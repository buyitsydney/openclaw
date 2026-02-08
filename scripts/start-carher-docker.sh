#!/bin/bash
# 已迁移至项目根目录 start-docker.sh
# 此脚本保留为兼容性跳转
echo "⚠ 此脚本已迁移，请改用: ./start-docker.sh"
echo ""
exec "$(dirname "$0")/../start-docker.sh" "$@"
