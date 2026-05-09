// node --test scripts/carher-patches/apply-outbound-card-default.test.mjs

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
const APPLY_PATCH_SH = join(__dirname, "apply-outbound-card-default.sh");

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "carher-outbound-card-"));
  const target = join(dir, "outbound.js");
  writeFileSync(
    target,
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.feishuOutbound = void 0;
const targets_1 = require("../../core/targets.js");
const comment_target_1 = require("../../core/comment-target.js");
const synthetic_target_1 = require("../../core/synthetic-target.js");
const deliver_1 = require("./deliver.js");
const log = { info() {}, debug() {} };
function resolveFeishuSendContext(params) {
    const routeTarget = (0, targets_1.parseFeishuRouteTarget)(params.to);
    return {
        cfg: params.cfg,
        to: routeTarget.target,
        replyToMessageId: undefined,
        replyInThread: false,
        accountId: params.accountId ?? undefined,
    };
}
// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
exports.feishuOutbound = {
    deliveryMode: 'direct',
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
        log.info(\`sendText: target=\${to}, textLength=\${text.length}\`);
        if ((0, synthetic_target_1.isSyntheticTarget)(to)) {
            return { channel: 'feishu', messageId: '', chatId: to };
        }
        if ((0, comment_target_1.isCommentTarget)(to)) {
            return { channel: 'feishu', messageId: 'comment' };
        }
        const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });
        const result = await (0, deliver_1.sendTextLark)({ ...ctx, to: ctx.to, text });
        return { channel: 'feishu', ...result };
    },
    sendPayload: async ({ cfg, to, payload, accountId, replyToId, threadId }) => {
        const ctx = resolveFeishuSendContext({ cfg, to, accountId, replyToId, threadId });
        const text = payload.text ?? '';
        const result = await (0, deliver_1.sendTextLark)({ ...ctx, to: ctx.to, text });
        return { channel: 'feishu', ...result };
    },
};
`,
  );
  return { dir, target };
}

function loadPatchedModule(code, calls) {
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(spec) {
      if (spec.endsWith("/targets.js")) {
        return { parseFeishuRouteTarget: (to) => ({ target: to }) };
      }
      if (spec.endsWith("/comment-target.js")) {
        return { isCommentTarget: () => false };
      }
      if (spec.endsWith("/synthetic-target.js")) {
        return { isSyntheticTarget: () => false };
      }
      if (spec === "./deliver.js") {
        return {
          sendTextLark: async (params) => {
            calls.push({ type: "text", params });
            return { messageId: "text-msg", chatId: params.to };
          },
          sendCardLark: async (params) => {
            calls.push({ type: "card", params });
            return { messageId: "card-msg", chatId: params.to };
          },
        };
      }
      throw new Error(`unexpected require: ${spec}`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}

test("patch cardifies direct outbound text", async () => {
  const { dir, target } = writeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, target], { stdio: "pipe" });
    execFileSync("node", ["--check", target], { stdio: "pipe" });
    const code = readFileSync(target, "utf8");
    assert.match(code, /CARHER_OUTBOUND_CARD_DEFAULT_PATCH_MARKER/);
    assert.match(code, /carherSendOutboundTextLark/);
    assert.match(code, /sendCardLark/);

    const calls = [];
    const mod = loadPatchedModule(code, calls);
    const result = await mod.feishuOutbound.sendText({
      cfg: {},
      to: "oc_test",
      text: "cron-card-e2e-ok",
    });

    assert.equal(result.messageId, "card-msg");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "card");
    assert.equal(calls[0].params.card.schema, "2.0");
    assert.equal(calls[0].params.card.body.elements[0].content, "cron-card-e2e-ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patch preserves explicit card JSON text route", async () => {
  const { dir, target } = writeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, target], { stdio: "pipe" });
    const code = readFileSync(target, "utf8");
    const calls = [];
    const mod = loadPatchedModule(code, calls);
    await mod.feishuOutbound.sendText({
      cfg: {},
      to: "oc_test",
      text: JSON.stringify({ schema: "2.0", body: { elements: [] } }),
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patch is idempotent", () => {
  const { dir, target } = writeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, target], { stdio: "pipe" });
    const once = readFileSync(target, "utf8");
    execFileSync("bash", [APPLY_PATCH_SH, target], { stdio: "pipe" });
    const twice = readFileSync(target, "utf8");
    assert.equal(twice, once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
