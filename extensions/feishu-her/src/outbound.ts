import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { buildFeishuSentMessageRef, type FeishuSentMessageRef } from "./message-metadata.js";

// Cache Lark clients per appId to avoid redundant token fetches.
const clientCache = new Map<string, Lark.Client>();

// Cache bot open_id per appId (fetched once via GET /bot/v3/info).
const botOpenIdCache = new Map<string, string>();

const FEISHU_ALLOWED_HOSTNAMES = ["open.feishu.cn"];

type FeishuSendResponse = {
  data?: {
    message_id?: string;
    chat_id?: string;
    msg_type?: string;
    parent_id?: string;
    root_id?: string;
    thread_id?: string;
    create_time?: string;
  };
};

function extractFeishuSentMessageRef(
  response: FeishuSendResponse | undefined,
  fallback: { chatId?: string; messageType: string },
): FeishuSentMessageRef | undefined {
  return buildFeishuSentMessageRef(response?.data ?? {}, fallback);
}

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

/** Fetch a Feishu chat's current name via GET /im/v1/chats/{chat_id}.
 *  Re-fetch on every call so inbound group metadata follows chat renames
 *  on the very next message after the rename. */
export async function getFeishuChatName(
  account: ResolvedFeishuAccount,
  chatId: string,
): Promise<string | null> {
  try {
    const client = getFeishuClient(account);
    const resp = await client.im.chat.get({ path: { chat_id: chatId } });
    const name = (resp?.data?.name as string)?.trim();
    if (name) {
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

const FEISHU_AT_TAG_RE = /<at\s+user_id="([^"]+)">([^<]*)<\/at>/gi;
const FEISHU_EMPTY_AT_TAG_RE = /<at\s+user_id="([^"]+)"\s*\/?>/gi;
const FEISHU_STRUCTURED_TAG_RE = /<\/?(?:file|media)\b[^>\n]*>/gi;

type FeishuCardMentionAccount = Pick<
  ResolvedFeishuAccount,
  "appId" | "botOpenId" | "knownBots" | "knownBotOpenIds"
>;

/** Resolve an <at user_id="..."> target into a Feishu card-compatible ID.
 *  Feishu cards reject cross-app bot open_ids (230099) and app_ids (230099).
 *  Only self-mention (own botOpenId) and human open_ids are safe. */
function resolveFeishuCardMentionTargetId(
  account: FeishuCardMentionAccount,
  userId: string,
): string | null {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return null;
  }
  if (!normalizedUserId.startsWith("cli_")) {
    return normalizedUserId;
  }
  if (normalizedUserId === account.appId) {
    const selfBotOpenId = account.botOpenId?.trim();
    return selfBotOpenId || null;
  }
  return null;
}

function formatFeishuCardMention(
  account: FeishuCardMentionAccount,
  userId: string,
  visibleText?: string,
): string {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return "";
  }
  const targetId = resolveFeishuCardMentionTargetId(account, normalizedUserId);
  if (targetId) {
    return `<at id=${targetId}></at>`;
  }
  if (normalizedUserId.startsWith("cli_")) {
    const displayName =
      visibleText?.trim() || account.knownBots[normalizedUserId]?.trim() || normalizedUserId;
    return `@${displayName.replace(/^@+/, "")}`;
  }
  return `<at id=${normalizedUserId}></at>`;
}

