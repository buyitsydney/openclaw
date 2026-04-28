#!/bin/bash
# Migrate carher-101 from start-user.sh to docker compose.
# Idempotent: safe to rerun. Volumes preserved.
#
# Usage:  ./migrate-carher-101.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "${YELLOW}▶${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# 1. Preconditions
command -v docker >/dev/null || err "docker not found"
docker info >/dev/null 2>&1 || err "docker daemon not running"

# 2. Ensure shared network + volumes exist (start-user.sh creates them; we reuse)
step "Ensuring carher-net network exists"
docker network inspect carher-net >/dev/null 2>&1 || docker network create carher-net
ok "carher-net OK"

step "Ensuring volumes exist (preserving any existing data)"
for vol in carher-101-home carher-101-data carher-redis-data; do
  docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create "$vol"
done
ok "volumes OK"

# 3. Shared redis — reuse existing (created by start-user.sh) or start via compose
step "Checking shared redis"
if docker inspect carher-redis >/dev/null 2>&1; then
  if [ "$(docker inspect --format '{{.State.Status}}' carher-redis)" = "running" ]; then
    ok "redis already running (preserving)"
  else
    docker start carher-redis
    ok "redis started (existing container)"
  fi
else
  cd "$SCRIPT_DIR/common"
  docker compose -f redis.yaml up -d
  ok "redis up (new)"
fi

# 4. Stop & remove any previous carher-101 (volumes preserved)
step "Stopping existing carher-101 (if any)"
docker rm -f carher-101 2>/dev/null || true
ok "clean slate"

# 5. Bring up via compose
step "Bringing up carher-101 via compose"
cd "$SCRIPT_DIR/carher-101"
docker compose up -d
ok "compose up -d issued"

# 6. Wait for health
step "Waiting for gateway ready (up to 90s)"
for i in $(seq 1 90); do
  STATUS=$(docker inspect --format '{{.State.Health.Status}}' carher-101 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ]; then
    ok "carher-101 healthy after ${i}s"
    break
  fi
  if [ "$STATUS" = "unhealthy" ]; then
    err "carher-101 unhealthy — see: docker compose logs"
  fi
  sleep 1
done

# 7. Summary
echo
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  carher-101 migrated to compose.${NC}"
echo
echo -e "  Image:    $(docker inspect --format '{{.Config.Image}}' carher-101)"
echo -e "  Status:   $(docker inspect --format '{{.State.Status}} ({{.State.Health.Status}})' carher-101)"
echo -e "  Gateway:  http://localhost:30001"
echo -e "  Logs:     docker compose -f deploy/carher-101/compose.yaml logs -f"
echo -e "  Upgrade:  edit deploy/carher-101/.env IMAGE_TAG → docker compose up -d"
echo -e "  Rollback: revert IMAGE_TAG → docker compose up -d"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
