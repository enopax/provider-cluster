/**
 * Der Zugang, den ein Sprung aus der Console braucht (enopax/enopax#58).
 *
 * Geprueft wird vor allem, was **nicht** passieren darf: eine Klemme, die
 * mehr durchlaesst als einen Mandanten; zwei Mandanten auf einem Namen; ein
 * Mitglied in `Main Org.`, wo die ungeklemmten Datenquellen stehen; und ein
 * Admin, der in einer Mandanten-Organisation stehenbleibt.
 */

const test = require('node:test');
const assert = require('node:assert');
const ga = require('../provider/cluster/grafana-access');

/** Ein VMUser, wie der Operator ihn legt: Lese- **und** Schreibpfade. */
const TEMPLATE = {
  // Die **echten** Label-Namen, am laufenden Regional abgelesen. Hier stand
  // einmal `kof-tenant`/`kof-cluster`, geraten - und weil Attrappe und Code
  // dieselbe Erfindung trugen, war der Test gruen, waehrend der Endpunkt in
  // Produktion keine Vorlage fand.
  metadata: {
    labels: {
      'k0rdent.mirantis.com/kof-tenant-id': 'acme_x',
      'k0rdent.mirantis.com/kof-cluster-name': 'c1',
    },
  },
  spec: {
    targetRefs: [
      {
        paths: ['/vm/select/.*'],
        static: { url: 'http://vmselect-cluster:8481' },
        query_args: [{ name: 'extra_filters', values: ['{tenant="acme_x"}'] }],
      },
      {
        paths: ['/vls/.*'],
        static: { url: 'http://vlselect:9471' },
        query_args: [{ name: 'extra_filters', values: ['"tenant":="acme_x"'] }],
      },
      {
        paths: ['/vts/.*'],
        static: { url: 'http://vtselect:10471' },
        query_args: [{ name: 'extra_filters', values: ['"resource_attr:tenant":="acme_x"'] }],
      },
      // Der Schreibpfad - erkennbar an `extra_label`, nicht `extra_filters`.
      {
        paths: ['/vm/insert/.*'],
        static: { url: 'http://vminsert:8480' },
        query_args: [{ name: 'extra_label', values: ['tenant=acme_x'] }],
      },
    ],
  },
};

test('die Adresse muss https sein und zum Regional gehoeren', () => {
  assert.strictEqual(
    ga.assertSafeGrafanaUrl('https://grafana.eu1-fsn1.kof.enopax.io'),
    'https://grafana.eu1-fsn1.kof.enopax.io',
  );
  // Ueber die Adresse reisen Admin-Zugangsdaten.
  assert.throws(() => ga.assertSafeGrafanaUrl('http://grafana.eu1-fsn1.kof.enopax.io'), /https/);
  assert.throws(() => ga.assertSafeGrafanaUrl('https://evil.example.com'), /not under/);
  assert.throws(
    () => ga.assertSafeGrafanaUrl('https://a:b@grafana.eu1-fsn1.kof.enopax.io'),
    /credentials/,
  );
  assert.throws(() => ga.assertSafeGrafanaUrl('nicht-mal-eine-url'), /not a URL/);
});

test('zwei Mandanten bekommen nie denselben Namen', () => {
  // `_` → `-` allein waere nicht eindeutig: `a_b-c` und `a-b_c` fielen
  // zusammen, und dann teilen zwei Projekte einen Lesezugang. Genau die
  // Verwechslung, die dieser Zugang verhindern soll.
  const a = ga.nameForTenant('a_b-c');
  const b = ga.nameForTenant('a-b_c');
  assert.notStrictEqual(a, b);
  // Und ein Kubernetes-Name bleibt es trotzdem.
  for (const name of [a, b, ga.nameForTenant('ACME_Prod.1')]) {
    assert.match(name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, name);
    assert.ok(name.length <= 63, name);
  }
  // Gleiche Kennung, gleicher Name - sonst entstuende bei jedem Sprung ein
  // neuer VMUser.
  assert.strictEqual(ga.nameForTenant('acme_x'), ga.nameForTenant('acme_x'));
});

test('geklemmt wird auf genau einen Mandanten', () => {
  const pattern = ga.patternForTenant('acme_x');
  assert.strictEqual(pattern, 'acme_x');
  // Kein `.*`: anders als beim Org-Zugang nimmt dieser keine Nachbarprojekte
  // mit.
  assert.ok(!pattern.includes('*'));
  // Sonderzeichen werden entschaerft, sonst waere eine Kennung ein Muster.
  assert.strictEqual(ga.patternForTenant('a.b'), 'a\\.b');
});

