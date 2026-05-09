"use strict";
// scripts/carher-patches/history-fill-helper.js
//
// CARHER PATCH: proactive 20-msg group history fill.
//
// Why this exists: 1-week-ago feishu-her/gateway.ts proactively fetched recent
// group messages on every @mention. That code was removed when the channel
// moved to @larksuite/openclaw-lark, which now accumulates history passively via
// `im.message.receive_v1` events. After a container restart the in-memory Map is
// empty, so bots lose context until humans rebuild it message-by-message. This
// helper restores pre-migration behavior without forking the lark package.
//
// Primary source: lark-cli's default user-token view, matching the audit command
// Her uses for 1:1 comparisons:
//   lark-cli im +chat-messages-list --chat-id <oc_...> --page-size 20 --sort desc --format json
// The raw Feishu API path below is only a fallback when lark-cli is unavailable.
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
  const property = node.property && typeof node.property === "object" ? node.property : null;
  const directText = node.text;
  const propertyText = property && property.text;
  return (
    usableText(node.content) ||
    (typeof directText === "string" ? usableText(directText) : extractTextNodeContent(directText)) ||
    (property ? usableText(property.content) : "") ||
    (typeof propertyText === "string" ? usableText(propertyText) : extractTextNodeContent(propertyText))
  );
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
  const property = element.property && typeof element.property === "object" ? element.property : null;
  switch (tag) {
    case "text":
    case "plain_text":
    case "markdown":
    case "lark_md":
      return extractTextNodeContent(element);
    case "a": {
      const text = extractTextNodeContent(element);
      const href =
        trimString(element.href) ||
        trimString(element.url) ||
        (property ? trimString(property.href) || trimString(property.url) : "");
      return text && href ? `[${text}](${href})` : text;
    }
    case "at":
      return formatMention(element);
    case "img": {
      const imageKey =
        trimString(element.img_key) ||
        trimString(element.image_key) ||
        (property ? trimString(property.img_key) || trimString(property.image_key) : "");
      pushUnique(acc.imageKeys, imageKey);
      return acc.imagePlaceholder;
    }
    case "media": {
      const fileName =
        trimString(element.file_name) || (property ? trimString(property.file_name) : "") || "video";
      return `[video:${fileName}]`;
    }
    case "emotion":
      return element.emoji_type ? `[${trimString(element.emoji_type)}]` : "[emotion]";
    case "button": {
      const label =
        extractTextNodeContent(element.text) || (property ? extractTextNodeContent(property.text) : "");
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
      if (property && Array.isArray(property.fields)) {
        for (const field of property.fields) {
          const fieldText = extractTextNodeContent(field && field.text);
          if (fieldText) parts.push(fieldText);
        }
      }
      if (property && Array.isArray(property.elements)) {
        const childText = flattenCardChildren(property.elements, acc);
        if (childText) parts.push(childText);
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
      if (property && Array.isArray(property.elements)) childGroups.push(property.elements);
      if (property && Array.isArray(property.columns)) childGroups.push(property.columns);
      if (property && Array.isArray(property.actions)) childGroups.push(property.actions);
      const childText = childGroups
        .map((children) => flattenCardChildren(children, acc, tag))
        .filter(Boolean)
        .join(tag === "note" ? " " : "\n");
      if (childText) return childText;
      return extractTextNodeContent(element.text) || usableText(element.content);
    }
  }
}

function isInlineCardElement(element) {
  if (!element || typeof element !== "object" || Array.isArray(element)) return false;
  const tag = trimString(element.tag);
  return ["text", "plain_text", "markdown", "lark_md", "a", "at", "img", "emotion"].includes(tag);
}

function flattenCardChildren(children, acc, parentTag) {
  if (!Array.isArray(children)) return "";
  const parts = children.map((child) => flattenCardElement(child, acc)).filter(Boolean);
  if (parts.length === 0) return "";
  if (parentTag === "note") return parts.join(" ");
  const allInline = children.every(isInlineCardElement);
  return parts.join(allInline ? "" : "\n");
}

