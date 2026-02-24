#!/bin/bash
# CarHer 用户容器管理
#
# 用法:
#   ./start-user.sh --id=1                    # 启动 user1 容器（默认 Sonnet）
#   ./start-user.sh --id=1 --model=opus       # user1 + Opus 4.6
#   ./start-user.sh --id=1 --random           # user1 + 临时随机隧道（一次性演示用）
#   ./start-user.sh --id=1 --reset             # 重置语音 token（不重启容器）
#   ./start-user.sh --id=1 --down             # 停止 user1
#   ./start-user.sh --down                    # 停止所有用户容器
#   ./start-user.sh --id=1 --logs             # 查看 user1 日志
#   ./start-user.sh --list                    # 列出所有用户
#
# 每个用户 = 一个独立 Docker 容器（--restart unless-stopped，Docker 自动保活）
# 固定隧道由 cloudflared Docker 容器单独管理（见 start-tunnel.sh）
# 你的个人 Her（start.sh）不受任何影响

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 加载服务器本地配置（TUNNEL_HOST_PREFIX 等），gitignored，各服务器独立
[ -f "$SCRIPT_DIR/docker/server.env" ] && source "$SCRIPT_DIR/docker/server.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# 跨平台 SHA-256：Ubuntu 用 sha256sum，macOS 用 shasum -a 256
sha256() { command -v sha256sum &>/dev/null && sha256sum || shasum -a 256; }

# --- Model shortcuts (短名 → 完整路径) ---
# resolve_model <shortname> [provider]
# provider: "anthropic" 或 "openrouter"（默认 openrouter）
resolve_model() {
  local provider="${2:-openrouter}"
  case "$1" in
    sonnet|sonnet-4.6)     [ "$provider" = "anthropic" ] && echo "anthropic/claude-sonnet-4-6" || echo "openrouter/anthropic/claude-sonnet-4.6" ;;
    opus|opus-4.6)         [ "$provider" = "anthropic" ] && echo "anthropic/claude-opus-4-6"   || echo "openrouter/anthropic/claude-opus-4.6" ;;
    haiku|haiku-3.5)       echo "openrouter/anthropic/claude-3.5-haiku" ;;
    gemini-3.1|gemini-3.1-pro) echo "openrouter/google/gemini-3.1-pro-preview" ;;
    gemini-2.5|gemini-pro) echo "openrouter/google/gemini-2.5-pro-preview" ;;
    gemini-flash)          echo "openrouter/google/gemini-2.0-flash-001" ;;
    gpt-4o)                echo "openrouter/openai/gpt-4o" ;;
    gpt-4o-mini)           echo "openrouter/openai/gpt-4o-mini" ;;
    minimax|minimax-m2.5)  echo "openrouter/minimax/minimax-m2.5" ;;
    glm|glm-5)             echo "openrouter/z-ai/glm-5" ;;
    *)                     echo "$1" ;;
  esac
}

# --- Parse arguments ---
USER_ID=""
MODE=""  # 默认不开隧道（隧道由 cloudflared Docker 容器管理）
ACTION="start"
MODEL_ARG=""
HOST_ARG="localhost"  # Webchat URL base host（默认 localhost，企业部署用内网 IP）
NO_REBUILD=""  # 跳过自动重建检查
DEV_MODE=""    # --dev: bind mount 源码，跳过镜像重建（秒级启动）

