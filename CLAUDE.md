# CLAUDE.md

**AI Assistant Reference File**
This file provides guidance to Claude Code when working with the Enopax Cluster Provider repository.

---

## 📚 Project Overview

**Name**: Enopax Cluster Provider
**Purpose**: IPFS cluster provisioning for distributed storage
**Status**: 🚧 Initial Development - Framework complete, IPFS implementation pending

**Core Principle**: Enable distributed, decentralised storage through easy-to-provision IPFS clusters integrated with the Enopax platform.

---

## 🚀 Quick Start

### Running the Server

```bash
# Install dependencies
pnpm install

# Start server
pnpm dev

# Server runs on http://localhost:3003
# API endpoint: /v1/clusters
```

### Server Architecture

This provider uses the `@enopax/resource-api` npm library for the server framework:

```javascript
// server.js
const { createServer } = require('@enopax/resource-api');

const app = createServer({
  port: 3003,
  authentication: { enabled: false, apiKey: '' },
  providers: [{
    apiVersion: 'v1',
    endpoint: '/clusters',
    scriptsFolder: './provider/cluster/scripts'
  }]
});

app.listen(3003);
```

### Project Structure

```
provider-cluster/
├── server.js                  # Server using @enopax/resource-api
├── package.json               # Dependencies
├── provider/
│   └── cluster/
│       ├── config.json        # Provider configuration
│       ├── scripts/           # CRUD operation scripts
│       │   ├── common.sh
│       │   ├── provision.sh
│       │   ├── list.sh
│       │   ├── status.sh
│       │   ├── metrics.sh
│       │   ├── update.sh
│       │   └── deprovision.sh
│       └── data/              # Cluster storage
└── README.md
```

---

## 🎯 Project Goals

### Primary Objectives
1. **Cluster Deployment** - Simple provisioning of multi-node IPFS clusters
2. **Replication Management** - Configurable replication factors for data redundancy
3. **Distributed Storage** - Geographic distribution of cluster nodes
4. **Health Monitoring** - Real-time cluster health and metrics
5. **Resource API Integration** - Seamless integration with Enopax ecosystem

---

## 🏗️ Architecture

### Technology Stack

**Backend**:
- Node.js with `@enopax/resource-api`
- Bash scripts for lifecycle operations

**IPFS Stack**:
- IPFS (InterPlanetary File System)
- IPFS Cluster for distributed pinning
- Docker containers for node isolation

**Storage**:
- Content-addressed IPFS storage
- Distributed across cluster nodes
- Configurable replication factor

---

## 📂 Implementation Details

### Bash Scripts

**provision.sh**:
- Creates cluster directory structure
- Generates unique cluster ID
- Stores configuration in cluster.json
- TODO: Deploy IPFS nodes in Docker containers

**status.sh**:
- Reads cluster configuration
- Returns cluster status
- TODO: Query actual IPFS cluster health

**metrics.sh**:
- Calculates uptime
- Measures storage usage
- TODO: Get real metrics from IPFS cluster API

**update.sh**:
- Updates cluster configuration
- Modifies node count and replication factor
- TODO: Apply changes to running cluster

**list.sh**:
- Lists all clusters for org/project
- Filters by organisation and project slugs

**deprovision.sh**:
- Removes cluster directory
- TODO: Stop Docker containers and cleanup

---

## 🔧 Resource API Integration

### Standard Endpoints

Following the Enopax Resource API pattern:

**Discovery**:
```bash
GET /providers/info
# Returns cluster provider metadata
```

**Provision**:
```bash
POST /v1/clusters
# Input: name, nodes, replicationFactor, org, project
# Output: cluster ID, status
```

**Status**:
```bash
GET /v1/clusters/:id
# Returns: cluster status, configuration
```

**Metrics**:
```bash
GET /v1/clusters/:id/metrics
# Returns: uptime, storage, pins, node health
```

**Update**:
```bash
PUT /v1/clusters/:id
# Update: nodes, replication factor
```

**Delete**:
```bash
DELETE /v1/clusters/:id
# Stop cluster and clean up
```

---

## 💡 Use Cases

### Distributed Storage
- Content distribution networks
- Geographic redundancy
- High availability storage

### Backup & Archival
- Immutable content addressing
- Version history tracking
- Disaster recovery

### Decentralised Applications
- dApp storage backend
- NFT asset storage
- Censorship-resistant publishing

---

## 📋 Development Guidelines

### Code Standards
- **Language**: Bash for scripts, Node.js for server
- **Documentation**: Comprehensive inline comments
- **Testing**: Manual script testing required
- **British English**: Consistent spelling throughout

### Workflow
1. **Branching**: Feature branches for all changes
2. **Commits**: Semantic commit messages
3. **Pull Requests**: Required for all changes
4. **Testing**: Test scripts before committing

### Best Practices
- **Never** expose sensitive data in logs
- **Always** validate input in bash scripts
- **Always** use proper error handling
- **Never** assume cluster is running (check status)
- **Always** clean up resources on deprovision

---

## 🚀 Implementation Phases

### Phase 1: Foundation (Complete)
- ✅ Server using `@enopax/resource-api`
- ✅ Bash script structure
- ✅ Basic CRUD operations (file-based)
- ✅ Documentation

### Phase 2: IPFS Integration (Next)
- [ ] Docker-based IPFS node deployment
- [ ] IPFS Cluster initialisation
- [ ] Node health monitoring
- [ ] Actual replication management

### Phase 3: Production Features
- [ ] Dynamic scaling
- [ ] Geographic distribution
- [ ] Advanced metrics
- [ ] Backup and restore

---

## 📚 Documentation

### Project Documentation

- **[README.md](./README.md)** - User-facing documentation
- **[docs/concept.md](./docs/concept.md)** - Core concepts
- **[docs/architecture.md](./docs/architecture.md)** - Detailed architecture
- **[CLAUDE.md](./CLAUDE.md)** - This file

### Related Documentation

- **[Resource API docs](../resource-api/)** - Resource API integration patterns
- **[Platform docs](../platform/)** - Platform integration
- **[Orga CLAUDE.md](../orga/CLAUDE.md)** - Organisation structure

---

## 🐛 Debugging

### Common Issues

**Cluster not found**:
- Check ID format: `orgslug-projectslug-name`
- Verify cluster directory exists
- Check data path in common.sh

**Provision fails**:
- Validate input JSON
- Check for existing cluster with same name
- Review logs in stderr

**Scripts not executable**:
```bash
chmod +x provider/cluster/scripts/*.sh
```

---

## 📝 Next Steps

### Immediate Tasks
1. Implement Docker-based IPFS node deployment
2. Configure IPFS Cluster
3. Add health checks
4. Implement real metrics gathering

### Future Enhancements
1. Kubernetes deployment
2. Geographic node distribution
3. Advanced monitoring dashboard
4. Backup/restore functionality

---

*This provider is in initial development. Server framework is complete, IPFS integration is pending.*
