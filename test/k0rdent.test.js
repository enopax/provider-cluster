/**
 * Die Uebersetzung gegen die Fassungen, die wirklich gebaut haben.
 *
 * Nicht gegen die Chart-Vorgaben und nicht gegen die Dokumentation: dreimal
 * hat dieser Dienst ein ClusterDeployment erzeugt, das die Kubernetes-API
 * annahm und das k0rdent nicht fertigbauen konnte. Jedes Mal stand die
 * richtige Antwort in einem Manifest unter `K0Cluster/`, das schon gelaufen
 * war. Diese Tests halten genau diese Manifeste fest.
 *
 * Laufen ohne Cluster und ohne Abhaengigkeiten: `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildClusterDeployment, readStatus, DIALECTS } = require('../provider/cluster/k0rdent');

/** Wie console-api einen Private Cluster schickt. */
const PRIVATE = {
  name: 'ep-eu1-fsn1-standalone',
  providerId: 'hetzner',
  dialect: 'HETZNER_STANDALONE',
  template: 'hetzner-standalone-cp-1-1-0',
  credential: 'hcloud-eu1-fsn1',
  region: 'fsn1',
  controlPlaneNumber: 1,
  controlPlaneType: 'cpx32',
  workersNumber: 2,
  workerType: 'cpx32',
  sshKeyNames: ['anmn'],
  tokenSecretName: 'hcloud-cluster-provisioning-token',
  tokenSecretKey: 'HCLOUD_TOKEN',
  k0sVersion: 'v1.35.4+k0s.0',
};

/** Wie console-api einen PaaS Cluster schickt. */
const PAAS = {
  name: 'eu1f-test01',
  providerId: 'hetzner',
  dialect: 'HETZNER_HOSTED',
  template: 'hetzner-hosted-cp-1-5-1',
  credential: 'hcloud-eu1-fsn1',
  region: 'fsn1',
  workersNumber: 1,
  workerType: 'cpx22',
  sshKeyNames: ['anmn'],
  hostedSecretName: 'hetzner',
  childApiDomain: 'eu1-fsn1.k8s.enopax.io',
  regionalClusterName: 'ep-eu1-fsn1-standalone',
  regionalClusterNamespace: 'kcm-system',
  organisationSlug: 'tenant-a',
  k0sVersion: 'v1.35.4+k0s.0',
};

test('der Private Cluster traegt, was die Vorlage verlangt', () => {
  const { spec } = buildClusterDeployment(PRIVATE);

  // Die Pflichtfelder aus values.schema.json des Charts. `image` fehlt
  // absichtlich: dort tragen die Chart-Vorgaben, bei den drei hier nicht.
  assert.deepStrictEqual(spec.config, {
    region: 'fsn1',
    controlPlaneNumber: 1,
    workersNumber: 2,
    controlPlane: { type: 'cpx32' },
    worker: { type: 'cpx32' },
    sshKeyNames: ['anmn'],
    tokenRef: { name: 'hcloud-cluster-provisioning-token', key: 'HCLOUD_TOKEN' },
    k0s: { version: 'v1.35.4+k0s.0' },
  });
  // Der standalone-Cluster bekommt keine Dienste mitgeliefert.
  assert.strictEqual(spec.serviceSpec, undefined);
});

test('der PaaS Cluster ist feldgleich mit eu1f-test01', () => {
  const { spec, metadata } = buildClusterDeployment(PAAS);

  assert.deepStrictEqual(spec.config, {
    clusterName: 'eu1f-test01',
    region: 'fsn1',
    // Singular. Der hosted-Chart nimmt einen Namen, standalone eine Liste.
    sshKeyName: 'anmn',
    hetznerSecretName: 'hetzner',
    clusterNetwork: {
      // Ebenfalls Singular, anders als bei standalone.
      pods: { cidrBlock: '10.244.0.0/16' },
      services: { cidrBlock: '10.96.0.0/12' },
    },
    core: { serverType: 'cpx22', imageName: 'ubuntu-24.04', replicas: 1 },
    worker: { serverType: 'cpx22', imageName: 'ubuntu-24.04', replicas: 1 },
    ingress: {
      enabled: true,
      apiHost: 'api.eu1f-test01.eu1-fsn1.k8s.enopax.io',
      konnectivityHost: 'k.eu1f-test01.eu1-fsn1.k8s.enopax.io',
    },
    k0s: { version: 'v1.35.4+k0s.0' },
  });

  // Keine Steuerungsebene als Server: sie laeuft als Pods auf dem Regional.
  assert.strictEqual(spec.config.controlPlaneNumber, undefined);
  assert.strictEqual(spec.config.controlPlane, undefined);

  // Ohne diese Labels erreicht die KOF-Konfiguration des Kindes den
  // regionalen Cluster nicht, und kof-operators scheitert FailedNonRetriable.
  assert.strictEqual(metadata.labels['k0rdent.mirantis.com/kof-cluster-role'], 'child');
  assert.strictEqual(
    metadata.labels['k0rdent.mirantis.com/kof-regional-cluster-name'],
    'ep-eu1-fsn1-standalone',
  );
  assert.strictEqual(metadata.labels['k0rdent.mirantis.com/kof-tenant-id'], 'tenant-a');

  // cert-manager, weil die hosted-Vorlage es nicht mitbringt; Cilium, weil
  // der Cluster sonst kein CNI hat.
  assert.deepStrictEqual(
    spec.serviceSpec.services.map((s) => s.template),
    ['cert-manager-v1-19-3', 'cilium-1-18-1'],
  );
  // Findet Cilium die API nicht, startet kein Pod.
  assert.match(
    spec.serviceSpec.services[1].values,
    /^k8sServiceHost: api\.eu1f-test01\.eu1-fsn1\.k8s\.enopax\.io$/m,
  );
});