test('der VMUser traegt nur Lesepfade, alle geklemmt', () => {
  const user = ga.vmUserForTenant('acme_x', TEMPLATE);
  const paths = user.spec.targetRefs.map((r) => r.paths[0]);
  assert.deepStrictEqual(paths, ['/vm/select/.*', '/vls/.*', '/vts/.*']);

  for (const ref of user.spec.targetRefs) {
    assert.strictEqual(ref.query_args.length, 1);
    assert.strictEqual(ref.query_args[0].name, 'extra_filters');
    assert.ok(ref.query_args[0].values[0].includes('acme_x'));
  }
  // LogsQL und Traces vergleichen **unverankert**: ohne ^ und $ wuerde
  // `acme_x` auch in `fremd-acme_x` treffen.
  const logs = user.spec.targetRefs[1].query_args[0].values[0];
  const traces = user.spec.targetRefs[2].query_args[0].values[0];
  assert.match(logs, /\^acme_x\$/);
  assert.match(traces, /\^acme_x\$/);

  // Die genaue Kennung steht als Annotation - ein Label darf sie nicht
  // tragen, weil Unterstriche dort nicht erlaubt sind.
  assert.strictEqual(user.metadata.annotations['enopax.io/kof-tenant-id'], 'acme_x');
});

test('ohne Lesepfade in der Vorlage wird nichts gebaut', () => {
  // Lieber kein Zugang als einer ohne Klemme.
  const writeOnly = { spec: { targetRefs: [TEMPLATE.spec.targetRefs[3]] } };
  assert.throws(() => ga.vmUserForTenant('acme_x', writeOnly), /unclamped/);
});

test('die Datenquellen lesen alle ueber vmauth', () => {
  const ds = ga.datasourcesFor({ username: 'u', password: 'p' });
  assert.deepStrictEqual(ds.map((d) => d.name), ['metrics', 'logs', 'traces']);
  for (const d of ds) {
    // Direkt auf vmselect gibt es nichts, was klemmt.
    assert.match(d.url, /vmauth/);
    assert.strictEqual(d.basicAuth, true);
    assert.strictEqual(d.basicAuthUser, 'u');
    assert.strictEqual(d.secureJsonData.basicAuthPassword, 'p');
    assert.strictEqual(d.access, 'proxy');
  }
});

/* ------------------------------------------------------------------ Ablauf */

/**
 * Die Vorlagen in `Main Org.`, in der Form der echten - am 2026-11-27 am
 * laufenden Regional abgelesen. Entscheidend ist `${datasource}`: die Seiten
 * waehlen ihre Datenquelle ueber eine **Variable** nach Typ, nicht ueber eine
 * uid. Stuende dort eine uid, zeigte jede Kopie auf die ungeklemmte Quelle in
 * `Main Org.` - und das waere ein Leck.
 */
const SOURCES = [
  {
    uid: 'k8s_views_pods', title: 'Kubernetes / Views / Pods',
    folderTitle: 'Cluster Monitoring', folderUid: 'afurpjhddp6v4c',
    dashboard: {
      uid: 'k8s_views_pods', title: 'Kubernetes / Views / Pods', id: 77, version: 4,
      panels: [{ datasource: { type: 'prometheus', uid: '${datasource}' } }],
    },
  },
  {
    uid: 'rYdddlPWk', title: 'Node Exporter Full',
    folderTitle: 'Cluster Monitoring', folderUid: 'afurpjhddp6v4c',
    dashboard: { uid: 'rYdddlPWk', title: 'Node Exporter Full', id: 78, version: 2, panels: [] },
  },
  {
    uid: 'kubernetes-event-exporter', title: 'All Kubernetes Events',
    folderTitle: 'Kubernetes Events', folderUid: 'afurpl96ut43ke',
    dashboard: { uid: 'kubernetes-event-exporter', title: 'All Kubernetes Events', id: 79, version: 1, panels: [] },
  },
  {
    // Aus einem Ordner, der unsere Plattform beschreibt - darf **nicht**
    // mitkopiert werden. Leere Felder beim Kunden, und der Titel allein
    // verraet den Aufbau.
    uid: 'victoria-metrics-cluster', title: 'VictoriaMetrics - cluster',
    folderTitle: 'Victoria Metrics', folderUid: 'vmfolder',
    dashboard: { uid: 'victoria-metrics-cluster', title: 'VictoriaMetrics - cluster', id: 80, version: 1, panels: [] },
  },
  {
    // Der Log-Browser - liegt im **selben** ausgeschlossenen Ordner wie die
    // Zeile darueber und muss trotzdem mit. Deshalb gibt es die uid-Liste
    // neben der Ordnerliste: nach Ordner allein ist zu grob.
    uid: 'aeckkt1pio0sgc', title: 'VictoriaLogs Dashboard',
    folderTitle: 'Victoria Logs', folderUid: 'vlfolder',
    dashboard: { uid: 'aeckkt1pio0sgc', title: 'VictoriaLogs Dashboard', id: 81, version: 1, panels: [] },
  },
];

