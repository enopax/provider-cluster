# CLAUDE.md

**AI Assistant Reference File**
Guidance for working with the Enopax Cluster Provider.

---

## Mehrere Sitzungen arbeiten hier gleichzeitig

Am 2026-11-23 liefen zwei. Inhaltlich ging das gut - verschiedene Themen,
Rebase ohne einen Konflikt. Kollidiert sind **nur die Versionsnummern**, und
daraus wurde fast ein ueberschriebenes Image.

Drei Regeln, jede fuer einen Fehler, der wirklich passiert ist:

**Holen, bevor man baut.** `git fetch` als erster Schritt. Wer die
Versionsnummer gegen das lokale `package.json` waehlt statt gegen `origin`,
waehlt eine, die schon vergeben ist.

**Niemals einen vorhandenen Image-Tag ueberschreiben.** Vor jedem Push:

```bash
docker manifest inspect ghcr.io/enopax/provider-cluster:<version> && echo "VERGEBEN"
```

Ein vorhandener Tag ist das veroeffentlichte Artefakt von jemandem. Git lehnt
einen Push ab, der etwas verlieren wuerde - **die Registry nicht**, sie nimmt
ihn stillschweigend an. Am 2026-11-23 lag ein `0.3.4` aus einer Sitzung schon
in der Registry, und in der anderen lag ein gleichnamiges Image aus einem
Stand *vor* dem Rebase. Dass es nicht hochgeladen wurde, lag an einem
abgelaufenen Registry-Token, nicht an Sorgfalt.

**Nach einem Rebase die Versionsnummer neu waehlen.** Die alte gehoert zu dem
Stand, aus dem sie kam.

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
- **`serviceSpec`** mit cert-manager, und nur damit: die Vorlage bringt es
  nicht mit, anders als standalone, und KOFs otel-operator braucht die
  Certificate-CRDs.
- **die KOF-Labels**, sonst erreicht die Konfiguration des Kindes den
  regionalen Cluster nicht und `kof-operators` scheitert FailedNonRetriable.
- **`clusterNetwork.pods.cidrBlock`** im Singular, waehrend standalone
  `cidrBlocks` als Liste nimmt.

Namen und Werte der Dienste stehen in `HOSTED_SERVICES` und nicht in der
Datenbank, weil sie eine Einheit bilden: ein anderer cert-manager-Stand kann
andere Schluessel verlangen. Ein Versionssprung ist deshalb eine Freigabe
dieses Dienstes, keine Datenpflege.

## Das CNI kommt vom Chart, nicht von hier

`HOSTED_SERVICES` lieferte einmal auch **Cilium** mit, mit dem Kommentar
„weil der Cluster sonst kein CNI hat". Das war nicht geprueft, sondern
angenommen: die hosted-Vorlage installiert Cilium selbst, ueber die
k0s-Extensions in `templates/k0smotroncontrolplane.yaml` - zusammen mit
hcloud-ccm und hcloud-csi, die wir hier nie mitgeliefert haben.

Beide Wege gleichzeitig haben sich ueberschrieben, belegt im Kindcluster von
`dev-dose`:

```
helm -n kube-system history cilium
1  13:39:11  superseded  cilium-1.19.4  Install complete   <- Chart, k0s-Extension
2  13:48:56  deployed    cilium-1.18.1  Upgrade complete   <- dieser Dienst, Sveltos
```

Eine Rueckdatierung des CNI auf einem Cluster, der schon lief, neun Minuten
nach seiner Geburt, mit anderem Tunnelprotokoll (geneve statt vxlan). Dass es
gut ging, war Glueck.

**Die Regel daraus:** was das Chart mitbringt, bringen wir nicht noch einmal
mit. Wer einen Dienst in `HOSTED_SERVICES` eintraegt, sieht vorher in
`templates/k0smotroncontrolplane.yaml` nach, ob er schon von dort kommt - und
in `helm list` im Kindcluster, ob er schon laeuft.

