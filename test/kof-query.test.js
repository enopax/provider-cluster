'use strict';

const test = require('node:test');
const assert = require('node:assert');

const kofQuery = require('../provider/cluster/kof-query');

/** Eine Antwort, wie VictoriaMetrics sie gibt - abgeschrieben vom echten Aufruf. */
const answer = (values) => ({
  ok: true,
  status: 200,
  json: async () => ({
    status: 'success',
    data: { resultType: 'matrix', result: values ? [{ metric: {}, values }] : [] },
  }),
});

test('die Zeitbereiche halten die Linie zwischen 60 und 300 Punkten', () => {
  for (const [name, { seconds, step }] of Object.entries(kofQuery.RANGES)) {
    const points = seconds / step;
    assert.ok(points >= 12 && points <= 300, `${name}: ${points} Punkte`);
  }
  // 30d ist der weiteste Bereich, weil der VMCluster `retentionPeriod: 30d`
  // haelt. Mehr anzubieten hiesse, eine Kante zu zeigen, die wie ein Ausfall
  // aussieht und keiner ist.
  assert.strictEqual(Math.max(...Object.values(kofQuery.RANGES).map((r) => r.seconds)), 2592000);
});

test('ein unbekannter Zeitbereich wird abgewiesen, nicht geraten', async () => {
  await assert.rejects(
    () => kofQuery.series({ endpoint: 'http://x', credential: {}, cluster: 'a', range: '90d', now: 0 }),
    /Unknown range/,
  );
});

test('ein Clustername, der eine Abfrage aufbrechen koennte, wird abgewiesen', () => {
  assert.strictEqual(kofQuery.assertSafeName('dev-dose'), 'dev-dose');
  // Der Name wandert in eine Abfragesprache. k0rdent laesst nur DNS-Namen zu,
  // aber darauf soll sich diese Datei nicht verlassen muessen.
  for (const bad of ['a"} or up{', 'UPPER', 'has space', '-leading', '']) {
    assert.throws(() => kofQuery.assertSafeName(bad), /unexpected cluster name/);
  }
});

test('die Formeln rechnen gegen allocatable, wie der Momentanwert', () => {
  for (const build of Object.values(kofQuery.QUERIES)) {
    const q = build('dev-dose');
    assert.match(q, /kube_node_status_allocatable/);
    // `container!=""` schliesst die Sammelreihe des Pods aus, die sonst jeden
    // Wert doppelt zaehlt.
    assert.match(q, /container!=""/);
    assert.match(q, /cluster="dev-dose"/);
  }
  // Nicht node-exporter: das misst die Maschine gegen ihre Rohkapazitaet und
  // damit auch, was der Kunde nicht benutzen kann.
  for (const build of Object.values(kofQuery.QUERIES)) {
    assert.ok(!/node_memory_|node_cpu_seconds/.test(build('dev-dose')));
  }
});

test('fragt beide Groessen und gibt Punkte als [sekunde, zahl]', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return answer([[1795000000, '14.04'], [1795000300, '7.36']]);
  };

  const out = await kofQuery.series({
    endpoint: 'https://vmauth.example/vm/select/0/prometheus',
    credential: { username: 'u', password: 'p' },
    cluster: 'dev-dose',
    range: '24h',
    now: 1795000600_000,
    fetchImpl,
  });

  assert.strictEqual(urls.length, 2);
  assert.strictEqual(out.range, '24h');
  assert.strictEqual(out.step, 300);
  assert.strictEqual(out.end - out.start, 86400);
  // Eine Stelle hinter dem Komma genuegt fuer ein Prozentdiagramm.
  assert.deepStrictEqual(out.cpuPercent, [[1795000000, 14], [1795000300, 7.4]]);
  assert.deepStrictEqual(out.memPercent, [[1795000000, 14], [1795000300, 7.4]]);

  const asked = new URL(urls[0]);
  assert.strictEqual(asked.pathname, '/vm/select/0/prometheus/api/v1/query_range');
  assert.strictEqual(asked.searchParams.get('step'), '300');
});

