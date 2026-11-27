'use strict';

const crypto = require('node:crypto');
const { clampFor, readTargetsFrom, findTemplateUser } = require('./kof-tenant');

/**
 * Der Zugang, den ein Sprung aus der Console braucht.
 *
 * Zwei Dinge, und sie liegen in verschiedenen Welten:
 *
 *   1. im **Regional**: ein Lesezugang (VMUser), der serverseitig auf genau
 *      diesen Mandanten klemmt - `<organisation>_<projekt>`, und nichts
 *      daneben;
 *   2. in **Grafana**: eine Organisation je Mandant, darin Datenquellen, die
 *      ueber diesen VMUser lesen, und die anspringende Person als Viewer
 *      darin - und aus `Main Org.` heraus.
 *
 * Warum das hier steht und nicht in `console-api`: es ist ein Eingriff im
 * Cluster, und die Verbindung dorthin hat nur dieser Dienst. Ein
 * Grafana-Admin-Zugang in `console-api` waere ein zweiter Weg in die
 * Infrastruktur neben dem, den es schon gibt.
 *
 * **Die Klemme ist die Sicherheitsgrenze, nicht die Organisation.** Grafanas
 * Organisation entscheidet, welche Datenquelle jemand *sieht*;
 * `extra_filters` im VMUser entscheidet, was sie *zurueckgibt*. Wer hier etwas
 * aendert, aendert im Zweifel das Zweite - und dann liest jemand fremde
 * Telemetrie, ohne dass es irgendwo auffaellt.
 *
 * **Viewer und nichts darueber.** Ein Editor kann die Datenquelle bearbeiten
 * und damit die Klemme abnehmen. Die Rolle ist deshalb festgeschrieben und
 * kein Parameter.
 */

const GROUP = 'operator.victoriametrics.com';
const VERSION = 'v1beta1';
const PLURAL = 'vmusers';

/**
 * **Zwei** Namensraeume im Regional, und das ist nicht Unordnung, sondern
 * nachgesehen - am 2026-11-27 am laufenden Regional:
 *
 *   kcm-system   die VMUser. Dort legt der kof-operator seine ab
 *                (`kof-vmuser-419106402`, Label `kof-tenant-id` und
 *                `kof-cluster-name`), und dort liegt auch der Org-Lesezugang
 *                aus kof-tenant.js. Unser per-Mandant-Zugang gehoert dazu.
 *   kof          das Grafana und sein Admin-Secret
 *                (`grafana-admin-credentials`), dazu `vmauth` selbst.
 *
 * Hier stand einmal **ein** Namensraum, `kof`, fuer beides - geraten aus dem
 * Beispielmanifest `vmuser-tenant-a-read.yaml`. Der Endpunkt lief damit bis in
 * den Regional und scheiterte dort mit "No operator-made VMUser to copy the
 * read paths from": in `kof` liegt nur das Handmanifest.
 *
 * Dass ein VMUser trotzdem in beiden Namensraeumen wirkt, liegt an `vmauth`:
 * `selectAllByDefault: true` ohne Selektoren, es nimmt sie aus **allen**
 * Namensraeumen. Unser Zugang liegt deshalb dort, wo jemand ihn sucht - bei
 * den anderen maschinell erzeugten.
 */
const VMUSER_NAMESPACE = process.env.KOF_VMUSER_NAMESPACE || 'kcm-system';
const GRAFANA_NAMESPACE = process.env.KOF_GRAFANA_NAMESPACE || 'kof';

/** Grafanas eigene Organisation. Dort stehen die **ungeklemmten** Datenquellen. */
const MAIN_ORG_ID = 1;

/** Das Secret, in dem KOF die Grafana-Zugangsdaten des Regionals ablegt. */
const GRAFANA_SECRET = 'grafana-admin-credentials';

/**
 * Welche Adresse ein Sprungziel sein darf.
 *
 * Die Adresse kommt von `console-api` - aus `provider_regions.grafanaUrl`, und
 * damit aus derselben Quelle, an die der Mensch gleich geschickt wird. Zwei
 * Quellen waeren schlimmer: dann liesse sich der Zugang in einem Grafana
 * herstellen und der Browser in ein anderes schicken.
 *
 * Geprueft wird sie trotzdem. Wer hier eine beliebige Adresse hineingeben
 * kann, laesst diesen Dienst mit Clusterzugang irgendwohin sprechen - und
 * dieser Dienst traegt die Admin-Zugangsdaten des Regionals.
 */
