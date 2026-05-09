// node --test scripts/carher-patches/apply-footer-status.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APPLY_PATCH_SH = join(__dirname, "apply-footer-status.sh");

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "carher-footer-status-"));
  const cardDir = join(dir, "src", "card");
  execFileSync("mkdir", ["-p", cardDir]);
  const controller = join(cardDir, "streaming-card-controller.js");
  const builder = join(cardDir, "builder.js");

  writeFileSync(
    controller,
    `"use strict";
const promises_1 = require("node:fs/promises");
const log = (0, lark_logger_1.larkLogger)('card/streaming');
class StreamingCardController {
  deps = { cfg: {}, accountId: "default", chatId: "oc_test" };
  async getFooterSessionMetrics() {
    const entry = { model: "opus", compactionCount: 2 };
    const metrics = {
      inputTokens: typeof entry.inputTokens === 'number' ? entry.inputTokens : undefined,
      outputTokens: typeof entry.outputTokens === 'number' ? entry.outputTokens : undefined,
      cacheRead: typeof entry.cacheRead === 'number' ? entry.cacheRead : undefined,
      cacheWrite: typeof entry.cacheWrite === 'number' ? entry.cacheWrite : undefined,
      totalTokens: typeof entry.totalTokens === 'number' ? entry.totalTokens : undefined,
      totalTokensFresh: typeof entry.totalTokensFresh === 'boolean' ? entry.totalTokensFresh : undefined,
      contextTokens: typeof entry.contextTokens === 'number' ? entry.contextTokens : undefined,
      model: typeof entry.model === 'string' ? entry.model : undefined,
    };
    return metrics;
  }
}
module.exports = { StreamingCardController };
`,
  );

  writeFileSync(
    builder,
    `"use strict";
function buildFooter(zhText, enText, isError) {
    const zhContent = isError ? \`<font color='red'>\${zhText}</font>\` : zhText;
    const enContent = isError ? \`<font color='red'>\${enText}</font>\` : enText;
    return [
        {
            tag: 'markdown',
            content: enContent,
            i18n_content: { zh_cn: zhContent, en_us: enContent },
            text_size: 'notation',
        },
    ];
}
function compactNumber(value) { return String(Math.round(value)); }
function formatElapsed(ms) { return (ms / 1000).toFixed(1) + "s"; }
function formatFooterRuntimeSegments(params) {
    const { footer, metrics, elapsedMs, isError, isAborted } = params;
    const primaryZh = [];
    const primaryEn = [];
    const detailZh = [];
    const detailEn = [];
    if (footer?.model && metrics?.model) {
        const model = metrics.model.trim();
        if (model) {
            primaryZh.push(model);
            primaryEn.push(model);
        }
    }
    if (footer?.context && metrics) {
        const freshTotal = metrics.totalTokensFresh === false ? undefined : metrics.totalTokens;
        const total = typeof freshTotal === 'number' ? Math.max(0, freshTotal) : undefined;
        const ctx = typeof metrics.contextTokens === 'number' ? Math.max(0, metrics.contextTokens) : undefined;
        if (total != null && ctx != null) {
            const totalLabel = compactNumber(total);
            const ctxLabel = compactNumber(ctx);
            const pct = ctx > 0 ? Math.round((total / ctx) * 100) : 0;
            const pctLabel = \`\${pct}%\`;
            detailZh.push(\`上下文 \${totalLabel}/\${ctxLabel} (\${pctLabel})\`);
            detailEn.push(\`Context \${totalLabel}/\${ctxLabel} (\${pctLabel})\`);
        }
    }
    return { primaryZh, primaryEn, detailZh, detailEn };
}
function buildCompleteCard(params) {
    const { text, elapsedMs, isError, isAborted, footer, footerMetrics } = params;
    const elements = [];
    elements.push({ tag: 'markdown', content: text });
    const fp = formatFooterRuntimeSegments({
        footer,
        metrics: footerMetrics,
        elapsedMs,
        isError,
        isAborted,
    });
    const footerZhLines = [];
    const footerEnLines = [];
    if (fp.primaryZh.length > 0) {
        footerZhLines.push(fp.primaryZh.join(' · '));
        footerEnLines.push(fp.primaryEn.join(' · '));
    }
    if (fp.detailZh.length > 0) {
        footerZhLines.push(fp.detailZh.join(' · '));
        footerEnLines.push(fp.detailEn.join(' · '));
    }
    if (footerZhLines.length > 0) {
        elements.push(...buildFooter(footerZhLines.join('\\n'), footerEnLines.join('\\n'), isError));
    }
    return { elements };
}
module.exports = { formatFooterRuntimeSegments, buildCompleteCard };
`,
  );

  return { dir, controller, builder };
}

