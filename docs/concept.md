# Concept: Kubernetes Cluster Provider

**Date**: 2025-10-10
**Status**: Initial Development

---

## Overview

The Cluster Provider enables container orchestration through Kubernetes clusters. It integrates with the Enopax platform as a resource provider, leveraging the `@enopax/resource-api` framework.

---

## Core Principles

### 1. **Simplicity First**

Kubernetes clusters should be as easy to provision as any other resource:
- Simple bash scripts handle lifecycle operations
- JSON schema defines configuration
- Standard Resource API patterns
- kubeadm for cluster initialisation

### 2. **Container-Native**

Leverage Kubernetes for container orchestration:
- Deploy and manage containerised applications
- Service discovery and load balancing
- Auto-scaling based on metrics
- Rolling updates with zero downtime

### 3. **Production Ready**

Clusters designed for real-world use:
- Multi-node architecture (control plane + workers)
- RBAC and security policies
- Scalable architecture
- Enterprise-grade features

### 4. **Integration Over Isolation**

Clusters are first-class citizens in the Enopax ecosystem:
- Standard resource API integration
- Metrics and monitoring built-in
- Organisation and project scoping
- Audit logging

---

## Use Cases

### Container Orchestration

**Microservices Deployment**:
- Deploy and manage containerised applications
- Service discovery and internal DNS
- Load balancing across pods

**Auto-scaling**:
- Horizontal pod autoscaling based on CPU/memory
- Cluster autoscaler for node management
- Resource quotas and limits

### Development & Testing

**Development Clusters**:
- Isolated environments for development teams
- Namespace-based separation
- Quick cluster spin-up for testing

**CI/CD Integration**:
- Automated deployment pipelines
- Rolling updates and rollbacks
- Blue-green and canary deployments

### Production Workloads

**High Availability**:
- Multi-node clusters with redundancy
- Pod replication and health checks
- Self-healing infrastructure

**Resource Management**:
- CPU and memory quotas per namespace
- Priority classes for workload scheduling
- Persistent volume management

---

## Architecture Philosophy

### Bash Scripts for Lifecycle

Like all Enopax providers, clusters are managed through bash scripts:

```
provision.sh    → Initialize K8s cluster
status.sh       → Check cluster health
metrics.sh      → Collect cluster metrics
update.sh       → Scale worker nodes
deprovision.sh  → Destroy cluster
```

**Why bash scripts?**
- Simple and testable
- No framework lock-in
- Easy to debug
- Familiar to DevOps teams
- Direct kubectl/kubeadm integration

### Kubernetes Architecture

Multi-node K8s cluster:
- Control plane (API server, scheduler, controller manager)
- Worker nodes with kubelet and container runtime
- Pod networking (CNI plugins)
- Service mesh capabilities

### kubeadm for Cluster Management

kubeadm handles cluster lifecycle:
- Cluster initialisation
- Node joining
- Certificate management
- Cluster upgrades

---

## Configuration

### Cluster Parameters

```json
{
  "name": "production-k8s",
  "workerNodes": 3,
  "k8sVersion": "1.28",
  "organisationName": "my-org",
  "projectName": "production"
}
```

**workerNodes**: Number of worker nodes in the cluster
**k8sVersion**: Kubernetes version to deploy

---

## Security Considerations

### Data Security
- Content addressing prevents tampering
- Encrypted transport between nodes (libp2p)
- No mutable references without explicit pinning

### Access Control
- Optional API key authentication
- Organisation/project scoping
- Audit logging for all operations

### Isolation
- Each cluster runs in isolated Docker network
- Resource quotas prevent exhaustion
- No cross-cluster access

---

## Future Enhancements

### High Availability Control Plane
- Multi-master setup
- Etcd clustering
- Load balancer for API server

### Advanced Metrics
- Real-time resource usage (kubectl top)
- Pod and node metrics
- Custom metrics with Prometheus
- Performance analytics

### Enterprise Features
- Multi-tenancy with namespaces
- Compliance reporting
- SLA monitoring
- Helm chart management

---

## Conclusion

The Cluster Provider brings container orchestration to the Enopax platform while maintaining simplicity and production-readiness. By leveraging Kubernetes and a bash script foundation, it enables powerful orchestration capabilities that are easy to provision and manage.
