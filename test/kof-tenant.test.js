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
} = require('../provider/cluster/kof-tenant');

/**
 * Eine Vorlage, wie `kof-operator` sie legt - gekuerzt, aber in der Form echt:
 * Lesepfade tragen `extra_filters`, Schreibpfade `extra_label` bzw.
 * `extra_fields`. Abgeschrieben von `kof-vmuser-457707155` am laufenden
 * regionalen Cluster.
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
