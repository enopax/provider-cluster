/**
 * Uebersetzung zwischen der Anfrage des Portals und einem k0rdent-ClusterDeployment.
 *
 * KCM hat keine eigene REST-Schnittstelle. Was es anbietet, ist die
 * Kubernetes-API des Management-Clusters mit seinen CRDs; dieser Provider ist
 * die Fassade davor. Er legt ein ClusterDeployment an und liest dessen Status -
 * gebaut wird der Cluster von KCM selbst, ueber Cluster API und Helm.
 *
 * Was hier *nicht* entschieden wird: welche Vorlage, welches Credential,
 * welcher Standort, welche Maschinentypen. Das weiss console-api aus seinen
 * Tabellen provider_regions und provider_sizes und schickt es mit. Diese Datei
 * weiss nur, wie ein Hetzner- und wie ein AWS-ClusterDeployment aussieht.
 */

const GROUP = 'k0rdent.mirantis.com';
const VERSION = 'v1beta1';
const PLURAL = 'clusterdeployments';

/** Wo die ClusterDeployments angelegt werden, solange es keine Mandanten-Namespaces gibt. */
const DEFAULT_NAMESPACE = process.env.KCM_NAMESPACE || 'kcm-system';

/**
 * Die Konfigurationssprachen der Vorlagen.
 *
 * Der Dialekt haengt an der Vorlagenfamilie, nicht am Anbieter. Zu Hetzner
 * gehoeren zwei gueltige Familien, und sie sind sich in fast keinem Feld
 * einig:
 *
 *   hetzner-standalone-cp   sshKeyNames[]  worker.type   workersNumber
 *   hetzner-hosted-cp       sshKeyName     worker.serverType  worker.replicas
 *
 * Die Vorgaengerfassung hielt die Sprache am Anbieternamen fest und konnte
 * damit nur eine der beiden bauen. Welchen Dialekt eine Vorlage spricht,
 * weiss console-api aus provider_templates und schickt es mit.
 *
 * Belegt ist bislang nur HETZNER_STANDALONE: damit laeuft
 * ep-eu1-fsn1-standalone. HETZNER_HOSTED ist beschrieben, aber ungebaut, und
 * steht deshalb unten bei den noch nicht unterstuetzten.
 */
const DIALECTS = {
  HETZNER_STANDALONE: {
    machineTypeKey: 'type',
    // Pflicht. Ohne scheitert nicht das ClusterDeployment - das nimmt die
    // API an -, sondern erst der Helm-Install mit
    // "HetznerCluster ... spec.sshKeys: Required value".
    sshKeysRequired: true,
    sshKeys: (names) => ({ sshKeyNames: names }),
    // Ebenfalls Pflicht, und ebenfalls erst spaet sichtbar: die Vorlage hat
    // `tokenRef.name: ""` als Vorgabe und nennt den Schluessel
    // `hcloud-token`, unser Secret fuehrt ihn als `HCLOUD_TOKEN`. Fehlt es,
    // installiert Helm erfolgreich und CAPH meldet danach
    // "HCloudTokenAvailable: invalid or not specified hcloud token".
    tokenRefRequired: true,
  },
  AWS_STANDALONE: {
    machineTypeKey: 'instanceType',
    sshKeysRequired: false,
    // AWS nimmt genau einen; mehrere waeren ein stiller Datenverlust.
    sshKeys: (names) => (names.length ? { sshKeyName: names[0] } : {}),
    tokenRefRequired: false,
  },
};

