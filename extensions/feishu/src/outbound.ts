import * as Lark from "@larksuiteoapi/node-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";

// Cache Lark clients per appId to avoid redundant token fetches.
const clientCache = new Map<string, Lark.Client>();

// Cache bot open_id per appId (fetched once via GET /bot/v3/info).
const botOpenIdCache = new Map<string, string>();

// Cache chat names per chatId (fetched once via GET /im/v1/chats/{chat_id}).
const chatNameCache = new Map<string, string>();

export function getFeishuClient(account: ResolvedFeishuAccount): Lark.Client {
  const key = account.appId;
  let client = clientCache.get(key);
  if (!client) {
    client = new Lark.Client({
      appId: account.appId,
      appSecret: account.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
    clientCache.set(key, client);
  }
  return client;
}

/** Fetch the bot's own open_id via GET /bot/v3/info/ (cached per appId).
 *  Uses direct HTTP because the SDK doesn't expose bot.v3 in its typed API.
 *  Needed for @mention detection in group chats. */
export async function getBotOpenId(account: ResolvedFeishuAccount): Promise<string | null> {
  const cached = botOpenIdCache.get(account.appId);
  if (cached) return cached;
  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const token = await (client as any).tokenManager.getTenantAccessToken({});
    if (!token) return null;

    const res = await fetch("https://open.feishu.cn/open-apis/bot/v3/info/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as {
      ok?: boolean;
      bot?: { open_id?: string };
    };
    const openId = json?.bot?.open_id;
    if (openId) {
      botOpenIdCache.set(account.appId, openId);
      return openId;
    }
  } catch {
    // Silently fail — caller handles null.
  }
  return null;
}

/** Fetch a Feishu chat's name via GET /im/v1/chats/{chat_id} (cached per chatId).
 *  Used for group archive index. */
export async function getFeishuChatName(
  account: ResolvedFeishuAccount,
  chatId: string,
): Promise<string | null> {
  const cached = chatNameCache.get(chatId);
  if (cached) return cached;
  try {
    const client = getFeishuClient(account);
    const resp = await client.im.chat.get({ path: { chat_id: chatId } });
    const name = (resp?.data?.name as string)?.trim();
    if (name) {
      chatNameCache.set(chatId, name);
      return name;
    }
  } catch {
    // Silently fail — caller handles null.
  }
  return null;
}

/**
 * Strip the optional `feishu:` routing prefix that routeReply may prepend,
 * then infer the Feishu receive_id_type from the ID prefix:
 *   oc_ -> chat_id, ou_ -> open_id, on_ -> union_id, else open_id.
 */
function resolveReceiveId(raw: string): {
  receiveId: string;
  receiveIdType: "chat_id" | "open_id" | "union_id";
} {
  const stripped = raw.replace(/^feishu:/i, "");
  if (stripped.startsWith("oc_")) return { receiveId: stripped, receiveIdType: "chat_id" };
  if (stripped.startsWith("ou_")) return { receiveId: stripped, receiveIdType: "open_id" };
  if (stripped.startsWith("on_")) return { receiveId: stripped, receiveIdType: "union_id" };
  // Default to open_id for unknown prefixes.
  return { receiveId: stripped, receiveIdType: "open_id" };
}

// ── Markdown -> Feishu Post conversion ──────────────────────────────────

/** A single element in a Feishu Post paragraph. */
type PostElement = {
  tag: string;
  text?: string;
  style?: string[];
  href?: string;
  language?: string;
};

/** Convert a Markdown string to Feishu Post content structure.
 *  Returns `{ zh_cn: { content: PostElement[][] } }` suitable for msg_type "post".
 *  Handles: bold, italic, inline code, code blocks, links, lists, headings, hr. */
export function markdownToPost(md: string): { zh_cn: { content: PostElement[][] } } {
  const lines = md.split("\n");
  const paragraphs: PostElement[][] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```lang ... ```
    if (line.trimStart().startsWith("```")) {
      const langMatch = line.trimStart().match(/^```(\w*)/);
      const language = langMatch?.[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      // Skip closing ```
      if (i < lines.length) i++;
      paragraphs.push([
        { tag: "code_block", language: language || "plain", text: codeLines.join("\n") },
      ]);
      continue;
    }

    // Blank line -> skip (paragraph separator).
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule: --- or *** or ___
    if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
      paragraphs.push([{ tag: "hr" }]);
      i++;
      continue;
    }

    // Heading: # Title -> bold text.
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const headingText = headingMatch[2];
      paragraphs.push(...parseInlineElements(headingText, true));
      i++;
      continue;
    }

    // Unordered list: - item or * item
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      const indent = Math.floor(ulMatch[1].length / 2);
      const prefix = "  ".repeat(indent) + "• ";
      paragraphs.push(...parseInlineElements(prefix + ulMatch[2]));
      i++;
      continue;
    }

    // Ordered list: 1. item
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      const indent = Math.floor(olMatch[1].length / 2);
      const prefix = "  ".repeat(indent) + olMatch[2] + ". ";
      paragraphs.push(...parseInlineElements(prefix + olMatch[3]));
      i++;
      continue;
    }

    // Regular text line.
    paragraphs.push(...parseInlineElements(line));
    i++;
  }

  return { zh_cn: { content: paragraphs } };
}

