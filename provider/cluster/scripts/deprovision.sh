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

cd "$CLUSTERS_BASE"

# Check if cluster exists
if [ ! -d "$ID" ]; then
  cat <<EOF
{
  "success": false,
  "error": "Cluster not found",
  "id": "$ID"
}
EOF
  exit 1
fi

kubectl delete -f "$ID/cluster.yaml" >&2 || true

rm -rf "$ID"

cat <<EOF
{
  "success": true,
  "id": "$ID",
  "message": "Cluster deprovisioned successfully"
}
EOF
