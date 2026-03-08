import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";

// Cache Lark clients per appId to avoid redundant token fetches.
const clientCache = new Map<string, Lark.Client>();

// Cache bot open_id per appId (fetched once via GET /bot/v3/info).
const botOpenIdCache = new Map<string, string>();

// Cache chat names per chatId (fetched once via GET /im/v1/chats/{chat_id}).
const chatNameCache = new Map<string, string>();
const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn"];

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

    const { response: res, release } = await fetchWithSsrFGuard({
      url: "https://open.feishu.cn/open-apis/bot/v3/info/",
      init: {
        headers: { Authorization: `Bearer ${token}` },
      },
      policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
      auditContext: "feishu-get-bot-open-id",
    });
    const json = (await res.json().finally(release)) as {
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
  user_id?: string;
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
 *  Supports: **bold**, *italic*, `inline code`, [text](url), raw https:// URLs,
 *  <at user_id="xxx">name</at>.
 *  If `forceBold` is true, the whole line is rendered bold (for headings). */
function unwrapStyledMarkdownLinks(text: string): string {
  if (
    !text.includes("](") ||
    (!text.includes("**[") && !text.includes("*[") && !text.includes("_["))
  ) {
    return text;
  }

  const segments = text.split("`");
  for (let i = 0; i < segments.length; i += 2) {
    segments[i] = segments[i]
      .replace(/\*\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\*/g, "[$1]($2)")
      .replace(/\*\*\[([^\]]+)\]\(([^)]+)\)\*\*/g, "[$1]($2)")
      .replace(/\*\[([^\]]+)\]\(([^)]+)\)\*/g, "[$1]($2)")
      .replace(/_\[([^\]]+)\]\(([^)]+)\)_/g, "[$1]($2)");
  }
  return segments.join("`");
}

function parseInlineElements(text: string, forceBold = false): PostElement[][] {
  const normalizedText = unwrapStyledMarkdownLinks(text);
  const elements: PostElement[] = [];

  // Regex to match inline Markdown tokens in order of precedence.
  // Bold+italic (***), bold (**), italic (*/_), inline code (`), link [text](url),
  // raw URLs, Feishu @mention: <at user_id="xxx">name</at>
  const inlineRegex =
    /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|`(.+?)`|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>()]+)|<at\s+user_id="([^"]+)">([^<]*)<\/at>)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(normalizedText)) !== null) {
    // Text before this match.
    if (match.index > lastIndex) {
      const before = normalizedText.slice(lastIndex, match.index);
      if (before) {
        elements.push(
          forceBold
            ? { tag: "text", text: before, style: ["bold"] }
            : { tag: "text", text: before },
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
    } else if (match[9]) {
      // Raw URL — render as an explicit Feishu hyperlink so underscores in query
      // parameters stay intact instead of being parsed as Markdown italics.
      const rawUrl = match[9];
      const normalizedUrl = normalizeExtractedUrl(rawUrl);
      elements.push({ tag: "a", text: normalizedUrl, href: normalizedUrl });
      const trailing = rawUrl.slice(normalizedUrl.length);
      if (trailing) {
        elements.push(
          forceBold
            ? { tag: "text", text: trailing, style: ["bold"] }
            : { tag: "text", text: trailing },
        );
      }
    } else if (match[10]) {
      // <at user_id="xxx">name</at> → Feishu Post @mention element
      elements.push({ tag: "at", user_id: match[10] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last match.
  if (lastIndex < normalizedText.length) {
    const remaining = normalizedText.slice(lastIndex);
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
      forceBold
        ? { tag: "text", text: normalizedText, style: ["bold"] }
        : { tag: "text", text: normalizedText },
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

const OUTBOUND_URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const FEISHU_OAUTH_AUTHORIZE_URL_PREFIX =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize?";
const FEISHU_OAUTH_AUTHORIZE_URL_PATTERN =
  /https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize\?[^\s<>()]+/g;
const FEISHU_OAUTH_LINK_LABEL = "点击授权飞书";
const OPEN_FEISHU_HOST = "open.feishu.cn";
const OPEN_FEISHU_DOCS_PREFIX = "/document/";

function normalizeExtractedUrl(candidate: string): string {
  return candidate.replace(/[),.;!?]+$/g, "");
}

function replaceRawFeishuOAuthUrls(segment: string): string {
  return segment.replace(FEISHU_OAUTH_AUTHORIZE_URL_PATTERN, (rawUrl, offset, fullSegment) => {
    if (typeof offset === "number" && fullSegment.slice(Math.max(0, offset - 2), offset) === "](") {
      return rawUrl;
    }
    const normalizedUrl = normalizeExtractedUrl(rawUrl);
    const trailing = rawUrl.slice(normalizedUrl.length);
    return `[${FEISHU_OAUTH_LINK_LABEL}](${normalizedUrl})${trailing}`;
  });
}

export function formatFeishuUserFacingText(text: string): string {
  if (!text.includes(FEISHU_OAUTH_AUTHORIZE_URL_PREFIX)) {
    return text;
  }

  const lines = text.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      if (inFence || !line.includes(FEISHU_OAUTH_AUTHORIZE_URL_PREFIX)) {
        return line;
      }
      const inlineCodeSegments = line.split("`");
      for (let i = 0; i < inlineCodeSegments.length; i += 2) {
        inlineCodeSegments[i] = replaceRawFeishuOAuthUrls(inlineCodeSegments[i]);
      }
      return inlineCodeSegments.join("`");
    })
    .join("\n");
}

/**
 * Block open-platform URLs from user-facing messages unless they are official docs.
 *
 * Rule:
 * - allowed: https://open.feishu.cn/document/...
 * - forbidden: other https://open.feishu.cn/* links (open-apis/wiki/docx/drive/...)
 */
export function assertNoForbiddenOpenPlatformUrls(text: string): void {
  const matches = text.match(OUTBOUND_URL_PATTERN);
  if (!matches || matches.length === 0) {
    return;
  }
  for (const raw of matches) {
    const normalized = normalizeExtractedUrl(raw);
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      continue;
    }
    if (parsed.hostname.toLowerCase() !== OPEN_FEISHU_HOST) {
      continue;
    }
    const path = parsed.pathname.toLowerCase();
    if (path.startsWith(OPEN_FEISHU_DOCS_PREFIX)) {
      continue;
    }
    throw new Error(
      `禁止向用户发送 open.feishu.cn 非文档链接: ${normalized}。请改用用户可访问的 *.feishu.cn 分享链接，或仅发送 open.feishu.cn/document 官方文档链接。`,
    );
  }
}

/** Send a rich-text Post message to a Feishu chat or user.
 *  Converts Markdown to Feishu Post format for nice rendering.
 *  Falls back to plain text if the text has no Markdown formatting. */
export async function sendFeishuRichText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
}): Promise<string | undefined> {
  const displayText = formatFeishuUserFacingText(params.text);
  assertNoForbiddenOpenPlatformUrls(displayText);
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);

  // oxlint-disable-next-line typescript/no-explicit-any
  let resp: any;
  if (hasMarkdown(displayText)) {
    const postContent = markdownToPost(displayText);
    resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify(postContent),
        msg_type: "post",
      },
    });
  } else {
    resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: displayText }),
        msg_type: "text",
      },
    });
  }
  return resp?.data?.message_id;
}

