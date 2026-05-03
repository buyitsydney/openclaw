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

# ============================================================
# Patch 5 + Patch 6 — added 2026-05-03 (reset-archive-emit-bypass)
# These mirror upstream openclaw commits 5f5e0a3633 / 2ffdb5d248 / aba97a4c7c.
# Will be auto-skipped once CarHer bumps OPENCLAW_TAG past the release containing aba97a4c7c.
# ============================================================

# Patch 5: session-transcript-files.fs emits sessionTranscriptUpdate after archive rename
python3 - <<'PY'
import glob, os, pathlib, sys
files = sorted(glob.glob("/app/dist/session-transcript-files.fs-*.js"))
if not files:
    raise SystemExit("patch5: session-transcript-files.fs-*.js bundle not found")
changed = 0
for fn in files:
    p = pathlib.Path(fn)
    s = p.read_text()
    if "emitSessionTranscriptUpdate" in s:
        print(f"patch5 {os.path.basename(fn)}: already has emit, skip")
        continue
    te = sorted(glob.glob("/app/dist/transcript-events-*.js"))
    if not te:
        raise SystemExit("patch5: transcript-events-*.js bundle not found")
    te_name = os.path.basename(te[0])
    imp = f'import {{ t as emitSessionTranscriptUpdate }} from "./{te_name}";'
    anchor = 'import fs from "node:fs";'
    if anchor not in s:
        raise SystemExit("patch5: 'import fs from node:fs' anchor not found")
    s = s.replace(anchor, anchor + "\n" + imp, 1)
    old_body = '\tfs.renameSync(filePath, archived);\n\treturn archived;\n}'
    new_body = '\tfs.renameSync(filePath, archived);\n\temitSessionTranscriptUpdate({ sessionFile: archived });\n\treturn archived;\n}'
    if old_body not in s:
        raise SystemExit("patch5: archiveFileOnDisk body anchor not found")
    s = s.replace(old_body, new_body, 1)
    p.write_text(s)
    # verify
    v = p.read_text()
    if v.count("emitSessionTranscriptUpdate") < 2:
        raise SystemExit("patch5: verify failed (expected >=2 references)")
    changed += 1
    print(f"patch5 {os.path.basename(fn)}: OK")
if changed == 0:
    print("patch5 session-transcript-files.fs: all already patched")
PY

# Patch 6: manager processSessionDeltaBatch bypasses delta threshold for archive artifacts
python3 - <<'PY'
import glob, os, pathlib
files = sorted(glob.glob("/app/dist/manager-*.js"))
if not files:
    raise SystemExit("patch6: manager-*.js bundle not found")
# pick the manager bundle that contains processSessionDeltaBatch (there can be multiple manager-*.js)
target = None
for fn in files:
    s = pathlib.Path(fn).read_text()
    if "processSessionDeltaBatch" in s and "ensureSessionListener" in s:
        target = fn
        break
if not target:
    raise SystemExit("patch6: no manager bundle with processSessionDeltaBatch found")
p = pathlib.Path(target)
s = p.read_text()
if "isSessionArchiveArtifactName(baseName) && isUsageCountedSessionTranscriptFileName(baseName)" in s:
    print(f"patch6 {os.path.basename(target)}: already patched, skip")
else:
    art = sorted(glob.glob("/app/dist/artifacts-*.js"))
    if not art:
        raise SystemExit("patch6: artifacts-*.js bundle not found")
    art_name = os.path.basename(art[0])
    # Insert import after the transcript-events import line
    import re
    anchor_re = re.compile(r'^import \{ [^\}]*onSessionTranscriptUpdate[^\}]*\} from "\./transcript-events-[^"]+\.js";$', re.M)
    m = anchor_re.search(s)
    if not m:
        raise SystemExit("patch6: onSessionTranscriptUpdate import anchor not found")
    imp_line = f'import {{ i as isUsageCountedSessionTranscriptFileName, r as isSessionArchiveArtifactName }} from "./{art_name}";'
    if imp_line not in s:
        s = s[:m.end()] + "\n" + imp_line + s[m.end():]
    # Insert bypass block at top of for-of loop in processSessionDeltaBatch
    loop_anchor = '\t\tfor (const sessionFile of pending) {\n\t\t\tconst delta = await this.updateSessionDelta(sessionFile);'
    if loop_anchor not in s:
        raise SystemExit("patch6: processSessionDeltaBatch loop anchor not found")
    new_loop = ('\t\tfor (const sessionFile of pending) {\n'
                '\t\t\tconst baseName = path.basename(sessionFile);\n'
                '\t\t\tif (isSessionArchiveArtifactName(baseName) && isUsageCountedSessionTranscriptFileName(baseName)) {\n'
                '\t\t\t\tthis.sessionsDirtyFiles.add(sessionFile);\n'
                '\t\t\t\tthis.sessionsDirty = true;\n'
                '\t\t\t\tshouldSync = true;\n'
                '\t\t\t\tcontinue;\n'
                '\t\t\t}\n'
                '\t\t\tconst delta = await this.updateSessionDelta(sessionFile);')
    s = s.replace(loop_anchor, new_loop, 1)
    p.write_text(s)
    v = p.read_text()
    for marker in ["isSessionArchiveArtifactName(baseName)", "this.sessionsDirtyFiles.add(sessionFile)"]:
        if marker not in v:
            raise SystemExit(f"patch6: verify failed ({marker} not present)")
    print(f"patch6 {os.path.basename(target)}: OK")
PY

echo 'reset-archive-session-memory 6-patch set applied successfully'
