#!/bin/bash
# CarHer 用户容器管理 — 启动独立容器 + Cloudflare 隧道
#
# 用法:
#   ./start-user.sh --id=1                    # user1 + 随机隧道（默认 Sonnet）
#   ./start-user.sh --id=1 --model=opus       # user1 + Opus 4.6
#   ./start-user.sh --id=1 --named            # user1 + 命名隧道（固定 URL，永不变化）
#   ./start-user.sh --id=1 --local            # user1 仅本地（不开隧道）
#   ./start-user.sh --id=1 --down             # 停止 user1
#   ./start-user.sh --down                    # 停止所有用户容器
#   ./start-user.sh --id=1 --logs             # 查看 user1 日志
#
# 每个用户 = 一个独立 Docker 容器 = 完全隔离的文件系统
# 你的个人 Her（start.sh）不受任何影响

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Model shortcuts (短名 → 完整 OpenRouter 路径) ---
resolve_model() {
  case "$1" in
    sonnet|sonnet-4)       echo "openrouter/anthropic/claude-sonnet-4" ;;
    sonnet-4.5)            echo "openrouter/anthropic/claude-sonnet-4.5" ;;
    opus|opus-4.6)         echo "openrouter/anthropic/claude-opus-4.6" ;;
    haiku|haiku-3.5)       echo "openrouter/anthropic/claude-3.5-haiku" ;;
    gemini-2.5|gemini-pro) echo "openrouter/google/gemini-2.5-pro-preview" ;;
    gemini-flash)          echo "openrouter/google/gemini-2.0-flash-001" ;;
    gpt-4o)                echo "openrouter/openai/gpt-4o" ;;
    gpt-4o-mini)           echo "openrouter/openai/gpt-4o-mini" ;;
    *)                     echo "$1" ;;  # 完整路径直接使用
  esac
}

# --- Parse arguments ---
USER_ID=""
MODE="random"  # 默认开启远程隧道（厂商用户一定是远程访问）
ACTION="start"
MODEL_ARG=""
HOST_ARG="localhost"  # Webchat URL base host（默认 localhost，企业部署用内网 IP）
NO_REBUILD=""  # 跳过自动重建检查

for arg in "$@"; do
  case "$arg" in
    --id=*) USER_ID="${arg#--id=}" ;;
    --model=*) MODEL_ARG="${arg#--model=}" ;;
    --host=*) HOST_ARG="${arg#--host=}" ;;
    --random) MODE="random" ;;
    --named) MODE="named" ;;
    --local) MODE="local" ;;
    --down) ACTION="down" ;;
    --logs) ACTION="logs" ;;
    --list) ACTION="list" ;;
    --sync-workspace) ACTION="sync-workspace" ;;
    --no-rebuild) NO_REBUILD="yes" ;;
    -h|--help)
      echo "用法: ./start-user.sh --id=N [--model=MODEL] [--host=IP] [--local] [--down] [--logs]"
      echo ""
      echo "  --id=N        用户编号 (1-999)"
      echo "  --model=MODEL 指定 AI 模型（覆盖 users.csv 中的设置）"
      echo "  --host=IP     Webchat 访问地址（默认 localhost，企业部署用内网 IP）"
      echo "  --named       使用命名隧道（固定 URL，永不变化）"
      echo "  --local       仅本地访问（不开隧道）"
      echo "  --down        停止容器（不指定 --id 则停止所有）"
      echo "  --logs        查看容器日志"
      echo "  --list        列出所有注册用户和容器状态"
      echo "  --sync-workspace  同步 docker/workspace/ 模板到容器"
      echo "  --no-rebuild  跳过自动镜像重建检查"
      echo ""
      echo "用户注册表: docker/users.csv（IT 维护，含飞书凭证等）"
      echo ""
      echo "模型快捷名:"
      echo "  sonnet       → claude-sonnet-4 (默认)"
      echo "  sonnet-4.5   → claude-sonnet-4.5 (同价，更强)"
      echo "  opus         → claude-opus-4.6 (最强，贵)"
      echo "  haiku        → claude-3.5-haiku (最省)"
      echo "  gemini-2.5   → gemini-2.5-pro-preview"
      echo "  gemini-flash → gemini-2.0-flash"
      echo "  gpt-4o       → gpt-4o"
      echo "  gpt-4o-mini  → gpt-4o-mini"
      echo "  或直接传完整 OpenRouter 路径"
      exit 0
      ;;
    *) echo "未知参数: $arg (使用 --help 查看帮助)"; exit 1 ;;
  esac
