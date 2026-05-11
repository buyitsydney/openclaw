#!/bin/bash
# CARHER PATCH: enrich openclaw-lark CardKit footers with Her-specific
# status fields that existed in the old feishu-her UX.
#
# Upstream openclaw-lark already supports status/elapsed/model/tokens/cache/context
# footers, but:
#   1. defaults are off (fleet config enables them), and
#   2. footer metrics do not include compaction count or CarHer group mode.
#
# Target package: @larksuite/openclaw-lark
#   - src/card/streaming-card-controller.js
#   - src/card/builder.js
# Marker: CARHER_FOOTER_STATUS_PATCH_MARKER
# Kill switch: CARHER_DISABLE_FOOTER_STATUS_PATCH=1

set -euo pipefail

LARK_PKG="${1:-}"
if [ -z "$LARK_PKG" ] || [ ! -d "$LARK_PKG" ]; then
  echo "apply-footer-status.sh: package dir not found: $LARK_PKG" >&2
  exit 2
fi

if [ "${CARHER_DISABLE_FOOTER_STATUS_PATCH:-0}" = "1" ]; then
  echo "apply-footer-status.sh: disabled via CARHER_DISABLE_FOOTER_STATUS_PATCH"
  exit 0
fi

CONTROLLER="$LARK_PKG/src/card/streaming-card-controller.js"
BUILDER="$LARK_PKG/src/card/builder.js"
for f in "$CONTROLLER" "$BUILDER"; do
  if [ ! -f "$f" ]; then
    echo "apply-footer-status.sh: target not found: $f" >&2
    exit 2
  fi
done

node - "$CONTROLLER" "$BUILDER" <<'NODE'
const fs = require("fs");

const [controllerPath, builderPath] = process.argv.slice(2);
const marker = "CARHER_FOOTER_STATUS_PATCH_MARKER";

function backup(path, code, suffix) {
  const backupPath = `${path}.bak.${suffix}`;
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, code);
  }
}

function patchController(path) {
  let code = fs.readFileSync(path, "utf8");
  if (code.includes(`${marker}:controller`)) {
    console.log(`apply-footer-status.sh: controller already patched (${path})`);
    return;
  }
  backup(path, code, "footer-status");

  const importAnchor = `const promises_1 = require("node:fs/promises");`;
  if (!code.includes(importAnchor)) {
    throw new Error("controller import anchor not found");
  }
  code = code.replace(
    importAnchor,
    () => `${importAnchor}
// === ${marker}:controller-import ===
const net_1 = require("node:net");
// === end ${marker}:controller-import ===`,
  );

  const helperAnchor = `const log = (0, lark_logger_1.larkLogger)('card/streaming');`;
  if (!code.includes(helperAnchor)) {
    throw new Error("controller helper anchor not found");
  }
  const helperBlock = `${helperAnchor}
// === ${marker}:controller ===
const CARHER_GROUP_MODE_FOOTER_LABELS = {
    'owner-at': '🔒主人@',
    'group-at': '👥群@',
    discussion: '🗣️讨论',
};
function carherMergeFeishuAccountConfig(cfg, accountId) {
    const section = cfg?.channels?.feishu ?? {};
    const { accounts: _accounts, ...base } = section;
    const normalized = typeof accountId === 'string' ? accountId.trim().toLowerCase() : '';
    const override = normalized && normalized !== 'default' && section.accounts
        ? section.accounts[normalized]
        : undefined;
    if (!override || typeof override !== 'object')
        return base;
    return { ...base, ...override };
}
function carherRedisGet(redisUrl, key, timeoutMs = 250) {
    return new Promise((resolve) => {
        if (!redisUrl || !key) {
            resolve(null);
            return;
        }
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                socket.destroy();
            }
            catch { }
            resolve(value);
        };
        let socket;
        const timer = setTimeout(() => finish(null), timeoutMs);
        try {
            const url = new URL(redisUrl);
            const port = Number(url.port || '6379');
            socket = (0, net_1.createConnection)({ host: url.hostname, port }, () => {
                const crlf = String.fromCharCode(13, 10);
                const command = ['*2', '$3', 'GET', String.fromCharCode(36) + Buffer.byteLength(key), key, ''].join(crlf);
                socket.write(command);
            });
            let data = '';
            socket.on('data', (chunk) => {
                data += chunk.toString('utf8');
                if (data.startsWith('$-1')) {
                    finish(null);
                    return;
                }
                const headerEnd = data.indexOf(String.fromCharCode(13, 10));
                if (data.startsWith('$') && headerEnd > 0) {
                    const len = Number(data.slice(1, headerEnd));
                    const bodyStart = headerEnd + 2;
                    if (Number.isFinite(len) && data.length >= bodyStart + len + 2) {
                        finish(data.slice(bodyStart, bodyStart + len));
                    }
                }
            });
            socket.on('error', () => finish(null));
            socket.on('close', () => finish(null));
        }
        catch {
            finish(null);
        }
    });
}
async function carherReadGroupModeLabel(params) {
    const chatId = typeof params.chatId === 'string' ? params.chatId.trim() : '';
    if (!chatId.startsWith('oc_'))
        return undefined;
    const accountCfg = carherMergeFeishuAccountConfig(params.cfg, params.accountId);
    const appId = typeof accountCfg.appId === 'string' ? accountCfg.appId.trim() : '';
    if (!appId)
        return undefined;
    const raw = await carherRedisGet(process.env.REDIS_URL, \`group:mode:\${chatId}:\${appId}\`);
    let mode = 'owner-at';
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.mode === 'string' && parsed.mode.trim())
                mode = parsed.mode.trim();
        }
        catch { }
    }
    return CARHER_GROUP_MODE_FOOTER_LABELS[mode] ?? mode;
}
// === end ${marker}:controller ===`;
  code = code.replace(helperAnchor, () => helperBlock);

  const metricAnchor = `model: typeof entry.model === 'string' ? entry.model : undefined,`;
  if (!code.includes(metricAnchor)) {
    throw new Error("controller footer metrics anchor not found");
  }
  code = code.split(metricAnchor).join(`${metricAnchor}
                    // === ${marker}:metrics ===
                    compactionCount: typeof entry.compactionCount === 'number' ? entry.compactionCount : undefined,
                    groupMode: await carherReadGroupModeLabel({
                        cfg: this.deps.cfg,
                        accountId: this.deps.accountId,
                        chatId: this.deps.chatId,
                    }),
                    // === end ${marker}:metrics ===`);

  fs.writeFileSync(path, code);
  console.log(`apply-footer-status.sh: patched controller ${path}`);
}