for arg in "$@"; do
  case "$arg" in
    --id=*) USER_ID="${arg#--id=}" ;;
    --model=*) MODEL_ARG="${arg#--model=}" ;;
    --host=*) HOST_ARG="${arg#--host=}" ;;
    --random) MODE="random" ;;
    --local) ;; # 向后兼容，现在是默认行为
    --reset) ACTION="voice-reset" ;;
    --down) ACTION="down" ;;
    --logs) ACTION="logs" ;;
    --list) ACTION="list" ;;
    --sync-workspace) ACTION="sync-workspace" ;;
    --no-rebuild) NO_REBUILD="yes" ;;
    --dev) DEV_MODE="yes" ;;
    -h|--help)
      echo "用法: ./start-user.sh --id=N [--model=MODEL] [--host=IP] [--down] [--logs]"
      echo ""
      echo "  --id=N        用户编号 (1-999)"
      echo "  --model=MODEL 指定 AI 模型（覆盖 users.csv 中的设置）"
      echo "  --host=IP     Webchat 访问地址（默认 localhost，企业部署用内网 IP）"
      echo "  --random      附加临时随机隧道（一次性演示，关终端就消失）"
      echo "  --reset       重置语音 token（不重启容器，立即生效）"
      echo "  --down        停止容器（不指定 --id 则停止所有）"
      echo "  --logs        查看容器日志"
      echo "  --list        列出所有注册用户和容器状态"
      echo "  --sync-workspace  同步 docker/workspace/ 模板到容器"
      echo "  --no-rebuild  跳过自动镜像重建检查"
      echo "  --dev         Dev 模式: bind mount 源码到容器，跳过镜像重建（秒级启动）"
      echo ""
      echo "固定隧道由 cloudflared Docker 容器管理: ./start-tunnel.sh"
      echo ""
      echo "用户注册表: docker/users.csv（IT 维护，含飞书凭证等）"
      echo ""
      echo "模型快捷名:"
      echo "  sonnet       → claude-sonnet-4.6 (默认)"
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
  echo -e "${CYAN}ID  姓名          模型      Provider    飞书Bot           主人OpenID                              容器状态    备注${NC}"
  echo -e "${CYAN}──  ────          ────      ────────    ───────           ──────────                              ────────    ────${NC}"
  while IFS=',' read -r uid uname umodel ufeishu_id ufeishu_secret ufeishu_owner uprovider unote uowner_allow_from; do
    [[ "$uid" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$uid" ]] && continue
    uid=$(echo "$uid" | xargs)
    uname=$(echo "$uname" | xargs)
    umodel=$(echo "$umodel" | xargs)
    ufeishu_id=$(echo "$ufeishu_id" | xargs)
    ufeishu_owner=$(echo "$ufeishu_owner" | xargs)
    uprovider=$(echo "$uprovider" | xargs)
    unote=$(echo "$unote" | xargs)
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
    printf "%-3s %-12s  %-8s  %-10s  %-18s  %-38s  " "$uid" "$uname" "${umodel:-sonnet}" "${uprovider:-openrouter}" "$FEISHU_DISPLAY" "$OWNER_DISPLAY"
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
  echo "  用法: ./start-user.sh --id=1"
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

# --- Voice token reset (no restart, immediate effect) ---
if [ "$ACTION" = "voice-reset" ]; then
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo -e "${RED}✗ 容器 ${CONTAINER_NAME} 未运行${NC}"
    echo -e "  先启动: ${YELLOW}./start-user.sh --id=${USER_ID}${NC}"
    exit 1
  fi
  NEW_TOKEN=$(docker exec "$CONTAINER_NAME" python3 -c "import uuid; print(uuid.uuid4().hex)")
  docker exec "$CONTAINER_NAME" bash -c "echo '${NEW_TOKEN}' > /data/.openclaw/.voice-token"
  echo ""
  echo -e "${GREEN}✓ Voice token 已重置${NC}"
  echo -e "  容器: ${CONTAINER_NAME}"
  echo -e "  新 Token: ${YELLOW}${NEW_TOKEN}${NC}"
  echo ""
  # Print updated vendor URLs with real token
  TP="${TUNNEL_HOST_PREFIX:-}"
  case "$USER_ID" in
    2) NAMED_PROXY_HOST="${TP}vendor-proxy.carher.net"; NAMED_FE_HOST="${TP}vendor-fe.carher.net" ;;
    *) NAMED_PROXY_HOST="${TP}u${USER_ID}-proxy.carher.net"; NAMED_FE_HOST="${TP}u${USER_ID}-fe.carher.net" ;;
  esac
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  厂商对接信息（直接复制发给厂商）${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  BOOTSTRAP_URL (App 启动时 HTTP GET 调用一次):"
  echo "    https://${NAMED_FE_HOST}/api/realtime/bootstrap?token=${NEW_TOKEN}"
  echo ""
  echo "  PROXY_URL (WS 连接 1 — 音频双向流):"
  echo "    wss://${NAMED_PROXY_HOST}"
  echo ""
  echo "  OPENCLAW_URL (WS 连接 2 — 后台 AI):"
  echo "    wss://${NAMED_FE_HOST}/ws?token=${NEW_TOKEN}"
  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "${YELLOW}旧 token 已立即失效，厂商需更新 App 配置${NC}"
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
if [ -n "$DEV_MODE" ]; then
  # Dev mode: skip full rebuild, just ensure base image exists for node_modules/pip
  if ! docker image inspect carher:local &>/dev/null; then
    echo -e "${YELLOW}  ⟳ Dev 模式: 首次构建基础镜像...${NC}"
    echo ""
    DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher --build-arg BUILD_HASH="dev" -t carher:local .
    echo ""
    echo -e "${GREEN}  ✓ 基础镜像构建完成${NC}"
  fi
  # Ensure dist/ exists on host (compiled core gateway code)
  if [ ! -d "dist" ]; then
    echo -e "${YELLOW}  ⟳ Dev 模式: 编译核心代码 (pnpm build)...${NC}"
    pnpm build
  fi
  echo -e "${GREEN}  ✓ Dev 模式: bind mount 源码，跳过镜像重建${NC}"
else
  CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  SOURCE_DIRS="src/ extensions/ skills/ docker/ scripts/ patches/ ui/ package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json Dockerfile.carher"
  DIFF_OUTPUT=$(git diff HEAD -- $SOURCE_DIRS 2>/dev/null || true)
  if [ -n "$DIFF_OUTPUT" ]; then
    DIRTY_HASH=$(printf '%s' "$DIFF_OUTPUT" | sha256 | cut -d' ' -f1)
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
      DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher --build-arg BUILD_HASH="$CURRENT_BUILD_HASH" -t carher:local .
      echo ""
      echo -e "${GREEN}  ✓ 镜像自动重建完成${NC}"
    fi
  else
    echo -e "${GREEN}  ✓ Docker 镜像已是最新 (${CURRENT_BUILD_HASH:0:16})${NC}"
  fi
fi

# Check cloudflared (only for --random)
if [ "$MODE" = "random" ]; then
  if ! command -v cloudflared &>/dev/null; then
    if [[ "$(uname)" == "Darwin" ]]; then
      echo -e "${RED}✗ 未安装 cloudflared: brew install cloudflared${NC}"
    else
      echo -e "${RED}✗ 未安装 cloudflared: apt install cloudflared 或参考 https://pkg.cloudflare.com${NC}"
    fi
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

# Auto-read ALL env.vars from ~/.openclaw/openclaw.json (single source of truth).
# Propagates every API key (OPENROUTER, GROQ, DEEPGRAM, etc.) to Docker.
ENV_ARGS=()
while IFS='=' read -r key val; do
  [ -n "$key" ] || continue
  ENV_ARGS+=(-e "${key}=${val}")
done < <(python3 -c "
import json, os
try:
    c = json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))
    for k, v in c.get('env', {}).get('vars', {}).items():
        print(f'{k}={v}')
