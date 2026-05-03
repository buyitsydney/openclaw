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

# ============================================================
# Patch 7 — bug-C: memory manager cold-start session-listener
# (v2 after v1 revert on 2026-05-03; v1 missed the OUTER gate in server.impl)
#
# Root cause (verified by empty gateway log after v1 + chunks=0 on cold-start /new):
#   server.impl.startup has TWO gates before startGatewayMemoryBackend runs:
#     (a) OUTER (in server.impl-*.js): if (!shouldStartGatewayMemoryBackend(cfg)) return;
#         — gate function only returns true when cfg.memory.backend === "qmd"
#         — CarHer uses "builtin" → gate returns false → whole memory-boot task SKIPPED.
#     (b) INNER (in server-startup-memory-*.js for-loop):
#         if (resolved.backend !== "qmd" || !resolved.qmd) continue;
#         — even if outer gate was passed, builtin agents still skipped per-iteration.
#   P7 v1 only touched (b). The outer gate (a) still short-circuited. Runtime never
#   reached (b) → listener never subscribed → archive emit fired into empty
#   SESSION_TRANSCRIPT_LISTENERS set → reset archive files never entered chunks.
#
# Fix: patch BOTH gates.
#   P7a: relax OUTER gate to also return true if any agent has
#        memorySearch.sources.includes("sessions").
#   P7b: relax INNER for-loop filter to preload the session-listener for builtin
#        agents whose sources include "sessions" (same as v1 logic, re-applied).
# Both patches are idempotent and will no-op once upstream cuts a release that
# ships the equivalent eager-preload code.
# ============================================================

# P7a: outer gate in server.impl-*.js — extend shouldStartGatewayMemoryBackend
python3 - <<'PY'
import glob, os, pathlib
files = sorted(glob.glob("/app/dist/server.impl-*.js"))
if not files:
    raise SystemExit("patch7a: server.impl-*.js bundle not found")
p = pathlib.Path(files[0])
s = p.read_text()
if "carher_P7a_gate" in s:
    print(f"patch7a {p.name}: already patched, skip")
else:
    anchor = 'function shouldStartGatewayMemoryBackend(cfg) {\n\treturn cfg.memory?.backend === "qmd";\n}'
    if anchor not in s:
        raise SystemExit("patch7a: shouldStartGatewayMemoryBackend anchor not found (upstream may have changed)")
    replacement = (
        'function shouldStartGatewayMemoryBackend(cfg) {\n'
        '\t// carher_P7a_gate: also return true when any agent requests sessions source,\n'
        '\t// so session-transcript listeners get eagerly subscribed at boot for builtin backend.\n'
        '\tif (cfg.memory?.backend === "qmd") return true;\n'
        '\tconst defs = cfg.agents?.defaults?.memorySearch?.sources;\n'
        '\tif (Array.isArray(defs) && defs.includes("sessions")) return true;\n'
        '\tconst entries = cfg.agents?.entries ?? {};\n'
        '\tfor (const id in entries) {\n'
        '\t\tconst src = entries[id]?.memorySearch?.sources;\n'
        '\t\tif (Array.isArray(src) && src.includes("sessions")) return true;\n'
        '\t}\n'
        '\treturn false;\n'
        '}'
    )
    s = s.replace(anchor, replacement, 1)
    p.write_text(s)
    v = p.read_text()
    if "carher_P7a_gate" not in v:
        raise SystemExit("patch7a: verify failed (marker missing)")
    print(f"patch7a {p.name}: OK")
PY

# P7b: inner filter in server-startup-memory-*.js — allow builtin+sessions agents
python3 - <<'PY'
import glob, os, pathlib
files = sorted(glob.glob("/app/dist/server-startup-memory-*.js"))
if not files:
    raise SystemExit("patch7b: server-startup-memory-*.js bundle not found")
p = pathlib.Path(files[0])
s = p.read_text()
if "carher_P7b_sessionListener" in s:
    print(f"patch7b {p.name}: already patched, skip")
else:
    anchor = 'if (resolved.backend !== "qmd" || !resolved.qmd) continue;\n\t\tconst { manager, error } = await getActiveMemorySearchManager({'
    if anchor not in s:
        raise SystemExit("patch7b: startGatewayMemoryBackend loop anchor not found")
    replacement = (
        '// carher_P7b_sessionListener: preload manager for builtin backend too when sources includes "sessions"\n'
        '\t\tconst carherSettings = resolveMemorySearchConfig(params.cfg, agentId);\n'
        '\t\tconst carherWantSessionListener = Array.isArray(carherSettings?.sources) && carherSettings.sources.includes("sessions");\n'
        '\t\tif ((resolved.backend !== "qmd" || !resolved.qmd) && !carherWantSessionListener) continue;\n'
        '\t\tconst { manager, error } = await getActiveMemorySearchManager({'
    )
    s = s.replace(anchor, replacement, 1)
    p.write_text(s)
    v = p.read_text()
    if "carher_P7b_sessionListener" not in v:
        raise SystemExit("patch7b: verify failed (marker missing)")
    print(f"patch7b {p.name}: OK")
PY

echo 'reset-archive-session-memory 7-patch set applied successfully (P1-P6 + P7a+P7b)'
