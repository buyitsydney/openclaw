/**
 * Feishu Gateway: WebSocket long connection for receiving messages.
 *
 * Uses @larksuiteoapi/node-sdk WSClient to establish a persistent connection
 * to Feishu servers. Received messages are forwarded to OpenClaw's auto-reply pipeline.
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  ChannelAccountSnapshot,
  ChannelLogSink,
  OpenClawConfig,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { resolveGroupOwnerIds } from "./accounts.js";
import { archiveGroupMessage, archiveSentFeishuBinaryMessage } from "./group-archive.js";
import { rewriteModelShortcutCommand } from "./model-shortcuts.js";
import {
  getFeishuClient,
  sendFeishuText,
  sendFeishuRichText,
  sendFeishuReply,
  createFeishuCardStream,
  formatFeishuUserFacingText,
  uploadFeishuImage,
  sendFeishuImage,
  uploadFeishuAudio,
  sendFeishuAudio,
  uploadFeishuFile,
  sendFeishuFile,
  sendFeishuVideo,
  downloadFeishuImage,
  downloadFeishuFile,
  getBotOpenId,
  getFeishuChatName,
  addFeishuReaction,
  removeFeishuReaction,
  type FeishuCardStream,
} from "./outbound.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  accumulateGroupedReplyText,
  buildFeishuStatusFooter,
  finalizeGroupedReplyText,
} from "./status-footer.js";

// ── Content-type inference for local files ────────────────────────────────
/** Infer MIME content-type from a file path extension. */
function inferContentType(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

// ── Anthropic Max quota probe ────────────────────────────────────────────
// Send a minimal API request using the OAuth token and extract rate limit
// headers that Anthropic returns on every response.

function formatResetTime(unixStr: string | null): string {
  if (!unixStr) return "未知";
  const d = new Date(parseInt(unixStr) * 1000);
  const now = Date.now();
  const diffMin = Math.round((d.getTime() - now) / 60000);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const time = `${hh}:${mm}`;
  if (diffMin <= 0) return `${md} ${time}（已过）`;
  if (diffMin < 60) return `${time}（${diffMin}分钟后）`;
  const diffH = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffH < 24) return `${time}（${diffH}h${remMin > 0 ? `${remMin}m` : ""}后）`;
  const diffDays = Math.floor(diffH / 24);
  const remH = diffH % 24;
  return `${md} ${time}（${diffDays}天${remH > 0 ? `${remH}h` : ""}后）`;
}

async function checkAnthropicQuota(): Promise<string | null> {
  const token = process.env.ANTHROPIC_OAUTH_TOKEN;
  if (!token) return null;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    }),
  });

  const util5h = res.headers.get("anthropic-ratelimit-unified-5h-utilization");
  const util7d = res.headers.get("anthropic-ratelimit-unified-7d-utilization");

  if (!util5h && !util7d) {
    if (!res.ok) {
      const body = await res.text();
      return `❌ API 请求失败 (${res.status})\n\n${body.slice(0, 200)}`;
    }
    return "⚠️ 响应中无用量信息\n\n可能不是 Claude Max 订阅的 OAuth token。";
  }

  const reset5h = res.headers.get("anthropic-ratelimit-unified-5h-reset");
  const reset7d = res.headers.get("anthropic-ratelimit-unified-7d-reset");
  const util7dSonnet = res.headers.get("anthropic-ratelimit-unified-7d_sonnet-utilization");
  const fallbackRaw = res.headers.get("anthropic-ratelimit-unified-fallback-percentage");
  const claim = res.headers.get("anthropic-ratelimit-unified-representative-claim");

  const pct5h = util5h ? Math.round(parseFloat(util5h) * 100) : null;
  const pct7d = util7d ? Math.round(parseFloat(util7d) * 100) : null;
  const pct7dS = util7dSonnet ? Math.round(parseFloat(util7dSonnet) * 100) : null;
  const fallback = fallbackRaw ? Math.round(parseFloat(fallbackRaw) * 100) : 50;

  const icon5h = pct5h === null ? "❓" : pct5h >= 90 ? "🚫" : pct5h >= fallback ? "⚠️" : "✅";
  const icon7d = pct7d === null ? "❓" : pct7d >= 90 ? "🚫" : pct7d >= fallback ? "⚠️" : "✅";

  const maxPct = Math.max(pct5h ?? 0, pct7d ?? 0);
  const safety =
    maxPct >= 90
      ? "🚫 **危险** — 即将或已经限流"
      : maxPct >= fallback
        ? "⚠️ **注意** — 已进入降级区"
        : maxPct >= 30
          ? "📊 正常 — 用量适中"
          : "✅ **充裕** — 用量很低";

  const claimLabel = claim === "five_hour" ? "5h 窗口" : claim === "seven_day" ? "7d 窗口" : claim;

  const lines = [
    "📊 **Claude Max 用量**",
    "",
    `**5h 窗口** ${icon5h}  已用 ${pct5h ?? "?"}%`,
    `重置：${formatResetTime(reset5h)}`,
    "",
    `**7d 窗口** ${icon7d}  已用 ${pct7d ?? "?"}%`,
    pct7dS !== null ? `Sonnet 专属 7d：${pct7dS}%` : null,
    `重置：${formatResetTime(reset7d)}`,
    "",
    `降级阈值：${fallback}% · 主要约束：${claimLabel ?? "未知"}`,
    "",
    `**安全评估**：${safety}`,
  ];

  return lines.filter((l): l is string => l !== null).join("\n");
}

// ── Permission error extraction ─────────────────────────────────────────
// Detect Feishu API permission errors (code 99991672) and extract the grant URL
// so the agent can report actionable guidance instead of an opaque error.

type PermissionError = { code: number; message: string; grantUrl?: string };

export function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== "object") return null;
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;
  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };
  if (feishuErr.code !== 99991672) return null;
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return { code: feishuErr.code, message: msg, grantUrl: urlMatch?.[0] };
}

// Cache permission-error notifications to avoid spamming on every API call.
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000;

// ── Sender name resolution (contact/v3/users) ──────────────────────────
// Resolve open_id -> display name so the agent sees "张三" not "ou_xxx".
// TTL-cached per open_id to minimise API calls.

const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

type SenderNameResult = { name?: string; permissionError?: PermissionError };

async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderOpenId: string;
  log?: ChannelLogSink;
}): Promise<SenderNameResult> {
  const { account, senderOpenId, log } = params;
  if (!senderOpenId) return {};
  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };
  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });
    const user = res?.data?.user;
    const name: string | undefined =
      user?.name || user?.display_name || user?.nickname || user?.en_name;
    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }
    // API succeeded but returned no usable name — log for diagnostics
    log?.info(
      `[${account.accountId}] sender name lookup returned no name for ${senderOpenId}` +
        ` (code=${res?.code}, hasUser=${!!user}, keys=${user ? Object.keys(user).join(",") : "n/a"})`,
    );
    return {};
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      log?.info(
        `[${account.accountId}] permission error resolving sender name: code=${permErr.code}`,
      );
      return { permissionError: permErr };
    }
    log?.info(
      `[${account.accountId}] failed to resolve sender name for ${senderOpenId}: ${String(err)}`,
    );
    return {};
  }
}

// ── Card text cache (persistent) ────────────────────────────────────────
// CardKit streaming cards: im.message.get returns degraded body (image placeholder)
// instead of the actual markdown text. We cache messageId -> finalText when the
// stream completes so quoted-message lookups return the real content.
// The cache is persisted to disk so it survives gateway restarts.

const cardTextCache = new Map<string, { text: string; ts: number }>();
const CARD_CACHE_MAX = 500;
const CARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CARD_CACHE_FILE = join(homedir(), ".openclaw", "feishu-card-text-cache.json");

let cardCacheDiskLoaded = false;

function loadCardCacheFromDisk(): void {
  if (cardCacheDiskLoaded) return;
  cardCacheDiskLoaded = true;
  try {
    if (!existsSync(CARD_CACHE_FILE)) return;
    const raw = readFileSync(CARD_CACHE_FILE, "utf-8");
    const entries: Array<[string, { text: string; ts: number }]> = JSON.parse(raw);
    const now = Date.now();
    for (const [k, v] of entries) {
      if (now - v.ts < CARD_CACHE_TTL_MS) {
        cardTextCache.set(k, v);
      }
    }
  } catch {
    // Corrupt or missing file — start fresh.
  }
}

let cardCacheFlushTimer: ReturnType<typeof setTimeout> | undefined;

