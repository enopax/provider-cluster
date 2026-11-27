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
const { registerRoutes } = require('../provider/cluster/routes');

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

  registerRoutes(app, {
    series: async (input) => {
      seen.push({ op: 'series', id: input.id, range: input.range });
      if (input.range && !['1h', '24h', '7d', '30d'].includes(input.range)) {
        return { success: false, error: `Unknown range: "${input.range}". Known: 1h, 24h, 7d, 30d` };
      }
      return { success: true, id: input.id, available: true, range: input.range || '24h', cpuPercent: [] };
    },
    kubeconfig: async (input) => {
      seen.push({ op: 'kubeconfig', id: input.id });
      if (input.id.endsWith('building')) {
        return { success: false, pending: true, error: 'still being built' };
      }
      return { success: true, id: input.id, via: 'ep-eu1-fsn1-standalone', kubeconfig: 'apiVersion: v1\n' };
    },
    dashboardAccess: async (input) => {
      seen.push({ op: 'dashboardAccess', id: input.id, tenantId: input.tenantId, email: input.email });
      if (!input.tenantId) return { success: false, error: 'Missing required field: tenantId' };
      if (input.id.endsWith('private')) {
        return {
          success: false,
          available: false,
          error: 'This cluster has no regional cluster, so there is no Grafana to open.',
        };
      }
      return { success: true, id: input.id, tenantId: input.tenantId, orgId: 5 };
    },
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

test('die kubeconfig haengt an einer eigenen Route und kommt heraus', async () => {
  const { base, seen, server } = await serve();
  try {
    const response = await call(base, `/v1/clusters/${encodeURIComponent(ID)}/kubeconfig`);
    assert.strictEqual(response.status, 200);

    const body = await response.json();
    assert.match(body.kubeconfig, /^apiVersion: v1/);
    // Ueber welchen Cluster sie gefunden wurde, gehoert in die Antwort: beim
    // PaaS-Cluster ist das der regionale.
    assert.strictEqual(body.via, 'ep-eu1-fsn1-standalone');
    assert.deepStrictEqual(seen, [{ op: 'kubeconfig', id: ID }]);
  } finally {
    server.close();
  }
});

test('ein Cluster im Bau gibt 409, keine leere Datei', async () => {
  const { base, server } = await serve();
  try {
    const response = await call(
      base,
      `/v1/clusters/${encodeURIComponent('kcm-system/building')}/kubeconfig`,
    );
    // Nichts ist falsch - es ist nur noch nicht da. Eine leere Datei waere
    // schlimmer als eine Absage: sie sieht aus wie ein Zugang.
    assert.strictEqual(response.status, 409);
    const body = await response.json();
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.kubeconfig, undefined);
  } finally {
    server.close();
  }
});

test('ohne API-Key kommt die kubeconfig nicht heraus', async () => {
  const { base, server } = await serve();
  try {
    // Die Route erbt authMiddleware ueber app.use - das ist der Grund, warum
    // sie dort und nicht in einem eigenen Server haengt.
    const response = await fetch(`${base}/v1/clusters/${encodeURIComponent(ID)}/kubeconfig`);
    assert.strictEqual(response.status, 401);
  } finally {
    server.close();
  }
});

test('die Zeitreihen erreichen ihre Kennung, und der Bereich kommt mit', async () => {
  const { base, seen, server } = await serve();
  try {
    const encoded = encodeURIComponent(ID);

    const ok = await call(base, `/v1/clusters/${encoded}/series?range=7d`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).range, '7d');

    // Ohne Angabe gilt die Vorgabe des Handlers, nicht ein Fehler.
    const plain = await call(base, `/v1/clusters/${encoded}/series`);
    assert.strictEqual(plain.status, 200);
    assert.strictEqual((await plain.json()).range, '24h');

    assert.deepStrictEqual(
      seen.filter((x) => x.op === 'series'),
      [
        { op: 'series', id: ID, range: '7d' },
        { op: 'series', id: ID, range: undefined },
      ],
    );
  } finally {
    server.close();
  }
});

test('ein unbekannter Zeitbereich ist 400, kein 500', async () => {
  const { base, server } = await serve();
  try {
    const response = await call(base, `/v1/clusters/${encodeURIComponent(ID)}/series?range=90d`);
    // Ein Fehler des Aufrufers soll nicht wie ein Serverproblem aussehen -
    // sonst sucht jemand den Ausfall, den es nicht gibt.
    assert.strictEqual(response.status, 400);
    assert.match((await response.json()).error, /Unknown range/);
  } finally {
    server.close();
  }
});

test('ohne Schluessel gibt es auch keine Zeitreihen', async () => {
  const { base, server } = await serve();
  try {
    const response = await fetch(`${base}/v1/clusters/${encodeURIComponent(ID)}/series`);
    assert.strictEqual(response.status, 401);
  } finally {
    server.close();
  }
});

test('der Sprungzugang nimmt einen Rumpf an und gibt die Organisation zurueck', async () => {
  const { base, seen, server } = await serve();
  try {
    const response = await call(base, `/v1/clusters/${encodeURIComponent(ID)}/dashboard-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'acme_telemetry',
        email: 'ada@enopax.io',
        name: 'Ada',
        grafanaUrl: 'https://grafana.eu1-fsn1.kof.enopax.io',
      }),
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      success: true, id: ID, tenantId: 'acme_telemetry', orgId: 5,
    });
    // Die Kennung mit Schraegstrich muss ungeteilt ankommen, und der Rumpf
    // ueberhaupt - ohne `express.json()` waere `tenantId` undefined.
    assert.deepStrictEqual(seen, [
      { op: 'dashboardAccess', id: ID, tenantId: 'acme_telemetry', email: 'ada@enopax.io' },
    ]);
  } finally {
    server.close();
  }
});

test('ein fehlendes Feld ist 400, kein Ausfall', async () => {
  const { base, server } = await serve();
  try {
    const response = await call(base, `/v1/clusters/${encodeURIComponent(ID)}/dashboard-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@enopax.io' }),
    });
    assert.strictEqual(response.status, 400);
  } finally {
    server.close();
  }
});

test('ein Cluster ohne Region ist 409 - dort gibt es nichts zu oeffnen', async () => {
  const { base, server } = await serve();
  try {
    const response = await call(
      base,
      `/v1/clusters/${encodeURIComponent('kcm-system/private')}/dashboard-access`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: 'acme_x', email: 'a@b.c', grafanaUrl: 'https://g.kof.enopax.io' }),
      },
    );
    assert.strictEqual(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /no regional cluster/);
  } finally {
    server.close();
  }
});
