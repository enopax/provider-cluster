'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ensureOrganisationTenant,
  vmUserFor,
  patternFor,
  clampFor,
  nameFor,
  readTargetsFrom,
  findTemplateUser,
  isReadPath,
  READ_PREFIXES,
  ORG_LABEL,
} = require('../provider/cluster/kof-tenant');

/**
 * Eine Vorlage, wie `kof-operator` sie legte - gekuerzt, aber in der Form
 * echt: Lesepfade mit `extra_filters`, Schreibpfade mit `extra_label` bzw.
 * `extra_fields`. Abgeschrieben von `kof-vmuser-457707155` am laufenden
 * regionalen Cluster.
 *
 * **Diese Form gibt es so nicht mehr.** Seit enopax/enopax#45 ist der VMUser
 * eines Kindes insert-only, er traegt keinen Lesepfad. Die Fixture bleibt,
 * weil sie prueft, dass Schreibpfade herausfallen; wie eine heutige Vorlage
 * aussieht, steht weiter unten als ADMIN_TEMPLATE und CHILD_TEMPLATE.
 */
const TEMPLATE = {
  metadata: {
    name: 'kof-vmuser-457707155',
    labels: {
      'k0rdent.mirantis.com/kof-cluster-name': 'dev-dose',
      'k0rdent.mirantis.com/kof-tenant-id': 'enopax_enopax-dev',
    },
  },
  spec: {
    targetRefs: [
      {
        paths: ['/vm/select/.*'],
        drop_src_path_prefix_parts: 1,
        query_args: [{ name: 'extra_filters', values: ['{tenant="enopax_enopax-dev"}'] }],
        static: { url: 'http://vmselect-cluster.kof.svc:8481' },
      },
      {
        paths: ['/vm/insert/.*'],
        drop_src_path_prefix_parts: 1,
        query_args: [{ name: 'extra_label', values: ['tenant=enopax_enopax-dev'] }],
        static: { url: 'http://vminsert-cluster.kof.svc:8480' },
      },
      {
        paths: ['/vls/.*'],
        drop_src_path_prefix_parts: 1,
        query_args: [{ name: 'extra_filters', values: ['"tenant":="enopax_enopax-dev"'] }],
        static: { url: 'http://kof-storage-victoria-logs-cluster-vlselect.kof.svc:9471' },
      },
      {
        paths: ['/vli/.*'],
        drop_src_path_prefix_parts: 1,
        query_args: [{ name: 'extra_fields', values: ['tenant=enopax_enopax-dev'] }],
        static: { url: 'http://kof-storage-victoria-logs-cluster-vlinsert.kof.svc:9481' },
      },
      {
        paths: ['/vts/.*'],
        drop_src_path_prefix_parts: 1,
        query_args: [{ name: 'extra_filters', values: ['"resource_attr:tenant":="enopax_enopax-dev"'] }],
        static: { url: 'http://kof-storage-vt-cluster-vtselect.kof.svc:10471' },
      },
    ],
  },
};

test('der Zugang kann nur lesen - kein Schreibpfad bleibt uebrig', () => {
  const user = vmUserFor('enopax', TEMPLATE);
  const paths = user.spec.targetRefs.map((r) => r.paths[0]);

  assert.deepStrictEqual(paths.sort(), ['/vls/.*', '/vm/select/.*', '/vts/.*']);
  // Was nicht schreiben kann, kann keine fremde Zeitreihe faelschen.
  assert.ok(!paths.some((p) => p.includes('insert') || p.includes('/vli') || p.includes('/vti')));
  for (const ref of user.spec.targetRefs) {
    assert.strictEqual(ref.query_args.length, 1);
    assert.strictEqual(ref.query_args[0].name, 'extra_filters');
  }
});

