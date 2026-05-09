#!/bin/bash
# CARHER PATCH: make direct openclaw-lark outbound text use Feishu cards.
#
# Cron/announce delivery enters OpenClaw core deliverOutboundPayloads and then
# calls @larksuite/openclaw-lark's outbound adapter directly. That adapter's
# sendText path calls sendTextLark, which emits msg_type="post" for ordinary
# text. Normal realtime replies are already cardified by reply-card-default
# and CardKit streaming; this patch aligns proactive/cron text-only sends.
#
# Target package file: @larksuite/openclaw-lark/src/messaging/outbound/outbound.js
# Marker: CARHER_OUTBOUND_CARD_DEFAULT_PATCH_MARKER
# Kill switch: CARHER_DISABLE_OUTBOUND_CARD_DEFAULT_PATCH=1

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-outbound-card-default.sh: target not found: $TARGET" >&2
  exit 2
fi

if [ "${CARHER_DISABLE_OUTBOUND_CARD_DEFAULT_PATCH:-0}" = "1" ]; then
  echo "apply-outbound-card-default.sh: disabled via CARHER_DISABLE_OUTBOUND_CARD_DEFAULT_PATCH"
  exit 0
fi

node - "$TARGET" <<'NODE'
const fs = require("fs");

const [path] = process.argv.slice(2);
const marker = "CARHER_OUTBOUND_CARD_DEFAULT_PATCH_MARKER";
let code = fs.readFileSync(path, "utf8");

if (code.includes(marker)) {
  console.log(`apply-outbound-card-default.sh: already patched (${path})`);
  process.exit(0);
}

const backupPath = `${path}.bak.outbound-card-default`;
if (!fs.existsSync(backupPath)) {
  fs.writeFileSync(backupPath, code);
}

const adapterAnchor = `// ---------------------------------------------------------------------------
// Adapter`;
if (!code.includes(adapterAnchor)) {
  throw new Error("outbound adapter anchor not found");
}

const helperBlock = `// === ${marker}:helpers ===
function carherLooksLikeCardJson(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw.startsWith('{') || !raw.endsWith('}'))
        return false;
    try {
        const parsed = JSON.parse(raw);
        return Boolean(parsed && typeof parsed === 'object' &&
            (parsed.schema === '2.0' || parsed.config || parsed.elements || parsed.body));
    }
    catch {
        return false;
    }
}
function carherBuildOutboundTextCard(text) {
    return {
        schema: '2.0',
        config: { wide_screen_mode: true },
        body: {
            elements: [
                {
                    tag: 'markdown',
                    content: text,
                },
            ],
        },
    };
}
async function carherSendOutboundTextLark(params) {
    const text = typeof params.text === 'string' ? params.text : '';
    if (!text.trim() || carherLooksLikeCardJson(text)) {
        return await (0, deliver_1.sendTextLark)(params);
    }
    return await (0, deliver_1.sendCardLark)({
        ...params,
        card: carherBuildOutboundTextCard(text),
    });
}
// === end ${marker}:helpers ===

`;

code = code.replace(adapterAnchor, () => `${helperBlock}${adapterAnchor}`);

const exactTextSend =
  `const result = await (0, deliver_1.sendTextLark)({ ...ctx, to: ctx.to, text });`;
if (!code.includes(exactTextSend)) {
  throw new Error("text-only outbound send anchor not found");
}
code = code.split(exactTextSend).join(
  `const result = await carherSendOutboundTextLark({ ...ctx, to: ctx.to, text });`,
);

const mediaNoUrlSend =
  `const result = await (0, deliver_1.sendTextLark)({ ...ctx, to: ctx.to, text: text ?? '' });`;
if (code.includes(mediaNoUrlSend)) {
  code = code.split(mediaNoUrlSend).join(
    `const result = await carherSendOutboundTextLark({ ...ctx, to: ctx.to, text: text ?? '' });`,
  );
}

fs.writeFileSync(path, code);
console.log(`apply-outbound-card-default.sh: patched ${path}`);
NODE

if ! CHECK_OUTPUT=$(node --check "$TARGET" 2>&1); then
  echo "$CHECK_OUTPUT" >&2
  echo "apply-outbound-card-default.sh: node --check failed after patch — restoring backup" >&2
  [ -f "$TARGET.bak.outbound-card-default" ] && cp "$TARGET.bak.outbound-card-default" "$TARGET"
  exit 4
fi
