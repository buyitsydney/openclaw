#!/usr/bin/env bash
# her-self-inspect run.sh — report THIS container's image identity + hot-patch
# status. Single-container only: no SSH, no cross-host IO, no secret paths.
#
# Exits 0 even when /opt/carher/image-info.json is missing (old image) — fields
# degrade to "N/A · upgrade required to see this".

set -u

IMAGE_INFO=/opt/carher/image-info.json
NA="N/A · upgrade required to see this"

# hostname: container name
HOSTNAME_VAL="$(hostname 2>/dev/null || echo unknown)"

# openclaw_version from /app/package.json
OPENCLAW_VERSION="$NA"
if [ -f /app/package.json ]; then
  OPENCLAW_VERSION="$(python3 -c 'import json;print(json.load(open("/app/package.json")).get("version","N/A"))' 2>/dev/null || echo N/A)"
fi

# uptime of pid 1
UPTIME_VAL="$(ps -o etime= -p 1 2>/dev/null | awk '{$1=$1;print}' || echo N/A)"

# hot_patches: /app/dist/*.bak*
HOT_PATCHES="$(ls /app/dist/*.bak* 2>/dev/null || true)"
if [ -z "$HOT_PATCHES" ]; then
  HOT_PATCHES_LINE="(clean)"
  HOT_PATCHES_COUNT=0
else
  HOT_PATCHES_LINE="$HOT_PATCHES"
  HOT_PATCHES_COUNT="$(echo "$HOT_PATCHES" | wc -l | awk '{print $1}')"
fi

# Image identity from frozen JSON (prefer jq, fall back to python3)
parse_json() {
  local key="$1"
  if [ ! -f "$IMAGE_INFO" ]; then
    echo "$NA"
    return
  fi
  if command -v jq >/dev/null 2>&1; then
    local val
    val="$(jq -r --arg k "$key" '.[$k] // empty' "$IMAGE_INFO" 2>/dev/null)"
    [ -n "$val" ] && echo "$val" || echo "$NA"
  else
    python3 -c "import json,sys
try:
  d=json.load(open('$IMAGE_INFO'))
  print(d.get('$key') or '')
except Exception:
  print('')
" 2>/dev/null | awk 'NF{print; found=1} END{if(!found) print "'"$NA"'"}'
  fi
}

BUILD_HASH_SHORT="$(parse_json build_hash_short)"
BUILD_BRANCH="$(parse_json build_branch)"
BUILD_TIME="$(parse_json build_time)"
BUILD_TAG="$(parse_json build_tag)"

# top-5 recent_commits
top_commits() {
  if [ ! -f "$IMAGE_INFO" ]; then
    echo "  $NA"
    return
  fi
  python3 <<PY
import json
try:
  d = json.load(open("$IMAGE_INFO"))
  commits = (d.get("recent_commits") or [])[:5]
  if not commits:
    print("  (none)")
  for c in commits:
    h = (c.get("hash") or "")[:12]
    t = c.get("time") or ""
    a = c.get("author") or ""
    s = c.get("subject") or ""
    print(f"  {h}  {t}  {a}: {s}")
except Exception as e:
  print("  $NA")
PY
}

cat <<EOF
🛠️  her-self-inspect
---------------------------------------------
hostname          : $HOSTNAME_VAL
openclaw_version  : $OPENCLAW_VERSION
build_hash_short  : $BUILD_HASH_SHORT
build_branch      : $BUILD_BRANCH
build_time        : $BUILD_TIME
build_tag         : ${BUILD_TAG:-(none)}
uptime            : $UPTIME_VAL
hot_patches       : $HOT_PATCHES_COUNT file(s)
$(echo "$HOT_PATCHES_LINE" | sed 's/^/  /')

recent_commits (top 5):
$(top_commits)
EOF

exit 0
