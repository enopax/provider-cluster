'use strict';

const crypto = require('node:crypto');
const { clampFor, readTargetsFrom } = require('./kof-tenant');

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
 * Der Namensraum der KOF-Objekte **im Regional**.
 *
 * `kof`, und das steht hier ausdruecklich: die bewaehrten Manifeste legen den
 * per-Mandant-VMUser dorthin (`vmuser-tenant-a-read.yaml` in enopax/cluster),
 * und dort liest `vmauth`. Ein VMUser in einem anderen Namensraum ist
 * gueltig, wird aber von niemandem gelesen - ein Fehler, der nichts meldet.
 */
const KOF_NAMESPACE = process.env.KOF_NAMESPACE || 'kof';

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
    const list = await objects.listNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace, plural: PLURAL,
    });
    const template = ((list && list.items) || []).find((u) => {
      const labels = (u.metadata && u.metadata.labels) || {};
      return labels['kof-tenant'] || labels['k0rdent.mirantis.com/kof-tenant'];
    });
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

/** Ein Aufruf an Grafanas API, als Admin. `404` ist eine Antwort, kein Fehler. */
async function gf(ctx, method, path, body) {
  const response = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${ctx.admin.user}:${ctx.admin.password}`).toString('base64')}`,
      'content-type': 'application/json',
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
async function ensureDatasources(ctx, credential) {
  const wanted = datasourcesFor(credential);
  const touched = [];
  for (const spec of wanted) {
    const found = await gf(ctx, 'GET', `/api/datasources/name/${encodeURIComponent(spec.name)}`);
    if (!found.body) {
      await gf(ctx, 'POST', '/api/datasources', spec);
      touched.push({ name: spec.name, action: 'created' });
      continue;
    }
    if (found.body.basicAuthUser !== spec.basicAuthUser || found.body.url !== spec.url) {
      await gf(ctx, 'PUT', `/api/datasources/${found.body.id}`, { ...spec, id: found.body.id });
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

  const main = await gf(ctx, 'GET', `/api/orgs/${MAIN_ORG_ID}/users`);
  if (((main.body) || []).some((m) => m.userId === userId)) {
    await gf(ctx, 'DELETE', `/api/orgs/${MAIN_ORG_ID}/users/${userId}`);
  }

  return { userId, created };
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
  namespace = KOF_NAMESPACE,
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
    core: regionalCore, objects: regionalObjects, namespace, tenantId,
  });
  const admin = await readGrafanaAdmin(regionalCore, namespace);
  const ctx = { baseUrl, admin, fetchImpl, timeoutMs };

  const org = await ensureOrg(ctx, tenantId);
  // Der Admin muss in die Organisation wechseln: `/api/datasources` arbeitet
  // immer in der **aktuellen** Organisation des Aufrufers. Ohne diesen
  // Wechsel entstehen die geklemmten Datenquellen in `Main Org.` - also genau
  // dort, wo sie nicht hingehoeren.
  await gf(ctx, 'POST', `/api/user/using/${org.orgId}`);
  let datasources;
  let member;
  try {
    datasources = await ensureDatasources(ctx, credential);
    member = await ensureMember(ctx, org.orgId, { email, name });
  } finally {
    // Zurueck, auch wenn etwas schiefging: ein Admin, der in einer
    // Mandanten-Organisation stehenbleibt, legt beim naechsten Aufruf fuer
    // einen anderen Mandanten dort an.
    await gf(ctx, 'POST', `/api/user/using/${MAIN_ORG_ID}`).catch(() => {});
  }

  return {
    tenantId,
    orgId: org.orgId,
    vmUser: credential.username,
    created: {
      vmUser: credential.created,
      org: org.created,
      user: member.created,
      datasources,
    },
  };
}

module.exports = {
  ensureDashboardAccess,
  ensureOrg,
  ensureDatasources,
  ensureMember,
  datasourcesFor,
  GROUP,
  VERSION,
  PLURAL,
  KOF_NAMESPACE,
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
