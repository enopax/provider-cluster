'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setClient, metrics } = require('../provider/cluster/handlers');

/**
 * Der Metrik-Handler, mit untergeschobenem Client.
 *
 * Diese Datei existiert wegen eines Ausfalls, den keiner meiner Tests finden
 * konnte: `metrics` rief `kofUsage(input.id, name)` auf, und `name` gibt es in
 * dieser Funktion nicht. Jeder Abruf antwortete mit
 *
 *     {"success":false,"error":"name is not defined"}
 *
 * also **alle** Cluster, nicht nur die mit Telemetrie. Der ClusterWatcher
 * konnte damit keinen Stand mehr auffrischen.
 *
 * Geprueft hatte ich `kof-query.js` (63 Tests) und die Routen auf HTTP-Ebene
 * mit Attrappen-Handlern. Beides lief an der Stelle vorbei, die ich geaendert
 * hatte - dem echten Handler. Dasselbe Muster wie bei der Kennung mit
 * Schraegstrich, nur eine Ebene tiefer.
 */

/** Ein Kindcluster, dessen Kubeconfig auf dem Management liegt. */
function stub({ configMapForbidden = false } = {}) {
  const kubeconfig = Buffer.from(
    'apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://127.0.0.1:1\n' +
      'users:\n- name: u\n  user: {}\ncontexts:\n- name: x\n  context:\n    cluster: c\n    user: u\n' +
      'current-context: x\n',
  ).toString('base64');

  return {
    // Die API des Kindclusters, einschiebbar - sonst scheitert `listNode()` an
    // einem unerreichbaren Server und alles danach wird nie ausgefuehrt. Genau
    // daran lief die erste Fassung dieses Tests vorbei: sie war gruen, auch
    // mit dem Fehler drin.
    childApis: () => ({
      core: {
        async listNode() {
          return {
            items: [
              {
                metadata: { name: 'dev-box1-md-abc', creationTimestamp: '2026-11-24T10:00:00Z' },
                status: {
                  conditions: [{ type: 'Ready', status: 'True' }],
                  nodeInfo: { kubeletVersion: 'v1.35.4+k0s' },
                  allocatable: { cpu: '4', memory: '8Gi' },
                },
              },
            ],
          };
        },
        async listPodForAllNamespaces() {
          return { items: [] };
        },
        async listPersistentVolumeClaimForAllNamespaces() {
          return { items: [] };
        },
      },
    }),
    core: {
      async readNamespacedSecret() {
        return { data: { value: kubeconfig } };
      },
      async readNamespacedConfigMap() {
        if (configMapForbidden) {
          // Genau die Meldung, die der Cluster gab: das Recht fehlte in
          // deploy/rbac.yaml, weil `readEndpoint` eine ConfigMap liest.
          throw new Error('configmaps "kof-x" is forbidden: User "…" cannot get resource "configmaps"');
        }
        return { data: { read_metrics_endpoint: 'https://vmauth.example/vm/select/0/prometheus' } };
      },
    },
    objects: {
      async getNamespacedCustomObject() {
        return {
          metadata: {
            namespace: 'kcm-system',
            name: 'dev-box1',
            labels: {
              'enopax.io/organisation': 'enopax',
              'k0rdent.mirantis.com/kof-regional-cluster-name': 'ep-eu1-fsn1-standalone',
              'k0rdent.mirantis.com/kof-regional-cluster-namespace': 'kcm-system',
            },
          },
        };
      },
    },
  };
}

test('der Handler kommt bis zum Kindcluster, ohne an einer eigenen Variable zu scheitern', async () => {
  setClient(stub());
  try {
    const result = await metrics({ id: 'kcm-system/dev-box1' });

    // Der Kindcluster ist unerreichbar (Server 127.0.0.1:1) - das ist in
    // Ordnung und der Punkt dieses Tests ist ein anderer: es darf **kein**
    // Fehler aus dem Handler selbst kommen.
    assert.ok(!/is not defined/.test(result.error || ''), `eigener Fehler: ${result.error}`);
    assert.ok(!/is not a function/.test(result.error || ''), `eigener Fehler: ${result.error}`);
  } finally {
    setClient(null);
  }
});

test('ohne id sagt er das, statt zu werfen', async () => {
  const result = await metrics({});
  assert.strictEqual(result.success, false);
  assert.match(result.error, /Missing required field: id/);
});

test('ein fehlendes Recht auf ConfigMaps nimmt die Metriken nicht mit', async () => {
  // `kofUsage` faengt und gibt `null` zurueck; der metrics-server bleibt.
  // Haette es geworfen, waere mit der Telemetrie auch die Knotenliste weg -
  // und die haengt nicht an KOF.
  setClient(stub({ configMapForbidden: true }));
  try {
    const result = await metrics({ id: 'kcm-system/dev-box1' });
    assert.ok(!/forbidden/.test(result.error || ''), 'das RBAC-Problem darf nicht durchschlagen');
  } finally {
    setClient(null);
  }
});
