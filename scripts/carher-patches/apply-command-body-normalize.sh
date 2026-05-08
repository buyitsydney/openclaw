#!/bin/bash
# Normalize Feishu slash-command bodies before OpenClaw command dispatch.
#
# @larksuite/openclaw-lark keeps bot mentions in ctx.content when
# stripBotMentions=false. That is correct for normal LLM turns, but command
# dispatch must not treat the addressing mention as command args:
#   /new @弋天的her     -> CommandBody=/new
#   /status @弋天的her  -> CommandBody=/status
#
# Usage:
#   bash apply-command-body-normalize.sh <path-to-dispatch.js>

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "apply-command-body-normalize.sh: target not found: $TARGET" >&2
  exit 2
fi

if [ "${CARHER_DISABLE_COMMAND_BODY_NORMALIZE_PATCH:-0}" = "1" ]; then
  echo "apply-command-body-normalize.sh: disabled via CARHER_DISABLE_COMMAND_BODY_NORMALIZE_PATCH"
  exit 0
fi

node - "$TARGET" <<'NODE'
const fs = require("fs");

const target = process.argv[2];
const marker = "CARHER_COMMAND_BODY_NORMALIZE_PATCH_MARKER";
let code = fs.readFileSync(target, "utf8");

if (code.includes(marker)) {
  console.log(`apply-command-body-normalize.sh: already patched (${target})`);
  process.exit(0);
}

const backup = `${target}.bak.command-body-normalize`;
fs.copyFileSync(target, backup);

const helperAnchor = "const log = (0, lark_logger_1.larkLogger)('inbound/dispatch');";
const helperBlock = `${helperAnchor}
// === ${marker} ===
function carherEscapeRegExp(value) {
    return String(value).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}
function carherOwnBotMentionCandidates(ctx) {
    const mentions = Array.isArray(ctx?.mentions) ? ctx.mentions : [];
    const candidates = [];
    for (const mention of mentions) {
        if (!mention || mention.isBot !== true)
            continue;
        for (const value of [mention.key, mention.name ? \`@\${mention.name}\` : '', mention.name]) {
            if (typeof value === 'string' && value.trim())
                candidates.push(value.trim());
        }
        if (mention.openId && mention.name) {
            candidates.push(\`<at user_id="\${mention.openId}">\${mention.name}</at>\`);
            candidates.push(\`<at id=\${mention.openId}></at>\`);
        }
    }
    return [...new Set(candidates)];
}
function carherStripOwnBotMentionsForCommandBody(raw, ctx) {
    let result = typeof raw === 'string' ? raw.trim() : '';
    if (!result.startsWith('/'))
        return result;
    for (const candidate of carherOwnBotMentionCandidates(ctx)) {
        const escaped = carherEscapeRegExp(candidate);
        result = result.replace(new RegExp(\`(^|\\\\s)\${escaped}(?=\\\\s|$)\`, 'g'), '$1');
    }
    return result.replace(/\\\\s+/g, ' ').trim();
}
function carherSlashCommandTargetsAnotherMention(raw, ctx) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text.startsWith('/'))
        return false;
    const mentions = Array.isArray(ctx?.mentions) ? ctx.mentions : [];
    return mentions.length > 0 && !mentions.some((mention) => mention?.isBot === true);
}
// === end ${marker} ===`;

if (!code.includes(helperAnchor)) {
  throw new Error("helper anchor not found");
}
code = code.replace(helperAnchor, () => helperBlock);

const skipAnchor = `    // === CARHER_HISTORY_FILL_PATCH_MARKER ===`;
const skipBlock = `    if (dc.isGroup && carherSlashCommandTargetsAnotherMention(params.ctx.content, params.ctx)) {
        dc.log(\`feishu[\${dc.account.accountId}]: targeted slash command did not mention this bot, ignoring\`);
        return;
    }
${skipAnchor}`;
if (!code.includes(skipAnchor)) {
  throw new Error("targeted-command skip anchor not found");
}
code = code.replace(skipAnchor, skipBlock);

const bareResetAnchor = `    const isBareNewOrReset = /^\\/(?:new|reset)\\s*$/i.test((params.ctx.content ?? '').trim());`;
const bareResetBlock = `    const commandBody = carherStripOwnBotMentionsForCommandBody(params.ctx.content, params.ctx);
    const isBareNewOrReset = /^\\/(?:new|reset)\\s*$/i.test(commandBody);`;
if (!code.includes(bareResetAnchor)) {
  throw new Error("bare reset anchor not found");
}
code = code.replace(bareResetAnchor, bareResetBlock);

code = code.replace(
  `        commandBody: params.ctx.content,`,
  `        commandBody,`,
);

code = code.replace(
  `    const contentTrimmed = (params.ctx.content ?? '').trim();`,
  `    const contentTrimmed = commandBody.trim();`,
);

code = code.replace(
  `    const isCommand = !isCommentFlow &&
        dc.core.channel.commands.isControlCommandMessage(params.ctx.content, params.accountScopedCfg);`,
  `    const isCommand = !isCommentFlow &&
        dc.core.channel.commands.isControlCommandMessage(commandBody, params.accountScopedCfg);`,
);

fs.writeFileSync(target, code);
NODE

if ! CHECK_OUTPUT=$(node --check "$TARGET" 2>&1); then
  echo "$CHECK_OUTPUT" >&2
  echo "apply-command-body-normalize.sh: node --check failed after patch — restoring backup" >&2
  cp "$TARGET.bak.command-body-normalize" "$TARGET"
  exit 4
fi

echo "apply-command-body-normalize.sh: patched $TARGET"