Fuer bestehende Cluster ist das kein stiller Wechsel: nimmt man den Dienst aus
dem `serviceSpec` eines laufenden Clusters, **deinstalliert Sveltos ihn** -
beim CNI heisst das, dem Cluster das Netz zu nehmen, bis k0s seine Extension
nachzieht. Ein bestehender Cluster wird deshalb neu gebaut und nicht
umgestellt.

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

## Die Mandantenkennung entscheidet dieser Dienst nicht

`kof-tenant-id` kommt als `tenantId` von console-api. Hier stand einmal der
Organisations-Slug, und das war kein Namensfehler, sondern eine
Sicherheitsentscheidung an der falschen Stelle:

Der `kof-operator` legt je Cluster einen VMUser an, klemmt ihn serverseitig
auf diese Kennung und legt dessen Zugangsdaten **in den Kindcluster** - die
Kollektoren schreiben damit. Weil die kubeconfig des Kindclusters an den
Kunden geht, liest jeder mit Clusterzugang genau das, worauf die Kennung
klemmt.

Mit der Organisation als Kennung laese ein projektgebundenes Mitglied die
Telemetrie aller Projekte seiner Organisation. enopax/enopax#39.

Fehlt die Kennung, wird **kein** Label gesetzt - lieber keine Abgrenzung als
eine falsche. Ohne Label legt der Operator keinen VMUser an; die Telemetrie
liegt dann im gemeinsamen Mandanten und ist nicht abgegrenzt, aber sie ist
auch nicht falsch abgegrenzt.

## Ein Upgrade ist ein Feld, kein Verb

`update` nimmt `workerNodes`, `k0sVersion` oder beides. Das Upgrade ist
`spec.config.k0s.version` - so tut k0rdent es, Cluster API tauscht danach die
Knoten. Ein eigenes `upgrade` hier waere eine Erfindung ueber einer
Zuweisung.

Beide Angaben gehen in **einen** Patch (`mergeConfigPatches`). Zwei
Schreibungen hintereinander koennen zur Haelfte gelingen, und dann traegt der
Cluster die neue Version und die alte Knotenzahl, ohne dass die Antwort es
verraet.

Zwei Absagen statt eines stillen Fehlschlags:

- **Die Schreibweise** (`K0S_VERSION`, eine Konstante fuer beide Stellen).
  Eine Version, die es als Release nicht gibt, ergibt eine Download-URL mit
  404 - sichtbar erst an einem Knoten, der nie beitritt, und die Maschine
  laeuft und kostet.
- **Das Feld muss schon da sein.** Traegt die Konfiguration kein
  `k0s.version`, ist es eine Vorlage, die wir nicht kennen. Ein Patch auf
  einen Schluessel, den kein Chart liest, wird von der API angenommen und
  wirkt nicht - genau #38, eine Etage daneben.

**Welche Versionen angeboten werden, entscheidet dieser Dienst nicht.** Der
Katalog in `console-api` fuehrt sie, mitsamt der Frage, welcher Sprung erlaubt
ist. Hier steht nur, was sich schreiben laesst.

## Was hier nicht entschieden wird

Vorlage, Credential, Standort und Maschinentypen kommen von `console-api` aus
`provider_regions` und `provider_sizes`. Wer sie hier noch einmal nachschlaegt,
baut eine zweite Kopie derselben Zuordnung, und zwei Kopien laufen auseinander.

## Gemessen, nicht geraten - und nicht ungemessen behauptet

`nodeUsage` liest `metrics.k8s.io` im Kindcluster. Zwei Rechenregeln, die
keine Geschmacksfrage sind:

- **gegen `allocatable`, nicht `capacity`** - was das System sich reserviert,
  kann der Kunde nicht benutzen, und ein Prozentwert gegen die Rohkapazitaet
  sieht harmloser aus als er ist
