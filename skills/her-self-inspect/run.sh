#!/usr/bin/env bash
# her-self-inspect run.sh — report THIS container's image identity + hot-patch
# status. Single-container only: no SSH, no cross-host IO, no secret paths.
#
# Usage:
#   run.sh                  → default: 6 core fields + top-5 commits
#   run.sh top-N            → show top-N commits (with body + diffstat)
#   run.sh all              → show all commits in image-info.json
#   run.sh <hash-prefix>    → show single commit detail (full body + stat)
#
# Exits 0 even when /opt/carher/image-info.json is missing (old image) — fields
# degrade to "N/A · upgrade required to see this".

set -u
IMAGE_INFO=/opt/carher/image-info.json
NA="N/A · upgrade required to see this"

# -------- arg parsing --------
MODE="default"
ARG=""
if [ $# -ge 1 ]; then
  case "$1" in
    top-*) MODE="topN"; ARG="${1#top-}" ;;
    all)   MODE="all" ;;
    help|-h|--help) sed -n '3,11p' "$0"; exit 0 ;;
    *)     MODE="hash"; ARG="$1" ;;
  esac
fi

# -------- hash lookup mode: show single commit --------
if [ "$MODE" = "hash" ] && [ -f "$IMAGE_INFO" ]; then
  python3 - "$IMAGE_INFO" "$ARG" <<'PY'
import json, sys
p, prefix = sys.argv[1], sys.argv[2]
d = json.load(open(p))
matches = [c for c in d.get("recent_commits", []) if c.get("hash","").startswith(prefix)]
if not matches:
    print(f"❌ no commit matches prefix '{prefix}' in image-info.json ({len(d.get('recent_commits',[]))} commits indexed)")
    sys.exit(0)
if len(matches) > 1:
    print(f"⚠ {len(matches)} ambiguous matches for '{prefix}':")
    for c in matches[:10]:
        print(f"  {c['hash'][:12]}  {c.get('subject','')}")
    sys.exit(0)
c = matches[0]
print(f"🛠️  commit {c['hash'][:12]} (full)")
print("-" * 45)
print(f"hash      : {c['hash']}")
print(f"time      : {c.get('time','')}")
print(f"author    : {c.get('author','')}")
print(f"subject   : {c.get('subject','')}")
fc, ins, dels = c.get('files_changed',0), c.get('insertions',0), c.get('deletions',0)
if fc or ins or dels:
    print(f"diffstat  : {fc} files, +{ins} -{dels}")
body = (c.get('body') or '').strip()
if body:
    print("body      :")
    for line in body.splitlines():
        print(f"  {line}")
PY
  exit 0
fi

# -------- default / topN / all mode: standard self-inspect --------
HOSTNAME_VAL="$(hostname 2>/dev/null || echo unknown)"
OPENCLAW_VERSION="$NA"
if [ -f /app/package.json ]; then
  OPENCLAW_VERSION="$(python3 -c 'import json;print(json.load(open("/app/package.json")).get("version","N/A"))' 2>/dev/null || echo N/A)"
fi
UPTIME_VAL="$(ps -o etime= -p 1 2>/dev/null | awk '{$1=$1;print}' || echo N/A)"
HOT_PATCHES="$(ls /app/dist/*.bak* 2>/dev/null || true)"
if [ -z "$HOT_PATCHES" ]; then HOT_PATCHES_LINE="(clean)"; HOT_PATCHES_COUNT=0
else HOT_PATCHES_LINE="$HOT_PATCHES"; HOT_PATCHES_COUNT="$(echo "$HOT_PATCHES" | wc -l | awk '{print $1}')"
fi

# decide how many commits to print
if [ "$MODE" = "topN" ]; then TOPN="${ARG:-5}"
elif [ "$MODE" = "all" ]; then TOPN="999999"
else TOPN="5"
fi

BUILD_HASH_SHORT="$NA"; BUILD_BRANCH="$NA"; BUILD_TIME="$NA"; BUILD_TAG=""
TOP_COMMITS_BLOCK="  $NA"; TOTAL_COMMITS=0

if [ -f "$IMAGE_INFO" ]; then
  eval "$(python3 - "$IMAGE_INFO" "$TOPN" <<'PY'
import json, sys, shlex
p, topn = sys.argv[1], int(sys.argv[2])
try: d = json.load(open(p))
except: d = {}
def emit(k,v): print(f"{k}={shlex.quote(str(v or ''))}")
emit("BUILD_HASH_SHORT", d.get("build_hash_short") or "")
emit("BUILD_BRANCH",     d.get("build_branch") or "")
emit("BUILD_TIME",       d.get("build_time") or "")
emit("BUILD_TAG",        d.get("build_tag") or "")
commits = d.get("recent_commits") or []
emit("TOTAL_COMMITS", len(commits))
sel = commits[:topn]
if sel:
    lines = []
    for c in sel:
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
        if stat: header += f"   [{stat}]"
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
  : "${BUILD_HASH_SHORT:=(none)}"
  : "${BUILD_BRANCH:=(none)}"
  : "${BUILD_TIME:=(none)}"
  [ -z "$BUILD_HASH_SHORT" ] && BUILD_HASH_SHORT="(none)"
  [ -z "$BUILD_BRANCH" ]     && BUILD_BRANCH="(none)"
  [ -z "$BUILD_TIME" ]       && BUILD_TIME="(none)"
fi

LABEL="recent_commits"
if [ "$MODE" = "topN" ]; then LABEL="recent_commits (top $TOPN of $TOTAL_COMMITS)"
elif [ "$MODE" = "all" ]; then LABEL="recent_commits (all $TOTAL_COMMITS)"
else LABEL="recent_commits (top 5 of $TOTAL_COMMITS)"
fi

cat <<EOF
🛠️  her-self-inspect  (v2.4-publish-test)
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

$LABEL:
$TOP_COMMITS_BLOCK
EOF
exit 0
