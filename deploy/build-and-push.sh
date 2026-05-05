#!/bin/bash
# Build carher-core image and push to registry (replaces manual docker build +
# docker save|ssh load).
#
# Usage:
#   ./build-and-push.sh                       # uses defaults (localhost:5001)
#   ./build-and-push.sh --registry=ghcr.io/buyitsydney
#   ./build-and-push.sh --openclaw-tag=2026.4.25
#   ./build-and-push.sh --tag-suffix=hotfix   # → carher-core:<date>-hotfix
#
# Tag format: <registry>/carher-core:<YYYY.M.D>-<suffix?>

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

REGISTRY="${CARHER_REGISTRY:-localhost:5001}"
OPENCLAW_TAG="2026.4.24"
TAG_SUFFIX=""
PUSH=1

for arg in "$@"; do
  case "$arg" in
    --registry=*) REGISTRY="${arg#--registry=}" ;;
    --openclaw-tag=*) OPENCLAW_TAG="${arg#--openclaw-tag=}" ;;
    --tag-suffix=*) TAG_SUFFIX="-${arg#--tag-suffix=}" ;;
    --no-push) PUSH=0 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//' | head -20
      exit 0
      ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

DATE=$(date +%Y.%-m.%-d)
IMAGE_TAG="${REGISTRY}/carher-core:${DATE}${TAG_SUFFIX}"
BUILD_HASH=$(git -C "$ROOT" rev-parse HEAD)

echo -e "${YELLOW}▶${NC} Building $IMAGE_TAG"
echo "  openclaw base: $OPENCLAW_TAG"
echo "  git HEAD:      $BUILD_HASH"
echo

DOCKER_BUILDKIT=1 docker build \
  -f "$ROOT/Dockerfile.carher.v2" \
  --build-arg OPENCLAW_TAG="$OPENCLAW_TAG" \
  --build-arg BUILD_HASH="$BUILD_HASH" \
  -t "$IMAGE_TAG" \
  "$ROOT"

echo
echo -e "${GREEN}✓${NC} built $IMAGE_TAG"

if [ "$PUSH" = "1" ]; then
  echo -e "${YELLOW}▶${NC} Pushing to $REGISTRY"
  docker push "$IMAGE_TAG"
  echo -e "${GREEN}✓${NC} pushed $IMAGE_TAG"
  echo
  echo -e "${YELLOW}Next:${NC} update deploy/carher-N/.env:"
  echo "  IMAGE_TAG=$IMAGE_TAG"
  echo "  docker compose up -d"
fi
