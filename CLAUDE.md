# CLAUDE.md

**AI Assistant Reference File**
This file provides guidance to Claude Code when working with the Enopax Cluster Provider repository.

---

## 📚 Project Overview

**Name**: Enopax Cluster Provider
**Purpose**: Kubernetes cluster provisioning for container orchestration
**Status**: 🚧 Initial Development - Framework complete, K8s implementation pending

**Core Principle**: Enable container orchestration through easy-to-provision Kubernetes clusters integrated with the Enopax platform.

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
1. **Cluster Deployment** - Simple provisioning of multi-node Kubernetes clusters
2. **Container Orchestration** - Deploy and manage containerised applications
3. **Auto-scaling** - Dynamic scaling of worker nodes
4. **Health Monitoring** - Real-time cluster health and metrics
5. **Resource API Integration** - Seamless integration with Enopax ecosystem

---

## 🏗️ Architecture

### Technology Stack

**Backend**:
- Node.js with `@enopax/resource-api`
- Bash scripts for lifecycle operations

**Kubernetes Stack**:
- Kubernetes (K8s) for container orchestration
- kubectl and kubeadm for cluster management
- Docker/containerd for container runtime

**Orchestration**:
- Control plane (API server, scheduler, controller)
- Worker nodes with kubelet
- Pod networking and service discovery

---

## 📂 Implementation Details

### Bash Scripts

**provision.sh**:
- Creates cluster directory structure
- Generates unique cluster ID
- Stores configuration in cluster.json
- TODO: Initialize K8s cluster with kubeadm

**status.sh**:
- Reads cluster configuration
- Returns cluster status
- TODO: Query actual K8s cluster health (kubectl get nodes)

**metrics.sh**:
- Calculates uptime
- Measures resource usage
- TODO: Get real metrics from K8s (kubectl top nodes/pods)

**update.sh**:
- Updates cluster configuration
- Scales worker node count
- TODO: Apply changes to running cluster (kubectl scale)

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
# Input: name, workerNodes, k8sVersion, org, project
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
# Returns: uptime, nodes, pods, CPU/memory usage
```

**Update**:
```bash
PUT /v1/clusters/:id
# Update: worker node count
```

**Delete**:
```bash
DELETE /v1/clusters/:id
# Stop cluster and clean up
```

---

## 💡 Use Cases

### Container Orchestration
- Microservices deployment
- Service discovery and load balancing
- Auto-scaling based on metrics

### Development & Testing
- Development environments
- CI/CD integration
- Ephemeral test clusters

### Production Workloads
- High availability applications
- Rolling updates
- Resource quotas and limits

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

### Phase 2: K8s Integration (Next)
- [ ] Kubernetes cluster initialisation with kubeadm
- [ ] Control plane and worker node deployment
- [ ] kubectl configuration
- [ ] Node health monitoring

### Phase 3: Production Features
- [ ] Dynamic node scaling
- [ ] Cluster upgrades
- [ ] Advanced metrics (kubectl top)
- [ ] Persistent volume management

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
1. Implement kubeadm cluster initialisation
2. Deploy control plane and worker nodes
3. Generate kubeconfig for access
4. Implement real metrics gathering (kubectl)

### Future Enhancements
1. High availability control plane
2. Multi-cloud deployment
3. Advanced monitoring dashboard
4. Helm chart support

---

*This provider is in initial development. Server framework is complete, K8s integration is pending.*
