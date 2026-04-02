#!/bin/bash
# CarHer Live Frontend 启动脚本
# 启动 Gemini Live 代理服务器

set -e

cd "$(dirname "$0")"

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║        🚗 CarHer - Gemini Live + OpenClaw                     ║"
echo "╠═══════════════════════════════════════════════════════════════╣"
echo "║                                                               ║"
echo "║  使用前请确保:                                                 ║"
echo "║  1. OpenClaw Gateway 已运行 (./start.sh in openclaw root)     ║"
echo "║  2. 已登录 GCP: gcloud auth application-default login         ║"
echo "║                                                               ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# 检查 Python 依赖
if ! python3 -c "import websockets, aiohttp, google.auth" 2>/dev/null; then
    echo "📦 安装 Python 依赖..."
    pip3 install -r requirements.txt
fi

# 启动服务
echo "🚀 启动 Gemini Live 代理服务..."
python3 server.py