/** Send a plain text message to a Feishu chat or user (no Markdown conversion). */
export async function sendFeishuText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
}): Promise<string | undefined> {
  assertNoForbiddenOpenPlatformUrls(params.text);
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
  // oxlint-disable-next-line typescript/no-explicit-any
  const resp: any = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content: JSON.stringify({ text: params.text }),
      msg_type: "text",
    },
  });
  return resp?.data?.message_id;
}

/** Send a reply to a specific message (quote-reply).
 *  Supports Markdown → Post format for rich rendering. */
export async function sendFeishuReply(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  text: string;
}): Promise<string | undefined> {
  const displayText = formatFeishuUserFacingText(params.text);
  assertNoForbiddenOpenPlatformUrls(displayText);
  const client = getFeishuClient(params.account);
  // oxlint-disable-next-line typescript/no-explicit-any
  let resp: any;
  if (hasMarkdown(displayText)) {
    const postContent = markdownToPost(displayText);
    resp = await client.im.message.reply({
      path: { message_id: params.messageId },
      data: {
        content: JSON.stringify(postContent),
        msg_type: "post",
      },
    });
  } else {
    resp = await client.im.message.reply({
      path: { message_id: params.messageId },
      data: {
        content: JSON.stringify({ text: displayText }),
        msg_type: "text",
      },
    });
  }
  return resp?.data?.message_id;
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

  const blob = new Blob([new Uint8Array(params.buffer)]);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", blob, "image.jpg");

  const { response: res, release } = await fetchWithSsrFGuard({
    url: "https://open.feishu.cn/open-apis/im/v1/images",
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
    policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
    auditContext: "feishu-upload-image",
  });
  const json = await res.json().finally(release);
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
    (typeof headers?.get === "function"
      ? headers.get("content-type")
      : headers?.["content-type"]) ?? "image/jpeg";
  return { buffer, contentType: typeof contentType === "string" ? contentType : "image/jpeg" };
}

