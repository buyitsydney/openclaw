#!/bin/bash
# scripts/carher-patches/apply-history-fill.sh
#
# Inject a single-line call to ./carher-history-fill.js.fillChatHistoryIfSparse
# immediately BEFORE the `buildEnvelopeWithHistory(...)` invocation in
# @larksuite/openclaw-lark's dispatch.js, restoring the 20-msg proactive
# history fill that feishu-her used to do before the channel migration.
#
# Usage:
#   bash apply-history-fill.sh <path-to-dispatch.js>
#
# The companion helper (history-fill-helper.js) must already be copied to
#   <dispatch.js's dir>/carher-history-fill.js
# in the container; carher-entrypoint.sh is responsible for that copy.
#
# Idempotent: re-running is a no-op.
# Markers:
#   CARHER_HISTORY_FILL_PATCH_MARKER  — proactive history fill call
#   CARHER_HISTORY_META_PATCH_MARKER  — pass message_id/msg_type/reply_to into InboundHistory
#
# Kill switch (read at patch time, not runtime):
#   CARHER_DISABLE_HISTORY_FILL_PATCH=1  → script exits 0 without changes

set -euo pipefail

if [ "${CARHER_DISABLE_HISTORY_FILL_PATCH:-0}" = "1" ]; then
  echo "apply-history-fill.sh: disabled via CARHER_DISABLE_HISTORY_FILL_PATCH"
  exit 0
fi

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-history-fill.sh: target not found: $TARGET" >&2
  exit 2
fi

FILL_MARKER="CARHER_HISTORY_FILL_PATCH_MARKER"
META_MARKER="CARHER_HISTORY_META_PATCH_MARKER"
QUOTED_CARD_MARKER="CARHER_QUOTED_CARD_CONTENT_CLEANUP_PATCH_MARKER"

ANCHOR="// 4. Build main envelope (with group chat history)"
if ! grep -qF "$ANCHOR" "$TARGET"; then
  echo "apply-history-fill.sh: anchor not found in $TARGET — upstream may have moved" >&2
  exit 3
fi

BACKUP="${TARGET}.bak.history-fill"
cp "$TARGET" "$BACKUP"

if grep -q "$FILL_MARKER" "$TARGET"; then
  echo "apply-history-fill.sh: fill already patched ($TARGET)"
else
  # Insert the patch block BEFORE the anchor comment line. Using awk to avoid
  # sed portability headaches across BSD/GNU when embedding multi-line content.
  awk -v marker="$FILL_MARKER" -v anchor="$ANCHOR" '
    BEGIN { inserted = 0 }
    !inserted && index($0, anchor) > 0 {
      print "    // === " marker " ==="
      print "    // Proactive 20-msg group history fill (restores feishu-her pre-migration behavior)."
      print "    // Kill switch at runtime: set CARHER_DISABLE_HISTORY_FILL=1 in env."
      print "    if (process.env.CARHER_DISABLE_HISTORY_FILL !== \"1\") {"
      print "        try {"
      print "            await require(\"./carher-history-fill.js\").fillChatHistoryIfSparse({ dc, params });"
      print "        } catch (_err) { /* silent: degrade to since-last-reply behavior */ }"
      print "    }"
      print "    // === end " marker " ==="
      inserted = 1
    }
    { print }
  ' "$TARGET" > "${TARGET}.tmp.history-fill"
  mv "${TARGET}.tmp.history-fill" "$TARGET"
fi

if grep -q "$META_MARKER" "$TARGET"; then
  echo "apply-history-fill.sh: history metadata already patched ($TARGET)"
else
  awk -v marker="$META_MARKER" '
    BEGIN { inserted = 0; inInboundHistory = 0 }
    index($0, "const inboundHistory =") > 0 { inInboundHistory = 1 }
    inInboundHistory && !inserted && index($0, "timestamp: entry.timestamp ?? Date.now(),") > 0 {
      print
      print "            // === " marker " ==="
      print "            messageId: entry.messageId,"
      print "            messageType: entry.messageType,"
      print "            replyToId: entry.replyToId,"
      print "            // === end " marker " ==="
      inserted = 1
      next
    }
    inInboundHistory && index($0, ": undefined;") > 0 { inInboundHistory = 0 }
    { print }
    END { if (!inserted) exit 42 }
  ' "$TARGET" > "${TARGET}.tmp.history-meta" || {
    echo "apply-history-fill.sh: history metadata anchor not found in $TARGET — upstream may have moved" >&2
    cp "$BACKUP" "$TARGET"
    rm -f "${TARGET}.tmp.history-meta" "${TARGET}.tmp.history-fill"
    exit 5
  }
  mv "${TARGET}.tmp.history-meta" "$TARGET"
fi

LOOKUP_TARGET="${CARHER_LARK_MESSAGE_LOOKUP_TARGET:-$(dirname "$TARGET")/../shared/message-lookup.js}"
if [ ! -f "$LOOKUP_TARGET" ]; then
  echo "apply-history-fill.sh: message lookup target not found ($LOOKUP_TARGET) — quoted card cleanup skipped"