- **ueber den Cluster nach Kapazitaet gewichtet**, nicht als Mittelwert der
  Prozentwerte. Zwei Knoten verschiedener Groesse ergaeben sonst eine Zahl,
  die keiner Maschine entspricht: 2,1 von 6 Kernen sind 35 %, der Mittelwert
  waere 27,5

Hier stand vorher `cpuUsagePercent: null` mit dem Kommentar, es fehle der
`metrics-server` im Kindcluster. **Das war nicht gemessen, sondern vermutet** -
k0s bringt ihn in beiden Varianten mit, und `kubectl top nodes` liefert dort
echte Zahlen. Ich habe das Ticket dazu mit derselben falschen Annahme
geschrieben, weil ich den Kommentar fuer einen Befund hielt.

Ein Kommentar, der eine Luecke behauptet, gehoert mit einem Beleg versehen
oder nachgeprueft, bevor er weitergetragen wird.

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

## KOF-Mandanten: die Klemmung sitzt im VMUser, nicht in der Abfrage

Die Telemetrie wird nicht ueber VictoriaMetrics-Mandanten getrennt - der
Endpunkt bleibt `/vm/select/0/...` fuer alle. Getrennt wird ueber ein Label
`tenant` an der Zeitreihe plus eine serverseitige Einschraenkung in `vmauth`.

Drei Dinge daran sind nicht offensichtlich, alle am laufenden Cluster
gemessen:

**Der Kollektor setzt das Label nicht - `vmauth` stempelt es beim Schreiben.**
Im Kindcluster steht nur `external_labels: {cluster: dev-dose}`. Die Kennung
kommt aus dem `extra_label` am Insert-Pfad des Cluster-VMUsers. Wer im
Kollektor nachsieht und kein `tenant` findet, zieht den falschen Schluss.

**Ein Zugang ohne Filter bekommt trotzdem nur seinen Mandanten.** Die
Einschraenkung steht im `VMUser`, also kann ein Client sie nicht weglassen.
Gemessen: dieselbe Abfrage `up` gibt dem einen Zugang 41 Zeitreihen und dem
eines anderen Mandanten 0.

**PromQL verankert, LogsQL nicht.** `{tenant=~"enopax(_.*)?"}` trifft nur
vollstaendig - `nopax(_.*)?` gibt 0. LogsQL und Traces benutzen `:~`, und das
ist ein unverankerter Teilstring-Abgleich: `"tenant":~"nopax"` liefert Zeilen.
Deshalb tragen die Klemmungen fuer Logs und Traces ausdrueckliche `^` und `$`.
Ohne sie reichte der Zugang von `enopax` in die Logs von `fremd-enopax`.

`kof-tenant.js` legt den Lesezugang je Organisation an - lesend, nie
schreibend, und die Zieladressen abgeschrieben aus einem vom Operator
erzeugten VMUser statt hier hingeschrieben. Siehe enopax/enopax#39.


## Das Bild muss `linux/amd64` sein

Der App-Host ist x86_64, der Entwicklungsrechner arm64. `docker build` nimmt
die eigene Architektur, die Registry nimmt das Bild an, `docker compose pull`
holt es - und dann:

```
exec /usr/local/bin/docker-entrypoint.sh: exec format error
Restarting (255)
```

Nichts davor warnt. Also:

```bash
docker buildx build --platform linux/amd64 -t ghcr.io/enopax/provider-cluster:<version> --push .
```

Nachsehen laesst es sich nur ausdruecklich - `docker manifest inspect` ohne
`-v` zeigt die Architektur nicht:

```bash
docker manifest inspect -v ghcr.io/enopax/provider-cluster:<version> | grep -i architecture
```

Das ist am 2026-11-24 bei `0.3.6` passiert. Gekostet hat es einen Rollback auf
`0.3.5`; der Dienst war etwa eine Minute im Neustartkreis. Dass es auffiel,
lag allein daran, dass ich nach dem Ausrollen in `docker compose ps` gesehen
habe - haette ich nur den Push geprueft, waere der Provider ausgefallen
geblieben.


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