function flushCardCacheToDisk(): void {
  try {
    const now = Date.now();
    // Purge expired entries before writing to keep the file lean.
    for (const [k, v] of cardTextCache) {
      if (now - v.ts > CARD_CACHE_TTL_MS) {
        cardTextCache.delete(k);
      }
    }
    const dir = dirname(CARD_CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entries = [...cardTextCache.entries()];
    writeFileSync(CARD_CACHE_FILE, JSON.stringify(entries), "utf-8");
  } catch {
    // Best-effort persistence.
  }
}

function scheduleCardCacheFlush(): void {
  if (cardCacheFlushTimer) return;
  cardCacheFlushTimer = setTimeout(() => {
    cardCacheFlushTimer = undefined;
    flushCardCacheToDisk();
  }, 2000);
}

function cacheCardText(messageId: string, text: string): void {
  loadCardCacheFromDisk();
  const renderedText = formatFeishuUserFacingText(text);
  if (cardTextCache.size >= CARD_CACHE_MAX) {
    const now = Date.now();
    // First pass: evict expired entries.
    for (const [k, v] of cardTextCache) {
      if (now - v.ts > CARD_CACHE_TTL_MS) {
        cardTextCache.delete(k);
      }
    }
    // Second pass: if still over limit, drop oldest entries.
    if (cardTextCache.size >= CARD_CACHE_MAX) {
      const sorted = [...cardTextCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      const toDrop = sorted.slice(0, sorted.length - CARD_CACHE_MAX + 1);
      for (const [k] of toDrop) {
        cardTextCache.delete(k);
      }
    }
  }
  cardTextCache.set(messageId, { text: renderedText, ts: Date.now() });
  scheduleCardCacheFlush();
}

// ── Sent message log (persistent) ────────────────────────────────────────
// Track message IDs of bot-sent messages per chat so AI tools can recall them.
// Same persistence pattern as cardTextCache: Map + debounce flush + load on start.

type SentMessageEntry = { messageId: string; sentAt: number; preview?: string };
const sentMessageLog = new Map<string, SentMessageEntry[]>();
const SENT_MSG_MAX = 200;
const SENT_MSG_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches Feishu's bot recall limit
const SENT_MSG_FILE = join(homedir(), ".openclaw", "feishu-sent-messages.json");

let sentMsgDiskLoaded = false;

function loadSentMessageLog(): void {
  if (sentMsgDiskLoaded) return;
  sentMsgDiskLoaded = true;
  try {
    if (!existsSync(SENT_MSG_FILE)) return;
    const raw = readFileSync(SENT_MSG_FILE, "utf-8");
    const entries: Array<[string, SentMessageEntry[]]> = JSON.parse(raw);
    const now = Date.now();
    for (const [chatId, msgs] of entries) {
      const valid = msgs.filter((m) => now - m.sentAt < SENT_MSG_TTL_MS);
      if (valid.length > 0) sentMessageLog.set(chatId, valid);
    }
  } catch {
    // Corrupt or missing file — start fresh.
  }
}

let sentMsgFlushTimer: ReturnType<typeof setTimeout> | undefined;

function flushSentMessageLog(): void {
  try {
    const now = Date.now();
    for (const [chatId, msgs] of sentMessageLog) {
      const valid = msgs.filter((m) => now - m.sentAt < SENT_MSG_TTL_MS);
      if (valid.length === 0) sentMessageLog.delete(chatId);
      else sentMessageLog.set(chatId, valid);
    }
    const dir = dirname(SENT_MSG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SENT_MSG_FILE, JSON.stringify([...sentMessageLog.entries()]), "utf-8");
  } catch {
    // Best-effort persistence.
  }
}

function scheduleSentMsgFlush(): void {
  if (sentMsgFlushTimer) return;
  sentMsgFlushTimer = setTimeout(() => {
    sentMsgFlushTimer = undefined;
    flushSentMessageLog();
  }, 2000);
}

export function recordSentMessage(chatId: string, messageId: string, preview?: string): void {
  loadSentMessageLog();
  const renderedPreview = preview ? formatFeishuUserFacingText(preview) : undefined;
  let list = sentMessageLog.get(chatId);
  if (!list) {
    list = [];
    sentMessageLog.set(chatId, list);
  }
  const trimmedPreview = renderedPreview?.slice(0, 60).replace(/\n/g, " ");
  list.push({
    messageId,
    sentAt: Date.now(),
    ...(trimmedPreview ? { preview: trimmedPreview } : {}),
  });
  // Enforce global max: count all entries across chats, drop oldest.
  let total = 0;
  for (const msgs of sentMessageLog.values()) total += msgs.length;
  if (total > SENT_MSG_MAX) {
    const all: Array<{ chatId: string; idx: number; sentAt: number }> = [];
    for (const [cid, msgs] of sentMessageLog) {
      for (let i = 0; i < msgs.length; i++)
        all.push({ chatId: cid, idx: i, sentAt: msgs[i].sentAt });
    }
    all.sort((a, b) => a.sentAt - b.sentAt);
    const toDrop = all.slice(0, total - SENT_MSG_MAX);
    // Group drops by chatId for efficient removal.
    const dropIndices = new Map<string, Set<number>>();
    for (const d of toDrop) {
      let s = dropIndices.get(d.chatId);
      if (!s) {
        s = new Set();
        dropIndices.set(d.chatId, s);
      }
      s.add(d.idx);
    }
    for (const [cid, indices] of dropIndices) {
      const msgs = sentMessageLog.get(cid);
      if (!msgs) continue;
      const kept = msgs.filter((_, i) => !indices.has(i));
      if (kept.length === 0) sentMessageLog.delete(cid);
      else sentMessageLog.set(cid, kept);
    }
  }
  scheduleSentMsgFlush();
}

/** Get recent bot-sent message IDs for a chat (newest first). */
export function getRecentSentMessages(chatId: string, count = 10): SentMessageEntry[] {
  loadSentMessageLog();
  const now = Date.now();
  const list = (sentMessageLog.get(chatId) ?? []).filter((m) => now - m.sentAt < SENT_MSG_TTL_MS);
  return list.slice(-Math.min(count, 50)).reverse();
}

/** Remove a message from the sent-message log (after successful recall).
 *  If chatId is provided, searches only that chat; otherwise scans all chats. */
export function removeSentMessage(chatId: string | undefined, messageId: string): void {
  loadSentMessageLog();
  const chatsToSearch = chatId ? [chatId] : Array.from(sentMessageLog.keys());
  for (const cid of chatsToSearch) {
    const list = sentMessageLog.get(cid);
    if (!list) continue;
    const idx = list.findIndex((m) => m.messageId === messageId);
    if (idx === -1) continue;
    list.splice(idx, 1);
    if (list.length === 0) sentMessageLog.delete(cid);
    scheduleSentMsgFlush();
    return;
  }
}

// ── Quoted message content retrieval (im.message.get) ───────────────────
// When a user replies to a message, Feishu sends parent_id (the quoted msg).
// We fetch its content so the AI has the full context of what was quoted.

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  senderId?: string;
  content: string;
  contentType: string;
  /** Image keys found in the quoted message (for downstream download). */
  imageKeys?: string[];
};

async function getQuotedMessageContent(params: {
  account: ResolvedFeishuAccount;
  parentMessageId: string;
  log?: ChannelLogSink;
}): Promise<FeishuMessageInfo | null> {
  const { account, parentMessageId, log } = params;
  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const response: any = await client.im.message.get({
      path: { message_id: parentMessageId },
    });
    if (response?.code !== 0) return null;
    const item = response?.data?.items?.[0];
    if (!item) return null;
    let content: string = item.body?.content ?? "";
    const quotedImageKeys: string[] = [];
    try {
      const parsed = JSON.parse(content);
      if (item.msg_type === "text" && parsed.text) {
        content = parsed.text;
      } else if (item.msg_type === "post") {
        // Handle both flat format and locale-wrapped format.
        content = extractPostText(parsed, quotedImageKeys) ?? content;
      } else if (item.msg_type === "interactive") {
        // CardKit streaming cards return degraded body via im.message.get.
        // Primary: look up cached final text (we cached it when the stream finished).
        loadCardCacheFromDisk();
        const cached = cardTextCache.get(parentMessageId);
        if (cached) {
          content = cached.text;
          log?.info(`[${account.accountId}] quoted interactive msg resolved from cache`);
        } else {
          // Fallback: extract text from the degraded legacy element structure.
          content = flattenInteractiveBody(parsed, quotedImageKeys) ?? content;
          log?.info(`[${account.accountId}] quoted interactive msg fallback parse (cache miss)`);
        }
      } else if (item.msg_type === "image") {
        // Standalone image message: collect key for downstream download.
        if (parsed.image_key) {
          quotedImageKeys.push(parsed.image_key);
        }
        content = "[image]";
      }
    } catch {
      // Keep raw content if parsing fails.
    }
    return {
      messageId: item.message_id ?? parentMessageId,
      chatId: item.chat_id ?? "",
      senderId: item.sender?.id,
      content,
      contentType: item.msg_type ?? "text",
      imageKeys: quotedImageKeys.length > 0 ? quotedImageKeys : undefined,
    };
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      log?.info(
        `[${account.accountId}] permission error fetching quoted msg: code=${permErr.code}`,
      );
    } else {
      log?.info(
        `[${account.accountId}] failed to fetch quoted msg ${parentMessageId}: ${String(err)}`,
      );
    }
    return null;
  }
}

export type FeishuGatewayOptions = {
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
};

// Dedupe recent messages (Feishu may re-deliver on timeout).
const recentMessageIds = new Set<string>();
const MAX_RECENT = 500;

/**
 * Resolve the Webchat URL for welcome messages.
 * Priority: WEBCHAT_URL env var > auto-compute from gateway config.
 * Docker containers get the env var via start-user.sh (external port mapping).
 * Local instances auto-compute from config (localhost + gateway port + token).
 */
