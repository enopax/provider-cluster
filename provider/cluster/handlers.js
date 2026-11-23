/**
 * Die sechs Operationen des Cluster-Providers, gegen die Kubernetes-API des
 * Management-Clusters.
 *
 * Sie ersetzen die Bash-Skripte daneben. Die lieferten `status: "active"`
 * unmittelbar nach einem `kubectl apply`, ohne auf irgendetwas zu warten, und
 * fest verdrahtete Nullen als Metriken; das Manifest, das sie anwendeten, war
 * ein Namespace. Hier wird wirklich ein ClusterDeployment angelegt und sein
 * Zustand gelesen.
 *
 * Form der Rueckgaben: dieselbe, die der Rahmen von einem Skript auf stdout
 * erwartet - `{ success, ... }`. So bleibt der Vertrag zu console-api
 * unveraendert.
 */

const k8s = require('@kubernetes/client-node');
const {
  GROUP,
  VERSION,
  PLURAL,
  DEFAULT_NAMESPACE,
  buildClusterDeployment,
  readStatus,
  workersOf,
  scalePatch,
} = require('./k0rdent');
const { ensureOrganisationTenant } = require('./kof-tenant');

/**
 * Der Content-Type eines Patches - und warum er hier ausdruecklich steht.
 *
 * `patchNamespacedCustomObject` darf zwei Medientypen schicken, und ohne
 * Options-Argument waehlt der generierte Client den **ersten** der Liste:
 * `application/json-patch+json`. Ein JSON Patch ist eine Liste von
 * Operationen; unser Rumpf ist ein Objekt. Der API-Server antwortet
 *
 *   400 error decoding patch: json: cannot unmarshal object into Go value
 *       of type []handlers.jsonPatchOp
 *
 * Das hat gekostet: Skalieren war in beiden Varianten wirkungslos, und zwar
 * lautlos - console-api setzte den Cluster nach dem Aufruf auf ACTIVE, und
 * die Zielzahl stand bereits in seiner Datenbank. Siehe enopax/enopax#38.
 */
const MERGE_PATCH = k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch);

/**
 * Ein Client, nicht einer pro Anfrage.
 *
 * Das ist der Grund, warum dieser Provider Handler statt Skripte benutzt: Token
 * und Zertifikat werden einmal geladen, nicht bei jedem Aufruf.
 */
let cached = null;

function client() {
  if (cached) return cached;

  const kc = new k8s.KubeConfig();
  // Im Cluster das ServiceAccount-Token, ausserhalb die uebliche kubeconfig.
  // loadFromDefault beruecksichtigt KUBECONFIG und ~/.kube/config.
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();

  cached = {
    kc,
    objects: kc.makeApiClient(k8s.CustomObjectsApi),
    core: kc.makeApiClient(k8s.CoreV1Api),
  };
  return cached;
}

/** Erlaubt den Tests, einen eigenen Client unterzuschieben. */
function setClient(stub) {
  cached = stub;
}

const namespaceOf = (id) => (id.includes('/') ? id.split('/')[0] : DEFAULT_NAMESPACE);
const nameOf = (id) => (id.includes('/') ? id.split('/').slice(1).join('/') : id);
const idOf = (deployment) => `${deployment.metadata.namespace}/${deployment.metadata.name}`;

function notFound(error) {
  const code = error && (error.code || error.statusCode || (error.response && error.response.statusCode));
  return code === 404;
}

/** Fasst ein ClusterDeployment so zusammen, wie console-api es erwartet. */
function summarise(deployment) {
  const config = (deployment.spec && deployment.spec.config) || {};
  const state = readStatus(deployment);

  return {
    id: idOf(deployment),
    name: deployment.metadata.name,
    status: state.status,
    ready: state.ready,
    message: state.message,
    stages: state.stages,
    progress: state.progress,
    // Je Dialekt, nicht fest auf `workersNumber`: der hosted-Chart fuehrt die
    // Zahl als `worker.replicas`, und ein PaaS-Cluster meldete hier deshalb
    // `undefined` - bis ein Patch sie hineinschrieb, woraufhin dieser Dienst
    // seine eigene Schreibung zurueckgelesen hat statt der Wahrheit.
    workerNodes: workersOf(config),
    controlPlaneNodes: config.controlPlaneNumber,
    region: config.region,
    k8sVersion: (config.k0s && config.k0s.version) || undefined,
    template: deployment.spec && deployment.spec.template,
    createdAt: deployment.metadata.creationTimestamp,
  };
}

