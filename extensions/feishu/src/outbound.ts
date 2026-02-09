import * as Lark from "@larksuiteoapi/node-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";

// Cache Lark clients per appId to avoid redundant token fetches.
const clientCache = new Map<string, Lark.Client>();

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

/** Send a reply to a specific message (quote-reply). */
export async function sendFeishuReply(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  text: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  await client.im.message.reply({
    path: { message_id: params.messageId },
    data: {
      content: JSON.stringify({ text: params.text }),
      msg_type: "text",
    },
  });
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
