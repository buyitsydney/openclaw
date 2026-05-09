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
const UPGRADE_CLIENT_HINT = "请升级至最新版本客户端";
const UPGRADE_CLIENT_HINT_RE = /请升级至最新版本客户端[，,\s]*以查看内容[。.]?/g;
const INTERACTIVE_UNAVAILABLE = "[interactive card: content not extractable via Feishu API]";
// No time window: we want the last 20 messages regardless of how long ago
// they were. A user who leaves a conversation overnight and @mentions the
// bot the next morning should still get full context. Feishu's
// /im/v1/messages treats start_time/end_time as optional — omitting them
// returns the most recent page.

function threadScopedKey(chatId, threadId) {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function removeUpgradeHint(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(UPGRADE_CLIENT_HINT_RE, "")
    .replace(UPGRADE_CLIENT_HINT, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasUpgradeHint(text) {
  return typeof text === "string" && text.includes(UPGRADE_CLIENT_HINT);
}

function usableText(text) {
  const cleaned = removeUpgradeHint(text);
  return cleaned.length > 0 ? cleaned : "";
}

function isWeakInteractiveText(text, messageType) {
  if (messageType !== "interactive") return false;
  const normalized = trimString(text).toLowerCase();
  return (
    normalized === "[interactive card]" ||
    normalized === INTERACTIVE_UNAVAILABLE.toLowerCase() ||
    normalized.startsWith("[interactive card —") ||
    normalized.startsWith("[interactive card -")
  );
}

function formatMention(node) {
  const userName = trimString(node && node.user_name);
  const userId = trimString(node && (node.user_id || node.id));
  return userName ? `@${userName}` : userId ? `@${userId}` : "";
}

function extractTextNodeContent(node) {
  if (!node || typeof node !== "object") return "";
  return usableText(node.content) || usableText(node.text);
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function flattenCardElement(element, acc) {
  if (!element || typeof element !== "object") return "";
  if (Array.isArray(element)) {
    return element
      .map((child) => flattenCardElement(child, acc))
      .filter(Boolean)
      .join("");
  }

  const tag = trimString(element.tag);
  switch (tag) {
    case "text":
    case "plain_text":
    case "markdown":
    case "lark_md":
      return usableText(element.text) || usableText(element.content);
    case "a": {
      const text = usableText(element.text) || usableText(element.content);
      const href = trimString(element.href) || trimString(element.url);
      return text && href ? `[${text}](${href})` : text;
    }
    case "at":
      return formatMention(element);
    case "img": {
      const imageKey = trimString(element.img_key) || trimString(element.image_key);
      pushUnique(acc.imageKeys, imageKey);
      return acc.imagePlaceholder;
    }
    case "media": {
      const fileName = trimString(element.file_name) || "video";
      return `[video:${fileName}]`;
    }
    case "emotion":
      return element.emoji_type ? `[${trimString(element.emoji_type)}]` : "[emotion]";
    case "button": {
      const label = extractTextNodeContent(element.text);
      return label ? `[button: ${label}]` : "[button]";
    }
    case "hr":
      return "---";
    case "div": {
      const parts = [];
      const directText = extractTextNodeContent(element.text);
      if (directText) parts.push(directText);
      if (Array.isArray(element.fields)) {
        for (const field of element.fields) {
          const fieldText = extractTextNodeContent(field && field.text);
          if (fieldText) parts.push(fieldText);
        }
      }
      return parts.join("\n");
    }
    case "note":
    case "column":
    case "column_set":
    case "action":
    default: {
      const childGroups = [];
      if (Array.isArray(element.elements)) childGroups.push(element.elements);
      if (Array.isArray(element.columns)) childGroups.push(element.columns);
      if (Array.isArray(element.actions)) childGroups.push(element.actions);
      const childText = childGroups
        .flat()
        .map((child) => flattenCardElement(child, acc))
        .filter(Boolean)
        .join(tag === "note" ? " " : "\n");
      if (childText) return childText;
      return extractTextNodeContent(element.text) || usableText(element.content);
    }
  }
}

function parseInteractiveText(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const acc = { imageKeys: [], imagePlaceholder: "<media:image>" };
  const lines = [];
  const headerTitle = extractTextNodeContent(parsed.header && parsed.header.title);
  const title = usableText(parsed.title);
  if (headerTitle) lines.push(headerTitle);
  else if (title) lines.push(title);

  const bodyElements =
    parsed.body && typeof parsed.body === "object" && Array.isArray(parsed.body.elements)
      ? parsed.body.elements
      : null;
  const topElements = Array.isArray(parsed.elements) ? parsed.elements : null;
  const elementGroups = bodyElements || topElements;
  if (Array.isArray(elementGroups)) {
    for (const element of elementGroups) {
      if (Array.isArray(element)) {
        const row = element.map((child) => flattenCardElement(child, acc)).join("").trim();
        if (row) lines.push(row);
      } else {
        const text = flattenCardElement(element, acc).trim();
        if (text) lines.push(text);
      }
    }
  }

  const rawText = usableText(lines.join("\n"));
  if (rawText) return rawText;
  if (acc.imageKeys.length > 0) {
    return `[interactive card: image ${acc.imageKeys.join(", ")}]`;
  }
  return "";
}

function resolvePostBody(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (Array.isArray(parsed.content)) return parsed;
  const zhCn = parsed.zh_cn;
  const enUs = parsed.en_us;
  const first = Object.values(parsed)[0];
  if (zhCn && typeof zhCn === "object") return zhCn;
  if (enUs && typeof enUs === "object") return enUs;
  return first && typeof first === "object" ? first : null;
}

function parsePostText(parsed) {
  const body = resolvePostBody(parsed);
  if (!body || !Array.isArray(body.content)) return "";
  const lines = [];
  const title = usableText(body.title);
  if (title) lines.push(title);
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];
    for (const el of paragraph) {
      if (!el || typeof el !== "object") continue;
      if (el.tag === "text") {
        parts.push(usableText(el.text));
      } else if (el.tag === "a") {
        const text = usableText(el.text);
        const href = trimString(el.href);
        parts.push(text && href ? `[${text}](${href})` : text);
      } else if (el.tag === "at") {
        parts.push(formatMention(el));
      } else if (el.tag === "img") {
        parts.push("<media:image>");
      } else if (el.tag === "media") {
        parts.push(`[video:${trimString(el.file_name) || "video"}]`);
      } else if (el.tag === "emotion") {
        parts.push(el.emoji_type ? `[${trimString(el.emoji_type)}]` : "[emotion]");
      }
    }
    const line = parts.filter(Boolean).join("").trim();
    if (line) lines.push(line);
  }
  return usableText(lines.join("\n"));
}

function fallbackMessageText(raw, messageType) {
  const parsed = parseJson(raw);
  if (!parsed) return usableText(raw);

  switch (messageType) {
    case "text":
      return usableText(parsed.text) || usableText(raw);
    case "post":
      return parsePostText(parsed) || usableText(raw);
    case "interactive":
      return parseInteractiveText(parsed);
    case "image": {
      const imageKey = trimString(parsed.image_key);
      return imageKey ? `[image: ${imageKey}]` : "[image]";
    }
    case "file": {
      const fileName = trimString(parsed.file_name) || trimString(parsed.file_key) || "unknown";
      return `[file: ${fileName}]`;
    }
    case "audio": {
      const fileKey = trimString(parsed.file_key) || "unknown";
      return `[audio: ${fileKey}]`;
    }
    case "media":
    case "video": {
      const fileName = trimString(parsed.file_name) || "video";
      return `[video: ${fileName}]`;
    }
    case "sticker":
      return "[sticker]";
    default:
      return usableText(parsed.text) || usableText(parsed.content) || usableText(raw);
  }
}

function extractPlainText(body) {
  if (!body || typeof body !== "object") return "";
  const raw = body.content;
  if (typeof raw !== "string" || raw.length === 0) return "";
  return fallbackMessageText(raw, "text");
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
  const messageId = m && m.message_id;
  const body = m && m.body;
  const raw = body && typeof body.content === "string" ? body.content : "";
  const messageType = m && (m.msg_type || m.message_type || m.content_type);

  // Mirror feishu-her's chat-history canonicalization step: timeline/list
  // results can contain degraded interactive bodies, while message.get returns
  // the stable card payload that lark-cli +messages-mget renders as <card>.
  if (messageId && messageType === "interactive") {
    const canonical = await fetchCanonicalMessageItem({
      messageId,
      fetchImpl: testHooks && testHooks.fetchImpl,
      token: testHooks && testHooks.token,
      log: testHooks && testHooks.log,
      testFetchCanonicalMessage: testHooks && testHooks.fetchCanonicalMessage,
    });
    if (canonical) {
      const canonicalText = await extractMessageTextFromItem(canonical, dc, testHooks);
      if (canonicalText && !isWeakInteractiveText(canonicalText, messageType)) {
        return canonicalText;
      }
      if (canonicalText && !hasUpgradeHint(canonicalText)) {
        return canonicalText;
      }
    }
  }

  const localText = await extractMessageTextFromItem(m, dc, testHooks);
  const shouldTryCanonical =
    messageId &&
    messageType !== "interactive" &&
    (hasUpgradeHint(raw) || !localText || isWeakInteractiveText(localText, messageType));
  if (!shouldTryCanonical && localText && !isWeakInteractiveText(localText, messageType)) {
    return localText;
  }

  if (shouldTryCanonical) {
    const canonical = await fetchCanonicalMessageItem({
      messageId,
      fetchImpl: testHooks && testHooks.fetchImpl,
      token: testHooks && testHooks.token,
      log: testHooks && testHooks.log,
      testFetchCanonicalMessage: testHooks && testHooks.fetchCanonicalMessage,
    });
    if (canonical && canonical !== m) {
      const canonicalText = await extractMessageTextFromItem(canonical, dc, testHooks);
      if (canonicalText && !isWeakInteractiveText(canonicalText, messageType)) {
        return canonicalText;
      }
      if (canonicalText && !hasUpgradeHint(canonicalText)) {
        return canonicalText;
      }
    }
  }

  return hasUpgradeHint(localText) ? "" : localText;
}

async function extractMessageTextFromItem(m, dc, testHooks) {
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
      if (converted && typeof converted.content === "string") {
        const text = usableText(converted.content);
        if (text && !isWeakInteractiveText(text, messageType)) {
          return text;
        }
      }
    } catch {
      // Fall back to the lightweight parser below.
    }
  }

  const fallback = fallbackMessageText(raw, messageType || "text");
  if (fallback) return fallback;
  return extractPlainText(body);
}