/** Download a file attachment from a Feishu message using the message resource API.
 *  Same endpoint as downloadFeishuImage but with type="file".
 *  Handles PPT, PDF, DOCX, images-as-files, and any other file attachments.
 *  Requires `im:message` or `im:resource` permission. ≤100 MB per Feishu docs. */
export async function downloadFeishuFile(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  fileKey: string;
}): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const client = getFeishuClient(params.account);
  const resp = await client.im.messageResource.get({
    params: { type: "file" },
    path: { message_id: params.messageId, file_key: params.fileKey },
  });
  if (!resp) return null;
  const stream = resp.getReadableStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const buffer = Buffer.concat(chunks);
  // oxlint-disable-next-line typescript/no-explicit-any
  const headers = resp.headers as any;
  const contentType =
    (typeof headers?.get === "function"
      ? headers.get("content-type")
      : headers?.["content-type"]) ?? "application/octet-stream";
  return {
    buffer,
    contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
  };
}

/** Convert non-Opus audio (e.g. MP3 from TTS) to OGG/Opus via ffmpeg.
 *  Returns the original buffer if already Opus or if ffmpeg is unavailable. */
function convertToOpus(buffer: Buffer): Buffer {
  // Check for OGG/Opus magic bytes (OggS header) — skip conversion if already Opus.
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return buffer;
  }
  const dir = mkdtempSync(join(resolvePreferredOpenClawTmpDir(), "feishu-audio-"));
  const inFile = join(dir, "input.mp3");
  const outFile = join(dir, "output.ogg");
  try {
    writeFileSync(inFile, buffer);
    execSync(`ffmpeg -y -i "${inFile}" -c:a libopus -b:a 32k -ac 1 -ar 16000 "${outFile}"`, {
      timeout: 15000,
      stdio: "pipe",
    });
    return readFileSync(outFile) as Buffer;
  } catch {
    // ffmpeg not available or conversion failed: upload as-is.
    return buffer;
  } finally {
    try {
      unlinkSync(inFile);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(outFile);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(dir);
    } catch {
      /* ignore: rmdir fails if not empty, ok */
    }
  }
}

/** Upload an audio buffer to Feishu and return the file_key for sending.
 *  Uses `client.im.file.create` with `file_type: "opus"`.
 *  Non-Opus audio (e.g. MP3 from TTS) is auto-converted via ffmpeg.
 *  Feishu requires a `duration` param (ms); estimated from buffer if not given. */