function resolveWebchatUrl(config: OpenClawConfig): string | undefined {
  // Docker / explicit override takes priority
  const envUrl = process.env.WEBCHAT_URL;
  if (envUrl) return envUrl;

  // Auto-compute from gateway config
  const port = config.gateway?.port ?? 18789;
  const token = config.gateway?.auth?.token;
  const base = `http://localhost:${port}`;
  return token ? `${base}?token=${token}` : base;
}

// ---------------------------------------------------------------------------
// Voice URL + token management (Layer 2 auth — same logic for local & Docker)
// Token file: ~/.openclaw/.voice-token (persistent across restarts)
// ---------------------------------------------------------------------------
const VOICE_TOKEN_PATH = join(process.env.HOME || os.homedir(), ".openclaw", ".voice-token");

/** Read or generate voice token. reset=true forces regeneration. */
function ensureVoiceToken(reset = false): string {
  if (!reset) {
    try {
      const existing = readFileSync(VOICE_TOKEN_PATH, "utf-8").trim();
      if (existing) return existing;
    } catch {
      /* file doesn't exist, generate */
    }
  }
  const token = crypto.randomUUID().replace(/-/g, "");
  mkdirSync(dirname(VOICE_TOKEN_PATH), { recursive: true });
  writeFileSync(VOICE_TOKEN_PATH, token);
  return token;
}

/** Construct voice URL. Same logic for local and Docker. */
function resolveVoiceUrl(config: OpenClawConfig, token: string): string {
  const feHost = process.env.VOICE_FE_HOST;
  const proxyHost = process.env.VOICE_PROXY_HOST;
  if (feHost && proxyHost) {
    // Docker: use tunnel domains (FE proxy handles RT proxying internally)
    return (
      `https://${feHost}/mobile.html` +
      `?proxy=wss://${proxyHost}` +
      `&openclaw=wss://${feHost}/ws` +
      `&token=${token}`
    );
  }
  // Local: localhost
  return (
    `http://localhost:8000/mobile.html` +
    `?proxy=ws://localhost:8080` +
    `&openclaw=ws://localhost:18790/ws` +
    `&token=${token}`
  );
}

function trackMessageId(messageId: string): boolean {
  if (recentMessageIds.has(messageId)) {
    return false;
  }
  recentMessageIds.add(messageId);
  if (recentMessageIds.size > MAX_RECENT) {
    const first = recentMessageIds.values().next().value;
    if (first) recentMessageIds.delete(first);
  }
  return true;
}

/** Flatten a post body ({ title?, content: [[{tag,text}, ...]] }) into plain text.
 *  Also collects any embedded image_key values for downstream download. */
// oxlint-disable-next-line typescript/no-explicit-any
function flattenPostBody(
  body: any,
  imageKeys?: string[],
  fileInfo?: FeishuFileInfo[],
): string | null {
  if (!body || !Array.isArray(body.content)) return null;
  const lines: string[] = [];
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const el of paragraph) {
      if (el.tag === "text" || el.tag === "a") line += el.text ?? "";
      else if (el.tag === "at") line += el.user_id ? `@_user_${el.user_id}` : "";
      else if (el.tag === "img") {
        // Collect image keys for download; replace with placeholder in text.
        if (el.image_key && imageKeys) imageKeys.push(el.image_key);
        line += "<media:image>";
      } else if (el.tag === "media") {
        // Embedded video in rich-text: collect cover + file for download.
        if (el.image_key && imageKeys) imageKeys.push(el.image_key);
        if (el.file_key && fileInfo)
          fileInfo.push({ fileKey: el.file_key, fileName: el.file_name ?? "video" });
        line += "[video]";
      } else if (el.tag === "emotion") line += el.emoji_type ? `[${el.emoji_type}]` : "";
    }
    lines.push(line);
  }
  const title = typeof body.title === "string" && body.title ? `${body.title}\n` : "";
  return `${title}${lines.join("\n")}`.trim() || null;
}

/** Extract plain text from a Feishu "post" (rich-text) message.
 *  Received format: { title?, content: [[...]] }  (flat, no locale wrapper)
 *  Send format:     { zh_cn: { title?, content: [[...]] } }  (locale-wrapped)
 *  We handle both so the parser is robust.
 *  imageKeys: collects any embedded image_key values for downstream download. */
function extractPostText(
  parsed: Record<string, unknown>,
  imageKeys?: string[],
  fileInfo?: FeishuFileInfo[],
): string | null {
  // Received messages use the flat format (title + content at top level).
  if (Array.isArray(parsed.content)) {
    return flattenPostBody(parsed, imageKeys, fileInfo);
  }
  // Fallback: locale-wrapped format (zh_cn / en_us / first key).
  // oxlint-disable-next-line typescript/no-explicit-any
  const locales = parsed as Record<string, any>;
  const locale = locales.zh_cn ?? locales.en_us ?? Object.values(locales)[0];
  return flattenPostBody(locale, imageKeys, fileInfo);
}

/** Extract text from an interactive (card) message's degraded body.
 *  When fetched via im.message.get, CardKit cards are returned in a legacy format:
 *  { title?, elements: [[{tag,text,...}, ...], ...] }
 *  We extract text/link content and collect image keys.
 *  Returns null if the structure is unrecognisable (caller falls back to raw content). */
// oxlint-disable-next-line typescript/no-explicit-any
function flattenInteractiveBody(parsed: any, imageKeys?: string[]): string | null {
  if (!parsed?.elements || !Array.isArray(parsed.elements)) {
    return null;
  }
  const lines: string[] = [];
  for (const row of parsed.elements) {
    if (!Array.isArray(row)) {
      continue;
    }
    let line = "";
    for (const el of row) {
      if (el.tag === "text" || el.tag === "a") {
        line += el.text ?? "";
      } else if (el.tag === "at") {
        line += el.user_name ?? "";
      } else if (el.tag === "img" && el.image_key) {
        if (imageKeys) {
          imageKeys.push(el.image_key);
        }
        line += "<media:image>";
      }
      // Skip buttons, hr, select, date_picker, overflow, note — UI-only elements.
    }
    if (line.trim()) {
      lines.push(line);
    }
  }
  const title = typeof parsed.title === "string" && parsed.title ? `${parsed.title}\n` : "";
  return `${title}${lines.join("\n")}`.trim() || null;
}

/** File attachment info extracted from a Feishu file message. */
interface FeishuFileInfo {
  fileKey: string;
  fileName: string;
}

/** Extract plain text from Feishu message content JSON.
 *  imageKeys: collects image_key values from post messages and standalone image messages.
 *  fileInfo: collects file_key + file_name from file messages for download. */
function extractTextContent(
  content: string,
  msgType: string,
  imageKeys?: string[],
  fileInfo?: FeishuFileInfo[],
): string | null {
  try {
    const parsed = JSON.parse(content);
    if (msgType === "text") {
      return (parsed.text as string) ?? null;
    }
    // Rich-text (post) messages: flatten nested paragraphs into plain text.
    // Embedded img/media tags have their keys collected for download.
    if (msgType === "post") {
      return extractPostText(parsed, imageKeys, fileInfo);
    }
    // Standalone image messages: collect image_key for download.
    if (msgType === "image") {
      if (parsed.image_key && imageKeys) imageKeys.push(parsed.image_key);
      return null; // Handled in handleInboundMessage.
    }
    // File attachments (PPT, PDF, images-as-files, etc.): collect for download.
    if (msgType === "file") {
      if (parsed.file_key && fileInfo) {
        fileInfo.push({ fileKey: parsed.file_key, fileName: parsed.file_name ?? "unknown" });
      }
      return null; // Handled in handleInboundMessage.
    }
    // Video messages: cover image for vision + video file for download.
    if (msgType === "media") {
      if (parsed.image_key && imageKeys) imageKeys.push(parsed.image_key);
      if (parsed.file_key && fileInfo) {
        fileInfo.push({ fileKey: parsed.file_key, fileName: parsed.file_name ?? "video" });
      }
      return null; // Handled in handleInboundMessage.
    }
    // Audio/voice messages: collect file_key for download (triggers STT pipeline).
    if (msgType === "audio") {
      if (parsed.file_key && fileInfo) {
        fileInfo.push({ fileKey: parsed.file_key, fileName: parsed.file_name ?? "voice.ogg" });
      }
      return null; // Handled in handleInboundMessage via file download.
    }
    if (msgType === "sticker") return "[sticker]";
    return null;
  } catch {
    return null;
  }
}

export async function startFeishuGateway(opts: FeishuGatewayOptions): Promise<void> {
  const { account, config, abortSignal, log, setStatus } = opts;
  const core = getFeishuRuntime();

  log?.info(`[${account.accountId}] connecting Feishu WSClient...`);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      // Return immediately so the SDK sends the ACK frame within milliseconds.
      // Without this, Feishu's ~3-5s ACK timeout expires before the AI finishes
      // processing (6-27s observed), causing Feishu to retry at +15s/+5m/+1h/+6h.
      void handleInboundMessage(data, { account, config, log, setStatus, core }).catch((err) => {
        log?.error(`[${account.accountId}] error handling message: ${String(err)}`);
      });
    },
  });

  const wsClient = new Lark.WSClient({
    appId: account.appId,
    appSecret: account.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher });

  log?.info(`[${account.accountId}] Feishu WSClient connected`);
  setStatus({ connected: true, lastConnectedAt: Date.now() });

  // Block until abort signal fires (gateway shutting down).
  return new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener(
      "abort",
      () => {
        log?.info(`[${account.accountId}] Feishu gateway stopping`);
        setStatus({ running: false, connected: false, lastStopAt: Date.now() });
        resolve();
      },
      { once: true },
    );
  });
}