function renderFeishuCardMarkdownTextSegment(
  markdown: string,
  account: FeishuCardMentionAccount,
): string {
  const replacedAtTags = markdown
    .replace(FEISHU_AT_TAG_RE, (_match, userId: string, mentionText: string) =>
      formatFeishuCardMention(account, userId, mentionText),
    )
    .replace(FEISHU_EMPTY_AT_TAG_RE, (_match, userId: string) =>
      formatFeishuCardMention(account, userId),
    );
  return replacedAtTags.replace(FEISHU_STRUCTURED_TAG_RE, (tag) =>
    tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
}

/** Escape `<>` inside inline code spans so Feishu doesn't interpret
 *  literal `<at>` / `<file>` examples as real tags. */
function escapeAngleBracketsInInlineCode(line: string): string {
  return line.replace(/(`+)(.*?)\1/g, (_m, ticks: string, content: string) => {
    return ticks + content.replaceAll("<", "＜").replaceAll(">", "＞") + ticks;
  });
}

const MD_TABLE_SEPARATOR_RE = /^\|\s*[-:]+[-|\s:]*$/;

/** Detect whether a line is a markdown table row (`| ... | ... |`). */
function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|");
}

/** Parse a markdown table row into cell values (strips leading/trailing pipes). */
function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Strip inline code backticks from table cell content.
 *  Feishu JSON 1.0 doesn't support inline code — backticks in card markdown
 *  cause the renderer to break and swallow all subsequent content.
 *  Content inside backticks often contains XML/HTML-like tags (e.g. `<at>`,
 *  `<file>`) as code examples — strip tags to plain text to avoid both
 *  230099 mention errors and ugly fullwidth bracket display. */
function stripTableCellBackticks(cell: string): string {
  return cell
    .replace(/`([^`]*)`/g, (_m, content: string) => content.replace(/<[^>]*>/g, ""))
    .replaceAll("`", "");
}

/** Convert a markdown table into bold-header + bullet-list format.
 *  Feishu card `tag:"markdown"` can't render `| ... |` pipe tables (shown as
 *  raw text) or `<table>` tags (rendered as blank in bot cards).
 *  Using bold + bullets which are confirmed to render correctly.
 *  Also strips backticks from cells (unsupported → breaks rendering). */
function convertMarkdownTableToFeishuList(tableLines: string[]): string {
  if (tableLines.length < 2) return tableLines.join("\n");
  const headerCells = parseMarkdownTableRow(tableLines[0]);
  const dataStartIndex = MD_TABLE_SEPARATOR_RE.test(tableLines[1].trim()) ? 2 : 1;
  const sep = " | ";

  const headerLine = headerCells.map((h) => `**${stripTableCellBackticks(h)}**`).join(sep);
  const rows: string[] = [headerLine];
  for (let i = dataStartIndex; i < tableLines.length; i++) {
    const cells = parseMarkdownTableRow(tableLines[i]).map(stripTableCellBackticks);
    rows.push("- " + cells.join(sep));
  }
  return rows.join("\n");
}

/** Convert markdown heading (`# ...`) to bold text with level distinction.
 *  Feishu JSON 1.0 card `tag:"markdown"` does NOT support heading syntax.
 *  H1 → bold + divider (visually prominent), H2+ → bold only.
 *  See docs/her/feishu-card-markdown-official-spec.md */
function convertHeadingToBold(line: string): string {
  const m = line.match(/^(#{1,6})\s+(.*)/);
  if (!m) return line;
  const level = m[1].length;
  if (level === 1) return `**${m[2]}**\n---`;
  return `**${m[2]}**`;
}

/** Convert blockquote (`> ...`) to plain text (strip the `>` prefix).
 *  Feishu JSON 1.0 card `tag:"markdown"` does NOT support blockquote syntax.
 *  `>` alone would be swallowed or render as raw `>`. */
function convertBlockquote(line: string): string {
  const m = line.match(/^>\s?(.*)/);
  if (!m) return line;
  return `｜${m[1]}`;
}

/** Normalize markdown for the Feishu card `tag:"markdown"` component (JSON 1.0).
 *  Based on 100% confirmed official docs (feishu-card-markdown-official-spec.md):
 *
 *  Supported (passthrough): bold, italic, strikethrough, links, ordered/unordered
 *  lists, fenced code blocks (7.6+), images, dividers, @mentions, font color, tags.
 *
 *  NOT supported (must convert):
 *  - `# heading` → `**bold**`
 *  - `> blockquote` → `｜text` (fullwidth bar prefix)
 *  - `| table |` → bold-header + bullet-list
 *
 *  Also: escape `<>` inside code regions to prevent tag interpretation. */
function normalizeFeishuCardMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inFence = false;
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length > 0) {
      result.push(convertMarkdownTableToFeishuList(tableBuffer));
      tableBuffer = [];
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      flushTable();
      inFence = !inFence;
      result.push(line);
      continue;
    }
    if (inFence) {
      result.push(line.replaceAll("<", "＜").replaceAll(">", "＞"));
      continue;
    }
    if (
      isMarkdownTableRow(line) ||
      (tableBuffer.length > 0 && MD_TABLE_SEPARATOR_RE.test(line.trim()))
    ) {
      tableBuffer.push(line);
      continue;
    }
    flushTable();

    const trimmed = line.trimStart();
    if (/^#{1,6}\s+/.test(trimmed)) {
      result.push(convertHeadingToBold(line));
    } else if (/^>\s?/.test(trimmed)) {
      result.push(convertBlockquote(line));
    } else {
      result.push(escapeAngleBracketsInInlineCode(line));
    }
  }
  flushTable();
  return result.join("\n").trimEnd();
}

function escapeUnmatchedInlineBacktick(markdown: string): string {
  let inFence = false;
  let unmatchedInlineBacktickIndex = -1;
  for (let i = 0; i < markdown.length; i++) {
    if (markdown.startsWith("```", i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (inFence || markdown[i] !== "`" || markdown[i - 1] === "\\") {
      continue;
    }
    unmatchedInlineBacktickIndex = unmatchedInlineBacktickIndex === -1 ? i : -1;
  }
  if (unmatchedInlineBacktickIndex === -1) {
    return markdown;
  }
  return (
    markdown.slice(0, unmatchedInlineBacktickIndex) +
    "\\`" +
    markdown.slice(unmatchedInlineBacktickIndex + 1)
  );
}

function stabilizeFeishuCardMarkdown(markdown: string): string {
  let stabilized = escapeUnmatchedInlineBacktick(markdown);
  const fenceCount = stabilized.match(/```/g)?.length ?? 0;
  if (fenceCount % 2 === 1) {
    stabilized += "\n```";
  }
  return stabilized;
}

export function renderFeishuUserFacingCardText(
  text: string,
  account: FeishuCardMentionAccount,
): string {
  const displayText = formatFeishuUserFacingText(text).trimEnd();
  const stabilizedSource = stabilizeFeishuCardMarkdown(displayText);
  // Feishu v1 card markdown supports only a small subset. Normalize general
  // markdown into a deterministic, card-safe text form before rewriting live mentions.
  return renderFeishuCardMarkdownTextSegment(
    normalizeFeishuCardMarkdown(stabilizedSource),
    account,
  );
}

export async function sendFeishuUserFacingCardDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId?: string;
  text: string;
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  const displayText = renderFeishuUserFacingCardText(params.text, params.account);
  assertNoForbiddenOpenPlatformUrls(displayText);
  const stream = await createFeishuCardStream({
    account: params.account,
    chatId: params.chatId,
    replyToMessageId: params.replyToMessageId,
  });
  if (!stream.started || !stream.messageId) return undefined;
  await stream.sendFinal(displayText);
  await stream.finalize(displayText);
  stream.stop();
  return stream.message;
}

export async function sendFeishuUserFacingCard(params: {
  account: ResolvedFeishuAccount;
  chatId?: string;
  text: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  return (await sendFeishuUserFacingCardDetailed(params))?.messageId;
}

export async function sendFeishuRichTextDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  return sendFeishuUserFacingCardDetailed(params);
}

/** Send a rich-text Post message to a Feishu chat or user.
 *  User-facing text is now unified to interactive cards for deterministic display. */
export async function sendFeishuRichText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  return (await sendFeishuRichTextDetailed(params))?.messageId;
}

export async function sendFeishuTextDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  return sendFeishuUserFacingCardDetailed(params);
}

/** Send a user-facing text message using the unified interactive-card path. */
export async function sendFeishuText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  return (await sendFeishuTextDetailed(params))?.messageId;
}

export async function sendFeishuReplyDetailed(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  text: string;
}): Promise<FeishuSentMessageRef | undefined> {
  return sendFeishuUserFacingCardDetailed({
    account: params.account,
    text: params.text,
    replyToMessageId: params.messageId,
  });
}

