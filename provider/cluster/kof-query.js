'use strict';

/**
 * Messwerte ueber Zeit, aus dem KOF-Stack der Region.
 *
 * Gefragt wird durch `vmauth`, mit dem Lesezugang der Organisation
 * (`kof-tenant.js`). Der klemmt serverseitig auf `<org>(_.*)?` - gemessen:
 * eine Abfrage ohne jeden Filter bekommt trotzdem nur die eigenen Mandanten,
 * und `query_range` verhaelt sich darin wie `query`. Die Einschraenkung kann
 * also nicht verlorengehen, weil sie nicht in der Abfrage steht.
 *
 * **Die Adresse wird abgeschrieben, nicht gebildet.** Sie steht in der
 * ConfigMap `kof-<regional>` auf dem Management-Cluster, Schluessel
 * `read_metrics_endpoint`. Sie dort zu lesen kostet einen Aufruf und erspart
 * eine Konstante, die bei der naechsten Region oder dem naechsten KOF-Umbau
 * still falsch wird.
 */

const CONFIG_MAP_PREFIX = 'kof-';
const ENDPOINT_KEY = 'read_metrics_endpoint';

/**
 * Was die Console an Zeitbereichen anbietet, und mit welcher Schrittweite.
 *
 * Die Schritte sind so gewaehlt, dass eine Linie zwischen 60 und 300 Punkten
 * hat: weniger sieht eckig aus, mehr kann ein Diagramm nicht zeigen und
 * kostet nur Uebertragung.
 *
 *   1h   step   60  →  60 Punkte
 *   24h  step  300  → 288
 *   7d   step 3600  → 168   (stuendlich)
 *   30d  step 14400 → 180   (vierstuendlich)
 *
 * Hier stand `7d: 1800` und `30d: 7200` - 336 und 360 Punkte, also mehr als
 * der Kommentar zwei Zeilen darueber behauptete. Gefunden hat es der Test,
 * nicht ich; eine Zusicherung auf die eigene Begruendung ist deshalb mehr
 * als Zierde.
 *
 * `30d` ist der weiteste Bereich, und das ist kein Zufall: der VMCluster haelt
 * `retentionPeriod: 30d`. Mehr anzubieten hiesse, eine abfallende Kante am
 * linken Rand zu zeigen, die wie ein Ausfall aussieht und keiner ist.
 */
const RANGES = {
  '1h': { seconds: 3600, step: 60 },
  '24h': { seconds: 86400, step: 300 },
  '7d': { seconds: 604800, step: 3600 },
  '30d': { seconds: 2592000, step: 14400 },
};

/**
 * Die Formeln.
 *
 * Gerechnet wird **cAdvisor gegen `allocatable`** - dieselbe Bauart wie der
 * Momentanwert, damit Kachel und Diagramm nicht zwei Zahlen fuer dieselbe
 * Groesse zeigen. Am 2026-11-23 21:00Z an `dev-dose` gemessen, je Knoten:
 *
 *   diese Formel          CPU 5.3 | 4.6 | 5.0    Speicher 14.0 |  7.4 | 11.7
 *   metrics-server        CPU   6 |   5 |   6    Speicher   18 |   11 |   16
 *   node-exporter         CPU 8.6 | 9.0 | 7.6    Speicher 21.1 | 24.0 | 15.9
 *
 * Die drei weichen aus Gruenden ab, nicht aus Fehlern: cAdvisor summiert nur
 * Container, der metrics-server die ganze Knotenlast einschliesslich kubelet,
 * und node-exporter die Maschine gegen ihre **Rohkapazitaet** statt gegen
 * `allocatable`. Gegen `allocatable` ist das Richtige, weil der Kunde nicht
 * benutzen kann, was das System sich nimmt.
 *
 * `container!=""` schliesst die Sammelreihe des Pods aus, die sonst jeden
 * Wert doppelt zaehlt.
 */
