#!/bin/bash
# Car Her 容器入口：同时启动 Gateway + Live Frontend Proxy
set -e

echo "🚗 Car Her Container Starting..."
echo "   Gateway:  :18789"
echo "   Realtime: :18790"
echo "   Frontend: :8000 (WS proxy: :8080)"

# Ensure data directories exist
mkdir -p /data/.openclaw/workspace

# Start Live Frontend Proxy in background
echo "▶ Starting Live Frontend Proxy..."
cd /app/extensions/realtime/live-frontend
python3 server.py &
PROXY_PID=$!

# Trap signals to clean up
cleanup() {
  echo "Stopping..."
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start Gateway in foreground
echo "▶ Starting Gateway..."
cd /app
exec node dist/index.js gateway run --port 18789 --force --bind lan
