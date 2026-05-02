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

# Default all build_* fields to NA (missing image-info.json).
BUILD_HASH_SHORT="$NA"
BUILD_BRANCH="$NA"
BUILD_TIME="$NA"
BUILD_TAG=""
TOP_COMMITS_BLOCK="  $NA"

if [ -f "$IMAGE_INFO" ]; then
  # Parse whole JSON once with python3 (always available in carher-core).
  # Fallback order: jq → python3 (prefer python for uniformity & no dep).
  eval "$(python3 - "$IMAGE_INFO" <<'PY'
import json, sys, shlex
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception:
    d = {}
def emit(k, v):
    print(f"{k}={shlex.quote(str(v or ''))}")
emit("BUILD_HASH_SHORT", d.get("build_hash_short") or "")
emit("BUILD_BRANCH",     d.get("build_branch") or "")
emit("BUILD_TIME",       d.get("build_time") or "")
emit("BUILD_TAG",        d.get("build_tag") or "")
commits = (d.get("recent_commits") or [])[:5]
if commits:
    lines = []
    for c in commits:
        h = (c.get("hash") or "")[:12]
        t = c.get("time") or ""
        a = c.get("author") or ""
        s = c.get("subject") or ""
        body = (c.get("body") or "").strip()
        fc = c.get("files_changed") or 0
        ins = c.get("insertions") or 0
        dels = c.get("deletions") or 0
        stat = f"{fc} files, +{ins} -{dels}" if fc else ""
        header = f"  {h}  {t}  {a}: {s}"
        if stat:
            header += f"   [{stat}]"
        lines.append(header)
        if body:
            for bl in body.splitlines():
                lines.append(f"      {bl}")
            lines.append("")
    block = "\n".join(lines).rstrip()
else:
    block = "  (none)"
print(f"TOP_COMMITS_BLOCK={shlex.quote(block)}")
PY
)"
  # Any field that came back empty → keep NA? For an existing file, empty is
  # a legitimate "no value" (e.g. no git tag on HEAD), so show "(none)".
  : "${BUILD_HASH_SHORT:=(none)}"
  : "${BUILD_BRANCH:=(none)}"
  : "${BUILD_TIME:=(none)}"
  [ -z "$BUILD_HASH_SHORT" ] && BUILD_HASH_SHORT="(none)"
  [ -z "$BUILD_BRANCH" ]     && BUILD_BRANCH="(none)"
  [ -z "$BUILD_TIME" ]       && BUILD_TIME="(none)"
fi

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
$TOP_COMMITS_BLOCK
EOF

exit 0
