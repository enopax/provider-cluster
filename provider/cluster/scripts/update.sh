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

# Read current configuration
if [ ! -f "$CLUSTER_PATH/cluster.json" ]; then
  cat <<EOF
{
  "success": false,
  "error": "Cluster configuration not found",
  "id": "$ID"
}
EOF
  exit 1
fi

CURRENT_CONFIG=$(cat "$CLUSTER_PATH/cluster.json")

# Parse update fields (optional)
NEW_WORKER_NODES=$(echo "$INPUT" | jq -r '.workerNodes // empty')

# Update configuration if new values provided
if [ -n "$NEW_WORKER_NODES" ] && [ "$NEW_WORKER_NODES" != "null" ]; then
  CURRENT_CONFIG=$(echo "$CURRENT_CONFIG" | jq ".workerNodes = $NEW_WORKER_NODES")
fi

# Update timestamp
CURRENT_CONFIG=$(echo "$CURRENT_CONFIG" | jq ".updatedAt = \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"")

# Save updated configuration
echo "$CURRENT_CONFIG" > "$CLUSTER_PATH/cluster.json"

# TODO: Apply actual K8s cluster configuration updates (scale nodes)
# For now, just update the JSON file

cat <<EOF
{
  "success": true,
  "id": "$ID",
  "message": "Cluster configuration updated successfully",
  $(echo "$CURRENT_CONFIG" | jq -r '. | to_entries | .[] | "\"\(.key)\": \(.value | tojson)"' | paste -sd ',' -)
}
EOF