/** Send a reply to a specific message using the unified interactive-card path. */
export async function sendFeishuReply(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  text: string;
}): Promise<string | undefined> {
  return (await sendFeishuReplyDetailed(params))?.messageId;
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

/** Download a docx inline image using its image token via the Drive media API.
 *  The token comes from docx block_type=27 `image.token`. */
export async function downloadDocxImage(params: {
  account: ResolvedFeishuAccount;
  imageToken: string;
}): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const client = getFeishuClient(params.account);
  // oxlint-disable-next-line typescript/no-explicit-any
  const token = await (client as any).tokenManager.getTenantAccessToken({});
  if (!token) return null;

  const url = `https://open.feishu.cn/open-apis/drive/v1/medias/${params.imageToken}/download`;
  const { response: res, release } = await fetchWithSsrFGuard({
    url,
    init: {
      headers: { Authorization: `Bearer ${token}` },
    },
    policy: { allowedHostnames: FEISHU_ALLOWED_HOSTNAMES },
    auditContext: "feishu-download-docx-image",
  });
  try {
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return null;
    return {
      buffer,
      contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
    };
  } finally {
    await release();
  }
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
async function sendFeishuBinaryMessageDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  content: string;
  messageType: "audio" | "media" | "file" | "image";
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  const client = getFeishuClient(params.account);
  // oxlint-disable-next-line typescript/no-explicit-any
  let resp: any;
  if (params.replyToMessageId) {
    resp = await client.im.message.reply({
      path: { message_id: params.replyToMessageId },
      data: { content: params.content, msg_type: params.messageType },
    });
  } else {
    const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
    resp = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: { receive_id: receiveId, content: params.content, msg_type: params.messageType },
    });
  }
  return extractFeishuSentMessageRef(resp as FeishuSendResponse, {
    chatId: params.chatId,
    messageType: params.messageType,
  });
}

