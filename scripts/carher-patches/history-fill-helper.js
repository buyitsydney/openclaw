"use strict";
// scripts/carher-patches/history-fill-helper.js
//
// CARHER PATCH: proactive 20-msg group history fill.
//
// Why this exists: 1-week-ago feishu-her/gateway.ts fetched the most recent
// 20 group messages via tenant_access_token on every @mention. That code was
// removed when the channel moved to @larksuite/openclaw-lark, which now
// accumulates history passively via `im.message.receive_v1` events. After a
// container restart the in-memory Map is empty, so bots lose context until
// humans rebuild it message-by-message. This helper restores pre-migration
// behavior without forking the lark package.
//
// Shipped into the container at:
//   /data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/messaging/inbound/carher-history-fill.js
//
// Invoked by a one-line patch inserted into dispatch.js by
// scripts/carher-patches/apply-history-fill.sh.

const HISTORY_FILL_TARGET = 20; // mirrors MAX_UNTRUSTED_HISTORY_ENTRIES in SDK
// No time window: we want the last 20 messages regardless of how long ago
// they were. A user who leaves a conversation overnight and @mentions the
// bot the next morning should still get full context. Feishu's
// /im/v1/messages treats start_time/end_time as optional — omitting them
// returns the most recent page.

function threadScopedKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

function extractPlainText(body) {
  if (!body || typeof body !== "object") return "";
  const raw = body.content;
  if (typeof raw !== "string" || raw.length === 0) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === "string") return parsed.text;
  } catch {
    // body.content is not always JSON (e.g. post, file, image) — fall back to raw.
  }
  return raw;
}

function optionalRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}

function senderIdFromMessage(m) {
  return (m && m.sender && m.sender.id) || "unknown";
}

function senderTypeFromMessage(m) {
  return (m && m.sender && m.sender.sender_type) || "";
}

function formatSenderLabel(senderId, name) {
  if (!senderId || senderId === "unknown") return name || "unknown";
  if (!name || name === senderId) return senderId;
  return `${name} (${senderId})`;
}

async function resolveHistorySenderNames({ dc, items, nameMap, log }) {
  const names = new Map(nameMap ? Array.from(nameMap.entries()) : []);
  const accountId = dc && dc.account && dc.account.accountId;
  if (!accountId) return names;

  const userNameModule = optionalRequire("./user-name-cache.js");
  const cache =
    userNameModule && typeof userNameModule.getUserNameCache === "function"
      ? userNameModule.getUserNameCache(accountId)
      : null;

  const ids = [];
  for (const m of items) {
    const id = senderIdFromMessage(m);
    if (!id || id === "unknown" || names.has(id)) continue;
    const cached = cache && typeof cache.get === "function" ? cache.get(id) : undefined;
    if (cached) {
      names.set(id, cached);
      continue;
    }
    if (senderTypeFromMessage(m) === "user") ids.push(id);
  }

  const missingUsers = [...new Set(ids.filter((id) => !names.has(id)))];
  if (
    missingUsers.length > 0 &&
    userNameModule &&
    typeof userNameModule.batchResolveUserNames === "function"
  ) {
    try {
      const resolved = await userNameModule.batchResolveUserNames({
        account: dc.account,
        openIds: missingUsers,
        log,
      });
      for (const [id, name] of resolved.entries()) {
        if (name) names.set(id, name);
      }
    } catch (err) {
      log(`[carher-history-fill] sender name resolve failed: ${String(err)}`);
    }
  }

  return names;
}

async function extractMessageText(m, dc, testHooks) {
  const body = m && m.body;
  const raw = body && typeof body.content === "string" ? body.content : "";
  const messageType = m && (m.msg_type || m.message_type || m.content_type);
  const converterModule =
    testHooks && testHooks.convertMessageContent
      ? null
      : optionalRequire("../converters/content-converter.js");
  const convertMessageContent =
    (testHooks && testHooks.convertMessageContent) ||
    (converterModule && converterModule.convertMessageContent);
  const buildConvertContextFromItem =
    (testHooks && testHooks.buildConvertContextFromItem) ||
    (converterModule && converterModule.buildConvertContextFromItem);

  if (typeof convertMessageContent === "function" && raw && messageType) {
    try {
      const accountId = dc && dc.account && dc.account.accountId;
      const ctx =
        typeof buildConvertContextFromItem === "function"
          ? buildConvertContextFromItem(m, m.message_id, accountId)
          : { accountId };
      const converted = await convertMessageContent(raw, messageType, ctx);
      if (converted && typeof converted.content === "string" && converted.content.trim()) {
        return converted.content;
      }
    } catch {
      // Fall back to the lightweight parser below.
    }
  }

  return extractPlainText(body);
}