/** Ein Grafana aus Papier: merkt sich jeden Aufruf und antwortet knapp. */
function fakeGrafana(state = {}) {
  const calls = [];
  const orgs = state.orgs || new Map();
  const users = state.users || new Map();
  const members = state.members || new Map();
  const datasources = state.datasources || new Map();
  const orgNames = state.orgNames || new Map([[1, 'Main Org.']]);
  const deletedOrgs = [];
  // Die Attrappe liest das Ziel aus `X-Grafana-Org-Id`, so wie das echte
  // Grafana. Ohne Kopfzeile gilt `Main Org.` - und genau daran haengt, ob eine
  // Kopie am richtigen Ort landet.
  //
  // Die Organisation des **Admins** wird hier nirgends geaendert: dass niemand
  // sie aendert, ist die Eigenschaft, um die es geht.
  const adminOrg = 1;
  const foldersByOrg = new Map();
  const dashboardsByOrg = new Map([[1, new Map((state.sources || SOURCES).map((d) => [d.uid, d]))]]);
  let nextId = 10;

  const fetchImpl = async (url, init) => {
    const path = url.replace(/^https:\/\/[^/]+/, '');
    const headers = init.headers || {};
    const currentOrg = Number(headers['X-Grafana-Org-Id'] || adminOrg);
    calls.push(`${init.method} ${path}${headers['X-Grafana-Org-Id'] ? ` @${currentOrg}` : ''}`);
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (payload, status = 200) => ({
      ok: true,
      status,
      text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
    });
    const notFound = { ok: false, status: 404, text: async () => '' };

    let m;
    if ((m = path.match(/^\/api\/orgs\/name\/(.+)$/))) {
      const id = orgs.get(decodeURIComponent(m[1]));
      return id ? ok({ id }) : notFound;
    }
    if (path === '/api/orgs' && init.method === 'POST') {
      const id = nextId++;
      orgs.set(body.name, id);
      orgNames.set(id, body.name);
      return ok({ orgId: id });
    }
    if ((m = path.match(/^\/api\/datasources\/name\/(.+)$/))) {
      const ds = datasources.get(m[1]);
      return ds ? ok(ds) : notFound;
    }
    if (path === '/api/datasources' && init.method === 'POST') {
      datasources.set(body.name, { ...body, id: nextId++ });
      return ok({ id: 1 });
    }
    if (path.startsWith('/api/datasources/') && init.method === 'PUT') {
      datasources.set(body.name, body);
      return ok({ id: body.id });
    }
    if ((m = path.match(/^\/api\/users\/lookup\?loginOrEmail=(.+)$/))) {
      const u = users.get(decodeURIComponent(m[1]));
      return u ? ok(u) : notFound;
    }
    if (path === '/api/admin/users') {
      const u = { id: nextId++, email: body.email };
      users.set(body.email, u);
      // Wie das echte Grafana bei `auto_assign_org: false`: eine
      // **persoenliche** Organisation, benannt nach der Anmeldung, und der
      // neue Nutzer ist dort **Admin**. Genau das war das Leck.
      const personal = nextId++;
      orgs.set(body.email, personal);
      orgNames.set(personal, body.email);
      members.set(personal, [{ userId: u.id, role: 'Admin' }]);
      return ok({ id: u.id });
    }
    if ((m = path.match(/^\/api\/orgs\/(\d+)\/users$/)) && init.method === 'GET') {
      return ok(members.get(Number(m[1])) || []);
    }
    if ((m = path.match(/^\/api\/users\/(\d+)\/orgs$/))) {
      const uid = Number(m[1]);
      const out = [];
      for (const [org, list] of members) {
        const found = (list || []).find((x) => x.userId === uid);
        if (found) out.push({ orgId: org, name: orgNames.get(org) || `org-${org}`, role: found.role });
      }
      return ok(out);
    }
    if ((m = path.match(/^\/api\/orgs\/(\d+)$/)) && init.method === 'DELETE') {
      const org = Number(m[1]);
      members.delete(org);
      deletedOrgs.push(org);
      return ok(undefined);
    }
    if ((m = path.match(/^\/api\/orgs\/(\d+)\/users$/)) && init.method === 'POST') {
      const org = Number(m[1]);
      const u = users.get(body.loginOrEmail);
      members.set(org, [...(members.get(org) || []), { userId: u.id, role: body.role }]);
      return ok(undefined);
    }
    if ((m = path.match(/^\/api\/orgs\/(\d+)\/users\/(\d+)$/)) && init.method === 'PATCH') {
      const org = Number(m[1]);
      members.set(
        org,
        (members.get(org) || []).map((x) => (x.userId === Number(m[2]) ? { ...x, role: body.role } : x)),
      );
      return ok(undefined);
    }
    if ((m = path.match(/^\/api\/orgs\/(\d+)\/users\/(\d+)$/)) && init.method === 'DELETE') {
      const org = Number(m[1]);
      const list = members.get(org) || [];
      const leaving = list.find((x) => x.userId === Number(m[2]));
      // Wie das echte Grafana: den letzten Admin laesst es nicht gehen.
      if (leaving && leaving.role === 'Admin' && list.filter((x) => x.role === 'Admin').length === 1) {
        return { ok: false, status: 400, text: async () => '{"message":"Cannot remove last organization admin"}' };
      }
      members.set(org, list.filter((x) => x.userId !== Number(m[2])));
      return ok(undefined);
    }
    if (path.match(/^\/api\/user\/using\/\d+$/)) {
      // Das darf nicht mehr vorkommen - es aenderte die Organisation des
      // Admins, und der grafana-operator benutzt denselben Nutzer.
      throw new Error(`fakeGrafana: niemand darf die Organisation des Admins aendern (${path})`);
    }
    if (path.match(/^\/api\/users\/\d+\/using\/\d+$/)) {
      // Die Vorgabe-Organisation des **Mandantennutzers** - die ist gewollt.
      return ok(undefined);
    }
    if (path.startsWith('/api/search')) {
      const here = dashboardsByOrg.get(currentOrg) || new Map();
      return ok([...here.values()].map((d) => ({
        uid: d.uid, title: d.title, folderTitle: d.folderTitle, folderUid: d.folderUid,
      })));
    }
    if ((m = path.match(/^\/api\/dashboards\/uid\/(.+)$/))) {
      const here = dashboardsByOrg.get(currentOrg) || new Map();
      const d = here.get(decodeURIComponent(m[1]));
      return d ? ok({ dashboard: d.dashboard, meta: { folderUid: d.folderUid } }) : notFound;
    }
    if (path === '/api/folders' && init.method === 'POST') {
      const here = foldersByOrg.get(currentOrg) || new Map();
      if (here.has(body.uid)) {
        return { ok: false, status: 409, text: async () => '{"message":"folder exists"}' };
      }
      here.set(body.uid, body.title);
      foldersByOrg.set(currentOrg, here);
      return ok({ uid: body.uid, title: body.title });
    }
    if (path === '/api/dashboards/db' && init.method === 'POST') {
      const here = dashboardsByOrg.get(currentOrg) || new Map();
      const d = body.dashboard;
      if (d.id !== null) {
        // Wie das echte Grafana: eine Id aus einer anderen Organisation zeigt
        // dort auf etwas anderes oder nichts.
        return { ok: false, status: 400, text: async () => '{"message":"dashboard id is not valid here"}' };
      }
      here.set(d.uid, {
        uid: d.uid, title: d.title, folderTitle: null, folderUid: body.folderUid, dashboard: d,
      });
      dashboardsByOrg.set(currentOrg, here);
      return ok({ uid: d.uid, status: 'success' });
    }
    throw new Error(`fakeGrafana: unhandled ${init.method} ${path}`);
  };

  return {
    fetchImpl, calls, orgs, users, members, datasources, orgNames, deletedOrgs,
    foldersByOrg, dashboardsByOrg, orgNow: () => currentOrg,
  };
}

