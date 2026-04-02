#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="carher-1"
FOLDER_TOKEN=""
UPLOAD_MB="200"
UPLOAD_TIMEOUT_MS="$((30 * 60 * 1000))"

for arg in "$@"; do
  case "$arg" in
    --folder-token=*)
      FOLDER_TOKEN="${arg#--folder-token=}"
      ;;
    --upload-mb=*)
      UPLOAD_MB="${arg#--upload-mb=}"
      ;;
    --upload-timeout-ms=*)
      UPLOAD_TIMEOUT_MS="${arg#--upload-timeout-ms=}"
      ;;
    --container=*)
      CONTAINER_NAME="${arg#--container=}"
      ;;
    -h|--help)
      echo "用法:"
      echo "  scripts/test-feishu-drive-docker1.sh --folder-token=<token> [--upload-mb=200] [--upload-timeout-ms=1800000] [--container=carher-1]"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 1
      ;;
  esac
done

if [ -z "$FOLDER_TOKEN" ]; then
  echo "缺少必填参数: --folder-token=<token>" >&2
  exit 1
fi

if ! [[ "$UPLOAD_MB" =~ ^[0-9]+$ ]] || [ "$UPLOAD_MB" -le 0 ]; then
  echo "--upload-mb 必须是正整数" >&2
  exit 1
fi

if ! [[ "$UPLOAD_TIMEOUT_MS" =~ ^[0-9]+$ ]] || [ "$UPLOAD_TIMEOUT_MS" -le 0 ]; then
  echo "--upload-timeout-ms 必须是正整数" >&2
  exit 1
fi

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" != "true" ]; then
  echo "容器未运行: $CONTAINER_NAME" >&2
  exit 1
fi

echo "在容器 ${CONTAINER_NAME} 执行 feishu_drive 回归测试..."
echo "  folder_token=${FOLDER_TOKEN}"
echo "  upload_mb=${UPLOAD_MB}"
echo "  upload_timeout_ms=${UPLOAD_TIMEOUT_MS}"

docker exec -i \
  -e FEISHU_DRIVE_TEST_FOLDER_TOKEN="$FOLDER_TOKEN" \
  -e FEISHU_DRIVE_UPLOAD_MB="$UPLOAD_MB" \
  -e FEISHU_DRIVE_UPLOAD_TIMEOUT_MS="$UPLOAD_TIMEOUT_MS" \
  "$CONTAINER_NAME" \
  sh -lc 'cd /app && node scripts/feishu-drive-docker1-regression.mjs'