async function provision(input) {
  if (!input || !input.name) {
    return { success: false, error: 'Missing required field: name' };
  }
  // k0rdent begrenzt den Namen; laenger scheitert erst im Webhook, und dann
  // steht in der Console eine Meldung, die niemand erwartet hat.
  if (input.name.length > 40) {
    return { success: false, error: `Cluster name must be 40 characters or fewer: "${input.name}"` };
  }

  let body;
  try {
    body = buildClusterDeployment(input);
  } catch (error) {
    return { success: false, error: error.message };
  }

  const { objects } = client();

  // Die mitgelieferten Dienste nachsehen, bevor etwas entsteht.
  //
  // Ein ServiceTemplate, das es nicht gibt, laesst das ClusterDeployment
  // durch - die Kubernetes-API prueft den Namen nicht - und der Cluster kaeme
  // hoch, ohne CNI und ohne cert-manager. Dafuer traegt die Rolle Leserecht
  // auf servicetemplates; es zu haben und nicht zu benutzen waere ein
  // Versprechen ohne Einlösung.
  const wanted = ((body.spec.serviceSpec || {}).services || []).map((x) => x.template);
  if (wanted.length) {
    const missing = await missingServiceTemplates(objects, body.metadata.namespace, wanted);
    if (missing.length) {
      return {
        success: false,
        error:
          `Missing or invalid ServiceTemplate(s) in ${body.metadata.namespace}: ${missing.join(', ')}. ` +
          'The cluster would come up without them — refusing instead.',
      };
    }
  }

  try {
    const created = await objects.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: body.metadata.namespace,
      plural: PLURAL,
      body,
    });

    // Der Lesezugang der Organisation, auf dem regionalen Cluster.
    //
    // Er haengt nicht am Cluster, der hier entsteht - aber hier ist der
    // Zeitpunkt, an dem wir die Region kennen und ohnehin mit ihr reden. Er
    // entsteht einmal und wird danach in Ruhe gelassen; ein zweiter
    // Clusterbau derselben Organisation aendert nichts.
    //
    // Der Bau des Clusters haengt nicht davon ab. Schlaegt es fehl, steht es
    // im Protokoll und der naechste Clusterbau holt es nach - einen
    // fertigen Cluster deswegen als gescheitert zu melden, waere die falsche
    // Reihenfolge der Sorgen.
    await ensureTenantQuietly(input, body.metadata.namespace);

    return { success: true, ...summarise(created) };
  } catch (error) {
    const code = error && (error.code || error.statusCode);
    if (code === 409) {
      return { success: false, error: `A cluster named "${input.name}" already exists`, id: `${body.metadata.namespace}/${input.name}` };
    }
    return { success: false, error: messageOf(error) };
  }
}

/**
 * Legt den Lesezugang der Organisation an, ohne den Clusterbau zu gefaehrden.
 *
 * Erreicht wird der regionale Cluster so wie in `childKubeconfig` - ueber sein
 * Kubeconfig-Secret auf dem Management-Cluster. Ohne regionalen Cluster (der
 * Private Cluster hat keinen) gibt es keinen KOF-Mandanten und nichts zu tun.
 */