// ── Mention parsing helpers ─────────────────────────────────────────────

type FeishuMention = { key: string; id: string; name?: string };

/** Parse the mentions array from the Feishu event body.
 *  SDK returns mentions[].id as an object { open_id, union_id, user_id },
 *  not a plain string. We extract the open_id for comparison. */
// oxlint-disable-next-line typescript/no-explicit-any
function parseMentions(message: any): FeishuMention[] {
  const raw = message?.mentions;
  if (!Array.isArray(raw)) return [];
  return (
    raw
      // oxlint-disable-next-line typescript/no-explicit-any
      .filter((m: any) => m.key && m.id)
      // oxlint-disable-next-line typescript/no-explicit-any
      .map((m: any) => ({
        key: m.key as string,
        // SDK gives id as { open_id, union_id, user_id } object — extract open_id.
        id:
          typeof m.id === "object" && m.id?.open_id ? (m.id.open_id as string) : String(m.id ?? ""),
        name: m.name as string | undefined,
      }))
  );
}

/** Extract sender name from Feishu event.
 *  Tries various SDK fields; falls back to senderId. */
// oxlint-disable-next-line typescript/no-explicit-any
function extractSenderName(sender: any): string {
  return sender?.sender_id?.name ?? sender?.sender_id?.id ?? sender?.sender_id?.open_id ?? "";
}

// ── Inbound message processing ──────────────────────────────────────────

type InboundDeps = {
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
  core: ReturnType<typeof getFeishuRuntime>;
};

/**
 * Walk the officeparser AST to produce rich text with slide separators and chart data.
 * Falls back to ast.toText() if the AST structure is unexpected.
 */
// oxlint-disable-next-line typescript/no-explicit-any
function formatOfficeAst(ast: any, maxChars: number): string {
  if (!ast) return "";
  const content = ast.content as unknown[];
  if (!Array.isArray(content) || content.length === 0) {
    // Fallback: no structured content, use plain text.
    return (ast.toText?.() ?? "").slice(0, maxChars).trim();
  }

  // Build a lookup of chart attachment data by name.
  // oxlint-disable-next-line typescript/no-explicit-any
  const chartDataByName = new Map<string, any>();
  const attachments = ast.attachments as unknown[];
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const a = att as any;
      if (a.chartData && a.name) {
        chartDataByName.set(a.name, a.chartData);
      }
    }
  }

  const lines: string[] = [];
  let slideNum = 0;
  let charCount = 0;

  // oxlint-disable-next-line typescript/no-explicit-any
  function walkNode(node: any): void {
    if (charCount >= maxChars) return;
    if (!node) return;
    const type = node.type as string;

    // Slide / section separator (PPTX slides appear as top-level "slide" nodes).
    if (type === "slide" || type === "section") {
      slideNum++;
      const sep = `\n--- Slide ${slideNum} ---\n`;
      lines.push(sep);
      charCount += sep.length;
    }

    // Chart node — format chart data from attachments.
    if (type === "chart") {
      const attachmentName = node.metadata?.attachmentName as string | undefined;
      const cd = attachmentName ? chartDataByName.get(attachmentName) : undefined;
      if (cd) {
        const parts: string[] = [];
        if (cd.title) parts.push(`[Chart: ${cd.title}]`);
        else parts.push("[Chart]");
        const labels = cd.labels as string[] | undefined;
        const dataSets = cd.dataSets as unknown[] | undefined;
        if (Array.isArray(labels) && labels.length > 0) {
          parts.push(`  Categories: ${labels.join(", ")}`);
        }
        if (Array.isArray(dataSets)) {
          for (const ds of dataSets) {
            // oxlint-disable-next-line typescript/no-explicit-any
            const d = ds as any;
            const vals = Array.isArray(d.values) ? d.values.join(", ") : String(d.values ?? "");
            const name = d.name ? `${d.name}: ` : "";
            parts.push(`  Data: ${name}${vals}`);
          }
        }
        const chartText = parts.join("\n") + "\n";
        lines.push(chartText);
        charCount += chartText.length;
      }
    }

    // Table node — format as tab-separated rows.
    if (type === "table" && Array.isArray(node.children)) {
      const rows = node.children.filter((r: { type: string }) => r.type === "row");
      for (const row of rows) {
        if (charCount >= maxChars) break;
        // oxlint-disable-next-line typescript/no-explicit-any
        const cells = (row.children ?? []).filter((c: any) => c.type === "cell");
        // oxlint-disable-next-line typescript/no-explicit-any
        const rowText = cells.map((c: any) => (c.text ?? "").replace(/[\t\n]/g, " ")).join("\t");
        lines.push(rowText);
        charCount += rowText.length + 1;
      }
      lines.push(""); // blank line after table
      return; // children already processed
    }

    // Recurse into children if present; otherwise emit leaf text.
    // This avoids duplication: parent.text is the concatenation of children's text,
    // so we only emit text for leaf nodes (no children).
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    if (hasChildren && type !== "table") {
      for (const child of node.children) {
        if (charCount >= maxChars) break;
        walkNode(child);
      }
    } else if (!hasChildren && node.text && type !== "table" && type !== "row" && type !== "cell") {
      const txt = String(node.text).trim();
      if (txt) {
        lines.push(txt);
        charCount += txt.length + 1;
      }
    }
  }

  for (const node of content) {
    if (charCount >= maxChars) break;
    walkNode(node);
  }

  return lines.join("\n").slice(0, maxChars).trim();
}

