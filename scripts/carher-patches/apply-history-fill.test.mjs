// node --test scripts/carher-patches/apply-history-fill.test.mjs
//
// TDD: reproduce the "失忆" bug first (must FAIL on unpatched dispatch.js),
// then apply the patch and assert it fills chatHistories to ~20 entries.
//
// The patch target is /data/.openclaw/extensions/node_modules/@larksuite/
// openclaw-lark/src/messaging/inbound/dispatch.js inside the carher image.
// For local testing we npm-pack'd the same version to test-assets/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

const DISPATCH_PATH = join(
  REPO_ROOT,
  "test-assets/lark-pkg/package/src/messaging/inbound/dispatch.js",
);
const APPLY_PATCH_SH = join(__dirname, "apply-history-fill.sh");
const HELPER_JS = join(__dirname, "history-fill-helper.js");

// -------- Fixtures --------

/** Create a fake dispatch context (just enough for the helper to work). */
function makeDc({ isGroup = true, isThread = false, chatId = "oc_test_group" } = {}) {
  return {
    isGroup,
    isThread,
    ctx: {
      chatId,
      threadId: isThread ? "omt_test_thread" : undefined,
      messageId: "om_current_msg",
      content: "@bot hello",
      senderId: "ou_sender",
    },
    account: {
      accountId: "default",
      config: {},
    },
    log: () => {},
    error: () => {},
  };
}

/** Build threadScopedKey the same way openclaw-lark's chat-queue.js does:
 *  `${chatId}` for top-level, `${chatId}:${threadId}` for threads. */
function threadScopedKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

/** Build a fake Feishu /im/v1/messages API response with N items.
 *  sort_type=ByCreateTimeDesc → items[0] is the newest, items[N-1] is the oldest. */
function fakeFeishuMessagesResponse(n, { chatId = "oc_test_group" } = {}) {
  const now = Date.now();
  const items = [];
  for (let i = 1; i <= n; i++) {
    // i=1 → newest (1 minute ago); i=n → oldest (n minutes ago)
    items.push({
      message_id: `om_history_${i}`,
      chat_id: chatId,
      msg_type: "text",
      create_time: String(now - i * 60_000),
      sender: { id: `ou_user_${(i % 3) + 1}`, sender_type: "user" },
      body: { content: JSON.stringify({ text: `history message ${i}` }) },
    });
  }
  return { code: 0, data: { items, has_more: false } };
}

// -------- TEST 1: Reproduce the bug --------
//
// Before any patch, a bot that just restarted has an empty chatHistories
// Map. When the user @mentions the bot, dispatch.js's existing logic at
// L316-322 builds inboundHistory from that empty Map, producing a 0-entry
// array. We assert that directly (no need to load dispatch.js — we just
// simulate the exact line of code that builds inboundHistory).

test("BUG: empty chatHistories → InboundHistory has 0 entries (regression)", () => {
  const chatHistories = new Map(); // fresh bot, no prior inbound events
  const dc = makeDc();
  const historyLimit = 50;

  const historyKey = threadScopedKey(
    dc.ctx.chatId,
    dc.isThread ? dc.ctx.threadId : undefined,
  );

  // This mirrors dispatch.js L316-322 exactly:
  const inboundHistory =
    dc.isGroup && chatHistories && historyLimit > 0
      ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp ?? Date.now(),
        }))
      : undefined;

  assert.equal(
    inboundHistory.length,
    0,
    "before patch: freshly-started bot has no history to inject — this is the 失忆 bug",
  );
});

// -------- TEST 2: Helper fills chatHistories to ~20 when Map is sparse --------