async function ensureTenantQuietly(input, namespace) {
  if (!input.regionalClusterName || !input.organisationSlug) return;

  try {
    const { core } = client();
    const regionalNamespace = input.regionalClusterNamespace || namespace;
    const secret = await core.readNamespacedSecret({
      name: `${input.regionalClusterName}-kubeconfig`,
      namespace: regionalNamespace,
    });
    const raw = secret.data && secret.data.value;
    if (!raw) throw new Error(`Secret ${regionalNamespace}/${input.regionalClusterName}-kubeconfig has no "value" key`);

    const regionalKc = new k8s.KubeConfig();
    regionalKc.loadFromString(Buffer.from(raw, 'base64').toString('utf8'));

    const result = await ensureOrganisationTenant({
      core: regionalKc.makeApiClient(k8s.CoreV1Api),
      objects: regionalKc.makeApiClient(k8s.CustomObjectsApi),
      namespace: regionalNamespace,
      organisationSlug: input.organisationSlug,
    });

    if (result.created) {
      console.log(`[kof] read access for ${input.organisationSlug}: ${result.name} clamped to ${result.pattern}`);
    } else {
      console.log(`[kof] read access for ${input.organisationSlug}: ${result.reason}`);
    }
  } catch (error) {
    console.log(`[kof] read access for ${input.organisationSlug} could not be ensured: ${messageOf(error)}`);
  }
}

/**
 * Welche der verlangten ServiceTemplates fehlen oder ungueltig sind.
 *
 * Ein Fehler beim Nachsehen zaehlt nicht als "fehlt": ohne Antwort wissen wir
 * es nicht, und eine Absage auf Verdacht waere so falsch wie eine Zusage.
 */
async function missingServiceTemplates(objects, namespace, wanted) {
  let items;
  try {
    const list = await objects.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: 'servicetemplates',
    });
    items = list.items || [];
  } catch (error) {
    return [];
  }

  const valid = new Set(
    items.filter((t) => t.status && t.status.valid).map((t) => t.metadata.name),
  );
  return wanted.filter((name) => !valid.has(name));
}

async function status(input) {
  if (!input || !input.id) return { success: false, error: 'Missing required field: id' };

  const { objects } = client();
  try {
    const found = await objects.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: namespaceOf(input.id),
      plural: PLURAL,
      name: nameOf(input.id),
    });
    return { success: true, ...summarise(found) };
  } catch (error) {
    if (notFound(error)) return { success: false, error: 'Cluster not found', id: input.id };
    return { success: false, error: messageOf(error) };
  }
}

/**
 * Metriken aus dem Kindcluster.
 *
 * Cluster API legt zu jedem Cluster ein Secret `<name>-kubeconfig` an; damit
 * laesst sich der Kindcluster befragen. Solange es das nicht gibt - der Cluster
 * ist noch im Bau -, wird das gesagt und nicht mit Nullen gefuellt. Die alten
 * Skripte lieferten hier fest verdrahtete 0 und liessen die Console behaupten,
 * ein Cluster habe keine Knoten.
 */
/**
 * Die kubeconfig eines Kindclusters, wo immer sie liegt.
 *
 * Beim Private Cluster legt Cluster API sie neben das ClusterDeployment, also
 * auf den Management-Cluster. Beim PaaS-Cluster nicht: dessen CAPI-Objekte
 * werden auf dem **regionalen** Cluster versoehnt, und dort liegt auch das
 * Secret - so steht es in enopax/cluster#23.
 *
 * Die Vorgaengerfassung suchte nur auf dem Management-Cluster, fand beim
 * PaaS-Cluster nichts und meldete ehrlich `available: false`. Die Console
 * zeigte daraufhin "0 von 0" fuer einen Cluster, dessen beide Knoten liefen.
 *
 * Welcher regionale Cluster es ist, steht als Label am ClusterDeployment -
 * dasselbe, das das Kind seinem Regional zuordnet. Nachgeschlagen wird also
 * nichts, was nicht schon dort steht.
 */