/**
 * Dialekte, die wir kennen und noch nicht erzeugen.
 *
 * HETZNER_HOSTED ist der PaaS-Cluster. Er ist **nicht unerprobt** - er hat
 * reproduzierbar gebaut: `eu1f-test01` erreichte Ready 5/5 mit Steuerungsebene
 * und etcd auf zwei regionalen Workern und null kmc-Pods auf dem
 * Management-Cluster. Die bewaehrte Fassung steht in
 * `K0Cluster/cluster/terraform/manifests/eu1f-test01.yaml`; der Betrieb des
 * regionalen Clusters traegt die Voraussetzungen dafuer bis heute.
 *
 * Was fehlt, ist allein die Uebersetzung hier. Dazu gehoert mehr als andere
 * Feldnamen:
 *
 *   - `ingress.apiHost` und `ingress.konnectivityHost`, je Cluster und je
 *     Region: `api.<name>.<region>.k8s.enopax.io`. Ohne sie initialisiert die
 *     Steuerungsebene nicht.
 *   - `serviceSpec` mit zwei Diensten: cert-manager (die Vorlage bringt es
 *     nicht mit, KOFs otel-operator braucht die Certificate-CRDs) und Cilium,
 *     dessen `k8sServiceHost` denselben apiHost traegt.
 *   - die KOF-Labels, die das Kind seinem regionalen Cluster und seinem
 *     Mandanten zuordnen.
 *   - `clusterNetwork.pods.cidrBlock` - Singular, waehrend standalone
 *     `cidrBlocks` als Liste verlangt.
 *
 * Und eine Falle, die Geld kostet: **1.5.0 baut nicht.** Dort fehlte
 * `HetznerCluster.spec.sshKeys`; 1.5.1 stellt es wieder her. Die Vorlage in
 * provider_templates muss 1-5-1 sein.
 */
const PLANNED_DIALECTS = {
  HETZNER_HOSTED:
    'the PaaS cluster is proven (eu1f-test01 reached Ready 5/5) but not translated here yet: ' +
    'it needs per-cluster ingress hosts, a serviceSpec with cert-manager and Cilium, and the KOF labels',
};

/**
 * Baut das ClusterDeployment.
 *
 * @param {object} req
 * @param {string} req.name            Clustername, zugleich der Name des Objekts
 * @param {string} req.providerId      hetzner | aws, nur fuer Meldungen
 * @param {string} req.dialect         HETZNER_STANDALONE | AWS_STANDALONE
 * @param {string} req.template        k0rdent-ClusterTemplate
 * @param {string} req.credential      k0rdent-Credential
 * @param {string} req.region          Standort beim Anbieter: fsn1, eu-central-1
 * @param {number} req.controlPlaneNumber
 * @param {string} req.controlPlaneType
 * @param {number} req.workersNumber
 * @param {string} req.workerType
 * @param {string} [req.k0sVersion]   k0s-Schreibweise: v1.35.4+k0s.0
 * @param {string} [req.tokenSecretName]
 * @param {string} [req.tokenSecretKey]
 * @param {string[]} [req.sshKeyNames]
 * @param {string} [req.organisationName]
 * @param {string} [req.projectName]
 * @param {boolean} [req.dryRun]       Nur pruefen lassen, nichts bauen
 */
