#!/bin/bash
# CarHer Gateway 启动脚本
# 确定性重编译 + 启动 Gateway（建议永远只通过此脚本启动）
#
# 自动 tmux 持久化：脚本自动在 tmux 会话 "her" 中运行，
# Cursor/终端重启后进程不会丢失。重复执行会自动替换旧会话。

set -e

# 确保在仓库根目录执行（脚本所在目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 加载服务器本地配置（ANTHROPIC_AUTH_TOKEN / OPENROUTER_API_KEY / TUNNEL_HOST_PREFIX / CARHER_AUTH_HOST 等）
# gitignored，各服务器独立。与 compose .env 用法对齐。
# set -a 保证变量导出到子进程（node gateway / tmux 内的 shell）。
if [ -f "$SCRIPT_DIR/docker/server.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/docker/server.env"
  set +a
fi

# --- 自动 tmux 包裹：不在 tmux 内时，自动进入 tmux 会话 "her" ---
if [ -z "$TMUX" ] && command -v tmux &>/dev/null; then
  tmux kill-session -t her 2>/dev/null || true
  exec tmux new-session -s her "$0 $*"
fi

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

GATEWAY_PORT=18789
REALTIME_PORT=18790
LIVE_UI_PORT=8000
LIVE_PROXY_PORT=8080
GATEWAY_STOP_TIMEOUT_SEC=20
# loopback 适合 Mac（只给本机 UI/tunnel 用）；lan 给服务器 host-native admin her
# 暴露给跨机 A2A（carher-14/75 → yitian-her）。通过 docker/server.env 注入。
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"

listener_pids() {
  local port="$1"
  if command -v ss &>/dev/null; then
    ss -tlnp "( sport = :${port} )" 2>/dev/null | awk -F'pid=' 'NF > 1 {split($2, parts, ","); print parts[1]}' | sort -u
  else
    lsof -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u || true
  fi
}

wait_for_port_free() {
  local port="$1"
  local timeout_sec="$2"
  local started_at
  started_at=$(date +%s)
  while [ $(( $(date +%s) - started_at )) -lt "$timeout_sec" ]; do
    if [ -z "$(listener_pids "$port")" ]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

echo -e "${YELLOW}🚀 CarHer Gateway 启动脚本${NC}"
echo ""

# Sync config/ tree into ~/.openclaw/ (macOS bind-mount equivalent for the
# flat-layout that openclaw's include-resolver requires — cross-dir symlinks
# hit the realpath security check in src/config/includes.ts).
# Source-of-truth stays in the repo's config/ directory; ~/.openclaw/*.json5
# are derived copies overwritten on every start.
#
# We convert JSON5 → JSON on copy so the downstream python3 sync step
# (knownBots/oauthRedirectUri) can use the stdlib json module. openclaw's
# own include-resolver uses JSON5.parse, which accepts plain JSON, so the
# .json5 file extension stays correct for \$include lookup.
mkdir -p "$HOME/.openclaw"
node -e "
const JSON5 = require('$SCRIPT_DIR/node_modules/json5');
const fs = require('fs');
for (const f of ['admin.json5', 'base.json5', 'host-mac.json5']) {
  const parsed = JSON5.parse(fs.readFileSync('$SCRIPT_DIR/config/' + f, 'utf-8'));
  fs.writeFileSync('$HOME/.openclaw/' + f, JSON.stringify(parsed, null, 2) + '\n');
}
"
# openclaw defaults to reading ~/.openclaw/openclaw.json. Point it at the
# freshly-copied admin.json5 via a same-directory symlink (passes rootRealDir
# check because target's realpath stays inside ~/.openclaw/).
ln -sfn "./admin.json5" "$HOME/.openclaw/openclaw.json"
echo -e "${GREEN}  ✓ config/{admin,base,host-mac}.json5 → ~/.openclaw/ (openclaw.json -> admin.json5)${NC}"

# 把本地 Her 的 Feishu 名称与多 bot 注册表显式同步进运行时配置。
export CARHER_HOST_FEISHU_NAME="${CARHER_HOST_FEISHU_NAME:-her}"
python3 - "$SCRIPT_DIR" <<'PY'
import csv
import json
import os
import pathlib
import sys

script_dir = pathlib.Path(sys.argv[1])
config_path = pathlib.Path.home() / ".openclaw" / "openclaw.json"
if not config_path.exists():
    raise SystemExit(0)

cfg = json.loads(config_path.read_text(encoding="utf-8"))
channels = cfg.get("channels")
if not isinstance(channels, dict):
    raise SystemExit(0)
feishu = channels.get("feishu")
if not isinstance(feishu, dict):
    raise SystemExit(0)

host_app_id = str(feishu.get("appId") or "").strip()
host_app_secret = str(feishu.get("appSecret") or "").strip()
if not host_app_id or not host_app_secret:
    raise SystemExit(0)

configured_name = str(feishu.get("name") or "").strip()
host_name = os.environ.get("CARHER_HOST_FEISHU_NAME", "").strip() or configured_name
if host_name:
    feishu["name"] = host_name

known = {}
known_bot_open_ids = {}
host_bot_open_id = str(feishu.get("botOpenId") or "").strip()
users_csv = script_dir / "docker" / "users.csv"
if users_csv.exists():
    with users_csv.open(newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if not row:
                continue
            uid = row[0].strip() if len(row) > 0 else ""
            if not uid or uid.startswith("#"):
                continue
            label = row[1].strip() if len(row) > 1 else ""
            app_id = row[3].strip() if len(row) > 3 else ""
            bot_open_id = row[9].strip() if len(row) > 9 else ""
            if label and app_id:
                known[app_id] = label
            if app_id and bot_open_id:
                known_bot_open_ids[bot_open_id] = app_id
            if host_app_id and app_id == host_app_id and bot_open_id and not host_bot_open_id:
                host_bot_open_id = bot_open_id

if host_app_id and host_name:
    known[host_app_id] = host_name
if known:
    feishu["knownBots"] = known
if known_bot_open_ids:
    feishu["knownBotOpenIds"] = known_bot_open_ids
if host_app_id and host_bot_open_id:
    feishu["botOpenId"] = host_bot_open_id

# OAuth redirect URI — feishu-her resolveOAuthRedirectUri() reads this.
# 不显式写会回落到硬编码 auth.carher.net/feishu/oauth/callback；
# 在非本地 Mac 的原生部署（例如 S1 yitian-her → s1-u13-auth.carher.net）
# 必须通过 CARHER_AUTH_HOST env 覆盖，否则飞书 OAuth 回调会 20029/404。
auth_host = os.environ.get("CARHER_AUTH_HOST", "auth.carher.net").strip()
if auth_host:
    feishu["oauthRedirectUri"] = f"https://{auth_host}/feishu/oauth/callback"

config_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
echo -e "${GREEN}  ✓ Feishu bot identity 已同步（host=${CARHER_HOST_FEISHU_NAME}）${NC}"

# 当 ACP 开启时，确保 ~/.claude/settings.json 有 ACP 非交互模式所需的 sandbox/permissions。
# 否则 (1) claude 要权限 prompt，但 ACP 无 TTY → AcpRuntimeError: Permission prompt unavailable；
# (2) 无 sandbox.enabled:false 时 claude harness 拒绝写 $SCRIPT_DIR 等目录。
# 与 Docker entrypoint 的 CARHER_ACP_ENABLED=1 分支等价。详见 docs/her/acp-claude-code-setup.md。
python3 - <<'PY'
import json
import pathlib

oc_path = pathlib.Path.home() / ".openclaw" / "openclaw.json"
claude_settings = pathlib.Path.home() / ".claude" / "settings.json"

if not oc_path.exists():
    raise SystemExit(0)
cfg = json.loads(oc_path.read_text(encoding="utf-8"))

# Gate: ACP 开启时才同步。兼容两个 key：
#   - plugins.entries.acpx.enabled  (S1 runtime 当前事实)
#   - acp.enabled                   (新版 start.sh 注入的顶层 key)
plugins_entries = (cfg.get("plugins") or {}).get("entries", {}) or {}
acpx = plugins_entries.get("acpx") or {}
acp_top = cfg.get("acp") or {}
if not (acpx.get("enabled") or acp_top.get("enabled")):
    raise SystemExit(0)

settings = {}
if claude_settings.exists():
    try:
        settings = json.loads(claude_settings.read_text(encoding="utf-8"))
    except Exception:
        settings = {}

sandbox = settings.setdefault("sandbox", {})
if sandbox.get("enabled") is not False:
    sandbox["enabled"] = False

perms = settings.setdefault("permissions", {})
perms.setdefault("defaultMode", "acceptEdits")
required_allow = ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
                  "Glob(*)", "Grep(*)", "WebSearch(*)", "WebFetch(*)"]
existing = perms.get("allow") or []
merged = list(dict.fromkeys([*existing, *required_allow]))
if merged != existing:
    perms["allow"] = merged

claude_settings.parent.mkdir(parents=True, exist_ok=True)
claude_settings.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
echo -e "${GREEN}  ✓ Claude ACP settings 已同步 (sandbox=false, permissions.allow)${NC}"

# 基于完整工作区快照决定是否需要重新编译（包含 tracked + untracked 文件）
WORKSPACE_BUILD_HASH=$(node scripts/workspace-build-hash.mjs)
BUILD_CACHE_DIR="$HOME/.openclaw/.cache"
BUILD_HASH_FILE="$BUILD_CACHE_DIR/start-sh.workspace-build.hash"
BACKEND_BUILD_SENTINEL="$SCRIPT_DIR/dist/index.js"
UI_BUILD_SENTINEL="$SCRIPT_DIR/dist/control-ui/index.html"
mkdir -p "$BUILD_CACHE_DIR"
PREVIOUS_BUILD_HASH=$(cat "$BUILD_HASH_FILE" 2>/dev/null || true)

NEED_BUILD=""
if [ ! -f "$BACKEND_BUILD_SENTINEL" ]; then
  NEED_BUILD="dist/index.js 缺失"
elif [ ! -f "$UI_BUILD_SENTINEL" ]; then
  NEED_BUILD="dist/control-ui/index.html 缺失"
elif [ "$PREVIOUS_BUILD_HASH" != "$WORKSPACE_BUILD_HASH" ]; then
  NEED_BUILD="工作区快照已变更 (${WORKSPACE_BUILD_HASH:0:16})"
fi

echo -e "${YELLOW}[1/5] 检查后端与前端构建...${NC}"
if [ -n "$NEED_BUILD" ]; then
  echo -e "${YELLOW}  ⟳ 重新编译: ${NEED_BUILD}${NC}"
  pnpm build
  pnpm ui:build
  printf '%s' "$WORKSPACE_BUILD_HASH" > "$BUILD_HASH_FILE"
  echo -e "${GREEN}  ✓ 编译完成 (${WORKSPACE_BUILD_HASH:0:16})${NC}"
else
  echo -e "${GREEN}  ✓ 构建已是最新 (${WORKSPACE_BUILD_HASH:0:16})${NC}"
fi
echo ""

# 在停旧进程前就校验 Live Frontend 依赖，避免把已运行的本地 Her 先停掉。
if ! python3 -c "import aiohttp" >/dev/null 2>&1; then
  echo -e "${RED}✗ Live Frontend 缺少 Python 依赖: aiohttp${NC}"
  echo -e "${YELLOW}  安装: python3 -m pip install aiohttp${NC}"
  exit 1
fi
echo -e "${GREEN}  ✓ Live Frontend Python 依赖${NC}"
echo ""

# 停止旧进程：直接 kill（不用 gateway stop，它会卡死）+ 清 lock 文件。
echo -e "${YELLOW}[2/5] 停止旧进程...${NC}"
export OPENCLAW_GATEWAY_PORT="$GATEWAY_PORT"
GW_LOCK_DIR="$(node -e "const os=require('os'),p=require('path');console.log(p.join(os.tmpdir(),'openclaw-'+(process.getuid?.()??'')))" 2>/dev/null)"
OLD_PIDS="$(listener_pids "$GATEWAY_PORT")"
if [ -n "$OLD_PIDS" ]; then
  echo "$OLD_PIDS" | xargs kill 2>/dev/null || true
  if ! wait_for_port_free "$GATEWAY_PORT" 5; then
    echo "$OLD_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
  if [ -n "$(listener_pids "$GATEWAY_PORT")" ]; then
    LISTENERS=$(listener_pids "$GATEWAY_PORT" | tr '\n' ' ')
    echo -e "${RED}  ✗ Gateway 端口 ${GATEWAY_PORT} 未在超时内释放: ${LISTENERS}${NC}"
    exit 1
  fi
  echo -e "${GREEN}  ✓ 已停止旧 Gateway${NC}"
else
  echo -e "  ℹ 没有旧进程"
fi
if [ -n "$GW_LOCK_DIR" ] && [ -d "$GW_LOCK_DIR" ]; then
  rm -f "$GW_LOCK_DIR"/gateway.*.lock 2>/dev/null
  echo -e "${GREEN}  ✓ Gateway lock 已清理${NC}"
fi

# 等待进程完全退出
sleep 0.2

# Gateway 端口必须在此时已经彻底空闲；其余辅助端口允许直接清理。
echo -e "${YELLOW}[3/5] 检查端口...${NC}"
if [ -n "$(listener_pids "$GATEWAY_PORT")" ]; then
  LISTENERS=$(listener_pids "$GATEWAY_PORT" | tr '\n' ' ')
  echo -e "${RED}  ✗ Gateway 端口 ${GATEWAY_PORT} 仍被占用: ${LISTENERS}${NC}"
  exit 1
fi
PIDS_TO_KILL="$(
  {
    listener_pids "$REALTIME_PORT"
    listener_pids "$LIVE_UI_PORT"
    listener_pids "$LIVE_PROXY_PORT"
  } | sort -u
)"
if [ -n "$PIDS_TO_KILL" ]; then
  echo -e "${RED}  ⚠ 辅助端口被占用，强制释放: $(echo "$PIDS_TO_KILL" | tr '\n' ' ')${NC}"
  echo "$PIDS_TO_KILL" | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi
echo -e "${GREEN}  ✓ 端口就绪${NC}"

# 启动 Gateway + Live Frontend Proxy
echo -e "${YELLOW}[4/5] 启动 Gateway + Live Frontend...${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Gateway:  http://localhost:${GATEWAY_PORT}${NC}"
echo -e "${GREEN}  Realtime: http://localhost:${REALTIME_PORT} (WebSocket: ws://localhost:${REALTIME_PORT}/ws)${NC}"
echo -e "${GREEN}  Live UI:  http://localhost:${LIVE_UI_PORT} (Proxy WS: ws://localhost:${LIVE_PROXY_PORT})${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# 个人 Her 的 Cloudflare 隧道域名（/voice 命令用这些生成远程 URL）
export VOICE_FE_HOST="carher.carher.net"
export VOICE_PROXY_HOST="proxy.carher.net"

# Anthropic direct on the macOS host can resolve IPv6 first and get a 403 from
# the forbidden path, while the same token succeeds over IPv4. Force ipv4first
# for the local Her gateway process so direct Anthropic calls match docker1.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"
export OPENCLAW_INSTANCE_ID="local-her-$(date +%Y%m%d%H%M%S)-$$"

# 直接运行已编译的 dist，避免再次经过 run-node freshness 检查触发二次构建。
node dist/index.js gateway run --port "$GATEWAY_PORT" --bind "$GATEWAY_BIND" --force &
GATEWAY_PID=$!

# 启动 Live Frontend Proxy（后台运行）
# 默认关闭 markdown 落盘，避免影响实时音频流畅度。
LIVE_GEMINI_LOG="${LIVE_GEMINI_LOG:-1}"
echo -e "${YELLOW}启动 Live Frontend Proxy (LIVE_GEMINI_LOG=$LIVE_GEMINI_LOG)...${NC}"
(cd "extensions/realtime/live-frontend" && LIVE_GEMINI_LOG="$LIVE_GEMINI_LOG" python3 server.py) &
LIVE_FRONTEND_PID=$!

cleanup() {
  echo ""
  echo -e "${YELLOW}Stopping processes...${NC}"
  if [ -n "${LIVE_FRONTEND_PID:-}" ]; then
    kill "$LIVE_FRONTEND_PID" 2>/dev/null || true
  fi
  if [ -n "${GATEWAY_PID:-}" ]; then
    kill "$GATEWAY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 等待 Gateway 启动
echo -e "${YELLOW}等待 Gateway 启动...${NC}"
sleep 3

# 读取 token（从配置文件）
TOKEN=$(grep -o '"token": *"[^"]*"' ~/.openclaw/openclaw.json | head -1 | sed 's/"token": *"\([^"]*\)"/\1/')
if [ -z "$TOKEN" ]; then
  TOKEN="my-local-token-12345"
fi

# Generate voice token if not exists (same file that /voice command reads/writes)
VOICE_TOKEN_FILE="$HOME/.openclaw/.voice-token"
if [ ! -f "$VOICE_TOKEN_FILE" ]; then
  mkdir -p "$(dirname "$VOICE_TOKEN_FILE")"
  python3 -c "import uuid; print(uuid.uuid4().hex)" > "$VOICE_TOKEN_FILE"
fi
VOICE_TOKEN=$(cat "$VOICE_TOKEN_FILE")

# 打印所有 URL（不弹浏览器）
echo -e "${GREEN}[5/5] 个人 Her 已就绪${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  个人 Her — 本地 URL${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "  Webchat:    ${GREEN}http://localhost:${GATEWAY_PORT}/?token=${TOKEN}${NC}"
echo -e "  Desktop UI: ${GREEN}http://localhost:${LIVE_UI_PORT}${NC}"
echo -e "  Mobile UI:  ${GREEN}http://localhost:${LIVE_UI_PORT}/mobile.html${NC}"
echo -e "  Voice:      ${GREEN}http://localhost:${LIVE_UI_PORT}/mobile.html?proxy=ws://localhost:${LIVE_PROXY_PORT}&openclaw=ws://localhost:${REALTIME_PORT}/ws&token=${VOICE_TOKEN}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
# 固定远程 URL（需 cloudflared 隧道运行）
# RT 端口不暴露，语音通过 FE 代理 (carher.carher.net)
CYAN='\033[0;36m'
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  个人 Her — 固定远程 URL（需 cloudflared 隧道运行）${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "  Mobile:  ${CYAN}https://carher.carher.net/mobile.html?proxy=wss%3A%2F%2Fproxy.carher.net&openclaw=wss%3A%2F%2Fcarher.carher.net%2Fws&token=${VOICE_TOKEN}${NC}"
echo -e "  Desktop: ${CYAN}https://carher.carher.net?proxy=wss%3A%2F%2Fproxy.carher.net&openclaw=wss%3A%2F%2Fcarher.carher.net%2Fws&token=${VOICE_TOKEN}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
# 隧道状态检测
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^cloudflared$"; then
  echo -e "${GREEN}✓ cloudflared 隧道运行中（Docker 容器）${NC}"
elif pgrep -f "cloudflared tunnel run" &>/dev/null; then
  echo -e "${GREEN}✓ cloudflared 隧道运行中（原生进程）${NC}"
else
  echo -e "${YELLOW}⚠ cloudflared 隧道未运行（远程 URL 不可用）${NC}"
  echo -e "  启动隧道: ${YELLOW}./start-tunnel.sh${NC}"
fi
echo ""
echo -e "${GREEN}✓ Gateway 已启动 (PID: $GATEWAY_PID)${NC}"
echo -e "${YELLOW}按 Ctrl+C 停止${NC}"
echo ""

# 等待 Gateway 进程
wait $GATEWAY_PID
