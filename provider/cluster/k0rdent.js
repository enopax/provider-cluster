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
 * Die Netze, die beide Dialekte benutzen. Sie stehen so in jeder belegten
 * Fassung; was der Kunde waehlt, ist sie nicht.
 */
const PODS_CIDR = '10.244.0.0/16';
const SERVICES_CIDR = '10.96.0.0/12';

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
  /**
   * Der PaaS-Cluster: die Steuerungsebene laeuft als Pods auf dem regionalen
   * Cluster, der Kunde zahlt nur Worker.
   *
   * Nachgebaut aus `K0Cluster/cluster/terraform/manifests/eu1f-test01.yaml` -
   * der Fassung, die Ready 5/5 erreicht hat. Jede Abweichung davon ist eine
   * Vermutung, und zwei dieser Vermutungen haben diesen Dienst schon zweimal
   * zum Scheitern gebracht.
   */
  HETZNER_HOSTED: {
    sshKeysRequired: true,
    // Nicht `tokenRef`. Der hosted-Chart verweist mit
    // `HetznerCluster.spec.hetznerSecretRef` auf ein *anderes* Secret auf dem
    // regionalen Cluster, dessen Schluessel er selbst auf `hcloud` festlegt -
    // waehrend standalone `tokenRef` mit `HCLOUD_TOKEN` nimmt. Zwei Secrets,
    // zwei Schluessel, ein Anbieter.
    tokenRefRequired: false,
    hostedSecretRequired: true,
    // Ohne erreichbare API initialisiert die Steuerungsebene nie: sie laeuft
    // auf dem regionalen Cluster und wird von aussen ueber dessen Ingress
    // bedient.
    ingressRequired: true,
    build: buildHostedConfig,
  },

  AWS_STANDALONE: {
    machineTypeKey: 'instanceType',
    sshKeysRequired: false,
    // AWS nimmt genau einen; mehrere waeren ein stiller Datenverlust.
    sshKeys: (names) => (names.length ? { sshKeyName: names[0] } : {}),
    tokenRefRequired: false,
  },
};

/** `api.<name>.<domain>` und `k.<name>.<domain>`, wie in der belegten Fassung. */
function ingressHosts(name, childApiDomain) {
  return {
    apiHost: `api.${name}.${childApiDomain}`,
    konnectivityHost: `k.${name}.${childApiDomain}`,
  };
}

/**
 * Der Konfigurationsteil des PaaS-Clusters.
 *
 * Eigene Funktion, weil er sich vom standalone-Dialekt nicht in einzelnen
 * Feldnamen unterscheidet, sondern im Aufbau: kein `controlPlaneNumber` (die
 * Steuerungsebene ist kein Server), `worker.replicas` statt `workersNumber`,
 * `cidrBlock` im Singular statt `cidrBlocks` als Liste.
 */
function buildHostedConfig(req) {
  const { apiHost, konnectivityHost } = ingressHosts(req.name, req.childApiDomain);
  const machine = (type, replicas) => ({
    serverType: type,
    imageName: req.nodeImage || 'ubuntu-24.04',
    replicas,
  });

  return {
    clusterName: req.name,
    region: req.region,
    // Singular. Der hosted-Chart nimmt genau einen Namen, standalone eine Liste.
    sshKeyName: req.sshKeyNames[0],
    hetznerSecretName: req.hostedSecretName,
    clusterNetwork: {
      pods: { cidrBlock: PODS_CIDR },
      services: { cidrBlock: SERVICES_CIDR },
    },
    // `core` ist der statische Knotenpool, `worker` der skalierbare. Die
    // belegte Fassung liess `core` auf der Chart-Vorgabe stehen - hier steht
    // er ausdruecklich, damit der Maschinentyp unserer ist und die Knotenzahl
    // bekannt.
    //
    // Hier stand: "Ein PaaS-Cluster hat damit `workersNumber + 1` Knoten."
    // Das ist falsch, und der Irrtum hat enopax/enopax#35 verursacht. Der
    // ganze core-Pool des Charts steht hinter `{{ if .Values.autoscaling.enabled }}` -
    // MachineDeployment, MachineTemplate und WorkerConfigTemplate. Ohne
    // Autoskalierung entsteht er nicht, und `core.replicas` rendert nichts.
    // Belegt an `dev-dose`: `core.replicas: 1` im Objekt, zwei Server bei
    // Hetzner, keiner davon ein core. Wer Autoskalierung einschaltet, zaehlt
    // ihn mit - bis dahin ist die Knotenzahl genau `workersNumber`.
    core: machine(req.workerType, 1),
    worker: machine(req.workerType, req.workersNumber),
    ingress: { enabled: true, apiHost, konnectivityHost },
  };
}

