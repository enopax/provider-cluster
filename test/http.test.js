/**
 * Die Endpunkte über HTTP, nicht gegen die Handler.
 *
 * Diese Datei existiert wegen eines Fehlers, den kein Handler-Test finden
 * konnte: `resource-api` registriert `/v1/clusters/:id` - ein einzelnes
 * Pfadsegment -, waehrend die Kennung eines Clusters `namespace/name` ist.
 * Ein Schraegstrich darin macht aus dem Pfad zwei Segmente, und die Route
 * trifft nicht mehr.
 *
 * Status und Metriken wurden deshalb **nie** abgerufen. Ein fertiger Cluster
 * blieb auf PROVISIONING, die Console zeigte "0 von 0" fuer zwei laufende
 * Knoten, und im Log stand die Anfrage ohne Antwort. Alle meine Tests liefen
 * an der Naht vorbei, weil sie die Funktionen direkt aufrufen.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('@enopax/resource-api');

const API_KEY = 'test-key';
const ID = 'kcm-system/some-cluster';

/** Ein Server mit Attrappen-Handlern, der nur die Wege prueft. */
function serve() {
  const seen = [];
  const record = (op) => async (input) => {
    seen.push({ op, id: input && input.id });
    return { success: true, id: input && input.id, op };
  };

  const app = createServer({
    port: 0,
    host: '127.0.0.1',
    authentication: { enabled: true, apiKey: API_KEY },
    providers: [
      {
        apiVersion: 'v1',
        endpoint: '/clusters',
        providerFolder: './provider/cluster',
        handlers: {
          provision: record('provision'),
          status: record('status'),
          metrics: record('metrics'),
          update: record('update'),
          deprovision: record('deprovision'),
          list: record('list'),
        },
      },
    ],
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}`, seen, server }),
    );
  });
}

const call = (base, path, init) =>
  fetch(base + path, { ...init, headers: { 'X-API-Key': API_KEY, ...(init || {}).headers } });

test('eine Kennung mit Schraegstrich erreicht Status und Metriken', async () => {
  const { base, seen, server } = await serve();
  try {
    const encoded = encodeURIComponent(ID);

    const status = await call(base, `/v1/clusters/${encoded}`);
    assert.strictEqual(status.status, 200, 'Status muss erreichbar sein');

    const metrics = await call(base, `/v1/clusters/${encoded}/metrics`);
    assert.strictEqual(metrics.status, 200, 'Metriken muessen erreichbar sein');

    // Und die Kennung muss beim Handler ungeteilt ankommen - sonst sucht er
    // im falschen Namespace.
    assert.deepStrictEqual(
      seen.map((s) => s.op),
      ['status', 'metrics'],
    );
    for (const s of seen) assert.strictEqual(s.id, ID, `${s.op} bekam "${s.id}"`);
  } finally {
    server.close();
  }
});

test('unkodiert trifft die Route nicht - der Grund fuer den Ausfall', async () => {
  const { base, server } = await serve();
  try {
    // Genau das schickte console-api, und genau das kam zurueck.
    const response = await call(base, `/v1/clusters/${ID}`);
    assert.strictEqual(response.status, 404);
  } finally {
    server.close();
  }
});

test('Skalieren und Loeschen erreichen ihre Kennung ebenfalls', async () => {
  const { base, seen, server } = await serve();
  try {
    const encoded = encodeURIComponent(ID);

    const scaled = await call(base, `/v1/clusters/${encoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerNodes: 3 }),
    });
    assert.strictEqual(scaled.status, 200);

    const deleted = await call(base, `/v1/clusters/${encoded}`, { method: 'DELETE' });
    assert.strictEqual(deleted.status, 200);

    assert.deepStrictEqual(
      seen.map((s) => s.op),
      ['update', 'deprovision'],
    );
    for (const s of seen) assert.strictEqual(s.id, ID);
  } finally {
    server.close();
  }
});