// oxlint-disable-next-line typescript/no-explicit-any
async function handleInboundMessage(data: any, deps: InboundDeps): Promise<void> {
  const { account, config, log, setStatus, core } = deps;
  const message = data.message;
  const sender = data.sender;

  if (!message || !sender) return;

  const messageId: string = message.message_id ?? "";
  const chatId: string = message.chat_id ?? "";
  const chatType: string = message.chat_type ?? ""; // "p2p" | "group"
  const msgType: string = message.message_type ?? "text";
  const content: string = message.content ?? "{}";
  const senderId: string = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "";
  const senderType: string = sender.sender_type ?? "";
  // parent_id is the message being replied to (quoted message).
  const parentId: string = message.parent_id ?? "";

  // Skip bot messages.
  if (senderType === "bot") return;

  // Debug: log raw inbound for diagnosis (create_time helps detect replayed messages).
  const createTime: string = message.create_time ?? "";
  log?.info(
    `[${account.accountId}] raw inbound: msgId=${messageId} createTime=${createTime} msgType=${msgType} from=${senderId} parentId=${parentId} content=${content.slice(0, 120)}`,
  );

  // Deduplicate.
  if (messageId && !trackMessageId(messageId)) return;

  // ── Extract text, collect embedded image keys and file attachment info ──
  const imageKeys: string[] = [];
  const fileInfo: FeishuFileInfo[] = [];
  const rawText = extractTextContent(content, msgType, imageKeys, fileInfo);

  // ── Download images (standalone image msgs + images embedded in post) ──
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  if (imageKeys.length > 0 && messageId) {
    for (const imageKey of imageKeys) {
      try {
        log?.info(`[${account.accountId}] downloading image: key=${imageKey} msg=${messageId}`);
        const imgData = await downloadFeishuImage({ account, messageId, imageKey });
        if (imgData) {
          // No size limit — image is already downloaded into memory.
          const saved = await core.channel.media.saveMediaBuffer(
            imgData.buffer,
            imgData.contentType,
            "inbound",
            Infinity,
          );
          mediaPaths.push(saved.path);
          mediaTypes.push(saved.contentType ?? imgData.contentType ?? "image/jpeg");
          log?.info(`[${account.accountId}] image saved: ${saved.path}`);
        }
      } catch (err) {
        log?.error(
          `[${account.accountId}] image download failed (key=${imageKey}): ${String(err)}`,
        );
      }
    }
    // Primary media fields use the first image.
    if (mediaPaths.length > 0) {
      mediaPath = mediaPaths[0];
      mediaType = mediaTypes[0];
    }
  }

  // ── Download file attachments (file msgs: PPT, PDF, images-as-files, etc.) ──
  // Track per-file errors so we can give the AI an informative placeholder.
  const fileErrors: { name: string; reason: string }[] = [];
  if (fileInfo.length > 0 && messageId) {
    for (const fi of fileInfo) {
      try {
        log?.info(
          `[${account.accountId}] downloading file: key=${fi.fileKey} name=${fi.fileName} msg=${messageId}`,
        );
        const fileData = await downloadFeishuFile({ account, messageId, fileKey: fi.fileKey });
        if (fileData) {
          // Feishu may return application/octet-stream for audio; fix to audio/ogg
          // so the STT pipeline detects audio/* and triggers transcription.
          const isAudioFile = fi.fileName.endsWith(".ogg") || fi.fileName.endsWith(".opus");
          const effectiveContentType =
            isAudioFile && fileData.contentType === "application/octet-stream"
              ? "audio/ogg"
              : fileData.contentType;
          // No size limit — Feishu already caps uploads; buffer is already in memory.
          const saved = await core.channel.media.saveMediaBuffer(
            fileData.buffer,
            effectiveContentType,
            "inbound",
            Infinity,
            fi.fileName,
          );
          mediaPaths.push(saved.path);
          mediaTypes.push(saved.contentType ?? effectiveContentType ?? "application/octet-stream");
          log?.info(`[${account.accountId}] file saved: ${saved.path} (${fi.fileName})`);
        } else {
          fileErrors.push({ name: fi.fileName, reason: "download returned empty" });
        }
      } catch (err) {
        const msg = String(err);
        log?.error(
          `[${account.accountId}] file download failed (key=${fi.fileKey} name=${fi.fileName}): ${msg}`,
        );
        // Feishu /im/v1/messages/{id}/resources/{key} returns HTTP 400 with a JSON body
        // containing a specific error code. Documented codes:
        //   234001 = invalid params, 234003 = file not in message,
        //   234004 = app not in chat, 234037 = file exceeds 100 MB limit.
        // The Lark SDK uses responseType:'stream', so err.response.data may be a
        // ReadableStream, Buffer, string, or pre-parsed object — try all forms.
        let reason = "download failed";
        try {
          // oxlint-disable-next-line typescript/no-explicit-any
          const resp = (err as any)?.response;
          if (resp) {
            let code: number | undefined;
            let feishuMsg: string | undefined;
            const d = resp.data;
            if (d && typeof d === "object" && typeof d.code === "number") {
              code = d.code;
              feishuMsg = d.msg;
            } else {
              let raw: string | undefined;
              if (Buffer.isBuffer(d)) raw = d.toString("utf-8");
              else if (typeof d === "string") raw = d;
              else if (d && typeof d[Symbol.asyncIterator] === "function") {
                const chunks: Buffer[] = [];
                for await (const chunk of d as AsyncIterable<Buffer>) {
                  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
                }
                raw = Buffer.concat(chunks).toString("utf-8");
              }
              if (raw) {
                try {
                  const p = JSON.parse(raw);
                  code = p.code;
                  feishuMsg = p.msg;
                } catch {}
              }
            }
            if (code === 234037) reason = "file too large (Feishu limits downloads to 100 MB)";
            else if (code === 234001) reason = "invalid request parameters";
            else if (code === 234003) reason = "resource does not belong to this message";
            else if (code === 234004) reason = "bot is not in the chat";
            else if (code) reason = feishuMsg ?? `Feishu error ${code}`;
            else reason = `download failed (HTTP ${resp.status ?? "?"})`;
          }
        } catch {
          // Parsing failed; keep generic reason.
        }
        if (msg.includes("exceeds")) reason = msg.replace(/^Error:\s*/, "");
        fileErrors.push({ name: fi.fileName, reason });
      }
    }
    // Set primary media fields if not already set by images.
    if (!mediaPath && mediaPaths.length > 0) {
      mediaPath = mediaPaths[0];
      mediaType = mediaTypes[0];
    }
  }

  // ── Extract text from Office files (PPTX, DOCX, XLSX, etc.) via officeparser ──
  const OFFICE_EXTS = new Set([".pptx", ".docx", ".xlsx", ".odt", ".odp", ".ods", ".rtf"]);
  const MAX_OFFICE_CHARS = 100_000;
  const officeBlocks: string[] = [];
  const fallbackParts: string[] = [];

  if (fileInfo.length > 0) {
    let savedIdx = imageKeys.length; // file paths come after image paths in mediaPaths
    for (const fi of fileInfo) {
      const savedPath = mediaPaths[savedIdx];
      if (!savedPath) continue;
      savedIdx++;

      const ext = fi.fileName.includes(".")
        ? `.${fi.fileName.split(".").pop()!.toLowerCase()}`
        : "";

      if (OFFICE_EXTS.has(ext)) {
        // Try structured extraction with officeparser (AST mode for charts + slides).
        try {
          const { parseOffice } = await import("officeparser");
          const ast = await parseOffice(savedPath, { extractAttachments: true });
          const text = formatOfficeAst(ast, MAX_OFFICE_CHARS);
          if (text) {
            officeBlocks.push(`<file name="${fi.fileName}">\n${text}\n</file>`);
            log?.info(
              `[${account.accountId}] office text extracted: ${fi.fileName} (${text.length} chars)`,
            );
          } else {
            // Extraction returned empty — fall back to path for exec.
            fallbackParts.push(`${fi.fileName} saved at ${savedPath} (text extraction empty)`);
            log?.info(
              `[${account.accountId}] office text empty, falling back to path: ${fi.fileName}`,
            );
          }
        } catch (err) {
          // Extraction failed — fall back to path for exec.
          fallbackParts.push(`${fi.fileName} saved at ${savedPath}`);
          log?.error(
            `[${account.accountId}] office extraction failed (${fi.fileName}): ${String(err)}`,
          );
        }
      } else {
        // Non-Office file (binary, zip, etc.) — report path so AI can use exec.
        fallbackParts.push(`${fi.fileName} saved at ${savedPath}`);
      }
    }
    // Append download failures.
    for (const e of fileErrors) {
      fallbackParts.push(`${e.name} (${e.reason})`);
    }
  }

  // Build the final file placeholder:
  // - officeBlocks: extracted text wrapped in <file> tags (AI sees content directly)
  // - fallbackParts: file paths + error info (AI can use exec or inform the user)
  let filePlaceholder: string | null = null;
  if (officeBlocks.length > 0 || fallbackParts.length > 0) {
    const sections: string[] = [];
    if (officeBlocks.length > 0) sections.push(officeBlocks.join("\n"));
    if (fallbackParts.length > 0) sections.push(`[file: ${fallbackParts.join("; ")}]`);
    filePlaceholder = sections.join("\n");
  }

  // For media-only messages, pick the right placeholder:
  // - Audio messages: "<media:audio>" triggers STT pipeline (same as Telegram pattern).
  // - Image messages (or image-as-file like jpg with msgType=file): "<media:image>" triggers vision.
  // - Video messages (msgType=media): cover image for vision + video file path for AI context.
  // - Non-image file messages: filePlaceholder with name+path so AI can use exec to read them.
  const isAudioMedia = msgType === "audio" && mediaType?.startsWith("audio/");
  const isImageMedia =
    imageKeys.length > 0 || (fileInfo.length > 0 && mediaType?.startsWith("image/"));
  const textFromMessage =
    rawText ??
    // Audio: placeholder triggers STT transcription.
    (isAudioMedia && mediaPath ? "<media:audio>" : null) ??
    // Video: combine cover image (vision) + video file path (AI can reference it).
    (msgType === "media" && isImageMedia && mediaPath && filePlaceholder
      ? `<media:image>\n${filePlaceholder}`
      : null) ??
    (isImageMedia && mediaPath ? "<media:image>" : null) ??
    filePlaceholder ??
    (fileInfo.length > 0 ? `[file: ${fileInfo[0].fileName}]` : null);
  if (!textFromMessage) {
    // Debug: log unrecognized message types so we can add support.
    log?.info(
      `[${account.accountId}] skipped msg: msgType=${msgType} content=${content.slice(0, 200)}`,
    );
    return;
  }

  // Strip @mentions (Feishu uses @_user_N patterns in text).
  const rawCleanText = textFromMessage.replace(/@_user_\d+/g, "").trim();
  const cleanText = rewriteModelShortcutCommand(rawCleanText);
  if (cleanText !== rawCleanText) {
    log?.info(`[${account.accountId}] rewritten model shortcut: ${rawCleanText} -> ${cleanText}`);
  }
  const isGroup = chatType === "group";

  // Allow through if: has text, is a reply (quoted msg context will be injected),
  // or is a group @mention (bot will respond based on context).
  // Only drop truly empty non-reply, non-mention messages.
  if (!cleanText && !parentId && !isGroup) return;

  log?.info(
    `[${account.accountId}] inbound: chat=${chatId} from=${senderId} type=${chatType}${mediaPath ? (isAudioMedia ? " +audio" : " +image") : ""}`,
  );
  setStatus({ lastInboundAt: Date.now() });

  // ── Group chat handling: archive + owner-only reply gating ──
  if (isGroup) {
    const groupConfig = account.config.groups;
    const groupsEnabled = groupConfig?.enabled === true;

    if (!groupsEnabled) {
      log?.info(`[${account.accountId}] group chat disabled, ignoring group message`);
      return;
    }

    // Archive all group messages (regardless of who sent them).
    const shouldArchive = groupConfig?.archive !== false;
    if (shouldArchive) {
      const senderName = extractSenderName(sender);
      // Fetch chat name (cached) — fire-and-forget to not block processing.
      let chatName: string | null = null;
      try {
        chatName = await getFeishuChatName(account, chatId);
      } catch {
        // Ignore — index will use chatId as fallback name.
      }
      try {
        archiveGroupMessage({
          chatId,
          chatName,
          senderId,
          senderName: senderName || senderId,
          text: cleanText,
          msgId: messageId,
        });
        log?.info(`[${account.accountId}] archived group msg from ${senderId} in ${chatId}`);
      } catch (err) {
        log?.error(`[${account.accountId}] group archive failed: ${String(err)}`);
      }
    }

    // Parse @mentions to detect if bot was mentioned.
    const mentions = parseMentions(message);
    let botOpenId: string | null = null;
    try {
      botOpenId = await getBotOpenId(account);
    } catch (err) {
      log?.error(`[${account.accountId}] getBotOpenId failed: ${String(err)}`);
    }
    const wasMentioned = botOpenId ? mentions.some((m) => m.id === botOpenId) : false;

    log?.info(
      `[${account.accountId}] group mention check: botOpenId=${botOpenId} mentions=${JSON.stringify(mentions.map((m) => ({ key: m.key, id: m.id, name: m.name })))} wasMentioned=${wasMentioned}`,
    );

    if (!wasMentioned) {
      // Not @mentioned — just archive (already done above), don't reply.
      log?.info(`[${account.accountId}] group msg not mentioning bot, skipping reply`);
      return;
    }

    // Bot was @mentioned. Check if sender is the owner.
    const ownerIds = resolveGroupOwnerIds(account.config);
    const isOwner = ownerIds.length === 0 || ownerIds.includes(senderId);

    if (!isOwner) {
      // Non-owner @mentioned bot — stay completely silent.
      log?.info(`[${account.accountId}] non-owner ${senderId} @mentioned bot in group, ignoring`);
      return;
    }

    // Owner @mentioned bot in group — proceed to reply.
    log?.info(`[${account.accountId}] owner ${senderId} @mentioned bot in group, processing`);
  }

  // DM access control: for now use "open" policy (private bot, only you can see it).
  // Full pairing/allowlist support can be added later.

  // Send webchat URL reminder on /new (new session).
  // URL resolution: WEBCHAT_URL env var (Docker) > auto-compute from gateway config (local).
  if (cleanText === "/new") {
    const webchatUrl = resolveWebchatUrl(config);
    if (webchatUrl) {
      const welcomeText =
        `你好！我是你的 AI 助手 🤖\n\n` +
        `除了飞书对话，你还可以通过网页版和我聊天：\n${webchatUrl}\n\n` +
        `网页版支持代码高亮、文件上传等更丰富的功能。`;
      try {
        await sendFeishuRichText({ account, chatId, text: welcomeText });
        log?.info(`[${account.accountId}] welcome sent to ${senderId}`);
      } catch (err) {
        log?.error(`[${account.accountId}] welcome send failed: ${String(err)}`);
      }
    }
  }

  // /voice — deliver authenticated voice URL; /voice reset — regenerate token
  if (cleanText === "/voice" || cleanText === "/voice reset") {
    const isReset = cleanText === "/voice reset";
    const token = ensureVoiceToken(isReset);
    const voiceUrl = resolveVoiceUrl(config, token);
    const msg = isReset
      ? `语音链接已重置\n\n新链接：\n${voiceUrl}\n\n旧链接已失效。此链接仅限你本人使用。`
      : `语音模式\n\n点击链接打开语音对话：\n${voiceUrl}\n\n此链接仅限你本人使用，请勿分享。`;
    try {
      await sendFeishuRichText({ account, chatId, text: msg });
      log?.info(
        `[${account.accountId}] voice URL ${isReset ? "reset and " : ""}sent to ${senderId}`,
      );
    } catch (err) {
      log?.error(`[${account.accountId}] voice URL send failed: ${String(err)}`);
    }
    return; // /voice is a command, don't forward to AI
  }

  // /quota — check Anthropic Max subscription usage via a minimal API probe
  if (cleanText === "/quota") {
    try {
      const quotaMsg = await checkAnthropicQuota();
      if (quotaMsg) {
        await sendFeishuRichText({ account, chatId, text: quotaMsg });
        log?.info(`[${account.accountId}] quota report sent to ${senderId}`);
      } else {
        await sendFeishuText({
          account,
          chatId,
          text: "无法查询用量：未配置 ANTHROPIC_OAUTH_TOKEN 环境变量。",
        });
      }
    } catch (err) {
      log?.error(`[${account.accountId}] quota check failed: ${String(err)}`);
      try {
        await sendFeishuText({
          account,
          chatId,
          text: `用量查询失败: ${String(err).slice(0, 200)}`,
        });
      } catch {
        /* ignore send failure */
      }
    }
    return; // /quota is a command, don't forward to AI
  }

  // /summary — show latest compaction report; /summary all — list all
  if (cleanText === "/summary" || cleanText === "/summary all") {
    try {
      const {
        readLatestReport,
        listReportFiles,
        formatMarkdown,
        formatSummaryList,
        buildReportFromSessionFile,
        buildAllReportsFromSessionFile,
      } = await import("./compaction-report.js");
      const { existsSync, readdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const compactionCfg = config as Record<string, unknown> | undefined;
      const agentsCfg = (compactionCfg?.agents as Record<string, unknown> | undefined)?.defaults as
        | Record<string, unknown>
        | undefined;
      const compCfg = agentsCfg?.compaction as Record<string, unknown> | undefined;
      const reportOpts = {
        reserveTokens: compCfg?.reserveTokens as number | undefined,
        reserveTokensFloor: compCfg?.reserveTokensFloor as number | undefined,
        keepRecentTokens: compCfg?.keepRecentTokens as number | undefined,
        maxHistoryShare: compCfg?.maxHistoryShare as number | undefined,
        contextTokens: agentsCfg?.contextTokens as number | undefined,
        compactionMode: compCfg?.mode as string | undefined,
      };

      const sessionsDir = join(homedir(), ".openclaw", "agents", "main", "sessions");
      const findSessionFile = (): string | undefined => {
        if (!existsSync(sessionsDir)) return undefined;
        const jsonls = readdirSync(sessionsDir).filter((f) => f === "main.jsonl");
        if (jsonls.length > 0) return join(sessionsDir, jsonls[0]!);
        const all = readdirSync(sessionsDir)
          .filter((f) => f.endsWith(".jsonl"))
          .sort()
          .reverse();
        return all.length > 0 ? join(sessionsDir, all[0]!) : undefined;
      };

      if (cleanText === "/summary all") {
        const savedFiles = listReportFiles();
        if (savedFiles.length > 0) {
          const lines = [`**Compaction History** (${savedFiles.length} reports)\n`];
          for (const f of savedFiles.slice(0, 20)) {
            lines.push(`- \`${f}\``);
          }
          if (savedFiles.length > 20) lines.push(`\n... and ${savedFiles.length - 20} more`);
          await sendFeishuRichText({ account, chatId, text: lines.join("\n") });
        } else {
          const sf = findSessionFile();
          if (sf) {
            const reports = buildAllReportsFromSessionFile(sf, reportOpts);
            if (reports.length > 0) {
              await sendFeishuRichText({ account, chatId, text: formatSummaryList(reports) });
            } else {
              await sendFeishuText({ account, chatId, text: "暂无 compaction 记录。" });
            }
          } else {
            await sendFeishuText({ account, chatId, text: "暂无 compaction 记录。" });
          }
        }
      } else {
        let content = readLatestReport();
        if (!content) {
          const sf = findSessionFile();
          if (sf) {
            const report = buildReportFromSessionFile(sf, reportOpts);
            if (report) content = formatMarkdown(report);
          }
        }
        if (!content) {
          await sendFeishuText({
            account,
            chatId,
            text: "暂无 compaction 记录。触发 compaction 后将自动生成报告。",
          });
        } else {
          const truncated =
            content.length > 4000 ? content.slice(0, 4000) + "\n\n... (truncated)" : content;
          await sendFeishuRichText({ account, chatId, text: truncated });
        }
      }
      log?.info(`[${account.accountId}] summary report sent to ${senderId}`);
    } catch (err) {
      log?.error(`[${account.accountId}] summary command failed: ${String(err)}`);
      try {
        await sendFeishuText({
          account,
          chatId,
          text: `Summary 查询失败: ${String(err).slice(0, 200)}`,
        });
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // ── Resolve sender display name (best-effort, non-blocking) ──
  let senderDisplayName: string | undefined;
  try {
    const nameResult = await resolveFeishuSenderName({ account, senderOpenId: senderId, log });
    senderDisplayName = nameResult.name;
    // Surface permission errors once per cooldown period so the admin knows.
    if (nameResult.permissionError) {
      const cooldownKey = account.appId ?? "default";
      const lastNotified = permissionErrorNotifiedAt.get(cooldownKey) ?? 0;
      if (Date.now() - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
        permissionErrorNotifiedAt.set(cooldownKey, Date.now());
        log?.error(
          `[${account.accountId}] Feishu permission error (sender name): ${nameResult.permissionError.message}` +
            (nameResult.permissionError.grantUrl
              ? ` Grant: ${nameResult.permissionError.grantUrl}`
              : ""),
        );
      }
    }
  } catch {
    // Best-effort — continue without display name.
  }
  if (senderDisplayName) {
    log?.info(`[${account.accountId}] sender resolved: ${senderId} -> ${senderDisplayName}`);
  }

  // ── Fetch quoted message content (if this is a reply) ──
  let quotedContext = "";
  let quotedBodyForReply: string | undefined;
  if (parentId) {
    try {
      const quoted = await getQuotedMessageContent({ account, parentMessageId: parentId, log });
      if (quoted?.content) {
        quotedContext = `\n[Quoted message (message_id=${parentId}): "${quoted.content.slice(0, 500)}"]`;
        // Prefix with message_id so AI can extract it even in DMs where core strips reply_to_id.
        quotedBodyForReply = `[message_id=${parentId}]\n${quoted.content.slice(0, 2000)}`;
        log?.info(
          `[${account.accountId}] quoted msg fetched: ${parentId} -> ${quoted.content.slice(0, 80)}`,
        );
      }
      // Download images embedded in the quoted message (standalone image, post img, card degraded img).
      if (quoted?.imageKeys?.length && quoted.messageId) {
        for (const imgKey of quoted.imageKeys) {
          try {
            log?.info(
              `[${account.accountId}] downloading quoted image: key=${imgKey} msg=${quoted.messageId}`,
            );
            const imgData = await downloadFeishuImage({
              account,
              messageId: quoted.messageId,
              imageKey: imgKey,
            });
            if (imgData) {
              // No size limit — image is already downloaded into memory.
              const saved = await core.channel.media.saveMediaBuffer(
                imgData.buffer,
                imgData.contentType,
                "inbound",
                Infinity,
              );
              mediaPaths.push(saved.path);
              mediaTypes.push(saved.contentType ?? imgData.contentType ?? "image/jpeg");
              log?.info(`[${account.accountId}] quoted image saved: ${saved.path}`);
            }
          } catch (err) {
            log?.info(
              `[${account.accountId}] quoted image download failed (key=${imgKey}): ${String(err)}`,
            );
          }
        }
        // Set primary media if not already set by the current message's own images.
        if (!mediaPath && mediaPaths.length > 0) {
          mediaPath = mediaPaths[0];
          mediaType = mediaTypes[0];
        }
      }
    } catch (err) {
      log?.info(`[${account.accountId}] quoted msg fetch failed: ${String(err)}`);
    }
  }

  // Resolve agent route for this message.
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "feishu",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "direct", id: chatId },
  });

  // Build envelope for the agent.
  // Include sender display name and quoted context in the body so the AI sees them.
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const enrichedFrom = senderDisplayName ? `${senderDisplayName} (${senderId})` : senderId;
  const enrichedBody = cleanText + quotedContext;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: enrichedFrom,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: cleanText,
    CommandBody: cleanText,
    From: `feishu:${senderId}`,
    To: `feishu:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: senderId,
    SenderId: senderId,
    Provider: "feishu",
    Surface: "feishu",
    MessageSid: messageId,
    MessageSidFull: messageId,
    ReplyToId: parentId || messageId,
    ReplyToBody: quotedBodyForReply,
    OriginatingChannel: "feishu",
    OriginatingTo: `feishu:${chatId}`,
    // Private bot: all senders are authorized to use commands (/new, /reset, etc.).
    CommandAuthorized: true,
    // Attach image media for vision processing if downloaded.
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  });

  // Record session metadata (fire-and-forget).
  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      log?.error(`feishu: failed updating session meta: ${String(err)}`);
    });

  // ── Card stream for typing / typewriter effect ──
  // Skip for commands (/new, /reset etc.) which have their own response flow.
  const isCommand = cleanText.startsWith("/");
  let cardStream: FeishuCardStream | undefined;

  // onReplyStart: create the card stream when the AI actually starts processing
  // (after session lane queuing — never fires for queued messages).
  const startCardStream = async () => {
    // Group chats: send text/post instead of interactive cards so other bots
    // (and the history API) can read Her's output. Card streaming is private-chat only.
    if (isGroup || isCommand || cardStream) return;
    try {
      cardStream = await createFeishuCardStream({
        account,
        chatId,
        replyToMessageId: messageId,
        log: (msg) => log?.info(`[${account.accountId}] ${msg}`),
        warn: (msg) => log?.error(`[${account.accountId}] ${msg}`),
      });
      if (cardStream.started) {
        log?.info(`[${account.accountId}] card stream started`);
      }
    } catch (err) {
      log?.error(`[${account.accountId}] card stream create failed: ${String(err)}`);
    }
  };

  // Track completed paragraphs across assistant messages.
  // onPartialReply text is per-paragraph (deltaBuffer resets each assistant message).
  // We detect paragraph boundaries by checking if the new text is a continuation of
  // the previous text — if not, a new assistant message started and we freeze the
  // previous paragraph into the prefix.
  let cardStreamPrefix = "";
  let cardStreamLastPartial = "";
  let cardStreamFinalText = "";
  let groupAccumulatedText = "";

  const updateCardStream = (text?: string) => {
    if (!text || !cardStream?.started) return;
    // Detect paragraph boundary: if text doesn't start with the previous partial,
    // it means deltaBuffer was reset (new assistant message). Freeze the previous
    // paragraph into the prefix.
    if (cardStreamLastPartial && !text.startsWith(cardStreamLastPartial)) {
      cardStreamPrefix = cardStreamPrefix
        ? cardStreamPrefix + "\n\n" + cardStreamLastPartial
        : cardStreamLastPartial;
    }
    cardStreamLastPartial = text;
    // Combine finished paragraphs with the current in-progress paragraph.
    const full = cardStreamPrefix ? cardStreamPrefix + "\n\n" + text : text;
    cardStream.update(full);
  };

  const stopCardStream = async () => {
    if (!cardStream?.started) return;
    // 1. Stop accepting new updates and cancel any scheduled timer.
    //    This prevents stray delayed flushes from firing after finalize.
    cardStream.stop();
    // 2. Push the full accumulated text as one final card update.
    //    onPartialReply may miss the tail of the last paragraph because deliver()
    //    can fire after the last partial — ensure the card shows the complete text.
    if (cardStreamFinalText) {
      await cardStream.sendFinal(cardStreamFinalText);
    }
    // 3. Close streaming mode so "[生成中...]" clears.
    await cardStream.finalize(cardStreamFinalText);
  };

  // ── ACK reaction: add a "typing" emoji when we start processing ──
  // Shows users an immediate visual indicator that their message was received.
  // The emoji is removed after the reply is delivered (like the test bot behavior).
  const ACK_EMOJI = "Get";
  let ackReactionId: string | null = null;
  const addAckReaction = async () => {
    if (isCommand) return;
    if (ackReactionId) return; // typing heartbeat re-fires onReplyStart; ACK only needs adding once
    try {
      ackReactionId = await addFeishuReaction({ account, messageId, emoji: ACK_EMOJI });
      if (ackReactionId) {
        log?.info(`[${account.accountId}] added ACK reaction (${ACK_EMOJI}) to ${messageId}`);
      }
    } catch (err) {
      // Non-fatal: ACK reaction is a UX nicety, not critical.
      log?.info(`[${account.accountId}] ACK reaction failed: ${String(err)}`);
    }
  };
  const removeAckReaction = async () => {
    if (!ackReactionId) return;
    try {
      await removeFeishuReaction({ account, messageId, reactionId: ackReactionId });
      log?.info(`[${account.accountId}] removed ACK reaction from ${messageId}`);
    } catch (err) {
      log?.info(`[${account.accountId}] ACK reaction removal failed: ${String(err)}`);
    }
    ackReactionId = null;
  };

  // Dispatch through the auto-reply pipeline and deliver response.
  // Strategy: onPartialReply drives the card typewriter (streaming display).
  // deliver only accumulates text for finalize — it does NOT update the card,
  // because onPartialReply already streamed the same content.
  //
  // Media dedup: when AI manually calls TTS, the tool result contains a MEDIA: path.
  // AI often echoes the same MEDIA: path in its final text reply. Without dedup,
  // the same audio gets uploaded+sent twice. This matches the pattern of
  // `filterMessagingToolDuplicates` (text dedup) in core reply-payloads.ts.
  // Preferred mode: tts.auto = "inbound" — system handles TTS, no AI echo, no dedup needed.
  const sentMediaUrls = new Set<string>();
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        // Filter already-delivered media (same pattern as filterMessagingToolDuplicates for text).
        const rawMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        const mediaUrls = rawMediaUrls.filter((u) => !sentMediaUrls.has(u));
        for (const u of mediaUrls) sentMediaUrls.add(u);
        const hasMedia = mediaUrls.length > 0;
        const skippedMedia = rawMediaUrls.length - mediaUrls.length;

        log?.info(
          `[${account.accountId}] deliver: kind=${info.kind} hasText=${!!payload.text} textLen=${payload.text?.length ?? 0} hasMedia=${hasMedia}${skippedMedia > 0 ? ` (skipped ${skippedMedia} duplicate media)` : ""}`,
        );

        // Group chats without card stream: accumulate text and send as a single
        // message after the full turn completes, avoiding fragmented bubbles.
        if (isGroup && !cardStream?.started && payload.text) {
          groupAccumulatedText = accumulateGroupedReplyText(groupAccumulatedText, payload.text);
          log?.info(
            `[${account.accountId}] deliver: group text accumulated (${groupAccumulatedText.length} chars total)`,
          );
          setStatus({ lastOutboundAt: Date.now() });
          if (hasMedia) {
            await deliverFeishuReply({
              payload: { mediaUrls },
              account,
              chatId,
              isGroup,
              replyToMessageId: messageId,
              log,
              setStatus,
              config,
              core,
            });
          }
          return;
        }

        if (cardStream?.started && payload.text) {
          const isReasoningBlock =
            info.kind === "block" && payload.text.trimStart().startsWith("Reasoning:");
          const isVerboseTool = info.kind === "tool";

          log?.info(
            `[${account.accountId}] deliver: card-stream check: kind=${info.kind} isReasoning=${isReasoningBlock} isVerbose=${isVerboseTool} textPrefix="${payload.text.slice(0, 60).replace(/\n/g, "\\n")}"`,
          );

          if (!isReasoningBlock && !isVerboseTool) {
            cardStreamFinalText = cardStreamFinalText
              ? cardStreamFinalText + "\n\n" + payload.text
              : payload.text;
            log?.info(
              `[${account.accountId}] deliver: text accumulated for finalize (${cardStreamFinalText.length} chars total)`,
            );
            setStatus({ lastOutboundAt: Date.now() });

            if (hasMedia) {
              await deliverFeishuReply({
                payload: { mediaUrls },
                account,
                chatId,
                isGroup,
                replyToMessageId: isGroup ? messageId : undefined,
                log,
                setStatus,
                config,
                core,
              });
            }
            return;
          }

          log?.info(
            `[${account.accountId}] deliver: bypassing card accumulation for ${isReasoningBlock ? "reasoning" : "verbose tool"} (kind=${info.kind})`,
          );
        }

        // Card stream not active, group text not accumulating, or no text — deliver normally.
        await deliverFeishuReply({
          payload: { ...payload, mediaUrls: hasMedia ? mediaUrls : undefined, mediaUrl: undefined },
          account,
          chatId,
          isGroup,
          replyToMessageId: isGroup ? messageId : undefined,
          log,
          setStatus,
          config,
          core,
        });
      },
      onError: (err, info) => {
        log?.error(`[${account.accountId}] Feishu ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: async () => {
        // Fire ACK reaction and card stream in parallel when AI starts processing.
        await Promise.all([addAckReaction(), startCardStream()]);
      },
    },
    replyOptions: {
      // Disable block streaming when card stream is active (non-command messages).
      // onPartialReply exclusively drives the card typewriter effect.
      disableBlockStreaming: !isCommand,
      onPartialReply: !isCommand ? (payload) => updateCardStream(payload.text) : undefined,
    },
  });
  // Group chats: flush accumulated text as a single post message.
  if (isGroup && groupAccumulatedText) {
    const footer = buildFeishuStatusFooter({ storePath, sessionKey: route.sessionKey, config });
    const finalGroupText = finalizeGroupedReplyText(groupAccumulatedText, footer);
    await deliverFeishuReply({
      payload: { text: finalGroupText },
      account,
      chatId,
      isGroup,
      replyToMessageId: messageId,
      log,
      setStatus,
      config,
      core,
    });
  }
  // Append status footer (model + context usage) to the card before closing.
  if (cardStream?.started && cardStreamFinalText) {
    const footer = buildFeishuStatusFooter({ storePath, sessionKey: route.sessionKey, config });
    if (footer) {
      cardStreamFinalText += footer;
    }
  }
  // Ensure card stream is stopped and ACK reaction is removed after dispatch completes.
  await Promise.all([
    cardStream?.started ? stopCardStream() : Promise.resolve(),
    removeAckReaction(),
  ]);

  // Cache the final card text so quoted-message lookups can resolve the real content
  // (im.message.get returns a degraded placeholder for CardKit interactive messages).
  if (cardStream?.started && cardStream.messageId && cardStreamFinalText) {
    cacheCardText(cardStream.messageId, cardStreamFinalText);
    recordSentMessage(chatId, cardStream.messageId, cardStreamFinalText);
  }
}