test("FIX: fillChatHistoryIfSparse populates Map with 20 entries via fake fetch", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const historyLimit = 50;

  // Stub the fetcher — the helper accepts dependency injection for testing.
  const fakeFetch = async (_url, _opts) => ({
    ok: true,
    status: 200,
    json: async () => fakeFeishuMessagesResponse(20),
  });
  const fakeTokenProvider = async () => "t-fake-token-xyz";

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit },
    _testFetch: fakeFetch,
    _testTokenProvider: fakeTokenProvider,
  });

  const historyKey = threadScopedKey(
    dc.ctx.chatId,
    dc.isThread ? dc.ctx.threadId : undefined,
  );
  const entries = chatHistories.get(historyKey) ?? [];

  assert.equal(entries.length, 20, "chatHistories should be filled to 20");
  assert.ok(
    entries[0].timestamp <= entries[entries.length - 1].timestamp,
    "entries must be in chronological order (oldest first)",
  );
  for (const e of entries) {
    assert.ok(typeof e.sender === "string" && e.sender.length > 0, "sender present");
    assert.ok(typeof e.body === "string" && e.body.length > 0, "body present");
    assert.ok(typeof e.timestamp === "number", "timestamp present");
  }
});

// -------- TEST 3: Helper skips fetch when Map already has enough entries --------

test("FIX: fillChatHistoryIfSparse skips fetch when Map already has ≥20 entries", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const historyKey = threadScopedKey(dc.ctx.chatId);

  // Pre-populate with 20 entries (simulating steady-state passive accumulation).
  const prefill = Array.from({ length: 20 }, (_, i) => ({
    sender: `ou_u${i}`,
    body: `msg ${i}`,
    timestamp: Date.now() - i * 1000,
    messageId: `om_${i}`,
  }));
  chatHistories.set(historyKey, prefill);

  let fetchCalls = 0;
  const fakeFetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => fakeFeishuMessagesResponse(20) };
  };

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
  });

  assert.equal(fetchCalls, 0, "no fetch when Map already has ≥20 entries");
  assert.equal(chatHistories.get(historyKey).length, 20, "existing entries untouched");
});

test("FIX: fillChatHistoryIfSparse labels senders and uses the content converter", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_history_1",
            chat_id: "oc_test_group",
            msg_type: "interactive",
            create_time: "1000",
            sender: { id: "ou_owner", sender_type: "user" },
            body: { content: JSON.stringify({ json_card: "{}" }) },
          },
        ],
        has_more: false,
      },
    }),
  });

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
    _testNameMap: new Map([["ou_owner", "卜弋天"]]),
    _testConvertMessageContent: async (raw, type) => ({
      content: `${type}: ${JSON.parse(raw).json_card}`,
      resources: [],
    }),
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sender, "卜弋天 (ou_owner)");
  assert.equal(entries[0].body, "interactive: {}");
});

test("FIX: fillChatHistoryIfSparse expands interactive cards instead of injecting client-upgrade placeholders", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const interactiveContent = JSON.stringify({
    body: {
      elements: [
        { tag: "markdown", content: "**实证完整！** 林森 5-1 已经把全队默认值改到 32k。" },
      ],
    },
  });
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_card_full",
            chat_id: "oc_test_group",
            msg_type: "interactive",
            create_time: "1000",
            sender: { id: "ou_owner", sender_type: "user" },
            body: { content: interactiveContent },
          },
        ],
        has_more: false,
      },
    }),
  });

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
    _testNameMap: new Map([["ou_owner", "卜弋天"]]),
    _testConvertMessageContent: async () => ({
      content: "请升级至最新版本客户端，以查看内容",
      resources: [],
    }),
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(entries.length, 1);
  assert.match(entries[0].body, /实证完整/);
  assert.doesNotMatch(entries[0].body, /请升级至最新版本客户端/);
});