const HOST_SUFFIX = process.env.KOF_GRAFANA_HOST_SUFFIX || '.kof.enopax.io';

function assertSafeGrafanaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`grafanaUrl is not a URL: "${value}"`);
  }
  if (url.protocol !== 'https:') {
    throw new Error('grafanaUrl must be https - admin credentials travel on it');
  }
  if (url.username || url.password) {
    throw new Error('grafanaUrl must not carry credentials');
  }
  if (!url.hostname.endsWith(HOST_SUFFIX)) {
    throw new Error(`grafanaUrl host "${url.hostname}" is not under ${HOST_SUFFIX}`);
  }
  return `${url.origin}`;
}

/**
 * Der Name des VMUser - lesbar, und trotzdem eindeutig.
 *
 * Die Mandantenkennung traegt einen Unterstrich (`<organisation>_<projekt>`),
 * und der ist in einem Kubernetes-Namen nicht erlaubt. Ihn einfach durch `-`
 * zu ersetzen waere **nicht** eindeutig: `a_b-c` und `a-b_c` ergaeben
 * denselben Namen, und dann teilen sich zwei Projekte einen Lesezugang. Genau
 * das ist die Verwechslung, die dieser Zugang verhindern soll.
 *
 * Deshalb haengt ein kurzer Abdruck der **genauen** Kennung hinten dran. Der
 * lesbare Teil ist Bequemlichkeit, der Abdruck ist die Eindeutigkeit.
 */
function nameForTenant(tenantId) {
  const readable = String(tenantId).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  const digest = crypto.createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 8);
  return `enopax-kof-read-${readable}-${digest}`;
}

/**
 * Worauf geklemmt wird: **genau** dieser Mandant.
 *
 * Kein `.*` und kein Praefix - anders als beim Org-Zugang, der die Projekte
 * seiner Organisation mitnimmt. Hier sieht eine Person die Telemetrie eines
 * Projekts, weil sie in dessen Grafana-Organisation steht.
 */
function patternForTenant(tenantId) {
  return String(tenantId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function vmUserForTenant(tenantId, templateUser) {
  const targetRefs = readTargetsFrom(templateUser, patternForTenant(tenantId));
  if (!targetRefs.length) {
    throw new Error('The template VMUser carries no read paths; refusing to build an unclamped user');
  }
  const name = nameForTenant(tenantId);
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: 'VMUser',
    metadata: {
      name,
      labels: { 'enopax.io/kof-tenant': nameForTenant(tenantId).slice(0, 63), 'enopax.io/managed': 'true' },
      // Die genaue Kennung als Annotation: ein Label darf sie nicht tragen
      // (Unterstrich), und ohne sie liesse sich am Objekt nicht nachsehen,
      // fuer wen es da ist.
      annotations: { 'enopax.io/kof-tenant-id': String(tenantId) },
    },
    spec: {
      username: name,
      passwordRef: { name: `${name}-creds`, key: 'password' },
      targetRefs,
    },
  };
}

function isNotFound(error) {
  const code = error && (error.code || error.statusCode || (error.response && error.response.statusCode));
  return code === 404;
}

/**
 * Legt den Lesezugang an, wenn er fehlt, und gibt seine Zugangsdaten zurueck.
 *
 * Das Kennwort wird **nie** ueberschrieben: Grafanas Datenquelle traegt eine
 * Kopie davon, und ein neues Kennwort machte sie still unbrauchbar.
 */
async function ensureTenantReadUser({ core, objects, namespace, tenantId }) {
  const name = nameForTenant(tenantId);
  let existing = null;
  try {
    existing = await objects.getNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace, plural: PLURAL, name,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (!existing) {
    // Woran eine Operator-Vorlage zu erkennen ist, entscheidet kof-tenant.js
    // und nicht diese Datei. Hier standen einmal geratene Label-Namen, und
    // die Suche fand nichts - am laufenden Regional aufgefallen.
    const template = await findTemplateUser(objects, namespace);
    if (!template) {
      // Nichts raten. Die Lesepfade entscheidet KOF, und eine erfundene
      // Adresse ergibt einen VMUser, der gueltig ist und ins Leere zeigt.
      throw new Error('No operator-made VMUser to copy the read paths from');
    }
    const body = vmUserForTenant(tenantId, template);
    await ensureSecret(core, namespace, body.spec.passwordRef.name, tenantId);
    await objects.createNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace, plural: PLURAL, body,
    });
  }

  const secret = await core.readNamespacedSecret({ name: `${name}-creds`, namespace });
  const raw = secret && secret.data && secret.data.password;
  if (!raw) throw new Error(`Secret ${namespace}/${name}-creds has no password`);
  return { username: name, password: Buffer.from(raw, 'base64').toString('utf8'), created: !existing };
}