// ── Reply delivery ──────────────────────────────────────────────────────

async function deliverFeishuReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedFeishuAccount;
  chatId: string;
  isGroup?: boolean;
  replyToMessageId?: string;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
  config: OpenClawConfig;
  core: ReturnType<typeof getFeishuRuntime>;
}): Promise<void> {
  const { payload, account, chatId, isGroup, replyToMessageId, log, setStatus, config, core } =
    params;

  // Handle media (images/audio) if present.
  const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  for (const rawUrl of mediaUrls) {
    try {
      // Normalize media URL: strip MEDIA: prefix, resolve file:// and ~ paths.
      let url = rawUrl.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
      if (url.startsWith("file://")) {
        try {
          url = new URL(url).pathname;
        } catch {
          /* keep as-is */
        }
      }
      if (url.startsWith("~")) {
        url = url.replace(/^~/, homedir());
      }
      // Skip obviously invalid entries (AI hallucinations, instructional text, etc.)
      if (!url.startsWith("/") && !url.startsWith("http://") && !url.startsWith("https://")) {
        log?.warn?.(`Feishu: skipping invalid media URL (not a path or http): ${url.slice(0, 80)}`);
        continue;
      }
      // Local file paths (e.g. TTS output, generated files) need direct read.
      const isLocalFile = url.startsWith("/") && existsSync(url);
      const media = isLocalFile
        ? {
            buffer: readFileSync(url) as Buffer,
            contentType: inferContentType(url),
          }
        : await core.channel.media.fetchRemoteMedia({ url });
      if (!media?.buffer) {
        log?.error(`Feishu media fetch returned empty for ${url}`);
        continue;
      }
      const isAudio = media.contentType?.startsWith("audio/");
      const isVideo = media.contentType?.startsWith("video/");
      const isImage = media.contentType?.startsWith("image/");
      if (isAudio) {
        const fileName = url.split("/").pop()?.split("?")[0] ?? `audio-${Date.now()}.ogg`;
        const fileKey = await uploadFeishuAudio({ account, buffer: media.buffer });
        const mid = await sendFeishuAudio({ account, chatId, fileKey });
        if (mid) {
          recordSentMessage(chatId, mid, "[audio]");
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              messageId: mid,
              senderId: account.appId,
              buffer: media.buffer,
              contentType: media.contentType,
              fileName,
              defaultBaseName: "sent-audio",
              log,
            });
          } catch (err) {
            log?.error(`[${account.accountId}] sent audio archive failed: ${String(err)}`);
          }
        }
        setStatus({ lastOutboundAt: Date.now() });
      } else if (isVideo) {
        const fileName = url.split("/").pop()?.split("?")[0] ?? `video-${Date.now()}.mp4`;
        const fileKey = await uploadFeishuFile({ account, buffer: media.buffer, fileName });
        const mid = await sendFeishuVideo({ account, chatId, fileKey });
        if (mid) {
          recordSentMessage(chatId, mid, "[video]");
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              messageId: mid,
              senderId: account.appId,
              buffer: media.buffer,
              contentType: media.contentType,
              fileName,
              defaultBaseName: "sent-video",
              log,
            });
          } catch (err) {
            log?.error(`[${account.accountId}] sent video archive failed: ${String(err)}`);
          }
        }
        setStatus({ lastOutboundAt: Date.now() });
      } else if (isImage) {
        const fileName = url.split("/").pop()?.split("?")[0] ?? `image-${Date.now()}.png`;
        const imageKey = await uploadFeishuImage({ account, buffer: media.buffer });
        const mid = await sendFeishuImage({ account, chatId, imageKey });
        if (mid) {
          recordSentMessage(chatId, mid, "[image]");
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              messageId: mid,
              senderId: account.appId,
              buffer: media.buffer,
              contentType: media.contentType,
              fileName,
              defaultBaseName: "sent-image",
              log,
            });
          } catch (err) {
            log?.error(`[${account.accountId}] sent image archive failed: ${String(err)}`);
          }
        }
        setStatus({ lastOutboundAt: Date.now() });
      } else {
        const fileName = url.split("/").pop()?.split("?")[0] ?? `file-${Date.now()}`;
        const fileKey = await uploadFeishuFile({ account, buffer: media.buffer, fileName });
        const mid = await sendFeishuFile({ account, chatId, fileKey });
        if (mid) {
          recordSentMessage(chatId, mid, `[file: ${fileName}]`);
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              messageId: mid,
              senderId: account.appId,
              buffer: media.buffer,
              contentType: media.contentType,
              fileName,
              defaultBaseName: "sent-file",
              log,
            });
          } catch (err) {
            log?.error(`[${account.accountId}] sent file archive failed: ${String(err)}`);
          }
        }
        setStatus({ lastOutboundAt: Date.now() });
      }
    } catch (err) {
      log?.error(`Feishu media send failed for ${rawUrl}: ${String(err)}`);
      // Fallback: send URL as text.
      try {
        await sendFeishuText({ account, chatId, text: `[media] ${rawUrl}` });
      } catch {
        /* ignore fallback error */
      }
    }
  }

  if (payload.text) {
    const chunkLimit = 4000;
    const chunkMode = core.channel.text.resolveChunkMode(config, "feishu", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (let ci = 0; ci < chunks.length; ci++) {
      try {
        let sentMsgId: string | undefined;
        if (isGroup && replyToMessageId && ci === 0) {
          sentMsgId = await sendFeishuReply({
            account,
            messageId: replyToMessageId,
            text: chunks[ci],
          });
        } else {
          sentMsgId = await sendFeishuRichText({ account, chatId, text: chunks[ci] });
        }
        if (sentMsgId) recordSentMessage(chatId, sentMsgId, chunks[ci]);
        setStatus({ lastOutboundAt: Date.now() });
      } catch (err) {
        log?.error(`Feishu send failed: ${String(err)}`);
      }
    }
  }
}
