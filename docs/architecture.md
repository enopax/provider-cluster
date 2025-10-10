# Architecture: IPFS Cluster Provider

**Last Updated**: 2025-10-10

---

## System Overview

The Cluster Provider consists of three main layers:

1. **Server Layer** - Express server via `@enopax/resource-api`
2. **Script Layer** - Bash scripts for cluster lifecycle
3. **IPFS Layer** - Docker containers running IPFS nodes

```
┌─────────────────────────────────────────┐
│           Resource API Server           │
│        (Node.js + Express)              │
│          Port: 3003                     │
└─────────────────────────────────────────┘
                   │
                   │ Calls bash scripts
                   ▼
┌─────────────────────────────────────────┐
│         Bash Script Layer               │
│  provision.sh, status.sh, etc.          │
└─────────────────────────────────────────┘
                   │
                   │ Manages Docker containers
                   ▼
┌─────────────────────────────────────────┐
│         IPFS Cluster Layer              │
│  Docker containers with IPFS nodes      │
│  Distributed pinning coordination       │
└─────────────────────────────────────────┘
```

---

## Server Layer

### Technology
- Node.js with `@enopax/resource-api` library
- Express web framework
- JSON request/response

### Responsibilities
- HTTP API endpoints
- Request validation
- Authentication (optional)
- Script execution
- Response formatting

### Endpoints
```
GET  /providers/info           - Discovery
GET  /v1/clusters              - List clusters
POST /v1/clusters              - Provision cluster
GET  /v1/clusters/:id          - Get status
GET  /v1/clusters/:id/metrics  - Get metrics
PUT  /v1/clusters/:id          - Update cluster
DELETE /v1/clusters/:id        - Deprovision
```

---

## Script Layer

### Bash Scripts

**provision.sh**:
- Parse input JSON
- Generate unique cluster ID
- Create cluster directory
- Store configuration
- Deploy IPFS nodes (TODO)

**status.sh**:
- Read cluster configuration
- Check cluster health (TODO)
- Return status JSON

**metrics.sh**:
- Calculate uptime
- Get storage usage
- Query IPFS metrics (TODO)

**update.sh**:
- Update configuration
- Scale cluster (TODO)

**list.sh**:
- Find clusters by org/project
- Return cluster list

**deprovision.sh**:
- Stop IPFS nodes (TODO)
- Remove cluster data

---

## IPFS Layer

### Docker Deployment

Each cluster consists of N Docker containers:

```
Cluster: my_org-prod-storage

Container 1: ipfs-node-1
  - IPFS daemon
  - IPFS Cluster daemon
  - Data volume

Container 2: ipfs-node-2
  - IPFS daemon
  - IPFS Cluster daemon
  - Data volume

Container 3: ipfs-node-3
  - IPFS daemon
  - IPFS Cluster daemon
  - Data volume
```

### IPFS Cluster Coordination

- Leader election for coordination
- Distributed hash table (DHT)
- Replication factor enforcement
- Health monitoring

---

## Data Flow

### Provisioning Flow

1. User sends POST to `/v1/clusters`
2. Server validates input
3. Server calls `provision.sh` with JSON
4. Script creates cluster directory
5. Script generates cluster ID
6. Script stores configuration
7. (TODO) Script deploys Docker containers
8. Script returns success JSON
9. Server returns response to user

### Status Check Flow

1. User sends GET to `/v1/clusters/:id`
2. Server calls `status.sh` with ID
3. Script reads cluster configuration
4. (TODO) Script queries IPFS health
5. Script returns status JSON
6. Server returns response to user

---

## File Structure

```
provider-cluster/
├── server.js                           # Express server
├── provider/
│   └── cluster/
│       ├── config.json                 # Provider metadata
│       ├── scripts/                    # Bash scripts
│       │   ├── common.sh               # Shared functions
│       │   ├── provision.sh
│       │   ├── status.sh
│       │   ├── metrics.sh
│       │   ├── update.sh
│       │   ├── list.sh
│       │   └── deprovision.sh
│       └── data/                       # Cluster storage
│           └── clusters/
│               └── {cluster-id}/
│                   ├── cluster.json    # Cluster config
│                   └── data/           # IPFS data
```

---

## ID Format

Cluster IDs follow the pattern:
```
{org-slug}-{project-slug}-{cluster-name}
```

Example:
```
my_org-production-storage_cluster
```

---

## Configuration Storage

Each cluster has a `cluster.json` file:

```json
{
  "id": "my_org-production-storage_cluster",
  "name": "storage-cluster",
  "organisation": "My Org",
  "project": "Production",
  "nodes": 5,
  "replicationFactor": 3,
  "status": "active",
  "createdAt": "2025-10-10T12:00:00Z",
  "updatedAt": "2025-10-10T12:00:00Z"
}
```

---

## Future Architecture

### Phase 2: Docker Implementation
- IPFS Docker images
- IPFS Cluster configuration
- Container networking
- Volume management

### Phase 3: Scaling
- Kubernetes deployment
- Multi-server clusters
- Geographic distribution
- Load balancing

---

## Security Architecture

### Network Isolation
- Each cluster in separate Docker network
- No cross-cluster communication
- Firewall rules

### Data Protection
- Content addressing (CIDs)
- Encrypted transport (libp2p)
- Access control via API keys

### Resource Limits
- CPU quotas per container
- Memory limits
- Storage quotas
- Network bandwidth limits

---

*Architecture subject to evolution as IPFS implementation progresses.*
