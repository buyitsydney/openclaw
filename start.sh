#!/bin/bash
# CarHer Gateway 启动脚本
# 确定性重编译 + 启动 Gateway（建议永远只通过此脚本启动）

set -e

# 确保在仓库根目录执行（脚本所在目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🚀 CarHer Gateway 启动脚本${NC}"
echo ""

# 确定性重编译（后端 dist + 控制台 UI）
echo -e "${YELLOW}[1/5] 重编译后端与前端资源...${NC}"
pnpm build
pnpm ui:build
echo -e "${GREEN}  ✓ 编译完成${NC}"
echo ""

# 杀掉已有的 Gateway 进程
echo -e "${YELLOW}[2/5] 停止旧进程...${NC}"
pkill -f "openclaw-gateway" 2>/dev/null && echo -e "${GREEN}  ✓ 已停止旧 Gateway${NC}" || echo -e "  ℹ 没有旧进程"
pkill -f "openclaw gateway" 2>/dev/null || true

# 等待进程完全退出
sleep 0.5

# 一次 lsof 检查所有端口（macOS 上 lsof 很慢，合并成一次调用）
echo -e "${YELLOW}[3/5] 检查端口...${NC}"
PIDS_TO_KILL=$(lsof -t -i :18789 -i :18790 -i :8000 -i :8080 2>/dev/null | sort -u || true)
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

# 自动打开前端页面（带 token）
echo -e "${GREEN}[5/5] 打开前端页面...${NC}"
open "http://localhost:18789/?token=${TOKEN}"
open "http://localhost:8000"

echo ""
echo -e "${GREEN}✓ Gateway 已启动 (PID: $GATEWAY_PID)${NC}"
echo -e "${YELLOW}按 Ctrl+C 停止${NC}"
echo ""

# 等待 Gateway 进程
wait $GATEWAY_PID
