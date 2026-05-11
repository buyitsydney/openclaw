#!/bin/bash
# scripts/carher-patches/apply-history-fill-dm.sh
#
# Extend the group history fill patch to cover DMs and thread contexts when
# running inside carher-runtime. This is opt-in at runtime:
#
#   CARHER_DUAL_ENGINE_HISTORY_FILL=1
#
# Without that env var the patch preserves the solo OpenClaw behavior and keeps
# the original 20-message history budget.

set -euo pipefail

if [ "${CARHER_DISABLE_HISTORY_FILL_DM_PATCH:-0}" = "1" ]; then
  echo "apply-history-fill-dm.sh: disabled via CARHER_DISABLE_HISTORY_FILL_DM_PATCH"
  exit 0
fi

TARGET_DIR="${1:-}"
if [ -z "$TARGET_DIR" ]; then
  for candidate in \
      "${OPENCLAW_DIST_DIR:-}" \
      "/opt/openclaw/lib/node_modules/openclaw/dist" \
      "/app/dist"; do
    [ -z "$candidate" ] && continue
    if [ -f "$candidate/carher-history-fill.js" ]; then
      TARGET_DIR="$candidate"
      break
    fi
    for hd in "$candidate" "$candidate/.."; do
      lark_helper=$(find "$hd" -path "*openclaw-lark/dist/messaging/inbound/carher-history-fill.js" 2>/dev/null | head -1)
      if [ -n "$lark_helper" ]; then
        TARGET_DIR=$(dirname "$lark_helper")
        break 2
      fi
    done
  done
fi

if [ -z "$TARGET_DIR" ] || [ ! -d "$TARGET_DIR" ]; then
  echo "apply-history-fill-dm.sh: target dir not found: '$TARGET_DIR'" >&2
  exit 2
fi

HELPER="$TARGET_DIR/carher-history-fill.js"
DISPATCH_BUILDERS="$TARGET_DIR/dispatch-builders.js"
DISPATCH="$TARGET_DIR/dispatch.js"
if [ ! -f "$HELPER" ]; then
  echo "apply-history-fill-dm.sh: $HELPER not found — apply-history-fill.sh must run first" >&2
  exit 3
fi
if [ ! -f "$DISPATCH_BUILDERS" ]; then
  echo "apply-history-fill-dm.sh: $DISPATCH_BUILDERS not found — cannot inject DM history into prompt" >&2
  exit 7
fi
if [ ! -f "$DISPATCH" ]; then
  echo "apply-history-fill-dm.sh: $DISPATCH not found — cannot inject DM InboundHistory metadata" >&2
  exit 8
fi

MARKER="CARHER_HISTORY_FILL_DM_PATCH_MARKER"
INJECT_MARKER="CARHER_HISTORY_FILL_DM_INJECT_PATCH_MARKER"

helper_patched=0
if grep -q "$MARKER" "$HELPER"; then
  helper_patched=1
  echo "apply-history-fill-dm.sh: helper already patched ($HELPER)"
fi

if [ "$helper_patched" = "0" ]; then
  cp "$HELPER" "$HELPER.bak.history-fill-dm"

  sed -i.tmp \
    -e 's@^const HISTORY_FILL_TARGET = 20;@// === '"$MARKER"' ===\nconst HISTORY_FILL_TARGET = parseInt(process.env.CARHER_HISTORY_FILL_LIMIT || "", 10) || (process.env.CARHER_DUAL_ENGINE_HISTORY_FILL === "1" ? 50 : 20);@' \
    "$HELPER"

  sed -i.tmp \
    -e 's@^  if (!dc.isGroup) return;@  if (!dc.isGroup \&\& process.env.CARHER_DUAL_ENGINE_HISTORY_FILL !== "1") return;@' \
    "$HELPER"

  rm -f "$HELPER.tmp"

  if ! grep -q "$MARKER" "$HELPER"; then
    echo "apply-history-fill-dm.sh: limit edit failed" >&2
    cp "$HELPER.bak.history-fill-dm" "$HELPER"
    exit 4
  fi
  if ! grep -q 'CARHER_DUAL_ENGINE_HISTORY_FILL' "$HELPER"; then
    echo "apply-history-fill-dm.sh: DM-guard edit failed" >&2
    cp "$HELPER.bak.history-fill-dm" "$HELPER"
    exit 5
  fi
fi

python3 - "$DISPATCH_BUILDERS" "$DISPATCH" "$INJECT_MARKER" <<'PY'
import re
import sys

dispatch_builders, dispatch, marker = sys.argv[1:4]

