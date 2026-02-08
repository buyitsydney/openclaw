#!/bin/bash
# CarHer Remote Access — 一键启动隧道，手机扫码即用
#
# 模式：
#   默认：命名隧道模式（需先配置 cloudflared tunnel，URL 固定不变）
#   --random：随机隧道模式（无需配置，但每次重启 URL 变化）
#
# 前提：
#   1. OpenClaw Gateway 已运行（./start.sh in openclaw root）
#   2. CarHer server.py 已运行（./start.sh in live-frontend/）
#   3. 已安装 cloudflared（brew install cloudflared）

set -e

MODE="named"
if [ "$1" = "--random" ]; then
  MODE="random"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   CarHer Remote Access — 手机实时语音 Demo              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Check cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo "错误: 未安装 cloudflared，请运行: brew install cloudflared"
  exit 1
fi

# Check local services
check_port() {
  if ! lsof -iTCP:"$1" -sTCP:LISTEN -P &>/dev/null; then
    echo "警告: 端口 $1 ($2) 未运行！"
    echo "  请先启动对应服务。"
    exit 1
  fi
}
check_port 8000 "CarHer 前端 (server.py)"
check_port 8080 "Gemini WS 代理 (server.py)"
check_port 18790 "OpenClaw Realtime 插件"

echo "本地服务检查通过 ✓"
echo ""

# Kill any leftover cloudflared processes from previous runs
if pgrep -q cloudflared 2>/dev/null; then
  echo "清理残留 cloudflared 进程..."
  pkill -9 cloudflared 2>/dev/null
  sleep 1
fi

# Auto-open local pages in Mac browser for debugging
open "http://localhost:8000/mobile.html" 2>/dev/null || true
open "http://localhost:8000/" 2>/dev/null || true

# ============================================================
# 命名隧道模式（默认）— URL 固定，重启不变
# ============================================================
if [ "$MODE" = "named" ]; then
  # 检查命名隧道配置
  if [ ! -f "$HOME/.cloudflared/config.yml" ]; then
    echo "错误: 未找到命名隧道配置 (~/.cloudflared/config.yml)"
    echo "  请先运行: cloudflared tunnel login && cloudflared tunnel create carher"
    echo "  或使用随机隧道模式: $0 --random"
    exit 1
  fi

  # 固定 URL（命名隧道，永不变化）
  URL_FRONTEND="https://carher.carher.net"
  URL_PROXY="https://proxy.carher.net"
  URL_OPENCLAW="https://api.carher.net"

  MOBILE_URL="${URL_FRONTEND}/mobile.html?proxy=wss%3A%2F%2Fproxy.carher.net&openclaw=wss%3A%2F%2Fapi.carher.net%2Fws"
  DESKTOP_URL="${URL_FRONTEND}?proxy=wss%3A%2F%2Fproxy.carher.net&openclaw=wss%3A%2F%2Fapi.carher.net%2Fws"
  CHECK_URL="${URL_FRONTEND}/car-check.html"

  echo "正在启动命名隧道 (carher)..."
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   隧道已就绪！（命名隧道 — URL 固定不变）               ║"
  echo "╠══════════════════════════════════════════════════════════╣"
  echo "║                                                          ║"
  echo "║  手机/车机版（极简界面，推荐）：                          ║"
  echo "║                                                          ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "$MOBILE_URL"
  echo ""
  echo "-----------------------------------------------------------"
  echo "桌面版（完整调试界面）："
  echo "$DESKTOP_URL"
  echo ""
  echo "-----------------------------------------------------------"
  echo "环境检测页面："
  echo "$CHECK_URL"
  echo ""
  echo "-----------------------------------------------------------"
  echo "隧道详情（固定地址，重启不变）："
  echo "  前端页面:     $URL_FRONTEND"
  echo "  Gemini 代理:  $URL_PROXY"
  echo "  OpenClaw:     $URL_OPENCLAW"
  echo "-----------------------------------------------------------"
  echo ""
  echo "按 Ctrl+C 关闭隧道"
  echo ""

  # 运行命名隧道（前台，Ctrl+C 停止）
  exec cloudflared tunnel run carher
fi

