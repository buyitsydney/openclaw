#!/bin/bash
# CarHer Remote Access — 一键启动隧道，手机扫码即用
#
# 模式：
#   默认：命名隧道模式（需先配置 cloudflared tunnel，URL 固定不变）
#   --random：随机隧道模式（无需配置，但每次重启 URL 变化）
#   --local：纯本地模式（不启动任何隧道，只打印 localhost URL）
#
# 前提：
#   1. OpenClaw Gateway 已运行（./start.sh in openclaw root）
#   2. CarHer server.py 已运行（./start.sh in live-frontend/）
#   3. 已安装 cloudflared（除 --local 模式外）

set -e

MODE="named"
if [ "$1" = "--random" ]; then
  MODE="random"
elif [ "$1" = "--local" ]; then
  MODE="local"
fi

# OpenClaw Realtime 插件端口（默认 18790，厂商联调用 OPENCLAW_REALTIME_PORT=19010）
REALTIME_PORT="${OPENCLAW_REALTIME_PORT:-18790}"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   CarHer Remote Access — 手机实时语音 Demo              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Check cloudflared (skip in local mode)
if [ "$MODE" != "local" ] && ! command -v cloudflared &>/dev/null; then
  echo "错误: 未安装 cloudflared，请运行: brew install cloudflared"
  echo "  或使用本地模式: $0 --local"
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
check_port "$REALTIME_PORT" "OpenClaw Realtime 插件 (端口 $REALTIME_PORT)"

echo "本地服务检查通过 ✓"
echo ""

# Auto-open local pages in Mac browser for debugging (skip in local mode, already on localhost)
if [ "$MODE" != "local" ]; then
  open "http://localhost:8000/mobile.html" 2>/dev/null || true
  open "http://localhost:8000/" 2>/dev/null || true
fi

# ============================================================
# 纯本地模式 (--local) — 不启动隧道，直接用 localhost
# ============================================================
if [ "$MODE" = "local" ]; then
  MOBILE_URL="http://localhost:8000/mobile.html?proxy=ws%3A%2F%2Flocalhost%3A8080&openclaw=ws%3A%2F%2Flocalhost%3A${REALTIME_PORT}%2Fws"
  DESKTOP_URL="http://localhost:8000?proxy=ws%3A%2F%2Flocalhost%3A8080&openclaw=ws%3A%2F%2Flocalhost%3A${REALTIME_PORT}%2Fws"
  CHECK_URL="http://localhost:8000/car-check.html"

  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║   纯本地模式 — 无隧道，直接 localhost                    ║"
  echo "╠══════════════════════════════════════════════════════════╣"
  echo "║                                                          ║"
  echo "║  手机版（需同一局域网或 Mac 浏览器直接访问）：              ║"
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
  echo "本地端口："
  echo "  前端页面:     http://localhost:8000"
  echo "  Gemini 代理:  ws://localhost:8080"
  echo "  OpenClaw:     ws://localhost:$REALTIME_PORT/ws"
  echo "-----------------------------------------------------------"
  echo ""
  echo "💡 纯本地模式，不消耗 Cloudflare 隧道配额"
  echo "   手机测试请确保与 Mac 在同一 WiFi，并将 localhost 换成 Mac 的局域网 IP"
  echo ""
  open "$MOBILE_URL" 2>/dev/null || true
  open "$DESKTOP_URL" 2>/dev/null || true
  exit 0
fi

# 多用户 agentId 列表（自动附加到 URL 后面）
AGENT_IDS=("user1" "user2" "user3")

# 打印多用户 URL（参数: $1=基础 mobile URL）
print_multi_user_urls() {
  local base_url="$1"
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  多用户测试 URL（每个用户独立记忆和会话）："
  echo "═══════════════════════════════════════════════════════════"
  for aid in "${AGENT_IDS[@]}"; do
    echo ""
    echo "  👤 $aid:"
    echo "  ${base_url}&agentId=${aid}"
  done
  echo ""
  echo "  💡 默认 URL（不带 agentId）= 你个人的 Her (agent=main)"
  echo "═══════════════════════════════════════════════════════════"
}

# ============================================================
# 命名隧道模式（默认）— URL 固定，重启不变
# ============================================================
if [ "$MODE" = "named" ]; then
  # 只清理同类型（命名隧道）的残留进程，不影响正在运行的随机隧道
  if pgrep -f "cloudflared tunnel run" &>/dev/null; then
    echo "清理残留命名隧道进程..."
    pkill -9 -f "cloudflared tunnel run" 2>/dev/null
    sleep 1
  fi
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

  print_multi_user_urls "$MOBILE_URL"

  echo ""
  echo "按 Ctrl+C 关闭隧道"
  echo ""

  # 运行命名隧道（前台，Ctrl+C 停止）
  exec cloudflared tunnel run carher
fi

# ============================================================
# 随机隧道模式 (--random) — 每次重启 URL 变化
# ============================================================
# 只清理同类型（随机隧道）的残留进程，不影响正在运行的命名隧道
if pgrep -f "cloudflared tunnel --url" &>/dev/null; then
  echo "清理残留随机隧道进程..."
  pkill -9 -f "cloudflared tunnel --url" 2>/dev/null
  sleep 1
fi

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
cloudflared tunnel --url http://localhost:8000 --protocol http2 --config /dev/null 2>"$TMP_FRONTEND" &
PID_FRONTEND=$!

cloudflared tunnel --url http://localhost:8080 --protocol http2 --config /dev/null 2>"$TMP_PROXY" &
PID_PROXY=$!

cloudflared tunnel --url http://localhost:$REALTIME_PORT --protocol http2 --config /dev/null 2>"$TMP_OPENCLAW" &
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

print_multi_user_urls "$MOBILE_URL"

echo ""
echo "按 Ctrl+C 关闭隧道"
echo ""

# Keep running until Ctrl+C
wait