async function ensureSecret(core, namespace, name, tenantId) {
  try {
    await core.readNamespacedSecret({ name, namespace });
    return false;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await core.createNamespacedSecret({
    namespace,
    body: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        labels: { 'enopax.io/managed': 'true' },
        annotations: { 'enopax.io/kof-tenant-id': String(tenantId) },
      },
      stringData: { password: crypto.randomBytes(32).toString('base64url') },
    },
  });
  return true;
}

/** Grafanas Admin-Zugang, aus dem Secret des Regionals. */
async function readGrafanaAdmin(core, namespace) {
  const secret = await core.readNamespacedSecret({ name: GRAFANA_SECRET, namespace });
  const data = (secret && secret.data) || {};
  const user = data.GF_SECURITY_ADMIN_USER;
  const password = data.GF_SECURITY_ADMIN_PASSWORD;
  if (!user || !password) {
    throw new Error(`Secret ${namespace}/${GRAFANA_SECRET} has no admin user/password`);
  }
  return {
    user: Buffer.from(user, 'base64').toString('utf8'),
    password: Buffer.from(password, 'base64').toString('utf8'),
  };
}


/** Die In-Cluster-Adressen, ueber die Grafana im Regional liest. */
const VMAUTH = process.env.KOF_VMAUTH_URL || 'http://vmauth-cluster.kof.svc:8427';

/**
 * Die drei Datenquellen, und warum sie alle ueber `vmauth` gehen.
 *
 * Nicht direkt auf `vmselect`/`vlselect`: dort gibt es nichts, was klemmt.
 * Der Weg ueber `vmauth` mit dem per-Mandant-VMUser ist der einzige, der
 * **Daten und Metadaten** einschraenkt - ein Etikettenbrowser auf vmselect
 * zeigt sonst die Werte aller Mandanten. Bei Traces ist es nicht einmal eine
 * Abwaegung: die Jaeger-Datenquelle hat kein Gegenstueck zu
 * `customQueryParameters`, der VMUser ist dort die einzige Klemme.
 */
function datasourcesFor(credential) {
  const auth = {
    basicAuth: true,
    basicAuthUser: credential.username,
    secureJsonData: { basicAuthPassword: credential.password },
  };
  return [
    {
      name: 'metrics',
      type: 'prometheus',
      access: 'proxy',
      isDefault: true,
      url: `${VMAUTH}/vm/select/0/prometheus`,
      jsonData: { httpMethod: 'POST' },
      ...auth,
    },
    {
      name: 'logs',
      type: 'victoriametrics-logs-datasource',
      access: 'proxy',
      url: `${VMAUTH}/vls`,
      ...auth,
    },
    {
      name: 'traces',
      type: 'jaeger',
      access: 'proxy',
      url: `${VMAUTH}/vts/select/jaeger`,
      ...auth,
    },
  ];
}

