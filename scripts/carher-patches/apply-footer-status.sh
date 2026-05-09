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
  if (code.includes(`${marker}:builder`)) {
    console.log(`apply-footer-status.sh: builder already patched (${path})`);
    return;
  }
  backup(path, code, "footer-status");

  const helperAnchor = `function formatFooterRuntimeSegments(params) {`;
  if (!code.includes(helperAnchor)) {
    throw new Error("builder helper anchor not found");
  }
  code = code.replace(
    helperAnchor,
    () => `// === ${marker}:builder ===
function carherFooterText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
// === end ${marker}:builder ===
${helperAnchor}`,
  );

  const modelAnchor = `    if (footer?.model && metrics?.model) {
        const model = metrics.model.trim();
        if (model) {
            primaryZh.push(model);
            primaryEn.push(model);
        }
    }`;
  if (!code.includes(modelAnchor)) {
    throw new Error("builder model anchor not found");
  }
  code = code.replace(
    modelAnchor,
    () => `${modelAnchor}
    // === ${marker}:group-mode ===
    const groupMode = carherFooterText(metrics?.groupMode);
    if (footer?.status && groupMode) {
        primaryZh.push(groupMode);
        primaryEn.push(groupMode);
    }
    // === end ${marker}:group-mode ===`,
  );

  const returnAnchor = `    return { primaryZh, primaryEn, detailZh, detailEn };`;
  if (!code.includes(returnAnchor)) {
    throw new Error("builder return anchor not found");
  }
  code = code.replace(
    returnAnchor,
    () => `    // === ${marker}:compactions ===
    if (footer?.context && metrics && typeof metrics.compactionCount === 'number') {
        const compactions = Math.max(0, Math.round(metrics.compactionCount));
        detailZh.push(\`压缩 \${compactions}\`);
        detailEn.push(\`Compactions \${compactions}\`);
    }
    // === end ${marker}:compactions ===
${returnAnchor}`,
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
