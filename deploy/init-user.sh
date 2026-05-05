#!/bin/bash
# Post-start initialization for a carher-N container (idempotent).
#
# First-boot steps after `docker compose up -d`:
#   1. Apply device-pairing operator scopes (so /voice, /gateway work)
#   2. Generate voice token (preserved in volume across restarts)
#
# Usage:  ./init-user.sh <container-name>
# Safe to rerun at any time (skips work already done).

set -euo pipefail

CONTAINER="${1:?usage: ./init-user.sh <container-name>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "${YELLOW}▶${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo -e "${RED}✗${NC} container not found: $CONTAINER"
  exit 1
fi

if [ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)" != "healthy" ]; then
  warn "$CONTAINER not yet healthy — waiting up to 60s…"
  for i in $(seq 1 60); do
    s=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "")
    [ "$s" = "healthy" ] && { ok "healthy"; break; }
    sleep 1
  done
fi

# 1. Device-pairing scope fix (idempotent — fix-device-pairing.js writes only if needed)
step "Apply device-pairing operator scopes"
# Look in deploy/, then in docker/ (source repo copy)
PAIRING_SRC=""
for cand in "$SCRIPT_DIR/fix-device-pairing.js" "$SCRIPT_DIR/../docker/fix-device-pairing.js"; do
  [ -f "$cand" ] && PAIRING_SRC="$cand" && break
done

if [ -n "$PAIRING_SRC" ]; then
  docker cp "$PAIRING_SRC" "$CONTAINER:/tmp/fix-device-pairing.js" 2>/dev/null
  OUT=$(docker exec "$CONTAINER" node /tmp/fix-device-pairing.js 2>&1 || true)
  ok "${OUT:-device pairing OK}"
else
  warn "fix-device-pairing.js not found — skipped"
fi

# 2. Voice token (generate once, preserve in volume)
step "Ensure voice token exists"
TOKEN=$(docker exec "$CONTAINER" bash -c '
  T="/data/.openclaw/.voice-token"
  if [ -s "$T" ]; then cat "$T"; else
    mkdir -p "$(dirname "$T")"
    python3 -c "import uuid; print(uuid.uuid4().hex)" | tee "$T"
  fi' 2>/dev/null || echo "")

if [ -n "$TOKEN" ]; then
  ok "voice token: ${TOKEN:0:8}… (${#TOKEN} chars)"
else
  warn "voice token generation failed (voice-call features may be unavailable)"
fi

echo -e "${GREEN}done.${NC}"
