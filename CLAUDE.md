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
nicht dessen, was nicht geht. Sie ist derzeit leer. Wer einen neuen Anbieter
aufnimmt, traegt ihn dort ein, bis die Uebersetzung steht.

## Die bewaehrten Manifeste sind die Quelle

Dreimal hat dieser Dienst ein ClusterDeployment erzeugt, das die
Kubernetes-API annahm und k0rdent nicht fertigbauen konnte. Jedes Mal stand
die richtige Antwort in einem Manifest unter `K0Cluster/`, das schon gelaufen
war:

| Was gebaut hat | Variante |
|---|---|
| `cluster/terraform/manifests/regions/eu1-fsn1/clusterdeployment.yaml` | PRIVATE, der laufende Regional |
| `cluster/terraform/manifests/eu1f-test01.yaml` | PAAS, Ready 5/5 |
| `k0cluster/manifests/user-cluster/cluster-standalone.yaml` | PRIVATE, Referenz |

`test/k0rdent.test.js` haelt genau diese Fassungen fest, feldgleich. Die
Chart-Vorgaben zu rekonstruieren ist der Weg, der dreimal falsch war -
nachsehen, nicht herleiten.

## Was der PaaS-Cluster ausserdem braucht

Der hosted-Dialekt unterscheidet sich nicht nur in Feldnamen:

- **`ingress.apiHost` / `konnectivityHost`**, je Cluster und Region:
  `api.<name>.<childApiDomain>`. Die Steuerungsebene laeuft auf dem regionalen
  Cluster und wird ueber dessen Ingress bedient - ohne den Namen initialisiert
  sie nie.
- **`hetznerSecretName`**, und das ist *nicht* `tokenRef`. Der hosted-Chart
  zeigt mit `HetznerCluster.spec.hetznerSecretRef` auf ein anderes Secret auf
  dem regionalen Cluster und legt dessen Schluessel selbst auf `hcloud` fest.
  Zwei Secrets, zwei Schluessel, ein Anbieter.
- **`serviceSpec`** mit cert-manager (die Vorlage bringt es nicht mit, anders
  als standalone, und KOFs otel-operator braucht die Certificate-CRDs) und
  Cilium, dessen `k8sServiceHost` derselbe apiHost sein muss.
- **die KOF-Labels**, sonst erreicht die Konfiguration des Kindes den
  regionalen Cluster nicht und `kof-operators` scheitert FailedNonRetriable.
- **`clusterNetwork.pods.cidrBlock`** im Singular, waehrend standalone
  `cidrBlocks` als Liste nimmt.

Namen und Werte der Dienste stehen in `HOSTED_SERVICES` und nicht in der
Datenbank, weil sie eine Einheit bilden: die Cilium-Werte verweisen auf den
apiHost, und ein anderer Cilium-Stand kann andere Schluessel verlangen. Ein
Versionssprung ist deshalb eine Freigabe dieses Dienstes, keine Datenpflege.

**1.5.0 baut nicht.** Dort fehlte `HetznerCluster.spec.sshKeys`; 1.5.1 stellt
es wieder her.

Und eine Falle, die Daten kostet: **niemals den `kmc-*`-Pod eines haengenden
Kindes loeschen.** Die hosted-Vorlage benutzt `persistence: emptyDir`; das
Loeschen wischt den Zustand der Steuerungsebene und macht den Cluster
unrettbar. Eine Testinstanz ist so zerstoert worden.

## Der Betrieb des regionalen Clusters

Ein PaaS-Cluster setzt auf dem regionalen Cluster Dinge voraus, die kein
Katalogwert sind und bis heute manuell eingerichtet werden
(enopax/cluster#26):

- der **`sysctl-inotify`-DaemonSet**. `fs.inotify.max_user_instances` steht
  standardmaessig auf 128 und ist ein Limit **pro UID**, geteilt von allen
  root-Containern eines Nodes. Der Regional traegt KOF, Envoy, HAProxy und je
  Kind eine Steuerungsebene. Darueber kann k0s keine Watcher anlegen und sein
  Controller-Manager startet nie - das Symptom ist ein kubelet-CSR, das
  `Pending` bleibt und auch nach Genehmigung ungezeichnet. Genau deshalb
  liefen hosted children immer auf mgmt und nie auf dem Regional.
- das `hcloud-...-resource-template` (sonst `CreateContainerConfigError` im
  CCM des Kindes), das Secret `hetzner`, der LoadBalancer
  `ep-eu1-fsn1-childapi` vor `haproxy-ingress`, `external-dns-childapi` und
  das Label `kcm-region-cluster=true` am regionalen ClusterDeployment.

## Was hier nicht entschieden wird## Was hier nicht entschieden wird

Vorlage, Credential, Standort und Maschinentypen kommen von `console-api` aus
`provider_regions` und `provider_sizes`. Wer sie hier noch einmal nachschlaegt,
baut eine zweite Kopie derselben Zuordnung, und zwei Kopien laufen auseinander.

## Nie erfinden

`metrics` liefert `cpuUsagePercent: null`, wenn nichts es misst, und sagt
`available: false`, solange es die kubeconfig des Kindclusters nicht gibt. Die
Vorgaengerfassung schrieb an beiden Stellen 0 - und ein Cluster mit 0 % CPU
liest sich wie ein leerer, nicht wie ein unbekannter.

## Gescheitert heisst endgueltig, nicht "noch nicht fertig"

`readStatus` erkennt Scheitern an `FailedNonRetriable` - der Stelle, an der
k0rdent und Sveltos aufgeben. Nicht an irgendeinem Grund, der „Failed"
enthaelt.

Hier stand einmal: irgendeine Bedingung mit `False` und einem Grund, der
`/fail|error/` trifft. Das traf `ServicesInReadyState` mit dem Grund `Failed`
und der Meldung `1/4` - einer von vier mitgelieferten Diensten ist oben,
mitten im Bau der Normalfall. Der Cluster `dev-dose` stand dadurch zwei
Minuten nach dem Anlegen als FAILED in der Datenbank, waehrend seine beiden
Server liefen.

Dass das erst jetzt auffiel, lag an einem zweiten Fehler: die Status-Abfrage
lief in einen 404, weil die Kennung einen Schraegstrich traegt und
`/v1/clusters/:id` ein Segment ist. Solange nie ein Status ankam, konnte auch
keiner falsch sein. **Ein verdeckter Fehler wird nicht kleiner.**

Die Kehrseite ist offen und bekannt: ein Cluster, der an derselben Bedingung
haengt, bleibt jetzt „im Bau". Wie lange das erlaubt ist, braucht eine
Zeitgrenze und ist eine Produktfrage - enopax/enopax#33.

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
