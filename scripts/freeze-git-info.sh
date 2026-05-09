#!/usr/bin/env bash
# freeze-git-info.sh — capture bounded CarHer repo git metadata (+ commit bodies)
# into JSON on stdout. Runs at image build time; image-info.json gets baked in,
# so runtime containers read it without any .git dependency (k8s-friendly).
#
# IMPORTANT: this script is on the image build critical path. Keep the default
# bounded and HEAD-scoped. Do not scan `git log --all` by default: production
# hosts have many stale refs, worktrees, and backup branches, and an unbounded
# scan can stall every deploy before Docker build even starts.
#
# Tuning:
#   CARHER_FREEZE_DEPTH=200          number of commits to index (default 200)
#   CARHER_FREEZE_SCOPE=head|all     default head; all is still depth-bounded
#   CARHER_FREEZE_REF=<ref>          ref for head scope (default HEAD)
#   CARHER_FREEZE_MAX_DEPTH=1000     safety cap unless CARHER_FREEZE_ALLOW_LARGE=1
#   CARHER_FREEZE_ROOT=/path/repo    test hook / alternate repo root
set -u

ROOT="${CARHER_FREEZE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 0

git_safe() { git "$@" 2>/dev/null || echo ""; }

export CARHER_BUILD_HASH="$(git_safe rev-parse HEAD)"
export CARHER_BUILD_HASH_SHORT="$(git_safe rev-parse --short=12 HEAD)"
export CARHER_BUILD_BRANCH="$(git_safe rev-parse --abbrev-ref HEAD)"
export CARHER_BUILD_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || echo '')"
export CARHER_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - <<'PY'
import json, os, re, subprocess, sys

DEFAULT_DEPTH = 200
DEFAULT_MAX_DEPTH = 1000


def parse_positive_int(raw, default):
    try:
        value = int(str(raw).strip())
    except Exception:
        return default
    return value if value > 0 else default


def run_git(args, timeout=20):
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            check=False,
            timeout=timeout,
        )
        if result.returncode != 0:
            return b""
        return result.stdout
    except Exception:
        return b""


def run_git_text(args, timeout=3):
    return run_git(args, timeout=timeout).decode("utf-8", errors="replace")


requested_depth = parse_positive_int(os.environ.get("CARHER_FREEZE_DEPTH"), DEFAULT_DEPTH)
max_depth = parse_positive_int(os.environ.get("CARHER_FREEZE_MAX_DEPTH"), DEFAULT_MAX_DEPTH)
allow_large = os.environ.get("CARHER_FREEZE_ALLOW_LARGE") == "1"
depth = requested_depth if allow_large else min(requested_depth, max_depth)

scope = (os.environ.get("CARHER_FREEZE_SCOPE") or "head").strip().lower()
ref = (os.environ.get("CARHER_FREEZE_REF") or "HEAD").strip() or "HEAD"
log_args = ["log", "-z", "-n", str(depth), "--pretty=format:%H%x1f%cI%x1f%an%x1f%s%x1f%b"]
if scope == "all":
    log_args.insert(1, "--all")
    freeze_scope = "all"
else:
    log_args.insert(1, ref)
    freeze_scope = ref

# NUL-separated records; unit-separator fields. Body may span lines.
raw = run_git(log_args, timeout=30)
records = [r for r in raw.split(b"\x00") if r]
commits = []
shortstat_re = re.compile(
    r"(?:(\d+) files? changed)?(?:,\s*)?(?:(\d+) insertions?\(\+\))?(?:,\s*)?(?:(\d+) deletions?\(-\))?"
)

for rec in records:
    txt = rec.decode("utf-8", errors="replace")
    parts = txt.split("\x1f", 4)
    while len(parts) < 5:
        parts.append("")
    h, t, a, s, b = parts[0], parts[1], parts[2], parts[3], parts[4]
    files = ins = dels = 0
    # diff-tree is much cheaper than `git show --stat`; keep it bounded per commit.
    stat = run_git_text(["diff-tree", "--shortstat", "--no-commit-id", "--root", "-r", h], timeout=2).strip()
    if stat:
        m = shortstat_re.search(stat)
        if m:
            files = int(m.group(1) or 0)
            ins = int(m.group(2) or 0)
            dels = int(m.group(3) or 0)
    commits.append({
        "hash": h,
        "time": t,
        "author": a,
        "subject": s,
        "body": b.strip(),
        "files_changed": files,
        "insertions": ins,
        "deletions": dels,
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
    "freeze_depth":     depth,
    "freeze_scope":     freeze_scope,
    "recent_commits":   commits,
}
print(json.dumps(out, ensure_ascii=False, indent=2))
PY
exit 0
