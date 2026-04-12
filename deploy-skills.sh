#!/bin/bash
# Deploy skills: sync git-managed skills to ~/.openclaw/skills/
# Run once after git pull or upgrade. NOT per-container — once per server.
#
# Usage:
#   ./deploy-skills.sh                    # sync all registered sources
#   ./deploy-skills.sh --list             # list what would be synced
#   ./deploy-skills.sh --dry-run          # show actions without executing
#
# Skill sources are registered in docker/skill-sources.txt.
# To add a new source, add a line there. This script never needs editing.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCES_FILE="$SCRIPT_DIR/docker/skill-sources.txt"
DEST="$HOME/.openclaw/skills"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ ! -f "$SOURCES_FILE" ]; then
  echo -e "${RED}✗ skill-sources.txt not found: ${SOURCES_FILE}${NC}"
  exit 1
fi

mkdir -p "$DEST"

# Parse args
DRY_RUN=""
LIST_ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="yes" ;;
    --list) LIST_ONLY="yes" ;;
    --help|-h)
      echo "Usage: ./deploy-skills.sh [--list] [--dry-run]"
      echo "  --list      List skills that would be synced"
      echo "  --dry-run   Show actions without executing"
      echo ""
      echo "Sources: $SOURCES_FILE"
      echo "Destination: $DEST"
      exit 0
      ;;
  esac
done

# Collect all skills from all sources
SYNCED=0
SKIPPED=0

while IFS= read -r line || [ -n "$line" ]; do
  # Skip comments and empty lines
  line=$(echo "$line" | sed 's/#.*//' | xargs)
  [ -z "$line" ] && continue

  SOURCE_DIR="$SCRIPT_DIR/$line"
  if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${YELLOW}  ⚠ source not found: ${line}${NC}"
    continue
  fi

  for skill_dir in "$SOURCE_DIR"/*/; do
    [ ! -d "$skill_dir" ] && continue
    skill_name=$(basename "$skill_dir")

    # Must have SKILL.md to be a valid skill
    if [ ! -f "$skill_dir/SKILL.md" ]; then
      continue
    fi

    if [ -n "$LIST_ONLY" ]; then
      echo "  $skill_name  ← $line/$skill_name"
      SYNCED=$((SYNCED + 1))
      continue
    fi

    if [ -n "$DRY_RUN" ]; then
      echo -e "  ${GREEN}would sync${NC}: $skill_name  ← $line/$skill_name"
      SYNCED=$((SYNCED + 1))
      continue
    fi

    # Sync: remove old, copy new
    rm -rf "$DEST/$skill_name"
    cp -r "$skill_dir" "$DEST/$skill_name"
    SYNCED=$((SYNCED + 1))
  done
done < "$SOURCES_FILE"

# Count non-git skills (in dest but not from any source)
NON_GIT=$(ls "$DEST" 2>/dev/null | wc -l)
NON_GIT=$((NON_GIT - SYNCED))
[ $NON_GIT -lt 0 ] && NON_GIT=0

if [ -n "$LIST_ONLY" ]; then
  echo ""
  echo "Total: $SYNCED git-managed skills"
  echo "Non-git skills in $DEST: $NON_GIT (not touched)"
elif [ -n "$DRY_RUN" ]; then
  echo ""
  echo -e "${YELLOW}Dry run: $SYNCED skills would be synced${NC}"
else
  echo -e "${GREEN}✓ Synced $SYNCED skills to $DEST${NC}"
  [ $NON_GIT -gt 0 ] && echo -e "  ($NON_GIT non-git skills preserved)"
fi
