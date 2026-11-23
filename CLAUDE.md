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

Was dagegen hilft: Pflichtfelder je Anbieter in `SHAPES` fuehren und vor dem
Anlegen pruefen - so wie `sshKeysRequired` fuer Hetzner. Jede neue
Pflichtangabe gehoert dorthin, sonst findet sie erst der Betrieb.