test("patch adds compaction and group mode footer metrics", () => {
  const { dir, controller, builder } = writeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, dir], { stdio: "pipe" });
    execFileSync("node", ["--check", controller], { stdio: "pipe" });
    execFileSync("node", ["--check", builder], { stdio: "pipe" });

    const controllerCode = readFileSync(controller, "utf8");
    assert.match(controllerCode, /CARHER_FOOTER_STATUS_PATCH_MARKER:controller/);
    assert.match(controllerCode, /carherReadGroupModeLabel/);
    assert.match(controllerCode, /compactionCount/);
    assert.match(controllerCode, /groupMode/);

    const builderCode = readFileSync(builder, "utf8");
    assert.match(builderCode, /CARHER_FOOTER_STATUS_PATCH_MARKER:builder-v3/);
    assert.match(builderCode, /carherBuildCompactFooterRuntimeSegments/);
    assert.match(builderCode, /carherFooterModelAlias/);
    assert.match(builderCode, /footer-separator/);
    assert.match(builderCode, /font color='grey'/);
    assert.match(builderCode, /groupMode/);

    const sandbox = { module: { exports: {} }, exports: {} };
    vm.runInNewContext(builderCode, sandbox);
    const { formatFooterRuntimeSegments } = sandbox.module.exports;
    const result = formatFooterRuntimeSegments({
      footer: { status: false, elapsed: true, model: true, tokens: false, cache: false, context: true },
      metrics: {
        model: "anthropic/anthropic.claude-opus-4-7",
        groupMode: "🔒主人@",
        compactionCount: 3,
        totalTokens: 120000,
        contextTokens: 200000,
      },
      elapsedMs: 18400,
    });

    assert.deepEqual(Array.from(result.primaryZh), [
      "耗时 18.4s",
      "opus4.7",
      "🔒主人@",
      "120000/200000 (60%)",
      "🧹3",
    ]);
    assert.deepEqual(Array.from(result.detailZh), []);
    assert.deepEqual(Array.from(result.detailEn), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compact footer is visually separated and de-emphasized", () => {
  const { dir, builder } = writeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, dir], { stdio: "pipe" });
    const builderCode = readFileSync(builder, "utf8");
    const sandbox = { module: { exports: {} }, exports: {} };
    vm.runInNewContext(builderCode, sandbox);
    const { buildCompleteCard } = sandbox.module.exports;
    const card = buildCompleteCard({
      text: "正文内容",
      footer: { status: false, elapsed: true, model: true, tokens: false, cache: false, context: true },
      footerMetrics: {
        model: "anthropic/anthropic.claude-opus-4-7",
        groupMode: "👥群@",
        compactionCount: 1,
        totalTokens: 216000,
        contextTokens: 1000000,
      },
      elapsedMs: 18400,
    });

    assert.deepEqual(Array.from(card.elements.map((e) => e.tag)), ["markdown", "hr", "markdown"]);
    const footer = card.elements[2];
    assert.equal(footer.text_size, "notation");
    assert.equal(
      footer.content,
      "<font color='grey'>耗时 18.4s · opus4.7 · 👥群@ · 216000/1000000 (22%) · 🧹1</font>",
    );
    assert.equal(
      footer.i18n_content.zh_cn,
      "<font color='grey'>耗时 18.4s · opus4.7 · 👥群@ · 216000/1000000 (22%) · 🧹1</font>",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compact footer hides zero compactions and noisy token/cache labels", () => {
  const { dir, builder } = writeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, dir], { stdio: "pipe" });
    const builderCode = readFileSync(builder, "utf8");
    const sandbox = { module: { exports: {} }, exports: {} };
    vm.runInNewContext(builderCode, sandbox);
    const { formatFooterRuntimeSegments } = sandbox.module.exports;
    const result = formatFooterRuntimeSegments({
      footer: { status: false, elapsed: true, model: true, tokens: false, cache: false, context: true },
      metrics: {
        inputTokens: 7,
        outputTokens: 353,
        cacheRead: 215000,
        cacheWrite: 537,
        model: "anthropic/claude-sonnet-4.6",
        groupMode: "👥群@",
        compactionCount: 0,
        totalTokens: 216000,
        contextTokens: 1000000,
      },
      elapsedMs: 18400,
    });

    assert.deepEqual(Array.from(result.primaryZh), [
      "耗时 18.4s",
      "sonnet4.6",
      "👥群@",
      "216000/1000000 (22%)",
    ]);
    const rendered = `${result.primaryZh.join(" · ")} ${result.detailZh.join(" · ")}`;
    assert.doesNotMatch(rendered, /已完成|缓存|上下文|↑|↓|🧹0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patch upgrades old builder marker from backup", () => {
  const { dir, builder } = writeFixture();
  try {
    const original = readFileSync(builder, "utf8");
    writeFileSync(`${builder}.bak.footer-status`, original);
    writeFileSync(builder, `${original}\n// CARHER_FOOTER_STATUS_PATCH_MARKER:builder\n`);
    execFileSync("bash", [APPLY_PATCH_SH, dir], { stdio: "pipe" });
    const upgraded = readFileSync(builder, "utf8");
    assert.match(upgraded, /CARHER_FOOTER_STATUS_PATCH_MARKER:builder-v3/);
    assert.doesNotMatch(upgraded, /CARHER_FOOTER_STATUS_PATCH_MARKER:builder\\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patch is idempotent", () => {
  const { dir, controller, builder } = writeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, dir], { stdio: "pipe" });
    const once = `${readFileSync(controller, "utf8")}\n${readFileSync(builder, "utf8")}`;
    execFileSync("bash", [APPLY_PATCH_SH, dir], { stdio: "pipe" });
    const twice = `${readFileSync(controller, "utf8")}\n${readFileSync(builder, "utf8")}`;
    assert.equal(twice, once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