test("FIX: fillChatHistoryIfSparse refetches canonical interactive content when history API is degraded", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const degradedContent = JSON.stringify({
    elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]],
  });
  const canonicalContent = JSON.stringify({
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: "完整答案有了。OpenClaw config 里有限额。" },
      },
    ],
  });
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_card_degraded",
            chat_id: "oc_test_group",
            msg_type: "interactive",
            create_time: "1000",
            sender: { id: "ou_owner", sender_type: "user" },
            body: { content: degradedContent },
          },
        ],
        has_more: false,
      },
    }),
  });
  let canonicalFetches = 0;

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
    _testNameMap: new Map([["ou_owner", "卜弋天"]]),
    _testFetchCanonicalMessage: async (messageId) => {
      canonicalFetches++;
      assert.equal(messageId, "om_card_degraded");
      return {
        message_id: messageId,
        chat_id: "oc_test_group",
        msg_type: "interactive",
        create_time: "1000",
        sender: { id: "ou_owner", sender_type: "user" },
        body: { content: canonicalContent },
      };
    },
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(canonicalFetches, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, "完整答案有了。OpenClaw config 里有限额。");
  assert.doesNotMatch(entries[0].body, /请升级至最新版本客户端/);
});

test("FIX: fillChatHistoryIfSparse canonicalizes every interactive card before accepting list text", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const listDegradedContent = JSON.stringify({
    elements: [[{ tag: "text", text: "全部默认值出齐。看 fallback 的 compact 模式逻辑：" }]],
  });
  const canonicalContent = JSON.stringify({
    json_card: JSON.stringify({
      header: { title: { tag: "plain_text", content: "完整答案有了" } },
      body: {
        elements: [
          {
            tag: "markdown",
            content:
              "OpenClaw config 里的 skill 限额机制非常具体。\n\n| 限额 | 默认值 |\n| --- | --- |\n| maxSkillsPromptChars | 18000 |",
          },
        ],
      },
    }),
    card_schema: 2,
  });
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_card_plausible_but_degraded",
            chat_id: "oc_test_group",
            msg_type: "interactive",
            create_time: "1000",
            sender: { id: "ou_owner", sender_type: "user" },
            body: { content: listDegradedContent },
          },
        ],
        has_more: false,
      },
    }),
  });
  let canonicalFetches = 0;

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
    _testNameMap: new Map([["ou_owner", "卜弋天"]]),
    _testFetchCanonicalMessage: async (messageId) => {
      canonicalFetches++;
      assert.equal(messageId, "om_card_plausible_but_degraded");
      return {
        message_id: messageId,
        chat_id: "oc_test_group",
        msg_type: "interactive",
        create_time: "1000",
        sender: { id: "ou_owner", sender_type: "user" },
        body: { content: canonicalContent },
      };
    },
    _testConvertMessageContent: async (raw, type) => {
      const parsed = JSON.parse(raw);
      if (typeof parsed.json_card === "string") {
        const card = JSON.parse(parsed.json_card);
        return {
          content: `<card title="${card.header.title.content}">\n${card.body.elements[0].content}\n</card>`,
          resources: [],
        };
      }
      return { content: `${type}: ${parsed.elements?.[0]?.[0]?.text ?? ""}`, resources: [] };
    },
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(canonicalFetches, 1);
  assert.equal(entries.length, 1);
  assert.match(entries[0].body, /<card title="完整答案有了">/);
  assert.match(entries[0].body, /maxSkillsPromptChars/);
  assert.doesNotMatch(entries[0].body, /全部默认值出齐/);
});

test("FIX: fillChatHistoryIfSparse never injects upgrade placeholders for image-only cards", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const degradedImageCard = JSON.stringify({
    elements: [
      [
        { tag: "img", image_key: "img_v3_abc" },
        { tag: "text", text: "请升级至最新版本客户端，以查看内容" },
      ],
    ],
  });
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_card_image_only",
            chat_id: "oc_test_group",
            msg_type: "interactive",
            create_time: "1000",
            sender: { id: "ou_owner", sender_type: "user" },
            body: { content: degradedImageCard },
          },
        ],
        has_more: false,
      },
    }),
  });

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
    _testNameMap: new Map([["ou_owner", "卜弋天"]]),
    _testFetchCanonicalMessage: async () => null,
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, "<media:image>");
  assert.doesNotMatch(entries[0].body, /请升级至最新版本客户端/);
});

