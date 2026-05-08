#!/bin/bash
# Normalize Feishu slash-command bodies before OpenClaw command dispatch.
#
# @larksuite/openclaw-lark keeps bot mentions in ctx.content when
# stripBotMentions=false. That is correct for normal LLM turns, but command
# dispatch must not treat addressing mentions as command args:
#   /new @弋天的her              -> CommandBody=/new
#   @弋天的her /new              -> CommandBody=/new
#   /new @弋天的her @研究3的her  -> CommandBody=/new
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
const marker = "CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER";
const previousMarker = "CARHER_COMMAND_BODY_NORMALIZE_PATCH_MARKER";
let code = fs.readFileSync(target, "utf8");
const originalCode = code;

if (code.includes(marker)) {
  console.log(`apply-command-body-normalize.sh: already patched (${target})`);
  process.exit(0);
}

const backup = `${target}.bak.command-body-normalize`;
const upgradeBackup = `${target}.bak.command-body-normalize-v2`;

if (code.includes(previousMarker)) {
  if (!fs.existsSync(backup)) {
    throw new Error("previous command-body patch found, but original backup is missing");
  }
  const restored = fs.readFileSync(backup, "utf8");
  if (restored.includes(previousMarker)) {
    throw new Error("previous command-body backup is already patched");
  }
  code = restored;
  console.log(`apply-command-body-normalize.sh: upgrading previous patch via ${backup}`);
}

fs.writeFileSync(upgradeBackup, originalCode);
if (!fs.existsSync(backup)) {
  fs.writeFileSync(backup, originalCode);
}

const helperAnchor = "const log = (0, lark_logger_1.larkLogger)('inbound/dispatch');";
const helperBlock = `${helperAnchor}
// === ${marker} ===
function carherEscapeRegExp(value) {
    return String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&');
}
function carherMentionCandidates(ctx) {
    const mentions = Array.isArray(ctx?.mentions) ? ctx.mentions : [];
    const candidates = [];
    for (const mention of mentions) {
        if (!mention)
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
    return [...new Set(candidates)].sort((a, b) => b.length - a.length);
}
function carherStripMentionTokens(raw, ctx) {
    let result = typeof raw === 'string' ? raw.trim() : '';
    for (const candidate of carherMentionCandidates(ctx)) {
        const escaped = carherEscapeRegExp(candidate);
        result = result.replace(new RegExp(\`(^|\\\\s)\${escaped}(?=\\\\s|$)\`, 'g'), '$1');
    }
    return result.replace(/\\\\s+/g, ' ').trim();
}
function carherStripMentionsForCommandBody(raw, ctx) {
    const original = typeof raw === 'string' ? raw.trim() : '';
    const stripped = carherStripMentionTokens(original, ctx);
    return stripped.startsWith('/') ? stripped : original;
}
function carherSlashCommandTargetsAnotherMention(raw, ctx) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!carherStripMentionTokens(text, ctx).startsWith('/'))
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
const bareResetBlock = `    const commandBody = carherStripMentionsForCommandBody(params.ctx.content, params.ctx);
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
  echo "apply-command-body-normalize.sh: node --check failed after patch — restoring previous file" >&2
  cp "$TARGET.bak.command-body-normalize-v2" "$TARGET"
  exit 4
fi

echo "apply-command-body-normalize.sh: patched $TARGET"
