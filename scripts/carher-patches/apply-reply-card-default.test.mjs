// node --test scripts/carher-patches/apply-reply-card-default.test.mjs
//
// TDD: prove that upstream openclaw-lark static replies only cardify
// table/code content, then patch shouldUseCard so plain Her replies are
// interactive cards too while preserving the too-many-tables fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const APPLY_PATCH_SH = join(__dirname, "apply-reply-card-default.sh");

function writeReplyModeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "carher-reply-card-default-"));
  const file = join(dir, "reply-mode.cjs");
  writeFileSync(
    file,
    `"use strict";
const card_error_1 = {
    FEISHU_CARD_TABLE_LIMIT: 2,
    findMarkdownTablesOutsideCodeBlocks(text) {
        if (String(text).includes("TOO_MANY_TABLES"))
            return [1, 2, 3];
        if (String(text).includes("|---|"))
            return [1];
        return [];
    }
};
function shouldUseCard(text) {
    const hasCodeBlock = /\`\`\`[\\s\\S]*?\`\`\`/.test(text);
    if (hasCodeBlock)
        return true;
    const tableMatches = (0, card_error_1.findMarkdownTablesOutsideCodeBlocks)(text);
    return tableMatches.length > 0 && tableMatches.length <= card_error_1.FEISHU_CARD_TABLE_LIMIT;
}
module.exports = { shouldUseCard };
`,
  );
  return { dir, file };
}

function loadFixture(file) {
  delete require.cache[file];
  return require(file);
}

test("BUG: upstream static reply mode does not cardify plain text", () => {
  const { dir, file } = writeReplyModeFixture();
  try {
    const { shouldUseCard } = loadFixture(file);

    assert.equal(shouldUseCard("plain short answer"), false);
    assert.equal(shouldUseCard("```js\nconsole.log(1)\n```"), true);
    assert.equal(shouldUseCard("| a |\n|---|\n| b |"), true);
    assert.equal(shouldUseCard("TOO_MANY_TABLES"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FIX: patched shouldUseCard uses cards for all non-empty text", () => {
  const { dir, file } = writeReplyModeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
    execFileSync("node", ["--check", file], { stdio: "pipe" });

    const patched = readFileSync(file, "utf8");
    assert.match(patched, /CARHER_REPLY_CARD_DEFAULT_PATCH_MARKER/);

    const { shouldUseCard } = loadFixture(file);
    assert.equal(shouldUseCard("plain short answer"), true);
    assert.equal(shouldUseCard("   "), false);
    assert.equal(shouldUseCard("```js\nconsole.log(1)\n```"), true);
    assert.equal(shouldUseCard("| a |\n|---|\n| b |"), true);
    assert.equal(shouldUseCard("TOO_MANY_TABLES"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FIX: patch is idempotent", () => {
  const { dir, file } = writeReplyModeFixture();
  try {
    execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
    const once = readFileSync(file, "utf8");
    execFileSync("bash", [APPLY_PATCH_SH, file], { stdio: "pipe" });
    const twice = readFileSync(file, "utf8");

    assert.equal(twice, once);
    assert.equal(
      [...twice.matchAll(/CARHER_REPLY_CARD_DEFAULT_PATCH_MARKER/g)].length,
      2,
      "start and end markers should appear exactly once each",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
