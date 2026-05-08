#!/bin/bash
# scripts/carher-patches/apply-system-command-ack.sh
#
# R-8 patch: visible ack for lifecycle system commands.
#
# Problem: core's native /new and /reset handlers do a silent session reset
# — they do NOT emit any onBlockReply / onFinalReply. Feishu-lark's
# dispatchSystemCommand therefore exits with delivered=false and the user
# sees no confirmation in the group.
#
# Fix: after dispatchReplyWithBufferedBlockDispatcher resolves, if
# `delivered` is still false AND the user-visible content is /new or
# /reset, send a tiny ack text via sendMessageFeishu. Other commands
# (/status, /help, /model, etc.) are NOT touched — they already deliver
# their own card/text via the inline reply path.
#
# Usage:  bash apply-system-command-ack.sh <path-to-dispatch-commands.js>
# Idempotent via CARHER_SYSTEM_COMMAND_ACK_PATCH_MARKER.
# Kill switch (at apply time): CARHER_DISABLE_SYSTEM_COMMAND_ACK_PATCH=1

set -euo pipefail

if [ "${CARHER_DISABLE_SYSTEM_COMMAND_ACK_PATCH:-0}" = "1" ]; then
  echo "apply-system-command-ack.sh: disabled via CARHER_DISABLE_SYSTEM_COMMAND_ACK_PATCH"
  exit 0
fi

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-system-command-ack.sh: target not found: $TARGET" >&2
  exit 2
fi

MARKER="CARHER_SYSTEM_COMMAND_ACK_PATCH_MARKER"

if grep -q "$MARKER" "$TARGET"; then
  echo "apply-system-command-ack.sh: already patched ($TARGET)"
  exit 0
fi

# Inject right BEFORE the "system command dispatched" log line.
ANCHOR='dc.log(`feishu[${dc.account.accountId}]: system command dispatched (delivered=${delivered})`);'
if ! grep -qF "$ANCHOR" "$TARGET"; then
  echo "apply-system-command-ack.sh: anchor not found in $TARGET — upstream may have moved" >&2
  exit 3
fi

BACKUP="${TARGET}.bak.system-command-ack"
cp "$TARGET" "$BACKUP"

awk -v marker="$MARKER" -v anchor="$ANCHOR" '
  BEGIN { inserted = 0 }
  !inserted && index($0, anchor) > 0 {
    n = match($0, /[^[:space:]]/)
    indent = substr($0, 1, n - 1)
    print indent "// === " marker " ==="
    print indent "// Core /new and /reset are silent in Feishu: they reset the session"
    print indent "// without emitting any reply payload → delivered=false → user sees"
    print indent "// nothing in the group. Send a tiny ack text for these two commands"
    print indent "// only, and only when nothing else was delivered."
    print indent "if (!delivered) {"
    print indent "    const __carherCmdContent = (dc.ctx.content || \"\").trim();"
    print indent "    const __carherLifecycleMatch = __carherCmdContent.match(/^\\/(new|reset)\\b/i);"
    print indent "    if (__carherLifecycleMatch) {"
    print indent "        const __carherAckText = __carherLifecycleMatch[1].toLowerCase() === \"new\""
    print indent "            ? \"✓ 新 session 已开启。\""
    print indent "            : \"✓ Session 已重置。\";"
    print indent "        try {"
    print indent "            await (0, send_1.sendMessageFeishu)({"
    print indent "                cfg: dc.accountScopedCfg,"
    print indent "                to: dc.ctx.chatId,"
    print indent "                text: __carherAckText,"
    print indent "                replyToMessageId: replyToMessageId ?? dc.ctx.messageId,"
    print indent "                accountId: dc.account.accountId,"
    print indent "                replyInThread: dc.isThread,"
    print indent "            });"
    print indent "            delivered = true;"
    print indent "        } catch (_err) { /* silent — ack is best-effort */ }"
    print indent "    }"
    print indent "}"
    print indent "// === end " marker " ==="
    inserted = 1
  }
  { print }
' "$BACKUP" > "$TARGET"

if ! node --check "$TARGET" 2>/dev/null; then
  echo "apply-system-command-ack.sh: node --check failed after patch — restoring backup" >&2
  cp "$BACKUP" "$TARGET"
  exit 4
fi

echo "apply-system-command-ack.sh: patched $TARGET"