export async function uploadFeishuAudio(params: {
  account: ResolvedFeishuAccount;
  buffer: Buffer;
  fileName?: string;
  duration?: number;
}): Promise<string> {
  const client = getFeishuClient(params.account);
  const opusBuffer = convertToOpus(params.buffer);
  const fileName = params.fileName ?? `voice-${Date.now()}.ogg`;
  // Estimate duration from opus bitrate (~32kbps) if not provided.
  const duration = params.duration ?? Math.max(1000, Math.round((opusBuffer.length * 8) / 32));

  // oxlint-disable-next-line typescript/no-explicit-any
  const response = (await client.im.file.create({
    data: {
      file_type: "opus",
      file_name: fileName,
      file: opusBuffer as never,
      duration,
    },
  })) as any;

  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu audio upload failed: ${response.msg || `code ${response.code}`}`);
  }
  const fileKey = response.file_key ?? response.data?.file_key;
  if (!fileKey) {
    throw new Error("Feishu audio upload failed: no file_key returned");
  }
  return fileKey;
}

/** Send an audio message to a Feishu chat or user.
 *  Uses `msg_type: "audio"` with the `file_key` from `uploadFeishuAudio`. */
export async function sendFeishuAudio(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  const client = getFeishuClient(params.account);
  const content = JSON.stringify({ file_key: params.fileKey });

  // oxlint-disable-next-line typescript/no-explicit-any
  let resp: any;
  if (params.replyToMessageId) {
    resp = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: { content, msg_type: "audio" },
    });
  } else {
    const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
    resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, content, msg_type: "audio" },
    });
  }
  return resp?.data?.message_id;
}

// ── File upload/send (PPT, PDF, DOCX, etc.) ─────────────────────────────

/** Map common file extensions to Feishu's `file_type` parameter.
 *  Feishu IM file upload accepts: mp4, pdf, doc, xls, ppt, stream (generic). */
function mapFileType(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (e === "mp4" || e === "mov") return "mp4";
  if (e === "pdf") return "pdf";
  if (e === "doc" || e === "docx") return "doc";
  if (e === "xls" || e === "xlsx") return "xls";
  if (e === "ppt" || e === "pptx") return "ppt";
  return "stream";
}

const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024; // 30MB — Feishu IM file upload limit

/** Upload a file buffer to Feishu IM and return the file_key.
 *  Uses `client.im.file.create`; max 30MB per Feishu docs. */
export async function uploadFeishuFile(params: {
  account: ResolvedFeishuAccount;
  buffer: Buffer;
  fileName: string;
}): Promise<string> {
  // Pre-check: Feishu IM file upload hard limit is 30MB.
  const sizeMb = (params.buffer.length / (1024 * 1024)).toFixed(1);
  if (params.buffer.length > FEISHU_FILE_MAX_BYTES) {
    throw new Error(
      `文件太大无法发送到飞书：${params.fileName} (${sizeMb}MB)，飞书限制最大 30MB。请压缩文件或发送较小的版本。`,
    );
  }

  const client = getFeishuClient(params.account);
  const ext = params.fileName.split(".").pop() ?? "";
  const fileType = mapFileType(ext);

  // oxlint-disable-next-line typescript/no-explicit-any
  let response: any;
  try {
    response = (await client.im.file.create({
      data: {
        file_type: fileType as never,
        file_name: params.fileName,
        file: params.buffer as never,
      },
    })) as any;
  } catch (err: unknown) {
    // Extract Feishu error details from Axios response for actionable error messages.
    const axiosErr = err as { response?: { status?: number; data?: unknown } };
    const status = axiosErr.response?.status;
    const data = axiosErr.response?.data;
    if (status === 400) {
      throw new Error(
        `飞书文件上传失败 (400)：${params.fileName} (${sizeMb}MB)。${data ? JSON.stringify(data) : "请检查文件格式和大小（限制 30MB）。"}`,
      );
    }
    throw err;
  }

  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`Feishu file upload failed: ${response.msg || `code ${response.code}`}`);
  }
  const fileKey = response.file_key ?? response.data?.file_key;
  if (!fileKey) {
    throw new Error("Feishu file upload failed: no file_key returned");
  }
  return fileKey;
}

/** Send a video/media message to a Feishu chat or user.
 *  Uses `msg_type: "media"` — required for video files (mp4/mov).
 *  Sending video with `msg_type: "file"` triggers Feishu error 230055. */
export async function sendFeishuVideo(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  const client = getFeishuClient(params.account);
  const content = JSON.stringify({ file_key: params.fileKey });

  // oxlint-disable-next-line typescript/no-explicit-any
  let resp: any;
  if (params.replyToMessageId) {
    resp = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: { content, msg_type: "media" },
    });
  } else {
    const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
    resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, content, msg_type: "media" },
    });
  }
  return resp?.data?.message_id;
}

/** Send a file message to a Feishu chat or user.
 *  Uses `msg_type: "file"` with the `file_key` from `uploadFeishuFile`. */
export async function sendFeishuFile(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  const client = getFeishuClient(params.account);
  const content = JSON.stringify({ file_key: params.fileKey });

  // oxlint-disable-next-line typescript/no-explicit-any
  let resp: any;
  if (params.replyToMessageId) {
    resp = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: { content, msg_type: "file" },
    });
  } else {
    const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
    resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, content, msg_type: "file" },
    });
  }
  return resp?.data?.message_id;
}

/** Send an image message to a Feishu chat or user. */
export async function sendFeishuImage(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  imageKey: string;
  caption?: string;
}): Promise<string | undefined> {
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
  // oxlint-disable-next-line typescript/no-explicit-any
  const resp: any = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content: JSON.stringify({ image_key: params.imageKey }),
      msg_type: "image",
    },
  });
  if (params.caption) {
    assertNoForbiddenOpenPlatformUrls(params.caption);
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: params.caption }),
        msg_type: "text",
      },
    });
  }
  return resp?.data?.message_id;
}

// ── Board / Whiteboard API (raw HTTP — SDK has no board namespace) ───────

/** Download a Feishu whiteboard/canvas as a PNG image.
 *  Uses Board API: GET /open-apis/board/v1/whiteboards/{token}/download_as_image
 *  Requires `board:whiteboard` scope. Returns raw PNG buffer or null on failure. */
export async function downloadWhiteboardImage(params: {
  account: ResolvedFeishuAccount;
  whiteboardToken: string;
}): Promise<{ buffer: Buffer; contentType: string } | null> {
  const client = getFeishuClient(params.account);
  // oxlint-disable-next-line typescript/no-explicit-any
  const token = await (client as any).tokenManager.getTenantAccessToken({});
  if (!token) return null;

  const url = `https://open.feishu.cn/open-apis/board/v1/whiteboards/${params.whiteboardToken}/download_as_image`;
  const { response: res, release } = await fetchWithSsrFGuard({
    url,
    init: {
      headers: { Authorization: `Bearer ${token}` },
    },
    policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
    auditContext: "feishu-download-whiteboard-image",
  });
  try {
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "image/png";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return null;
    return { buffer, contentType };
  } finally {
    await release();
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
  /** When set, the card message is sent as a reply to this message (quote-reply style). */
  replyToMessageId?: string;
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
      return {
        update: () => {},
        flush: async () => {},
        stop: () => {},
        sendFinal: async () => {},
        finalize: async (_t: string) => {},
        started: false,
      };
    }
  } catch (err) {
    params.warn?.(`Feishu card stream: card.create failed: ${String(err)}`);
    return {
      update: () => {},
      flush: async () => {},
      stop: () => {},
      sendFinal: async () => {},
      finalize: async (_t: string) => {},
      started: false,
    };
  }

  // ── Step 2: Send the card as a message (reply style when replyToMessageId is set) ──
  const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    let sendResp: any;
    if (params.replyToMessageId) {
      // Quote-reply: card appears as a reply to the user's message.
      sendResp = await client.im.message.reply({
        path: { message_id: params.replyToMessageId },
        data: { content: cardContent, msg_type: "interactive" },
      });
    } else {
      sendResp = await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, content: cardContent, msg_type: "interactive" },
      });
    }
    messageId = sendResp?.data?.message_id;
    if (!messageId) {
      params.warn?.("Feishu card stream: message send returned no message_id");
      return {
        update: () => {},
        flush: async () => {},
        stop: () => {},
        sendFinal: async () => {},
        finalize: async (_t: string) => {},
        started: false,
      };
    }
  } catch (err) {
    params.warn?.(`Feishu card stream: message send failed: ${String(err)}`);
    return {
      update: () => {},
      flush: async () => {},
      stop: () => {},
      sendFinal: async () => {},
      finalize: async (_t: string) => {},
      started: false,
    };
  }

  params.log?.(
    `Feishu card stream ready (cardId=${cardId}, messageId=${messageId}, throttleMs=${throttleMs})`,
  );

  // ── Step 3: Stream updates via cardElement.content() ──
  const sendUpdate = async (text: string) => {
    if (stopped || !cardId) return;
    const rendered = formatFeishuUserFacingText(text.trimEnd());
    if (!rendered || rendered === lastSentText) return;
    lastSentText = rendered;
    lastSentAt = Date.now();
    try {
      await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
        data: { content: rendered, sequence: sequence++ },
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
    const rendered = formatFeishuUserFacingText(text.trimEnd());
    if (!rendered) return;
    try {
      await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
        data: { content: rendered, sequence: sequence++ },
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

// ── Emoji Reactions ─────────────────────────────────────────────────────

/** Add an emoji reaction to a Feishu message.
 *  Uses POST /open-apis/im/v1/messages/{message_id}/reactions
 *  Requires `im:message.reaction:create` scope (or equivalent).
 *  Returns the reaction_id (used for removal), or null on failure. */
export async function addFeishuReaction(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  emoji: string;
}): Promise<string | null> {
  const client = getFeishuClient(params.account);
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.im.messageReaction.create({
    path: { message_id: params.messageId },
    data: { reaction_type: { emoji_type: params.emoji } },
  });
  if (res?.code !== 0) return null;
  return res?.data?.reaction_id ?? null;
}

/** Remove an emoji reaction from a Feishu message by reaction_id.
 *  Uses DELETE /open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}
 *  Requires `im:message.reaction:create` scope (or equivalent). */
export async function removeFeishuReaction(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  reactionId: string;
}): Promise<boolean> {
  const client = getFeishuClient(params.account);
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.im.messageReaction.delete({
    path: {
      message_id: params.messageId,
      reaction_id: params.reactionId,
    },
  });
  return res?.code === 0;
}

// ── Message Recall (Delete) ─────────────────────────────────────────────

/** Recall (delete) a Feishu message by message_id.
 *  Bot can recall its own messages within 24h, or group-owner can recall
 *  any member's messages within 1 year.
 *  Uses DELETE /open-apis/im/v1/messages/{message_id}. */
export async function deleteFeishuMessage(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
}): Promise<{ ok: boolean; code?: number; msg?: string }> {
  const client = getFeishuClient(params.account);
  // oxlint-disable-next-line typescript/no-explicit-any
  const resp: any = await client.im.message.delete({
    path: { message_id: params.messageId },
  });
  return { ok: resp?.code === 0, code: resp?.code, msg: resp?.msg };
}
