#!/bin/bash
# CarHer 用户容器管理 — 启动独立容器 + Cloudflare 隧道
#
# 用法:
#   ./start-user.sh --id=1                    # user1 + 随机隧道（默认 Sonnet）
#   ./start-user.sh --id=1 --model=opus       # user1 + Opus 4.6
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

for arg in "$@"; do
  case "$arg" in
    --id=*) USER_ID="${arg#--id=}" ;;
    --model=*) MODEL_ARG="${arg#--model=}" ;;
    --random) MODE="random" ;;
    --local) MODE="local" ;;
    --down) ACTION="down" ;;
    --logs) ACTION="logs" ;;
    -h|--help)
      echo "用法: ./start-user.sh --id=N [--model=MODEL] [--local] [--down] [--logs]"
      echo ""
      echo "  --id=N        用户编号 (1-99)"
      echo "  --model=MODEL 指定 AI 模型（默认: sonnet）"
      echo "  --local       仅本地访问（不开隧道）"
      echo "  --down        停止容器（不指定 --id 则停止所有）"
      echo "  --logs        查看容器日志"
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

if ! [[ "$USER_ID" =~ ^[0-9]+$ ]] || [ "$USER_ID" -lt 1 ] || [ "$USER_ID" -gt 99 ]; then
  echo -e "${RED}✗ 用户 ID 必须是 1-99 的数字${NC}"
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

# Check Docker image
if ! docker image inspect carher:local &>/dev/null; then
  echo -e "${RED}✗ 镜像 carher:local 不存在${NC}"
  echo -e "${YELLOW}  请先构建: ./start-docker.sh${NC}"
  exit 1
fi
echo -e "${GREEN}  ✓ Docker 镜像就绪${NC}"

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

# --- Resolve model and prepare config ---
if [ -n "$MODEL_ARG" ]; then
  MODEL_FULL=$(resolve_model "$MODEL_ARG")
else
  MODEL_FULL=""  # 使用 docker/carher-config.json 中的默认值
fi

# Generate per-user config (with custom model if specified)
CONFIG_FILE="${SCRIPT_DIR}/docker/carher-config.json"
CUSTOM_CONFIG=""
if [ -n "$MODEL_FULL" ]; then
  # 持久化路径（容器运行期间可能重读 config，不能用 mktemp 后删除）
  CUSTOM_CONFIG="/tmp/carher-config-${USER_ID}.json"
  python3 -c "
import json, sys
with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)
cfg['agents']['defaults']['model']['primary'] = '${MODEL_FULL}'
json.dump(cfg, sys.stdout, indent=2)
" > "$CUSTOM_CONFIG"
  CONFIG_MOUNT="$CUSTOM_CONFIG"
  echo -e "${GREEN}  ✓ 模型: ${MODEL_FULL}${NC}"
else
  CONFIG_MOUNT="$CONFIG_FILE"
  # 读取默认模型名用于显示
  DEFAULT_MODEL=$(python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    print(json.load(f)['agents']['defaults']['model']['primary'])
" 2>/dev/null || echo "sonnet")
  echo -e "${GREEN}  ✓ 模型: ${DEFAULT_MODEL} (默认)${NC}"
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

echo ""

# --- Print local URLs ---
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  User ${USER_ID} — 本地 URL${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
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
echo -e "${YELLOW}按 Ctrl+C 关闭隧道（容器 ${CONTAINER_NAME} 保持运行）${NC}"
echo ""

# Keep running until Ctrl+C
wait
