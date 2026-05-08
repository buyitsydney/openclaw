// node --test scripts/carher-patches/apply-system-command-ack.test.mjs
//
// R-8: after dispatchReplyWithBufferedBlockDispatcher resolves, if
// delivered is still false AND content matches /new or /reset, send a
// tiny ack via sendMessageFeishu so users see confirmation. Other
// commands (/status, /help) are untouched — they deliver their own card.

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
  "test-assets/lark-pkg/package/src/messaging/inbound/dispatch-commands.js",
);
const APPLY_PATCH_SH = join(__dirname, "apply-system-command-ack.sh");

test("BUG: unpatched dispatch-commands.js never sends ack on delivered=false", () => {
  const src = readFileSync(TARGET_PATH, "utf-8");
  assert.doesNotMatch(
    src,
    /__carherLifecycleMatch/,
    "vanilla has no ack logic",
  );
  // Anchor must exist
  assert.match(
    src,
    /system command dispatched \(delivered=\$\{delivered\}\)/,
    "anchor present",
  );
});

test("FIX: patcher injects lifecycle ack block", () => {
  const scratch = join(dirname(TARGET_PATH), "dispatch-commands.ack-scratch.js");
  execSync(`cp ${TARGET_PATH} ${scratch}`);
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const patched = readFileSync(scratch, "utf-8");

    assert.match(patched, /CARHER_SYSTEM_COMMAND_ACK_PATCH_MARKER/, "marker");
    assert.match(patched, /if \(!delivered\) \{/, "guards on delivered");
    assert.match(
      patched,
      /\/\^\\\/\(new\|reset\)\\b\/i/,
      "matches /new and /reset only",
    );
    assert.match(
      patched,
      /send_1\.sendMessageFeishu/,
      "calls sendMessageFeishu",
    );
    // Ack block must be BEFORE the dispatched log line (so the log reflects
    // the updated delivered value).
    const ackIdx = patched.indexOf("CARHER_SYSTEM_COMMAND_ACK_PATCH_MARKER");
    const logIdx = patched.indexOf("system command dispatched (delivered=");
    assert.ok(ackIdx > 0 && logIdx > ackIdx, "ack precedes log");

    execSync(`node --check ${scratch}`, { stdio: "pipe" });
  } finally {
    execSync(`rm -f ${scratch}`);
  }
});

test("FIX: idempotent", () => {
  const scratch = join(dirname(TARGET_PATH), "dispatch-commands.ack-scratch.js");
  execSync(`cp ${TARGET_PATH} ${scratch}`);
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const once = (readFileSync(scratch, "utf-8").match(
      /CARHER_SYSTEM_COMMAND_ACK_PATCH_MARKER/g,
    ) ?? []).length;
    assert.equal(once, 2);

    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const twice = (readFileSync(scratch, "utf-8").match(
      /CARHER_SYSTEM_COMMAND_ACK_PATCH_MARKER/g,
    ) ?? []).length;
    assert.equal(twice, 2, "no duplication");
  } finally {
    execSync(`rm -f ${scratch}`);
  }
});

test("SAFETY: anchor missing → non-zero exit + no changes", () => {
  const scratch = join(dirname(TARGET_PATH), "dispatch-commands.ack-scratch.js");
  execSync(`cp ${TARGET_PATH} ${scratch}`);
  try {
    execSync(
      `sed -i.bak "s/system command dispatched/UPSTREAM_RENAMED/g" ${scratch}`,
    );
    let threw = false;
    try { execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" }); }
    catch { threw = true; }
    assert.ok(threw);
    assert.doesNotMatch(
      readFileSync(scratch, "utf-8"),
      /CARHER_SYSTEM_COMMAND_ACK_PATCH_MARKER/,
    );
  } finally {
    execSync(`rm -f ${scratch} ${scratch}.bak`);
  }
});

// Regex spec test — the lifecycle match regex must match exactly /new and
// /reset only (with optional args or @mentions after).
test("LIFECYCLE: regex matches /new and /reset only", () => {
  const match = (s) => s.trim().match(/^\/(new|reset)\b/i);
  assert.ok(match("/new"));
  assert.ok(match("/reset"));
  assert.ok(match(" /new "));
  assert.ok(match("/new @bot"));
  assert.ok(match("/RESET now please"));
  assert.equal(match("/status"), null);
  assert.equal(match("/help"), null);
  assert.equal(match("/whoami"), null);
  assert.equal(match("/newline"), null, "must word-boundary after 'new'");
  assert.equal(match("/resetting"), null, "must word-boundary after 'reset'");
  assert.equal(match("new"), null, "must start with /");
});
