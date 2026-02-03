#!/bin/bash
# CarHer Gateway 启动脚本
# 自动杀掉旧进程，启动新的 Gateway

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}🚀 CarHer Gateway 启动脚本${NC}"
echo ""

# 杀掉已有的 Gateway 进程
echo -e "${YELLOW}[1/3] 停止旧进程...${NC}"
pkill -f "openclaw-gateway" 2>/dev/null && echo -e "${GREEN}  ✓ 已停止旧 Gateway${NC}" || echo -e "  ℹ 没有旧进程"
pkill -f "openclaw gateway" 2>/dev/null || true

# 等待进程完全退出
sleep 1

# 检查端口是否被占用
check_port() {
  local port=$1
  if lsof -i :$port >/dev/null 2>&1; then
    echo -e "${RED}  ⚠ 端口 $port 仍被占用，尝试强制释放...${NC}"
    lsof -ti :$port | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

echo -e "${YELLOW}[2/3] 检查端口...${NC}"
check_port 18789
check_port 18790
echo -e "${GREEN}  ✓ 端口就绪${NC}"

# 启动 Gateway
echo -e "${YELLOW}[3/3] 启动 Gateway...${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Gateway:  http://localhost:18789${NC}"
echo -e "${GREEN}  Realtime: http://localhost:18790 (WebSocket: ws://localhost:18790/ws)${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# 启动 Gateway（后台运行）
pnpm openclaw gateway --port 18789 --verbose &
GATEWAY_PID=$!

# 等待 Gateway 启动
echo -e "${YELLOW}等待 Gateway 启动...${NC}"
sleep 3

# 读取 token（从配置文件）
TOKEN=$(grep -o '"token": *"[^"]*"' ~/.openclaw/openclaw.json | head -1 | sed 's/"token": *"\([^"]*\)"/\1/')
if [ -z "$TOKEN" ]; then
  TOKEN="my-local-token-12345"
fi

# 自动打开前端页面（带 token）
echo -e "${GREEN}[4/4] 打开前端页面...${NC}"
open "http://localhost:18789/?token=${TOKEN}"

echo ""
echo -e "${GREEN}✓ Gateway 已启动 (PID: $GATEWAY_PID)${NC}"
echo -e "${YELLOW}按 Ctrl+C 停止${NC}"
echo ""

# 等待 Gateway 进程
wait $GATEWAY_PID
