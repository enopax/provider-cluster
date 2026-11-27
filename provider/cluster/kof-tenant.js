'use strict';

/**
 * Ein Lesezugang je Organisation fuer die KOF-Telemetrie.
 *
 * `kof-operator` legt je **Cluster** einen VMUser an und klemmt ihn
 * serverseitig auf die Kennung aus `kof-tenant-id` - bei uns
 * `<organisation>_<projekt>`. Gemessen am laufenden Cluster: ein Zugang ohne
 * jeden Filter in der Abfrage bekommt trotzdem nur seinen Mandanten. Die
 * Trennung je Projekt steht damit, und zwar unumgehbar.
 *
 * Was fehlt, ist die Ebene darueber: ein Org-Admin oder Owner darf alle
 * Projekte **seiner** Organisation sehen. In `console-api` ist das die Rolle
 * mit `projectIds === null`. Dafuer braucht es einen Zugang, der auf
 * `<organisation>_*` klemmt und auf nichts weiter.
 *
 * Zwei Festlegungen, die Sicherheitsfolgen haben:
 *
 * **Nur lesen.** Der Cluster-VMUser kann lesen und schreiben, weil das Kind
 * schreiben muss. Ein Zugang fuer einen Menschen braucht das nicht, und was
 * nicht schreiben kann, kann keine fremde Zeitreihe faelschen.
 *
 * **Die Zielangaben werden abgeschrieben, nicht erfunden.** Welche Dienste
 * hinter `/vm/select`, `/vls`, `/vlas` und `/vts` stehen, entscheidet KOF -
 * die Adressen stehen in jedem vom Operator erzeugten VMUser. Haette ich sie
 * hier hingeschrieben, waere die naechste KOF-Fassung still an uns
 * vorbeigezogen: der VMUser bliebe gueltig und zeigte auf einen Dienst, den
 * es nicht mehr gibt. Also wird ein vorhandener als Vorlage gelesen.
 */

const crypto = require('node:crypto');

const GROUP = 'operator.victoriametrics.com';
const VERSION = 'v1beta1';
const PLURAL = 'vmusers';

const TENANT_LABEL = 'k0rdent.mirantis.com/kof-tenant-id';
const CLUSTER_LABEL = 'k0rdent.mirantis.com/kof-cluster-name';
/** Woran unsere eigenen Zugaenge zu erkennen sind - der Operator setzt es nicht. */
const ORG_LABEL = 'enopax.io/kof-organisation';

/**
 * Wie die Einschraenkung je Lesepfad geschrieben wird.
 *
 * Drei Abfragesprachen, drei Schreibweisen - und sie unterscheiden sich in
 * einem Punkt, der hier sicherheitsrelevant ist:
 *
 * - PromQL (`/vm/select`): `=~` ist **vollstaendig verankert**. `enopax_.*`
 *   trifft `enopax_dev`, aber nicht `fremd-enopax_dev`.
 * - LogsQL (`/vls`, `/vlas`) und Traces (`/vts`): `:~` ist ein
 *   **unverankerter** Teilstring-Abgleich. Ohne `^` und `$` wuerde
 *   `enopax_.*` auch in `fremd-enopax_dev` zutreffen - also genau das Leck,
 *   das dieser Zugang verhindern soll. Die Anker stehen deshalb ausdruecklich
 *   da und sind in `kof-tenant.test.js` festgehalten.
 */
function clampFor(pathPrefix, pattern) {
  if (pathPrefix.startsWith('/vm/select')) return `{tenant=~"${pattern}"}`;
  if (pathPrefix.startsWith('/vts')) return `"resource_attr:tenant":~"^${pattern}$"`;
  return `"tenant":~"^${pattern}$"`;
}