test('AWS nimmt genau einen SSH-Schluessel, nicht stillschweigend mehrere', () => {
  const { spec } = buildClusterDeployment({
    ...PRIVATE,
    dialect: 'AWS_STANDALONE',
    region: 'eu-central-1',
    controlPlaneType: 't3.large',
    workerType: 't3.large',
    sshKeyNames: ['erster', 'zweiter'],
  });
  assert.strictEqual(spec.config.sshKeyName, 'erster');
  assert.strictEqual(spec.config.sshKeyNames, undefined);
  assert.deepStrictEqual(spec.config.controlPlane, { instanceType: 't3.large' });
});

test('abgewiesen wird vor dem Anlegen, nicht vom Betrieb gefunden', () => {
  const refuses = (patch, pattern) =>
    assert.throws(() => buildClusterDeployment({ ...PRIVATE, ...patch }), pattern);

  // Jeder dieser vier Faelle hat einmal ein Objekt erzeugt, das die
  // Kubernetes-API annahm und k0rdent nicht bauen konnte.
  refuses({ sshKeyNames: [] }, /at least one SSH key/);
  refuses({ tokenSecretName: undefined }, /tokenSecretName and tokenSecretKey/);
  refuses({ workersNumber: undefined }, /workersNumber/);
  refuses({ k0sVersion: '1.30.4' }, /not a k0s version/);

  refuses({ dialect: undefined }, /Missing required field: dialect/);
  refuses({ dialect: 'OPENSTACK_HOSTED' }, /Unknown dialect/);
});

test('der PaaS Cluster wird ohne Ingress und ohne Secret abgewiesen', () => {
  assert.throws(
    () => buildClusterDeployment({ ...PAAS, childApiDomain: undefined }),
    /childApiDomain/,
  );
  assert.throws(
    () => buildClusterDeployment({ ...PAAS, hostedSecretName: undefined }),
    /hostedSecretName/,
  );
});

test('jeder Dialekt sagt, was er verlangt', () => {
  for (const [name, shape] of Object.entries(DIALECTS)) {
    assert.strictEqual(typeof shape.sshKeysRequired, 'boolean', `${name}: sshKeysRequired`);
    assert.strictEqual(typeof shape.tokenRefRequired, 'boolean', `${name}: tokenRefRequired`);
  }
});

test('die Stufen kommen aus den Bedingungen, nicht von hier', () => {
  const state = readStatus({
    status: {
      conditions: [
        { type: 'CredentialReady', status: 'True' },
        { type: 'TemplateReady', status: 'True' },
        { type: 'HelmChartReady', status: 'True' },
        { type: 'HelmReleaseReady', status: 'True' },
        { type: 'Ready', status: 'False', reason: 'Progressing', message: 'InfrastructureReady' },
      ],
    },
  });
  assert.strictEqual(state.ready, false);
  // "Progressing" ist nicht gescheitert - k0rdent versucht es weiter.
  assert.strictEqual(state.status, 'provisioning');
  assert.strictEqual(state.progress, 67);
  assert.strictEqual(state.stages.find((s) => s.key === 'Ready').state, 'running');
  assert.strictEqual(state.stages.find((s) => s.key === 'ServicesInReadyState').state, 'pending');
});

test('die mitgelieferten Dienste werden vor dem Anlegen nachgesehen', async () => {
  const { setClient, provision } = require('../provider/cluster/handlers');

  // Ein Management-Cluster, in dem Cilium fehlt.
  const created = [];
  setClient({
    objects: {
      listNamespacedCustomObject: async () => ({
        items: [{ metadata: { name: 'cert-manager-v1-19-3' }, status: { valid: true } }],
      }),
      createNamespacedCustomObject: async (args) => {
        created.push(args);
        return args.body;
      },
    },
  });

  const result = await provision(PAAS);
  assert.strictEqual(result.success, false);
  assert.match(result.error, /cilium-1-18-1/);
  // Und zwar ohne dass etwas entstanden ist.
  assert.strictEqual(created.length, 0);

  setClient(null);
});

test('ein Fehler beim Nachsehen ist kein Fehlen', async () => {
  const { setClient, provision } = require('../provider/cluster/handlers');

  // Ohne Antwort wissen wir es nicht. Eine Absage auf Verdacht waere so
  // falsch wie eine Zusage - also weiterbauen.
  const created = [];
  setClient({
    objects: {
      listNamespacedCustomObject: async () => {
        throw new Error('etcdserver: request timed out');
      },
      createNamespacedCustomObject: async (args) => {
        created.push(args);
        return { ...args.body, metadata: { ...args.body.metadata, creationTimestamp: 'x' } };
      },
    },
  });

  const result = await provision(PAAS);
  assert.strictEqual(result.success, true);
  assert.strictEqual(created.length, 1);

  setClient(null);
});