async function childKubeconfig(id) {
  const namespace = namespaceOf(id);
  const name = nameOf(id);
  const { core, objects } = client();

  const read = async (api, secretName, ns) => {
    const secret = await api.readNamespacedSecret({ name: secretName, namespace: ns });
    const raw = secret.data && secret.data.value;
    if (!raw) throw new Error(`Secret ${ns}/${secretName} has no "value" key`);
    return Buffer.from(raw, 'base64').toString('utf8');
  };

  try {
    return { kubeconfig: await read(core, `${name}-kubeconfig`, namespace), via: 'management' };
  } catch (error) {
    if (!notFound(error)) throw error;
  }

  // Nicht auf dem Management-Cluster: dann ueber den regionalen.
  const deployment = await objects.getNamespacedCustomObject({
    group: GROUP, version: VERSION, namespace, plural: PLURAL, name,
  });
  const regional =
    (deployment.metadata.labels || {})['k0rdent.mirantis.com/kof-regional-cluster-name'];
  const regionalNamespace =
    (deployment.metadata.labels || {})['k0rdent.mirantis.com/kof-regional-cluster-namespace'] ||
    namespace;
  if (!regional) return { kubeconfig: null, via: null };

  const regionalKc = new k8s.KubeConfig();
  regionalKc.loadFromString(await read(core, `${regional}-kubeconfig`, regionalNamespace));
  const regionalCore = regionalKc.makeApiClient(k8s.CoreV1Api);

  try {
    return {
      kubeconfig: await read(regionalCore, `${name}-kubeconfig`, regionalNamespace),
      via: regional,
    };
  } catch (error) {
    if (notFound(error)) return { kubeconfig: null, via: regional };
    throw error;
  }
}

