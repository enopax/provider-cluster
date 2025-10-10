# Enopax Cluster Provider

**IPFS Cluster Provisioning for Distributed Storage**

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](./CHANGELOG.md)
[![Status](https://img.shields.io/badge/status-initial%20development-yellow.svg)](#status)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

---

## Overview

The Cluster Provider enables provisioning and management of IPFS clusters for distributed, decentralised storage. Powered by the [`@enopax/resource-api`](https://www.npmjs.com/package/@enopax/resource-api) framework, it provides production-ready IPFS cluster deployment through the Enopax platform.

**Features**:
- 🗂️ Deploy multi-node IPFS clusters
- 📦 Configurable replication factors
- 🔄 Automatic data synchronisation
- 📊 Real-time cluster metrics
- 🔧 Dynamic cluster scaling

---

## Status

**🚧 Initial Development** - v0.1.0

- ✅ Server implementation using `@enopax/resource-api`
- ✅ Provider API integration complete
- ✅ Bash script structure in place
- 🚧 IPFS cluster implementation (pending)
- 🚧 Docker container deployment (pending)

---

## Quick Start

### Prerequisites

- Node.js 18+ and pnpm
- Docker (for IPFS nodes)
- IPFS and IPFS Cluster installed

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
#     "typeId": "ipfs-cluster",
#     "displayName": "IPFS Cluster",
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
2. Select "IPFS Cluster" provider
3. Configure cluster settings:
   - Cluster name
   - Number of nodes
   - Replication factor
4. Click "Provision"

**Via API**:
```bash
curl -X POST http://localhost:3003/v1/clusters \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-storage",
    "nodes": 5,
    "replicationFactor": 3,
    "organisationName": "my-org",
    "projectName": "production"
  }'
```

**Response**:
```json
{
  "success": true,
  "id": "my_org-production-production_storage",
  "name": "production-storage",
  "status": "active",
  "nodes": 5,
  "replicationFactor": 3,
  "message": "IPFS cluster provisioned successfully"
}
```

### Checking Cluster Status

```bash
curl http://localhost:3003/v1/clusters/my_org-production-production_storage
```

**Response**:
```json
{
  "success": true,
  "id": "my_org-production-production_storage",
  "name": "production-storage",
  "status": "active",
  "nodes": 5,
  "replicationFactor": 3,
  "createdAt": "2025-10-10T12:00:00Z"
}
```

### Getting Cluster Metrics

```bash
curl http://localhost:3003/v1/clusters/my_org-production-production_storage/metrics
```

**Response**:
```json
{
  "success": true,
  "id": "my_org-production-production_storage",
  "metrics": {
    "uptime": 86400,
    "totalStorageKB": 1024000,
    "totalPins": 150,
    "activeNodes": 5,
    "replicationStatus": "healthy"
  }
}
```

### Updating Cluster Configuration

```bash
curl -X PUT http://localhost:3003/v1/clusters/my_org-production-production_storage \
  -H "Content-Type: application/json" \
  -d '{
    "nodes": 7,
    "replicationFactor": 4
  }'
```

### Deprovisioning a Cluster

```bash
curl -X DELETE http://localhost:3003/v1/clusters/my_org-production-production_storage
```

---

## Configuration

### Cluster Configuration

Clusters are configured via JSON schema:

```json
{
  "name": "my-cluster",
  "nodes": 3,
  "replicationFactor": 2,
  "organisationName": "my-org",
  "projectName": "my-project"
}
```

**Parameters**:
- `name` (required): Unique name for the cluster
- `nodes` (optional): Number of IPFS nodes (default: 3)
- `replicationFactor` (optional): Data replication count (default: 2)
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
3. **IPFS Cluster**: Docker containers running IPFS nodes
4. **Data Layer**: Distributed storage across cluster nodes

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
│       └── data/              # Cluster storage
├── docs/
│   ├── concept.md            # Core concepts
│   └── architecture.md       # System architecture
├── CLAUDE.md                 # AI assistant guidance
└── README.md                 # This file
```

---

## Use Cases

### Distributed Storage
- **Content Distribution**: Replicate content across multiple nodes
- **High Availability**: Ensure data availability with redundancy
- **Geographic Distribution**: Deploy nodes in different locations

### Backup & Archival
- **Immutable Storage**: IPFS content addressing ensures data integrity
- **Version History**: Track file versions through IPFS hashes
- **Disaster Recovery**: Distributed replication protects against node failures

### Decentralised Applications
- **dApp Storage**: Provide storage layer for decentralised applications
- **NFT Storage**: Store NFT assets and metadata
- **Content Publishing**: Censorship-resistant content distribution

See [`docs/concept.md`](./docs/concept.md) for detailed use cases.

---

## Development

### Prerequisites

- Node.js 18+
- pnpm
- Docker Desktop
- IPFS and IPFS Cluster
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
echo '{"name":"test","organisationName":"myorg","projectName":"myproj"}' | \
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

### Data Security
- All data stored using IPFS content addressing
- No mutable references without explicit pinning
- Encrypted transport between nodes

### Access Control
- Optional API key authentication
- Organisation/project scoping
- Audit logging for all operations

### Isolation
- Each cluster runs in isolated Docker network
- Resource quotas prevent resource exhaustion
- No cross-cluster data access

---

## Roadmap

### v0.2.0 (Next)
- [ ] Docker-based IPFS node deployment
- [ ] Cluster initialisation and configuration
- [ ] Node health monitoring
- [ ] Basic replication verification

### v0.3.0
- [ ] Dynamic node scaling
- [ ] Advanced metrics and monitoring
- [ ] Cluster backup and restore
- [ ] Geographic distribution

### v1.0.0
- [ ] Production-ready deployment
- [ ] Kubernetes support
- [ ] Enterprise features
- [ ] Comprehensive testing

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
- Powered by [IPFS](https://ipfs.io/) and [IPFS Cluster](https://cluster.ipfs.io/)

---

**Status**: Initial development • IPFS implementation pending • v0.1.0