async function defaultTokenProvider(dc) {
  try {
    const { LarkClient } = require("../../core/lark-client.js");
    const lark = LarkClient.fromAccount(dc.account);
    // tokenManager lives on the underlying Lark SDK client, not on LarkClient
    // itself. LarkClient exposes it via the lazy `sdk` getter.
    const sdk = lark && lark.sdk;
    const tokenManager = sdk && sdk.tokenManager;
    if (!tokenManager || typeof tokenManager.getTenantAccessToken !== "function") {
      return null;
    }
    const token = await tokenManager.getTenantAccessToken({});
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Back-fill chatHistories Map with up to 20 recent messages from the Feishu
 * `/im/v1/messages` API when the Map is sparse for this chat. No-op for DMs,
 * when history is already full, when the account lacks a tenant token, or
 * when the fetch fails (preserves the original "since last reply" behavior
 * as a safe fallback).
 */
async function fillChatHistoryIfSparse(args) {
  const { dc, params } = args || {};
  if (!dc || !params) return;
  if (!dc.isGroup) return;
  if (!params.chatHistories) return;
  if (!(params.historyLimit > 0)) return;

  const chatId = dc.ctx && dc.ctx.chatId;
  if (!chatId) return;

  const historyKey = threadScopedKey(
    chatId,
    dc.isThread ? dc.ctx.threadId : undefined,
  );

  const want = Math.min(HISTORY_FILL_TARGET, params.historyLimit);
  const existing = params.chatHistories.get(historyKey);
  const have = Array.isArray(existing) ? existing.length : 0;
  const _log = typeof dc.log === "function" ? dc.log : () => {};
  if (have >= want) {
    _log(`[carher-history-fill] skip ${chatId}: have=${have} >= want=${want}`);
    return;
  }
  _log(`[carher-history-fill] start ${chatId}: have=${have} want=${want}`);

  const fetchImpl = args._testFetch || globalThis.fetch;
  const tokenProvider = args._testTokenProvider || (() => defaultTokenProvider(dc));

  if (typeof fetchImpl !== "function") {
    _log(`[carher-history-fill] no fetch impl — skip`);
    return;
  }

  let token;
  const tokenStart = Date.now();
  try {
    token = await tokenProvider(dc);
  } catch (err) {
    _log(`[carher-history-fill] token error: ${String(err)}`);
    return;
  }
  const tokenMs = Date.now() - tokenStart;
  if (!token) {
    _log(`[carher-history-fill] no token after ${tokenMs}ms — skip`);
    return;
  }

  const url =
    "https://open.feishu.cn/open-apis/im/v1/messages?" +
    "container_id_type=chat" +
    `&container_id=${encodeURIComponent(chatId)}` +
    "&sort_type=ByCreateTimeDesc" +
    `&page_size=${want}`;

  let resp;
  const fetchStart = Date.now();
  try {
    resp = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    _log(`[carher-history-fill] fetch error after ${Date.now() - fetchStart}ms: ${String(err)}`);
    return;
  }
  const fetchMs = Date.now() - fetchStart;
  if (!resp || !resp.ok) {
    _log(`[carher-history-fill] fetch !ok status=${resp && resp.status} in ${fetchMs}ms`);
    return;
  }

  let payload;
  try {
    payload = await resp.json();
  } catch (err) {
    _log(`[carher-history-fill] json error: ${String(err)}`);
    return;
  }
  const items = (payload && payload.data && payload.data.items) || [];
  if (!Array.isArray(items) || items.length === 0) {
    _log(`[carher-history-fill] 0 items in ${fetchMs}ms (code=${payload && payload.code})`);
    return;
  }

  // API returns newest-first; reverse to chronological (oldest first) so the
  // prompt injection reads naturally. Also drop the current trigger message
  // so it isn't double-counted with the @mention it's being dispatched for.
  const currentMessageId = dc.ctx && dc.ctx.messageId;
  const chronological = items.slice().reverse();
  const senderNames = await resolveHistorySenderNames({
    dc,
    items: chronological,
    nameMap: args._testNameMap,
    log: _log,
  });

  const entries = [];
  for (const m of chronological) {
    if (!m || typeof m !== "object") continue;
    if (currentMessageId && m.message_id === currentMessageId) continue;
    const senderId = senderIdFromMessage(m);
    const senderLabel = formatSenderLabel(senderId, senderNames.get(senderId));
    const text = await extractMessageText(m, dc, {
      convertMessageContent: args._testConvertMessageContent,
      buildConvertContextFromItem: args._testBuildConvertContextFromItem,
    });
    if (!text) continue;
    const ts = Number(m.create_time);
    entries.push({
      sender: senderLabel,
      body: text,
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
      messageId: m.message_id,
    });
    if (entries.length >= want) break;
  }

  if (entries.length === 0) {
    _log(`[carher-history-fill] 0 usable entries parsed from ${items.length} items`);
    return;
  }
  params.chatHistories.set(historyKey, entries);
  _log(`[carher-history-fill] done ${chatId}: filled ${entries.length} in ${fetchMs}ms (token=${tokenMs}ms)`);
}

module.exports = { fillChatHistoryIfSparse };
