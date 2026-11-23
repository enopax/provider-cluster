# Enopax Cluster-Provider.
#
# Node 24 (LTS) wie Console und console-api.
#
# Eine Stufe, nicht zwei: hier wird nichts uebersetzt oder gebuendelt, es ist
# JavaScript. Ein Build-Schritt waere eine Stufe, die nur Zeit kostet.

FROM node:24-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Erst die Lockfiles, damit der npm-Layer nur bei Abhaengigkeitsaenderungen
# neu laeuft und nicht bei jeder Quelltextaenderung.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY provider ./provider

# Als unprivilegierter Nutzer; das Node-Image bringt uid/gid 1000 mit.
USER node

EXPOSE 3000

# Der Dienst spricht mit dem Management-Cluster. Ausserhalb des Clusters ueber
# eine kubeconfig unter KUBECONFIG - auf dem App-Host eine, die das Token des
# ServiceAccounts enopax-cluster-provider traegt (deploy/rbac.yaml). Laeuft er
# einmal im Cluster selbst, nimmt handlers.js automatisch das Token des Pods.
CMD ["node", "server.js"]
