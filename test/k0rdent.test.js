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
  tenantId: 'tenant-a_portal',
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
  // Je Projekt, nicht je Organisation: die Zugangsdaten des VMUser liegen im
  // Kindcluster, dessen kubeconfig an den Kunden geht - die Kennung
  // entscheidet, wer wessen Telemetrie lesen kann.
  assert.strictEqual(
    metadata.labels['k0rdent.mirantis.com/kof-tenant-id'],
    'tenant-a_portal',
  );

  // cert-manager, weil die hosted-Vorlage es nicht mitbringt und KOFs
  // otel-operator die Certificate-CRDs braucht. Und sonst nichts: das CNI
  // kommt vom Chart ueber die k0s-Extensions, zusammen mit hcloud-ccm und
  // hcloud-csi.
  //
  // Hier stand `['cert-manager-v1-19-3', 'cilium-1-18-1']`. Beide Wege
  // gleichzeitig haben sich ueberschrieben - am laufenden `dev-dose` belegt:
  // der Chart installierte Cilium 1.19.4, dieser Dienst neun Minuten spaeter
  // 1.18.1 darueber. Eine Rueckdatierung des CNI auf einem Cluster, der
  // schon lief.
  assert.deepStrictEqual(
    spec.serviceSpec.services.map((s) => s.template),
    ['cert-manager-v1-19-3'],
  );
  // Und keiner der Dienste darf ein CNI mitbringen - das ist der Punkt.
  assert.ok(
    spec.serviceSpec.services.every((s) => !/cilium/i.test(JSON.stringify(s))),
    'ein mitgeliefertes Cilium wuerde das des Charts ueberschreiben',
  );

  // `atomic` ausdruecklich, seit k0rdent 1.13 es nicht mehr hart setzt. Bis
  // 1.12 war es verdrahtet; ohne diese Zeile aenderte ein Upgrade des
  // Management-Clusters still unser Verhalten - ein abgebrochener Install
  // liesse dann eine halb installierte Release stehen, bei cert-manager also
  // CRDs ohne Controller. enopax/enopax#50.
  assert.deepStrictEqual(
    spec.serviceSpec.services.map((s) => s.helmOptions),
    [{ atomic: true }],
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

  // Ein Management-Cluster, in dem cert-manager fehlt - die Vorlage ist da,
  // aber nicht gueltig.
  const created = [];
  setClient({
    objects: {
      listNamespacedCustomObject: async () => ({
        items: [{ metadata: { name: 'cert-manager-v1-19-3' }, status: { valid: false } }],
      }),
      createNamespacedCustomObject: async (args) => {
        created.push(args);
        return args.body;
      },
    },
  });

  const result = await provision(PAAS);
  assert.strictEqual(result.success, false);
  assert.match(result.error, /cert-manager-v1-19-3/);
  // Und zwar ohne dass etwas entstanden ist: ein Cluster ohne die
  // Certificate-CRDs laesst kof-operators FailedNonRetriable scheitern, und
  // dann steht eine Maschine, die bezahlt wird und nichts tut.
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

test('die kubeconfig eines PaaS-Kindes wird auf dem Regional gefunden', async () => {
  const { setClient, metrics } = require('../provider/cluster/handlers');

  // Der Management-Cluster hat sie nicht - beim PaaS-Cluster liegt sie auf
  // dem regionalen. Vorher suchte dieser Dienst nur auf dem Management und
  // meldete `available: false`, waehrend beide Knoten liefen.
  const notFound = Object.assign(new Error('not found'), { code: 404 });
  const asked = [];

  setClient({
    core: {
      readNamespacedSecret: async ({ name }) => {
        asked.push(name);
        if (name === 'kind-kubeconfig') throw notFound;
        if (name === 'ep-eu1-fsn1-standalone-kubeconfig') {
          return { data: { value: Buffer.from('regional-kubeconfig').toString('base64') } };
        }
        throw notFound;
      },
    },
    objects: {
      getNamespacedCustomObject: async () => ({
        metadata: {
          labels: {
            'k0rdent.mirantis.com/kof-regional-cluster-name': 'ep-eu1-fsn1-standalone',
            'k0rdent.mirantis.com/kof-regional-cluster-namespace': 'kcm-system',
          },
        },
      }),
    },
  });

  const result = await metrics({ id: 'kcm-system/kind' });

  // Entscheidend ist die Reihenfolge: zuerst beim Management, dann ueber den
  // regionalen Cluster, dessen Namen das Objekt selbst traegt.
  assert.deepStrictEqual(asked, ['kind-kubeconfig', 'ep-eu1-fsn1-standalone-kubeconfig']);
  // Die Attrappe liefert keine brauchbare kubeconfig weiter; hier zaehlt,
  // dass ueberhaupt dort gesucht wurde.
  assert.strictEqual(result.success === false || result.available === false, true);

  setClient(null);
});

test('ein Cluster im Bau ist nicht gescheitert', () => {
  // Genau der Zustand von dev-dose, zwei Minuten nach dem Anlegen: beide
  // Server laufen, k0rdent meldet Progressing, und einer von vier
  // mitgelieferten Diensten ist oben.
  //
  // Die Vorgaengerfassung las den Grund `Failed` an ServicesInReadyState und
  // schrieb den Cluster als gescheitert in die Datenbank. Er baute noch.
  const state = readStatus({
    status: {
      conditions: [
        { type: 'CredentialReady', status: 'True' },
        { type: 'TemplateReady', status: 'True' },
        { type: 'HelmChartReady', status: 'True' },
        { type: 'HelmReleaseReady', status: 'True', reason: 'InstallSucceeded' },
        {
          type: 'Ready',
          status: 'False',
          reason: 'Progressing',
          message: '1/4 Services are ready.. * WorkersAvailable:',
        },
        { type: 'ServicesInReadyState', status: 'False', reason: 'Failed', message: '1/4' },
        { type: 'CAPIClusterSummary', status: 'False', reason: 'IssuesReported' },
      ],
    },
  });

  assert.strictEqual(state.status, 'provisioning');
  assert.strictEqual(state.ready, false);
});

test('endgueltig gescheitert ist, was nicht mehr versucht wird', () => {
  // `FailedNonRetriable` ist bei Sveltos die Stelle, an der aufgegeben wird -
  // so ist der kof-operators-Release einmal gescheitert, bevor #21 zu war.
  const state = readStatus({
    status: {
      conditions: [
        { type: 'CredentialReady', status: 'True' },
        { type: 'Ready', status: 'False', reason: 'Progressing' },
        {
          type: 'ServicesInReadyState',
          status: 'False',
          reason: 'Failed',
          message:
            'Helm=FailedNonRetriable: referenced resource: ConfigMap kcm-system/kof-cluster-config-x does not exist',
        },
      ],
    },
  });

  assert.strictEqual(state.status, 'failed');
  assert.match(state.message, /FailedNonRetriable/);
});

test('ein fertiger Cluster ist fertig, auch wenn Dienste noch zaehlen', () => {
  const state = readStatus({
    status: {
      conditions: [
        { type: 'Ready', status: 'True', reason: 'Succeeded' },
        { type: 'ServicesInReadyState', status: 'False', reason: 'Failed', message: '4/5' },
      ],
    },
  });
  // Ready entscheidet. Die Dienste sind ein eigener Zustand.
  assert.strictEqual(state.status, 'active');
  assert.strictEqual(state.ready, true);
});

test('die Auslastung wird gemessen, nicht geraten', async () => {
  const { setClient, metrics, __nodeUsage } = require('../provider/cluster/handlers');

  // Zwei Knoten verschiedener Groesse. Gerechnet wird gegen `allocatable`,
  // nicht gegen `capacity`: was das System sich reserviert, kann der Kunde
  // nicht benutzen.
  const nodes = [
    {
      metadata: { name: 'gross' },
      status: { allocatable: { cpu: '4', memory: '8Gi' } },
    },
    {
      metadata: { name: 'klein' },
      status: { allocatable: { cpu: '2', memory: '4Gi' } },
    },
  ];
  const measured = {
    items: [
      { metadata: { name: 'gross' }, usage: { cpu: '2', memory: '4Gi' } },
      { metadata: { name: 'klein' }, usage: { cpu: '100m', memory: '512Mi' } },
    ],
  };

  const usage = await __nodeUsage({ makeApiClient: () => ({}) }, nodes, async () => measured);

  // Je Knoten: 2 von 4 Kernen, 100m von 2 Kernen.
  assert.strictEqual(usage.nodes.get('gross').cpuPercent, 50);
  assert.strictEqual(usage.nodes.get('klein').cpuPercent, 5);

  // Ueber den Cluster nach Kapazitaet gewichtet: 2.1 von 6 Kernen = 35 %.
  // Der Mittelwert der Prozentwerte waere 27,5 - eine Zahl, die keiner
  // Maschine entspricht.
  assert.strictEqual(usage.cpuPercent, 35);

  setClient(null);
});

test('ohne Messung bleibt die Auslastung unbekannt', async () => {
  const { __nodeUsage } = require('../provider/cluster/handlers');

  // Der metrics-server startet neu, oder es gibt ihn nicht. Unbekannt ist
  // nicht null: eine 0 liest sich wie ein leerer Cluster.
  const usage = await __nodeUsage({ makeApiClient: () => ({}) }, [], async () => {
    throw new Error('the server could not find the requested resource');
  });

  assert.strictEqual(usage.cpuPercent, null);
  assert.strictEqual(usage.memoryPercent, null);
  assert.strictEqual(usage.nodes.size, 0);
});

/**
 * Skalieren, und zwar so, dass beide Fehler aus enopax/enopax#38 auffallen
 * wuerden.
 *
 * Die vorhandenen Tests haben keinen der beiden gefunden: `http.test.js`
 * prueft, dass `PUT /v1/clusters/:id` beim Handler ankommt - mit einem
 * untergeschobenen Handler -, und diese Datei prueft die Uebersetzung beim
 * Anlegen. Was `update` wirklich an die Kubernetes-API schickt, prueffte
 * niemand. Deshalb steht hier der Aufruf selbst: der Rumpf, der Pfad und der
 * Content-Type.
 */

/** Ein ClusterDeployment, wie es `dev-dose` wirklich ist (hosted). */
const HOSTED_OBJECT = {
  metadata: { name: 'dev-dose', namespace: 'kcm-system' },
  spec: {
    template: 'hetzner-hosted-cp-1-5-1',
    config: {
      clusterName: 'dev-dose',
      region: 'fsn1',
      core: { serverType: 'cpx32', imageName: 'ubuntu-24.04', replicas: 1 },
      worker: { serverType: 'cpx32', imageName: 'ubuntu-24.04', replicas: 2 },
    },
  },
};

/** Und eines im standalone-Dialekt, wie der laufende Regional. */
const STANDALONE_OBJECT = {
  metadata: { name: 'ep-eu1-fsn1-standalone', namespace: 'kcm-system' },
  spec: {
    template: 'hetzner-standalone-cp-1-1-0',
    config: { region: 'fsn1', controlPlaneNumber: 1, workersNumber: 2 },
  },
};

/** Faengt den Aufruf ab, den `update` an die Kubernetes-API richtet. */
function recordingClient(object) {
  const calls = [];
  return {
    calls,
    client: {
      objects: {
        getNamespacedCustomObject: async () => object,
        patchNamespacedCustomObject: async (args, options) => {
          calls.push({ args, options });
          return object;
        },
      },
    },
  };
}

/**
 * Welchen Content-Type die Options wirklich setzen.
 *
 * Nicht `deepStrictEqual` gegen `setHeaderOptions(...)` - das waere die
 * Bibliothek gegen sich selbst. Stattdessen laeuft die Middleware gegen einen
 * Abzug des Request-Objekts, so wie der Client es tun wuerde.
 */
function contentTypeOf(options) {
  const headers = {};
  const request = { setHeaderParam: (k, v) => { headers[k] = v; } };
  for (const m of (options && options.middleware) || []) m.pre(request);
  return headers['Content-Type'];
}

test('der PaaS-Cluster wird an worker.replicas skaliert', async () => {
  const { setClient, update } = require('../provider/cluster/handlers');
  const { calls, client } = recordingClient(HOSTED_OBJECT);
  setClient(client);

  const result = await update({ id: 'kcm-system/dev-dose', workerNodes: 3 });

  assert.strictEqual(result.success, true);
  assert.strictEqual(calls.length, 1);
  // Genau dieses Feld, und kein zweites: `workersNumber` wuerde die API
  // annehmen und kein Chart lesen.
  assert.deepStrictEqual(calls[0].args.body, {
    spec: { config: { worker: { replicas: 3 } } },
  });
  assert.strictEqual(calls[0].args.name, 'dev-dose');
  assert.strictEqual(calls[0].args.namespace, 'kcm-system');

  setClient(null);
});

test('der Private Cluster wird an workersNumber skaliert', async () => {
  const { setClient, update } = require('../provider/cluster/handlers');
  const { calls, client } = recordingClient(STANDALONE_OBJECT);
  setClient(client);

  await update({ id: 'kcm-system/ep-eu1-fsn1-standalone', workerNodes: 4 });

  assert.deepStrictEqual(calls[0].args.body, {
    spec: { config: { workersNumber: 4 } },
  });

  setClient(null);
});

test('das Patch geht als merge-patch hinaus, nicht als json-patch', async () => {
  const { setClient, update } = require('../provider/cluster/handlers');
  const { calls, client } = recordingClient(HOSTED_OBJECT);
  setClient(client);

  await update({ id: 'kcm-system/dev-dose', workerNodes: 3 });

  // Ohne dieses Argument waehlt der generierte Client
  // `application/json-patch+json` - den ersten der beiden erlaubten
  // Medientypen - und die API antwortet 400: ein Objekt ist keine Liste von
  // Operationen. Skalieren war dadurch in beiden Varianten wirkungslos.
  assert.strictEqual(contentTypeOf(calls[0].options), 'application/merge-patch+json');

  setClient(null);
});

test('ein Cluster mit unbekanntem Aufbau wird nicht skaliert', async () => {
  const { setClient, update } = require('../provider/cluster/handlers');
  const { calls, client } = recordingClient({
    metadata: { name: 'fremd', namespace: 'kcm-system' },
    spec: { template: 'aws-standalone-cp-1-0-0', config: { region: 'eu-central-1' } },
  });
  setClient(client);

  const result = await update({ id: 'kcm-system/fremd', workerNodes: 3 });

  // Lieber eine Absage mit Grund als ein Schluessel, den niemand liest.
  assert.strictEqual(result.success, false);
  assert.match(result.error, /neither worker\.replicas nor workersNumber/);
  assert.strictEqual(calls.length, 0);

  setClient(null);
});

test('die gemeldete Arbeiterzahl kommt aus dem Dialekt des Objekts', async () => {
  const { setClient, status } = require('../provider/cluster/handlers');

  // Vorher las `summarise` immer `config.workersNumber`. Fuer einen
  // PaaS-Cluster war das `undefined` - und nach einem Patch genau der Wert,
  // den dieser Dienst selbst hineingeschrieben hatte.
  setClient({ objects: { getNamespacedCustomObject: async () => HOSTED_OBJECT } });
  assert.strictEqual((await status({ id: 'kcm-system/dev-dose' })).workerNodes, 2);

  setClient({ objects: { getNamespacedCustomObject: async () => STANDALONE_OBJECT } });
  assert.strictEqual(
    (await status({ id: 'kcm-system/ep-eu1-fsn1-standalone' })).workerNodes,
    2,
  );

  setClient(null);
});

test('Pods werden aufgeschluesselt, nicht gezaehlt', () => {
  const { __readPods } = require('../provider/cluster/handlers');

  // Die Vorgaengerfassung gab `pods.items.length` zurueck, und console-api
  // schrieb das als "laufend". Bei dev-dose standen 31 Pods da, und es waren
  // wirklich 31 laufende - ein gescheiterter waere mitgezaehlt worden.
  const state = __readPods([
    { metadata: { namespace: 'default', name: 'a' }, status: { phase: 'Running' } },
    { metadata: { namespace: 'default', name: 'b' }, status: { phase: 'Pending' } },
    { metadata: { namespace: 'default', name: 'c' }, status: { phase: 'Failed' } },
    { metadata: { namespace: 'default', name: 'd' }, status: { phase: 'Succeeded' } },
  ]);

  assert.strictEqual(state.running, 1);
  assert.strictEqual(state.pending, 1);
  assert.strictEqual(state.failed, 1);
  assert.strictEqual(state.succeeded, 1);
});

test('ein Pod mit Neustarts faellt auf, auch wenn er laeuft', () => {
  const { __readPods } = require('../provider/cluster/handlers');

  // Genau der Fall aus dem Kindcluster: metrics-server laeuft, hatte aber
  // vier Neustarts mit exit 2. Wer nur auf "laeuft" sieht, merkt nichts.
  const state = __readPods([
    {
      metadata: { namespace: 'kube-system', name: 'metrics-server-x' },
      status: {
        phase: 'Running',
        containerStatuses: [
          { restartCount: 4, state: { running: {} }, lastState: { terminated: { reason: 'Error' } } },
        ],
      },
    },
    {
      metadata: { namespace: 'default', name: 'ruhig' },
      status: { phase: 'Running', containerStatuses: [{ restartCount: 0 }] },
    },
  ]);

  assert.strictEqual(state.running, 2);
  assert.strictEqual(state.restarts, 4);
  assert.strictEqual(state.troubled.length, 1);
  assert.strictEqual(state.troubled[0].name, 'metrics-server-x');
  assert.strictEqual(state.troubled[0].restarts, 4);
});

test('die unruhigsten zuerst, und nicht alle', () => {
  const { __readPods } = require('../provider/cluster/handlers');

  // Eine vollstaendige Liste ist bei einem grossen Cluster lang und in
  // Sekunden veraltet.
  const many = Array.from({ length: 30 }, (_, i) => ({
    metadata: { namespace: 'default', name: `p${i}` },
    status: { phase: 'Running', containerStatuses: [{ restartCount: i }] },
  }));

  const state = __readPods(many);
  assert.strictEqual(state.troubled.length, 20);
  assert.strictEqual(state.troubled[0].restarts, 29);
});

test('der Grund kommt von Kubernetes, nicht von hier', () => {
  const { __readPods } = require('../provider/cluster/handlers');

  const state = __readPods([
    {
      metadata: { namespace: 'kube-system', name: 'csi' },
      status: {
        phase: 'Pending',
        containerStatuses: [{ restartCount: 0, state: { waiting: { reason: 'CreateContainerConfigError' } } }],
      },
    },
  ]);

  // Genau diese Meldung stand beim ersten PaaS-Versuch im Kindcluster, als
  // das resource-template auf dem Regional fehlte.
  assert.strictEqual(state.troubled[0].reason, 'CreateContainerConfigError');
});

test('Volumes werden gelesen, und keine sind keine 0 TB', () => {
  const { __readVolumes } = require('../provider/cluster/handlers');

  const leer = __readVolumes([]);
  assert.strictEqual(leer.count, 0);
  assert.strictEqual(leer.totalGi, 0);
  assert.deepStrictEqual(leer.volumes, []);

  const voll = __readVolumes([
    {
      metadata: { namespace: 'kof', name: 'vmstorage-0' },
      spec: { storageClassName: 'hcloud-volumes', resources: { requests: { storage: '10Gi' } } },
      status: { phase: 'Bound', capacity: { storage: '10Gi' } },
    },
    {
      metadata: { namespace: 'db', name: 'pg-0' },
      spec: { storageClassName: 'hcloud-volumes', resources: { requests: { storage: '1Ti' } } },
      status: { phase: 'Bound', capacity: { storage: '1Ti' } },
    },
  ]);

  assert.strictEqual(voll.count, 2);
  // 10 Gi + 1 Ti. Die Einheit ist nicht kosmetisch: bei Hetzner stehen
  // dahinter Volumes, deren Groesse die Rechnung mitbestimmt.
  assert.strictEqual(voll.totalGi, 10 + 1024);
  assert.strictEqual(voll.volumes[0].storageClass, 'hcloud-volumes');
});

test('ohne Mandantenkennung kein KOF-Mandantenlabel', () => {
  const { metadata } = buildClusterDeployment({ ...PAAS, tenantId: undefined });

  // Lieber kein Label als ein falsches. Ohne Label legt der kof-operator
  // keinen VMUser an - die Telemetrie landet dann im gemeinsamen Mandanten
  // und ist nicht abgegrenzt, aber sie ist auch nicht *falsch* abgegrenzt.
  //
  // Hier stand vorher `organisationSlug` als Rueckfall. Das waere der
  // gefaehrlichere Fall: eine Klemmung auf die ganze Organisation sieht aus
  // wie Trennung und ist keine fuer projektgebundene Mitglieder.
  assert.strictEqual(metadata.labels['k0rdent.mirantis.com/kof-tenant-id'], undefined);
  // Die Zuordnung zum regionalen Cluster bleibt - die ist etwas anderes.
  assert.strictEqual(metadata.labels['k0rdent.mirantis.com/kof-cluster-role'], 'child');
});
