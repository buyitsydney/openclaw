#!/bin/bash
# CARHER PATCH: parse archive date from sessions/main/*.jsonl.reset.<ISO>.Z
# filenames so memory_search temporalDecay actually fires for archived
# transcripts (not just memory/YYYY-MM-DD.md files).
#
# Why this exists: openclaw's extractTimestamp falls back to fs.stat for
# session paths. The chunks DB stores `sessions/main/<id>.jsonl.reset.<ISO>.Z`
# but the actual files live under `<agentDir>/sessions/<id>...`, so fs.stat
# never resolves and decay is silently skipped. The .reset suffix encodes
# the archive moment exactly, so we parse the date directly from the path
# and bypass fs.stat entirely.
#
# Target: /app/dist/manager-<hash>.js (resolved by entrypoint glob)
# Marker: CARHER_SESSION_DECAY_PATCH_MARKER
# Kill switch: CARHER_DISABLE_SESSION_DECAY_PATCH=1

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-session-decay.sh: target not found: $TARGET" >&2
  exit 2
fi

if [ "${CARHER_DISABLE_SESSION_DECAY_PATCH:-0}" = "1" ]; then
  echo "apply-session-decay.sh: disabled via CARHER_DISABLE_SESSION_DECAY_PATCH"
  exit 0
fi

node - "$TARGET" <<'NODE'
const fs = require("fs");

const target = process.argv[2];
const marker = "CARHER_SESSION_DECAY_PATCH_MARKER";
let code = fs.readFileSync(target, "utf8");

if (code.includes(marker)) {
  console.log(`apply-session-decay.sh: already patched (${target})`);
  process.exit(0);
}

const backup = `${target}.bak.session-decay`;
if (!fs.existsSync(backup)) {
  fs.writeFileSync(backup, code);
}

const anchor1 = `const DATED_MEMORY_PATH_RE = /(?:^|\\/)memory\\/(\\d{4})-(\\d{2})-(\\d{2})\\.md$/;`;
if (!code.includes(anchor1)) {
  throw new Error("DATED_MEMORY_PATH_RE anchor not found");
}

const helperBlock = `${anchor1}
// === ${marker} ===
const CARHER_SESSION_RESET_PATH_RE = /\\.reset\\.(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})\\.(\\d{1,3})Z$/;
function carherParseSessionResetDateFromPath(filePath) {
\tconst normalized = String(filePath).replaceAll("\\\\", "/").replace(/^\\.\\//, "");
\tconst match = CARHER_SESSION_RESET_PATH_RE.exec(normalized);
\tif (!match) return null;
\tconst y = Number(match[1]);
\tconst mo = Number(match[2]);
\tconst d = Number(match[3]);
\tconst hh = Number(match[4]);
\tconst mm = Number(match[5]);
\tconst ss = Number(match[6]);
\tconst ms = Number(match[7]);
\tif (![y, mo, d, hh, mm, ss, ms].every(Number.isInteger)) return null;
\tconst ts = Date.UTC(y, mo - 1, d, hh, mm, ss, ms);
\tconst parsed = new Date(ts);
\tif (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== mo - 1 || parsed.getUTCDate() !== d || parsed.getUTCHours() !== hh || parsed.getUTCMinutes() !== mm || parsed.getUTCSeconds() !== ss) return null;
\treturn parsed;
}
// === end ${marker} ===`;

code = code.replace(anchor1, () => helperBlock);

const anchor2 = `\tconst fromPath = parseMemoryDateFromPath(params.filePath);\n\tif (fromPath) return fromPath;`;
if (!code.includes(anchor2)) {
  throw new Error("extractTimestamp fromPath anchor not found");
}

const callBlock = `${anchor2}
\tconst fromResetSuffix = carherParseSessionResetDateFromPath(params.filePath);
\tif (fromResetSuffix) return fromResetSuffix;`;

code = code.replace(anchor2, () => callBlock);

fs.writeFileSync(target, code);
console.log(`apply-session-decay.sh: patched ${target}`);
NODE

if ! CHECK_OUTPUT=$(node --check "$TARGET" 2>&1); then
  echo "$CHECK_OUTPUT" >&2
  echo "apply-session-decay.sh: node --check failed after patch — restoring previous file" >&2
  cp "$TARGET.bak.session-decay" "$TARGET"
  exit 4
fi

echo "apply-session-decay.sh: patched $TARGET"
