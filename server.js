/**
 * Cluster Provider Server
 *
 * Uses @enopax/resource-api library to serve Kubernetes cluster provisioning
 */

const { createServer } = require('@enopax/resource-api');
const handlers = require('./provider/cluster/handlers');
const { registerRoutes } = require('./provider/cluster/routes');

// Create server with cluster provider configuration
const app = createServer({
  port: 3000,
  host: 'localhost',
  authentication: {
    enabled: true,
    apiKey: process.env.API_KEY || 'secret-cluster-key'
  },
  providers: [
    {
      apiVersion: 'v1',
      endpoint: '/clusters',
      // Funktionen statt Skripte: der Kubernetes-Client wird einmal aufgebaut
      // und nicht bei jedem Aufruf. Die alten Skripte liegen bis zum Aufraeumen
      // daneben; sie legten einen Namespace an und nannten das einen Cluster.
      providerFolder: './provider/cluster',
      handlers
    }
  ]
});

// Die Routen, die der Rahmen nicht kennt - siehe provider/cluster/routes.js.
registerRoutes(app, handlers);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

app.listen(PORT, HOST, () => {
  console.log(`\nCluster Provider API running on http://${HOST}:${PORT}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  GET  /providers/info          - Discover providers`);
  console.log(`\nCluster Provider:`);
  console.log(`  Endpoint: /v1/clusters`);
  console.log(`  Operations:`);
  console.log(`    - GET    /v1/clusters?org=...&project=...`);
  console.log(`    - POST   /v1/clusters`);
  console.log(`    - GET    /v1/clusters/:id`);
  console.log(`    - GET    /v1/clusters/:id/metrics`);
  console.log(`    - GET    /v1/clusters/:id/kubeconfig`);
  console.log(`    - PUT    /v1/clusters/:id`);
  console.log(`    - DELETE /v1/clusters/:id`);
  console.log(`\n`);
});