const QUERIES = {
  cpuPercent: (cluster) =>
    `100 * sum(rate(container_cpu_usage_seconds_total{cluster="${cluster}",container!=""}[5m]))` +
    ` / sum(kube_node_status_allocatable{cluster="${cluster}",resource="cpu"})`,
  memPercent: (cluster) =>
    `100 * sum(container_memory_working_set_bytes{cluster="${cluster}",container!=""})` +
    ` / sum(kube_node_status_allocatable{cluster="${cluster}",resource="memory"})`,
};

/** Ein Clustername, der keine Abfrage aufbrechen kann. */
function assertSafeName(cluster) {
  // k0rdent laesst nur DNS-Namen zu; alles andere kaeme nicht bis hierher.
  // Geprueft wird es trotzdem: der Name wandert in eine Abfragesprache, und
  // ein Anfuehrungszeichen darin waere eine Einladung.
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(cluster || ''))) {
    throw new Error(`Refusing to query for an unexpected cluster name: "${cluster}"`);
  }
  return cluster;
}

/** Die Leseadresse der Region, aus ihrer ConfigMap auf dem Management. */
async function readEndpoint(core, regionalClusterName, namespace) {
  const name = `${CONFIG_MAP_PREFIX}${regionalClusterName}`;
  const cm = await core.readNamespacedConfigMap({ name, namespace });
  const endpoint = ((cm && cm.data) || {})[ENDPOINT_KEY];
  if (!endpoint) {
    throw new Error(`ConfigMap ${namespace}/${name} has no ${ENDPOINT_KEY}`);
  }
  return endpoint.replace(/\/+$/, '');
}

/** Benutzername und Kennwort des Org-Lesezugangs, vom regionalen Cluster. */
async function readCredential(regionalCore, namespace, organisationSlug, nameFor) {
  const username = nameFor(organisationSlug);
  const secret = await regionalCore.readNamespacedSecret({
    name: `${username}-creds`,
    namespace,
  });
  const raw = secret && secret.data && secret.data.password;
  if (!raw) throw new Error(`Secret ${namespace}/${username}-creds has no password`);
  return { username, password: Buffer.from(raw, 'base64').toString('utf8') };
}

/**
 * Eine Linie je Groesse, fuer einen Zeitbereich.
 *
 * `now` kommt von aussen, damit der Pruefstand nicht von der Uhr abhaengt.
 * Zurueck kommen Punkte als `[sekunden, zahl]` - und `null` fuer eine Luecke
 * bleibt eine Luecke: eine Zeitreihe, die eine Unterbrechung ueberbrueckt,
 * behauptet einen Messwert, den es nicht gab.
 */
async function series({ endpoint, credential, cluster, range, now, fetchImpl }) {
  const spec = RANGES[range];
  if (!spec) throw new Error(`Unknown range: "${range}". Known: ${Object.keys(RANGES).join(', ')}`);
  assertSafeName(cluster);

  const end = Math.floor(now / 1000);
  const start = end - spec.seconds;
  const doFetch = fetchImpl || fetch;
  const auth = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');

  const out = { range, step: spec.step, start, end };

  for (const [key, build] of Object.entries(QUERIES)) {
    const url = new URL(`${endpoint}/api/v1/query_range`);
    url.searchParams.set('query', build(cluster));
    url.searchParams.set('start', String(start));
    url.searchParams.set('end', String(end));
    url.searchParams.set('step', String(spec.step));

    const response = await doFetch(url.toString(), {
      headers: { authorization: `Basic ${auth}` },
    });
    if (!response.ok) {
      throw new Error(`${key}: vmauth answered ${response.status}`);
    }
    const body = await response.json();
    out[key] = pointsOf(body);
  }

  return out;
}

/**
 * Die Punkte einer Antwort, oder eine leere Liste.
 *
 * Mehr als eine Reihe kann hier nicht vorkommen - die Formeln aggregieren
 * ohne `by` -, und wenn doch, zaehlt die erste. Keine zu haben ist der
 * Normalfall fuer einen Cluster, der gerade entsteht: dann ist die Liste leer
 * und die Seite sagt es, statt eine Linie bei Null zu zeichnen.
 */
