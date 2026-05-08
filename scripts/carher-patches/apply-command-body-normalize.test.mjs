// node --test scripts/carher-patches/apply-command-body-normalize.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APPLY_PATCH_SH = join(__dirname, "apply-command-body-normalize.sh");

function writeDispatchFixture() {
  const dir = mkdtempSync(join(tmpdir(), "carher-command-body-"));
  const file = join(dir, "dispatch.js");
  writeFileSync(
    file,
    `"use strict";
const log = (0, lark_logger_1.larkLogger)('inbound/dispatch');
async function dispatchToAgent(params) {
    const dc = {
        isGroup: true,
        account: { accountId: 'default' },
        core: { channel: { commands: { isControlCommandMessage: () => false } } },
        log: () => {},
    };
    // === CARHER_HISTORY_FILL_PATCH_MARKER ===
    const { combinedBody, historyKey } = { combinedBody: '', historyKey: undefined };
    const bodyForAgent = params.ctx.content;
    const isBareNewOrReset = /^\\/(?:new|reset)\\s*$/i.test((params.ctx.content ?? '').trim());
    const ctxPayload = (0, dispatch_builders_1.buildInboundPayload)(dc, {
        body: combinedBody,
        bodyForAgent,
        rawBody: params.ctx.content,
        commandBody: params.ctx.content,
    });
    const contentTrimmed = (params.ctx.content ?? '').trim();
    const isCommentFlow = false;
    const isCommand = !isCommentFlow &&
        dc.core.channel.commands.isControlCommandMessage(params.ctx.content, params.accountScopedCfg);
    return { ctxPayload, contentTrimmed, isCommand, isBareNewOrReset, historyKey };
}
`,
  );
  return file;
}

function loadPatchedHelpers(code) {
  const start = code.indexOf("function carherEscapeRegExp");
  const end = code.indexOf("// === end CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER ===");
  assert.notEqual(start, -1, "helper start marker should exist");
  assert.notEqual(end, -1, "helper end marker should exist");
  const sandbox = {};
  vm.runInNewContext(
    `${code.slice(start, end)}
result = {
  strip: carherStripMentionsForCommandBody,
  targetsOther: carherSlashCommandTargetsAnotherMention,
};`,
    sandbox,
  );
  return sandbox.result;
}

test("patch rewrites dispatch.js to use mention-normalized CommandBody", () => {
  const file = writeDispatchFixture();

  execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
  const patched = readFileSync(file, "utf8");

  assert.match(patched, /CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER/);
  assert.match(
    patched,
    /const commandBody = carherStripMentionsForCommandBody\(params\.ctx\.content, params\.ctx\);/,
  );
  assert.match(patched, /commandBody,/);
  assert.match(patched, /isControlCommandMessage\(commandBody, params\.accountScopedCfg\)/);
  assert.match(patched, /isBareNewOrReset = \/.+\.test\(commandBody\)/s);
  assert.match(patched, /targeted slash command did not mention this bot, ignoring/);

  execFileSync("node", ["--check", file], { stdio: "pipe" });
});

test("patch is idempotent", () => {
  const file = writeDispatchFixture();

  execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
  const once = readFileSync(file, "utf8");
  execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
  const twice = readFileSync(file, "utf8");

  assert.equal(twice, once);
});

test("patch upgrades an already-applied V1 command-body patch from backup", () => {
  const file = writeDispatchFixture();
  const clean = readFileSync(file, "utf8");
  writeFileSync(`${file}.bak.command-body-normalize`, clean);
  writeFileSync(
    file,
    clean.replace(
      "const log = (0, lark_logger_1.larkLogger)('inbound/dispatch');",
      `const log = (0, lark_logger_1.larkLogger)('inbound/dispatch');
// === CARHER_COMMAND_BODY_NORMALIZE_PATCH_MARKER ===
function oldPatch() {}
// === end CARHER_COMMAND_BODY_NORMALIZE_PATCH_MARKER ===`,
    ),
  );

  execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
  const patched = readFileSync(file, "utf8");

  assert.match(patched, /CARHER_COMMAND_BODY_NORMALIZE_PATCH_V2_MARKER/);
  assert.doesNotMatch(patched, /function oldPatch/);
  execFileSync("node", ["--check", file], { stdio: "pipe" });
});

test("helpers normalize command bodies with leading and repeated mentions", () => {
  const file = writeDispatchFixture();
  execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
  const helpers = loadPatchedHelpers(readFileSync(file, "utf8"));

  const ownBotCtx = {
    mentions: [{ key: "@_user_1", openId: "ou_bot", name: "弋天的her", isBot: true }],
  };
  const otherMentionCtx = {
    mentions: [{ key: "@_user_2", openId: "ou_other", name: "研究2的her", isBot: false }],
  };
  const multiBotCtx = {
    mentions: [
      { key: "@_user_1", openId: "ou_bot", name: "弋天的her", isBot: true },
      { key: "@_user_3", openId: "ou_other_bot", name: "研究3的her", isBot: false },
    ],
  };

  assert.equal(helpers.strip("/new @弋天的her", ownBotCtx), "/new");
  assert.equal(helpers.strip("@弋天的her /new", ownBotCtx), "/new");
  assert.equal(helpers.strip("/new @弋天的her @研究3的her", multiBotCtx), "/new");
  assert.equal(helpers.strip('/status <at user_id="ou_bot">弋天的her</at>', ownBotCtx), "/status");
  assert.equal(helpers.strip("/new @研究2的her", otherMentionCtx), "/new");
  assert.equal(helpers.strip("@弋天的her hello", ownBotCtx), "@弋天的her hello");
  assert.equal(helpers.strip("hello @弋天的her", ownBotCtx), "hello @弋天的her");
});

test("helpers identify slash commands targeted at another mentioned account", () => {
  const file = writeDispatchFixture();
  execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
  const helpers = loadPatchedHelpers(readFileSync(file, "utf8"));

  assert.equal(
    helpers.targetsOther("/new @研究2的her", {
      mentions: [{ key: "@_user_2", openId: "ou_other", name: "研究2的her", isBot: false }],
    }),
    true,
  );
  assert.equal(
    helpers.targetsOther("@研究2的her /new", {
      mentions: [{ key: "@_user_2", openId: "ou_other", name: "研究2的her", isBot: false }],
    }),
    true,
  );
  assert.equal(
    helpers.targetsOther("/new @弋天的her", {
      mentions: [{ key: "@_user_1", openId: "ou_bot", name: "弋天的her", isBot: true }],
    }),
    false,
  );
  assert.equal(
    helpers.targetsOther("/new @弋天的her @研究2的her", {
      mentions: [
        { key: "@_user_1", openId: "ou_bot", name: "弋天的her", isBot: true },
        { key: "@_user_2", openId: "ou_other", name: "研究2的her", isBot: false },
      ],
    }),
    false,
  );
  assert.equal(helpers.targetsOther("/new", { mentions: [] }), false);
  assert.equal(
    helpers.targetsOther("hello @研究2的her", {
      mentions: [{ key: "@_user_2", openId: "ou_other", name: "研究2的her", isBot: false }],
    }),
    false,
  );
});
