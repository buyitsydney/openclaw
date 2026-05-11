#!/bin/bash
# scripts/carher-patches/apply-inbound-history-meta.sh
#
# Patch OpenClaw's built bundles so:
# 1. structured InboundHistory entries expose message_id/message_type/reply_to_id
#    in the JSON block the agent sees.
# 2. replayed session history never re-injects stale Feishu runtime-context
#    blocks from previous turns.
# Source builds that already include either behavior are left untouched.
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
REPLAY_MARKER="CARHER_REPLAY_CONTEXT_FILTER_PATCH_MARKER"

patch_replay_context_filter() {
  local dist_dir replay_target replay_backup
  dist_dir="$(dirname "$TARGET")"
  replay_target="$(grep -RIl "async function sanitizeSessionHistory(params)" "$dist_dir" 2>/dev/null | grep -v '\.bak\.' | head -1 || true)"
  if [ -z "$replay_target" ] || [ ! -f "$replay_target" ]; then
    echo "apply-inbound-history-meta.sh: replay-history bundle not found under $dist_dir — replay context filter skipped" >&2
    return 0
  fi
  if grep -q "$REPLAY_MARKER" "$replay_target"; then
    echo "apply-inbound-history-meta.sh: replay context filter already patched ($replay_target)"
    return 0
  fi
  if grep -q 'customType !== "openclaw.runtime-context"' "$replay_target"; then
    echo "apply-inbound-history-meta.sh: source build already filters replay runtime context ($replay_target)"
    return 0
  fi

  replay_backup="${replay_target}.bak.replay-context-filter"
  cp "$replay_target" "$replay_backup"

  python3 - "$replay_backup" "$replay_target" "$REPLAY_MARKER" <<'PY' || {
import sys

backup, target, marker = sys.argv[1:4]
text = open(backup, encoding="utf-8").read()
anchor = '\tconst withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);'
replacement = f'''\tconst withInterSessionMarkers = annotateInterSessionUserMessages(params.messages)
\t\t.filter((message) => message?.customType !== "openclaw.runtime-context")
\t\t.map((message) => {{
\t\t\tif (message?.role !== "user" || typeof message?.content !== "string") return message;
\t\t\tconst content = message.content;
\t\t\tconst stripped = content
\t\t\t\t.replace(/(?:^|\\n)Conversation info \\(untrusted metadata\\):\\n```json\\n[\\s\\S]*?\\n```\\n*/g, "\\n")
\t\t\t\t.replace(/(?:^|\\n)Chat history since last reply \\(untrusted, for context\\):\\n```json\\n[\\s\\S]*?\\n```\\n*/g, "\\n");
\t\t\tconst cleaned = stripped === content ? content : stripped.trimStart();
\t\t\treturn cleaned === content ? message : {{ ...message, content: cleaned }};
\t\t}});
\t// === {marker} ==='''
if anchor not in text:
    raise SystemExit("sanitizeSessionHistory anchor not found")
open(target, "w", encoding="utf-8").write(text.replace(anchor, replacement, 1))
PY
    echo "apply-inbound-history-meta.sh: replay context filter anchor not found in $replay_target — upstream may have moved" >&2
    cp "$replay_backup" "$replay_target"
    return 3
  }

  if ! node --check "$replay_target"; then
    echo "apply-inbound-history-meta.sh: node --check failed for replay filter — restoring backup" >&2
    cp "$replay_backup" "$replay_target"
    return 4
  fi
  echo "apply-inbound-history-meta.sh: patched replay context filter ($replay_target)"
}

if grep -q "$MARKER" "$TARGET"; then
  echo "apply-inbound-history-meta.sh: history metadata already patched ($TARGET)"
elif grep -q "message_id: normalizePromptMetadataString(entry.messageId)" "$TARGET"; then
  echo "apply-inbound-history-meta.sh: source build already includes history metadata ($TARGET)"
else
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

  echo "apply-inbound-history-meta.sh: patched history metadata ($TARGET)"
fi

patch_replay_context_filter
