#!/bin/bash
# CarHer Docker 镜像构建脚本
# 构建一次，所有用户容器共享同一镜像
#
# 用法:
#   ./start-docker.sh              # 构建镜像
#   ./start-docker.sh --rebuild    # 强制重新构建（代码更新后使用）
#
# 后续启动用户容器: ./start-user.sh --id=1 --random

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}🚗 CarHer Docker 镜像构建${NC}"
echo ""

# Check Docker
if ! command -v docker &>/dev/null; then
  echo -e "${RED}✗ Docker 未安装${NC}"
  echo -e "  安装: https://docker.com/products/docker-desktop/"
  exit 1
fi
if ! docker info &>/dev/null 2>&1; then
  echo -e "${RED}✗ Docker 未运行，请先启动 Docker Desktop${NC}"
  exit 1
fi
echo -e "${GREEN}  ✓ Docker 就绪${NC}"

# Parse args
BUILD_ARGS=""
if [ "${1:-}" = "--rebuild" ]; then
  BUILD_ARGS="--no-cache"
  echo -e "${YELLOW}  ⟳ 强制重新构建（--no-cache）${NC}"
fi

# Build image (includes pnpm build + ui:build + Python deps)
# Compute build hash: git SHA + optional dirty-diff hash for auto-rebuild detection
GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
SOURCE_DIRS="src/ extensions/ skills/ package.json pnpm-lock.yaml Dockerfile.carher scripts/carher-entrypoint.sh ui/"
DIFF_OUTPUT=$(git diff HEAD -- $SOURCE_DIRS 2>/dev/null || true)
if [ -n "$DIFF_OUTPUT" ]; then
  DIRTY_HASH=$(printf '%s' "$DIFF_OUTPUT" | shasum -a 256 | cut -d' ' -f1)
  BUILD_HASH="${GIT_SHA}-dirty-${DIRTY_HASH:0:16}"
else
  BUILD_HASH="$GIT_SHA"
fi
echo ""
echo -e "${YELLOW}构建 carher:local 镜像（含前后端编译）...${NC}"
echo -e "  Build hash: ${BUILD_HASH:0:24}"
echo ""
docker build -f Dockerfile.carher --build-arg BUILD_HASH="$BUILD_HASH" -t carher:local $BUILD_ARGS .
echo ""
echo -e "${GREEN}✓ 镜像构建完成${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  镜像: carher:local${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  启动用户容器:"
echo -e "    ${YELLOW}./start-user.sh --id=1 --random${NC}    # user1 + 随机隧道"
echo -e "    ${YELLOW}./start-user.sh --id=2 --random${NC}    # user2 + 随机隧道"
echo ""
echo -e "  管理:"
echo -e "    ${YELLOW}./start-user.sh --id=1 --logs${NC}      # 查看 user1 日志"
echo -e "    ${YELLOW}./start-user.sh --id=1 --down${NC}      # 停止 user1"
echo -e "    ${YELLOW}./start-user.sh --down${NC}             # 停止所有用户"
echo ""