function parseInteractiveText(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  if (typeof parsed.json_card === "string") {
    const jsonCard = parseJson(parsed.json_card);
    const text = parseInteractiveText(jsonCard);
    return text ? `<card>\n${text}\n</card>` : "";
  }
  const acc = { imageKeys: [], imagePlaceholder: "<media:image>" };
  const lines = [];
  const header = parsed.header && typeof parsed.header === "object" ? parsed.header : null;
  const headerProperty = header && header.property && typeof header.property === "object" ? header.property : null;
  const headerTitle =
    extractTextNodeContent(header && header.title) || extractTextNodeContent(headerProperty && headerProperty.title);
  const title =
    usableText(parsed.title) ||
    extractTextNodeContent(parsed.title) ||
    (parsed.property && typeof parsed.property === "object" ? extractTextNodeContent(parsed.property.title) : "");
  if (headerTitle) lines.push(headerTitle);
  else if (title) lines.push(title);

  const bodyElements =
    parsed.body && typeof parsed.body === "object" && Array.isArray(parsed.body.elements)
      ? parsed.body.elements
      : parsed.body &&
          typeof parsed.body === "object" &&
          parsed.body.property &&
          typeof parsed.body.property === "object" &&
          Array.isArray(parsed.body.property.elements)
        ? parsed.body.property.elements
      : null;
  const topElements = Array.isArray(parsed.elements)
    ? parsed.elements
    : parsed.property && typeof parsed.property === "object" && Array.isArray(parsed.property.elements)
      ? parsed.property.elements
      : null;
  const elementGroups = bodyElements || topElements;
  if (Array.isArray(elementGroups)) {
    for (const element of elementGroups) {
      if (Array.isArray(element)) {
        const row = flattenCardChildren(element, acc).trim();
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

function isRawInteractiveJsonText(text, messageType) {
  if (messageType !== "interactive" || typeof text !== "string") return false;
  const parsed = parseJson(text.trim());
  return Boolean(parsed && typeof parsed === "object" && "json_card" in parsed);
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

function execFileJson(command, args, options) {
  const childProcess = optionalRequire("node:child_process") || optionalRequire("child_process");
  if (!childProcess || typeof childProcess.execFile !== "function") {
    return Promise.reject(new Error("execFile_unavailable"));
  }
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        env: { ...process.env, NO_COLOR: "1" },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
          return;
        }
        try {
          resolve(parseLarkCliJson(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

function parseLarkCliJson(stdout) {
  const raw = typeof stdout === "string" ? stdout.trim() : "";
  if (!raw) throw new Error("empty_lark_cli_stdout");
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("invalid_lark_cli_json");
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

function firstTrimmedString(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return "";
}

function messageTypeFromMessage(message) {
  return firstTrimmedString(message && message.msg_type, message && message.message_type, message && message.content_type);
}

function replyToIdFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  const reply = message.reply && typeof message.reply === "object" ? message.reply : null;
  return firstTrimmedString(
    message.reply_to,
    message.reply_to_id,
    message.parent_id,
    reply && reply.parentId,
    reply && reply.parent_id,
  );
}

function parseHistoryTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const raw = trimString(value);
  if (!raw) return Date.now();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return numeric > 1e12 ? numeric : numeric * 1000;
  }
  const shanghaiMatch = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (shanghaiMatch) {
    const parsed = Date.parse(`${shanghaiMatch[1]}T${shanghaiMatch[2]}:${shanghaiMatch[3] || "00"}+08:00`);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function buildHistoryEntryFromLarkCliMessage(message, currentMessageId) {
  if (!message || typeof message !== "object") return null;
  if (currentMessageId && message.message_id === currentMessageId) return null;
  const body = usableText(message.content);
  if (!body || hasUpgradeHint(body)) return null;
  const sender = message.sender && typeof message.sender === "object" ? message.sender : {};
  const senderId = trimString(sender.id) || "unknown";
  const senderLabel = formatSenderLabel(senderId, trimString(sender.name));
  return {
    sender: senderLabel,
    body,
    timestamp: parseHistoryTimestamp(message.create_time),
    messageId: message.message_id,
    messageType: messageTypeFromMessage(message),
    replyToId: replyToIdFromMessage(message),
  };
}

async function fetchHistoryEntriesViaLarkCli(params) {
  if (typeof params.testFetchLarkCliHistory === "function") {
    const messages = await params.testFetchLarkCliHistory({
      chatId: params.chatId,
      threadId: params.threadId,
      want: params.want,
    });
    return buildHistoryEntriesFromLarkCliMessages({
      messages,
      currentMessageId: params.currentMessageId,
      want: params.want,
    });
  }

  const isThread = Boolean(params.threadId);
  const cliArgs = isThread
    ? [
        "im",
        "+threads-messages-list",
        "--thread",
        params.threadId,
        "--page-size",
        String(params.want),
        "--sort",
        "desc",
        "--format",
        "json",
      ]
    : [
        "im",
        "+chat-messages-list",
        "--chat-id",
        params.chatId,
        "--page-size",
        String(params.want),
        "--sort",
        "desc",
        "--format",
        "json",
      ];
  const candidates = [
    trimString(process.env.CARHER_LARK_CLI_BIN),
    "lark-cli",
    "/usr/local/bin/lark-cli",
  ].filter(Boolean);
  const execJson = params.testExecFileJson || execFileJson;
  let lastError = null;
  for (const command of params.testExecFileJson ? ["lark-cli"] : [...new Set(candidates)]) {
    try {
      const payload = await execJson(command, cliArgs, {
        timeoutMs: 5000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const messages = payload && payload.data && payload.data.messages;
      return buildHistoryEntriesFromLarkCliMessages({
        messages,
        currentMessageId: params.currentMessageId,
        want: params.want,
      });
    } catch (err) {
      lastError = err;
    }
  }
  if (params.log) {
    params.log(`[carher-history-fill] lark-cli history failed: ${String(lastError)}`);
  }
  return [];
}

function buildHistoryEntriesFromLarkCliMessages(params) {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const entries = [];
  for (const message of messages.slice().reverse()) {
    const entry = buildHistoryEntryFromLarkCliMessage(message, params.currentMessageId);
    if (!entry) continue;
    entries.push(entry);
    if (entries.length >= params.want) break;
  }
  return entries;
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

  const localText = await extractMessageTextFromItem(m, dc, testHooks);
  const shouldTryCanonical =
    messageId &&
    messageType !== "interactive" &&
    (hasUpgradeHint(raw) || !localText || isWeakInteractiveText(localText, messageType));
  if (
    !shouldTryCanonical &&
    localText &&
    !isWeakInteractiveText(localText, messageType) &&
    !isRawInteractiveJsonText(localText, messageType)
  ) {
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
      if (
        canonicalText &&
        !isWeakInteractiveText(canonicalText, messageType) &&
        !isRawInteractiveJsonText(canonicalText, messageType)
      ) {
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
        if (
          text &&
          !isWeakInteractiveText(text, messageType) &&
          !isRawInteractiveJsonText(text, messageType)
        ) {
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

async function fetchCanonicalMessageItems(params) {
  const ids = [...new Set((params.messageIds || []).filter(Boolean))].slice(0, 50);
  const result = new Map();
  if (ids.length === 0) return result;
  if (typeof params.testFetchCanonicalMessages === "function") {
    try {
      const messages = await params.testFetchCanonicalMessages(ids);
      if (messages instanceof Map) return messages;
      if (Array.isArray(messages)) {
        for (const item of messages) {
          if (item && item.message_id) result.set(item.message_id, item);
        }
      }
      return result;
    } catch (err) {
      if (params.log) params.log(`[carher-history-fill] test canonical batch fetch failed: ${String(err)}`);
      return result;
    }
  }
  if (!params.token || typeof params.fetchImpl !== "function") return result;

  const query = new URLSearchParams();
  query.set("card_msg_content_type", "raw_card_content");
  for (const id of ids) query.append("message_ids", id);
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/mget?${query.toString()}`;
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
        params.log(`[carher-history-fill] canonical mget !ok count=${ids.length} status=${resp && resp.status}`);
      }
      return result;
    }
    const payload = await resp.json();
    const items = payload && payload.data && payload.data.items;
    if (!Array.isArray(items)) return result;
    for (const item of items) {
      if (item && item.message_id) result.set(item.message_id, item);
    }
    return result;
  } catch (err) {
    if (params.log) {
      params.log(`[carher-history-fill] canonical mget error count=${ids.length}: ${String(err)}`);
    }
    return result;
  }
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

  const currentMessageId = dc.ctx && dc.ctx.messageId;
  if (!args._testFetch || args._testFetchLarkCliHistory || args._testExecFileJson) {
    const cliStart = Date.now();
    const cliEntries = await fetchHistoryEntriesViaLarkCli({
      chatId,
      threadId: dc.isThread ? dc.ctx.threadId : undefined,
      currentMessageId,
      want,
      log: _log,
      testFetchLarkCliHistory: args._testFetchLarkCliHistory,
      testExecFileJson: args._testExecFileJson,
    });
    if (cliEntries.length > 0) {
      params.chatHistories.set(historyKey, cliEntries);
      _log(`[carher-history-fill] done ${chatId}: filled ${cliEntries.length} via lark-cli in ${Date.now() - cliStart}ms`);
      return;
    }
  }

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
    "&card_msg_content_type=raw_card_content" +
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
  const chronological = items.slice().reverse();
  const fillCandidates = chronological.filter((m) => {
    if (!m || typeof m !== "object") return false;
    return !(currentMessageId && m.message_id === currentMessageId);
  });
  const interactiveMessageIds = fillCandidates
    .filter((m) => (m.msg_type || m.message_type || m.content_type) === "interactive")
    .map((m) => m.message_id)
    .filter(Boolean);
  const canonicalInteractiveMessages = await fetchCanonicalMessageItems({
    messageIds: interactiveMessageIds,
    fetchImpl,
    token,
    log: _log,
    testFetchCanonicalMessages: args._testFetchCanonicalMessages,
  });
  const senderNames = await resolveHistorySenderNames({
    dc,
    items: chronological,
    nameMap: args._testNameMap,
    log: _log,
  });

  const entries = [];
  for (const m of fillCandidates) {
    if (!m || typeof m !== "object") continue;
    const senderId = senderIdFromMessage(m);
    const senderLabel = formatSenderLabel(senderId, senderNames.get(senderId));
    const contentItem = canonicalInteractiveMessages.get(m.message_id) || m;
    const text = await extractMessageText(contentItem, dc, {
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
      messageType: messageTypeFromMessage(m),
      replyToId: replyToIdFromMessage(m),
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