test('die Zieladressen werden abgeschrieben, nicht erfunden', () => {
  const user = vmUserFor('enopax', TEMPLATE);
  const urls = user.spec.targetRefs.map((r) => r.static.url).sort();

  // Welche Dienste hinter den Pfaden stehen, entscheidet KOF. Stuenden sie
  // hier als Konstanten, zoege die naechste KOF-Fassung still an uns vorbei.
  assert.deepStrictEqual(urls, [
    'http://kof-storage-victoria-logs-cluster-vlselect.kof.svc:9471',
    'http://kof-storage-vt-cluster-vtselect.kof.svc:10471',
    'http://vmselect-cluster.kof.svc:8481',
  ]);
});

/**
 * Der Kern dieses Tickets, und der Grund fuer die Anker.
 *
 * Am laufenden Cluster gemessen, gegen Daten mit `tenant="enopax_enopax-dev"`:
 *
 *   PromQL  up{tenant=~"nopax(_.*)?"}   → 0 Zeitreihen   (verankert)
 *   LogsQL  "tenant":~"nopax"           → Zeilen da      (unverankert!)
 *
 * Ohne `^` und `$` wuerde der Zugang einer Organisation `enopax` deshalb in
 * die Logs einer Organisation `fremd-enopax` hineinreichen. PromQL braucht
 * die Anker nicht; sie dort zu setzen waere aber auch nicht falsch.
 */
test('Logs und Traces werden verankert, weil ihr Abgleich sonst Teilstrings trifft', () => {
  assert.strictEqual(clampFor('/vls/.*', patternFor('enopax')), '"tenant":~"^enopax(_.*)?$"');
  assert.strictEqual(clampFor('/vlas/.*', patternFor('enopax')), '"tenant":~"^enopax(_.*)?$"');
  assert.strictEqual(
    clampFor('/vts/.*', patternFor('enopax')),
    '"resource_attr:tenant":~"^enopax(_.*)?$"',
  );
});

test('PromQL klemmt auf dasselbe Muster', () => {
  assert.strictEqual(clampFor('/vm/select/.*', patternFor('enopax')), '{tenant=~"enopax(_.*)?"}');
});

test('das Muster reicht nicht in eine andere Organisation', () => {
  const re = new RegExp(`^${patternFor('enopax')}$`);

  assert.ok(re.test('enopax'), 'die alte bloße Kennung gehoert derselben Organisation');
  assert.ok(re.test('enopax_enopax-dev'));
  assert.ok(re.test('enopax_shop'));

  // Der Unterstrich ist der Trenner, und Slugs enthalten ihn nicht.
  assert.ok(!re.test('enopax-dev_shop'), 'eine andere Organisation, die so anfaengt');
  assert.ok(!re.test('enopaxx'));
  assert.ok(!re.test('fremd-enopax_shop'));
  assert.ok(!re.test('tenant-a'));
});

test('ein Slug mit Regex-Zeichen wird entschaerft', () => {
  // Kein Slug sieht so aus, aber die Kennung kommt von aussen, und ein
  // Muster, das der Eingabe folgt, ist eine Einladung.
  const re = new RegExp(`^${patternFor('a.c')}$`);
  assert.ok(re.test('a.c_p'));
  assert.ok(!re.test('abc_p'), 'der Punkt darf nicht als Platzhalter wirken');
});

test('ohne Lesepfade in der Vorlage entsteht nichts', () => {
  // Eher kein VMUser als einer ohne Klemmung.
  const writeOnly = { spec: { targetRefs: [TEMPLATE.spec.targetRefs[1]] } };
  assert.throws(() => vmUserFor('enopax', writeOnly), /no read paths/);
  assert.deepStrictEqual(readTargetsFrom(writeOnly, 'x'), []);
});

/* ------------------------------------------------- ensureOrganisationTenant */