# ============================================================
# 随机隧道模式 (--random) — 每次重启 URL 变化
# ============================================================
echo "正在启动随机隧道..."
echo ""

# Clean up on exit
cleanup() {
  echo ""
  echo "正在关闭隧道..."
  kill -9 $PID_FRONTEND $PID_PROXY $PID_OPENCLAW 2>/dev/null
  wait $PID_FRONTEND $PID_PROXY $PID_OPENCLAW 2>/dev/null
  rm -f "$TMP_FRONTEND" "$TMP_PROXY" "$TMP_OPENCLAW" 2>/dev/null
  echo "隧道已关闭。"
}
trap cleanup EXIT INT TERM

# Temp files for tunnel output
TMP_FRONTEND=$(mktemp)
TMP_PROXY=$(mktemp)
TMP_OPENCLAW=$(mktemp)

# Start 3 tunnels in background
cloudflared tunnel --url http://localhost:8000 --protocol http2 2>"$TMP_FRONTEND" &
PID_FRONTEND=$!

cloudflared tunnel --url http://localhost:8080 --protocol http2 2>"$TMP_PROXY" &
PID_PROXY=$!

cloudflared tunnel --url http://localhost:18790 --protocol http2 2>"$TMP_OPENCLAW" &
PID_OPENCLAW=$!

# Wait for all 3 URLs to appear (with timeout)
echo "等待隧道建立..."
MAX_WAIT=30
WAITED=0
URL_FRONTEND=""
URL_PROXY=""
URL_OPENCLAW=""

while [ $WAITED -lt $MAX_WAIT ]; do
  [ -z "$URL_FRONTEND" ] && URL_FRONTEND=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_FRONTEND" 2>/dev/null | head -1)
  [ -z "$URL_PROXY" ] && URL_PROXY=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_PROXY" 2>/dev/null | head -1)
  [ -z "$URL_OPENCLAW" ] && URL_OPENCLAW=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TMP_OPENCLAW" 2>/dev/null | head -1)

  if [ -n "$URL_FRONTEND" ] && [ -n "$URL_PROXY" ] && [ -n "$URL_OPENCLAW" ]; then
    break
  fi

  sleep 1
  WAITED=$((WAITED + 1))
done

# Verify all URLs
if [ -z "$URL_FRONTEND" ] || [ -z "$URL_PROXY" ] || [ -z "$URL_OPENCLAW" ]; then
  echo "错误: 隧道建立超时！"
  [ -z "$URL_FRONTEND" ] && echo "  - 前端隧道失败"
  [ -z "$URL_PROXY" ] && echo "  - Gemini 代理隧道失败"
  [ -z "$URL_OPENCLAW" ] && echo "  - OpenClaw 隧道失败"
  exit 1
fi

# Build one-click URLs with query params
WSS_PROXY=$(echo "$URL_PROXY" | sed 's|^https://|wss://|')
WSS_OPENCLAW=$(echo "$URL_OPENCLAW" | sed 's|^https://|wss://|')
QUERY="proxy=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_PROXY}'))")&openclaw=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_OPENCLAW}/ws'))")"
MOBILE_URL="${URL_FRONTEND}/mobile.html?${QUERY}"
DESKTOP_URL="${URL_FRONTEND}?${QUERY}"
CHECK_URL="${URL_FRONTEND}/car-check.html"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   隧道已就绪！（随机隧道 — 重启后 URL 变化）            ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  手机/车机版（极简界面，推荐）：                          ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "$MOBILE_URL"
echo ""
echo "-----------------------------------------------------------"
echo "桌面版（完整调试界面）："
echo "$DESKTOP_URL"
echo ""
echo "-----------------------------------------------------------"
echo "环境检测页面："
echo "$CHECK_URL"
echo ""
echo "-----------------------------------------------------------"
echo "隧道详情（随机地址，重启后变化）："
echo "  前端页面:     $URL_FRONTEND"
echo "  Gemini 代理:  $URL_PROXY"
echo "  OpenClaw:     $URL_OPENCLAW"
echo "-----------------------------------------------------------"
echo ""
echo "按 Ctrl+C 关闭隧道"
echo ""

# Keep running until Ctrl+C
wait
