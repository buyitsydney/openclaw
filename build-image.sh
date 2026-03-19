#!/bin/bash
# CarHer Docker 镜像构建（与 start-user.sh 分离）
#
# 用法:
#   ./build-image.sh                              # 构建 carher:local（默认）
#   ./build-image.sh --tag=carher:search          # 自定义镜像名
#   ./build-image.sh --branch=feature/search-users --tag=carher:search  # 从指定分支构建
#   ./build-image.sh --force                      # 跳过缓存检查，强制重建
#   ./build-image.sh --check                      # 仅检查是否需要重建，不构建
#
# 构建完成后，用 start-user.sh 启动容器:
#   ./start-user.sh --id=1                        # 使用默认 carher:local
#   ./start-user.sh --id=13 --image=carher:search # 使用自定义镜像

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

TAG="carher:local"
BRANCH=""
FORCE=""
CHECK_ONLY=""
BUILD_DIR="$SCRIPT_DIR"
WORKTREE_DIR=""

for arg in "$@"; do
  case "$arg" in
    --tag=*) TAG="${arg#--tag=}" ;;
    --branch=*) BRANCH="${arg#--branch=}" ;;
    --force) FORCE="yes" ;;
    --check) CHECK_ONLY="yes" ;;
    -h|--help)
      echo "用法: ./build-image.sh [--tag=NAME] [--branch=BRANCH] [--force] [--check]"
      echo ""
      echo "  --tag=NAME     镜像名称（默认: carher:local）"
      echo "  --branch=BRANCH  从指定 git 分支构建（使用临时 worktree）"
      echo "  --force        跳过缓存检查，强制重建"
      echo "  --check        仅检查是否需要重建，不执行构建"
      exit 0
      ;;
    *)
      echo -e "${RED}未知参数: $arg${NC}"
      exit 1
      ;;
  esac
done

echo -e "${YELLOW}🔨 CarHer 镜像构建${NC}"
echo ""

# --- Branch mode: create temporary worktree ---
if [ -n "$BRANCH" ]; then
  WORKTREE_DIR=$(mktemp -d /tmp/carher-build-XXXXXX)
  echo -e "${YELLOW}  ⟳ 创建临时 worktree: ${BRANCH} → ${WORKTREE_DIR}${NC}"
  git -C "$SCRIPT_DIR" worktree add "$WORKTREE_DIR" "$BRANCH" 2>&1 | tail -1
  BUILD_DIR="$WORKTREE_DIR"
  # Cleanup worktree on exit (success or failure)
  trap 'echo -e "${YELLOW}  ⟳ 清理 worktree...${NC}"; git -C "$SCRIPT_DIR" worktree remove "$WORKTREE_DIR" 2>/dev/null; echo -e "${GREEN}  ✓ worktree 已清理${NC}"' EXIT
fi

# --- Check if rebuild needed (skip for --force or --branch) ---
if [ -z "$FORCE" ] && [ -z "$BRANCH" ]; then
  # Compute current build hash
  CURRENT_BUILD_HASH=$(node "$BUILD_DIR/scripts/workspace-build-hash.mjs" 2>/dev/null || echo "unknown")

  IMAGE_BUILD_HASH=$(docker inspect "$TAG" --format '{{index .Config.Labels "carher.build.hash"}}' 2>/dev/null || echo "none")

  NEED_REBUILD=""
  if ! docker image inspect "$TAG" &>/dev/null; then
    NEED_REBUILD="镜像不存在"
  elif [ "$IMAGE_BUILD_HASH" = "none" ] || [ "$IMAGE_BUILD_HASH" = "unknown" ] || [ "$IMAGE_BUILD_HASH" = "" ]; then
    NEED_REBUILD="镜像无版本标记（旧版构建）"
  elif [ "$CURRENT_BUILD_HASH" != "$IMAGE_BUILD_HASH" ]; then
    NEED_REBUILD="工作区快照已变更 (镜像: ${IMAGE_BUILD_HASH:0:16}, 当前: ${CURRENT_BUILD_HASH:0:16})"
  fi

  if [ -z "$NEED_REBUILD" ]; then
    echo -e "${GREEN}  ✓ 镜像已是最新 (${CURRENT_BUILD_HASH:0:16})，无需重建${NC}"
    exit 0
  fi

  if [ -n "$CHECK_ONLY" ]; then
    echo -e "${YELLOW}  ⚠ 需要重建: ${NEED_REBUILD}${NC}"
    exit 1
  fi

  echo -e "${YELLOW}  ⟳ ${NEED_REBUILD}${NC}"
else
  CURRENT_BUILD_HASH=$(cd "$BUILD_DIR" && node scripts/workspace-build-hash.mjs 2>/dev/null || echo "$(cd "$BUILD_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')")
fi

# --- Build ---
echo ""
DOCKER_BUILDKIT=1 docker build \
  -f "$BUILD_DIR/Dockerfile.carher" \
  --build-arg BUILD_HASH="$CURRENT_BUILD_HASH" \
  -t "$TAG" \
  "$BUILD_DIR"
echo ""
echo -e "${GREEN}  ✓ 镜像构建完成: ${TAG} (${CURRENT_BUILD_HASH:0:16})${NC}"