elif grep -q "$QUOTED_CARD_MARKER" "$LOOKUP_TARGET"; then
  echo "apply-history-fill.sh: quoted card cleanup already patched ($LOOKUP_TARGET)"
elif grep -q "carherStripFlattenedEngineCardFooter(content)" "$LOOKUP_TARGET"; then
  echo "apply-history-fill.sh: source build already cleans quoted card content ($LOOKUP_TARGET)"
else
  LOOKUP_BACKUP="${LOOKUP_TARGET}.bak.quoted-card-cleanup"
  cp "$LOOKUP_TARGET" "$LOOKUP_BACKUP"
  python3 - "$LOOKUP_BACKUP" "$LOOKUP_TARGET" "$QUOTED_CARD_MARKER" <<'PY' || {
import sys

backup, target, marker = sys.argv[1:4]
text = open(backup, encoding="utf-8").read()
helper_anchor = 'const accounts_1 = require("../../core/accounts.js");'
helper = f'''const accounts_1 = require("../../core/accounts.js");
// === {marker} ===
function carherNormalizeFlattenedCardFooterText(value) {{
    return String(value).replace(/<\\/?font\\b[^>]*>/gi, "").replaceAll("**", "").split(/\\s+/).join(" ");
}}
function carherIsEngineFooterText(value) {{
    const normalized = carherNormalizeFlattenedCardFooterText(value.trim());
    return normalized.includes("·") && (normalized.startsWith("🦞 OpenClaw") || normalized.startsWith("☤ Hermes"));
}}
function carherNormalizeFlattenedCardShellBody(value) {{
    return String(value).replace(/\\\\r\\\\n|\\\\n|\\\\r/g, "\\n");
}}
function carherStripFlattenedEngineCardFooter(value) {{
    if (typeof value !== "string")
        return value;
    const withoutClosingCard = value.replace(/\\s*<\\/card>\\s*$/i, "");
    if (withoutClosingCard === value)
        return value;
    const openCardMatch = withoutClosingCard.match(/^\\s*(?:(\\[message_id=[^\\]]+\\])\\s*)?<card\\b[^>]*>\\s*/i);
    if (!openCardMatch)
        return value;
    const shellBody = carherNormalizeFlattenedCardShellBody(withoutClosingCard.slice(openCardMatch[0].length));
    const separatorIndex = shellBody.lastIndexOf("---");
    if (separatorIndex === -1)
        return value;
    const body = shellBody.slice(0, separatorIndex);
    const footer = shellBody.slice(separatorIndex + 3);
    if (!carherIsEngineFooterText(footer))
        return value;
    const messagePrefix = openCardMatch[1] ? openCardMatch[1].trim() : "";
    return messagePrefix ? `${{messagePrefix}} ${{body.trim()}}`.trim() : body.trim();
}}
// === end {marker} ==='''
convert_anchor = "    const { content } = await (0, content_converter_1.convertMessageContent)(rawContent, msgType, ctx);"
convert_replacement = f'''    const {{ content }} = await (0, content_converter_1.convertMessageContent)(rawContent, msgType, ctx);
    // === {marker} render ===
    const carherContent = msgType === 'interactive' ? carherStripFlattenedEngineCardFooter(content) : content;
    // === end {marker} render ==='''
content_anchor = "        content,"
content_replacement = "        content: carherContent,"
if helper_anchor not in text:
    raise SystemExit("message-lookup helper anchor not found")
if convert_anchor not in text:
    raise SystemExit("message-lookup convert anchor not found")
if content_anchor not in text:
    raise SystemExit("message-lookup content return anchor not found")
text = text.replace(helper_anchor, helper, 1)
text = text.replace(convert_anchor, convert_replacement, 1)
text = text.replace(content_anchor, content_replacement, 1)
open(target, "w", encoding="utf-8").write(text)
PY
    echo "apply-history-fill.sh: quoted card cleanup anchor not found in $LOOKUP_TARGET — upstream may have moved" >&2
    cp "$LOOKUP_BACKUP" "$LOOKUP_TARGET"
    exit 6
  }
  if ! node --check "$LOOKUP_TARGET" 2>/dev/null; then
    echo "apply-history-fill.sh: node --check failed for quoted card cleanup — restoring backup" >&2
    cp "$LOOKUP_BACKUP" "$LOOKUP_TARGET"
    exit 7
  fi
  echo "apply-history-fill.sh: patched quoted card cleanup ($LOOKUP_TARGET)"
fi

# Syntax check — if node rejects the patched file, restore backup immediately.
if ! node --check "$TARGET" 2>/dev/null; then
  echo "apply-history-fill.sh: node --check failed after patch — restoring backup" >&2
  cp "$BACKUP" "$TARGET"
  exit 4
fi

echo "apply-history-fill.sh: patched $TARGET"