/**
 * Ein Aufruf an Grafanas API, als Admin - und auf eine **bestimmte**
 * Organisation adressiert.
 *
 * `orgId` wird als `X-Grafana-Org-Id` mitgeschickt. Hier stand vorher ein
 * `POST /api/user/using/<org>` davor und ein Rueckwechsel danach, und das war
 * gefaehrlich: `/api/user/using/` schreibt die Organisation an den **Nutzer**,
 * nicht an die Sitzung. Solange der Admin dort parkte, schrieb der
 * **grafana-operator** - der dieselben Zugangsdaten benutzt - seine Objekte in
 * die Organisation des Mandanten.
 *
 * Belegt, nicht befuerchtet: am 2026-11-27 lag `KPS / Kubernetes / Networking
 * / Workload` in `enopax_enopax-dev`, von niemandem dorthin kopiert. Bei einem
 * Dashboard ist das Unordnung; haette der Operator in demselben Fenster eine
 * **Datenquelle** abgeglichen, waere eine ungeklemmte beim Mandanten
 * entstanden - und damit Lesezugriff auf alle.
 *
 * Mit der Kopfzeile gibt es dieses Fenster nicht: der Admin bleibt, wo er ist,
 * und jede Anfrage traegt ihr Ziel selbst. Am laufenden Grafana 10.4 geprueft,
 * lesend und schreibend.
 */