function patchBuilder(path) {
  let code = fs.readFileSync(path, "utf8");
  if (code.includes(`${marker}:builder-v5`)) {
    console.log(`apply-footer-status.sh: builder already patched (${path})`);
    return;
  }
  if (code.includes(`${marker}:builder`)) {
    const backupPath = `${path}.bak.footer-status`;
    if (!fs.existsSync(backupPath)) {
      throw new Error("builder has old footer-status patch but missing .bak.footer-status backup");
    }
    code = fs.readFileSync(backupPath, "utf8");
    console.log(`apply-footer-status.sh: upgrading builder from existing footer-status patch (${path})`);
  }
  backup(path, code, "footer-status");

  const helperAnchor = `function formatFooterRuntimeSegments(params) {`;
  if (!code.includes(helperAnchor)) {
    throw new Error("builder helper anchor not found");
  }
  code = code.replace(
    helperAnchor,
    () => `// === ${marker}:builder-v5 ===
function carherFooterText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function carherFooterModelAlias(value) {
    const raw = carherFooterText(value);
    if (!raw)
        return undefined;
    const normalized = raw
        .replace(/^anthropic\\//, '')
        .replace(/^openai\\//, '')
        .replace(/^google\\//, '')
        .replace(/^deepseek\\//, '')
        .replace(/^minimax\\//, '')
        .replace(/^anthropic\\./, '')
        .replace(/^claude-/, '')
        .toLowerCase();
    const opus = normalized.match(/^opus[-.]?(\\d+)[-.](\\d+)$/);
    if (opus)
        return \`opus\${opus[1]}.\${opus[2]}\`;
    const sonnet = normalized.match(/^sonnet[-.]?(\\d+)[-.](\\d+)$/);
    if (sonnet)
        return \`sonnet\${sonnet[1]}.\${sonnet[2]}\`;
    const gpt = normalized.match(/^gpt[-.]?(\\d+)[-.](\\d+)$/);
    if (gpt)
        return \`gpt\${gpt[1]}.\${gpt[2]}\`;
    if (normalized === 'deepseek-v4-pro')
        return 'ds-v4-pro';
    if (normalized === 'deepseek-v4-flash')
        return 'ds-v4-flash';
    if (normalized === 'gemini-3.1-pro-preview')
        return 'gemini3.1p';
    return raw
        .replace(/^anthropic\\/(?:anthropic\\.)?claude-/, '')
        .replace(/^anthropic\\//, '')
        .replace(/^openai\\//, '')
        .replace(/^google\\//, '')
        .replace(/^deepseek\\//, '')
        .replace(/^minimax\\//, '');
}
function carherFooterContextLabel(metrics) {
    const freshTotal = metrics?.totalTokensFresh === false ? undefined : metrics?.totalTokens;
    const total = typeof freshTotal === 'number' ? Math.max(0, freshTotal) : undefined;
    const ctx = typeof metrics?.contextTokens === 'number' ? Math.max(0, metrics.contextTokens) : undefined;
    if (total == null || ctx == null)
        return undefined;
    const totalLabel = compactNumber(total);
    const ctxLabel = compactNumber(ctx);
    return \`\${totalLabel}/\${ctxLabel}\`;
}
function carherFooterContextPercentLabel(metrics) {
    const freshTotal = metrics?.totalTokensFresh === false ? undefined : metrics?.totalTokens;
    const total = typeof freshTotal === 'number' ? Math.max(0, freshTotal) : undefined;
    const ctx = typeof metrics?.contextTokens === 'number' ? Math.max(0, metrics.contextTokens) : undefined;
    if (total == null || ctx == null)
        return undefined;
    const pct = ctx > 0 ? Math.round((total / ctx) * 100) : 0;
    return \`\${pct}%\`;
}
function carherBuildCompactFooterRuntimeSegments(params) {
    const { footer, metrics, elapsedMs, isError, isAborted } = params;
    if (isError || isAborted)
        return undefined;
    const primaryZh = [];
    const primaryEn = [];
    primaryZh.push('🦞 **OpenClaw**');
    primaryEn.push('🦞 **OpenClaw**');
    const model = footer?.model ? carherFooterModelAlias(metrics?.model) : undefined;
    if (model) {
        primaryZh.push(model);
        primaryEn.push(model);
    }
    const context = footer?.context ? carherFooterContextLabel(metrics) : undefined;
    if (context) {
        primaryZh.push(context);
        primaryEn.push(context);
    }
    const contextPercent = footer?.context ? carherFooterContextPercentLabel(metrics) : undefined;
    if (contextPercent) {
        primaryZh.push(contextPercent);
        primaryEn.push(contextPercent);
    }
    const groupMode = carherFooterText(metrics?.groupMode);
    if (groupMode) {
        primaryZh.push(groupMode);
        primaryEn.push(groupMode);
    }
    if (footer?.elapsed && elapsedMs != null) {
        const d = formatElapsed(elapsedMs);
        primaryZh.push(d);
        primaryEn.push(d);
    }
    return primaryZh.length || primaryEn.length
        ? { primaryZh, primaryEn, detailZh: [], detailEn: [] }
        : undefined;
}
// === end ${marker}:builder-v5 ===
${helperAnchor}`,
  );

  const compactAnchor = `    const detailEn = [];`;
  if (!code.includes(compactAnchor)) {
    throw new Error("builder compact insert anchor not found");
  }
  code = code.replace(
    compactAnchor,
    () => `${compactAnchor}
    // === ${marker}:compact-render ===
    const carherCompactFooter = carherBuildCompactFooterRuntimeSegments(params);
    if (carherCompactFooter)
        return carherCompactFooter;
    // === end ${marker}:compact-render ===`,
  );

  const footerColorAnchor = [
    "    const zhContent = isError ? `<font color='red'>${zhText}</font>` : zhText;",
    "    const enContent = isError ? `<font color='red'>${enText}</font>` : enText;",
  ].join("\n");
  if (!code.includes(footerColorAnchor)) {
    throw new Error("builder footer color anchor not found");
  }
  code = code.replace(
    footerColorAnchor,
    () => [
      "    const zhContent = isError",
      "        ? `<font color='red'>${zhText}</font>`",
      "        : `<font color='grey'>${zhText}</font>`;",
      "    const enContent = isError",
      "        ? `<font color='red'>${enText}</font>`",
      "        : `<font color='grey'>${enText}</font>`;",
    ].join("\n"),
  );

  const footerPushAnchor = `    if (footerZhLines.length > 0) {
        elements.push(...buildFooter(footerZhLines.join('\\n'), footerEnLines.join('\\n'), isError));
    }`;
  if (!code.includes(footerPushAnchor)) {
    throw new Error("builder footer separator anchor not found");
  }
  code = code.replace(
    footerPushAnchor,
    () => `    if (footerZhLines.length > 0) {
        // === ${marker}:footer-separator ===
        if (text.trim() && !isError)
            elements.push({ tag: 'hr' });
        // === end ${marker}:footer-separator ===
        elements.push(...buildFooter(footerZhLines.join('\\n'), footerEnLines.join('\\n'), isError));
    }`,
  );

  fs.writeFileSync(path, code);
  console.log(`apply-footer-status.sh: patched builder ${path}`);
}

patchController(controllerPath);
patchBuilder(builderPath);
NODE

for f in "$CONTROLLER" "$BUILDER"; do
  if ! CHECK_OUTPUT=$(node --check "$f" 2>&1); then
    echo "$CHECK_OUTPUT" >&2
    echo "apply-footer-status.sh: node --check failed after patch — restoring backups" >&2
    [ -f "$CONTROLLER.bak.footer-status" ] && cp "$CONTROLLER.bak.footer-status" "$CONTROLLER"
    [ -f "$BUILDER.bak.footer-status" ] && cp "$BUILDER.bak.footer-status" "$BUILDER"
    exit 4
  fi
done

echo "apply-footer-status.sh: patched $LARK_PKG"
