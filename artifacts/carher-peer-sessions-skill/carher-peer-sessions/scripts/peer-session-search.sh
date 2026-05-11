#!/usr/bin/env bash
set -euo pipefail

SELF_NAME="peer-session-search"
MARKER_PATH="${CARHER_ENGINE_MARKER:-/data/.engine/active}"
OPENCLAW_HOME="${CARHER_PEER_OPENCLAW_HOME:-${OPENCLAW_HOME:-/data/.openclaw}}"
HERMES_HOME="${CARHER_PEER_HERMES_HOME:-${HERMES_HOME:-/opt/data}}"
MAX_LINES="${CARHER_PEER_MAX_LINES:-200}"
MAX_SNIPPET_CHARS="${CARHER_PEER_MAX_SNIPPET_CHARS:-1000}"

usage() {
  cat <<'USAGE'
Usage:
  peer-session-search.sh status
  peer-session-search.sh memory
  peer-session-search.sh recent <peer|openclaw|hermes|both>
  peer-session-search.sh search <peer|openclaw|hermes|both> <query>
  peer-session-search.sh show <path> [line]

Read-only helper for CarHer cross-engine session and memory lookup.
USAGE
}

have() {
  command -v "$1" >/dev/null 2>&1
}

trim_output() {
  awk -v max="$MAX_SNIPPET_CHARS" '{
    if (length($0) > max) {
      print substr($0, 1, max) "... [truncated]"
    } else {
      print
    }
  }'
}

active_engine() {
  local active
  if [ -r "$MARKER_PATH" ]; then
    active="$(tr '[:upper:]' '[:lower:]' <"$MARKER_PATH")"
  else
    active=""
  fi
  case "$active" in
    openclaw | hermes) printf '%s\n' "$active" ;;
    *) printf 'unknown\n' ;;
  esac
}

peer_engine() {
  case "$(active_engine)" in
    openclaw) printf 'hermes\n' ;;
    hermes) printf 'openclaw\n' ;;
    *) printf 'both\n' ;;
  esac
}

real_path() {
  if have python3; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
  elif have realpath; then
    realpath "$1"
  else
    printf '%s\n' "$1"
  fi
}

add_existing() {
  local path="$1"
  if [ -e "$path" ]; then
    printf '%s\n' "$path"
  fi
}

openclaw_roots() {
  add_existing "$OPENCLAW_HOME/agents"
  add_existing "$OPENCLAW_HOME/feishu-groups"
  add_existing "$OPENCLAW_HOME/workspace/SOUL.md"
  add_existing "$OPENCLAW_HOME/workspace/USER.md"
  add_existing "$OPENCLAW_HOME/workspace/MEMORY.md"
  add_existing "$OPENCLAW_HOME/workspace-claude/SOUL.md"
  add_existing "$OPENCLAW_HOME/workspace-claude/USER.md"
  add_existing "$OPENCLAW_HOME/workspace-claude/MEMORY.md"
}

hermes_roots() {
  add_existing "$HERMES_HOME/sessions"
  add_existing "$HERMES_HOME/SOUL.md"
  add_existing "$HERMES_HOME/memories"
  add_existing "$HERMES_HOME/logs"
}

roots_for() {
  local target="$1"
  case "$target" in
    peer) roots_for "$(peer_engine)" ;;
    openclaw) openclaw_roots ;;
    hermes) hermes_roots ;;
    both)
      openclaw_roots
      hermes_roots
      ;;
    *)
      printf '%s: unknown target: %s\n' "$SELF_NAME" "$target" >&2
      return 2
      ;;
  esac
}

print_status() {
  local active peer
  active="$(active_engine)"
  peer="$(peer_engine)"
  printf 'active_engine=%s\n' "$active"
  printf 'peer_engine=%s\n' "$peer"
  printf 'marker_path=%s\n' "$MARKER_PATH"
  printf 'openclaw_home=%s readable=%s\n' "$OPENCLAW_HOME" "$([ -r "$OPENCLAW_HOME" ] && printf yes || printf no)"
  printf 'hermes_home=%s readable=%s\n' "$HERMES_HOME" "$([ -r "$HERMES_HOME" ] && printf yes || printf no)"
  printf '\nopenclaw_roots:\n'
  openclaw_roots | sed 's/^/  /'
  printf '\nhermes_roots:\n'
  hermes_roots | sed 's/^/  /'
}