function buildClusterDeployment(req) {
  if (!req.dialect) {
    throw new Error('Missing required field: dialect (which configuration language the template speaks)');
  }
  if (PLANNED_DIALECTS[req.dialect]) {
    throw new Error(`Dialect "${req.dialect}" is not supported yet: ${PLANNED_DIALECTS[req.dialect]}`);
  }
  const shape = DIALECTS[req.dialect];
  if (!shape) {
    throw new Error(
      `Unknown dialect "${req.dialect}". Known: ${Object.keys(DIALECTS).join(', ')}`,
    );
  }

  const sshKeyNames = req.sshKeyNames || [];
  if (shape.sshKeysRequired && sshKeyNames.length === 0) {
    throw new Error(
      `Dialect "${req.dialect}" requires at least one SSH key name; none was given. ` +
        'They belong to the project behind the credential — see provider_regions.sshKeyNames.',
    );
  }

  if (shape.tokenRefRequired && !(req.tokenSecretName && req.tokenSecretKey)) {
    throw new Error(
      `Dialect "${req.dialect}" requires tokenSecretName and tokenSecretKey; ` +
        'without them the Helm install succeeds and CAPH then reports ' +
        '"HCloudTokenAvailable: invalid or not specified hcloud token in Hetzner secret". ' +
        'See provider_regions.tokenSecretName.',
    );
  }

  // Die Vorlage baut aus der k0s-Version eine Download-URL; `1.30.4` ergibt
  // eine, die es nicht gibt, und das faellt erst auf, wenn die Maschine schon
  // laeuft und bezahlt wird.
  if (req.k0sVersion && !/^v\d+\.\d+\.\d+\+k0s\.\d+$/.test(req.k0sVersion)) {
    throw new Error(
      `"${req.k0sVersion}" is not a k0s version; expected something like v1.35.4+k0s.0`,
    );
  }

  if (req.workersNumber === undefined || req.workersNumber === null) {
    throw new Error(
      'Missing required field: workersNumber. It used to arrive as workerNodes, was never ' +
        "read, and the chart's default of 2 stood in for it — so a cluster came up with a " +
        'worker count nobody chose.',
    );
  }

  const machine = (type) => ({ [shape.machineTypeKey]: type });

  const config = {
    region: req.region,
    controlPlaneNumber: req.controlPlaneNumber,
    workersNumber: req.workersNumber,
    controlPlane: machine(req.controlPlaneType),
    worker: machine(req.workerType),
    ...shape.sshKeys(sshKeyNames),
  };

  if (shape.tokenRefRequired) {
    config.tokenRef = { name: req.tokenSecretName, key: req.tokenSecretKey };
  }

  // Nur setzen, wenn gewuenscht: ohne Angabe nimmt die Vorlage ihre eigene
  // Version, und die ist verlaesslicher als eine, die wir raten.
  if (req.k0sVersion) config.k0s = { version: req.k0sVersion };

  return {
    apiVersion: `${GROUP}/${VERSION}`,
    kind: 'ClusterDeployment',
    metadata: {
      name: req.name,
      namespace: req.namespace || DEFAULT_NAMESPACE,
      labels: {
        'enopax.io/managed': 'true',
        ...(req.organisationSlug ? { 'enopax.io/organisation': req.organisationSlug } : {}),
        ...(req.projectSlug ? { 'enopax.io/project': req.projectSlug } : {}),
      },
      // Namen duerfen hier stehen, Labels vertragen keine Leerzeichen.
      annotations: {
        ...(req.organisationName ? { 'enopax.io/organisation-name': req.organisationName } : {}),
        ...(req.projectName ? { 'enopax.io/project-name': req.projectName } : {}),
      },
    },
    spec: {
      template: req.template,
      credential: req.credential,
      ...(req.dryRun ? { dryRun: true } : {}),
      config,
    },
  };
}

/**
 * Die Bedingungen, die KCM an einem ClusterDeployment fuehrt, in der
 * Reihenfolge, in der sie wahr werden.
 *
 * Die Console zeichnet Fortschrittsstufen und verlangt laut ihrem README
 * solche, "die die API deklariert hat, statt hier geschriebener". Das sind
 * genau diese - erfunden wird nichts.
 */
const STAGE_ORDER = [
  ['CredentialReady', 'Checking credentials'],
  ['TemplateReady', 'Resolving the cluster template'],
  ['HelmChartReady', 'Fetching the chart'],
  ['HelmReleaseReady', 'Applying the release'],
  ['Ready', 'Building the cluster'],
  ['ServicesInReadyState', 'Starting the included services'],
];

/** Uebersetzt status.conditions in Stufen und einen Gesamtzustand. */
function readStatus(deployment) {
  const conditions = new Map(
    ((deployment.status && deployment.status.conditions) || []).map((c) => [c.type, c]),
  );

  const stages = STAGE_ORDER.map(([type, label]) => {
    const condition = conditions.get(type);
    return {
      key: type,
      label,
      // Ohne Bedingung ist die Stufe noch nicht erreicht, nicht gescheitert.
      state: !condition ? 'pending' : condition.status === 'True' ? 'done' : 'running',
      message: condition && condition.status !== 'True' ? condition.message : undefined,
    };
  });

  const ready = conditions.get('Ready');
  const failed = [...conditions.values()].find(
    (c) => c.status === 'False' && c.reason && /fail|error/i.test(c.reason),
  );

  return {
    ready: ready ? ready.status === 'True' : false,
    status: ready && ready.status === 'True' ? 'active' : failed ? 'failed' : 'provisioning',
    message: (ready && ready.message) || (failed && failed.message) || undefined,
    stages,
    // Anteil erreichter Stufen - die Console zeigt einen Balken, und er soll
    // aus den Stufen folgen statt daneben zu laufen.
    progress: Math.round(
      (stages.filter((s) => s.state === 'done').length / stages.length) * 100,
    ),
  };
}

module.exports = {
  GROUP,
  VERSION,
  PLURAL,
  DEFAULT_NAMESPACE,
  DIALECTS,
  PLANNED_DIALECTS,
  buildClusterDeployment,
  readStatus,
};
