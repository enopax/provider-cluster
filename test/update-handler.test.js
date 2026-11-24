'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setClient, update } = require('../provider/cluster/handlers');

/**
 * `update` mit untergeschobenem Client.
 *
 * Diese Datei prueft nicht die Patch-Bauer - das tut `k0rdent.test.js` ohne
 * Cluster -, sondern den Weg dazwischen: **was wirklich an die API geht**.
 * Zweimal hat genau dieser Weg getragen, was die reine Uebersetzung nicht
 * zeigen konnte:
 *
 *   - der Medientyp (`application/json-patch+json` statt Merge Patch), und
 *   - das Feld, das kein Chart liest (enopax/enopax#38).
 *
 * Beides sah in der Antwort wie Erfolg aus.
 */

/** Ein ClusterDeployment im hosted-Dialekt, wie `dev-box1` es traegt. */
function hosted() {
  return {
    apiVersion: 'k0rdent.mirantis.com/v1beta1',
    kind: 'ClusterDeployment',
    metadata: { namespace: 'kcm-system', name: 'dev-box1' },
    spec: {
      template: 'hetzner-hosted-cp-1-5-1',
      config: {
        k0s: { version: 'v1.35.4+k0s.0' },
        worker: { replicas: 2, serverType: 'cpx32' },
        region: 'fsn1',
      },
    },
  };
}

/** Ein standalone-ClusterDeployment, wie `ep-eu1-fsn1-standalone` es traegt. */
function standalone() {
  return {
    metadata: { namespace: 'kcm-system', name: 'ep-eu1-fsn1-standalone' },
    spec: {
      template: 'hetzner-standalone-cp-1-1-0',
      config: {
        k0s: { version: 'v1.35.4+k0s.0' },
        workersNumber: 3,
        controlPlaneNumber: 1,
        region: 'fsn1',
      },
    },
  };
}

/**
 * Nimmt den Patch an und spiegelt ihn in das Objekt zurueck - so wie der
 * API-Server es mit einem Merge Patch tut. Eine Attrappe, die den Patch
 * wegwirft und das alte Objekt zurueckgibt, waere freundlicher als die
 * Wirklichkeit und koennte einen wirkungslosen Patch nicht zeigen.
 */
function stub(object) {
  const calls = [];
  return {
    calls,
    objects: {
      getNamespacedCustomObject: async () => object,
      patchNamespacedCustomObject: async (args, options) => {
        calls.push({ body: args.body, options });
        const config = { ...object.spec.config };
        const patch = args.body.spec.config;
        for (const [key, value] of Object.entries(patch)) {
          config[key] = value && typeof value === 'object' ? { ...config[key], ...value } : value;
        }
        return { ...object, spec: { ...object.spec, config } };
      },
    },
  };
}

test('die k0s-Version wandert nach spec.config.k0s.version, als Merge Patch', async () => {
  const client = stub(hosted());
  setClient(client);

  const result = await update({ id: 'kcm-system/dev-box1', k0sVersion: 'v1.36.3+k0s.0' });

  assert.equal(result.success, true);
  assert.deepEqual(client.calls[0].body, {
    spec: { config: { k0s: { version: 'v1.36.3+k0s.0' } } },
  });
  // Der Medientyp steht ausdruecklich dabei. Ohne ihn schickt der generierte
  // Client `application/json-patch+json`, und der API-Server lehnt ein Objekt
  // ab, wo er eine Liste von Operationen erwartet.
  assert.ok(client.calls[0].options, 'ohne Options-Argument waehlt der Client JSON Patch');
});

test('die Antwort traegt die Version des gepatchten Objekts, nicht die der Anfrage', async () => {
  // Das ist die Pruefbarkeit, die enopax/enopax#38 gefehlt hat: der Aufrufer
  // soll nachlesen koennen, was oben steht, statt einem `success: true` zu
  // glauben.
  setClient(stub(standalone()));
  const result = await update({
    id: 'kcm-system/ep-eu1-fsn1-standalone',
    k0sVersion: 'v1.36.3+k0s.0',
  });
  assert.equal(result.k8sVersion, 'v1.36.3+k0s.0');
  assert.equal(result.workerNodes, 3, 'die Arbeiterzahl bleibt, wenn nur die Version gesetzt wird');
});

test('Version und Knotenzahl gehen in einem Aufruf', async () => {
  // Zwei Schreibungen koennten zur Haelfte gelingen - neue Version, alte
  // Knotenzahl -, und die Antwort saehe in beiden Faellen gleich aus.
  const client = stub(hosted());
  setClient(client);

  const result = await update({
    id: 'kcm-system/dev-box1',
    workerNodes: 4,
    k0sVersion: 'v1.36.3+k0s.0',
  });

  assert.equal(client.calls.length, 1, 'ein Patch, nicht zwei');
  assert.deepEqual(client.calls[0].body.spec.config, {
    worker: { replicas: 4 },
    k0s: { version: 'v1.36.3+k0s.0' },
  });
  assert.equal(result.workerNodes, 4);
  assert.equal(result.k8sVersion, 'v1.36.3+k0s.0');
});

test('eine Version in falscher Schreibweise geht nicht an die API', async () => {
  // `1.36.3` ergibt eine Download-URL, die es nicht gibt. Das faellt sonst
  // erst an einem Knoten auf, der nie beitritt - und der laeuft schon.
  const client = stub(hosted());
  setClient(client);

  const result = await update({ id: 'kcm-system/dev-box1', k0sVersion: '1.36.3' });

  assert.equal(result.success, false);
  assert.match(result.error, /not a k0s version/);
  assert.equal(client.calls.length, 0, 'nichts geschrieben');
});

test('eine Vorlage ohne k0s.version wird abgewiesen statt blind gepatcht', async () => {
  const foreign = hosted();
  delete foreign.spec.config.k0s;
  const client = stub(foreign);
  setClient(client);

  const result = await update({ id: 'kcm-system/dev-box1', k0sVersion: 'v1.36.3+k0s.0' });

  assert.equal(result.success, false);
  assert.match(result.error, /no k0s\.version|carries no k0s\.version/);
  assert.equal(client.calls.length, 0);
});

test('ohne Angabe sagt er, was er erwartet', async () => {
  setClient(stub(hosted()));
  const result = await update({ id: 'kcm-system/dev-box1' });
  assert.equal(result.success, false);
  assert.match(result.error, /workerNodes or k0sVersion/);
});