/** Was eine Organisation sehen darf: alle ihre Projekte, keine fremden. */
function patternFor(organisationSlug) {
  // Der Unterstrich ist der Trenner, den `tenantIdFor` in console-api setzt,
  // und Slugs enthalten ihn nicht. `enopax_.*` kann deshalb nicht in die
  // Kennung einer anderen Organisation hineinreichen - auch nicht in die von
  // `enopax-dev`, denn dort stuende `enopax-dev_…`.
  //
  // Die bloße Organisation ist mitgemeint (`(_.*)?`): bevor die Kennung je
  // Projekt gebildet wurde, stand dort der Organisations-Slug allein - so
  // tragen es die Zeitreihen von `enopax-eu-central` bis heute. Die gehoeren
  // derselben Organisation, und ein Zugang, der sie nicht findet, waere
  // unvollstaendig. Verankert bleibt es trotzdem.
  return `${escapeRegex(organisationSlug)}(_.*)?`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ein Name, der aus demselben Slug immer derselbe ist. */
function nameFor(organisationSlug) {
  return `enopax-kof-org-${organisationSlug}`;
}

/**
 * Die Lesepfade einer Operator-Vorlage, umgeschrieben auf die Organisation.
 *
 * Schreibpfade fallen weg - erkennbar daran, dass sie `extra_label` oder
 * `extra_fields` tragen statt `extra_filters`. Das ist der Unterschied
 * zwischen "beim Schreiben anhaengen" und "beim Lesen einschraenken", und er
 * ist hier die ganze Sicherheitsgrenze.
 */
function readTargetsFrom(templateUser, pattern) {
  const refs = (templateUser && templateUser.spec && templateUser.spec.targetRefs) || [];
  return refs
    .filter((ref) => {
      const args = ref.query_args || [];
      return args.some((a) => a.name === 'extra_filters');
    })
    .map((ref) => {
      const prefix = (ref.paths || [])[0] || '';
      return {
        ...ref,
        query_args: [{ name: 'extra_filters', values: [clampFor(prefix, pattern)] }],
      };
    });
}

function vmUserFor(organisationSlug, templateUser) {
  const pattern = patternFor(organisationSlug);
  const targetRefs = readTargetsFrom(templateUser, pattern);
  if (!targetRefs.length) {
    throw new Error('The template VMUser carries no read paths; refusing to build an unclamped user');
  }
  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: 'VMUser',
    metadata: {
      name: nameFor(organisationSlug),
      labels: { [ORG_LABEL]: organisationSlug, 'enopax.io/managed': 'true' },
    },
    spec: {
      username: nameFor(organisationSlug),
      passwordRef: { name: `${nameFor(organisationSlug)}-creds`, key: 'password' },
      targetRefs,
    },
  };
}

/**
 * Ein Kennwort, das nur hier entsteht.
 *
 * 32 Byte aus `randomBytes`, base64url - kein `Math.random`, und es wird
 * **nie** ueberschrieben: ein bestehendes Secret bleibt stehen, sonst
 * verlieren alle, die den Zugang schon benutzen, ihn beim naechsten
 * Clusterbau.
 */
function newPassword() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Legt den Zugang an, wenn er fehlt - und laesst ihn sonst in Ruhe.
 *
 * Gibt zurueck, was geschehen ist, damit der Aufrufer es protokollieren kann.
 * Fehlt die Vorlage - etwa beim allerersten Cluster einer Region, bevor der
 * Operator seinen eigenen VMUser gelegt hat -, wird **nichts** geraten: der
 * naechste Clusterbau holt es nach, und bis dahin steht im Protokoll, warum.
 */
async function ensureOrganisationTenant({ core, objects, namespace, organisationSlug }) {
  if (!organisationSlug) return { created: false, reason: 'no organisation slug' };

  const name = nameFor(organisationSlug);

  const existing = await getVmUser(objects, namespace, name);
  if (existing) return { created: false, reason: 'already present', name };

  const template = await findTemplateUser(objects, namespace);
  if (!template) {
    return { created: false, reason: 'no operator-made VMUser to copy the read paths from' };
  }

  const body = vmUserFor(organisationSlug, template);

  await ensureSecret(core, namespace, body.spec.passwordRef.name, organisationSlug);
  await objects.createNamespacedCustomObject({
    group: GROUP, version: VERSION, namespace, plural: PLURAL, body,
  });

  return { created: true, name, pattern: patternFor(organisationSlug) };
}

async function getVmUser(objects, namespace, name) {
  try {
    return await objects.getNamespacedCustomObject({
      group: GROUP, version: VERSION, namespace, plural: PLURAL, name,
    });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Irgendein vom Operator erzeugter VMUser - sie tragen alle dieselben Ziele. */
async function findTemplateUser(objects, namespace) {
  const list = await objects.listNamespacedCustomObject({
    group: GROUP, version: VERSION, namespace, plural: PLURAL,
  });
  const items = (list && list.items) || [];
  return (
    items.find((u) => {
      const labels = (u.metadata && u.metadata.labels) || {};
      return labels[TENANT_LABEL] && labels[CLUSTER_LABEL];
    }) || null
  );
}

async function ensureSecret(core, namespace, name, organisationSlug) {
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
      metadata: { name, labels: { [ORG_LABEL]: organisationSlug, 'enopax.io/managed': 'true' } },
      stringData: { password: newPassword() },
    },
  });
  return true;
}

function isNotFound(error) {
  const code = error && (error.code || error.statusCode || (error.response && error.response.statusCode));
  return code === 404;
}

module.exports = {
  ensureOrganisationTenant,
  // Nach aussen gegeben, damit niemand die Label-Namen ein zweites Mal
  // raet: woran ein vom Operator erzeugter VMUser zu erkennen ist, steht
  // genau hier. Der Sprungzugang (grafana-access.js) hat sie geraten und
  // fand deshalb keine Vorlage - am laufenden Regional aufgefallen.
  findTemplateUser,
  TENANT_LABEL,
  CLUSTER_LABEL,
  vmUserFor,
  patternFor,
  clampFor,
  nameFor,
  readTargetsFrom,
  ORG_LABEL,
};
