#!/bin/bash
# Admin container post-start bootstrap
#
# Use case: EVERY TIME admin container is rebuilt,
#           run this script to reinstall the non-image-baked admin layers.
#
# What it installs:
#   1. sshpass + openssh-client (container writable layer; lost on docker rm)
#   2. docker/servers.txt → /data/.openclaw/servers.txt (container volume; persistent)
#   3. admin-only fleet-ops skills → /home/cltx/.openclaw/skills/ (host shared layer)
#
# Usage:
#   ./bootstrap-admin.sh              # default: carher-198
#   ./bootstrap-admin.sh carher-XXX   # override container name
#
# Prerequisite:
#   - docker compose has already brought the admin container up
#   - docker/servers.txt exists at repo root docker/ dir (gitignored, host-local)

set -e

CONTAINER="${1:-carher-198}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}▶ bootstrap admin: $CONTAINER${NC}"

# Sanity: container must be running
if ! docker ps --format '{{.Names}}' | grep -q "^$CONTAINER$"; then
  echo -e "${RED}✗ container $CONTAINER not running — docker compose up -d first${NC}"
  exit 1
fi

# 1. sshpass + ssh client (writable layer — will be lost on docker rm, re-run this script each rebuild)
echo "  [1/3] install sshpass + openssh-client …"
docker exec -u root "$CONTAINER" sh -c 'apt-get update -qq 2>&1 | tail -1; apt-get install -y sshpass openssh-client 2>&1 | tail -1'
docker exec "$CONTAINER" sh -c 'command -v sshpass && command -v ssh' >/dev/null && \
  echo -e "    ${GREEN}✓ sshpass + ssh installed${NC}" || { echo -e "    ${RED}✗ install failed${NC}"; exit 1; }

# 2. servers.txt → volume (persists across restart AND rebuild; docker cp once after volume exists)
echo "  [2/3] deploy servers.txt to volume (persistent) …"
if [ ! -f "$SCRIPT_DIR/docker/servers.txt" ]; then
  echo -e "    ${RED}✗ docker/servers.txt missing (expected at $SCRIPT_DIR/docker/servers.txt)${NC}"
  exit 1
fi
docker cp "$SCRIPT_DIR/docker/servers.txt" "$CONTAINER:/data/.openclaw/servers.txt"
docker exec -u root "$CONTAINER" chown node:node /data/.openclaw/servers.txt 2>/dev/null || true
docker exec "$CONTAINER" test -s /data/.openclaw/servers.txt && \
  echo -e "    ${GREEN}✓ servers.txt deployed${NC}" || { echo -e "    ${RED}✗ servers.txt missing post-cp${NC}"; exit 1; }

# 3. admin fleet-ops skills → host shared layer
#    (/home/cltx/.openclaw/skills/ ↔ container /data/.openclaw/skills/ via bind mount)
#    Non-admin her containers see these skills too, but lack sshpass+servers.txt so they can't actually use them
echo "  [3/3] deploy admin fleet-ops skills …"
HOST_SKILL_DIR="/home/cltx/.openclaw/skills"
mkdir -p "$HOST_SKILL_DIR"

ADMIN_SKILLS=(
  docker-fleet
  carher-ops
  carher-a2a-topology
  carher-shared-skills
  cloudflare-tunnel
  openclaw-gateway
  openclaw-logs
)

DEPLOYED=0
MISSING=0
for s in "${ADMIN_SKILLS[@]}"; do
  SRC="$SCRIPT_DIR/.cursor/skills/$s/SKILL.md"
  DEST="$HOST_SKILL_DIR/$s/SKILL.md"
  if [ -f "$SRC" ]; then
    mkdir -p "$HOST_SKILL_DIR/$s"
    cp "$SRC" "$DEST"
    DEPLOYED=$((DEPLOYED + 1))
  else
    echo -e "    ${YELLOW}SKIP: $s (source $SRC missing)${NC}"
    MISSING=$((MISSING + 1))
  fi
done
echo -e "    ${GREEN}✓ $DEPLOYED skills deployed${NC} ($MISSING missing)"

# 4. CPU limit (fleet 标准: admin 和主 her 都 10 cores; docker update 立即生效不重启)
echo "  [4/4] set cpus=10 (fleet 标准) …"
docker update --cpus=10 "$CONTAINER" > /dev/null
CPU_NANO=$(docker inspect "$CONTAINER" --format '{{.HostConfig.NanoCpus}}')
if [ "$CPU_NANO" = "10000000000" ]; then
  echo -e "    ${GREEN}✓ cpus=10${NC}"
else
  echo -e "    ${YELLOW}⚠ cpus=$CPU_NANO (expected 10000000000)${NC}"
fi

echo
echo -e "${GREEN}✓ admin bootstrap complete for $CONTAINER${NC}"
echo
echo "  Verify:"
echo "    docker exec $CONTAINER which sshpass ssh"
echo "    docker exec $CONTAINER ls /data/.openclaw/servers.txt"
echo "    docker exec $CONTAINER ls /data/.openclaw/skills/docker-fleet/"
echo "    docker inspect $CONTAINER --format 'CPU={{.HostConfig.NanoCpus}} Mem={{.HostConfig.Memory}}'"
echo
echo "  Admin should /new a new session for skill to pick up."
