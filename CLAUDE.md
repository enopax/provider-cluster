# CLAUDE.md

**AI Assistant Reference File**
Guidance for working with the Enopax Cluster Provider.

---

## Was dieser Dienst ist

Eine Fassade vor der Kubernetes-API des Management-Clusters. Er nimmt eine
Anfrage entgegen, macht daraus ein k0rdent-`ClusterDeployment` und liest
dessen Zustand zurueck. **Gebaut wird der Cluster von k0rdent**, ueber Cluster
API und Helm - nicht hier. Es gibt kein kubeadm, kein kubectl und keine
Bash-Skripte mehr; die frueheren Fassungen dieser Datei beschrieben all das,
und nichts davon trifft noch zu.

```
console-api ──▶ dieser Dienst ──▶ ClusterDeployment ──▶ k0rdent ──▶ Hetzner
```

### Aufbau

```
provider-cluster/
├── server.js                      @enopax/resource-api mit handlers statt scriptsFolder
├── Dockerfile
├── deploy/rbac.yaml               ServiceAccount, Role, Binding, Token
└── provider/cluster/
    ├── config.json
    ├── k0rdent.js                 reine Uebersetzung, ohne Cluster testbar
    └── handlers.js                alles, was mit der Kubernetes-API spricht
```

### Starten

```bash
npm install
KUBECONFIG=<kubeconfig des Management-Clusters> npm start
```

Im Cluster selbst braucht es kein KUBECONFIG - `handlers.js` nimmt dann das
Token des Pods.

---

## Handler statt Skripte

Die Operationen sind JavaScript-Funktionen in `provider/cluster/handlers.js`,
keine Bash-Skripte. Der Rahmen (`@enopax/resource-api` ≥ 1.1.0) nimmt beides;
hier sind es Funktionen, weil der Kubernetes-Client sonst bei jedem Aufruf neu
aufgebaut wuerde und zwischen zwei Aufrufen nichts bleibt.

`provider/cluster/k0rdent.js` ist die reine Uebersetzung — Anfrage hinein,
ClusterDeployment heraus — und laesst sich ohne Cluster testen. `handlers.js`
ist alles, was mit der Kubernetes-API spricht.

## Der Dialekt haengt an der Vorlage, nicht am Anbieter

`DIALECTS` in `k0rdent.js` ist nach Vorlagenfamilie geordnet, nicht nach
Anbieter. Zu Hetzner gehoeren zwei gueltige Familien, und sie sind sich in
fast keinem Feld einig:

```
HETZNER_STANDALONE   sshKeyNames[]  worker.type        workersNumber  tokenRef
HETZNER_HOSTED       sshKeyName     worker.serverType  worker.replicas
```

Die Vorgaengerfassung hielt die Felder am Anbieternamen fest und konnte damit
nur eine der beiden bauen. Welchen Dialekt eine Vorlage spricht, weiss
console-api aus `provider_templates` und schickt es mit.

`PLANNED_DIALECTS` ist die Liste dessen, was wir noch nicht *uebersetzen* -
nicht dessen, was nicht geht. HETZNER_HOSTED, der PaaS-Cluster, hat
reproduzierbar gebaut: `eu1f-test01` erreichte Ready 5/5 mit Steuerungsebene
und etcd auf regionalen Workern. Nachzulesen in
`K0Cluster/cluster/terraform/manifests/eu1f-test01.yaml` und
`K0Cluster/cluster/docs/progress_log.md`.

Was zur Uebersetzung gehoert, steht im Kommentar an `PLANNED_DIALECTS`. Zwei
Dinge daraus sind leicht zu uebersehen: die Vorlage **1.5.0 baut nicht** (dort
fehlte `HetznerCluster.spec.sshKeys`, 1.5.1 stellt es wieder her), und
`clusterNetwork.pods.cidrBlock` heisst im hosted-Dialekt Singular, waehrend
standalone `cidrBlocks` als Liste nimmt.

## Was hier nicht entschieden wird

Vorlage, Credential, Standort und Maschinentypen kommen von `console-api` aus
`provider_regions` und `provider_sizes`. Wer sie hier noch einmal nachschlaegt,
baut eine zweite Kopie derselben Zuordnung, und zwei Kopien laufen auseinander.

## Nie erfinden

`metrics` liefert `cpuUsagePercent: null`, wenn nichts es misst, und sagt
`available: false`, solange es die kubeconfig des Kindclusters nicht gibt. Die
Vorgaengerfassung schrieb an beiden Stellen 0 - und ein Cluster mit 0 % CPU
liest sich wie ein leerer, nicht wie ein unbekannter.

## Was der Dry-Run beweist - und was nicht

`dryRun: 'All'` an der Kubernetes-API laesst die Admission-Webhooks das
ClusterDeployment pruefen, ohne es zu speichern und ohne einen Server
anzulegen. Das faengt Tippfehler, falsche Vorlagennamen und unbekannte Felder.

**Es faengt nicht, was die Helm-Vorlage daraus macht.** Der erste echte
Durchlauf scheiterte genau dort: das ClusterDeployment war gueltig, und
danach lehnte CAPH den gerenderten `HetznerCluster` ab, weil `spec.sshKeys`
fehlte. Zwischen "die API nimmt es an" und "k0rdent kann es bauen" liegt ein
Schritt, den der Dry-Run nicht sieht.

Beim zweiten Lauf passierte dasselbe eine Etage weiter: der Helm-Install
gelang, und dann meldete CAPH `HCloudTokenAvailable: invalid or not specified
hcloud token in Hetzner secret`. Die Vorlage hat fuer `tokenRef` keinen
brauchbaren Vorgabewert - der Name ist leer, und den Schluessel nennt sie
`hcloud-token`, waehrend unser Secret ihn als `HCLOUD_TOKEN` fuehrt.

Was dagegen hilft: Pflichtfelder je Dialekt in `DIALECTS` fuehren und vor dem
Anlegen pruefen - `sshKeysRequired`, `tokenRefRequired`, und `workersNumber`
und die k0s-Schreibweise direkt in `buildClusterDeployment`. Jede neue
Pflichtangabe gehoert dorthin, sonst findet sie erst der Betrieb.

Und: nachsehen, nicht rekonstruieren. Die bewaehrten Manifeste unter
`K0Cluster/` - `cluster/terraform/manifests/regions/eu1-fsn1/` und
`k0cluster/manifests/user-cluster/cluster-standalone.yaml` - zeigen, welche
Felder ein Cluster wirklich braucht. Beide gescheiterten Laeufe haetten das
vorher verraten.
