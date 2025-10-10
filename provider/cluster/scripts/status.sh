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

# Read cluster configuration
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

# Read and output cluster configuration
CLUSTER_CONFIG=$(cat "$CLUSTER_PATH/cluster.json")

# TODO: Check actual cluster health status
# For now, return the stored configuration

cat <<EOF
{
  "success": true,
  $(echo "$CLUSTER_CONFIG" | jq -r '. | to_entries | .[] | "\"\(.key)\": \(.value | tojson)"' | paste -sd ',' -)
}
EOF
