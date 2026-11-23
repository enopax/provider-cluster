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
const { GROUP, VERSION, PLURAL, DEFAULT_NAMESPACE, buildClusterDeployment, readStatus } =
  require('./k0rdent');

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
    workerNodes: config.workersNumber,
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
async function metrics(input) {
  if (!input || !input.id) return { success: false, error: 'Missing required field: id' };

  const namespace = namespaceOf(input.id);
  const name = nameOf(input.id);
  const { core } = client();

  let kubeconfig;
  try {
    const secret = await core.readNamespacedSecret({ name: `${name}-kubeconfig`, namespace });
    const raw = secret.data && secret.data.value;
    if (!raw) throw new Error('kubeconfig secret has no "value" key');
    kubeconfig = Buffer.from(raw, 'base64').toString('utf8');
  } catch (error) {
    if (notFound(error)) {
      return {
        success: true,
        id: input.id,
        available: false,
        reason: 'The cluster is still being built; its kubeconfig does not exist yet.',
      };
    }
    return { success: false, error: messageOf(error) };
  }

  const childKc = new k8s.KubeConfig();
  childKc.loadFromString(kubeconfig);
  const childCore = childKc.makeApiClient(k8s.CoreV1Api);

  try {
    const [nodes, pods] = await Promise.all([
      childCore.listNode(),
      childCore.listPodForAllNamespaces(),
    ]);

    const items = nodes.items || [];
    const ready = items.filter((n) =>
      ((n.status && n.status.conditions) || []).some(
        (c) => c.type === 'Ready' && c.status === 'True',
      ),
    ).length;

    return {
      success: true,
      id: input.id,
      available: true,
      metrics: {
        totalNodes: items.length,
        readyNodes: ready,
        pods: (pods.items || []).length,
        // Auslastung braucht metrics-server im Kindcluster. Ohne ihn wird sie
        // nicht geraten, sondern weggelassen - die Console hat dafuer einen
        // eigenen Leerzustand.
        cpuUsagePercent: null,
        memoryUsagePercent: null,
      },
    };
  } catch (error) {
    return { success: false, error: messageOf(error) };
  }
}

async function update(input) {
  if (!input || !input.id) return { success: false, error: 'Missing required field: id' };
  if (input.workerNodes === undefined) {
    return { success: false, error: 'Nothing to update: expected workerNodes' };
  }

  const { objects } = client();
  try {
    const patched = await objects.patchNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: namespaceOf(input.id),
      plural: PLURAL,
      name: nameOf(input.id),
      body: { spec: { config: { workersNumber: Number(input.workerNodes) } } },
    });
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

module.exports = { provision, status, metrics, update, deprovision, list, setClient, summarise };
