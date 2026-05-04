#!/bin/bash
# Apply reset-archive-session-memory patches to /app/dist
# Patches are idempotent and auto-skip when upstream already includes the fix.
# Compatible with openclaw 2026.4.24 AND 2026.5.3+.
set -euo pipefail

DIST=/app/dist

# Helper: find bundle by glob pattern, fail with message if not found
find_bundle() {
  local pattern="$1" label="$2"
  local files
  files=$(find "$DIST" -maxdepth 1 -name "$pattern" -type f 2>/dev/null | sort | head -1)
  if [ -z "$files" ]; then
    echo "SKIP $label: bundle $pattern not found (upstream may have removed it)"
    return 1
  fi
  echo "$files"
}

echo "Applying reset-archive patches (idempotent)..."

# ============================================================
# Patch 4: memory-core/index — archiveMarker passthrough
# ============================================================
python3 - <<'PY'
import pathlib
p = pathlib.Path("/app/dist/extensions/memory-core/index.js")
if not p.exists():
    print("patch4 memory-core: SKIP (file not found)")
    exit(0)
s = p.read_text()
marker = 'if (!stem) continue;'
patch = '\n\t\tconst archiveMarker = /\\.jsonl\\.(?:reset|deleted)\\./.exec(hit.path);\n\t\tif (archiveMarker) { next.push(hit); continue; }'
if patch in s:
    print("patch4 memory-core: already patched, skip")
elif marker not in s:
    print("patch4 memory-core: SKIP (anchor not found, upstream may have refactored)")
else:
    s = s.replace(marker, marker + patch)
    p.write_text(s)
    if patch not in p.read_text():
        raise SystemExit("patch4 memory-core: verify failed")
    print("patch4 memory-core: OK")
PY

# ============================================================
# Patch 7a: outer gate — extend shouldStartGatewayMemoryBackend
# ============================================================
python3 - <<'PY'
import glob, pathlib
files = sorted(glob.glob("/app/dist/server.impl-*.js"))
if not files:
    print("patch7a: SKIP (server.impl-*.js not found)")
    exit(0)
p = pathlib.Path(files[0])
s = p.read_text()
if "carher_P7a_gate" in s:
    print(f"patch7a {p.name}: already patched, skip")
    exit(0)
anchor = 'function shouldStartGatewayMemoryBackend(cfg) {\n\treturn cfg.memory?.backend === "qmd";\n}'
if anchor not in s:
    # 0503 may have removed/refactored this function entirely
    if "shouldStartGatewayMemoryBackend" not in s:
        print(f"patch7a {p.name}: SKIP (function removed in this version)")
    else:
        print(f"patch7a {p.name}: SKIP (anchor changed, manual review needed)")
    exit(0)
replacement = (
    'function shouldStartGatewayMemoryBackend(cfg) {\n'
    '\t// carher_P7a_gate: also return true when any agent requests sessions source\n'
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
if "carher_P7a_gate" not in p.read_text():
    raise SystemExit("patch7a: verify failed")
print(f"patch7a {p.name}: OK")
PY

# ============================================================
# Patch 7b: inner filter — allow builtin+sessions agents
# ============================================================
python3 - <<'PY'
import glob, pathlib
files = sorted(glob.glob("/app/dist/server-startup-memory-*.js"))
if not files:
    print("patch7b: SKIP (server-startup-memory-*.js not found)")
    exit(0)
p = pathlib.Path(files[0])
s = p.read_text()
if "carher_P7b_sessionListener" in s:
    print(f"patch7b {p.name}: already patched, skip")
    exit(0)
anchor = 'if (resolved.backend !== "qmd" || !resolved.qmd) continue;\n\t\tconst { manager, error } = await getActiveMemorySearchManager({'
if anchor not in s:
    print(f"patch7b {p.name}: SKIP (anchor not found, upstream may have refactored)")
    exit(0)
replacement = (
    '// carher_P7b_sessionListener: preload manager for builtin backend too when sources includes "sessions"\n'
    '\t\tconst carherSettings = resolveMemorySearchConfig(params.cfg, agentId);\n'
    '\t\tconst carherWantSessionListener = Array.isArray(carherSettings?.sources) && carherSettings.sources.includes("sessions");\n'
    '\t\tif ((resolved.backend !== "qmd" || !resolved.qmd) && !carherWantSessionListener) continue;\n'
    '\t\tconst { manager, error } = await getActiveMemorySearchManager({'
)
s = s.replace(anchor, replacement, 1)
p.write_text(s)
if "carher_P7b_sessionListener" not in p.read_text():
    raise SystemExit("patch7b: verify failed")
print(f"patch7b {p.name}: OK")
PY

echo 'reset-archive patches applied (0503-compatible, idempotent)'

# Freeze dist manifest AFTER patches (caller expects this)