/** Der regionale Cluster aus Papier. */
function fakeRegional({ vmUserExists = false } = {}) {
  const created = [];
  const secrets = new Map([
    [
      'grafana-admin-credentials',
      { data: { GF_SECURITY_ADMIN_USER: Buffer.from('admin').toString('base64'),
                GF_SECURITY_ADMIN_PASSWORD: Buffer.from('geheim').toString('base64') } },
    ],
  ]);
  const name = ga.nameForTenant('acme_telemetry');
  if (vmUserExists) {
    secrets.set(`${name}-creds`, { data: { password: Buffer.from('vmpass').toString('base64') } });
  }

  const notFound = Object.assign(new Error('not found'), { code: 404 });
  const seenNamespaces = [];
  const core = {
    readNamespacedSecret: async ({ name: n, namespace: ns }) => {
      seenNamespaces.push(`secret:${n}@${ns}`);
      if (!secrets.has(n)) throw notFound;
      return secrets.get(n);
    },
    createNamespacedSecret: async ({ body }) => {
      created.push(`secret/${body.metadata.name}`);
      secrets.set(body.metadata.name, {
        data: { password: Buffer.from(body.stringData.password).toString('base64') },
      });
    },
  };
  const objects = {
    getNamespacedCustomObject: async ({ namespace: ns }) => {
      seenNamespaces.push(`get:${ns}`);
      if (!vmUserExists) throw notFound;
      return { metadata: { name } };
    },
    listNamespacedCustomObject: async ({ namespace: ns }) => {
      seenNamespaces.push(`list:${ns}`);
      return { items: [TEMPLATE] };
    },
    createNamespacedCustomObject: async ({ body }) => {
      created.push(`vmuser/${body.metadata.name}`);
    },
  };
  return { core, objects, created, secrets, seenNamespaces };
}