test('der Zugang reist im Kopf, nicht in der Adresse', async () => {
  let seenUrl = '';
  let seenAuth = '';
  await kofQuery.series({
    endpoint: 'https://vmauth.example/vm/select/0/prometheus',
    credential: { username: 'enopax-kof-org-enopax', password: 'geheim' },
    cluster: 'dev-dose',
    range: '1h',
    now: 0,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.authorization;
      return answer([]);
    },
  });

  // Ein Kennwort in einer Adresse landet in jedem Zugriffsprotokoll.
  assert.ok(!seenUrl.includes('geheim'));
  assert.ok(!seenUrl.includes('enopax-kof-org-enopax'));
  assert.strictEqual(
    seenAuth,
    'Basic ' + Buffer.from('enopax-kof-org-enopax:geheim').toString('base64'),
  );
});

test('keine Reihe heisst leere Liste, nicht eine Linie bei Null', async () => {
  const out = await kofQuery.series({
    endpoint: 'http://x', credential: { username: 'u', password: 'p' },
    cluster: 'neu', range: '1h', now: 0, fetchImpl: async () => answer(null),
  });

  // Ein Cluster, der gerade entsteht, hat noch keine Messwerte. Eine Linie
  // bei Null waere die Behauptung, es sei nichts los.
  assert.deepStrictEqual(out.cpuPercent, []);
  assert.deepStrictEqual(out.memPercent, []);
});

test('eine Luecke bleibt eine Luecke', () => {
  const points = kofQuery.pointsOf({
    data: { result: [{ values: [[1, '5'], [2, 'NaN'], [3, '7']] }] },
  });
  // Eine Zeitreihe, die eine Unterbrechung ueberbrueckt, behauptet einen
  // Messwert, den es nicht gab.
  assert.deepStrictEqual(points, [[1, 5], [2, null], [3, 7]]);
});

test('ein Fehler von vmauth wird nicht zu einer leeren Linie', async () => {
  await assert.rejects(
    () => kofQuery.series({
      endpoint: 'http://x', credential: { username: 'u', password: 'p' },
      cluster: 'a', range: '1h', now: 0,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }),
    /vmauth answered 503/,
  );
});

/* ------------------------------------------------------- readEndpoint/-Cred */

test('die Leseadresse kommt aus der ConfigMap der Region', async () => {
  const core = {
    async readNamespacedConfigMap({ name, namespace }) {
      assert.strictEqual(name, 'kof-ep-eu1-fsn1-standalone');
      assert.strictEqual(namespace, 'kcm-system');
      return { data: { read_metrics_endpoint: 'https://vmauth.eu1-fsn1.kof.enopax.io/vm/select/0/prometheus/' } };
    },
  };
  const endpoint = await kofQuery.readEndpoint(core, 'ep-eu1-fsn1-standalone', 'kcm-system');
  // Ohne Schlussstrich, sonst entstehen doppelte Striche im Pfad.
  assert.strictEqual(endpoint, 'https://vmauth.eu1-fsn1.kof.enopax.io/vm/select/0/prometheus');
});

test('fehlt die Adresse, wird sie nicht gebildet', async () => {
  const core = { async readNamespacedConfigMap() { return { data: {} }; } };
  await assert.rejects(
    () => kofQuery.readEndpoint(core, 'r', 'kcm-system'),
    /has no read_metrics_endpoint/,
  );
});

test('der Zugang wird beim Namen des Org-VMUsers gelesen', async () => {
  const core = {
    async readNamespacedSecret({ name }) {
      assert.strictEqual(name, 'enopax-kof-org-enopax-creds');
      return { data: { password: Buffer.from('geheim').toString('base64') } };
    },
  };
  const cred = await kofQuery.readCredential(core, 'kcm-system', 'enopax', (s) => `enopax-kof-org-${s}`);
  assert.deepStrictEqual(cred, { username: 'enopax-kof-org-enopax', password: 'geheim' });
});
