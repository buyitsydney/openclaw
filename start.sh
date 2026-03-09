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

echo -e "${YELLOW}🚀 CarHer Gateway 启动脚本${NC}"
echo ""

# 同步 shared config 到 ~/.openclaw/（upstream v2026.2.17 安全策略要求 $include 在 config 目录内）
cp "$SCRIPT_DIR/docker/shared-config.json5" "$HOME/.openclaw/shared-config.json5"
echo -e "${GREEN}  ✓ shared-config.json5 已同步到 ~/.openclaw/${NC}"

# 基于完整工作区快照决定是否需要重新编译（包含 tracked + untracked 文件）
WORKSPACE_BUILD_HASH=$(node scripts/workspace-build-hash.mjs)
BUILD_CACHE_DIR="$HOME/.openclaw/.cache"
BUILD_HASH_FILE="$BUILD_CACHE_DIR/start-sh.workspace-build.hash"
BACKEND_BUILD_SENTINEL="$SCRIPT_DIR/dist/index.js"
UI_BUILD_SENTINEL="$SCRIPT_DIR/ui/dist/index.html"
mkdir -p "$BUILD_CACHE_DIR"
PREVIOUS_BUILD_HASH=$(cat "$BUILD_HASH_FILE" 2>/dev/null || true)

NEED_BUILD=""
if [ ! -f "$BACKEND_BUILD_SENTINEL" ]; then
  NEED_BUILD="dist/index.js 缺失"
elif [ ! -f "$UI_BUILD_SENTINEL" ]; then
  NEED_BUILD="ui/dist/index.html 缺失"
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

# 杀掉已有的 Gateway 进程
echo -e "${YELLOW}[2/5] 停止旧进程...${NC}"
pkill -f "openclaw-gateway" 2>/dev/null && echo -e "${GREEN}  ✓ 已停止旧 Gateway${NC}" || echo -e "  ℹ 没有旧进程"
pkill -f "openclaw gateway" 2>/dev/null || true

# 等待进程完全退出
sleep 0.5

# 跨平台端口检查：Ubuntu 用 ss（自带），macOS 用 lsof
echo -e "${YELLOW}[3/5] 检查端口...${NC}"
if command -v ss &>/dev/null; then
  PIDS_TO_KILL=$(ss -tlnp '( sport = :18789 or sport = :18790 or sport = :8000 or sport = :8080 )' 2>/dev/null \
    | grep -oP 'pid=\K[0-9]+' | sort -u || true)
else
  PIDS_TO_KILL=$(lsof -t -i :18789 -i :18790 -i :8000 -i :8080 2>/dev/null | sort -u || true)
fi
if [ -n "$PIDS_TO_KILL" ]; then
  echo -e "${RED}  ⚠ 端口被占用，强制释放: $(echo $PIDS_TO_KILL | tr '\n' ' ')${NC}"
  echo $PIDS_TO_KILL | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi
echo -e "${GREEN}  ✓ 端口就绪${NC}"

# 启动 Gateway + Live Frontend Proxy
echo -e "${YELLOW}[4/5] 启动 Gateway + Live Frontend...${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Gateway:  http://localhost:18789${NC}"
echo -e "${GREEN}  Realtime: http://localhost:18790 (WebSocket: ws://localhost:18790/ws)${NC}"
echo -e "${GREEN}  Live UI:  http://localhost:8000 (Proxy WS: ws://localhost:8080)${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# 个人 Her 的 Cloudflare 隧道域名（/voice 命令用这些生成远程 URL）
export VOICE_FE_HOST="carher.carher.net"
export VOICE_PROXY_HOST="proxy.carher.net"

# 启动 Gateway（后台运行）
pnpm openclaw gateway run --port 18789 --force &
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
echo -e "  Webchat:    ${GREEN}http://localhost:18789/?token=${TOKEN}${NC}"
echo -e "  Desktop UI: ${GREEN}http://localhost:8000${NC}"
echo -e "  Mobile UI:  ${GREEN}http://localhost:8000/mobile.html${NC}"
echo -e "  Voice:      ${GREEN}http://localhost:8000/mobile.html?proxy=ws://localhost:8080&openclaw=ws://localhost:18790/ws&token=${VOICE_TOKEN}${NC}"
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
