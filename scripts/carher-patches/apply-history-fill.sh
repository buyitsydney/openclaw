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
# Idempotent: re-running is a no-op. Marker: CARHER_HISTORY_FILL_PATCH_MARKER.
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

MARKER="CARHER_HISTORY_FILL_PATCH_MARKER"

if grep -q "$MARKER" "$TARGET"; then
  echo "apply-history-fill.sh: already patched ($TARGET)"
  exit 0
fi

ANCHOR="// 4. Build main envelope (with group chat history)"
if ! grep -qF "$ANCHOR" "$TARGET"; then
  echo "apply-history-fill.sh: anchor not found in $TARGET — upstream may have moved" >&2
  exit 3
fi

BACKUP="${TARGET}.bak.history-fill"
cp "$TARGET" "$BACKUP"

# Insert the patch block BEFORE the anchor comment line. Using awk to avoid
# sed portability headaches across BSD/GNU when embedding multi-line content.
awk -v marker="$MARKER" -v anchor="$ANCHOR" '
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
' "$BACKUP" > "$TARGET"

# Syntax check — if node rejects the patched file, restore backup immediately.
if ! node --check "$TARGET" 2>/dev/null; then
  echo "apply-history-fill.sh: node --check failed after patch — restoring backup" >&2
  cp "$BACKUP" "$TARGET"
  exit 4
fi

echo "apply-history-fill.sh: patched $TARGET"
