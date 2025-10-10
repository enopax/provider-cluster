#!/bin/bash

# Common configuration for Cluster Provider

# Get the directory of this script
COMMON_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Shared configuration
CLUSTERS_BASE="$(cd "$COMMON_SCRIPT_DIR" && cd ../../ && pwd)/data/clusters"
DEFAULT_WORKER_NODES=3
DEFAULT_K8S_VERSION="1.28"

mkdir -p "$CLUSTERS_BASE"

# Slugify function: convert names to URL-safe identifiers
slugify() {
  echo "$1" | \
    sed 'y/äöüßÄÖÜ/aousAOU/' | \
    tr '[:upper:]' '[:lower:]' | \
    sed 's/[^a-z0-9]/_/g' | \
    sed 's/__*/_/g' | \
    sed 's/^_//; s/_$//'
}

# Parse ID components (ID format: orgslug-projectslug-clusterslug OR orgslug-projectslug-clusterslug-randomstring)
get_org_from_id() {
  local id=$1
  IFS='-' read -ra parts <<< "$id"
  [ ${#parts[@]} -ge 3 ] && echo "${parts[0]}"
}

get_project_from_id() {
  local id=$1
  IFS='-' read -ra parts <<< "$id"
  [ ${#parts[@]} -ge 3 ] && echo "${parts[1]}"
}

get_name_from_id() {
  local id=$1
  IFS='-' read -ra parts <<< "$id"
  [ ${#parts[@]} -ge 3 ] && echo "${parts[2]}"
}

# Generate unique ID
generate_id() {
  local org_slug=$1
  local project_slug=$2
  local name_slug=$3
  echo "${org_slug}-${project_slug}-${name_slug}"
}

# Construct cluster path
get_cluster_path() {
  local id=$1
  echo "$CLUSTERS_BASE/$id"
}
