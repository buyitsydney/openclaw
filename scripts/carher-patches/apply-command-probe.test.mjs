// node --test scripts/carher-patches/apply-command-probe.test.mjs
//
// R-7: classify slash commands via a mention-stripped probe body so that
// `/status @bot` in a group is detected as /status (not as free-form agent
// input). Bug in vanilla: isControlCommandMessage sees trailing @bot and
// rejects the command → agent path runs → NO_REPLY / wrong reply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

const TARGET_PATH = join(
  REPO_ROOT,
  "test-assets/lark-pkg/package/src/messaging/inbound/dispatch.js",
);
const APPLY_PATCH_SH = join(__dirname, "apply-command-probe.sh");

test("BUG: unpatched dispatch.js classifies isCommand via ctx.content directly", () => {
  const src = readFileSync(TARGET_PATH, "utf-8");
  assert.match(
    src,
    /isControlCommandMessage\(params\.ctx\.content,/,
    "anchor present — upstream not refactored",
  );
  assert.doesNotMatch(
    src,
    /__carherCmdProbeBody/,
    "vanilla has no probe body",
  );
});

test("FIX: patcher injects probe body and rewrites isControlCommandMessage arg", () => {
  const scratch = join(dirname(TARGET_PATH), "dispatch.probe-scratch.js");
  execSync(`cp ${TARGET_PATH} ${scratch}`);
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const patched = readFileSync(scratch, "utf-8");

    assert.match(patched, /CARHER_COMMAND_PROBE_PATCH_MARKER/, "marker present");
    assert.match(
      patched,
      /const __carherCmdProbeBody = /,
      "probe body const present",
    );
    assert.match(
      patched,
      /isControlCommandMessage\(__carherCmdProbeBody,/,
      "call now uses probe variable",
    );
    assert.doesNotMatch(
      patched,
      /isControlCommandMessage\(params\.ctx\.content,/,
      "original arg no longer used",
    );
    // Probe must be declared BEFORE the const isCommand = ... statement,
    // not inside it — otherwise JS is a syntax error.
    const probeIdx = patched.indexOf("__carherCmdProbeBody = ");
    const isCommandIdx = patched.indexOf("const isCommand = !isCommentFlow");
    assert.ok(probeIdx > 0 && isCommandIdx > probeIdx, "probe above isCommand");

    execSync(`node --check ${scratch}`, { stdio: "pipe" });
  } finally {
    execSync(`rm -f ${scratch}`);
  }
});

test("FIX: idempotent (double apply = one marker block)", () => {
  const scratch = join(dirname(TARGET_PATH), "dispatch.probe-scratch.js");
  execSync(`cp ${TARGET_PATH} ${scratch}`);
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const once = readFileSync(scratch, "utf-8");
    const onceCount = (once.match(/CARHER_COMMAND_PROBE_PATCH_MARKER/g) ?? [])
      .length;
    assert.equal(onceCount, 2, "2 marker lines from one block");

    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const twice = readFileSync(scratch, "utf-8");
    const twiceCount = (twice.match(/CARHER_COMMAND_PROBE_PATCH_MARKER/g) ?? [])
      .length;
    assert.equal(twiceCount, 2, "no duplication on double apply");
  } finally {
    execSync(`rm -f ${scratch}`);
  }
});

test("SAFETY: anchor-missing → non-zero exit + no changes", () => {
  const scratch = join(dirname(TARGET_PATH), "dispatch.probe-scratch.js");
  execSync(`cp ${TARGET_PATH} ${scratch}`);
  try {
    execSync(`sed -i.bak "s/isControlCommandMessage/UPSTREAM_RENAMED/g" ${scratch}`);
    let threw = false;
    try { execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" }); }
    catch { threw = true; }
    assert.ok(threw, "exit non-zero when anchor missing");
    assert.doesNotMatch(
      readFileSync(scratch, "utf-8"),
      /CARHER_COMMAND_PROBE_PATCH_MARKER/,
      "no marker written",
    );
  } finally {
    execSync(`rm -f ${scratch} ${scratch}.bak`);
  }
});

// Pure regex unit test for the probe itself — must handle edge cases users
// actually type into Feishu groups.
test("PROBE: regex strips @xxx tokens correctly", () => {
  const strip = (s) => (s + "").replace(/@[^\s@]+/g, "").trim();

  assert.equal(strip("/status @弋天的her"), "/status");
  assert.equal(strip("/status @弋天的her @其他 bot"), "/status   bot");
  assert.equal(strip(" /new "), "/new");
  assert.equal(strip("/new @uid_ou_xxx123"), "/new");
  assert.equal(strip("hello @bot how are you"), "hello  how are you");
  assert.equal(strip("/status"), "/status");
  // Multi-byte unicode inside @-mention must not split on Chinese chars
  assert.equal(strip("/help @研究1"), "/help");
});