async function fetchCanonicalMessageItem(params) {
  if (typeof params.testFetchCanonicalMessage === "function") {
    try {
      return await params.testFetchCanonicalMessage(params.messageId);
    } catch (err) {
      if (params.log) params.log(`[carher-history-fill] test canonical fetch failed: ${String(err)}`);
      return null;
    }
  }
  if (!params.messageId || !params.token || typeof params.fetchImpl !== "function") return null;
  const url =
    `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}` +
    "?user_id_type=open_id";
  try {
    const signal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(3000)
        : undefined;
    const resp = await params.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.token}` },
      ...(signal ? { signal } : {}),
    });
    if (!resp || !resp.ok) {
      if (params.log) {
        params.log(
          `[carher-history-fill] canonical fetch !ok message=${params.messageId} status=${resp && resp.status}`,
        );
      }
      return null;
    }
    const payload = await resp.json();
    const items = payload && payload.data && payload.data.items;
    return Array.isArray(items) ? items[0] || null : null;
  } catch (err) {
    if (params.log) {
      params.log(`[carher-history-fill] canonical fetch error message=${params.messageId}: ${String(err)}`);
    }
    return null;
  }
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
      fetchCanonicalMessage: args._testFetchCanonicalMessage,
      fetchImpl,
      token,
      log: _log,
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
