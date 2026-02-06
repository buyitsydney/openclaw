#!/bin/bash
# CarHer 手机远程 Demo — 项目根目录快捷入口
# 实际逻辑在 extensions/realtime/live-frontend/start-remote.sh
exec "$(dirname "$0")/extensions/realtime/live-frontend/start-remote.sh" "$@"
