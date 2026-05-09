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
function compactNumber(value) { return String(Math.round(value)); }
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
module.exports = { formatFooterRuntimeSegments };
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
    assert.match(builderCode, /CARHER_FOOTER_STATUS_PATCH_MARKER:builder/);
    assert.match(builderCode, /Compactions/);
    assert.match(builderCode, /groupMode/);

    const sandbox = { module: { exports: {} }, exports: {} };
    vm.runInNewContext(builderCode, sandbox);
    const { formatFooterRuntimeSegments } = sandbox.module.exports;
    const result = formatFooterRuntimeSegments({
      footer: { status: true, model: true, context: true },
      metrics: {
        model: "opus-4",
        groupMode: "🔒主人@",
        compactionCount: 3,
        totalTokens: 120000,
        contextTokens: 200000,
      },
    });

    assert.deepEqual(Array.from(result.primaryZh), ["opus-4", "🔒主人@"]);
    assert.ok(result.detailZh.includes("上下文 120000/200000 (60%)"));
    assert.ok(result.detailZh.includes("压缩 3"));
    assert.ok(result.detailEn.includes("Compactions 3"));
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