const BASE = {
  grafanaUrl: 'https://grafana.eu1-fsn1.kof.enopax.io',
  tenantId: 'acme_telemetry',
  email: 'ada@enopax.io',
  name: 'Ada Lovelace',
};

test('stellt alles her und legt die Person als Viewer in ihre Organisation', async () => {
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  assert.strictEqual(result.tenantId, 'acme_telemetry');
  assert.ok(result.orgId > 0);
  assert.strictEqual(result.created.vmUser, true);
  assert.strictEqual(result.created.org, true);
  assert.strictEqual(result.created.user, true);

  // Der Lesezugang entsteht im Regional, mitsamt Kennwort.
  assert.deepStrictEqual(regional.created, [
    `secret/${ga.nameForTenant('acme_telemetry')}-creds`,
    `vmuser/${ga.nameForTenant('acme_telemetry')}`,
  ]);

  // Viewer, und nur dort.
  const orgId = result.orgId;
  assert.deepStrictEqual(
    grafana.members.get(orgId).map((m) => m.role),
    ['Viewer'],
  );
  assert.deepStrictEqual(grafana.members.get(ga.MAIN_ORG_ID) || [], []);

  // Die Datenquellen entstehen **in** der Mandanten-Organisation: der Admin
  // wechselt vorher hin und danach zurueck. Ohne den Wechsel landen die
  // geklemmten Datenquellen in Main Org.
  // **Die Organisation des Admins wird nie geaendert.** Das ist der Kern: der
  // grafana-operator benutzt denselben Nutzer, und solange der Admin in einer
  // Mandanten-Organisation parkte, schrieb der Operator dorthin. Die Attrappe
  // wirft, wenn es doch jemand versucht.
  assert.deepStrictEqual(
    grafana.calls.filter((c) => c.startsWith('POST /api/user/using/')),
    [],
  );
  // Stattdessen traegt jede schreibende Anfrage ihr Ziel selbst.
  assert.ok(
    grafana.calls.includes(`POST /api/datasources @${orgId}`),
    grafana.calls.join('\n'),
  );
  // Und die Vorlagen werden ausdruecklich in Main Org. gelesen.
  assert.ok(grafana.calls.some((c) => c.startsWith(`GET /api/search`) && c.endsWith(`@${ga.MAIN_ORG_ID}`)));
});

test('entfernt die Person aus Main Org., wo die ungeklemmten Quellen stehen', async () => {
  const regional = fakeRegional();
  const users = new Map([['ada@enopax.io', { id: 7, email: 'ada@enopax.io' }]]);
  const members = new Map([[ga.MAIN_ORG_ID, [{ userId: 7, role: 'Editor' }]]]);
  const grafana = fakeGrafana({ users, members });

  await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  assert.deepStrictEqual(grafana.members.get(ga.MAIN_ORG_ID), []);
  assert.ok(grafana.calls.includes(`DELETE /api/orgs/${ga.MAIN_ORG_ID}/users/7`));
});

test('setzt einen Editor auf Viewer herab', async () => {
  // Ein Editor kann die Datenquelle bearbeiten und damit die Klemme abnehmen.
  const regional = fakeRegional();
  const users = new Map([['ada@enopax.io', { id: 7, email: 'ada@enopax.io' }]]);
  const orgs = new Map([['acme_telemetry', 5]]);
  const members = new Map([[5, [{ userId: 7, role: 'Editor' }]]]);
  const grafana = fakeGrafana({ users, orgs, members });

  await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  assert.deepStrictEqual(grafana.members.get(5), [{ userId: 7, role: 'Viewer' }]);
});

test('berichtigt eine Datenquelle, die auf einen anderen Lesezugang zeigt', async () => {
  // Der Fall, der sich sonst nicht heilt: ein neuer VMUser, waehrend die
  // Datenquelle noch den alten Namen traegt - Grafana zeigt dann nichts an,
  // ohne zu sagen, warum.
  const regional = fakeRegional({ vmUserExists: true });
  const datasources = new Map([
    ['metrics', { id: 3, name: 'metrics', basicAuthUser: 'alt', url: 'http://woanders' }],
  ]);
  const grafana = fakeGrafana({ datasources });

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  assert.deepStrictEqual(
    result.created.datasources.find((d) => d.name === 'metrics'),
    { name: 'metrics', action: 'corrected' },
  );
  assert.strictEqual(grafana.datasources.get('metrics').basicAuthUser, ga.nameForTenant('acme_telemetry'));
  // Berichtigt, nicht neu angelegt: ein DELETE+POST aenderte die Kennung der
  // Datenquelle und damit jedes Dashboard, das sie nennt.
  assert.ok(!grafana.calls.some((c) => c.startsWith('DELETE /api/datasources')));
});

