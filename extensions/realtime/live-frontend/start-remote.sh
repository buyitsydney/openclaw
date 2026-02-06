#!/bin/bash
# CarHer Remote Access — 一键启动隧道，手机扫码即用
#
# 前提：
#   1. OpenClaw Gateway 已运行（./start.sh in openclaw root）
#   2. CarHer server.py 已运行（./start.sh in live-frontend/）
#   3. 已安装 cloudflared（brew install cloudflared）
#   4. 手机需要能访问 trycloudflare.com（中国大陆需 VPN）

set -e

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
echo "正在启动 Cloudflare 隧道..."
echo ""

# Clean up on exit
cleanup() {
  echo ""
  echo "正在关闭隧道..."
  kill $PID_FRONTEND $PID_PROXY $PID_OPENCLAW 2>/dev/null
  wait $PID_FRONTEND $PID_PROXY $PID_OPENCLAW 2>/dev/null
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

# Build the one-click URL with query params
WSS_PROXY=$(echo "$URL_PROXY" | sed 's|^https://|wss://|')
WSS_OPENCLAW=$(echo "$URL_OPENCLAW" | sed 's|^https://|wss://|')
FULL_URL="${URL_FRONTEND}?proxy=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_PROXY}'))")&openclaw=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${WSS_OPENCLAW}/ws'))")"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   隧道已就绪！                                          ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  手机打开以下链接，点「一键启动」即可语音对话：           ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "$FULL_URL"
echo ""
echo "-----------------------------------------------------------"
echo "隧道详情："
echo "  前端页面:     $URL_FRONTEND"
echo "  Gemini 代理:  $URL_PROXY"
echo "  OpenClaw:     $URL_OPENCLAW"
echo "-----------------------------------------------------------"
echo ""
echo "按 Ctrl+C 关闭隧道"
echo ""

# Keep running until Ctrl+C
wait