async function gf(ctx, method, path, body, orgId) {
  const response = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${ctx.admin.user}:${ctx.admin.password}`).toString('base64')}`,
      'content-type': 'application/json',
      ...(orgId === undefined ? {} : { 'X-Grafana-Org-Id': String(orgId) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ctx.timeoutMs),
  });
  if (response.status === 404) return { status: 404, body: null };
  const text = await response.text();
  if (!response.ok) {
    // Der Wortlaut von Grafana kommt mit: "organization name taken" ist eine
    // Diagnose, "Grafana returned 409" ist keine.
    throw new Error(`Grafana ${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/**
 * Welche Dashboards ein Mandant bekommt - und warum nicht alle.
 *
 * Grafana teilt Dashboards **nicht** ueber Organisationen. Eine
 * Mandanten-Organisation entsteht leer, und `Main Org.` ist fuer einen Kunden
 * gesperrt, weil dort die ungeklemmten Datenquellen stehen. Also kopieren.
 *
 * Kopiert wird nach **Ordner**, nicht nach Liste von Kennungen: `Cluster
 * Monitoring` ist der einzige Ordner, der von *einem Cluster* handelt statt
 * von unserer Plattform. Legt KOF dort eine Seite dazu, ist sie damit
 * automatisch dabei - eine Liste von uids waere beim naechsten Upgrade still
 * veraltet.
 *
 * Die 42 anderen bleiben, wo sie sind (am 2026-11-27 durchgesehen): Kcm, Ksm,
 * Istio, Victoria*, Ceph, Nvidia, Opencost und 28 Seiten
 * Kube-Prometheus-Stack-Innenleben. Ihre Felder blieben beim Kunden ohnehin
 * leer - die Klemme filtert die Reihen weg -, und ihre **Titel** allein
 * verraten, woraus der Stapel gebaut ist.
 *
 * Dass eine Kopie funktioniert, haengt an einer Eigenschaft der Vorlagen:
 * sie waehlen ihre Datenquelle ueber eine Variable (`${datasource}`, Typ
 * `datasource`) und nicht ueber eine feste uid. Die Kopie bindet sich deshalb
 * an die Datenquelle des Mandanten - die geklemmte -, ohne dass hier etwas
 * umgeschrieben werden muss. Waere es eine uid, zeigte jede Kopie auf die
 * ungeklemmte Quelle in `Main Org.`, und das waere ein Leck.
 */
const TENANT_FOLDERS = (process.env.KOF_TENANT_DASHBOARD_FOLDERS || 'Cluster Monitoring')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

/** Einzelne Seiten aus fremden Ordnern. `Kubernetes Events` traegt zwei, und
 *  nur eine davon handelt vom Cluster des Kunden - die andere zeigt
 *  k0rdent-ClusterDeployments. */
const TENANT_DASHBOARD_UIDS = (process.env.KOF_TENANT_DASHBOARD_UIDS || 'kubernetes-event-exporter')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

/**
 * Die Vorlagen, gelesen in `Main Org.` - dort provisioniert der
 * grafana-operator.
 */
async function readTenantDashboards(ctx) {
  const found = await gf(ctx, 'GET', '/api/search?type=dash-db&limit=500', undefined, MAIN_ORG_ID);
  const wanted = (found.body || []).filter(
    (d) => TENANT_FOLDERS.includes(d.folderTitle) || TENANT_DASHBOARD_UIDS.includes(d.uid),
  );
  const out = [];
  for (const entry of wanted) {
    const full = await gf(ctx, 'GET', `/api/dashboards/uid/${encodeURIComponent(entry.uid)}`, undefined, MAIN_ORG_ID);
    if (!full.body) continue;
    out.push({
      uid: entry.uid,
      title: entry.title,
      folderTitle: entry.folderTitle || null,
      folderUid: entry.folderUid || null,
      dashboard: full.body.dashboard,
    });
  }
  return out;
}

/**
 * Legt die Kopien in der Organisation des Mandanten an - **einmal**.
 *
 * Vorhandene werden nicht ueberschrieben: ein Sprung soll billig sein, und
 * sieben Seiten bei jedem Klick neu zu schreiben waere es nicht. Der Preis ist
 * bekannt: eine Aenderung an der Vorlage erreicht bestehende Kopien nicht.
 * Wer sie nachziehen will, loescht sie in der Mandanten-Organisation; der
 * naechste Sprung legt sie neu.
 *
 * `id: null` ist Pflicht - eine Dashboard-Id gilt je Organisation, und die der
 * Vorlage zeigt in der neuen auf etwas anderes oder nichts. Die `uid` bleibt,
 * damit "schon da" ueberhaupt feststellbar ist.
 */
async function ensureDashboards(ctx, sources, orgId) {
  const touched = [];
  const folders = new Map();
  for (const src of sources) {
    const exists = await gf(ctx, 'GET', `/api/dashboards/uid/${encodeURIComponent(src.uid)}`, undefined, orgId);
    if (exists.body) continue;

    let folderUid = null;
    if (src.folderTitle) {
      if (!folders.has(src.folderTitle)) {
        // Denselben Ordner-uid wiederverwenden, damit die Ablage in jeder
        // Organisation gleich aussieht. Gibt es ihn schon, antwortet Grafana
        // mit 412/409 - dann steht er, und das ist das Ziel.
        try {
          const made = await gf(ctx, 'POST', '/api/folders', {
            uid: src.folderUid,
            title: src.folderTitle,
          }, orgId);
          folders.set(src.folderTitle, (made.body && made.body.uid) || src.folderUid);
        } catch {
          folders.set(src.folderTitle, src.folderUid);
        }
      }
      folderUid = folders.get(src.folderTitle);
    }

    await gf(ctx, 'POST', '/api/dashboards/db', {
      dashboard: { ...src.dashboard, id: null, version: 0 },
      folderUid,
      overwrite: false,
      message: 'Kopie fuer den Mandanten (enopax/enopax#58)',
    }, orgId);
    touched.push({ uid: src.uid, title: src.title, action: 'copied' });
  }
  return touched;
}

/** Die Organisation des Mandanten - sie heisst wie die Kennung. */
async function ensureOrg(ctx, tenantId) {
  const found = await gf(ctx, 'GET', `/api/orgs/name/${encodeURIComponent(tenantId)}`);
  if (found.body && found.body.id) return { orgId: found.body.id, created: false };
  const made = await gf(ctx, 'POST', '/api/orgs', { name: tenantId });
  return { orgId: made.body.orgId, created: true };
}

/**
 * Die Datenquellen in der Organisation des Mandanten.
 *
 * Angelegt, wenn sie fehlen; **berichtigt**, wenn sie auf einen anderen
 * Lesezugang zeigen. Das Zweite ist der Fall, der sich sonst nicht heilt: ein
 * VMUser, der neu angelegt wurde, waehrend eine alte Datenquelle noch den
 * alten Namen trug - und dann zeigt Grafana nichts an, ohne zu sagen, warum.
 *
 * Nicht bei jedem Sprung neu angelegt: `POST` nach `DELETE` wuerde bei jedem
 * Klick die Kennung der Datenquelle aendern, und damit jedes gespeicherte
 * Dashboard, das sie nennt.
 */
async function ensureDatasources(ctx, credential, orgId) {
  const wanted = datasourcesFor(credential);
  const touched = [];
  for (const spec of wanted) {
    const found = await gf(ctx, 'GET', `/api/datasources/name/${encodeURIComponent(spec.name)}`, undefined, orgId);
    if (!found.body) {
      await gf(ctx, 'POST', '/api/datasources', spec, orgId);
      touched.push({ name: spec.name, action: 'created' });
      continue;
    }
    if (found.body.basicAuthUser !== spec.basicAuthUser || found.body.url !== spec.url) {
      await gf(ctx, 'PUT', `/api/datasources/${found.body.id}`, { ...spec, id: found.body.id }, orgId);
      touched.push({ name: spec.name, action: 'corrected' });
    }
  }
  return touched;
}

/**
 * Die Person in der Organisation des Mandanten - und nirgends sonst.
 *
 * Das Kennwort des Grafana-Nutzers ist Zufall und wird nie herausgegeben: die
 * Anmeldung geschieht ueber das Sprungtoken (`[auth.jwt]`), und `auto_sign_up`
 * steht auf `false`, weil der Nutzer hier entsteht und nicht dort.
 *
 * Aus `Main Org.` wird er entfernt. Das ist keine Kosmetik - dort stehen die
 * **ungeklemmten** Datenquellen des Operators, und eine Mitgliedschaft darin
 * ist genau das Leck aus enopax/enopax#39.
 */
async function ensureMember(ctx, orgId, person) {
  const found = await gf(ctx, 'GET', `/api/users/lookup?loginOrEmail=${encodeURIComponent(person.email)}`);
  let userId = found.body && found.body.id;
  let created = false;
  if (!userId) {
    const made = await gf(ctx, 'POST', '/api/admin/users', {
      name: person.name || person.email,
      email: person.email,
      login: person.email,
      password: crypto.randomBytes(32).toString('base64url'),
    });
    userId = made.body.id;
    created = true;
  }

  const members = await gf(ctx, 'GET', `/api/orgs/${orgId}/users`);
  const member = ((members.body) || []).find((m) => m.userId === userId);
  if (!member) {
    await gf(ctx, 'POST', `/api/orgs/${orgId}/users`, { loginOrEmail: person.email, role: 'Viewer' });
  } else if (member.role !== 'Viewer') {
    // Herabsetzen und nicht stehenlassen: ein Editor nimmt die Klemme ab,
    // indem er die Datenquelle bearbeitet.
    await gf(ctx, 'PATCH', `/api/orgs/${orgId}/users/${userId}`, { role: 'Viewer' });
  }

  await gf(ctx, 'POST', `/api/users/${userId}/using/${orgId}`);

  // **Genau eine Organisation, und zwar diese.** Hier stand "aus Main Org.
  // entfernen", und das war zu wenig: Grafana legt bei
  // `auto_assign_org: false` beim Anlegen eines Nutzers eine **persoenliche**
  // Organisation an, benannt nach seiner E-Mail - und macht ihn dort zum
  // **Admin**. Ein Admin bearbeitet Datenquellen, also haette er sich dort
  // eine ungeklemmte legen koennen: `http://vmselect-cluster:8481` direkt,
  // ohne Zugangsdaten, von Grafana serverseitig geholt. Damit laese er die
  // Telemetrie aller Mandanten.
  //
  // Am 2026-11-27 am laufenden Regional gefunden, beim ersten echten Aufruf:
  // Organisation 5 hiess `amueller@niggemann.it`, Rolle Admin.
  //
  // Die ganze Trennung beruht darauf, dass ein Mensch **Viewer** ist und
  // Datenquellen nicht aendern kann. Jede Mitgliedschaft daneben hebt das auf,
  // nicht nur die in Main Org.
  const elsewhere = [];
  const mine = await gf(ctx, 'GET', `/api/users/${userId}/orgs`);
  for (const membership of (mine.body || [])) {
    if (membership.orgId === orgId) continue;
    try {
      await gf(ctx, 'DELETE', `/api/orgs/${membership.orgId}/users/${userId}`);
      elsewhere.push({ orgId: membership.orgId, action: 'removed' });
    } catch (error) {
      // Den letzten Admin laesst Grafana nicht gehen ("Cannot remove last
      // organization admin"). Bei der **persoenlichen** Organisation ist das
      // kein Hindernis, sondern die Antwort: sie ist eine Nebenwirkung des
      // Anlegens, traegt nichts und kann weg. Erkennbar daran, dass sie nach
      // der Anmeldung des Nutzers heisst - eine Mandanten-Organisation heisst
      // `<organisation>_<projekt>` und kann kein `@` enthalten.
      const istPersoenlich =
        membership.orgId !== MAIN_ORG_ID && membership.name === person.email;
      if (!istPersoenlich) {
        // Nicht stillschweigend hinnehmen: eine fremde Mitgliedschaft, die
        // nicht aufgeloest werden kann, gehoert nach oben gemeldet.
        throw error;
      }
      await gf(ctx, 'DELETE', `/api/orgs/${membership.orgId}`);
      elsewhere.push({ orgId: membership.orgId, action: 'org deleted' });
    }
  }

  return { userId, created, elsewhere };
}

/**
 * Alles, was vor einem Sprung stehen muss - idempotent.
 *
 * Reihenfolge mit Absicht: erst der Lesezugang, dann die Organisation, dann
 * die Datenquellen, dann die Person. Jeder Schritt setzt den vorigen voraus,
 * und ein Abbruch in der Mitte laesst nichts zurueck, was fuer sich gefaehrlich
 * waere - eine Organisation ohne Datenquellen ist leer, ein Mitglied ohne
 * Datenquellen sieht nichts.
 *
 * Die Person **zuletzt**: solange die Datenquellen nicht geklemmt stehen, soll
 * niemand in der Organisation sein.
 */
async function ensureDashboardAccess({
  regionalCore,
  regionalObjects,
  vmUserNamespace = VMUSER_NAMESPACE,
  grafanaNamespace = GRAFANA_NAMESPACE,
  grafanaUrl,
  tenantId,
  email,
  name,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  if (!tenantId) throw new Error('Missing required field: tenantId');
  if (!email) throw new Error('Missing required field: email');
  const baseUrl = assertSafeGrafanaUrl(grafanaUrl);

  const credential = await ensureTenantReadUser({
    core: regionalCore, objects: regionalObjects, namespace: vmUserNamespace, tenantId,
  });
  const admin = await readGrafanaAdmin(regionalCore, grafanaNamespace);
  const ctx = { baseUrl, admin, fetchImpl, timeoutMs };

  // Die Vorlagen aus `Main Org.` - dort provisioniert der grafana-operator.
  const sources = await readTenantDashboards(ctx);

  const org = await ensureOrg(ctx, tenantId);

  // **Kein Wechsel der Organisation des Admins.** Jede Anfrage traegt ihr Ziel
  // als `X-Grafana-Org-Id`; siehe `gf()`, warum das der Unterschied zwischen
  // ordentlich und gefaehrlich ist.
  const datasources = await ensureDatasources(ctx, credential, org.orgId);
  // Erst die Datenquellen, dann die Dashboards: eine Seite ohne Datenquelle
  // ist eine Seite mit Fehlermeldungen, und die Variable bindet beim Oeffnen,
  // nicht beim Anlegen.
  const dashboards = await ensureDashboards(ctx, sources, org.orgId);
  const member = await ensureMember(ctx, org.orgId, { email, name });

  return {
    tenantId,
    orgId: org.orgId,
    vmUser: credential.username,
    created: {
      vmUser: credential.created,
      org: org.created,
      user: member.created,
      datasources,
      dashboards,
    },
    // Was an Mitgliedschaften **aufgeloest** wurde. Gehoert nicht unter
    // `created` - es ist das Gegenteil - und gehoert ins Ergebnis, weil der
    // Aufrufer es protokollieren soll: hier wird jemandem ein Zugang
    // genommen.
    elsewhere: member.elsewhere,
  };
}

module.exports = {
  ensureDashboardAccess,
  ensureOrg,
  ensureDatasources,
  ensureMember,
  datasourcesFor,
  readTenantDashboards,
  ensureDashboards,
  TENANT_FOLDERS,
  TENANT_DASHBOARD_UIDS,
  GROUP,
  VERSION,
  PLURAL,
  VMUSER_NAMESPACE,
  GRAFANA_NAMESPACE,
  MAIN_ORG_ID,
  GRAFANA_SECRET,
  assertSafeGrafanaUrl,
  nameForTenant,
  patternForTenant,
  vmUserForTenant,
  ensureTenantReadUser,
  readGrafanaAdmin,
  clampFor,
};