function pointsOf(body) {
  const result = ((body && body.data) || {}).result || [];
  if (!result.length) return [];
  return (result[0].values || []).map(([at, value]) => {
    const number = Number(value);
    return [Number(at), Number.isFinite(number) ? Math.round(number * 10) / 10 : null];
  });
}


/**
 * Dieselben Groessen als Momentanwert, je Knoten und fuer den Cluster.
 *
 * Gefragt werden Zaehler und Nenner **getrennt und je Knoten**, und gerechnet
 * wird hier. Das hat einen Grund: der Clusterwert ist `sum(zaehler) /
 * sum(nenner)` und nicht der Mittelwert der Knotenanteile. Bei gleich grossen
 * Knoten liegt beides nah beieinander, bei gemischten Groessen nicht - und
 * eine Kachel, die einen kleinen ueberlasteten Knoten gegen einen grossen
 * leeren mittelt, zeigt Ruhe, wo Not ist.
 *
 * `null`, wenn eine der vier Abfragen nichts liefert. Unbekannt ist nicht
 * null, und der Aufrufer hat einen Rueckfall.
 */
const NODE_PARTS = {
  cpuUsed: (c) => `sum by (node) (rate(container_cpu_usage_seconds_total{cluster="${c}",container!=""}[5m]))`,
  cpuAlloc: (c) => `sum by (node) (kube_node_status_allocatable{cluster="${c}",resource="cpu"})`,
  memUsed: (c) => `sum by (node) (container_memory_working_set_bytes{cluster="${c}",container!=""})`,
  memAlloc: (c) => `sum by (node) (kube_node_status_allocatable{cluster="${c}",resource="memory"})`,
};

async function instant({ endpoint, credential, cluster, now, fetchImpl, timeoutMs = 4000 }) {
  assertSafeName(cluster);
  const doFetch = fetchImpl || fetch;
  const auth = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
  const at = Math.floor(now / 1000);

  const parts = {};
  for (const [key, build] of Object.entries(NODE_PARTS)) {
    const url = new URL(`${endpoint}/api/v1/query`);
    url.searchParams.set('query', build(cluster));
    url.searchParams.set('time', String(at));

    // Eine Zeitgrenze, weil der Waechter das je Cluster im Minutentakt ruft:
    // ein haengendes KOF darf nicht die Auffrischung aller Cluster aufhalten.
    const response = await doFetch(url.toString(), {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${key}: vmauth answered ${response.status}`);
    parts[key] = vectorByNode(await response.json());
  }

  const nodes = new Map();
  for (const node of new Set([...parts.cpuAlloc.keys(), ...parts.memAlloc.keys()])) {
    nodes.set(node, {
      cpuPercent: ratio(parts.cpuUsed.get(node), parts.cpuAlloc.get(node)),
      memPercent: ratio(parts.memUsed.get(node), parts.memAlloc.get(node)),
    });
  }

  return {
    nodes,
    cpuPercent: ratio(total(parts.cpuUsed), total(parts.cpuAlloc)),
    memPercent: ratio(total(parts.memUsed), total(parts.memAlloc)),
  };
}

/** Ein Vektor als Karte Knoten → Zahl. Reihen ohne `node` fallen weg. */
function vectorByNode(body) {
  const out = new Map();
  for (const entry of ((body && body.data) || {}).result || []) {
    const node = (entry.metric || {}).node;
    const value = Number((entry.value || [])[1]);
    if (node && Number.isFinite(value)) out.set(node, value);
  }
  return out;
}

const total = (map) => {
  if (!map || map.size === 0) return null;
  let sum = 0;
  for (const value of map.values()) sum += value;
  return sum;
};

/** Prozent auf eine Stelle, oder `null` wenn eine Seite fehlt. */
function ratio(used, allocatable) {
  if (used === null || used === undefined) return null;
  if (!allocatable) return null;
  return Math.round((used / allocatable) * 1000) / 10;
}

module.exports = {
  series,
  instant,
  readEndpoint,
  readCredential,
  pointsOf,
  assertSafeName,
  RANGES,
  QUERIES,
  NODE_PARTS,
  ratio,
  vectorByNode,
};
