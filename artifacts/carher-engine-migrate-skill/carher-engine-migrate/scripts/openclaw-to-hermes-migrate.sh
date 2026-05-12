#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
case "$cmd" in
  plan|apply)
    echo "refuse: use scripts/carher-migrate.sh for plan/apply so Hermes does not mis-detect this command as a live OpenClaw process." >&2
    exit 9
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/carher-migrate.sh" "$@"