async function metrics(input) {
  if (!input || !input.id) return { success: false, error: 'Missing required field: id' };

  let found;
  try {
    found = await childKubeconfig(input.id);
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
  if (!found.kubeconfig) {
    return {
      success: true,
      id: input.id,
      available: false,
      reason: 'The cluster is still being built; its kubeconfig does not exist yet.',
    };
  }

  const childKc = new k8s.KubeConfig();
  childKc.loadFromString(found.kubeconfig);
  const childCore = childKc.makeApiClient(k8s.CoreV1Api);

  try {
    const [nodes, pods, claims] = await Promise.all([
      childCore.listNode(),
      childCore.listPodForAllNamespaces(),
      // Volumes gehoeren dazu: bei Hetzner stehen dahinter hcloud-Volumes,
      // deren Groesse die Rechnung mitbestimmt.
      childCore
        .listPersistentVolumeClaimForAllNamespaces()
        .catch(() => ({ items: [] })),
    ]);

    const items = nodes.items || [];
    const isReady = (n) =>
      ((n.status && n.status.conditions) || []).some(
        (c) => c.type === 'Ready' && c.status === 'True',
      );

    // Namen, nicht nur Zahlen. Die Console zeigt waehrend des Baus, welche
    // Maschine gerade dazukommt; "2 von 3" sagt das nicht.
    // Die Auslastung, wenn der Kindcluster sie messen kann.
    const usage = await nodeUsage(childKc, items);
    const podState = readPods(pods.items);
    const volumeState = readVolumes(claims.items);

    const named = items.map((n) => ({
      name: n.metadata.name,
      ready: isReady(n),
      // Was der Knoten von sich sagt - nicht abgeleitet.
      kubeletVersion: (n.status && n.status.nodeInfo && n.status.nodeInfo.kubeletVersion) || null,
      createdAt: n.metadata.creationTimestamp || null,
      // Gemessen, und `null`, wenn der metrics-server gerade nicht liefert.
      cpuPercent: (usage.nodes.get(n.metadata.name) || {}).cpuPercent ?? null,
      memPercent: (usage.nodes.get(n.metadata.name) || {}).memPercent ?? null,
    }));

    return {
      success: true,
      id: input.id,
      available: true,
      // Ueber welchen Cluster die kubeconfig gefunden wurde. Beim
      // PaaS-Cluster ist das der regionale, und das gehoert in die Antwort:
      // wer sie liest, soll nicht raten muessen, wo das Kind haengt.
      via: found.via,
      nodes: named,
      // Was nicht laeuft, mit dem Grund, den Kubernetes nennt.
      troubledPods: podState.troubled,
      volumes: volumeState.volumes,
      metrics: {
        totalNodes: items.length,
        readyNodes: named.filter((n) => n.ready).length,
        // Aufgeschluesselt, nicht gezaehlt. `pods` war die Gesamtzahl und
        // wurde von console-api als "laufend" gespeichert.
        pods: podState.running,
        podsPending: podState.pending,
        podsFailed: podState.failed,
        podsSucceeded: podState.succeeded,
        restarts: podState.restarts,
        volumeCount: volumeState.count,
        storageGi: volumeState.totalGi,
        // Gemessen, gegen `allocatable` gerechnet. `null`, wenn der
        // metrics-server im Kindcluster gerade nicht liefert - unbekannt ist
        // nicht null, und die Console hat dafuer einen Leerzustand.
        cpuUsagePercent: usage.cpuPercent,
        memoryUsagePercent: usage.memoryPercent,
      },
    };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

/**
 * Was im Kindcluster laeuft, und was nicht.
 *
 * Die Vorgaengerfassung zaehlte `pods.items.length` und console-api schrieb
 * das als `podsRunning`. Solange alle laufen, faellt das nicht auf - bei
 * `dev-dose` standen 31 Pods da, und es waren wirklich 31 laufende. Ein
 * gescheiterter waere mitgezaehlt worden.
 *
 * Interessant ist ausserdem, was **nicht** laeuft. Genau danach habe ich beim
 * ersten PaaS-Durchlauf gesucht: cert-manager-cainjector in `Error`, der
 * CSI-Controller mit zehn Neustarts, metrics-server in `CrashLoopBackOff`.
 * Alle drei fingen sich; sichtbar war es nirgends.
 */
function readPods(items) {
  const phases = { running: 0, pending: 0, failed: 0, succeeded: 0 };
  let restarts = 0;
  const troubled = [];

  for (const pod of items || []) {
    const phase = String((pod.status && pod.status.phase) || '').toLowerCase();
    if (phase in phases) phases[phase] += 1;

    const containers = (pod.status && pod.status.containerStatuses) || [];
    const podRestarts = containers.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    restarts += podRestarts;

    // Was nicht laeuft und nicht fertig ist, oder was neu startet. Ein Pod mit
    // Neustarts laeuft gerade, hat aber einen Grund gehabt.
    const settled = phase === 'running' || phase === 'succeeded';
    if (!settled || podRestarts > 0) {
      const waiting = containers.find((c) => c.state && c.state.waiting);
      const terminated = containers.find((c) => c.state && c.state.terminated);
      troubled.push({
        namespace: pod.metadata.namespace,
        name: pod.metadata.name,
        phase: (pod.status && pod.status.phase) || 'Unknown',
        restarts: podRestarts,
        // Der Grund, den Kubernetes nennt - nicht einer von hier.
        reason:
          (waiting && waiting.state.waiting.reason) ||
          (terminated && terminated.state.terminated.reason) ||
          (pod.status && pod.status.reason) ||
          null,
      });
    }
  }

  return {
    ...phases,
    restarts,
    // Die unruhigsten zuerst, und nicht alle: eine vollstaendige Liste ist bei
    // einem grossen Cluster lang und in Sekunden veraltet.
    troubled: troubled.sort((a, b) => b.restarts - a.restarts).slice(0, 20),
  };
}

/**
 * Die Volumes des Kindclusters.
 *
 * Bei Hetzner stehen hinter einem PVC hcloud-Volumes, deren Groesse die
 * Rechnung mitbestimmt. `dev-dose` hat keine - das ist kein Fehler, sondern
 * ein Cluster ohne zustandsbehaftete Last, und die Console zeigt dafuer einen
 * Leerzustand statt 0 TB.
 */
function readVolumes(items) {
  const parseGi = (value) => {
    const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/.exec(String(value || ''));
    if (!match) return 0;
    const factors = { Ki: 1 / 1024 ** 2, Mi: 1 / 1024, Gi: 1, Ti: 1024 };
    return Number(match[1]) * (factors[match[2]] ?? 1 / 1024 ** 3);
  };

  const volumes = (items || []).map((pvc) => ({
    namespace: pvc.metadata.namespace,
    name: pvc.metadata.name,
    phase: (pvc.status && pvc.status.phase) || 'Unknown',
    storageClass: pvc.spec && pvc.spec.storageClassName ? pvc.spec.storageClassName : null,
    sizeGi: parseGi(
      (pvc.status && pvc.status.capacity && pvc.status.capacity.storage) ||
        (pvc.spec && pvc.spec.resources && pvc.spec.resources.requests
          ? pvc.spec.resources.requests.storage
          : null),
    ),
  }));

  return {
    volumes,
    count: volumes.length,
    totalGi: volumes.reduce((sum, v) => sum + v.sizeGi, 0),
  };
}

/**
 * Die Auslastung der Knoten, wenn der Kindcluster sie messen kann.
 *
 * `metrics-server` ist in beiden Varianten schon da - k0s bringt ihn mit, und
 * `kubectl top nodes` liefert im Kindcluster echte Zahlen. Die
 * Vorgaengerfassung behauptete hier das Gegenteil und gab `null` zurueck,
 * mit dem Kommentar, es fehle der metrics-server. Das war nicht gemessen,
 * sondern vermutet.
 *
 * Gerechnet wird gegen `allocatable`, nicht gegen `capacity`: was das System
 * sich reserviert, kann der Kunde nicht benutzen, und ein Prozentwert gegen
 * die Rohkapazitaet sieht harmloser aus als er ist.
 *
 * `null`, wenn die Messung nicht da ist - etwa weil der metrics-server neu
 * startet. Dann ist es unbekannt, und unbekannt ist nicht null.
 */
async function nodeUsage(childKc, nodes, read) {
  let measured;
  try {
    // Die Messquelle ist einschiebbar, damit die Rechnung ohne Cluster
    // pruefbar ist - sie ist der Teil, der falsch sein kann.
    measured = read
      ? await read()
      : await new k8s.Metrics(childKc).getNodeMetrics();
  } catch (error) {
    // Kein Grund zur Sorge und kein Grund zu raten: die Messung fehlt.
    return { nodes: new Map(), cpuPercent: null, memoryPercent: null };
  }

  const quantity = (value) => {
    if (!value) return 0;
    // CPU kommt als `252m` oder `1`, Speicher als `1330Mi` oder `1234567Ki`.
    const match = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(String(value));
    if (!match) return 0;
    const amount = Number(match[1]);
    const unit = match[2];
    const factors = {
      '': 1, n: 1e-9, u: 1e-6, m: 1e-3,
      Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
      K: 1e3, M: 1e6, G: 1e9, T: 1e12,
    };
    return amount * (factors[unit] ?? 1);
  };

  const allocatable = new Map(
    (nodes || []).map((n) => [
      n.metadata.name,
      {
        cpu: quantity(n.status && n.status.allocatable && n.status.allocatable.cpu),
        memory: quantity(n.status && n.status.allocatable && n.status.allocatable.memory),
      },
    ]),
  );

  const perNode = new Map();
  let cpuUsed = 0;
  let cpuTotal = 0;
  let memUsed = 0;
  let memTotal = 0;

  for (const item of (measured && measured.items) || []) {
    const name = item.metadata.name;
    const limits = allocatable.get(name);
    if (!limits || !limits.cpu || !limits.memory) continue;

    const cpu = quantity(item.usage && item.usage.cpu);
    const memory = quantity(item.usage && item.usage.memory);

    perNode.set(name, {
      cpuPercent: Math.round((cpu / limits.cpu) * 100),
      memPercent: Math.round((memory / limits.memory) * 100),
    });

    cpuUsed += cpu;
    cpuTotal += limits.cpu;
    memUsed += memory;
    memTotal += limits.memory;
  }

  return {
    nodes: perNode,
    // Ueber den ganzen Cluster, gewichtet nach Kapazitaet - nicht der
    // Mittelwert der Prozentwerte. Zwei Knoten verschiedener Groesse ergaeben
    // sonst eine Zahl, die keiner Maschine entspricht.
    cpuPercent: cpuTotal ? Math.round((cpuUsed / cpuTotal) * 100) : null,
    memoryPercent: memTotal ? Math.round((memUsed / memTotal) * 100) : null,
  };
}

/**
 * Die kubeconfig des Kindclusters, zum Herunterladen.
 *
 * Keine der sechs CRUD-Operationen, sondern eine eigene Route - und das mit
 * Absicht: ein Cluster-Admin-Zugang darf nicht in `status` oder `metrics`
 * mitreisen. Diese Antworten werden geloggt und zwischengespeichert, und was
 * dort einmal steht, ist nicht mehr einzufangen.
 *
 * Deshalb liegt sie auch nicht im Rueckgabewert von `summarise`.
 */
async function kubeconfig(input) {
  if (!input || !input.id) return { success: false, error: 'Missing required field: id' };

  let found;
  try {
    found = await childKubeconfig(input.id);
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }

  if (!found.kubeconfig) {
    // Waehrend des Baus gibt es sie noch nicht. Eine leere Datei waere
    // schlimmer als eine Absage: sie sieht aus wie ein Zugang.
    return {
      success: false,
      error: 'The cluster is still being built; its kubeconfig does not exist yet.',
      pending: true,
    };
  }

  return { success: true, id: input.id, via: found.via, kubeconfig: found.kubeconfig };
}

/**
 * Setzt die Arbeiterzahl eines bestehenden Clusters.
 *
 * Liest das Objekt, bevor es schreibt. Der Pfad der Zahl haengt am Aufbau der
 * Konfiguration - `worker.replicas` im hosted-, `workersNumber` im
 * standalone-Dialekt -, und den kennt man erst, wenn man das Objekt gesehen
 * hat. Ein zusaetzlicher Aufruf gegen eine blinde Schreibung: der blinde
 * Schluessel wird von der API angenommen und von keinem Chart gelesen.
 */
async function update(input) {
  if (!input || !input.id) return { success: false, error: 'Missing required field: id' };
  if (input.workerNodes === undefined) {
    return { success: false, error: 'Nothing to update: expected workerNodes' };
  }

  const { objects } = client();
  const ref = {
    group: GROUP,
    version: VERSION,
    namespace: namespaceOf(input.id),
    plural: PLURAL,
    name: nameOf(input.id),
  };

  try {
    const current = await objects.getNamespacedCustomObject(ref);
    const body = scalePatch(current, Number(input.workerNodes));
    const patched = await objects.patchNamespacedCustomObject({ ...ref, body }, MERGE_PATCH);
    return { success: true, ...summarise(patched) };
  } catch (error) {
    if (notFound(error)) return { success: false, error: 'Cluster not found', id: input.id };
    return { success: false, error: messageOf(error) };
  }
}

async function deprovision(input) {
  if (!input || !input.id) return { success: false, error: 'Missing required field: id' };

  const { objects } = client();
  try {
    await objects.deleteNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: namespaceOf(input.id),
      plural: PLURAL,
      name: nameOf(input.id),
    });
    return { success: true, id: input.id, status: 'deleting' };
  } catch (error) {
    // Schon weg ist das Ergebnis, das wir wollten.
    if (notFound(error)) return { success: true, id: input.id, status: 'deleted' };
    return { success: false, error: messageOf(error) };
  }
}

async function list(input) {
  const { objects } = client();
  const selectors = ['enopax.io/managed=true'];
  if (input && input.org) selectors.push(`enopax.io/organisation=${input.org}`);
  if (input && input.project) selectors.push(`enopax.io/project=${input.project}`);

  try {
    const found = await objects.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: (input && input.namespace) || DEFAULT_NAMESPACE,
      plural: PLURAL,
      labelSelector: selectors.join(','),
    });
    return { success: true, resources: (found.items || []).map(summarise) };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

/** Die Meldung von der Kubernetes-API, nicht die Huelle darum. */
function messageOf(error) {
  if (!error) return 'Unknown error';
  const body = error.body || (error.response && error.response.body);
  if (body && typeof body === 'object' && body.message) return body.message;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed.message) return parsed.message;
    } catch {
      /* keine JSON-Antwort, dann die rohe Meldung */
    }
  }
  return error.message || String(error);
}

module.exports = {
  provision,
  status,
  metrics,
  kubeconfig,
  update,
  deprovision,
  list,
  setClient,
  summarise,
  /** Nur fuer Tests: die Rechnung ohne Cluster. */
  __nodeUsage: nodeUsage,
  __readPods: readPods,
  __readVolumes: readVolumes,
};