test('zweimal hintereinander schreibt beim zweiten Mal nichts', async () => {
  const regional = fakeRegional({ vmUserExists: true });
  const grafana = fakeGrafana();

  const first = await ga.ensureDashboardAccess({
    regionalCore: regional.core, regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl, ...BASE,
  });
  const second = await ga.ensureDashboardAccess({
    regionalCore: regional.core, regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl, ...BASE,
  });

  assert.strictEqual(first.orgId, second.orgId);
  assert.deepStrictEqual(second.created, {
    vmUser: false, org: false, user: false, datasources: [], dashboards: [],
  });
});

test('hat keinen Admin-Kontext, der nach einem Fehler zurueckzustellen waere', async () => {
  // Hier stand ein Test ueber den Rueckwechsel im `finally`. Er ist
  // gegenstandslos geworden, und das ist der Fortschritt: es gibt keinen
  // Zustand mehr, der schiefstehen koennte. Jede Anfrage traegt ihr Ziel als
  // `X-Grafana-Org-Id`, der Admin bleibt, wo er ist - auch wenn mitten im
  // Ablauf etwas scheitert.
  const regional = fakeRegional({ vmUserExists: true });
  const grafana = fakeGrafana();
  const broken = async (url, init) => {
    if (url.includes('/api/datasources') && init.method === 'POST') {
      return { ok: false, status: 500, text: async () => 'kaputt' };
    }
    return grafana.fetchImpl(url, init);
  };

  await assert.rejects(
    ga.ensureDashboardAccess({
      regionalCore: regional.core, regionalObjects: regional.objects,
      fetchImpl: broken, ...BASE,
    }),
    /returned 500/,
  );
  assert.deepStrictEqual(
    grafana.calls.filter((c) => c.startsWith('POST /api/user/using/')),
    [],
    'niemand darf die Organisation des Admins anfassen, auch nicht im Fehlerfall',
  );
});

test('fehlende Pflichtfelder sagen, welches', async () => {
  const regional = fakeRegional();
  for (const missing of ['tenantId', 'email']) {
    const input = { ...BASE, [missing]: undefined };
    await assert.rejects(
      ga.ensureDashboardAccess({
        regionalCore: regional.core, regionalObjects: regional.objects,
        fetchImpl: async () => { throw new Error('darf nicht aufgerufen werden'); },
        ...input,
      }),
      new RegExp(missing),
    );
  }
});

test('sucht die VMUser in kcm-system und das Grafana-Secret in kof', async () => {
  // Der Fehler, der nur am laufenden Regional auffiel: beides in `kof`
  // gesucht, geraten aus dem Beispielmanifest. Der Endpunkt lief bis in den
  // Cluster und scheiterte mit "No operator-made VMUser to copy the read
  // paths from" - in `kof` liegt nur das Handmanifest, die des Operators
  // liegen in `kcm-system`.
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  const vmuser = regional.seenNamespaces.filter((x) => x.startsWith('get:') || x.startsWith('list:'));
  assert.ok(vmuser.length > 0, 'es muss nach VMUser gesehen worden sein');
  for (const call of vmuser) {
    assert.match(call, /:kcm-system$/, `VMUser-Zugriff im falschen Namensraum: ${call}`);
  }
  assert.ok(
    regional.seenNamespaces.includes('secret:grafana-admin-credentials@kof'),
    `Grafana-Secret nicht aus kof gelesen: ${regional.seenNamespaces.join(', ')}`,
  );
  // Und die Vorgaben stehen, damit ein Aufrufer sie nicht setzen muss.
  assert.strictEqual(ga.VMUSER_NAMESPACE, 'kcm-system');
  assert.strictEqual(ga.GRAFANA_NAMESPACE, 'kof');
});

test('erkennt eine Operator-Vorlage an denselben Labels wie kof-tenant.js', async () => {
  // Nicht an eigenen: zwei Erfindungen derselben Sache gehen auseinander, und
  // genau das ist passiert.
  const { TENANT_LABEL, CLUSTER_LABEL } = require('../provider/cluster/kof-tenant');
  assert.strictEqual(TENANT_LABEL, 'k0rdent.mirantis.com/kof-tenant-id');
  assert.strictEqual(CLUSTER_LABEL, 'k0rdent.mirantis.com/kof-cluster-name');
  assert.ok(TEMPLATE.metadata.labels[TENANT_LABEL], 'die Attrappe traegt das echte Label');
  assert.ok(TEMPLATE.metadata.labels[CLUSTER_LABEL], 'die Attrappe traegt das echte Label');
});

