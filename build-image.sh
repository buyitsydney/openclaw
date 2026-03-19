#!/bin/bash
# CarHer Docker 镜像构建（与 start-user.sh 分离）
#
# 用法:
#   ./build-image.sh                              # 构建 carher:local（默认，从当前工作区）
#   ./build-image.sh --tag=carher:search          # 自定义镜像名
#   ./build-image.sh --branch=feature/xxx --tag=carher:xxx  # 从指定分支构建（自动 fetch + detach worktree）
#   ./build-image.sh --force                      # 跳过缓存检查，强制重建
#   ./build-image.sh --check                      # 仅检查是否需要重建，不构建
#
# 构建完成后，用 start-user.sh 启动容器:
#   ./start-user.sh --id=1                        # 使用默认 carher:local
#   ./start-user.sh --id=13 --image=carher:xxx    # 使用自定义镜像

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
      echo "  --tag=NAME       镜像名称（默认: carher:local）"
      echo "  --branch=BRANCH  从指定 git 分支构建（自动 fetch，使用 detach worktree）"
      echo "  --force          跳过缓存检查，强制重建"
      echo "  --check          仅检查是否需要重建，不执行构建"
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

# --- Branch mode: resolve ref + create detached worktree ---
if [ -n "$BRANCH" ]; then
  # 1. Clean stale worktrees (previous SSH drops, /tmp cleanups, etc.)
  git -C "$SCRIPT_DIR" worktree prune 2>/dev/null

  # 2. Fetch latest from remote (handles force-push / amend)
  echo -e "${YELLOW}  ⟳ Fetching origin/${BRANCH}...${NC}"
  if ! git -C "$SCRIPT_DIR" fetch origin "$BRANCH" 2>/dev/null; then
    # Branch might already be an origin/ ref or a full ref
    git -C "$SCRIPT_DIR" fetch origin 2>/dev/null || true
  fi

  # 3. Resolve to the correct ref — always prefer remote over local
  RESOLVED_REF=""
  if git -C "$SCRIPT_DIR" rev-parse --verify "origin/$BRANCH" &>/dev/null; then
    RESOLVED_REF="origin/$BRANCH"
  elif git -C "$SCRIPT_DIR" rev-parse --verify "$BRANCH" &>/dev/null; then
    RESOLVED_REF="$BRANCH"
  else
    echo -e "${RED}  ✗ 分支不存在: $BRANCH (本地和远端都找不到)${NC}"
    exit 1
  fi

  RESOLVED_SHA=$(git -C "$SCRIPT_DIR" rev-parse --short "$RESOLVED_REF")
  echo -e "${YELLOW}  ✓ 解析: ${BRANCH} → ${RESOLVED_REF} (${RESOLVED_SHA})${NC}"

  # 4. Create detached worktree (no local branch lock — immune to stale refs)
  WORKTREE_DIR=$(mktemp -d /tmp/carher-build-XXXXXX)
  echo -e "${YELLOW}  ⟳ 创建 detached worktree → ${WORKTREE_DIR}${NC}"
  git -C "$SCRIPT_DIR" worktree add --detach "$WORKTREE_DIR" "$RESOLVED_REF" 2>&1 | tail -1
  BUILD_DIR="$WORKTREE_DIR"

  # 5. Cleanup on exit (success or failure) — force remove
  trap 'echo -e "${YELLOW}  ⟳ 清理 worktree...${NC}"; git -C "$SCRIPT_DIR" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"; git -C "$SCRIPT_DIR" worktree prune 2>/dev/null; echo -e "${GREEN}  ✓ worktree 已清理${NC}"' EXIT

  # 6. Verify the worktree has the expected commit
  WORKTREE_SHA=$(git -C "$WORKTREE_DIR" rev-parse --short HEAD)
  if [ "$WORKTREE_SHA" != "$RESOLVED_SHA" ]; then
    echo -e "${RED}  ✗ worktree commit 不匹配！期望 ${RESOLVED_SHA}，实际 ${WORKTREE_SHA}${NC}"
    exit 1
  fi
  echo -e "${GREEN}  ✓ worktree commit 验证通过: ${WORKTREE_SHA}${NC}"
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
# When using --branch, touch all source files to invalidate Docker layer cache.
# BuildKit's content-addressed cache can miss single-file changes across worktrees.
if [ -n "$BRANCH" ]; then
  find "$BUILD_DIR/extensions" "$BUILD_DIR/src" -name '*.ts' -exec touch {} + 2>/dev/null
fi

DOCKER_BUILDKIT=1 docker build \
  -f "$BUILD_DIR/Dockerfile.carher" \
  --build-arg BUILD_HASH="$CURRENT_BUILD_HASH" \
  -t "$TAG" \
  "$BUILD_DIR"
echo ""
echo -e "${GREEN}  ✓ 镜像构建完成: ${TAG} (${CURRENT_BUILD_HASH:0:16})${NC}"
