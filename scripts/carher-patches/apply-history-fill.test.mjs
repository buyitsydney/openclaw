// node --test scripts/carher-patches/apply-history-fill.test.mjs
//
// TDD: reproduce the "失忆" bug first (must FAIL on unpatched dispatch.js),
// then apply the patch and assert it fills chatHistories to ~20 entries.
//
// The patch target is /data/.openclaw/extensions/node_modules/@larksuite/
// openclaw-lark/src/messaging/inbound/dispatch.js inside the carher image.
// For local testing we npm-pack'd the same version to test-assets/.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const REPO_ROOT = join(currentDir, "..", "..");

const DISPATCH_PATH = join(
  REPO_ROOT,
  "test-assets/lark-pkg/package/src/messaging/inbound/dispatch.js",
);
const APPLY_PATCH_SH = join(currentDir, "apply-history-fill.sh");
const APPLY_INBOUND_HISTORY_META_SH = join(currentDir, "apply-inbound-history-meta.sh");
const HELPER_JS = join(currentDir, "history-fill-helper.js");

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

  const historyKey = threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined);

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

  const historyKey = threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined);
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

test("FIX: fillChatHistoryIfSparse prefers lark-cli user history view before raw API fallback", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  let fetchCalls = 0;
  let capturedCommand = null;
  let capturedArgs = null;

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => fakeFeishuMessagesResponse(20) };
    },
    _testExecFileJson: async (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return {
        ok: true,
        data: {
          messages: [
            {
              message_id: "om_current_msg",
              msg_type: "text",
              create_time: "2026-05-09 14:39",
              sender: { id: "ou_sender", sender_type: "user", name: "卜弋天" },
              content: "@bot hello",
            },
            {
              message_id: "om_card_full",
              msg_type: "interactive",
              create_time: "2026-05-09 14:38",
              reply_to: "om_parent_msg",
              sender: { id: "cli_peer", sender_type: "app", name: "弋天的her" },
              content: "<card>\n天哥，我自己的 config **不是 32k，是 200k**\n</card>",
            },
          ],
        },
      };
    },
  });

  assert.equal(fetchCalls, 0, "raw Feishu API fallback should not run after lark-cli succeeds");
  assert.equal(capturedCommand, "lark-cli");
  assert.deepEqual(capturedArgs, [
    "im",
    "+chat-messages-list",
    "--chat-id",
    "oc_test_group",
    "--page-size",
    "20",
    "--sort",
    "desc",
    "--format",
    "json",
  ]);
  assert.equal(capturedArgs.includes("--as"), false, "must use lark-cli's default user identity");

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sender, "弋天的her (cli_peer)");
  assert.equal(entries[0].messageId, "om_card_full");
  assert.equal(entries[0].messageType, "interactive");
  assert.equal(entries[0].replyToId, "om_parent_msg");
  assert.match(entries[0].body, /<card>/);
  assert.match(entries[0].body, /200k/);
});

test("FIX: fillChatHistoryIfSparse resolves lark-cli app senders through known bot registry", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetchKnownBotNames: async () =>
      new Map([
        ["cli_a917e5525178dbb3", "弋天的her"],
        ["cli_a94a0b73a878dbcb", "林森的her"],
      ]),
    _testExecFileJson: async () => ({
      ok: true,
      data: {
        messages: [
          {
            message_id: "om_current_msg",
            msg_type: "text",
            create_time: "2026-05-09 14:39",
            sender: { id: "ou_sender", sender_type: "user", name: "卜弋天" },
            content: "@bot 看看前文",
          },
          {
            message_id: "om_peer_bot",
            msg_type: "post",
            create_time: "2026-05-09 14:38",
            sender: { id: "cli_a917e5525178dbb3", sender_type: "app" },
            content: "天哥，我自己的 config 不是 32k，是 200k",
          },
        ],
      },
    }),
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sender, "弋天的her (cli_a917e5525178dbb3)");
  assert.match(entries[0].body, /200k/);
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