test('laesst die Person in **genau einer** Organisation stehen', async () => {
  // Der Fund vom 2026-11-27 am laufenden Regional: Grafana legt bei
  // `auto_assign_org: false` eine persoenliche Organisation an, benannt nach
  // der E-Mail, und macht den Nutzer dort **Admin**. Ein Admin bearbeitet
  // Datenquellen - er haette sich dort `http://vmselect-cluster:8481` direkt
  // eintragen koennen, ohne Zugangsdaten, serverseitig geholt, und damit die
  // Telemetrie **aller** Mandanten gelesen.
  //
  // Die ganze Trennung beruht darauf, dass ein Mensch Viewer ist. Jede
  // Mitgliedschaft daneben hebt sie auf.
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  // Direkt am Zustand: in welchen Organisationen steht ueberhaupt jemand?
  const mitgliedschaften = [...grafana.members.entries()]
    .filter(([, list]) => (list || []).length)
    .map(([org, list]) => [org, list.map((m) => m.role)]);
  assert.deepStrictEqual(mitgliedschaften, [[result.orgId, ['Viewer']]]);

  // Und die persoenliche Organisation ist weg, nicht nur verlassen - Grafana
  // laesst den letzten Admin nicht gehen.
  assert.strictEqual(grafana.deletedOrgs.length, 1, 'die persoenliche Organisation muss geloescht sein');
  assert.ok(result.created.user);
  // Was aufgeloest wurde, steht im Ergebnis - der Aufrufer soll es
  // protokollieren koennen, hier wird jemandem ein Zugang genommen.
  assert.deepStrictEqual(result.elsewhere.map((e) => e.action), ['org deleted']);
});

test('entfernt auch eine Mitgliedschaft in Main Org.', async () => {
  const regional = fakeRegional();
  const users = new Map([['ada@enopax.io', { id: 7, email: 'ada@enopax.io' }]]);
  const members = new Map([[ga.MAIN_ORG_ID, [{ userId: 7, role: 'Viewer' }]]]);
  const grafana = fakeGrafana({ users, members });

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  assert.deepStrictEqual(grafana.members.get(ga.MAIN_ORG_ID), []);
  assert.deepStrictEqual(
    result.elsewhere,
    [{ orgId: ga.MAIN_ORG_ID, action: 'removed' }],
  );
  // Main Org. wird **nie** geloescht, nur verlassen.
  assert.deepStrictEqual(grafana.deletedOrgs, []);
});

test('meldet eine fremde Mitgliedschaft, die nicht aufzuloesen ist', async () => {
  // Nicht stillschweigend hinnehmen: wer sonst wo Admin ist, bleibt es, und
  // dann gilt die Zusage "Viewer und nichts darueber" nicht mehr. Lieber ein
  // Fehler als ein Sprung, der mehr erlaubt als gedacht.
  const regional = fakeRegional();
  const users = new Map([['ada@enopax.io', { id: 7, email: 'ada@enopax.io' }]]);
  const orgNames = new Map([[1, 'Main Org.'], [9, 'fremdes-projekt']]);
  const members = new Map([[9, [{ userId: 7, role: 'Admin' }]]]);
  const grafana = fakeGrafana({ users, members, orgNames });

  await assert.rejects(
    ga.ensureDashboardAccess({
      regionalCore: regional.core,
      regionalObjects: regional.objects,
      fetchImpl: grafana.fetchImpl,
      ...BASE,
    }),
    /last organization admin/,
  );
  assert.deepStrictEqual(grafana.deletedOrgs, [], 'eine fremde Organisation wird nicht geloescht');
});

/* --------------------------------------------- Dashboards je Mandant (#58) */

test('kopiert die kuratierten Seiten in die Organisation des Mandanten', async () => {
  // Grafana teilt Dashboards nicht ueber Organisationen; eine
  // Mandanten-Organisation entsteht leer, und `Main Org.` ist gesperrt, weil
  // dort die ungeklemmten Datenquellen stehen.
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  const erwartet = ['aeckkt1pio0sgc', 'k8s_views_pods', 'kubernetes-event-exporter', 'rYdddlPWk'];
  const kopiert = result.created.dashboards.map((d) => d.uid).sort();
  assert.deepStrictEqual(kopiert, erwartet);

  // Und sie liegen **in** der Organisation des Mandanten, nicht in Main Org.
  const beimMandanten = [...(grafana.dashboardsByOrg.get(result.orgId) || new Map()).keys()].sort();
  assert.deepStrictEqual(beimMandanten, erwartet);
});

test('kopiert nichts, was unsere Plattform beschreibt', async () => {
  // `VictoriaMetrics - cluster` liegt im Ordner `Victoria Metrics`. Beim
  // Kunden blieben seine Felder leer - die Klemme filtert die Reihen weg -,
  // und der Titel allein verraet, woraus der Stapel gebaut ist.
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  const beimMandanten = [...(grafana.dashboardsByOrg.get(result.orgId) || new Map()).keys()];
  assert.ok(!beimMandanten.includes('victoria-metrics-cluster'), beimMandanten.join(', '));
  // In Main Org. bleibt sie unberuehrt stehen.
  assert.ok([...grafana.dashboardsByOrg.get(1).keys()].includes('victoria-metrics-cluster'));
});

