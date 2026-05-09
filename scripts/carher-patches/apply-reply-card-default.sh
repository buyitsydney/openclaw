#!/bin/bash
# CARHER PATCH: make static openclaw-lark replies use Feishu interactive
# cards by default, matching the old feishu-her user-facing reply surface.
#
# Why this exists: @larksuite/openclaw-lark's static group reply path only
# chooses interactive cards for markdown tables or fenced code blocks. Plain
# answers fall back to msg_type=post, so the same Her alternates between ugly
# text posts and rich cards in one group. Old feishu-her routed normal
# user-facing text through cards too.
#
# Target: @larksuite/openclaw-lark/src/card/reply-mode.js
# Marker: CARHER_REPLY_CARD_DEFAULT_PATCH_MARKER
# Kill switch: CARHER_DISABLE_REPLY_CARD_DEFAULT_PATCH=1

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-reply-card-default.sh: target not found: $TARGET" >&2
  exit 2
fi

if [ "${CARHER_DISABLE_REPLY_CARD_DEFAULT_PATCH:-0}" = "1" ]; then
  echo "apply-reply-card-default.sh: disabled via CARHER_DISABLE_REPLY_CARD_DEFAULT_PATCH"
  exit 0
fi

node - "$TARGET" <<'NODE'
const fs = require("fs");

const target = process.argv[2];
const marker = "CARHER_REPLY_CARD_DEFAULT_PATCH_MARKER";
let code = fs.readFileSync(target, "utf8");

if (code.includes(marker)) {
  console.log(`apply-reply-card-default.sh: already patched (${target})`);
  process.exit(0);
}

const backup = `${target}.bak.reply-card-default`;
if (!fs.existsSync(backup)) {
  fs.writeFileSync(backup, code);
}

const functionStart = code.indexOf("function shouldUseCard(text)");
if (functionStart === -1) {
  throw new Error("shouldUseCard function anchor not found");
}

const braceStart = code.indexOf("{", functionStart);
if (braceStart === -1) {
  throw new Error("shouldUseCard opening brace not found");
}

let depth = 0;
let end = -1;
for (let i = braceStart; i < code.length; i += 1) {
  const ch = code[i];
  if (ch === "{") {
    depth += 1;
  } else if (ch === "}") {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}

if (end === -1) {
  throw new Error("shouldUseCard closing brace not found");
}

const patchedFunction = `function shouldUseCard(text) {
    // === ${marker} ===
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized)
        return false;
    const tableMatches = (0, card_error_1.findMarkdownTablesOutsideCodeBlocks)(text);
    if (tableMatches.length > card_error_1.FEISHU_CARD_TABLE_LIMIT)
        return false;
    const carherUseCard = true;
    // === end ${marker} ===
    return carherUseCard;
}`;

code = `${code.slice(0, functionStart)}${patchedFunction}${code.slice(end)}`;
fs.writeFileSync(target, code);
console.log(`apply-reply-card-default.sh: patched ${target}`);
NODE

if ! CHECK_OUTPUT=$(node --check "$TARGET" 2>&1); then
  echo "$CHECK_OUTPUT" >&2
  echo "apply-reply-card-default.sh: node --check failed after patch — restoring previous file" >&2
  cp "$TARGET.bak.reply-card-default" "$TARGET"
  exit 4
fi

echo "apply-reply-card-default.sh: patched $TARGET"
