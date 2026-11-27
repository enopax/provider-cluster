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

/** Ein Grafana aus Papier: merkt sich jeden Aufruf und antwortet knapp. */
function fakeGrafana(state = {}) {
  const calls = [];
  const orgs = state.orgs || new Map();
  const users = state.users || new Map();
  const members = state.members || new Map();
  const datasources = state.datasources || new Map();
  const orgNames = state.orgNames || new Map([[1, 'Main Org.']]);
  const deletedOrgs = [];
  let nextId = 10;

  const fetchImpl = async (url, init) => {
    const path = url.replace(/^https:\/\/[^/]+/, '');
    calls.push(`${init.method} ${path}`);
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
    if (path.startsWith('/api/user/using/') || path.match(/^\/api\/users\/\d+\/using\/\d+$/)) {
      return ok(undefined);
    }
    throw new Error(`fakeGrafana: unhandled ${init.method} ${path}`);
  };

  return { fetchImpl, calls, orgs, users, members, datasources, orgNames, deletedOrgs };
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
  const switches = grafana.calls.filter((c) => c.startsWith('POST /api/user/using/'));
  assert.deepStrictEqual(switches, [
    `POST /api/user/using/${orgId}`,
    `POST /api/user/using/${ga.MAIN_ORG_ID}`,
  ]);
  const firstDs = grafana.calls.findIndex((c) => c === 'POST /api/datasources');
  assert.ok(grafana.calls.indexOf(`POST /api/user/using/${orgId}`) < firstDs);
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
    vmUser: false, org: false, user: false, datasources: [],
  });
});

test('stellt den Admin-Kontext auch dann zurueck, wenn es scheitert', async () => {
  // Ein Admin, der in einer Mandanten-Organisation stehenbleibt, legt beim
  // naechsten Aufruf fuer einen **anderen** Mandanten dort an.
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
  assert.strictEqual(
    grafana.calls.at(-1),
    `POST /api/user/using/${ga.MAIN_ORG_ID}`,
    'der letzte Aufruf muss der Rueckwechsel sein',
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