// -------- TEST 4a: URL omits start_time / end_time (no 2h window) --------
//
// Rationale: if a user leaves a group overnight and @mentions the bot the
// next morning, we still want the most recent 20 messages. Adding a time
// window would silently drop them.

test("FIX: fillChatHistoryIfSparse calls API without start_time/end_time", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);
  const chatHistories = new Map();
  let capturedUrl = null;
  const fakeFetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => fakeFeishuMessagesResponse(20) };
  };

  await fillChatHistoryIfSparse({
    dc: makeDc(),
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
  });

  assert.ok(capturedUrl, "fetch must be called");
  assert.doesNotMatch(capturedUrl, /start_time=/, "no start_time in URL");
  assert.doesNotMatch(capturedUrl, /end_time=/, "no end_time in URL");
  assert.match(capturedUrl, /sort_type=ByCreateTimeDesc/, "still sorts newest-first");
  assert.match(capturedUrl, /page_size=20/, "asks for 20 messages");
});

// -------- TEST 4: Helper is a no-op for DMs --------

test("FIX: fillChatHistoryIfSparse no-ops for direct messages", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);
  const chatHistories = new Map();
  let fetchCalls = 0;
  const fakeFetch = async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({}) };
  };

  await fillChatHistoryIfSparse({
    dc: makeDc({ isGroup: false }),
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
  });

  assert.equal(fetchCalls, 0, "DM path must not touch the Feishu messages API");
  assert.equal(chatHistories.size, 0, "no Map mutation for DM");
});

// -------- TEST 5: Patcher injects a single line at the expected anchor + is idempotent --------

test("PATCH: apply-history-fill.sh injects one line before buildEnvelopeWithHistory (idempotent)", () => {
  // Snapshot the target file shape so regressions in upstream lark are caught loudly.
  const original = readFileSync(DISPATCH_PATH, "utf-8");
  assert.match(
    original,
    /\/\/ 4\. Build main envelope \(with group chat history\)/,
    "anchor comment must exist in upstream dispatch.js",
  );

  // Apply patch to a scratch copy. Scratch must keep a `.js` extension
  // because the patcher runs `node --check` which refuses unknown extensions.
  const scratch = join(dirname(DISPATCH_PATH), "dispatch.patchscratch.js");
  execSync(`cp ${DISPATCH_PATH} ${scratch}`);
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const once = readFileSync(scratch, "utf-8");

    assert.match(
      once,
      /CARHER_HISTORY_FILL_PATCH_MARKER/,
      "patch marker must be present after first apply",
    );
    assert.match(
      once,
      /require\(['"]\.\/carher-history-fill\.js['"]\)/,
      "patched code must require the helper",
    );
    // Anchor line must still be present and appear AFTER the inserted block.
    const markerIdx = once.indexOf("CARHER_HISTORY_FILL_PATCH_MARKER");
    const anchorIdx = once.indexOf("buildEnvelopeWithHistory");
    assert.ok(markerIdx > 0 && anchorIdx > markerIdx, "patch inserted before anchor");

    // Idempotent: applying a second time must not duplicate the block.
    // Each block has 2 marker occurrences (`=== MARKER ===` + `=== end MARKER ===`),
    // so single-apply = 2 and double-apply must still = 2.
    const singleCount = (once.match(/CARHER_HISTORY_FILL_PATCH_MARKER/g) ?? []).length;
    assert.equal(singleCount, 2, "single apply: exactly one block (2 marker lines)");
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe" });
    const twice = readFileSync(scratch, "utf-8");
    const doubleCount = (twice.match(/CARHER_HISTORY_FILL_PATCH_MARKER/g) ?? []).length;
    assert.equal(doubleCount, 2, "idempotent: double-apply must not duplicate the block");

    // Syntax check: patched dispatch.js must still parse (no JS broken).
    execSync(`node --check ${scratch}`, { stdio: "pipe" });
  } finally {
    execSync(`rm -f ${scratch}`);
  }
});