print_memory() {
  local file
  for file in \
    "$OPENCLAW_HOME/workspace/SOUL.md" \
    "$OPENCLAW_HOME/workspace/USER.md" \
    "$OPENCLAW_HOME/workspace/MEMORY.md" \
    "$HERMES_HOME/SOUL.md" \
    "$HERMES_HOME/memories/USER.md" \
    "$HERMES_HOME/memories/MEMORY.md"; do
    if [ -f "$file" ]; then
      printf '%s\t' "$file"
      if have sha256sum; then
        sha256sum "$file" | awk '{printf "sha256=%s\t", $1}'
      elif have shasum; then
        shasum -a 256 "$file" | awk '{printf "sha256=%s\t", $1}'
      fi
      wc -l "$file" | awk '{printf "lines=%s\n", $1}'
    else
      printf '%s\tmissing\n' "$file"
    fi
  done
}

recent_files() {
  local target="$1"
  mapfile -t roots < <(roots_for "$target")
  if [ "${#roots[@]}" -eq 0 ]; then
    printf '%s: no readable roots for target %s\n' "$SELF_NAME" "$target" >&2
    return 1
  fi

  if have find; then
    find "${roots[@]}" -type f ! -name '*.trajectory.jsonl' \( -name '*.jsonl' -o -name '*.md' -o -name '*.txt' -o -name '*.log' \) \
      -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -50 | awk '{first=$1; $1=""; sub(/^ /,""); print}'
  else
    printf '%s: find is required for recent\n' "$SELF_NAME" >&2
    return 1
  fi
}

search_files() {
  local target="$1"
  local query="$2"
  mapfile -t roots < <(roots_for "$target")
  if [ "${#roots[@]}" -eq 0 ]; then
    printf '%s: no readable roots for target %s\n' "$SELF_NAME" "$target" >&2
    return 1
  fi

  if have rg; then
    rg -n --hidden --no-heading --color never --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/*.trajectory.jsonl' -F -- "$query" "${roots[@]}" 2>/dev/null | head -n "$MAX_LINES" | trim_output
  elif have grep; then
    grep -RIn -- "$query" "${roots[@]}" 2>/dev/null | head -n "$MAX_LINES" | trim_output
  else
    printf '%s: rg or grep is required for search\n' "$SELF_NAME" >&2
    return 1
  fi
}

show_file() {
  local path="$1"
  local line="${2:-1}"
  local real allowed_openclaw allowed_hermes start end
  real="$(real_path "$path")"
  allowed_openclaw="$(real_path "$OPENCLAW_HOME")"
  allowed_hermes="$(real_path "$HERMES_HOME")"

  case "$real" in
    "$allowed_openclaw"/* | "$allowed_hermes"/*) ;;
    *)
      printf '%s: refusing to read outside peer roots: %s\n' "$SELF_NAME" "$path" >&2
      return 2
      ;;
  esac

  if [ ! -f "$real" ]; then
    printf '%s: not a file: %s\n' "$SELF_NAME" "$real" >&2
    return 1
  fi

  if ! [[ "$line" =~ ^[0-9]+$ ]]; then
    line=1
  fi
  start=$(( line > 20 ? line - 20 : 1 ))
  end=$(( line + 40 ))
  sed -n "${start},${end}p" "$real" | nl -ba -v "$start" | trim_output
}

cmd="${1:-}"
case "$cmd" in
  status)
    print_status
    ;;
  memory)
    print_memory
    ;;
  recent)
    target="${2:-peer}"
    recent_files "$target"
    ;;
  search)
    target="${2:-peer}"
    query="${3:-}"
    if [ -z "$query" ]; then
      usage >&2
      exit 2
    fi
    search_files "$target" "$query"
    ;;
  show)
    path="${2:-}"
    if [ -z "$path" ]; then
      usage >&2
      exit 2
    fi
    show_file "$path" "${3:-1}"
    ;;
  -h | --help | help | "")
    usage
    ;;
  *)
    printf '%s: unknown command: %s\n' "$SELF_NAME" "$cmd" >&2
    usage >&2
    exit 2
    ;;
esac