test('die Kopie waehlt ihre Datenquelle ueber die Variable, nicht ueber eine uid', async () => {
  // Daran haengt die ganze Uebung: eine feste uid zeigte auf die
  // **ungeklemmte** Quelle in Main Org., und der Mandant laese alles.
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core,
    regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl,
    ...BASE,
  });

  const kopie = grafana.dashboardsByOrg.get(result.orgId).get('k8s_views_pods').dashboard;
  assert.deepStrictEqual(kopie.panels[0].datasource, { type: 'prometheus', uid: '${datasource}' });
  // Die Id der Vorlage darf nicht mitreisen - sie gilt je Organisation.
  assert.strictEqual(kopie.id, null);
  assert.strictEqual(kopie.uid, 'k8s_views_pods', 'die uid bleibt, sonst ist "schon da" nicht feststellbar');
});

test('legt beim zweiten Sprung keine Kopie nach', async () => {
  const regional = fakeRegional({ vmUserExists: true });
  const grafana = fakeGrafana();

  await ga.ensureDashboardAccess({
    regionalCore: regional.core, regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl, ...BASE,
  });
  const zaehle = () => grafana.calls.filter((c) => c.startsWith('POST /api/dashboards/db')).length;
  const vorher = zaehle();
  const zweiter = await ga.ensureDashboardAccess({
    regionalCore: regional.core, regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl, ...BASE,
  });

  assert.strictEqual(vorher, 4);
  assert.deepStrictEqual(zweiter.created.dashboards, []);
  assert.strictEqual(zaehle(), 4, 'beim zweiten Mal darf nichts geschrieben werden');
});

test('legt den Ordner in der Organisation des Mandanten an', async () => {
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core, regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl, ...BASE,
  });

  const ordner = [...(grafana.foldersByOrg.get(result.orgId) || new Map()).values()].sort();
  // `Victoria Logs` steht dabei, weil der Log-Browser daraus stammt. Der
  // Kunde sieht damit einen Ordnernamen aus unserem Stapel - das ist bekannt
  // und der Preis dafuer, dass die Kopie die Ablage der Vorlage uebernimmt.
  // Umzubenennen waere eine zweite Wahrheit ueber denselben Ordner.
  assert.deepStrictEqual(ordner, ['Cluster Monitoring', 'Kubernetes Events', 'Victoria Logs']);
  // Derselbe Ordner-uid wie in der Vorlage, damit die Ablage ueberall gleich
  // aussieht.
  assert.ok([...(grafana.foldersByOrg.get(result.orgId)).keys()].includes('afurpjhddp6v4c'));
});

test('ein vorhandener Ordner ist kein Fehler', async () => {
  // Grafana antwortet 409. Dann steht er, und das ist das Ziel.
  const regional = fakeRegional();
  const grafana = fakeGrafana();
  const once = { done: false };
  const fetchImpl = async (url, init) => {
    if (url.includes('/api/folders') && init.method === 'POST' && !once.done) {
      once.done = true;
      return { ok: false, status: 409, text: async () => '{"message":"folder title exists"}' };
    }
    return grafana.fetchImpl(url, init);
  };

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core, regionalObjects: regional.objects,
    fetchImpl, ...BASE,
  });
  assert.strictEqual(result.created.dashboards.length, 4);
});

test('nimmt den Log-Browser mit, obwohl sein Ordner ausgeschlossen ist', async () => {
  // Ohne ihn gab es **keinen** Weg zu den Logs: von den kuratierten Seiten
  // benutzte genau eine Logs, und die zeigt Kubernetes-Ereignisse. `Explore`
  // ist fuer einen Viewer zu - Grafana wirft `/explore` auf die Startseite.
  const regional = fakeRegional();
  const grafana = fakeGrafana();

  const result = await ga.ensureDashboardAccess({
    regionalCore: regional.core, regionalObjects: regional.objects,
    fetchImpl: grafana.fetchImpl, ...BASE,
  });

  const beimMandanten = [...grafana.dashboardsByOrg.get(result.orgId).keys()];
  assert.ok(beimMandanten.includes('aeckkt1pio0sgc'), beimMandanten.join(', '));
  // Und die Nachbarseite aus demselben Ordner bleibt draussen - der Ordner
  // ist weiter ausgeschlossen, nur diese eine uid ist benannt.
  assert.ok(!beimMandanten.includes('victoria-metrics-cluster'));
  assert.ok(ga.TENANT_DASHBOARD_UIDS.includes('aeckkt1pio0sgc'));
});
