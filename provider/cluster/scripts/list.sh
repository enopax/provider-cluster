#!/bin/bash
set -e

# Load common configuration and helper functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Read input
INPUT=$(cat)
ORG_NAME=$(echo "$INPUT" | jq -r '.organisationName // empty')
PROJECT_NAME=$(echo "$INPUT" | jq -r '.projectName // empty')

# Validate required fields
if [ -z "$ORG_NAME" ] || [ -z "$PROJECT_NAME" ]; then
  cat <<EOF
{
  "success": false,
  "error": "Missing required fields: organisationName and projectName"
}
EOF
  exit 1
fi

# Slugify names
ORG_SLUG=$(slugify "$ORG_NAME")
PROJECT_SLUG=$(slugify "$PROJECT_NAME")

# Build list of clusters for this org/project
CLUSTERS_JSON="[]"

# Find all cluster directories matching the pattern
for cluster_dir in "$CLUSTERS_BASE"/${ORG_SLUG}-${PROJECT_SLUG}-*; do
  if [ -d "$cluster_dir" ] && [ -f "$cluster_dir/cluster.json" ]; then
    CLUSTER_DATA=$(cat "$cluster_dir/cluster.json")
    CLUSTERS_JSON=$(echo "$CLUSTERS_JSON" | jq ". += [$CLUSTER_DATA]")
  fi
done

# Output JSON
cat <<EOF
{
  "success": true,
  "organisationName": "$ORG_NAME",
  "projectName": "$PROJECT_NAME",
  "clusters": $CLUSTERS_JSON
}
EOF