function fakeApis({ existing = null, users = [TEMPLATE], secretExists = false } = {}) {
  const calls = { createdUsers: [], createdSecrets: [] };
  const notFound = () => Object.assign(new Error('not found'), { code: 404 });

  return {
    calls,
    core: {
      async readNamespacedSecret() {
        if (!secretExists) throw notFound();
        return { data: { password: 'x' } };
      },
      async createNamespacedSecret({ body }) {
        calls.createdSecrets.push(body);
      },
    },
    objects: {
      async getNamespacedCustomObject() {
        if (!existing) throw notFound();
        return existing;
      },
      async listNamespacedCustomObject() {
        return { items: users };
      },
      async createNamespacedCustomObject({ body }) {
        calls.createdUsers.push(body);
      },
    },
  };
}

test('legt den Zugang an, wenn er fehlt', async () => {
  const apis = fakeApis();
  const result = await ensureOrganisationTenant({
    core: apis.core, objects: apis.objects, namespace: 'kcm-system', organisationSlug: 'enopax',
  });

  assert.strictEqual(result.created, true);
  assert.strictEqual(result.name, nameFor('enopax'));
  assert.strictEqual(apis.calls.createdUsers.length, 1);
  assert.strictEqual(apis.calls.createdSecrets.length, 1);
  // Das Kennwort entsteht hier und steht nirgends im Quelltext.
  const password = apis.calls.createdSecrets[0].stringData.password;
  assert.ok(password.length >= 40, 'zu kurz fuer 32 Byte base64url');
});

test('ein bestehender Zugang wird nicht angetastet', async () => {
  const apis = fakeApis({ existing: { metadata: { name: nameFor('enopax') } } });
  const result = await ensureOrganisationTenant({
    core: apis.core, objects: apis.objects, namespace: 'kcm-system', organisationSlug: 'enopax',
  });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.reason, 'already present');
  // Wuerde das Kennwort neu gesetzt, verloere jeder den Zugang, der ihn schon
  // benutzt - beim naechsten Clusterbau derselben Organisation.
  assert.strictEqual(apis.calls.createdSecrets.length, 0);
  assert.strictEqual(apis.calls.createdUsers.length, 0);
});

test('ohne Vorlage wird nichts geraten', async () => {
  const apis = fakeApis({ users: [] });
  const result = await ensureOrganisationTenant({
    core: apis.core, objects: apis.objects, namespace: 'kcm-system', organisationSlug: 'enopax',
  });

  assert.strictEqual(result.created, false);
  assert.match(result.reason, /no operator-made VMUser/);
  assert.strictEqual(apis.calls.createdUsers.length, 0);
});

test('ohne Organisation gibt es keinen Mandanten', async () => {
  const apis = fakeApis();
  const result = await ensureOrganisationTenant({
    core: apis.core, objects: apis.objects, namespace: 'kcm-system', organisationSlug: '',
  });
  assert.strictEqual(result.created, false);
  assert.strictEqual(apis.calls.createdUsers.length, 0);
});

/* ------------------------------------------- Vorlagen nach enopax/enopax#45 */

/** Der Admin-VMUser des Regionals, wie er wirklich aussieht: alle acht Pfade,
 *  **keine** query_args. Am 2026-11-27 abgelesen. */
const ADMIN_TEMPLATE = {
  metadata: { labels: { 'k0rdent.mirantis.com/kof-cluster-name': 'ep-eu1-fsn1-standalone' } },
  spec: {
    targetRefs: [
      { paths: ['/vlas/.*'], static: { url: 'http://vlselect-audit:9471' } },
      { paths: ['/vlai/.*'], static: { url: 'http://vlinsert-audit:9481' } },
      { paths: ['/vls/.*'], static: { url: 'http://vlselect:9471' } },
      { paths: ['/vli/.*'], static: { url: 'http://vlinsert:9481' } },
      { paths: ['/vm/select/.*'], static: { url: 'http://vmselect:8481' } },
      { paths: ['/vm/insert/.*'], static: { url: 'http://vminsert:8480' } },
      { paths: ['/vts/.*'], static: { url: 'http://vtselect:10471' } },
      { paths: ['/vti/.*'], static: { url: 'http://vtinsert:10481' } },
    ],
  },
};

