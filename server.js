/**
 * Cluster Provider Server
 *
 * Uses @enopax/resource-api library to serve Kubernetes cluster provisioning
 */

const { createServer } = require('@enopax/resource-api');

// Create server with cluster provider configuration
const app = createServer({
  port: 3003,
  host: 'localhost',
  authentication: {
    enabled: false,
    apiKey: process.env.API_KEY || ''
  },
  providers: [
    {
      apiVersion: 'v1',
      endpoint: '/clusters',
      scriptsFolder: './provider/cluster/scripts'
    }
  ]
});

const PORT = process.env.PORT || 3003;
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
  console.log(`    - PUT    /v1/clusters/:id`);
  console.log(`    - DELETE /v1/clusters/:id`);
  console.log(`\n`);
});