/** Parse a single line of Markdown text into Feishu Post inline elements.
 *  Supports: **bold**, *italic*, `inline code`, [text](url).
 *  If `forceBold` is true, the whole line is rendered bold (for headings). */
function parseInlineElements(text: string, forceBold = false): PostElement[][] {
  const elements: PostElement[] = [];

  // Regex to match inline Markdown tokens in order of precedence.
  // Bold+italic (***), bold (**), italic (*/_), inline code (`), link [text](url).
  const inlineRegex =
    /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`(.+?)`|\[([^\]]+)\]\(([^)]+)\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    // Text before this match.
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      if (before) {
        elements.push(
          forceBold ? { tag: "text", text: before, style: ["bold"] } : { tag: "text", text: before },
        );
      }
    }

    if (match[2]) {
      // ***bold+italic***
      elements.push({ tag: "text", text: match[2], style: ["bold", "italic"] });
    } else if (match[3]) {
      // **bold**
      elements.push({ tag: "text", text: match[3], style: ["bold"] });
    } else if (match[4]) {
      // *italic*
      elements.push({ tag: "text", text: match[4], style: ["italic"] });
    } else if (match[5]) {
      // _italic_
      elements.push({ tag: "text", text: match[5], style: ["italic"] });
    } else if (match[6]) {
      // `inline code` — use bold as visual distinction (Feishu has no inline code style).
      elements.push({ tag: "text", text: "`" + match[6] + "`", style: ["bold"] });
    } else if (match[7] && match[8]) {
      // [text](url)
      elements.push({ tag: "a", text: match[7], href: match[8] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match.
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining) {
      elements.push(
        forceBold
          ? { tag: "text", text: remaining, style: ["bold"] }
          : { tag: "text", text: remaining },
      );
    }
  }

  // If no matches at all, return the whole text as a single element.
  if (elements.length === 0) {
    elements.push(
      forceBold ? { tag: "text", text, style: ["bold"] } : { tag: "text", text },
    );
  }

  return [elements];
}