/**
 * Die Dienste, die ein PaaS-Cluster mitbekommt.
 *
 * Genau einer: **cert-manager**. Die hosted-Vorlage bringt es nicht mit -
 * anders als standalone -, und KOFs otel-operator braucht die
 * Certificate-CRDs.
 *
 * **Cilium stand hier und ist weg.** Das CNI kommt vom Chart, ueber die
 * k0s-Extensions in `templates/k0smotroncontrolplane.yaml` - zusammen mit
 * hcloud-ccm und hcloud-csi, die wir hier nie mitgeliefert haben. Beides
 * gleichzeitig hat sich gegenseitig ueberschrieben, und zwar nachweislich am
 * laufenden `dev-dose`:
 *
 *   helm -n kube-system history cilium   (im Kindcluster)
 *   1  13:39:11  superseded  cilium-1.19.4  Install complete   <- Chart, k0s-Extension
 *   2  13:48:56  deployed    cilium-1.18.1  Upgrade complete   <- dieser Dienst, Sveltos
 *
 * Also eine **Rueckdatierung des CNI** auf einem Cluster, der schon lief,
 * neun Minuten nach seiner Geburt, mit anderem Tunnelprotokoll (geneve statt
 * vxlan). Dass es gut ging, war Glueck.
 *
 * Der Kommentar hier sagte "Cilium, weil der Cluster sonst kein CNI hat".
 * Das war nicht geprueft, sondern angenommen - die Vorlage installiert es
 * selbst. Wer hier einen Dienst eintraegt, sieht vorher im Chart nach, ob er
 * schon von dort kommt.
 *
 * Namen und Werte stehen hier und nicht in der Datenbank, weil sie eine
 * Einheit bilden: ein anderer cert-manager-Stand kann andere Schluessel
 * verlangen. Ein Versionssprung ist deshalb eine Freigabe dieses Dienstes,
 * keine Datenpflege.
 */
const HOSTED_SERVICES = {
  certManager: 'cert-manager-v1-19-3',
};

/**
 * Die Dienste, die der PaaS-Cluster mitbekommt - und wie Helm sie ausbringt.
 *
 * `helmOptions.atomic: true` steht hier **ausdruecklich**, seit k0rdent 1.13
 * es nicht mehr von sich aus setzt. Bis 1.12 war es hart verdrahtet; wer
 * nichts angibt, bekommt ab 1.13 ein nicht-atomares Install.
 *
 * Geschrieben, um das Verhalten zu **behalten**, nicht um es zu waehlen: ein
 * abgebrochener Install laesst sonst eine halb installierte Release stehen,
 * und bei cert-manager heisst das CRDs ohne Controller. Dass ein
 * Upstream-Standard sich aendert, darf unser Verhalten nicht lautlos
 * mitaendern - und wenn wir es aendern wollen, dann als eigene Entscheidung
 * mit eigenem Beleg. Siehe enopax/enopax#50.
 *
 * Die Kehrseite ist bekannt und gewollt: ein Rollback verwischt die Spur des
 * Fehlschlags. Sichtbar bleibt er trotzdem - eine gescheiterte Release steht
 * in `troubledReleases` (enopax/enopax#40), und nach einem Rollback steht
 * dort gar keine, was ebenso auffaellt.
 */
function buildHostedServiceSpec() {
  return {
    services: [
      {
        template: HOSTED_SERVICES.certManager,
        name: 'cert-manager',
        namespace: 'cert-manager',
        values: 'crds:\n  enabled: true\n',
        helmOptions: { atomic: true },
      },
    ],
  };
}

/**
 * Dialekte, die wir kennen und noch nicht erzeugen.
 *
 * Derzeit keiner. HETZNER_HOSTED stand hier, solange die Uebersetzung fehlte;
 * gebaut hatte er da laengst - `eu1f-test01` erreichte Ready 5/5. Wer einen
 * neuen Anbieter aufnimmt, traegt ihn hier ein, bis die Uebersetzung steht:
 * eine Absage mit Grund ist besser als ein Objekt, das k0rdent nicht
 * fertigbauen kann.
 */
const PLANNED_DIALECTS = {};

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
/**
 * Die k0s-Schreibweise, an einer Stelle.
 *
 * `v1.35.4+k0s.0`: ein `v`, die Kubernetes-Version, und dahinter die Nummer
 * des k0s-Builds dazu. Die Vorlage baut daraus eine Download-URL
 * (`.../releases/download/<version>/k0s-<version>-amd64`) - `1.30.4` ergibt
 * eine, die es nicht gibt, und das faellt erst auf, wenn die Maschine schon
 * laeuft und bezahlt wird.
 */