export async function sendFeishuAudioDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  return sendFeishuBinaryMessageDetailed({
    account: params.account,
    chatId: params.chatId,
    content: JSON.stringify({ file_key: params.fileKey }),
    messageType: "audio",
    replyToMessageId: params.replyToMessageId,
  });
}

export async function sendFeishuAudio(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  return (await sendFeishuAudioDetailed(params))?.messageId;
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
  return (await sendFeishuVideoDetailed(params))?.messageId;
}

export async function sendFeishuVideoDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  return sendFeishuBinaryMessageDetailed({
    account: params.account,
    chatId: params.chatId,
    content: JSON.stringify({ file_key: params.fileKey }),
    messageType: "media",
    replyToMessageId: params.replyToMessageId,
  });
}

/** Send a file message to a Feishu chat or user.
 *  Uses `msg_type: "file"` with the `file_key` from `uploadFeishuFile`. */
export async function sendFeishuFile(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  return (await sendFeishuFileDetailed(params))?.messageId;
}

export async function sendFeishuFileDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  fileKey: string;
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  return sendFeishuBinaryMessageDetailed({
    account: params.account,
    chatId: params.chatId,
    content: JSON.stringify({ file_key: params.fileKey }),
    messageType: "file",
    replyToMessageId: params.replyToMessageId,
  });
}

/** Send an image message to a Feishu chat or user. */
export async function sendFeishuImage(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  imageKey: string;
  caption?: string;
  replyToMessageId?: string;
}): Promise<string | undefined> {
  return (await sendFeishuImageDetailed(params))?.messageId;
}

export async function sendFeishuImageDetailed(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  imageKey: string;
  caption?: string;
  replyToMessageId?: string;
}): Promise<FeishuSentMessageRef | undefined> {
  const message = await sendFeishuBinaryMessageDetailed({
    account: params.account,
    chatId: params.chatId,
    content: JSON.stringify({ image_key: params.imageKey }),
    messageType: "image",
    replyToMessageId: params.replyToMessageId,
  });
  if (params.caption) {
    await sendFeishuUserFacingCardDetailed({
      account: params.account,
      chatId: params.chatId,
      text: params.caption,
      replyToMessageId: params.replyToMessageId,
    });
  }
  return message;
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

// ── Interactive Card Streaming (tag:"markdown" + im.message.patch) ───────
// Uses v1 top-level `elements: [{tag:"markdown"}]` cards. Tested to produce:
//   ✓ native markdown rendering in UI (headings, tables, code fences, etc.)
//   ✓ PATCH support for streaming
//   ✓ `message.get` readback with `coverage: partial` (preserves markdown syntax)
// Schema 2.0 cards break readback entirely (`coverage: none`), so avoided.
// `div+lark_md` strips markdown formatting in readback, so also avoided.
// Updates via PATCH /im/v1/messages/{id} — 5 QPS rate limit, no total count limit.

const DEFAULT_STREAM_THROTTLE_MS = 300;
const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

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
  /** Close streaming mode (no-op for v1 patch cards — kept for interface compat). */
  finalize: (finalText: string) => Promise<void>;
  /** Whether the stream was successfully started (card created + message sent). */
  started: boolean;
  /** The message_id of the card message (for potential deletion later). */
  messageId?: string;
  /** Full message metadata returned by Feishu at create/reply time. */
  message?: FeishuSentMessageRef;
};

function buildInlineCardJson(markdown: string): string {
  return JSON.stringify({
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    elements: [{ tag: "markdown", content: markdown }],
  });
}

const NOOP_STREAM: FeishuCardStream = {
  update: () => {},
  flush: async () => {},
  stop: () => {},
  sendFinal: async () => {},
  finalize: async () => {},
  started: false,
};

/**
 * Send a v1 inline card and return a stream object that updates it via im.message.patch.
 *
 * Flow:
 *  1. im.message.create(msg_type="interactive", content=v1_inline_card_json) → message_id
 *  2. Caller calls stream.update(text) repeatedly
 *  3. Internally throttled PATCH /im/v1/messages/{id} replaces card content
 *  4. Readback still works through the interactive-card parser/archive path
 */