/** Der VMUser eines Kindes, seit #45 **insert-only**. Trug vorher Lesepfade. */
const CHILD_TEMPLATE = {
  metadata: {
    labels: {
      'k0rdent.mirantis.com/kof-tenant-id': 'enopax_enopax-dev',
      'k0rdent.mirantis.com/kof-cluster-name': 'dev-box1',
    },
  },
  spec: {
    targetRefs: [
      { paths: ['/vlai/.*'], query_args: [{ name: 'extra_fields', values: ['tenant=enopax_enopax-dev'] }] },
      { paths: ['/vli/.*'], query_args: [{ name: 'extra_fields', values: ['tenant=enopax_enopax-dev'] }] },
      { paths: ['/vm/insert/.*'], query_args: [{ name: 'extra_label', values: ['tenant=enopax_enopax-dev'] }] },
      { paths: ['/vti/.*'], query_args: [{ name: 'extra_fields', values: ['resource_attr:tenant=enopax_enopax-dev'] }] },
    ],
  },
};

const listing = (items) => ({ listNamespacedCustomObject: async () => ({ items }) });

test('baut den Lesezugang aus dem ungeklemmten Admin - und klemmt jeden Pfad', async () => {
  const user = vmUserFor('enopax', ADMIN_TEMPLATE);
  const paths = user.spec.targetRefs.map((r) => r.paths[0]);
  // Genau die vier Lesepfade, keine Schreibpfade.
  assert.deepStrictEqual(paths, ['/vlas/.*', '/vls/.*', '/vm/select/.*', '/vts/.*']);
  for (const ref of user.spec.targetRefs) {
    assert.strictEqual(ref.query_args.length, 1, `${ref.paths[0]} hat mehr als eine Angabe`);
    assert.strictEqual(ref.query_args[0].name, 'extra_filters');
    assert.ok(ref.query_args[0].values[0].includes('enopax'));
    // Die Adresse kommt aus der Vorlage und ist nicht erfunden.
    assert.ok(ref.static.url.startsWith('http://'));
  }
});

test('waehlt nicht den insert-only-VMUser des Kindes als Vorlage', async () => {
  // Genau daran scheiterte es: `findTemplateUser` nahm ihn, weil er Mandanten-
  // und Cluster-Label traegt - und seit #45 hat er keinen Lesepfad mehr.
  const chosen = await findTemplateUser(listing([CHILD_TEMPLATE, ADMIN_TEMPLATE]), 'kcm-system');
  assert.strictEqual(chosen, ADMIN_TEMPLATE);

  // Und allein ergibt er nichts, statt etwas Ungeklemmtes.
  assert.strictEqual(await findTemplateUser(listing([CHILD_TEMPLATE]), 'kcm-system'), null);
  assert.throws(() => vmUserFor('enopax', CHILD_TEMPLATE), /unclamped/);
});

test('nimmt einen eigenen Zugang nicht als Vorlage', async () => {
  // Sonst vererbte sich eine eigene Klemme - und ein Fehler darin still mit.
  const own = {
    metadata: {
      labels: {
        'k0rdent.mirantis.com/kof-cluster-name': 'ep-eu1-fsn1-standalone',
        [ORG_LABEL]: 'enopax',
      },
    },
    spec: { targetRefs: [{ paths: ['/vm/select/.*'], query_args: [{ name: 'extra_filters', values: ['x'] }] }] },
  };
  assert.strictEqual(await findTemplateUser(listing([own]), 'kcm-system'), null);
});

test('welche Pfade als Lesen gelten, steht an einer Stelle', () => {
  assert.deepStrictEqual(READ_PREFIXES, ['/vm/select', '/vls', '/vlas', '/vts']);
  for (const p of ['/vm/select/.*', '/vls/.*', '/vlas/.*', '/vts/.*']) assert.ok(isReadPath(p), p);
  for (const p of ['/vm/insert/.*', '/vli/.*', '/vlai/.*', '/vti/.*']) assert.ok(!isReadPath(p), p);
});
