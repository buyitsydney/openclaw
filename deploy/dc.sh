#!/bin/bash
# Thin wrapper around `docker compose` that loads docker/server.env for
# compose-level $variable interpolation (env_file: is NOT used for interpolation
# per Compose v2 spec). Runs from any deploy/carher-N/ dir.
#
# Usage:  ./dc.sh up -d    (equivalent of `docker compose up -d`)

set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

exec docker compose \
  --env-file "$ROOT/docker/server.env" \
  --env-file ./.env \
  "$@"
