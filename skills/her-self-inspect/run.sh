#!/usr/bin/env bash
# her-self-inspect — report THIS container's image identity + drift detection.
# Single-container only: no SSH, no cross-host IO, no secret paths.
#
# Usage:
#   run.sh                 default: 6 core fields + top-5 commits
#   run.sh -n N | top-N    show top-N commits (with body + diffstat)
#   run.sh 5               bare digits 1-4 chars treated as top-N
#   run.sh -a | --all | all  show all commits
#   run.sh <hash-prefix>   show single commit detail (hex, >=4 chars)
#   run.sh -h | --help     this help
#
# Exits 0 even when image-info.json is missing (old image) — build_* fields
# degrade to "N/A · upgrade required to see this".

set -u
IMAGE_INFO=/opt/carher/image-info.json
DIST_MANIFEST=/opt/carher/dist-manifest.txt
NA="N/A · upgrade required to see this"

# -------- arg parsing (with aliases) --------
MODE="default"
ARG=""
show_help() { sed -n '3,14p' "$0"; }
if [ $# -ge 1 ]; then
  case "$1" in
    -h|--help|help) show_help; exit 0 ;;
    -a|--all|all)   MODE="all" ;;
    -n|--top)       MODE="topN"; ARG="${2:-5}" ;;
    top-*)          MODE="topN"; ARG="${1#top-}" ;;
    *)
      if   [[ "$1" =~ ^[0-9]{1,4}$ ]]; then MODE="topN"; ARG="$1"
      elif [[ "$1" =~ ^[0-9a-fA-F]{4,}$ ]]; then MODE="hash"; ARG="$1"
      else echo "❌ unrecognized arg: $1"; show_help; exit 0
      fi ;;
  esac
fi

# -------- hash lookup mode --------
if [ "$MODE" = "hash" ] && [ -f "$IMAGE_INFO" ]; then
  python3 - "$IMAGE_INFO" "$ARG" <<'PY'
import json, sys
p, prefix = sys.argv[1], sys.argv[2]
d = json.load(open(p))
m = [c for c in d.get("recent_commits", []) if c.get("hash","").startswith(prefix)]
if not m:
    print(f"❌ no commit matches prefix '{prefix}' in image-info.json ({len(d.get('recent_commits',[]))} commits indexed)")
    sys.exit(0)
if len(m) > 1:
    print(f"⚠ {len(m)} ambiguous matches for '{prefix}':")
    for c in m[:10]:
        print(f"  {c['hash'][:12]}  {c.get('subject','')}")
    sys.exit(0)
c = m[0]
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

# -------- self-inspect fields --------
HOSTNAME_VAL="$(hostname 2>/dev/null || echo unknown)"
OPENCLAW_VERSION="$NA"
if [ -f /app/package.json ]; then
  OPENCLAW_VERSION="$(python3 -c 'import json;print(json.load(open("/app/package.json")).get("version","N/A"))' 2>/dev/null || echo N/A)"
fi
UPTIME_VAL="$(ps -o etime= -p 1 2>/dev/null | awk '{$1=$1;print}' || echo N/A)"

# ---- hot-patch detection: .bak* files AND sha256 drift vs dist-manifest ----
BAK_FILES="$(ls /app/dist/*.bak* 2>/dev/null || true)"
BAK_COUNT=$(echo -n "$BAK_FILES" | grep -c '^' 2>/dev/null || echo 0)

DRIFT_COUNT=0
DRIFT_SAMPLE=""
if [ -f "$DIST_MANIFEST" ]; then
  # compare current dist/*.js sha256 vs manifest
  DRIFT_SAMPLE="$(cd / && sha256sum -c "$DIST_MANIFEST" 2>/dev/null | grep -v ': OK$' | grep -v '^$' | head -5 || true)"
  DRIFT_COUNT=$(echo -n "$DRIFT_SAMPLE" | grep -c '^' 2>/dev/null || echo 0)
  MANIFEST_STATUS="active"
else
  MANIFEST_STATUS="$NA"
fi

TOTAL_DRIFT=$((BAK_COUNT + DRIFT_COUNT))
if [ "$TOTAL_DRIFT" -eq 0 ]; then
  HOT_STATUS="(clean)"
else
  HOT_STATUS=""
  [ "$BAK_COUNT" -gt 0 ] && HOT_STATUS="$HOT_STATUS  .bak files ($BAK_COUNT):
$(echo "$BAK_FILES" | sed 's/^/    /')"
  [ "$DRIFT_COUNT" -gt 0 ] && HOT_STATUS="$HOT_STATUS
  sha256 drift ($DRIFT_COUNT):
$(echo "$DRIFT_SAMPLE" | sed 's/^/    /')"
fi

# -------- commits --------
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
fi

LABEL="recent_commits (top 5 of $TOTAL_COMMITS)"
if [ "$MODE" = "topN" ]; then LABEL="recent_commits (top $TOPN of $TOTAL_COMMITS)"
elif [ "$MODE" = "all" ]; then LABEL="recent_commits (all $TOTAL_COMMITS)"
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
dist_manifest     : $MANIFEST_STATUS
hot_patches       : $TOTAL_DRIFT (bak=$BAK_COUNT, sha256_drift=$DRIFT_COUNT)
$HOT_STATUS

$LABEL:
$TOP_COMMITS_BLOCK
EOF
exit 0
