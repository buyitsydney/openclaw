#!/bin/bash
# patch-agent-loop.sh — In-place patch pi-agent-core agent-loop.js
#
# Adds a globalThis fallback for config.getFollowUpMessages so that any
# AgentLoopConfig constructed without that field automatically routes
# through our stop-hook-pipeline when the loop is about to stop.
#
# Idempotent: re-running is safe (marker detection skips already-patched files).
# Reversible: original file preserved as .orig.<timestamp> backup.
# Version-strict: pattern match failure -> exit 0 (skip) rather than mangle file.
# Portable: uses node for text replacement (no sed -i / awk portability pain).
#
# See docs/her/stop-hook-pipeline-architecture.md for rationale.

set -euo pipefail

TARGET="${OPENCLAW_AGENT_LOOP_PATH:-/app/node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js}"

log() { echo "[patch-agent-loop] $*"; }

if [[ ! -f "$TARGET" ]]; then
  log "SKIP: $TARGET does not exist (pi-agent-core not installed or path changed)"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  log "ERROR: node not found on PATH"
  exit 1
fi

BACKUP="${TARGET}.orig.$(date +%s)"

# Use node for the in-place edit — portable across mac/linux, handles exact strings.
TARGET="$TARGET" BACKUP="$BACKUP" node - <<'NODE_EOF'
const fs = require("node:fs");
const target = process.env.TARGET;
const backup = process.env.BACKUP;
const MARKER = "globalThis.__openclaw_stopHookPipeline";
const OLD = "const followUpMessages = (await config.getFollowUpMessages?.()) || [];";
// The wrapper runs the original getFollowUpMessages first (if it exists) and only
// falls through to globalThis.__openclaw_stopHookPipeline when the original returned
// empty. This preserves SDK default behavior (followUpQueue.drain from Agent class)
// while still letting our plugin-owned pipeline inject continuation messages when
// the queue is empty.
const NEW = "const followUpMessages = await (async () => { const __orig = config.getFollowUpMessages ? await config.getFollowUpMessages() : []; if (__orig && __orig.length > 0) return __orig; const __gp = globalThis.__openclaw_stopHookPipeline; return (__gp ? await __gp() : []) || []; })();";

const src = fs.readFileSync(target, "utf-8");

if (src.includes(MARKER)) {
  console.log(`[patch-agent-loop] SKIP: ${target} already patched`);
  process.exit(0);
}

if (!src.includes(OLD)) {
  console.log(`[patch-agent-loop] WARN: expected pattern not found — pi-agent-core SDK may have been upgraded; leaving file alone`);
  console.log(`[patch-agent-loop]   expected: ${OLD}`);
  console.log(`[patch-agent-loop]   → stop-hook-pipeline will silently no-op until this script is updated for the new pattern`);
  process.exit(0);
}

fs.copyFileSync(target, backup);
console.log(`[patch-agent-loop] backup: ${backup}`);

const out = src.replace(OLD, NEW);
if (out === src) {
  console.log(`[patch-agent-loop] ERROR: replace produced identical output`);
  process.exit(2);
}
fs.writeFileSync(target, out, "utf-8");

const verify = fs.readFileSync(target, "utf-8");
if (verify.includes(MARKER)) {
  console.log(`[patch-agent-loop] PATCHED ${target}`);
  process.exit(0);
}

console.log(`[patch-agent-loop] ERROR: post-write verification failed; restoring backup`);
fs.copyFileSync(backup, target);
process.exit(1);
NODE_EOF
