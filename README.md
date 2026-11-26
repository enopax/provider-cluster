# Enopax Cluster Provider

**Kubernetes Cluster Provisioning for Container Orchestration**

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](./CHANGELOG.md)
[![Status](https://img.shields.io/badge/status-initial%20development-yellow.svg)](#status)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

---

## Overview

The Cluster Provider enables provisioning and management of Kubernetes (K8s) clusters for container orchestration. Powered by the [`@enopax/resource-api`](https://www.npmjs.com/package/@enopax/resource-api) framework, it provides production-ready Kubernetes cluster deployment through the Enopax platform.

**What it does**: takes a request over HTTP and turns it into a k0rdent
`ClusterDeployment` on the management cluster, then reads that object's status
back. It does **not** build clusters — k0rdent does, through Cluster API and
Helm. KCM has no REST interface of its own; what it offers is the Kubernetes
API with its CRDs, and this service is the façade in front of it.

**What it does not decide**: which template, which credential, which location,
which machine types. `console-api` resolves those from its `provider_regions`
and `provider_sizes` tables and sends them along. This service only knows what
a Hetzner, a StackIT and an AWS `ClusterDeployment` look like — they differ in the key
for the machine type (`type` vs `instanceType`) and the SSH key field, and
nowhere else.

---

## Status

**Built, not yet deployed** — v0.2.0

- ✅ Creates, reads, scales and deletes k0rdent `ClusterDeployment` objects
- ✅ Progress from the six conditions KCM maintains, not an invented list
- ✅ Metrics from the child cluster, via the kubeconfig secret Cluster API writes
- ✅ RBAC manifest in `deploy/rbac.yaml` — three rights, no admin
- ✅ Container image; runs with a service-account kubeconfig outside the
  cluster, or the pod's own token inside it
- ⛔ Needs `@enopax/resource-api` ≥ 1.1.0, which is **not published yet**

### What replaced the bash scripts

Until v0.2.0 the operations were bash scripts, and they were a decoy:
`provision.sh` applied a manifest, and the manifest was a **Namespace**. It
reported `status: "active"` immediately without waiting for anything, ignored
`workerNodes` and `k8sVersion` entirely, and wrote `# Kubeconfig will be
generated here` into a file called `kubeconfig.yaml`. `metrics.sh` returned
hard-wired zeros for nodes, pods, CPU and memory; the only real figure was
uptime, computed with `date -j` — BSD syntax that does not run on Linux.

They are gone. Dead code that looks like it works is worse than none.

### Why handlers, not scripts

`@enopax/resource-api` runs an operation as a bash script by default, which is
right for short, stateless work. This provider holds a Kubernetes client with
a token and a certificate; a script would rebuild it on every call and could
keep nothing between two of them. Version 1.1.0 of the framework therefore
accepts `handlers` — JavaScript functions in the server process — and falls
back to scripts when a provider has none.

---

## Quick Start

### Prerequisites

- Node.js 18+ and pnpm
- Docker (for K8s nodes)
- kubectl and kubeadm
- Sufficient system resources (CPU, RAM, storage)

### Installation

```bash
# Clone repository
git clone https://github.com/enopax/provider-cluster.git
cd provider-cluster

# Install dependencies
pnpm install

# Start server
pnpm dev

# Server runs on http://localhost:3003
```

### Verify Installation

```bash
# Test provider discovery
curl http://localhost:3003/providers/info | json_pp

# Expected output:
# {
#   "success": true,
#   "providers": [{
#     "typeId": "k8s-cluster",
#     "displayName": "K8s Cluster",
#     "endpoint": "/clusters",
#     ...
#   }]
# }
```

---

## Usage

### Provisioning a Cluster

**Via Platform UI**:
1. Navigate to Resources → Create Resource
2. Select "K8s Cluster" provider
3. Configure cluster settings:
   - Cluster name
   - Number of worker nodes
   - Kubernetes version
4. Click "Provision"

**Via API**:
```bash
curl -X POST http://localhost:3003/v1/clusters \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-k8s",
    "workerNodes": 3,
    "k8sVersion": "1.28",
    "organisationName": "my-org",
    "projectName": "production"
  }'
```

**Response**:
```json
{
  "success": true,
  "id": "my_org-production-production_k8s",
  "name": "production-k8s",
  "status": "active",
  "workerNodes": 3,
  "k8sVersion": "1.28",
  "message": "Kubernetes cluster provisioned successfully"
}
```

### Checking Cluster Status

```bash
curl http://localhost:3003/v1/clusters/my_org-production-production_k8s
```

**Response**:
```json
{
  "success": true,
  "id": "my_org-production-production_k8s",
  "name": "production-k8s",
  "status": "active",
  "workerNodes": 3,
  "k8sVersion": "1.28",
  "createdAt": "2025-10-10T12:00:00Z"
}
```

### Getting Cluster Metrics

```bash
curl http://localhost:3003/v1/clusters/my_org-production-production_k8s/metrics
```

**Response**:
```json
{
  "success": true,
  "id": "my_org-production-production_k8s",
  "metrics": {
    "uptime": 86400,
    "totalNodes": 4,
    "readyNodes": 4,
    "pods": 25,
    "cpuUsagePercent": 45,
    "memoryUsagePercent": 62
  }
}
```

### Updating Cluster Configuration

Two things can change on a running cluster: the worker count and the k0s
version. Either on its own, or both in one call — one call means one patch,
so a half-applied change cannot look like a whole one.

```bash
curl -X PUT http://localhost:3003/v1/clusters/kcm-system%2Fdev-box1 \
  -H "Content-Type: application/json" \
  -d '{
    "workerNodes": 5,
    "k0sVersion": "v1.36.3+k0s.0"
  }'
```

`k0sVersion` is the **upgrade**. k0rdent has no upgrade verb: setting
`spec.config.k0s.version` is how it is done, and Cluster API then replaces the
nodes. The notation is mandatory (`v1.36.3+k0s.0`) because the template builds
a download URL from it; `1.36.3` yields one that does not exist, and that
shows up on a node which never joins.

Which versions may be offered is **not decided here** — `console-api` holds
the catalogue. This service refuses a version it cannot write (wrong notation,
or a template whose config carries no `k0s.version`) and otherwise reports
back what the patched object says:

```json
{ "success": true, "workerNodes": 5, "k8sVersion": "v1.36.3+k0s.0" }
```

Those two fields come from the object, not from the request. The caller is
meant to compare them against what it asked for — a `success: true` is not a
promise that anything arrived. See enopax/enopax#38.

### Deprovisioning a Cluster

```bash
curl -X DELETE http://localhost:3003/v1/clusters/my_org-production-production_k8s
```

---

## Configuration

### Cluster Configuration

Clusters are configured via JSON schema:

```json
{
  "name": "my-k8s-cluster",
  "workerNodes": 3,
  "k8sVersion": "1.28",
  "organisationName": "my-org",
  "projectName": "my-project"
}
```

**Parameters**:
- `name` (required): Unique name for the cluster
- `workerNodes` (optional): Number of worker nodes (default: 3)
- `k8sVersion` (optional): Kubernetes version (default: latest stable)
- `organisationName` (required): Organisation identifier
- `projectName` (required): Project identifier

### Server Configuration

Server settings in `server.js`:

```javascript
const app = createServer({
  port: 3003,                          // Server port
  host: 'localhost',                   // Server host
  authentication: {
    enabled: false,                     // Enable API key auth
    apiKey: process.env.API_KEY || ''  // API key
  },
  providers: [{
    apiVersion: 'v1',
    endpoint: '/clusters',
    scriptsFolder: './provider/cluster/scripts'
  }]
});
```

---

## API Reference

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/providers/info` | Discover provider metadata |
| `GET` | `/v1/clusters?org=...&project=...` | List clusters |
| `POST` | `/v1/clusters` | Provision new cluster |
| `GET` | `/v1/clusters/:id` | Get cluster status |
| `GET` | `/v1/clusters/:id/metrics` | Get cluster metrics |
| `PUT` | `/v1/clusters/:id` | Update cluster |
| `DELETE` | `/v1/clusters/:id` | Deprovision cluster |

### Configuration Schema

See [`provider/cluster/config.json`](./provider/cluster/config.json) for the complete JSON Schema.

---

## Architecture

The Cluster Provider uses a layered architecture:

1. **Server Layer**: Express via `@enopax/resource-api`
2. **Provider Scripts**: Bash scripts for lifecycle management
3. **K8s Control Plane**: Master node with API server, scheduler, controller
4. **Worker Nodes**: Container runtime and kubelet on each node

See [`docs/architecture.md`](./docs/architecture.md) for detailed architecture documentation.

---

## Project Structure

```
provider-cluster/
├── server.js                  # Server using @enopax/resource-api
├── package.json               # Dependencies and scripts
├── provider/
│   └── cluster/
│       ├── config.json        # Provider configuration
│       ├── scripts/           # Lifecycle scripts
│       │   ├── provision.sh
│       │   ├── list.sh
│       │   ├── status.sh
│       │   ├── metrics.sh
│       │   ├── update.sh
│       │   └── deprovision.sh
│       └── data/              # Cluster data
├── docs/
│   ├── concept.md            # Core concepts
│   └── architecture.md       # System architecture
├── CLAUDE.md                 # AI assistant guidance
└── README.md                 # This file
```

---

## Use Cases

### Container Orchestration
- **Microservices Deployment**: Deploy and manage containerised applications
- **Auto-scaling**: Horizontal pod autoscaling based on metrics
- **Service Discovery**: Built-in service discovery and load balancing

### Development & Testing
- **Development Clusters**: Isolated environments for development teams
- **CI/CD Integration**: Automated deployment pipelines
- **Testing Environments**: Ephemeral clusters for integration testing

### Production Workloads
- **High Availability**: Multi-node clusters with redundancy
- **Rolling Updates**: Zero-downtime deployments
- **Resource Management**: CPU and memory quotas per namespace

See [`docs/concept.md`](./docs/concept.md) for detailed use cases.

---

## Development

### Prerequisites

- Node.js 18+
- pnpm
- Docker Desktop
- kubectl and kubeadm
- Git

### Setup

```bash
# Clone repository
git clone https://github.com/enopax/provider-cluster.git
cd provider-cluster

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

### Testing Scripts

```bash
# Test provision script manually
echo '{"name":"test","workerNodes":2,"organisationName":"myorg","projectName":"myproj"}' | \
  bash provider/cluster/scripts/provision.sh

# Test status script
echo '{"id":"myorg-myproj-test"}' | \
  bash provider/cluster/scripts/status.sh
```

---

## Documentation

- **[Concept](./docs/concept.md)** - Core concepts and philosophy
- **[Architecture](./docs/architecture.md)** - System architecture and design
- **[CLAUDE.md](./CLAUDE.md)** - AI assistant guidance

---

## Security

### Cluster Security
- RBAC enabled by default
- Network policies for pod-to-pod communication
- Secret management with encryption at rest
- TLS for all API server communication

### Access Control
- Optional API key authentication
- Organisation/project scoping
- Audit logging for all operations
- Kubeconfig generation for authorized users

### Isolation
- Each cluster runs in isolated network
- Resource quotas prevent resource exhaustion
- No cross-cluster access

---

## Roadmap

### v0.2.0 (Next)
- [ ] Kubernetes cluster initialisation with kubeadm
- [ ] Control plane and worker node deployment
- [ ] kubectl access configuration
- [ ] Basic health monitoring

### v0.3.0
- [x] Dynamic node scaling (add/remove workers)
- [x] Cluster upgrades (K8s version updates) — `spec.config.k0s.version`
- [ ] Advanced metrics (pod, node, resource usage)
- [ ] Persistent volume management

### v1.0.0
- [ ] Production-ready deployment
- [ ] High availability control plane
- [ ] Multi-cloud support
- [ ] Comprehensive monitoring and logging

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

Follow semantic commit messages and PR specifications.

---

## Support

- **Issues**: [GitHub Issues](https://github.com/enopax/provider-cluster/issues)
- **Documentation**: [`docs/`](./docs/)
- **Email**: support@enopax.io

---

## License

MIT

---

## Acknowledgements

- Built with [`@enopax/resource-api`](https://www.npmjs.com/package/@enopax/resource-api)
- Part of the [Enopax](https://github.com/enopax) ecosystem
- Powered by [Kubernetes](https://kubernetes.io/)

---

**Status**: Initial development • K8s implementation pending • v0.1.0
