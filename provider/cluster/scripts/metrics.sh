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

# TODO: Gather actual cluster metrics
# For now, return placeholder metrics

# Calculate uptime (time since creation)
if [ -f "$CLUSTER_PATH/cluster.json" ]; then
  CREATED_AT=$(cat "$CLUSTER_PATH/cluster.json" | jq -r '.createdAt')
  CREATED_TS=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$CREATED_AT" "+%s" 2>/dev/null || echo "0")
  NOW_TS=$(date "+%s")
  UPTIME=$((NOW_TS - CREATED_TS))
else
  UPTIME=0
fi

# Get directory size as total storage
TOTAL_SIZE=$(du -sk "$CLUSTER_PATH" 2>/dev/null | cut -f1 || echo "0")

cat <<EOF
{
  "success": true,
  "id": "$ID",
  "metrics": {
    "uptime": $UPTIME,
    "totalNodes": 0,
    "readyNodes": 0,
    "pods": 0,
    "cpuUsagePercent": 0,
    "memoryUsagePercent": 0
  }
}
EOF
