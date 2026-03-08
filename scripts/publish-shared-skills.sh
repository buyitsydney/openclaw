#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_ROOT="${REPO_ROOT}/skills"
TARGET_ROOT="${HOME}/.openclaw/skills"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  cat <<EOF
用法:
  ./scripts/publish-shared-skills.sh sync <skill...>
  ./scripts/publish-shared-skills.sh remove <skill...>
  ./scripts/publish-shared-skills.sh list-source
  ./scripts/publish-shared-skills.sh list-target

说明:
  sync   把 repo skills/<name>/ 同步到 ~/.openclaw/skills/<name>/
  remove 删除 ~/.openclaw/skills/<name>/
EOF
}

require_skill_args() {
  if [ "$#" -eq 0 ]; then
    echo -e "${RED}✗ 必须至少指定一个 skill 名称${NC}"
    usage
    exit 1
  fi
}

sync_skill() {
  local name="$1"
  local src="${SOURCE_ROOT}/${name}"
  local dst="${TARGET_ROOT}/${name}"

  if [ ! -d "$src" ]; then
    echo -e "${RED}✗ 源 skill 不存在: ${src}${NC}"
    exit 1
  fi
  if [ ! -f "${src}/SKILL.md" ]; then
    echo -e "${RED}✗ 源 skill 缺少 SKILL.md: ${src}${NC}"
    exit 1
  fi

  rm -rf "$dst"
  cp -R "$src" "$dst"
  echo -e "${GREEN}✓ 已同步: ${name}${NC}"
  echo -e "  source: ${src}"
  echo -e "  target: ${dst}"
}

remove_skill() {
  local name="$1"
  local dst="${TARGET_ROOT}/${name}"

  if [ ! -e "$dst" ]; then
    echo -e "${YELLOW}· 目标不存在，跳过: ${dst}${NC}"
    return
  fi

  rm -rf "$dst"
  echo -e "${GREEN}✓ 已删除: ${name}${NC}"
  echo -e "  target: ${dst}"
}

list_dir() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo -e "${YELLOW}· 目录不存在: ${dir}${NC}"
    return
  fi

  python3 - "$dir" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
items = sorted(
    p.name for p in root.iterdir()
    if p.is_dir() and (p / "SKILL.md").exists()
)
for item in items:
    print(item)
PY
}

mkdir -p "$TARGET_ROOT"

COMMAND="${1:-}"
shift || true

case "$COMMAND" in
  sync)
    require_skill_args "$@"
    echo -e "${CYAN}同步到 shared skills 目录: ${TARGET_ROOT}${NC}"
    for skill in "$@"; do
      sync_skill "$skill"
    done
    ;;
  remove)
    require_skill_args "$@"
    echo -e "${CYAN}从 shared skills 目录删除: ${TARGET_ROOT}${NC}"
    for skill in "$@"; do
      remove_skill "$skill"
    done
    ;;
  list-source)
    echo -e "${CYAN}repo skills:${NC}"
    list_dir "$SOURCE_ROOT"
    ;;
  list-target)
    echo -e "${CYAN}shared skills:${NC}"
    list_dir "$TARGET_ROOT"
    ;;
  *)
    usage
    exit 1
    ;;
esac