def patch_once(path, replacements, label):
    src = open(path, "r", encoding="utf-8").read()
    if marker in src:
        print(f"apply-history-fill-dm.sh: {label} already patched ({path})")
        return
    patched = None
    for old, new, mode in replacements:
        if mode == "literal" and old in src:
            patched = src.replace(old, new, 1)
            break
        if mode == "regex":
            candidate, count = re.subn(old, new, src, count=1)
            if count == 1:
                patched = candidate
                break
    if patched is None:
        raise SystemExit(f"apply-history-fill-dm.sh: {label} anchor not found in {path}")
    open(path + ".bak.history-fill-dm-inject", "w", encoding="utf-8").write(src)
    open(path, "w", encoding="utf-8").write(patched)
    print(f"apply-history-fill-dm.sh: patched {label} ({path})")

prompt_new_source = f"""  // === {marker} ===
  const carherDualHistoryFillEnabled = process.env.CARHER_DUAL_ENGINE_HISTORY_FILL === "1";
  const historyKey = dc.isGroup || carherDualHistoryFillEnabled
    ? threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined)
    : undefined;
  if ((dc.isGroup || carherDualHistoryFillEnabled) && historyKey && chatHistories) {{"""

prompt_new_compiled = f"""    // === {marker} ===
    const carherDualHistoryFillEnabled = process.env.CARHER_DUAL_ENGINE_HISTORY_FILL === "1";
    const historyKey = dc.isGroup || carherDualHistoryFillEnabled ? (0, chat_queue_1.threadScopedKey)(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined) : undefined;
    if ((dc.isGroup || carherDualHistoryFillEnabled) && historyKey && chatHistories) {{"""

patch_once(
    dispatch_builders,
    [
        ("""  const historyKey = dc.isGroup
    ? threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined)
    : undefined;
  if (dc.isGroup && historyKey && chatHistories) {""", prompt_new_source, "literal"),
        (
            r"""    const historyKey = dc\.isGroup \? \(0, chat_queue_1\.threadScopedKey\)\(dc\.ctx\.chatId, dc\.isThread \? dc\.ctx\.threadId : undefined\) : undefined;
    if \(dc\.isGroup && historyKey && chatHistories\) \{""",
            prompt_new_compiled,
            "regex",
        ),
    ],
    "dispatch-builders prompt injection",
)

history_new_source = f"""  // === {marker} ===
  const carherDualInboundHistoryFillEnabled = process.env.CARHER_DUAL_ENGINE_HISTORY_FILL === "1";
  const inboundHistory =
    (dc.isGroup || carherDualInboundHistoryFillEnabled) && params.chatHistories && params.historyLimit > 0
      ? (params.chatHistories.get(threadHistoryKey) ?? []).map((entry) => ({{"""

history_new_compiled = f"""    // === {marker} ===
    const carherDualInboundHistoryFillEnabled = process.env.CARHER_DUAL_ENGINE_HISTORY_FILL === "1";
    const inboundHistory = (dc.isGroup || carherDualInboundHistoryFillEnabled) && params.chatHistories && params.historyLimit > 0
        ? (params.chatHistories.get(threadHistoryKey) ?? []).map((entry) => ({{"""

patch_once(
    dispatch,
    [
        ("""  const inboundHistory =
    dc.isGroup && params.chatHistories && params.historyLimit > 0
      ? (params.chatHistories.get(threadHistoryKey) ?? []).map((entry) => ({""", history_new_source, "literal"),
        (
            r"""    const inboundHistory = dc\.isGroup && params\.chatHistories && params\.historyLimit > 0
        \? \(params\.chatHistories\.get\(threadHistoryKey\) \?\? \[\]\)\.map\(\(entry\) => \(\{""",
            history_new_compiled,
            "regex",
        ),
    ],
    "dispatch InboundHistory metadata injection",
)
PY

if command -v node >/dev/null 2>&1; then
  if ! node --check "$HELPER" 2>&1; then
    echo "apply-history-fill-dm.sh: node --check failed; restoring backup" >&2
    [ -f "$HELPER.bak.history-fill-dm" ] && cp "$HELPER.bak.history-fill-dm" "$HELPER"
    exit 6
  fi
  for js in "$DISPATCH_BUILDERS" "$DISPATCH"; do
    if ! node --check "$js" 2>&1; then
      echo "apply-history-fill-dm.sh: node --check failed for $js; restoring injection backup" >&2
      [ -f "$js.bak.history-fill-dm-inject" ] && cp "$js.bak.history-fill-dm-inject" "$js"
      exit 9
    fi
  done
fi

echo "apply-history-fill-dm.sh: patched $TARGET_DIR (limit 50, DM/thread history fill + prompt/context injection when CARHER_DUAL_ENGINE_HISTORY_FILL=1)"