export async function createFeishuCardStream(params: {
  account: ResolvedFeishuAccount;
  chatId?: string;
  /** When set, the card message is sent as a reply to this message (quote-reply style). */
  replyToMessageId?: string;
  throttleMs?: number;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): Promise<FeishuCardStream> {
  const throttleMs = Math.max(50, params.throttleMs ?? DEFAULT_STREAM_THROTTLE_MS);
  const client = getFeishuClient(params.account);

  let message: FeishuSentMessageRef | undefined;
  let messageId: string | undefined;
  let lastSentText = "";
  let lastSentAt = 0;
  let pendingText = "";
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  // ── Step 1: Send initial v1 inline card ──
  const initialContent = buildInlineCardJson("⏳ ...");
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    let sendResp: any;
    if (params.replyToMessageId) {
      sendResp = await client.im.message.reply({
        path: { message_id: params.replyToMessageId },
        data: { content: initialContent, msg_type: "interactive" },
      });
    } else {
      if (!params.chatId) {
        params.warn?.("Feishu card stream: chatId is required when replyToMessageId is absent");
        return NOOP_STREAM;
      }
      const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
      sendResp = await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, content: initialContent, msg_type: "interactive" },
      });
    }
    message = extractFeishuSentMessageRef(sendResp as FeishuSendResponse, {
      chatId: params.chatId,
      messageType: "interactive",
    });
    messageId = message?.messageId;
    if (!messageId) {
      params.warn?.("Feishu card stream: message send returned no message_id");
      return NOOP_STREAM;
    }
  } catch (err) {
    params.warn?.(`Feishu card stream: message send failed: ${String(err)}`);
    return NOOP_STREAM;
  }

  // Re-fetch token on each PATCH call so long-running streams survive token rotation.
  // The SDK's tokenManager caches internally and only refreshes when expired.
  const getToken = async (): Promise<string | null> => {
    // oxlint-disable-next-line typescript/no-explicit-any
    return (client as any).tokenManager.getTenantAccessToken({});
  };

  const initialToken = await getToken();
  if (!initialToken) {
    params.warn?.("Feishu card stream: cannot obtain tenant_access_token for patch");
    return { ...NOOP_STREAM, started: true, messageId, message };
  }

  params.log?.(
    `Feishu card stream ready (v1-patch, messageId=${messageId}, throttleMs=${throttleMs})`,
  );

  // ── Step 2: Stream updates via PATCH /im/v1/messages/{id} ──
  const patchCard = async (
    content: string,
    token: string,
    _label: string,
  ): Promise<{ code: number; msg: string }> => {
    const res = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: buildInlineCardJson(content) }),
    });
    return (await res.json()) as { code: number; msg: string };
  };

  const sendUpdate = async (text: string) => {
    if (stopped || !messageId) return;
    const rendered = renderFeishuUserFacingCardText(text, params.account);
    if (!rendered || rendered === lastSentText) return;
    lastSentText = rendered;
    lastSentAt = Date.now();
    const token = await getToken();
    if (!token) {
      stopped = true;
      params.warn?.("Feishu card stream: token refresh failed, stopping stream");
      return;
    }
    try {
      const data = await patchCard(rendered, token, "patch");
      if (data.code !== 0) {
        if (data.code === 230020) {
          params.warn?.("Feishu card stream: rate limited (230020), will retry");
        } else {
          stopped = true;
          params.warn?.(`Feishu card stream patch failed: ${data.code} ${data.msg}`);
        }
      }
    } catch (err) {
      stopped = true;
      params.warn?.(`Feishu card stream patch error: ${String(err)}`);
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

  const sendFinal = async (text: string) => {
    if (!messageId) return;
    const rendered = renderFeishuUserFacingCardText(text, params.account);
    if (!rendered) return;
    const token = await getToken();
    if (!token) {
      params.warn?.("Feishu card stream sendFinal: token refresh failed");
      return;
    }
    try {
      const data = await patchCard(rendered, token, "sendFinal");
      if (data.code !== 0) {
        params.warn?.(`Feishu card stream sendFinal failed: ${data.code} ${data.msg}`);
      }
    } catch (err) {
      params.warn?.(`Feishu card stream sendFinal error: ${String(err)}`);
    }
  };

  // v1 inline cards have no streaming_mode to close — finalize is a no-op.
  const finalize = async (_finalText: string) => {
    params.log?.("card stream finalize: v1-patch complete (no streaming_mode to close)");
  };

  return { update, flush, stop, sendFinal, finalize, started: true, messageId, message };
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