test("FIX: fillChatHistoryIfSparse resolves raw API app senders through knownBots", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  dc.account.knownBots = { cli_a94a0b73a878dbcb: "林森的her" };
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_history_app",
            chat_id: "oc_test_group",
            msg_type: "text",
            create_time: "1000",
            sender: { id: "cli_a94a0b73a878dbcb", sender_type: "app" },
            body: { content: JSON.stringify({ text: "我刚才说过这句话" }) },
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
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sender, "林森的her (cli_a94a0b73a878dbcb)");
  assert.equal(entries[0].body, "我刚才说过这句话");
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
    _testFetchCanonicalMessages: async (messageIds) => {
      canonicalFetches++;
      assert.deepEqual(messageIds, ["om_card_degraded"]);
      return [
        {
          message_id: "om_card_degraded",
          chat_id: "oc_test_group",
          msg_type: "interactive",
          create_time: "1000",
          sender: { id: "ou_owner", sender_type: "user" },
          body: { content: canonicalContent },
        },
      ];
    },
  });

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(canonicalFetches, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, "完整答案有了。OpenClaw config 里有限额。");
  assert.doesNotMatch(entries[0].body, /请升级至最新版本客户端/);
});

test("FIX: fillChatHistoryIfSparse batch-canonicalizes every interactive card before accepting list text", async () => {
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
          {
            message_id: "om_card_second_degraded",
            chat_id: "oc_test_group",
            msg_type: "interactive",
            create_time: "900",
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
    _testFetchCanonicalMessages: async (messageIds) => {
      canonicalFetches++;
      assert.deepEqual(messageIds, ["om_card_second_degraded", "om_card_plausible_but_degraded"]);
      return messageIds.map((messageId) => ({
        message_id: messageId,
        chat_id: "oc_test_group",
        msg_type: "interactive",
        create_time: messageId === "om_card_second_degraded" ? "900" : "1000",
        sender: { id: "ou_owner", sender_type: "user" },
        body: { content: canonicalContent },
      }));
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
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.match(entry.body, /<card title="完整答案有了">/);
    assert.match(entry.body, /maxSkillsPromptChars/);
    assert.doesNotMatch(entry.body, /全部默认值出齐/);
  }
});

test("FIX: fillChatHistoryIfSparse uses raw_card_content mget and parses json_card", async () => {
  const { fillChatHistoryIfSparse } = await import(HELPER_JS);

  const chatHistories = new Map();
  const dc = makeDc();
  const degradedContent = JSON.stringify({
    elements: [[{ tag: "text", text: "请升级至最新版本客户端，以查看内容" }]],
  });
  const rawCardContent = JSON.stringify({
    json_card: JSON.stringify({
      body: {
        property: {
          elements: [
            {
              tag: "div",
              property: {
                elements: [
                  { tag: "plain_text", property: { content: "天哥，我自己的 config " } },
                  { tag: "plain_text", property: { content: "不是 32k，是 200k" } },
                ],
              },
            },
          ],
        },
      },
    }),
  });
  let capturedMgetUrl = null;
  const fakeFetch = async (url) => {
    if (String(url).includes("/im/v1/messages/mget")) {
      capturedMgetUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            items: ["om_card_a", "om_card_b"].map((messageId) => ({
              message_id: messageId,
              chat_id: "oc_test_group",
              msg_type: "interactive",
              create_time: messageId === "om_card_a" ? "1000" : "900",
              sender: { id: "ou_owner", sender_type: "user" },
              body: { content: rawCardContent },
            })),
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: {
          items: ["om_card_a", "om_card_b"].map((messageId) => ({
            message_id: messageId,
            chat_id: "oc_test_group",
            msg_type: "interactive",
            create_time: messageId === "om_card_a" ? "1000" : "900",
            sender: { id: "ou_owner", sender_type: "user" },
            body: { content: degradedContent },
          })),
        },
      }),
    };
  };

  await fillChatHistoryIfSparse({
    dc,
    params: { chatHistories, historyLimit: 50 },
    _testFetch: fakeFetch,
    _testTokenProvider: async () => "t",
    _testNameMap: new Map([["ou_owner", "卜弋天"]]),
  });

  assert.ok(capturedMgetUrl, "interactive cards must be refetched through messages/mget");
  const mgetUrl = new URL(capturedMgetUrl);
  assert.equal(mgetUrl.searchParams.get("card_msg_content_type"), "raw_card_content");
  assert.deepEqual(mgetUrl.searchParams.getAll("message_ids"), ["om_card_b", "om_card_a"]);

  const entries = chatHistories.get(threadScopedKey(dc.ctx.chatId)) ?? [];
  assert.equal(entries.length, 2);
  assert.match(entries[0].body, /<card>/);
  assert.match(entries[0].body, /不是 32k，是 200k/);
  assert.doesNotMatch(entries[0].body, /请升级至最新版本客户端/);
  assert.doesNotMatch(entries[0].body, /json_card/);
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

test("PATCH: apply-history-fill.sh injects one line before buildEnvelopeWithHistory (idempotent)", async () => {
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
  const lookupScratch = join(dirname(DISPATCH_PATH), "../shared/message-lookup.patchscratch.js");
  execSync(`cp ${DISPATCH_PATH} ${scratch}`);
  execSync(`cp ${join(dirname(DISPATCH_PATH), "../shared/message-lookup.js")} ${lookupScratch}`);
  const patchEnv = {
    ...process.env,
    CARHER_LARK_MESSAGE_LOOKUP_TARGET: lookupScratch,
  };
  try {
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe", env: patchEnv });
    const once = readFileSync(scratch, "utf-8");
    const lookupOnce = readFileSync(lookupScratch, "utf-8");

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
    assert.match(
      once,
      /CARHER_HISTORY_META_PATCH_MARKER/,
      "history metadata marker must be present after first apply",
    );
    assert.match(
      once,
      /messageId: entry\.messageId/,
      "patched dispatch must pass message_id metadata into InboundHistory",
    );
    assert.match(
      once,
      /replyToId: entry\.replyToId/,
      "patched dispatch must pass reply_to metadata into InboundHistory",
    );
    assert.match(
      lookupOnce,
      /CARHER_QUOTED_CARD_CONTENT_CLEANUP_PATCH_MARKER/,
      "message lookup must strip flattened card footers from quoted interactive cards",
    );
    assert.match(
      lookupOnce,
      /content: carherContent/,
      "quoted message content must use the cleaned content in Feishu reply context",
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
    const singleMetaCount = (once.match(/CARHER_HISTORY_META_PATCH_MARKER/g) ?? []).length;
    assert.equal(singleMetaCount, 2, "single apply: exactly one metadata block");
    const singleLookupCount =
      (lookupOnce.match(/CARHER_QUOTED_CARD_CONTENT_CLEANUP_PATCH_MARKER/g) ?? []).length;
    assert.equal(singleLookupCount, 4, "single apply: helper + render marker lines");
    execSync(`bash ${APPLY_PATCH_SH} ${scratch}`, { stdio: "pipe", env: patchEnv });
    const twice = readFileSync(scratch, "utf-8");
    const lookupTwice = readFileSync(lookupScratch, "utf-8");
    const doubleCount = (twice.match(/CARHER_HISTORY_FILL_PATCH_MARKER/g) ?? []).length;
    assert.equal(doubleCount, 2, "idempotent: double-apply must not duplicate the block");
    const doubleMetaCount = (twice.match(/CARHER_HISTORY_META_PATCH_MARKER/g) ?? []).length;
    assert.equal(doubleMetaCount, 2, "idempotent: double-apply must not duplicate metadata block");
    const doubleLookupCount =
      (lookupTwice.match(/CARHER_QUOTED_CARD_CONTENT_CLEANUP_PATCH_MARKER/g) ?? []).length;
    assert.equal(doubleLookupCount, 4, "idempotent: double-apply must not duplicate cleanup block");

    const sandbox = {
      exports: {},
      require: (id) => {
        if (id === "../converters/content-converter.js") {
          return {
            buildConvertContextFromItem: () => ({}),
            convertMessageContent: async () => ({
              content:
                "<card>\n柚子\n宁波\n---\n🦞 OpenClaw · opus4.7 · 48.9k/1.0m · 5% · 🔒主人@ · 17.8s\n</card>",
            }),
          };
        }
        if (id === "../../core/lark-client.js") {
          return { LarkClient: { fromCfg: () => ({ sdk: {} }) } };
        }
        if (id === "../../core/lark-logger.js") {
          return { larkLogger: () => ({ info: () => {}, error: () => {} }) };
        }
        if (id === "../inbound/user-name-cache.js") {
          return {
            createBatchResolveNames: () => async () => ({}),
            getUserNameCache: () => new Map(),
          };
        }
        if (id === "../../core/accounts.js") {
          return { getLarkAccount: () => ({}) };
        }
        throw new Error(`unexpected require: ${id}`);
      },
    };
    const vm = await import("node:vm");
    vm.runInNewContext(`${lookupTwice}\nexports.__testParseMessageItem = parseMessageItem;`, sandbox);
    const parsed = await sandbox.exports.__testParseMessageItem(
      {
        msg_type: "interactive",
        message_id: "om_structured_footer_card",
        chat_id: "oc_footer",
        body: { content: "{}" },
      },
      "om_structured_footer_card",
    );
    assert.equal(parsed.content, "柚子\n宁波");

    // Syntax check: patched dispatch.js must still parse (no JS broken).
    execSync(`node --check ${scratch}`, { stdio: "pipe" });
    execSync(`node --check ${lookupScratch}`, { stdio: "pipe" });
  } finally {
    execSync(`rm -f ${scratch} ${lookupScratch}`);
  }
});

test("PATCH: apply-inbound-history-meta.sh renders message metadata in core history JSON", () => {
  const scratch = join(dirname(DISPATCH_PATH), "get-reply-meta.patchscratch.js");
  writeFileSync(
    scratch,
    `
function normalizePromptMetadataString(value) { return value == null ? undefined : String(value).trim() || undefined; }
function stripNullBytes(value) {
\treturn value.replaceAll("\\0", "");
}
function sanitizePromptBody(value) {
\tif (typeof value !== "string") return;
\treturn stripNullBytes(value) || void 0;
}
function render(boundedHistory) {
  const label = "Chat history since last reply (untrusted, for context):";
  return boundedHistory.map((entry) => ({
    sender: sanitizePromptBody(entry.sender),
    timestamp_ms: entry.timestamp,
    body: sanitizePromptBody(entry.body)
  }));
}
`,
  );
  try {
    execSync(`bash ${APPLY_INBOUND_HISTORY_META_SH} ${scratch}`, { stdio: "pipe" });
    const once = readFileSync(scratch, "utf-8");
    assert.match(once, /CARHER_INBOUND_HISTORY_META_PATCH_MARKER/);
    assert.match(once, /message_id: normalizePromptMetadataString\(entry\.messageId\)/);
    assert.match(once, /message_type: normalizePromptMetadataString\(entry\.messageType\)/);
    assert.match(once, /reply_to_id: normalizePromptMetadataString\(entry\.replyToId\)/);
    assert.match(once, /CARHER_REPLY_TARGET_CARD_CLEANUP_PATCH_MARKER/);
    assert.match(once, /carherStripFlattenedEngineCardFooter\(stripNullBytes\(value\)\)/);

    const singleMetaCount = (once.match(/CARHER_INBOUND_HISTORY_META_PATCH_MARKER/g) ?? []).length;
    assert.equal(singleMetaCount, 2, "single apply: exactly one metadata block");
    execSync(`node --check ${scratch}`, { stdio: "pipe" });
    const runner = join(dirname(DISPATCH_PATH), "reply-card-cleanup-runner.patchscratch.cjs");
    writeFileSync(
      runner,
      `
const fs = require("fs");
const vm = require("vm");
const code = fs.readFileSync(${JSON.stringify(scratch)}, "utf8");
const sandbox = {};
vm.runInNewContext(code, sandbox);
const cases = [
  {
    name: "plain card",
    input: "<card>\\nbody\\n---\\n🦞 OpenClaw · opus4.7 · 1k/1.0m · 1% · 🔒主人@ · 1.0s\\n</card>",
    expected: "body",
  },
  {
    name: "message id prefix",
    input: "[message_id=om_real] <card>\\n葡萄\\n苏州\\n---\\n🦞 OpenClaw · opus4.7 · 1k/1.0m · 1% · 🔒主人@ · 1.0s\\n</card>",
    expected: "[message_id=om_real] 葡萄\\n苏州",
  },
  {
    name: "message id prefix escaped newlines",
    input: "[message_id=om_real] <card>\\\\n石榴\\\\n杭州\\\\n---\\\\n🦞 OpenClaw · opus4.7 · 1k/1.0m · 1% · 🔒主人@ · 1.0s\\\\n</card>",
    expected: "[message_id=om_real] 石榴\\n杭州",
  },
  {
    name: "Hermes",
    input: "<card>\\n颜色\\n---\\n**☤ Hermes** · opus4.7 · 1k/1.0m · 1% · 🔒主人@ · 1.0s\\n</card>",
    expected: "颜色",
  },
  {
    name: "body separator",
    input: "<card>\\n段1\\n---\\n段2\\n---\\n🦞 OpenClaw · opus4.7 · 1k/1.0m · 1% · 🔒主人@ · 1.0s\\n</card>",
    expected: "段1\\n---\\n段2",
  },
  {
    name: "no footer",
    input: "<card>\\n段1\\n---\\n段2\\n</card>",
    expected: "<card>\\n段1\\n---\\n段2\\n</card>",
  },
  {
    name: "arbitrary prefix",
    input: "quoted <card>\\nbody\\n---\\n🦞 OpenClaw · opus4.7 · 1k/1.0m · 1% · 🔒主人@ · 1.0s\\n</card>",
    expected: "quoted <card>\\nbody\\n---\\n🦞 OpenClaw · opus4.7 · 1k/1.0m · 1% · 🔒主人@ · 1.0s\\n</card>",
  },
];
for (const item of cases) {
  const result = sandbox.sanitizePromptBody(item.input);
  if (result !== item.expected) {
    throw new Error(item.name + " cleanup mismatch: " + JSON.stringify(result));
  }
}
`,
    );
    execSync(`node ${runner}`, { stdio: "pipe" });
    execSync(`bash ${APPLY_INBOUND_HISTORY_META_SH} ${scratch}`, { stdio: "pipe" });
    const twice = readFileSync(scratch, "utf-8");
    const doubleMetaCount = (twice.match(/CARHER_INBOUND_HISTORY_META_PATCH_MARKER/g) ?? []).length;
    assert.equal(doubleMetaCount, 2, "idempotent: double-apply must not duplicate metadata");
  } finally {
    execSync(`rm -f ${scratch}`);
    execSync(`rm -f ${join(dirname(DISPATCH_PATH), "reply-card-cleanup-runner.patchscratch.cjs")}`);
  }
});

test("PATCH: apply-inbound-history-meta.sh filters replayed runtime context blocks", () => {
  const scratchDir = dirname(DISPATCH_PATH);
  const getReplyScratch = join(scratchDir, "get-reply-meta-replay.patchscratch.js");
  const replayScratch = join(scratchDir, "compaction-successor-transcript.patchscratch.js");
  const queueScratch = join(scratchDir, "runtime-context-prompt.patchscratch.js");
  const dataRoot = join(scratchDir, "runtime-context-scrub-data.patchscratch");
  const sessionFile = join(dataRoot, "agents/main/sessions/test.jsonl");
  const resetSessionFile = join(
    dataRoot,
    "agents/main/sessions/test.jsonl.reset.2026-05-11T00-00-00.000Z",
  );
  writeFileSync(
    getReplyScratch,
    `
function normalizePromptMetadataString(value) { return value == null ? undefined : String(value).trim() || undefined; }
function stripNullBytes(value) {
\treturn value.replaceAll("\\0", "");
}
function sanitizePromptBody(value) {
\tif (typeof value !== "string") return;
\treturn stripNullBytes(value) || void 0;
}
function render(boundedHistory) {
  const label = "Chat history since last reply (untrusted, for context):";
  return boundedHistory.map((entry) => ({
    sender: sanitizePromptBody(entry.sender),
    timestamp_ms: entry.timestamp,
    body: sanitizePromptBody(entry.body)
  }));
}
`,
  );
  writeFileSync(
    replayScratch,
    `
function annotateInterSessionUserMessages(messages) { return messages; }
function normalizeAssistantReplayContent(messages) { return messages; }
async function sanitizeSessionMessagesImages(messages) { return messages; }
async function sanitizeSessionHistory(params) {
\tconst withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
\tconst sanitizedImages = await sanitizeSessionMessagesImages(normalizeAssistantReplayContent(withInterSessionMarkers), "session:history", {});
\treturn sanitizedImages;
}
sanitizeSessionHistory({ messages: [
  {
    role: "custom",
    customType: "openclaw.runtime-context",
    content: "Chat history since last reply (untrusted, for context):\\nold"
  },
  {
    role: "user",
    content: "Conversation info (untrusted metadata):\\n\`\`\`json\\n{}\\n\`\`\`\\n\\nChat history since last reply (untrusted, for context):\\n\`\`\`json\\n[{\\"body\\":\\"old\\"}]\\n\`\`\`\\n\\nactual question"
  }
] }).then((out) => {
  if (out.length !== 1) throw new Error("expected stale runtime-context to be dropped");
  if (out[0].content !== "actual question") throw new Error("expected replayed inbound metadata to be stripped");
});
`,
  );
  writeFileSync(
    queueScratch,
    `
async function queueRuntimeContextForNextTurn(params) {
\tconst runtimeContext = params.runtimeContext?.trim();
\tif (!runtimeContext) return;
\tawait params.session.sendCustomMessage({
\t\tcustomType: "openclaw.runtime-context",
\t\tcontent: runtimeContext,
\t\tdisplay: false,
\t\tdetails: { source: "openclaw-runtime-context" }
\t}, { deliverAs: "nextTurn" });
}
async function main() {
  const sent = [];
  const session = { sendCustomMessage: async (message) => sent.push(message) };
  await queueRuntimeContextForNextTurn({
    runtimeContext: "Chat history since last reply (untrusted, for context):\\nold",
    session
  });
  await queueRuntimeContextForNextTurn({
    runtimeContext: "non-Feishu runtime context",
    session
  });
  if (sent.length !== 1) throw new Error("expected Feishu runtime context not to persist");
  if (sent[0].content !== "non-Feishu runtime context") throw new Error("expected ordinary runtime context to persist");
}
main();
`,
  );
  execSync(`mkdir -p ${dirname(sessionFile)}`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "custom_message",
      customType: "openclaw.runtime-context",
      content: "Chat history since last reply (untrusted, for context):\nold",
    })}\n${JSON.stringify({
      traceSchema: "openclaw-trajectory",
      type: "model.completed",
      data: {
        messagesSnapshot: [
          { role: "user", content: "real prompt" },
          {
            role: "custom",
            customType: "openclaw.runtime-context",
            content: "Chat history since last reply (untrusted, for context):\nold",
          },
        ],
      },
    })}\n${JSON.stringify({ type: "message", role: "user", content: "real user text" })}\n`,
  );
  writeFileSync(
    resetSessionFile,
    `${JSON.stringify({
      type: "custom_message",
      customType: "openclaw.runtime-context",
      content: "Chat history since last reply (untrusted, for context):\narchived",
    })}\n${JSON.stringify({ type: "message", role: "user", content: "archived real text" })}\n`,
  );
  try {
    execSync(
      `CARHER_OPENCLAW_DATA_ROOT=${dataRoot} bash ${APPLY_INBOUND_HISTORY_META_SH} ${getReplyScratch}`,
      {
        stdio: "pipe",
      },
    );
    const once = readFileSync(replayScratch, "utf-8");
    assert.match(once, /CARHER_REPLAY_CONTEXT_FILTER_PATCH_MARKER/);
    assert.match(once, /customType !== "openclaw\.runtime-context"/);
    execSync(`node --check ${replayScratch}`, { stdio: "pipe" });
    execSync(`node ${replayScratch}`, { stdio: "pipe" });

    const queueOnce = readFileSync(queueScratch, "utf-8");
    assert.match(queueOnce, /CARHER_RUNTIME_CONTEXT_QUEUE_FEISHU_SKIP_PATCH_MARKER/);
    execSync(`node --check ${queueScratch}`, { stdio: "pipe" });
    execSync(`node ${queueScratch}`, { stdio: "pipe" });

    const scrubbed = readFileSync(sessionFile, "utf-8");
    assert.doesNotMatch(scrubbed, /openclaw\.runtime-context/);
    assert.doesNotMatch(scrubbed, /Chat history since last reply/);
    assert.match(scrubbed, /real prompt/);
    assert.match(scrubbed, /real user text/);
    const scrubbedReset = readFileSync(resetSessionFile, "utf-8");
    assert.doesNotMatch(scrubbedReset, /openclaw\.runtime-context/);
    assert.match(scrubbedReset, /archived real text/);

    execSync(
      `CARHER_OPENCLAW_DATA_ROOT=${dataRoot} bash ${APPLY_INBOUND_HISTORY_META_SH} ${getReplyScratch}`,
      {
        stdio: "pipe",
      },
    );
    const twice = readFileSync(replayScratch, "utf-8");
    const markerCount = (twice.match(/CARHER_REPLAY_CONTEXT_FILTER_PATCH_MARKER/g) ?? []).length;
    assert.equal(markerCount, 1, "idempotent: double-apply must not duplicate replay filter");
    execSync(`node ${replayScratch}`, { stdio: "pipe" });

    const queueTwice = readFileSync(queueScratch, "utf-8");
    const queueMarkerCount = (
      queueTwice.match(/CARHER_RUNTIME_CONTEXT_QUEUE_FEISHU_SKIP_PATCH_MARKER/g) ?? []
    ).length;
    assert.equal(queueMarkerCount, 2, "idempotent: double-apply must not duplicate queue filter");
    execSync(`node ${queueScratch}`, { stdio: "pipe" });
  } finally {
    execSync(`rm -f ${getReplyScratch} ${replayScratch} ${queueScratch}`);
    execSync(`rm -rf ${dataRoot}`);
  }
});