done

# --- Users registry (docker/users.csv) ---
USERS_CSV="${SCRIPT_DIR}/docker/users.csv"

# List all registered users and their container status
if [ "$ACTION" = "list" ]; then
  if [ ! -f "$USERS_CSV" ]; then
    echo -e "${RED}✗ 用户注册表不存在: docker/users.csv${NC}"
    exit 1
  fi
  echo ""
  echo -e "${CYAN}ID  姓名          模型      飞书Bot           主人OpenID                              容器状态    备注${NC}"
  echo -e "${CYAN}──  ────          ────      ───────           ──────────                              ────────    ────${NC}"
  while IFS=',' read -r uid uname umodel ufeishu_id ufeishu_secret ufeishu_owner unote; do
    # Skip comments and empty lines
    [[ "$uid" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$uid" ]] && continue
    uid=$(echo "$uid" | xargs)
    uname=$(echo "$uname" | xargs)
    umodel=$(echo "$umodel" | xargs)
    ufeishu_id=$(echo "$ufeishu_id" | xargs)
    ufeishu_owner=$(echo "$ufeishu_owner" | xargs)
    unote=$(echo "$unote" | xargs)
    # Check container status
    CNAME="carher-${uid}"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CNAME}$"; then
      STATUS="${GREEN}运行中${NC}"
    elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${CNAME}$"; then
      STATUS="${YELLOW}已停止${NC}"
    else
      STATUS="未创建"
    fi
    FEISHU_DISPLAY="${ufeishu_id:-—}"
    OWNER_DISPLAY="${ufeishu_owner:-—}"
    printf "%-3s %-12s  %-8s  %-18s  %-38s  " "$uid" "$uname" "${umodel:-sonnet}" "$FEISHU_DISPLAY" "$OWNER_DISPLAY"
    echo -e "$STATUS    $unote"
  done < "$USERS_CSV"
  echo ""
  exit 0
fi

# --- Stop all containers ---
if [ "$ACTION" = "down" ] && [ -z "$USER_ID" ]; then
  echo -e "${YELLOW}停止所有 CarHer 用户容器...${NC}"
  CONTAINERS=$(docker ps -a --filter "name=carher-" --format '{{.Names}}' 2>/dev/null || true)
  if [ -n "$CONTAINERS" ]; then
    echo "$CONTAINERS" | xargs docker rm -f
    echo -e "${GREEN}✓ 已停止: $(echo $CONTAINERS | tr '\n' ' ')${NC}"
  else
    echo "没有运行中的 CarHer 容器"
  fi
  exit 0
fi

# --- Validate user ID ---
if [ -z "$USER_ID" ]; then
  echo -e "${RED}✗ 必须指定用户 ID: --id=N${NC}"
  echo "  用法: ./start-user.sh --id=1 --random"
  echo "  帮助: ./start-user.sh --help"
  exit 1
fi

if ! [[ "$USER_ID" =~ ^[0-9]+$ ]] || [ "$USER_ID" -lt 1 ] || [ "$USER_ID" -gt 999 ]; then
  echo -e "${RED}✗ 用户 ID 必须是 1-999 的数字${NC}"
  exit 1
fi

CONTAINER_NAME="carher-${USER_ID}"

# --- Port calculation: base = 29000 + (N-1)*10 ---
BASE=$((29000 + (USER_ID - 1) * 10))
PORT_GW=$((BASE + 1))    # Gateway
PORT_RT=$((BASE + 2))    # Realtime WebSocket
PORT_FE=$((BASE + 3))    # Frontend HTTP
PORT_WS=$((BASE + 4))    # Frontend WS Proxy

# --- Logs ---
if [ "$ACTION" = "logs" ]; then
  exec docker logs -f "$CONTAINER_NAME" 2>&1
fi

# --- Sync workspace templates into running container ---
sync_workspace() {
  local cname="$1"
  local ws_dir="${SCRIPT_DIR}/docker/workspace"
  if [ ! -d "$ws_dir" ]; then
    echo -e "${YELLOW}  · docker/workspace/ 不存在，跳过 workspace 同步${NC}"
    return
  fi
  local count=0
  for f in "$ws_dir"/*.md; do
    [ -f "$f" ] || continue
    local fname=$(basename "$f")
    docker cp "$f" "${cname}:/data/.openclaw/workspace/${fname}"
    count=$((count + 1))
  done
  if [ $count -gt 0 ]; then
    echo -e "${GREEN}  ✓ workspace 模板已同步 (${count} 个文件)${NC}"
  fi
}

if [ "$ACTION" = "sync-workspace" ]; then
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${RED}✗ 容器 ${CONTAINER_NAME} 未运行${NC}"
    exit 1
  fi
  echo -e "${YELLOW}同步 workspace 到 ${CONTAINER_NAME}...${NC}"
  sync_workspace "$CONTAINER_NAME"
  exit 0
fi

# --- Stop single container ---
if [ "$ACTION" = "down" ]; then
  echo -e "${YELLOW}停止 ${CONTAINER_NAME}...${NC}"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null && echo -e "${GREEN}✓ 已停止${NC}" || echo "容器未运行"
  exit 0
fi

# --- Start container + tunnel ---
echo ""
echo -e "${YELLOW}🚗 CarHer User ${USER_ID} — 启动${NC}"
echo ""

# --- Auto-rebuild: compare build hash (git SHA + dirty diff hash) with image label ---
CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
SOURCE_DIRS="src/ extensions/ skills/ package.json pnpm-lock.yaml Dockerfile.carher scripts/carher-entrypoint.sh ui/"
DIFF_OUTPUT=$(git diff HEAD -- $SOURCE_DIRS 2>/dev/null || true)
if [ -n "$DIFF_OUTPUT" ]; then
  DIRTY_HASH=$(printf '%s' "$DIFF_OUTPUT" | shasum -a 256 | cut -d' ' -f1)
  CURRENT_BUILD_HASH="${CURRENT_SHA}-dirty-${DIRTY_HASH:0:16}"
else
  CURRENT_BUILD_HASH="$CURRENT_SHA"
fi

IMAGE_BUILD_HASH=$(docker inspect carher:local --format '{{index .Config.Labels "carher.build.hash"}}' 2>/dev/null || echo "none")

NEED_REBUILD=""
if ! docker image inspect carher:local &>/dev/null; then
  NEED_REBUILD="镜像不存在"
elif [ "$IMAGE_BUILD_HASH" = "none" ] || [ "$IMAGE_BUILD_HASH" = "unknown" ] || [ "$IMAGE_BUILD_HASH" = "" ]; then
  NEED_REBUILD="镜像无版本标记（旧版构建）"
elif [ "$CURRENT_BUILD_HASH" != "$IMAGE_BUILD_HASH" ]; then
  NEED_REBUILD="源码已变更 (镜像: ${IMAGE_BUILD_HASH:0:16}, 当前: ${CURRENT_BUILD_HASH:0:16})"
fi

if [ -n "$NEED_REBUILD" ]; then
  if [ -n "$NO_REBUILD" ]; then
    echo -e "${YELLOW}  ⚠ 镜像需要重建 (${NEED_REBUILD})，但 --no-rebuild 已跳过${NC}"
  else
    echo -e "${YELLOW}  ⟳ 自动重建镜像: ${NEED_REBUILD}${NC}"
    echo ""
    docker build -f Dockerfile.carher --build-arg BUILD_HASH="$CURRENT_BUILD_HASH" -t carher:local .
    echo ""
    echo -e "${GREEN}  ✓ 镜像自动重建完成${NC}"
  fi
else
  echo -e "${GREEN}  ✓ Docker 镜像已是最新 (${CURRENT_BUILD_HASH:0:16})${NC}"
fi

# Check cloudflared (unless --local)
if [ "$MODE" != "local" ]; then
  if ! command -v cloudflared &>/dev/null; then
    echo -e "${RED}✗ 未安装 cloudflared: brew install cloudflared${NC}"
    exit 1
  fi
  echo -e "${GREEN}  ✓ cloudflared 就绪${NC}"
fi

# Check Google Cloud credentials (for Gemini Live proxy)
GCLOUD_ADC="$HOME/.config/gcloud/application_default_credentials.json"
if [ ! -f "$GCLOUD_ADC" ]; then
  echo -e "${RED}✗ Google Cloud 凭证未找到: $GCLOUD_ADC${NC}"
  echo -e "${YELLOW}  运行: gcloud auth application-default login${NC}"
  exit 1
fi
echo -e "${GREEN}  ✓ Google Cloud 凭证${NC}"

# Check OpenRouter API key
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  # Try to read from local openclaw config
  OPENROUTER_API_KEY=$(python3 -c "
import json, os
try:
    c = json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))
    print(c.get('env', {}).get('vars', {}).get('OPENROUTER_API_KEY', ''))
except: pass
" 2>/dev/null || true)
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo -e "${RED}✗ OPENROUTER_API_KEY 未设置${NC}"
  echo -e "${YELLOW}  export OPENROUTER_API_KEY=sk-or-...${NC}"
  exit 1
fi
echo -e "${GREEN}  ✓ OpenRouter API key${NC}"
echo ""

# --- Read user info from registry (docker/users.csv) ---
CSV_NAME=""
CSV_MODEL=""
CSV_FEISHU_ID=""
CSV_FEISHU_SECRET=""
CSV_FEISHU_OWNER=""
CSV_NOTE=""

if [ -f "$USERS_CSV" ]; then
  while IFS=',' read -r uid uname umodel ufeishu_id ufeishu_secret ufeishu_owner unote; do
    [[ "$uid" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$uid" ]] && continue
    uid=$(echo "$uid" | xargs)
    if [ "$uid" = "$USER_ID" ]; then
      CSV_NAME=$(echo "$uname" | xargs)
      CSV_MODEL=$(echo "$umodel" | xargs)
      CSV_FEISHU_ID=$(echo "$ufeishu_id" | xargs)
      CSV_FEISHU_SECRET=$(echo "$ufeishu_secret" | xargs)
      CSV_FEISHU_OWNER=$(echo "$ufeishu_owner" | xargs)
      CSV_NOTE=$(echo "$unote" | xargs)
      break
    fi
  done < "$USERS_CSV"
  if [ -n "$CSV_NAME" ]; then
    echo -e "${GREEN}  ✓ 用户: ${CSV_NAME} (id=${USER_ID})${NC}"
  else
    echo -e "${YELLOW}  ⚠ 用户 ${USER_ID} 未在 docker/users.csv 中注册，使用默认配置${NC}"
  fi
else
  echo -e "${YELLOW}  ⚠ docker/users.csv 不存在，使用默认配置${NC}"
fi

# --- Resolve model: CLI arg > CSV > base config default ---
if [ -n "$MODEL_ARG" ]; then
  MODEL_FULL=$(resolve_model "$MODEL_ARG")
elif [ -n "$CSV_MODEL" ]; then
  MODEL_FULL=$(resolve_model "$CSV_MODEL")
else
  MODEL_FULL=""  # 使用 docker/carher-config.json 中的默认值
fi

# --- Generate per-user config (model + feishu from CSV) ---
CONFIG_FILE="${SCRIPT_DIR}/docker/carher-config.json"
CUSTOM_CONFIG="/tmp/carher-config-${USER_ID}.json"

# Always generate a per-user config (may inject feishu credentials)
python3 -c "
import json, sys

with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)

# Model override
model = '${MODEL_FULL}'
if model:
    cfg['agents']['defaults']['model']['primary'] = model

# Feishu credentials from users.csv
feishu_id = '${CSV_FEISHU_ID}'
feishu_secret = '${CSV_FEISHU_SECRET}'
feishu_owner = '${CSV_FEISHU_OWNER}'
if feishu_id and feishu_secret:
    # Build feishu channel config
    feishu_cfg = {
        'enabled': True,
        'appId': feishu_id,
        'appSecret': feishu_secret,
    }
    # Owner identification (dm allowlist + group owner)
    if feishu_owner:
        feishu_cfg['dm'] = {'allowFrom': [feishu_owner]}
    # Group chat: archive + owner-only reply (enabled by default when owner is set)
    feishu_cfg['groups'] = {
        'enabled': True,
        'archive': True,
    }
    cfg.setdefault('channels', {})['feishu'] = feishu_cfg
    # Enable feishu plugin
    cfg.setdefault('plugins', {}).setdefault('entries', {})['feishu'] = {
        'enabled': True
    }

json.dump(cfg, sys.stdout, indent=2)
" > "$CUSTOM_CONFIG"

CONFIG_MOUNT="$CUSTOM_CONFIG"

# Display config summary
DISPLAY_MODEL=$(python3 -c "
import json
with open('${CUSTOM_CONFIG}') as f:
    print(json.load(f)['agents']['defaults']['model']['primary'])
" 2>/dev/null || echo "sonnet")
echo -e "${GREEN}  ✓ 模型: ${DISPLAY_MODEL}${NC}"

if [ -n "$CSV_FEISHU_ID" ] && [ -n "$CSV_FEISHU_SECRET" ]; then
  echo -e "${GREEN}  ✓ 飞书: ${CSV_FEISHU_ID}${NC}"
else
  echo -e "  · 飞书: 未配置"
fi

# --- Compute webchat URL from token + port (before docker run) ---
AUTH_TOKEN=$(python3 -c "
import json
with open('${CUSTOM_CONFIG}') as f:
    print(json.load(f).get('gateway', {}).get('auth', {}).get('token', ''))
" 2>/dev/null || true)
WEBCHAT_URL=""
if [ -n "$AUTH_TOKEN" ]; then
  WEBCHAT_URL="http://${HOST_ARG}:${PORT_GW}?token=${AUTH_TOKEN}"
fi

# --- Always clean start: stop old container if exists ---
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo -e "${YELLOW}  ⟳ 清理旧容器 ${CONTAINER_NAME}...${NC}"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
fi

echo -e "${YELLOW}启动容器 ${CONTAINER_NAME}...${NC}"
echo -e "  端口映射: GW=${PORT_GW} RT=${PORT_RT} FE=${PORT_FE} WS=${PORT_WS}"
docker run -d \
  --name "$CONTAINER_NAME" \
  --init \
  -e HOME=/data \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json \
  ${WEBCHAT_URL:+-e WEBCHAT_URL="$WEBCHAT_URL"} \
  -p "${PORT_GW}:18789" \
  -p "${PORT_RT}:18790" \
  -p "${PORT_FE}:8000" \
  -p "${PORT_WS}:8080" \
  -v "carher-${USER_ID}-data:/data/.openclaw" \
  -v "${GCLOUD_ADC}:/gcloud/application_default_credentials.json:ro" \
  -v "${CONFIG_MOUNT}:/data/.openclaw/openclaw.json:ro" \
  carher:local

echo -e "${GREEN}  ✓ 容器已启动${NC}"

# Wait for health
echo -e "${YELLOW}等待容器就绪...${NC}"
MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -sf "http://localhost:${PORT_FE}/" -o /dev/null 2>/dev/null; then
    echo -e "${GREEN}  ✓ 容器就绪 (${WAITED}s)${NC}"
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done
if [ $WAITED -ge $MAX_WAIT ]; then
  echo -e "${RED}⚠ 容器启动超时 (${MAX_WAIT}s)${NC}"
  echo -e "${YELLOW}  查看日志: ./start-user.sh --id=${USER_ID} --logs${NC}"
  exit 1
fi

# Auto-sync workspace templates on startup
sync_workspace "$CONTAINER_NAME"

echo ""

# --- Print local URLs ---
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  User ${USER_ID} — 本地 URL${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
if [ -n "$WEBCHAT_URL" ]; then
  echo -e "  Webchat:   ${GREEN}${WEBCHAT_URL}${NC}"
fi
echo -e "  Mobile UI: ${GREEN}http://localhost:${PORT_FE}/mobile.html${NC}"
echo -e "  Desktop:   ${GREEN}http://localhost:${PORT_FE}${NC}"
echo -e "  Gateway:   ${GREEN}http://localhost:${PORT_GW}${NC}"
echo -e "  Realtime:  ${GREEN}ws://localhost:${PORT_RT}/ws${NC}"
echo -e "  WS Proxy:  ${GREEN}ws://localhost:${PORT_WS}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# --- If --local, done ---
if [ "$MODE" = "local" ]; then
  echo -e "${GREEN}✓ User ${USER_ID} 已启动（仅本地访问）${NC}"
  echo ""
  echo -e "  去掉 ${YELLOW}--local${NC} 即可开启远程隧道"
  echo -e "  停止: ${YELLOW}./start-user.sh --id=${USER_ID} --down${NC}"
  echo -e "  日志: ${YELLOW}./start-user.sh --id=${USER_ID} --logs${NC}"
  exit 0
fi

# --- Named tunnel mode (固定域名，永不变化) ---
if [ "$MODE" = "named" ]; then
  # 检查命名隧道配置
  if [ ! -f "$HOME/.cloudflared/config.yml" ]; then
    echo -e "${RED}✗ 未找到命名隧道配置 (~/.cloudflared/config.yml)${NC}"
    echo "  请先运行: cloudflared tunnel login && cloudflared tunnel create carher"
    exit 1
  fi

  # 用户 id → 固定域名映射（在 ~/.cloudflared/config.yml 中配置对应 ingress 规则）
  # 默认约定: u{id}.carher.net (Realtime/Bootstrap) + u{id}-proxy.carher.net (WS Proxy) + u{id}-fe.carher.net (Frontend)
  # 特殊别名: id=2 → vendor.carher.net / vendor-proxy.carher.net / vendor-fe.carher.net
  case "$USER_ID" in
    2) NAMED_RT_HOST="vendor.carher.net"; NAMED_PROXY_HOST="vendor-proxy.carher.net"; NAMED_FE_HOST="vendor-fe.carher.net" ;;
    *) NAMED_RT_HOST="u${USER_ID}.carher.net"; NAMED_PROXY_HOST="u${USER_ID}-proxy.carher.net"; NAMED_FE_HOST="u${USER_ID}-fe.carher.net" ;;
  esac

  NAMED_BOOTSTRAP_URL="https://${NAMED_RT_HOST}/api/realtime/bootstrap"
  NAMED_PROXY_URL="wss://${NAMED_PROXY_HOST}"
  NAMED_OPENCLAW_URL="wss://${NAMED_RT_HOST}/ws"
  NAMED_PROXY_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${NAMED_PROXY_URL}'))")
  NAMED_OPENCLAW_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${NAMED_OPENCLAW_URL}'))")
  NAMED_MOBILE_URL="https://${NAMED_FE_HOST}/mobile.html?proxy=${NAMED_PROXY_ENCODED}&openclaw=${NAMED_OPENCLAW_ENCODED}"
  NAMED_DESKTOP_URL="https://${NAMED_FE_HOST}?proxy=${NAMED_PROXY_ENCODED}&openclaw=${NAMED_OPENCLAW_ENCODED}"

  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  🚗 User ${USER_ID} — 固定 URL（命名隧道，永不变化）${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${CYAN}📱 手机测试（固定 URL，直接打开）：${NC}"
  echo ""
  echo "  $NAMED_MOBILE_URL"
  echo ""
  echo -e "  ${CYAN}🖥  桌面测试：${NC}"
  echo ""
  echo "  $NAMED_DESKTOP_URL"
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  厂商对接信息（直接复制发给厂商）${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  BOOTSTRAP_URL (App 启动时 HTTP GET 调用一次):"
  echo "    $NAMED_BOOTSTRAP_URL"
  echo ""
  echo "  PROXY_URL (WS 连接 1 — 音频双向流):"
  echo "    $NAMED_PROXY_URL"
  echo ""
  echo "  OPENCLAW_URL (WS 连接 2 — 后台 AI):"
  echo "    $NAMED_OPENCLAW_URL"
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  隧道域名映射:"
  echo "    ${NAMED_FE_HOST}     → localhost:${PORT_FE} (Frontend)"
  echo "    ${NAMED_RT_HOST}        → localhost:${PORT_RT} (Realtime/Bootstrap)"
  echo "    ${NAMED_PROXY_HOST}  → localhost:${PORT_WS} (WS Proxy)"
  echo ""

  # 检查命名隧道是否已在运行
  if pgrep -f "cloudflared tunnel run" &>/dev/null; then
    echo -e "${GREEN}✓ 命名隧道已在运行中${NC}"
    echo ""
    echo -e "  停止容器: ${YELLOW}./start-user.sh --id=${USER_ID} --down${NC}"
    echo -e "  查看日志: ${YELLOW}./start-user.sh --id=${USER_ID} --logs${NC}"
    exit 0
  fi

  # 启动命名隧道（前台，Ctrl+C 停止）
  echo -e "${YELLOW}启动命名隧道 (carher)...${NC}"
  echo -e "${YELLOW}按 Ctrl+C 关闭隧道（容器 ${CONTAINER_NAME} 保持运行）${NC}"
  echo ""
  exec cloudflared tunnel run carher
fi

# --- Start Cloudflare random tunnels ---
echo -e "${YELLOW}启动 Cloudflare 随机隧道...${NC}"
echo ""

cleanup() {
  echo ""
  echo -e "${YELLOW}关闭隧道...${NC}"
  kill -9 $PID_FE $PID_WS $PID_RT 2>/dev/null || true
  wait $PID_FE $PID_WS $PID_RT 2>/dev/null || true
  rm -f "$TMP_FE" "$TMP_WS" "$TMP_RT" 2>/dev/null
  echo -e "${GREEN}隧道已关闭。容器 ${CONTAINER_NAME} 保持运行。${NC}"
  echo -e "  停止容器: ${YELLOW}./start-user.sh --id=${USER_ID} --down${NC}"
}
trap cleanup EXIT INT TERM

TMP_FE=$(mktemp)
TMP_WS=$(mktemp)
TMP_RT=$(mktemp)

# 3 independent tunnels → container's mapped ports on host
cloudflared tunnel --url http://localhost:${PORT_FE} --protocol http2 --config /dev/null 2>"$TMP_FE" &
PID_FE=$!

cloudflared tunnel --url http://localhost:${PORT_WS} --protocol http2 --config /dev/null 2>"$TMP_WS" &
PID_WS=$!

cloudflared tunnel --url http://localhost:${PORT_RT} --protocol http2 --config /dev/null 2>"$TMP_RT" &
PID_RT=$!

# Wait for all 3 tunnel URLs
echo "等待隧道建立..."
MAX_WAIT=30
WAITED=0
URL_FE=""
URL_WS=""
URL_RT=""

while [ $WAITED -lt $MAX_WAIT ]; do
  [ -z "$URL_FE" ] && URL_FE=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_FE" 2>/dev/null | head -1)
  [ -z "$URL_WS" ] && URL_WS=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_WS" 2>/dev/null | head -1)
  [ -z "$URL_RT" ] && URL_RT=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_RT" 2>/dev/null | head -1)

  if [ -n "$URL_FE" ] && [ -n "$URL_WS" ] && [ -n "$URL_RT" ]; then
    break
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

if [ -z "$URL_FE" ] || [ -z "$URL_WS" ] || [ -z "$URL_RT" ]; then
  echo -e "${RED}✗ 隧道建立超时！${NC}"
  [ -z "$URL_FE" ] && echo "  - Frontend 隧道失败"
  [ -z "$URL_WS" ] && echo "  - WS Proxy 隧道失败"
  [ -z "$URL_RT" ] && echo "  - Realtime 隧道失败"
  exit 1
fi

# Build one-click URLs with query params
WSS_PROXY=$(echo "$URL_WS" | sed 's|^https://|wss://|')
WSS_RT=$(echo "$URL_RT" | sed 's|^https://|wss://|')
QUERY="proxy=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_PROXY}'))")&openclaw=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_RT}/ws'))")"
MOBILE_URL="${URL_FE}/mobile.html?${QUERY}"
DESKTOP_URL="${URL_FE}?${QUERY}"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🚗 User ${USER_ID} — 远程 URL（随机隧道）${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}📱 手机/车机版（推荐）：${NC}"
echo ""
echo "  $MOBILE_URL"
echo ""
echo -e "  ${CYAN}🖥  桌面版：${NC}"
echo ""
echo "  $DESKTOP_URL"
echo ""
echo -e "  ${CYAN}隧道详情：${NC}"
echo "    Frontend:  $URL_FE"
echo "    WS Proxy:  $URL_WS"
echo "    Realtime:  $URL_RT"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# --- Vendor integration info (copy-paste ready) ---
BOOTSTRAP_URL="${URL_RT}/api/realtime/bootstrap"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  厂商对接信息（直接复制发给厂商）${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  BOOTSTRAP_URL (App 启动时 HTTP GET 调用一次):"
echo "    $BOOTSTRAP_URL"
echo ""
echo "  PROXY_URL (WS 连接 1 — 音频双向流):"
echo "    $WSS_PROXY"
echo ""
echo "  OPENCLAW_URL (WS 连接 2 — 后台 AI):"
echo "    ${WSS_RT}/ws"
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "${YELLOW}按 Ctrl+C 关闭隧道（容器 ${CONTAINER_NAME} 保持运行）${NC}"
echo ""

# Keep running until Ctrl+C
wait