/** Detect whether text contains Markdown formatting worth converting. */
function hasMarkdown(text: string): boolean {
  // Check for common Markdown patterns.
  return /(\*\*.+?\*\*|\*[^*]+?\*|`.+?`|```|\[.+?\]\(.+?\)|^#{1,6}\s|^[-*+]\s|^\d+\.\s|^---)/m.test(
    text,
  );
}

/** Send a rich-text Post message to a Feishu chat or user.
 *  Converts Markdown to Feishu Post format for nice rendering.
 *  Falls back to plain text if the text has no Markdown formatting. */
export async function sendFeishuRichText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);

  if (hasMarkdown(params.text)) {
    const postContent = markdownToPost(params.text);
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify(postContent),
        msg_type: "post",
      },
    });
  } else {
    // No Markdown -> send as plain text (simpler, no unnecessary post wrapper).
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: params.text }),
        msg_type: "text",
      },
    });
  }
}

/** Send a plain text message to a Feishu chat or user (no Markdown conversion). */
export async function sendFeishuText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content: JSON.stringify({ text: params.text }),
      msg_type: "text",
    },
  });
}

/** Send a reply to a specific message (quote-reply).
 *  Supports Markdown → Post format for rich rendering. */
export async function sendFeishuReply(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  text: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  if (hasMarkdown(params.text)) {
    const postContent = markdownToPost(params.text);
    await client.im.message.reply({
      path: { message_id: params.messageId },
      data: {
        content: JSON.stringify(postContent),
        msg_type: "post",
      },
    });
  } else {
    await client.im.message.reply({
      path: { message_id: params.messageId },
      data: {
        content: JSON.stringify({ text: params.text }),
        msg_type: "text",
      },
    });
  }
}

/** Upload an image buffer to Feishu and return the image_key.
 *  Uses raw HTTP API because the SDK's `image_file` param name
 *  doesn't match the actual API field name `image`. */
export async function uploadFeishuImage(params: {
  account: ResolvedFeishuAccount;
  buffer: Buffer;
}): Promise<string> {
  const client = getFeishuClient(params.account);
  // Obtain tenant access token via the SDK's token manager.
  // oxlint-disable-next-line typescript/no-explicit-any
  const token = await (client as any).tokenManager.getTenantAccessToken({});
  if (!token) throw new Error("Feishu: failed to obtain tenant access token");

  const blob = new Blob([params.buffer]);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", blob, "image.jpg");

  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data?.image_key) {
    throw new Error(`Feishu image upload failed: code=${json.code} msg=${json.msg}`);
  }
  return json.data.image_key;
}

/** Download an image from a Feishu message using the message resource API.
 *  Requires `im:message` or `im:resource` permission.
 *  Returns the raw image buffer, or null if download fails. */
export async function downloadFeishuImage(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  imageKey: string;
}): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const client = getFeishuClient(params.account);
  const resp = await client.im.messageResource.get({
    params: { type: "image" },
    path: { message_id: params.messageId, file_key: params.imageKey },
  });
  if (!resp) return null;
  const stream = resp.getReadableStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const buffer = Buffer.concat(chunks);
  // Try to extract content-type from response headers.
  // oxlint-disable-next-line typescript/no-explicit-any
  const headers = resp.headers as any;
  const contentType =
    (typeof headers?.get === "function" ? headers.get("content-type") : headers?.["content-type"]) ??
    "image/jpeg";
  return { buffer, contentType: typeof contentType === "string" ? contentType : "image/jpeg" };
}

/** Send an image message to a Feishu chat or user. */
export async function sendFeishuImage(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  imageKey: string;
  caption?: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content: JSON.stringify({ image_key: params.imageKey }),
      msg_type: "image",
    },
  });
  // Send caption as a follow-up text message if provided.
  if (params.caption) {
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: params.caption }),
        msg_type: "text",
      },
    });
  }
}

// ── CardKit Streaming (typing / typewriter effect) ───────────────────────

const DEFAULT_STREAM_THROTTLE_MS = 300;
/** Stable element ID used inside every streaming card. */
const STREAM_ELEMENT_ID = "stream_content";

export type FeishuCardStream = {
  /** Push new accumulated text; throttled internally. */
  update: (text: string) => void;
  /** Flush any pending update immediately. */
  flush: () => Promise<void>;
  /** Stop the stream (no more updates will be sent). */
  stop: () => void;
  /** Send final complete text directly, bypassing throttle/inFlight guards.
   *  Call after stop() to ensure the card displays the full content. */
  sendFinal: (text: string) => Promise<void>;
  /** Close streaming mode and update chat-list preview summary.
   *  Pass the final text so summary.content is set to a snippet.
   *  Call before stop(). */
  finalize: (finalText: string) => Promise<void>;
  /** Whether the stream was successfully started (card created + message sent). */
  started: boolean;
  /** The message_id of the card message (for potential deletion later). */
  messageId?: string;
};

/**
 * Create a Feishu card, send it as a message, and return a stream object
 * that updates the card content with a typewriter effect.
 *
 * Flow:
 *  1. cardkit.card.create() → get card_id
 *  2. im.message.create(msg_type="interactive") → get message_id
 *  3. Caller calls stream.update(text) repeatedly
 *  4. Internally throttled calls to cardkit.cardElement.content() with sequence++
 *     → Feishu renders incremental text with native typewriter animation
 */
export async function createFeishuCardStream(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  throttleMs?: number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): Promise<FeishuCardStream> {
  const throttleMs = Math.max(50, params.throttleMs ?? DEFAULT_STREAM_THROTTLE_MS);
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);

  let cardId: string | undefined;
  let messageId: string | undefined;
  let sequence = 1;
  let lastSentText = "";
  let lastSentAt = 0;
  let pendingText = "";
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  // ── Step 1: Create card instance with a single markdown element ──
  const cardData = {
    schema: "2.0",
    body: {
      elements: [
        {
          tag: "markdown",
          content: "...",
          element_id: STREAM_ELEMENT_ID,
        },
      ],
    },
    // Enable streaming mode. Do NOT set custom summary.content — Feishu's
    // default "[生成中...]" is controlled by streaming_mode and clears
    // automatically when streaming_mode is set to false via card.settings().
    // A custom summary.content persists independently and causes stale previews.
    config: {
      streaming_mode: true,
    },
  };

  try {
    const createResp = await client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(cardData),
      },
    });
    cardId = createResp?.data?.card_id;
    if (!cardId) {
      params.warn?.("Feishu card stream: card.create returned no card_id");
      return { update: () => {}, flush: async () => {}, stop: () => {}, sendFinal: async () => {}, finalize: async (_t: string) => {}, started: false };
    }
  } catch (err) {
    params.warn?.(`Feishu card stream: card.create failed: ${String(err)}`);
    return { update: () => {}, flush: async () => {}, stop: () => {}, sendFinal: async () => {}, finalize: async (_t: string) => {}, started: false };
  }

  // ── Step 2: Send the card as a message ──
  try {
    const sendResp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
        msg_type: "interactive",
      },
    });
    messageId = sendResp?.data?.message_id;
    if (!messageId) {
      params.warn?.("Feishu card stream: message.create returned no message_id");
      return { update: () => {}, flush: async () => {}, stop: () => {}, sendFinal: async () => {}, finalize: async (_t: string) => {}, started: false };
    }
  } catch (err) {
    params.warn?.(`Feishu card stream: message.create failed: ${String(err)}`);
    return { update: () => {}, flush: async () => {}, stop: () => {}, sendFinal: async () => {}, finalize: async (_t: string) => {}, started: false };
  }

  params.log?.(
    `Feishu card stream ready (cardId=${cardId}, messageId=${messageId}, throttleMs=${throttleMs})`,
  );

  // ── Step 3: Stream updates via cardElement.content() ──
  const sendUpdate = async (text: string) => {
    if (stopped || !cardId) return;
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === lastSentText) return;
    lastSentText = trimmed;
    lastSentAt = Date.now();
    try {
      await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
        data: { content: trimmed, sequence: sequence++ },
      });
    } catch (err) {
      stopped = true;
      params.warn?.(`Feishu card stream update failed: ${String(err)}`);
    }
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight) {
      schedule();
      return;
    }
    const text = pendingText;
    if (!text.trim()) {
      pendingText = "";
      return;
    }
    pendingText = "";
    inFlight = true;
    try {
      await sendUpdate(text);
    } finally {
      inFlight = false;
    }
    if (pendingText) schedule();
  };

  const schedule = () => {
    if (timer) return;
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  };

  const update = (text: string) => {
    if (stopped) return;
    pendingText = text;
    if (inFlight) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void flush();
      return;
    }
    schedule();
  };

  const stop = () => {
    stopped = true;
    pendingText = "";
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // Send final complete text directly, bypassing throttle/inFlight guards.
  // Called after stop() to push the full content before finalize closes streaming.
  const sendFinal = async (text: string) => {
    if (!cardId) return;
    const trimmed = text.trimEnd();
    if (!trimmed) return;
    try {
      await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
        data: { content: trimmed, sequence: sequence++ },
      });
    } catch (err) {
      params.warn?.(`Feishu card stream sendFinal failed: ${String(err)}`);
    }
  };

  // Close streaming mode. No custom summary was set on creation, so Feishu's
  // default "[生成中...]" clears automatically when streaming_mode is turned off.
  // Ref: https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
  const finalize = async (_finalText: string) => {
    if (!cardId) return;
    try {
      await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({
            config: { streaming_mode: false },
          }),
          sequence: sequence++,
        },
      });
      params.log?.("card stream finalize: streaming_mode closed");
    } catch (err) {
      params.warn?.(`card stream finalize failed: ${String(err)}`);
    }
  };

  return { update, flush, stop, sendFinal, finalize, started: true, messageId };
}
