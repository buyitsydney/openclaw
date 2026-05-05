#!/usr/bin/env bash
# freeze-git-info.sh — capture CarHer repo git metadata (+ full body) into
# JSON on stdout. Runs at image build time; image-info.json gets baked in,
# so runtime containers read it without any .git dependency (k8s-friendly).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 0

git_safe() { git "$@" 2>/dev/null || echo ""; }

export CARHER_BUILD_HASH="$(git_safe rev-parse HEAD)"
export CARHER_BUILD_HASH_SHORT="$(git_safe rev-parse --short=12 HEAD)"
export CARHER_BUILD_BRANCH="$(git_safe rev-parse --abbrev-ref HEAD)"
export CARHER_BUILD_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || echo '')"
export CARHER_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Dump raw commit stream: NUL-separated records, unit-separator fields.
# Fields: hash, ISO-date, author, subject, body. body may span multiple lines.
# -z makes records NUL-separated.
git log --all -n ${CARHER_FREEZE_DEPTH:-999999} -z --pretty=format:'%H%x1f%cI%x1f%an%x1f%s%x1f%b' > /tmp/carher-commits-raw.bin 2>/dev/null || true
# per-commit diffstat (files_changed, insertions, deletions)
python3 - <<'PY' > /tmp/carher-commits.json
import json, subprocess, os

raw = b""
try:
    raw = open("/tmp/carher-commits-raw.bin", "rb").read()
except FileNotFoundError:
    pass

records = [r for r in raw.split(b"\x00") if r]
commits = []
for rec in records:
    # decode tolerantly
    try:
        txt = rec.decode("utf-8", errors="replace")
    except Exception:
        continue
    parts = txt.split("\x1f", 4)
    if len(parts) < 5:
        # no body (initial commit w/o body) → pad
        while len(parts) < 5:
            parts.append("")
    h, t, a, s, b = parts[0], parts[1], parts[2], parts[3], parts[4]
    # files_changed via git diff-tree (cheap, no diff content)
    files = 0; ins = 0; dels = 0
    try:
        r = subprocess.run(
            ["git", "show", "--stat=200", "--format=", h],
            capture_output=True, text=True, timeout=10
        )
        # Last line looks like:  "12 files changed, 345 insertions(+), 67 deletions(-)"
        tail = [ln for ln in r.stdout.strip().splitlines() if "changed" in ln]
        if tail:
            import re
            m = re.search(r"(\d+) files? changed", tail[-1]);      files = int(m.group(1)) if m else 0
            m = re.search(r"(\d+) insertions?\(\+\)", tail[-1]);   ins   = int(m.group(1)) if m else 0
            m = re.search(r"(\d+) deletions?\(-\)",  tail[-1]);    dels  = int(m.group(1)) if m else 0
    except Exception:
        pass
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
    "recent_commits":   commits,
}
print(json.dumps(out, ensure_ascii=False, indent=2))
PY
cat /tmp/carher-commits.json
rm -f /tmp/carher-commits-raw.bin /tmp/carher-commits.json
exit 0