except: pass
" 2>/dev/null)

# Verify OPENROUTER_API_KEY is present (required for AI models).
HAS_OPENROUTER=""
for arg in "${ENV_ARGS[@]}"; do
  case "$arg" in OPENROUTER_API_KEY=*) HAS_OPENROUTER="yes" ;; esac
done
if [ -z "$HAS_OPENROUTER" ]; then
  # Fallback to environment variable
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    ENV_ARGS+=(-e "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}")
    HAS_OPENROUTER="yes"
  fi
fi
if [ -z "$HAS_OPENROUTER" ]; then
  echo -e "${RED}✗ OPENROUTER_API_KEY 未设置（~/.openclaw/openclaw.json env.vars 或环境变量）${NC}"
  exit 1
fi
echo -e "${GREEN}  ✓ API keys (${#ENV_ARGS[@]} env vars from config)${NC}"
echo ""

# --- Read user info from registry (docker/users.csv) ---
CSV_NAME=""
CSV_MODEL=""
CSV_FEISHU_ID=""
CSV_FEISHU_SECRET=""
CSV_FEISHU_OWNER=""
CSV_PROVIDER=""
CSV_NOTE=""
CSV_OWNER_ALLOW_FROM=""

if [ -f "$USERS_CSV" ]; then
  while IFS=',' read -r uid uname umodel ufeishu_id ufeishu_secret ufeishu_owner uprovider unote uowner_allow_from; do
    [[ "$uid" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$uid" ]] && continue
    uid=$(echo "$uid" | xargs)
    if [ "$uid" = "$USER_ID" ]; then
      CSV_NAME=$(echo "$uname" | xargs)
      CSV_MODEL=$(echo "$umodel" | xargs)
      CSV_FEISHU_ID=$(echo "$ufeishu_id" | xargs)
      CSV_FEISHU_SECRET=$(echo "$ufeishu_secret" | xargs)
      CSV_FEISHU_OWNER=$(echo "$ufeishu_owner" | xargs)
      CSV_PROVIDER=$(echo "$uprovider" | xargs)
      CSV_NOTE=$(echo "$unote" | xargs)
      CSV_OWNER_ALLOW_FROM=$(echo "$uowner_allow_from" | xargs)
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

# --- Resolve provider: CSV > default (openrouter) ---
USER_PROVIDER="${CSV_PROVIDER:-openrouter}"

# --- Resolve model: CLI arg > CSV > base config default ---
if [ -n "$MODEL_ARG" ]; then
  MODEL_FULL=$(resolve_model "$MODEL_ARG" "$USER_PROVIDER")
elif [ -n "$CSV_MODEL" ]; then
  MODEL_FULL=$(resolve_model "$CSV_MODEL" "$USER_PROVIDER")
else
  MODEL_FULL=""
fi

# --- Generate per-user config (model + feishu from CSV) ---
# Per-user config uses $include to reference Docker base config (which itself
# $includes shared-config.json5). This ensures all environments share the same
# functional config and only per-user/per-env overrides live here.
CUSTOM_CONFIG="${SCRIPT_DIR}/docker/user-configs/carher-config-${USER_ID}.json"
mkdir -p "${SCRIPT_DIR}/docker/user-configs"

# Always generate a per-user config (may inject feishu credentials)
python3 -c "
import json, sys, os, pathlib

cfg = {
    '\$include': './carher-config.json',
}

# Model override
model = '${MODEL_FULL}'
provider = '${USER_PROVIDER}'
if model:
    agents = {'defaults': {'model': {'primary': model}}}
else:
    agents = {'defaults': {}}

# Per-user model whitelist: both providers available, aliases follow CSV provider
if provider == 'anthropic':
    agents['defaults']['models'] = {
        'anthropic/claude-opus-4-6': {'alias': 'opus'},
        'anthropic/claude-sonnet-4-6': {'alias': 'sonnet'},
        'openrouter/anthropic/claude-opus-4.6': {'alias': 'or-opus'},
        'openrouter/anthropic/claude-sonnet-4.6': {'alias': 'or-sonnet'},
        'openrouter/google/gemini-3.1-pro-preview': {'alias': 'gemini'},
        'openrouter/minimax/minimax-m2.5': {'alias': 'minimax'},
        'openrouter/z-ai/glm-5': {'alias': 'glm'},
    }
else:
    agents['defaults']['models'] = {
        'openrouter/anthropic/claude-opus-4.6': {'alias': 'opus'},
        'openrouter/anthropic/claude-sonnet-4.6': {'alias': 'sonnet'},
        'anthropic/claude-opus-4-6': {'alias': 'or-opus'},
        'anthropic/claude-sonnet-4-6': {'alias': 'or-sonnet'},
        'openrouter/google/gemini-3.1-pro-preview': {'alias': 'gemini'},
        'openrouter/minimax/minimax-m2.5': {'alias': 'minimax'},
        'openrouter/z-ai/glm-5': {'alias': 'glm'},
    }
if agents['defaults']:
    cfg['agents'] = agents

# Gemini config for realtime plugin
# Priority: env var > host openclaw.json (gemini is a sibling key, JSON.parse reads it) > error
gemini_project = os.environ.get('GEMINI_PROJECT_ID', '')
gemini_model = os.environ.get('GEMINI_MODEL', '')
if not gemini_project:
    host_cfg_path = pathlib.Path.home() / '.openclaw' / 'openclaw.json'
    if host_cfg_path.exists():
        with open(host_cfg_path) as hf:
            host_cfg = json.load(hf)
        host_gemini = host_cfg.get('plugins', {}).get('entries', {}).get('realtime', {}).get('config', {}).get('gemini', {})
        gemini_project = host_gemini.get('projectId', '')
        if not gemini_model:
            gemini_model = host_gemini.get('model', '')
if not gemini_model:
    gemini_model = 'gemini-live-2.5-flash-native-audio'
if gemini_project:
    cfg.setdefault('plugins', {}).setdefault('entries', {}).setdefault('realtime', {}).setdefault('config', {})['gemini'] = {
        'projectId': gemini_project, 'model': gemini_model
    }
else:
    print('WARNING: GEMINI_PROJECT_ID not found (env / ~/.openclaw/openclaw.json)', file=sys.stderr)

# Feishu credentials from users.csv
feishu_id = '${CSV_FEISHU_ID}'
feishu_secret = '${CSV_FEISHU_SECRET}'
feishu_owner = '${CSV_FEISHU_OWNER}'
owner_allow_from_raw = '${CSV_OWNER_ALLOW_FROM}'
if feishu_id and feishu_secret:
    feishu_cfg = {
        'enabled': True,
        'appId': feishu_id,
        'appSecret': feishu_secret,
    }
    if feishu_owner:
        feishu_cfg['dm'] = {'allowFrom': [feishu_owner]}
    feishu_cfg['groups'] = {
        'enabled': True,
        'archive': True,
    }
    cfg.setdefault('channels', {})['feishu'] = feishu_cfg

# commands.ownerAllowFrom from CSV (pipe-separated open_ids)
if owner_allow_from_raw:
    owner_ids = [x.strip() for x in owner_allow_from_raw.split('|') if x.strip()]
    if owner_ids:
        cfg.setdefault('commands', {})['ownerAllowFrom'] = owner_ids

json.dump(cfg, sys.stdout, indent=2)
" > "$CUSTOM_CONFIG"

CONFIG_MOUNT="$CUSTOM_CONFIG"

# Display config summary
DISPLAY_MODEL=$(python3 -c "
import json
with open('${CUSTOM_CONFIG}') as f:
    print(json.load(f)['agents']['defaults']['model']['primary'])
" 2>/dev/null || echo "sonnet")
echo -e "${GREEN}  ✓ 模型: ${DISPLAY_MODEL} (provider: ${USER_PROVIDER})${NC}"

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

# --- Resolve domain names (needed for VOICE env vars and URL display) ---
TP="${TUNNEL_HOST_PREFIX:-}"
case "$USER_ID" in
  2) NAMED_RT_HOST="${TP}vendor.carher.net"; NAMED_PROXY_HOST="${TP}vendor-proxy.carher.net"; NAMED_FE_HOST="${TP}vendor-fe.carher.net" ;;
  *) NAMED_RT_HOST="${TP}u${USER_ID}.carher.net"; NAMED_PROXY_HOST="${TP}u${USER_ID}-proxy.carher.net"; NAMED_FE_HOST="${TP}u${USER_ID}-fe.carher.net" ;;
esac

echo -e "${YELLOW}启动容器 ${CONTAINER_NAME}...${NC}"
echo -e "  端口映射: GW=${PORT_GW} FE=${PORT_FE} WS=${PORT_WS} (RT=内部，不暴露)"

# Dev mode: bind mount host source into container; use a named volume for
# node_modules so the container keeps its own Linux-native dependencies
# instead of the host's macOS ones.
DEV_MOUNTS=()
if [ -n "$DEV_MODE" ]; then
  DEV_MOUNTS=(
    -v "$(pwd):/app"
    -v "carher-dev-node-modules:/app/node_modules"
  )
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --init \
  --restart unless-stopped \
  --memory=2g \
  -e HOME=/data \
  "${ENV_ARGS[@]}" \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json \
  ${WEBCHAT_URL:+-e WEBCHAT_URL="$WEBCHAT_URL"} \
  -e VOICE_FE_HOST="${NAMED_FE_HOST}" \
  -e VOICE_PROXY_HOST="${NAMED_PROXY_HOST}" \
  -p "${PORT_GW}:18789" \
  -p "${PORT_FE}:8000" \
  -p "${PORT_WS}:8080" \
  -v "carher-${USER_ID}-data:/data/.openclaw" \
  -v "${GCLOUD_ADC}:/gcloud/application_default_credentials.json:ro" \
  -v "${CONFIG_MOUNT}:/data/.openclaw/openclaw.json:ro" \
  -v "${SCRIPT_DIR}/docker/carher-config.json:/data/.openclaw/carher-config.json:ro" \
  -v "${SCRIPT_DIR}/docker/shared-config.json5:/data/.openclaw/shared-config.json5:ro" \
  "${DEV_MOUNTS[@]}" \
  carher:local

echo -e "${GREEN}  ✓ 容器已启动${NC}"

# Wait for health — three-layer verification:
#   1. Container not in crash-restart loop
#   2. Gateway port responds (not just the frontend proxy)
#   3. Feishu WebSocket connected
echo -e "${YELLOW}等待容器就绪...${NC}"
MAX_WAIT=60
WAITED=0
GW_READY=false
FEISHU_READY=false

while [ $WAITED -lt $MAX_WAIT ]; do
  CONTAINER_STATUS=$(docker inspect --format '{{.State.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
  if [ "$CONTAINER_STATUS" = "restarting" ]; then
    echo -e "${RED}  ✗ 容器在崩溃重启中！最近日志:${NC}"
    docker logs "$CONTAINER_NAME" --tail 20 2>&1
    exit 1
  fi

  if [ "$GW_READY" = "false" ]; then
    if curl -sf "http://localhost:${PORT_GW}/" -o /dev/null 2>/dev/null; then
      GW_READY=true
      echo -e "${GREEN}  ✓ Gateway 就绪 (${WAITED}s)${NC}"
    fi
  fi

  if [ "$GW_READY" = "true" ] && [ "$FEISHU_READY" = "false" ]; then
    if [ -z "$CSV_FEISHU_ID" ]; then
      echo -e "  · 飞书未配置，跳过连接检查"
      break
    fi
    if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "ws client ready"; then
      FEISHU_READY=true
      echo -e "${GREEN}  ✓ 飞书连接就绪 (${WAITED}s)${NC}"
      break
    fi
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

if [ "$GW_READY" = "false" ]; then
  echo -e "${RED}✗ Gateway 启动超时 (${MAX_WAIT}s)${NC}"
  echo -e "${YELLOW}  最近日志:${NC}"
  docker logs "$CONTAINER_NAME" --tail 20 2>&1
  exit 1
fi

if [ "$FEISHU_READY" = "false" ]; then
  echo -e "${YELLOW}⚠ 飞书连接未就绪（Gateway 已启动，飞书可能稍后连接）${NC}"
fi

# Auto-sync workspace templates on startup
sync_workspace "$CONTAINER_NAME"

# --- Ensure device pairing has full operator scopes (idempotent) ---
PAIRING_SCRIPT="${SCRIPT_DIR}/docker/fix-device-pairing.js"
if [ -f "$PAIRING_SCRIPT" ]; then
  docker cp "$PAIRING_SCRIPT" "${CONTAINER_NAME}:/tmp/fix-device-pairing.js" 2>/dev/null
  PAIRING_OUT=$(docker exec "$CONTAINER_NAME" node /tmp/fix-device-pairing.js 2>&1) || true
  echo -e "${GREEN}  ✓ ${PAIRING_OUT:-device pairing OK}${NC}"
fi

# --- Auto-generate voice token if not exists (idempotent; preserves token across restarts) ---
VOICE_TOKEN=$(docker exec "$CONTAINER_NAME" bash -c '
  TOKEN_FILE="/data/.openclaw/.voice-token"
  if [ -f "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
    cat "$TOKEN_FILE"
  else
    mkdir -p "$(dirname "$TOKEN_FILE")"
    python3 -c "import uuid; print(uuid.uuid4().hex)" | tee "$TOKEN_FILE"
  fi
' 2>/dev/null || echo "")

if [ -n "$VOICE_TOKEN" ]; then
  echo -e "${GREEN}  ✓ Voice token 就绪${NC}"
else
  echo -e "${YELLOW}  ⚠ Voice token 生成失败（语音功能需要手动生成）${NC}"
fi

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
echo -e "  WS Proxy:  ${GREEN}ws://localhost:${PORT_WS}${NC}"
if [ -n "$VOICE_TOKEN" ]; then
  echo -e "  Voice:     ${GREEN}http://localhost:${PORT_FE}/mobile.html?proxy=ws://localhost:${PORT_WS}&openclaw=ws://localhost:${PORT_FE}/ws&token=${VOICE_TOKEN}${NC}"
else
  echo -e "  Voice:     ${YELLOW}通过飞书 Bot 输入 /voice 获取带 token 的语音链接${NC}"
fi
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# --- Print fixed remote URLs (based on naming convention) ---
# 域名约定: uN-fe.carher.net / uN-proxy.carher.net
# RT 端口不暴露，语音流量通过 FE 代理；token 由 /voice 命令生成
NAMED_PROXY_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('wss://${NAMED_PROXY_HOST}'))")
NAMED_OPENCLAW_ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('wss://${NAMED_FE_HOST}/ws'))")

echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
TOKEN_DISPLAY="${VOICE_TOKEN:-<TOKEN>}"
echo -e "${CYAN}  User ${USER_ID} — 固定远程 URL（需 cloudflared 隧道）${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "  Mobile:    ${CYAN}https://${NAMED_FE_HOST}/mobile.html?proxy=${NAMED_PROXY_ENCODED}&openclaw=${NAMED_OPENCLAW_ENCODED}&token=${TOKEN_DISPLAY}${NC}"
echo -e "  Desktop:   ${CYAN}https://${NAMED_FE_HOST}?proxy=${NAMED_PROXY_ENCODED}&openclaw=${NAMED_OPENCLAW_ENCODED}&token=${TOKEN_DISPLAY}${NC}"
echo ""
echo -e "  Proxy:     wss://${NAMED_PROXY_HOST}"
echo -e "  RT(内部):  通过 FE 代理访问 (${NAMED_FE_HOST}/ws)"
if [ -z "$VOICE_TOKEN" ]; then
  echo -e "  ${YELLOW}Token 未就绪，通过飞书 /voice 或 --reset 生成${NC}"
fi
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# --- Vendor integration info for fixed tunnels (copy-paste ready) ---
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  厂商对接信息（直接复制发给厂商）${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  BOOTSTRAP_URL (App 启动时 HTTP GET 调用一次):"
echo "    https://${NAMED_FE_HOST}/api/realtime/bootstrap?token=${TOKEN_DISPLAY}"
echo ""
echo "  PROXY_URL (WS 连接 1 — 音频双向流):"
echo "    wss://${NAMED_PROXY_HOST}"
echo ""
echo "  OPENCLAW_URL (WS 连接 2 — 后台 AI):"
echo "    wss://${NAMED_FE_HOST}/ws?token=${TOKEN_DISPLAY}"
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# --- Tunnel status (informational) ---
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^cloudflared$"; then
  echo -e "${GREEN}✓ cloudflared 隧道运行中（Docker 容器）${NC}"
elif pgrep -f "cloudflared tunnel run" &>/dev/null; then
  echo -e "${GREEN}✓ cloudflared 隧道运行中（原生进程）${NC}"
else
  echo -e "${YELLOW}⚠ cloudflared 隧道未运行（远程 URL 不可用）${NC}"
  echo -e "  启动隧道: ${YELLOW}./start-tunnel.sh${NC}"
fi
echo ""

echo -e "${GREEN}✓ User ${USER_ID} 已启动${NC}"
echo ""
echo -e "  停止: ${YELLOW}./start-user.sh --id=${USER_ID} --down${NC}"
echo -e "  日志: ${YELLOW}./start-user.sh --id=${USER_ID} --logs${NC}"

# --- If no tunnel mode, we're done ---
if [ "$MODE" != "random" ]; then
  exit 0
fi

# --- Start Cloudflare random tunnels ---
echo -e "${YELLOW}启动 Cloudflare 随机隧道...${NC}"
echo ""

cleanup() {
  echo ""
  echo -e "${YELLOW}关闭隧道...${NC}"
  kill -9 $PID_FE $PID_WS 2>/dev/null || true
  wait $PID_FE $PID_WS 2>/dev/null || true
  rm -f "$TMP_FE" "$TMP_WS" 2>/dev/null
  echo -e "${GREEN}隧道已关闭。容器 ${CONTAINER_NAME} 保持运行。${NC}"
  echo -e "  停止容器: ${YELLOW}./start-user.sh --id=${USER_ID} --down${NC}"
}
trap cleanup EXIT INT TERM

TMP_FE=$(mktemp)
TMP_WS=$(mktemp)

# 2 tunnels: FE (static + RT proxy) + WS (Gemini proxy). RT 通过 FE 代理，不单独暴露。
cloudflared tunnel --url http://localhost:${PORT_FE} --protocol http2 --config /dev/null 2>"$TMP_FE" &
PID_FE=$!

cloudflared tunnel --url http://localhost:${PORT_WS} --protocol http2 --config /dev/null 2>"$TMP_WS" &
PID_WS=$!

# Wait for tunnel URLs
echo "等待隧道建立..."
MAX_WAIT=30
WAITED=0
URL_FE=""
URL_WS=""

while [ $WAITED -lt $MAX_WAIT ]; do
  [ -z "$URL_FE" ] && URL_FE=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_FE" 2>/dev/null | head -1)
  [ -z "$URL_WS" ] && URL_WS=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_WS" 2>/dev/null | head -1)

  if [ -n "$URL_FE" ] && [ -n "$URL_WS" ]; then
    break
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

if [ -z "$URL_FE" ] || [ -z "$URL_WS" ]; then
  echo -e "${RED}✗ 隧道建立超时！${NC}"
  [ -z "$URL_FE" ] && echo "  - Frontend 隧道失败"
  [ -z "$URL_WS" ] && echo "  - WS Proxy 隧道失败"
  exit 1
fi

# Build one-click URLs (RT goes through FE proxy; token auto-generated at startup)
WSS_PROXY=$(echo "$URL_WS" | sed 's|^https://|wss://|')
WSS_FE=$(echo "$URL_FE" | sed 's|^https://|wss://|')
QUERY="proxy=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_PROXY}'))")&openclaw=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_FE}/ws'))")"
MOBILE_URL="${URL_FE}/mobile.html?${QUERY}&token=${TOKEN_DISPLAY}"
DESKTOP_URL="${URL_FE}?${QUERY}&token=${TOKEN_DISPLAY}"

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
echo "    Frontend:  $URL_FE (含 RT 代理)"
echo "    WS Proxy:  $URL_WS"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# --- Vendor integration info (copy-paste ready) ---
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  厂商对接信息（直接复制发给厂商）${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  BOOTSTRAP_URL (App 启动时 HTTP GET 调用一次):"
echo "    ${URL_FE}/api/realtime/bootstrap?token=${TOKEN_DISPLAY}"
echo ""
echo "  PROXY_URL (WS 连接 1 — 音频双向流):"
echo "    $WSS_PROXY"
echo ""
echo "  OPENCLAW_URL (WS 连接 2 — 后台 AI):"
echo "    ${WSS_FE}/ws?token=${TOKEN_DISPLAY}"
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "${YELLOW}按 Ctrl+C 关闭隧道（容器 ${CONTAINER_NAME} 保持运行）${NC}"
echo ""

# Keep running until Ctrl+C
wait
