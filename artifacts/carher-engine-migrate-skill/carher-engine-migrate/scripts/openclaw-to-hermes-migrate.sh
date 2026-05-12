#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_HOME="${OPENCLAW_HOME:-/data/.openclaw}"
HERMES_HOME="${HERMES_HOME:-/opt/data}"
ACTIVE_FILE="${CARHER_ENGINE_MARKER_FILE:-/data/.engine/active}"
HERMES_BIN="${HERMES_BIN:-/opt/hermes/venv/bin/hermes}"
PRESET="${CARHER_MIGRATE_PRESET:-user-data}"
SKILL_CONFLICT="${CARHER_MIGRATE_SKILL_CONFLICT:-skip}"

usage() {
  cat <<'USAGE'
Usage:
  openclaw-to-hermes-migrate.sh status
  openclaw-to-hermes-migrate.sh plan
  openclaw-to-hermes-migrate.sh apply --confirm
  openclaw-to-hermes-migrate.sh apply --confirm --overwrite
  openclaw-to-hermes-migrate.sh verify

Safe default:
  preset=user-data, skill-conflict=skip, secrets are not migrated.
USAGE
}

active_engine() {
  if [ -f "$ACTIVE_FILE" ]; then
    tr -d '[:space:]' < "$ACTIVE_FILE"
  else
    echo "unknown"
  fi
}

require_openclaw() {
  local active
  active="$(active_engine)"
  if [ "$active" != "openclaw" ]; then
    echo "refuse: active_engine=$active, migration apply/plan must run from OpenClaw mode" >&2
    exit 3
  fi
}

hermes_cmd() {
  if [ -x "$HERMES_BIN" ]; then
    "$HERMES_BIN" "$@"
  else
    hermes "$@"
  fi
}

source_file() {
  local name="$1"
  for base in "$OPENCLAW_HOME/workspace" "$OPENCLAW_HOME/workspace-main" "$OPENCLAW_HOME/workspace.default" "$OPENCLAW_HOME/workspace-claude"; do
    if [ -f "$base/$name" ]; then
      printf '%s\n' "$base/$name"
      return 0
    fi
  done
  return 1
}

sha() {
  if [ -f "$1" ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "missing"
  fi
}

bytes() {
  if [ -f "$1" ]; then
    wc -c < "$1" | tr -d '[:space:]'
  else
    echo "0"
  fi
}

line() {
  printf '%s\n' "$*"
}

file_report() {
  local label="$1"
  local src="$2"
  local dst="$3"
  line "$label.source=$src"
  line "$label.source_exists=$([ -f "$src" ] && echo yes || echo no)"
  line "$label.source_bytes=$(bytes "$src")"
  line "$label.source_sha256=$(sha "$src")"
  line "$label.dest=$dst"
  line "$label.dest_exists=$([ -f "$dst" ] && echo yes || echo no)"
  line "$label.dest_bytes=$(bytes "$dst")"
  line "$label.dest_sha256=$(sha "$dst")"
}

status() {
  local soul_src user_src memory_src
  soul_src="$(source_file SOUL.md || true)"
  user_src="$(source_file USER.md || true)"
  memory_src="$(source_file MEMORY.md || true)"
  line "active_engine=$(active_engine)"
  line "openclaw_home=$OPENCLAW_HOME"
  line "hermes_home=$HERMES_HOME"
  line "hermes_bin=$HERMES_BIN"
  file_report "SOUL" "${soul_src:-missing}" "$HERMES_HOME/SOUL.md"
  file_report "USER" "${user_src:-missing}" "$HERMES_HOME/memories/USER.md"
  file_report "MEMORY" "${memory_src:-missing}" "$HERMES_HOME/memories/MEMORY.md"
}

plan() {
  require_openclaw
  HOME="$HERMES_HOME" HERMES_HOME="$HERMES_HOME" hermes_cmd claw migrate \
    --source "$OPENCLAW_HOME" \
    --preset "$PRESET" \
    --skill-conflict "$SKILL_CONFLICT" \
    --dry-run
}

apply_migration() {
  local confirmed="no"
  local overwrite="no"
  for arg in "$@"; do
    if [ "$arg" = "--confirm" ]; then
      confirmed="yes"
    elif [ "$arg" = "--overwrite" ]; then
      overwrite="yes"
    fi
  done
  if [ "$confirmed" != "yes" ]; then
    echo "refuse: apply requires --confirm after owner approval" >&2
    exit 4
  fi
  require_openclaw
  local extra=()
  if [ "$overwrite" = "yes" ]; then
    extra+=(--overwrite)
  fi
  HOME="$HERMES_HOME" HERMES_HOME="$HERMES_HOME" hermes_cmd claw migrate \
    --source "$OPENCLAW_HOME" \
    --preset "$PRESET" \
    --skill-conflict "$SKILL_CONFLICT" \
    --yes \
    "${extra[@]}"
}

verify_phrase() {
  local label="$1"
  local phrase="$2"
  local src_hits dst_hits
  src_hits="$(grep -R -F -n "$phrase" "$OPENCLAW_HOME"/workspace* 2>/dev/null | head -3 || true)"
  dst_hits="$(grep -R -F -n "$phrase" "$HERMES_HOME"/SOUL.md "$HERMES_HOME"/memories 2>/dev/null | head -5 || true)"
  line "phrase.$label=$phrase"
  line "phrase.$label.source_found=$([ -n "$src_hits" ] && echo yes || echo no)"
  if [ -n "$src_hits" ]; then
    printf '%s\n' "$src_hits"
  fi
  line "phrase.$label.dest_found=$([ -n "$dst_hits" ] && echo yes || echo no)"
  if [ -n "$dst_hits" ]; then
    printf '%s\n' "$dst_hits"
  fi
}

verify() {
  status
  verify_phrase "owner" "卜弋天"
  verify_phrase "nova" "Nova"
  verify_phrase "research3" "研究3"
  verify_phrase "glory_liao" "Glory Liao"
}

cmd="${1:-}"
case "$cmd" in
  status)
    status
    ;;
  plan)
    plan
    ;;
  apply)
    shift
    apply_migration "$@"
    ;;
  verify)
    verify
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
