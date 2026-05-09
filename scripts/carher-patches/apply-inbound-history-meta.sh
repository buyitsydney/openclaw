#!/bin/bash
# scripts/carher-patches/apply-inbound-history-meta.sh
#
# Patch OpenClaw's built get-reply bundle so structured InboundHistory entries
# expose message_id/message_type/reply_to_id in the JSON block the agent sees.
# Source builds that already include these fields are left untouched.
#
# Usage:
#   bash apply-inbound-history-meta.sh /app/dist/get-reply-*.js

set -euo pipefail

if [ "${CARHER_DISABLE_INBOUND_HISTORY_META_PATCH:-0}" = "1" ]; then
  echo "apply-inbound-history-meta.sh: disabled via CARHER_DISABLE_INBOUND_HISTORY_META_PATCH"
  exit 0
fi

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-inbound-history-meta.sh: target not found: $TARGET" >&2
  exit 2
fi

MARKER="CARHER_INBOUND_HISTORY_META_PATCH_MARKER"

if grep -q "$MARKER" "$TARGET"; then
  echo "apply-inbound-history-meta.sh: already patched ($TARGET)"
  exit 0
fi

if grep -q "message_id: normalizePromptMetadataString(entry.messageId)" "$TARGET"; then
  echo "apply-inbound-history-meta.sh: source build already includes history metadata ($TARGET)"
  exit 0
fi

BACKUP="${TARGET}.bak.inbound-history-meta"
cp "$TARGET" "$BACKUP"

awk -v marker="$MARKER" '
  BEGIN { inserted = 0; inHistoryBlock = 0 }
  index($0, "Chat history since last reply (untrusted, for context):") > 0 {
    inHistoryBlock = 1
  }
  inHistoryBlock && !inserted && index($0, "sender: sanitizePromptBody(entry.sender),") > 0 {
    print "\t\t// === " marker " ==="
    print "\t\tmessage_id: normalizePromptMetadataString(entry.messageId),"
    print "\t\tmessage_type: normalizePromptMetadataString(entry.messageType),"
    print "\t\treply_to_id: normalizePromptMetadataString(entry.replyToId),"
    print "\t\t// === end " marker " ==="
    inserted = 1
  }
  { print }
  END { if (!inserted) exit 42 }
' "$BACKUP" > "$TARGET" || {
  echo "apply-inbound-history-meta.sh: history render anchor not found in $TARGET — upstream may have moved" >&2
  cp "$BACKUP" "$TARGET"
  exit 3
}

if ! node --check "$TARGET" 2>/dev/null; then
  echo "apply-inbound-history-meta.sh: node --check failed after patch — restoring backup" >&2
  cp "$BACKUP" "$TARGET"
  exit 4
fi

echo "apply-inbound-history-meta.sh: patched $TARGET"
