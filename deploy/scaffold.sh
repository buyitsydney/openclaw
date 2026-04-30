#!/bin/bash
# Scaffold deploy/carher-<N>/ from common/compose.template.yaml + users.csv.
#
# Usage:
#   ./scaffold.sh 102              # generates deploy/carher-102/ from CSV row 102
#   ./scaffold.sh 102 103 104      # multiple at once
#   ./scaffold.sh --all-testers    # generates 101..104 (Mac local testers)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CSV="$ROOT/docker/users.csv"
TEMPLATE="$SCRIPT_DIR/common/compose.template.yaml"

[ -f "$CSV" ] || { echo "users.csv not found at $CSV"; exit 1; }
[ -f "$TEMPLATE" ] || { echo "template not found at $TEMPLATE"; exit 1; }

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

IDS=()
if [ "${1:-}" = "--all-testers" ]; then
  IDS=(101 102 103 104)
else
  IDS=("$@")
fi

[ ${#IDS[@]} -eq 0 ] && { echo "usage: $0 <id> [<id>...]  |  --all-testers"; exit 1; }

for ID in "${IDS[@]}"; do
  ROW=$(awk -F, -v id="$ID" '$1==id {print}' "$CSV" | head -1)
  [ -z "$ROW" ] && { echo -e "${RED}✗${NC} no CSV row for id=$ID"; continue; }

  # CSV columns: id,name,model,appId,appSecret,ownerOpenId,provider,note,ownerAllowFrom,botOpenId
  IFS=',' read -r C_ID C_NAME C_MODEL C_APPID C_SECRET C_OWNER C_PROVIDER _ <<<"$ROW"

  # Port base (matches start-user.sh)
  BASE=$((29000 + (ID - 1) * 10))
  PORT_GW=$((BASE + 1)); PORT_FE=$((BASE + 3)); PORT_WS=$((BASE + 4))
  PORT_OAUTH=$((BASE + 5)); PORT_A2A=$((BASE + 6))

  USER_DIR="$SCRIPT_DIR/carher-${ID}"
  mkdir -p "$USER_DIR"

  # Render compose.yaml from template
  sed \
    -e "s/{{USER_ID}}/${ID}/g" \
    -e "s/{{PORT_GW}}/${PORT_GW}/g" \
    -e "s/{{PORT_FE}}/${PORT_FE}/g" \
    -e "s/{{PORT_WS}}/${PORT_WS}/g" \
    -e "s/{{PORT_OAUTH}}/${PORT_OAUTH}/g" \
    -e "s/{{PORT_A2A}}/${PORT_A2A}/g" \
    "$TEMPLATE" > "$USER_DIR/compose.yaml"

  # Mirror compose \${VAR} substitution sources from docker/server.env
  # (compose resolves \${VAR} at parse time from shell-env / --env-file / project-.env,
  # NOT from env_file directives — see compose spec. So we bake the needed vars here.)
  SERVER_ENV="$ROOT/docker/server.env"
  ANTHROPIC_AUTH_TOKEN_VAL=""
  ANTHROPIC_BASE_URL_VAL=""
  CARHER_LAN_IP_VAL="127.0.0.1"
  if [ -f "$SERVER_ENV" ]; then
    ANTHROPIC_AUTH_TOKEN_VAL=$(awk -F= "/^ANTHROPIC_AUTH_TOKEN=/{print substr(\$0, index(\$0, \"=\") + 1)}" "$SERVER_ENV")
    ANTHROPIC_BASE_URL_VAL=$(awk -F= "/^ANTHROPIC_BASE_URL=/{print substr(\$0, index(\$0, \"=\") + 1)}" "$SERVER_ENV")
    lan_ip=$(awk -F= "/^CARHER_LAN_IP=/{print substr(\$0, index(\$0, \"=\") + 1)}" "$SERVER_ENV")
    [ -n "$lan_ip" ] && CARHER_LAN_IP_VAL="$lan_ip"
  fi

  # Write .env only if absent (don't clobber user's chosen IMAGE_TAG)
  if [ ! -f "$USER_DIR/.env" ]; then
    cat > "$USER_DIR/.env" <<EOF
# carher-${ID} (${C_NAME}) — edit IMAGE_TAG to upgrade/rollback.

IMAGE_TAG=carher-core:phase2-config-free-101
MEMORY_LIMIT=16g
CARHER_GATEWAY_TOKEN=carher-container-token

# Compose \${VAR} substitution sources (mirrored from docker/server.env).
# These are needed because compose env_file directives are NOT consulted
# during \${VAR} expansion — only shell env / --env-file / this project .env.
# Without these, ANTHROPIC_API_KEY ends up blank and CARHER_LAN_IP stays
# loopback, breaking anthropic calls and cross-container A2A respectively.
ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN_VAL}
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL_VAL}
CARHER_LAN_IP=${CARHER_LAN_IP_VAL}
EOF
  fi

  # Write secrets.env only if absent
  if [ ! -f "$USER_DIR/secrets.env" ]; then
    cat > "$USER_DIR/secrets.env" <<EOF
# carher-${ID} (${C_NAME}) secrets — gitignored
FEISHU_APP_SECRET=${C_SECRET}
CARHER_GATEWAY_TOKEN=carher-container-token
EOF
  fi

  echo -e "${GREEN}✓${NC} carher-${ID} (${C_NAME}) → $USER_DIR (ports ${PORT_GW}/${PORT_FE}/${PORT_WS}/${PORT_OAUTH}/${PORT_A2A})"
done

echo
echo -e "${YELLOW}Next:${NC} bring each up with:"
for ID in "${IDS[@]}"; do
  echo "  cd deploy/carher-${ID} && docker compose up -d"
done
