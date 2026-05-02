#!/bin/bash
# Apply reset-archive-session-memory 4-patch set to /app/dist
# See feat/reset-archive-session-memory-20260502 commit 0e692c385d for source.
set -euo pipefail

DIST=/app/dist

# Patch 1: engine-qmd shouldSkipTranscriptFileForDreaming — let reset/deleted through
F=$DIST/engine-qmd-BblS7k9c.js
sed -i 's@return isSessionArchiveArtifactName(fileName) || isCheckpointTranscriptFileName(fileName);@return (isSessionArchiveArtifactName(fileName) \&\& !isUsageCountedSessionTranscriptFileName(fileName)) || isCheckpointTranscriptFileName(fileName);@' "$F"
grep -q '!isUsageCountedSessionTranscriptFileName(fileName)) || isCheckpointTranscriptFileName' "$F" || { echo 'patch1 verify failed'; exit 1; }
echo 'patch1 engine-qmd: OK'

# Patch 2: manager isRetryableMemoryEmbeddingError — retry socket/network errors
F=$DIST/manager-Cjkvk5xb.js
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("/app/dist/manager-Cjkvk5xb.js")
s = p.read_text()
old = "return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\\d\\d|cloudflare|tokens per day)/i.test(message);"
new = "return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\\d\\d|cloudflare|tokens per day|fetch failed|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|network error|read ECONN|timed out)/i.test(message);"
if new not in s:
    if old not in s:
        raise SystemExit("patch2 manager: marker missing")
    s = s.replace(old, new)
    p.write_text(s)
if new not in s:
    raise SystemExit("patch2 manager: verify failed")
print("patch2 manager: OK")
PY

# Patch 3: session-transcript-hit extractTranscriptStemFromSessionsMemoryHit — yield stems for reset/deleted
python3 - <<'PY'
import pathlib
p = pathlib.Path("/app/dist/session-transcript-hit-Dwum7uxE.js")
s = p.read_text()
marker = 'if (base.endsWith(".md")) return base.slice(0, -3) || null;'
patch = '\n\tfor (const reason of ["reset", "deleted"]) {\n\t\tconst marker = `.jsonl.${reason}.`;\n\t\tconst idx = base.indexOf(marker);\n\t\tif (idx > 0) return base.slice(0, idx) || null;\n\t}'
if patch not in s:
    if marker not in s:
        raise SystemExit("patch3 session-transcript-hit: marker missing")
    s = s.replace(marker, marker + patch)
    p.write_text(s)
if patch not in s:
    raise SystemExit("patch3 session-transcript-hit: verify failed")
print("patch3 session-transcript-hit: OK")
PY

# Patch 4: memory-core/index — archiveMarker passthrough so reset/deleted hits bypass visibility gate
python3 - <<'PY'
import pathlib
p = pathlib.Path("/app/dist/extensions/memory-core/index.js")
s = p.read_text()
marker = 'if (!stem) continue;'
patch = '\n\t\tconst archiveMarker = /\\.jsonl\\.(?:reset|deleted)\\./.exec(hit.path);\n\t\tif (archiveMarker) { next.push(hit); continue; }'
if patch not in s:
    if marker not in s:
        raise SystemExit("patch4 memory-core archiveMarker: marker missing")
    s = s.replace(marker, marker + patch)
    p.write_text(s)
if patch not in s:
    raise SystemExit("patch4 memory-core archiveMarker: verify failed")
print("patch4 memory-core archiveMarker: OK")
PY

echo 'reset-archive-session-memory 4-patch set applied successfully'