const K0S_VERSION = /^v\d+\.\d+\.\d+\+k0s\.\d+$/;

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

  if (shape.hostedSecretRequired && !req.hostedSecretName) {
    throw new Error(
      `Dialect "${req.dialect}" requires hostedSecretName — the secret on the regional ` +
        'cluster that HetznerCluster.spec.hetznerSecretRef points at. It is not the same ' +
        'secret as tokenSecretName, and the chart fixes its key to "hcloud". ' +
        'See provider_regions.hostedSecretName.',
    );
  }

  if (shape.ingressRequired && !req.childApiDomain) {
    throw new Error(
      `Dialect "${req.dialect}" requires childApiDomain — the control plane runs on the ` +
        'regional cluster and is reached through its ingress, so without api.<name>.<domain> ' +
        'it never initialises. See provider_regions.childApiDomain.',
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
  if (req.k0sVersion && !K0S_VERSION.test(req.k0sVersion)) {
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

  // Dialekte mit eigenem Aufbau bauen selbst; die uebrigen teilen die
  // standalone-Form, die sich nur in zwei Feldnamen unterscheidet.
  let config;
  if (shape.build) {
    config = shape.build({ ...req, sshKeyNames });
  } else {
    const machine = (type) => ({ [shape.machineTypeKey]: type });
    config = {
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
        ...kofLabels(req, shape),
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
      ...(shape.build === buildHostedConfig ? { serviceSpec: buildHostedServiceSpec() } : {}),
    },
  };
}

/**
 * Die Labels, mit denen KOF ein Kind seinem regionalen Cluster und seinem
 * Mandanten zuordnet.
 *
 * Nur fuer Dialekte mit Ingress, also fuer den PaaS-Cluster: beim standalone
 * traegt der Cluster seinen KOF-Teil selbst. Der Mandant ist die Organisation
 * - daran haengt die Trennung der Messwerte in Grafana, und zwei
 * Organisationen unter einer Mandanten-Kennung saehen einander zu.
 */
function kofLabels(req, shape) {
  if (!shape.ingressRequired) return {};
  if (!req.regionalClusterName) return {};
  return {
    'k0rdent.mirantis.com/kof-cluster-role': 'child',
    'k0rdent.mirantis.com/kof-regional-cluster-name': req.regionalClusterName,
    'k0rdent.mirantis.com/kof-regional-cluster-namespace':
      req.regionalClusterNamespace || DEFAULT_NAMESPACE,
    // Je Projekt, von console-api gebildet. Stand hier einmal
    // `organisationSlug`, und das war eine Entscheidung mit
    // Sicherheitsfolge, die mir nicht zusteht: der kof-operator legt je
    // Cluster einen VMUser an, klemmt ihn serverseitig auf diese Kennung, und
    // legt dessen Zugangsdaten **in den Kindcluster** - die Kollektoren
    // schreiben damit. Da die kubeconfig des Kindes an den Kunden geht, liest
    // jeder mit Clusterzugang genau das, worauf die Kennung klemmt.
    //
    // Mit der Organisation als Kennung laese ein projektgebundenes Mitglied
    // die Telemetrie aller Projekte seiner Organisation. Siehe
    // enopax/enopax#39.
    ...(req.tenantId ? { 'k0rdent.mirantis.com/kof-tenant-id': req.tenantId } : {}),
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

  // Gescheitert heisst "endgueltig", nicht "noch nicht fertig".
  //
  // Hier stand einmal: irgendeine Bedingung mit `False` und einem Grund, der
  // /fail|error/ enthaelt. Das traf `ServicesInReadyState` mit dem Grund
  // `Failed` und der Meldung `1/4` - einer von vier mitgelieferten Diensten
  // ist oben, mitten im Bau der Normalfall. Der Cluster `dev-dose` stand
  // dadurch nach zwei Minuten als FAILED in der Datenbank, waehrend seine
  // beiden Server liefen und k0rdent `Progressing` meldete.
  //
  // Endgueltig ist bei k0rdent und Sveltos `FailedNonRetriable`: dort wird
  // nicht weiter versucht. Alles andere laeuft noch, und wie lange das
  // dauern darf, ist eine Produktfrage - siehe enopax/enopax#33.
  const terminal = [...conditions.values()].find(
    (c) =>
      c.status === 'False' &&
      /nonretriable/i.test(`${c.reason || ''} ${c.message || ''}`),
  );

  return {
    ready: ready ? ready.status === 'True' : false,
    status: ready && ready.status === 'True' ? 'active' : terminal ? 'failed' : 'provisioning',
    message: (ready && ready.message) || (terminal && terminal.message) || undefined,
    stages,
    // Anteil erreichter Stufen - die Console zeigt einen Balken, und er soll
    // aus den Stufen folgen statt daneben zu laufen.
    progress: Math.round(
      (stages.filter((s) => s.state === 'done').length / stages.length) * 100,
    ),
  };
}

/**
 * Wo die Arbeiterzahl eines Clusters steht.
 *
 * Nicht an einer Stelle, sondern an zwei - und welche es ist, haengt an der
 * Vorlage: der standalone-Chart nimmt `workersNumber`, der hosted-Chart
 * `worker.replicas`. `buildHostedConfig` und `buildPrivateConfig` wissen das
 * beim Anlegen; beim Aendern wusste es niemand, und deshalb schrieb `update`
 * jahrelang `workersNumber` auch in PaaS-Cluster, wo kein Chart es liest.
 *
 * Festgemacht am **Aufbau des Objekts**, nicht am Anbieternamen oder am
 * Vorlagentext: wer eine Vorlage austauscht, aendert damit den Feldnamen mit,
 * und der Name der Vorlage sagt nichts darueber, wie ihre Werte heissen.
 */
function workersOf(config) {
  const c = config || {};
  if (c.worker && c.worker.replicas !== undefined) return c.worker.replicas;
  return c.workersNumber;
}

/**
 * Das Merge-Patch, das die Arbeiterzahl eines bestehenden Clusters setzt.
 *
 * Braucht das Objekt, nicht nur seine Kennung: der Pfad ist erst bekannt,
 * wenn man gesehen hat, wie seine Konfiguration aufgebaut ist.
 *
 * Kennt es den Aufbau nicht, wird **nichts** geschrieben. Ein Patch auf einen
 * erfundenen Pfad scheitert nicht - `values.schema.json` der Charts setzt kein
 * `additionalProperties: false`, die Kubernetes-API nimmt den Schluessel an,
 * und niemand liest ihn. Ein Fehler mit Grund ist besser als ein Erfolg, der
 * keine Maschine erreicht.
 */
function scalePatch(deployment, workers) {
  const config = (deployment && deployment.spec && deployment.spec.config) || {};

  if (config.worker) return { spec: { config: { worker: { replicas: workers } } } };
  if (config.workersNumber !== undefined) return { spec: { config: { workersNumber: workers } } };

  throw new Error(
    'Cannot scale this cluster: its config has neither worker.replicas nor workersNumber ' +
      `(template "${(deployment && deployment.spec && deployment.spec.template) || 'unknown'}")`,
  );
}

/**
 * Der Patch, der die k0s-Version eines bestehenden Clusters setzt - also das
 * Kubernetes-Upgrade.
 *
 * Bei k0rdent ist ein Upgrade kein eigenes Verb: man setzt
 * `spec.config.k0s.version`, und Cluster API tauscht daraufhin die Knoten.
 * Beide Hetzner-Dialekte tragen dieses Feld, der hosted auch im Schema
 * (`pattern: ^v\\d+\\.\\d+\\.\\d+\\+k0s\\.\\d+$`).
 *
 * Zwei Pruefungen, und keine davon ist Formalie:
 *
 * **Die Schreibweise.** Siehe `K0S_VERSION` - eine Version, die als Release
 * nicht existiert, ergibt eine Download-URL, die 404 liefert, und das sieht
 * man erst an einem Knoten, der nie beitritt.
 *
 * **Das Feld muss schon da sein.** Steht in der Konfiguration kein
 * `k0s.version`, ist es eine Vorlage, die wir nicht kennen. Ein Patch auf
 * einen Schluessel, den kein Chart liest, wird von der API angenommen und
 * wirkt nicht - genau der Fehler aus enopax/enopax#38, wo die Arbeiterzahl in
 * ein Feld geschrieben wurde, das der hosted-Chart nicht liest. Lieber eine
 * Absage als ein stiller Fehlschlag.
 */
function versionPatch(deployment, k0sVersion) {
  if (!K0S_VERSION.test(k0sVersion)) {
    throw new Error(
      `"${k0sVersion}" is not a k0s version; expected something like v1.35.4+k0s.0`,
    );
  }

  const config = (deployment && deployment.spec && deployment.spec.config) || {};
  if (!config.k0s || config.k0s.version === undefined) {
    throw new Error(
      'Cannot upgrade this cluster: its config carries no k0s.version ' +
        `(template "${(deployment && deployment.spec && deployment.spec.template) || 'unknown'}")`,
    );
  }

  return { spec: { config: { k0s: { version: k0sVersion } } } };
}

/**
 * Fasst mehrere Patches zu einem zusammen, eine Ebene tief unter
 * `spec.config`.
 *
 * Ein Aufruf statt zwei: zwei Schreibungen hintereinander koennen zur Haelfte
 * gelingen, und dann hat der Cluster die neue Version und die alte
 * Knotenzahl, ohne dass jemand es anhand der Antwort merkt.
 */
function mergeConfigPatches(patches) {
  const config = {};
  for (const patch of patches) Object.assign(config, patch.spec.config);
  return { spec: { config } };
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
  workersOf,
  scalePatch,
  versionPatch,
  mergeConfigPatches,
  K0S_VERSION,
};
