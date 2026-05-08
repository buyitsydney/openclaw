#!/bin/bash
# scripts/carher-patches/apply-command-probe.sh
#
# R-7 patch: classify slash commands via a mention-stripped probe body.
#
# Problem: with stripBotMentions=false (R-1) group messages keep their
# trailing `@bot` tokens in ctx.content. Core's `isControlCommandMessage`
# sees "/status @弋天的her" and refuses it because /status takes no args.
# Result: isCommand=false → message falls through to `dispatchNormalMessage`
# → agent runs → NO_REPLY in group chat.
#
# Fix: before the `isCommand` check, build a probe body with `@xxx` tokens
# stripped, and feed that to `isControlCommandMessage`. Downstream
# dispatchSystemCommand / ctxPayload is untouched, so the original content
# (with @mention) still reaches core — that's fine; core's /status native
# handler matches by prefix and ignores the tail.
#
# Usage:  bash apply-command-probe.sh <path-to-dispatch.js>
# Idempotent via CARHER_COMMAND_PROBE_PATCH_MARKER.
# Kill switch (at apply time): CARHER_DISABLE_COMMAND_PROBE_PATCH=1

set -euo pipefail

if [ "${CARHER_DISABLE_COMMAND_PROBE_PATCH:-0}" = "1" ]; then
  echo "apply-command-probe.sh: disabled via CARHER_DISABLE_COMMAND_PROBE_PATCH"
  exit 0
fi

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-command-probe.sh: target not found: $TARGET" >&2
  exit 2
fi

MARKER="CARHER_COMMAND_PROBE_PATCH_MARKER"

if grep -q "$MARKER" "$TARGET"; then
  echo "apply-command-probe.sh: already patched ($TARGET)"
  exit 0
fi

# Statement-start anchor (the `const isCommand = ...` line). Inject the
# probe variable above it, and rewrite its 2nd line's argument in the same
# pass. Matching by line 1 avoids corrupting a multi-line expression.
ANCHOR_DECL="const isCommand = !isCommentFlow &&"
ANCHOR_CALL="dc.core.channel.commands.isControlCommandMessage(params.ctx.content, params.accountScopedCfg);"
if ! grep -qF "$ANCHOR_DECL" "$TARGET" || ! grep -qF "$ANCHOR_CALL" "$TARGET"; then
  echo "apply-command-probe.sh: anchor not found in $TARGET — upstream may have moved" >&2
  exit 3
fi

BACKUP="${TARGET}.bak.command-probe"
cp "$TARGET" "$BACKUP"

awk -v marker="$MARKER" -v decl="$ANCHOR_DECL" '
  BEGIN { seen_decl = 0; injected = 0 }
  # Inject probe block ABOVE the `const isCommand = !isCommentFlow &&` line.
  !injected && index($0, decl) > 0 {
    n = match($0, /[^[:space:]]/)
    indent = substr($0, 1, n - 1)
    print indent "// === " marker " ==="
    print indent "// Strip @xxx mentions so `/status @bot` is still classified as"
    print indent "// /status. Does not mutate downstream ctxPayload."
    print indent "const __carherCmdProbeBody = ((params.ctx.content || \"\") + \"\").replace(/@[^\\s@]+/g, \"\").trim();"
    print indent "// === end " marker " ==="
    injected = 1
    seen_decl = 1
    print
    next
  }
  # On the very next non-blank line after the decl we expect the
  # isControlCommandMessage call — rewrite its first arg.
  seen_decl && /params\.ctx\.content/ {
    gsub(/params\.ctx\.content/, "__carherCmdProbeBody", $0)
    seen_decl = 0
    print
    next
  }
  { print }
' "$BACKUP" > "$TARGET"

if ! node --check "$TARGET" 2>/dev/null; then
  echo "apply-command-probe.sh: node --check failed after patch — restoring backup" >&2
  cp "$BACKUP" "$TARGET"
  exit 4
fi

echo "apply-command-probe.sh: patched $TARGET"
