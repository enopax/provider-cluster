#!/bin/bash
set -e

# Load common configuration and helper functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "[provision.sh] Starting K8s cluster provisioning..." >&2

# Read all input (multiline JSON)
INPUT=$(cat)

echo "[provision.sh] Received input, parsing fields..." >&2

# Parse input from flat structure
NAME=$(echo "$INPUT" | jq -r '.name // empty')
ORG_NAME=$(echo "$INPUT" | jq -r '.organisationName // "default"')
PROJECT_NAME=$(echo "$INPUT" | jq -r '.projectName // "default"')

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

echo "[provision.sh] Cluster: $NAME (Org: $ORG_NAME, Project: $PROJECT_NAME)" >&2

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

# Create kubeconfig

echo "# Kubeconfig will be generated here" > kubeconfig.yaml

echo "[provision.sh] Cluster provisioned successfully" >&2
echo "[provision.sh] Returning JSON response..." >&2

# Output JSON
cat <<EOF
{
  "success": true,
  "id": "$ID",
  "name": "$NAME",
  "status": "active",
  "workerNodes": $WORKER_NODES,
  "k8sVersion": "$K8S_VERSION",
  "message": "Kubernetes cluster provisioned successfully"
}
EOF
