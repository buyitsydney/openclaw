#!/bin/bash
# Car Her 容器入口：同时启动 Gateway + Live Frontend Proxy
set -e

echo "🚗 Car Her Container Starting..."
echo "   Gateway:  :18789"
echo "   Realtime: :18790"
echo "   Frontend: :8000 (WS proxy: :8080)"

# Ensure data directories exist
mkdir -p /data/.openclaw/workspace
mkdir -p /data/.openclaw/local/bin

# Persistent local bin: bot-installed CLIs survive container recreation.
export PATH="/data/.openclaw/local/bin:$PATH"
export NPM_CONFIG_PREFIX="/data/.openclaw/local"
if ! command -v lark-cli &>/dev/null; then
  echo "▶ Installing lark-cli..."
  npm install -g @larksuite/cli --prefix /data/.openclaw/local 2>&1 | tail -1
fi
# Symlink into /usr/local/bin so child processes find it
ln -sf /data/.openclaw/local/bin/* /usr/local/bin/ 2>/dev/null || true

# lark-cli skills: install to personal layer on first boot.
# `npx skills add -g` installs to ~/.agents/skills/ (= /data/.agents/skills/).
# Per-bot, writable, persistent volume. Her can self-update later.
if command -v lark-cli &>/dev/null && [ ! -d "/data/.agents/skills/lark-im" ]; then
  echo "▶ Installing lark-cli skills..."
  npx skills add larksuite/cli -g -y 2>&1 | tail -3 || true
fi

# Clean stale Chrome singleton locks — hostname changes on container restart,
# causing Chromium to refuse starting ("profile in use by another computer").
find /data/.openclaw/browser -name "SingletonLock" -o -name "SingletonSocket" -o -name "SingletonCookie" 2>/dev/null | xargs rm -f 2>/dev/null || true

# Clean stale session write locks — previous container may have been killed
# before releasing locks; PID reuse in containers causes false "alive" detection.
find /data/.openclaw -name "*.jsonl.lock" -delete 2>/dev/null || true

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
exec node dist/index.js gateway run --port 18789 --bind lan
