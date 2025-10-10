#!/bin/bash
set -e

# Load common configuration and helper functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Read input
INPUT=$(cat)
ID=$(echo "$INPUT" | jq -r '.id // empty')

# Validate required fields
if [ -z "$ID" ]; then
  cat <<EOF
{
  "success": false,
  "error": "Missing required field: id"
}
EOF
  exit 1
fi

# Get cluster path
CLUSTER_PATH=$(get_cluster_path "$ID")

# Check if cluster exists
if [ ! -d "$CLUSTER_PATH" ]; then
  cat <<EOF
{
  "success": false,
  "error": "Cluster not found",
  "id": "$ID"
}
EOF
  exit 1
fi

# TODO: Stop K8s cluster (kubectl delete, destroy nodes)
# For now, just remove the directory

# Remove cluster directory
rm -rf "$CLUSTER_PATH"

cat <<EOF
{
  "success": true,
  "id": "$ID",
  "message": "Cluster deprovisioned successfully"
}
EOF
