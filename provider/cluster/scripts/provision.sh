#!/bin/bash
set -e

# Load common configuration and helper functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "[provision.sh] Starting cluster provisioning..." >&2

# Read all input (multiline JSON)
INPUT=$(cat)

echo "[provision.sh] Received input, parsing fields..." >&2

# Parse input from flat structure
NAME=$(echo "$INPUT" | jq -r '.name // empty')
ORG_NAME=$(echo "$INPUT" | jq -r '.organisationName // "default"')
PROJECT_NAME=$(echo "$INPUT" | jq -r '.projectName // "default"')
NODES=$(echo "$INPUT" | jq -r '.nodes // empty')
REPLICATION_FACTOR=$(echo "$INPUT" | jq -r '.replicationFactor // empty')

# Validate required fields
if [ -z "$NAME" ]; then
  cat <<EOF
{
  "success": false,
  "error": "Missing required field: name"
}
EOF
  exit 1
fi

# Set defaults for optional fields
if [ -z "$NODES" ] || [ "$NODES" = "null" ]; then
  NODES=$DEFAULT_NODES
fi

if [ -z "$REPLICATION_FACTOR" ] || [ "$REPLICATION_FACTOR" = "null" ]; then
  REPLICATION_FACTOR=$DEFAULT_REPLICATION_FACTOR
fi

echo "[provision.sh] Cluster: $NAME (Org: $ORG_NAME, Project: $PROJECT_NAME)" >&2
echo "[provision.sh] Configuration: $NODES nodes, replication factor $REPLICATION_FACTOR" >&2

# Slugify names and generate ID using helper functions
ORG_SLUG=$(slugify "$ORG_NAME")
PROJECT_SLUG=$(slugify "$PROJECT_NAME")
NAME_SLUG=$(slugify "$NAME")
ID=$(generate_id "$ORG_SLUG" "$PROJECT_SLUG" "$NAME_SLUG")

echo "[provision.sh] Generated ID: $ID" >&2

# Navigate to clusters base directory
cd "$CLUSTERS_BASE"

# Check if cluster already exists
if [ -d "$ID" ]; then
  cat <<EOF
{
  "success": false,
  "error": "Cluster already exists",
  "id": "$ID",
  "message": "A cluster with this name already exists for this organisation and project. Please use a different name or deprovision the existing cluster first."
}
EOF
  exit 1
fi

echo "[provision.sh] Creating cluster directory: $ID" >&2
mkdir -p "$ID"
cd "$ID"

# Create cluster configuration file
cat > cluster.json <<CLUSTER_EOF
{
  "id": "$ID",
  "name": "$NAME",
  "organisation": "$ORG_NAME",
  "project": "$PROJECT_NAME",
  "nodes": $NODES,
  "replicationFactor": $REPLICATION_FACTOR,
  "status": "active",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
CLUSTER_EOF

echo "[provision.sh] Cluster configuration created" >&2

# TODO: Actual IPFS cluster provisioning logic will go here
# For now, this is a placeholder that creates the directory structure

# Create data directory for cluster nodes
mkdir -p data/node-{1..$NODES}

echo "[provision.sh] Cluster provisioned successfully" >&2
echo "[provision.sh] Returning JSON response..." >&2

# Output JSON
cat <<EOF
{
  "success": true,
  "id": "$ID",
  "name": "$NAME",
  "status": "active",
  "nodes": $NODES,
  "replicationFactor": $REPLICATION_FACTOR,
  "message": "IPFS cluster provisioned successfully"
}
EOF
