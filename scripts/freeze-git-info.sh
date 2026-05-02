#!/usr/bin/env bash
# freeze-git-info.sh — capture CarHer repo git metadata into JSON on stdout.
#
# Usage:
#   ./scripts/freeze-git-info.sh                       # stdout
#   ./scripts/freeze-git-info.sh > build/image-info.json
#
# Intended to run at image build time (on host, before `docker build`) so the
# resulting image-info.json is baked into /opt/carher/image-info.json and
# runtime containers need zero .git dependency (k8s/immutable-friendly).
#
# Always exits 0 (falls back to "N/A" fields) so the build is not blocked.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 0

git_safe() { git "$@" 2>/dev/null || echo ""; }

export CARHER_BUILD_HASH="$(git_safe rev-parse HEAD)"
export CARHER_BUILD_HASH_SHORT="$(git_safe rev-parse --short=12 HEAD)"
export CARHER_BUILD_BRANCH="$(git_safe rev-parse --abbrev-ref HEAD)"
export CARHER_BUILD_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || echo '')"
export CARHER_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Use ASCII unit-separator as field delimiter; newline as record separator.
DELIM=$'\x1f'
export CARHER_COMMITS_RAW="$(git log -n 50 --pretty=format:"%H${DELIM}%cI${DELIM}%an${DELIM}%s" 2>/dev/null || echo '')"
export CARHER_DELIM="$DELIM"

python3 <<'PY'
import json, os

delim = os.environ.get("CARHER_DELIM", "\x1f")
raw = os.environ.get("CARHER_COMMITS_RAW", "")

commits = []
for line in raw.splitlines():
    line = line.rstrip("\n")
    if not line.strip():
        continue
    parts = line.split(delim, 3)
    if len(parts) < 4:
        continue
    commits.append({
        "hash": parts[0],
        "time": parts[1],
        "author": parts[2],
        "subject": parts[3],
    })

def v(name, default="N/A"):
    s = os.environ.get(name, "").strip()
    return s if s else default

out = {
    "build_hash":       v("CARHER_BUILD_HASH"),
    "build_hash_short": v("CARHER_BUILD_HASH_SHORT"),
    "build_branch":     v("CARHER_BUILD_BRANCH"),
    "build_tag":        v("CARHER_BUILD_TAG", default=""),
    "build_time":       v("CARHER_BUILD_TIME"),
    "recent_commits":   commits,
}
print(json.dumps(out, ensure_ascii=False, indent=2))
PY

exit 0
