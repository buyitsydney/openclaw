/**
 * Feishu Gateway: WebSocket long connection for receiving messages.
 *
 * Uses @larksuiteoapi/node-sdk WSClient to establish a persistent connection
 * to Feishu servers. Received messages are forwarded to OpenClaw's auto-reply pipeline.
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  extractReasoningDirective,
  type ReasoningLevel,
} from "../../../src/auto-reply/reply/directives.js";
import { normalizeReasoningLevel } from "../../../src/auto-reply/thinking.js";
import { readSessionStoreJson5 } from "../../../src/infra/state-migrations.fs.js";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { resolveGroupOwnerIds } from "./accounts.js";
import { buildDriveFileContextFromText } from "./drive-file-read.js";
import {
  applyFeishuKnownBotDisplayName,
  buildFeishuActorFromApiSender,
  buildFeishuBotActorFromAccount,
  buildFeishuActorFromEventSender,
  buildFeishuTextPayload,
  formatFeishuActorLabel,
  parseFeishuMentions,
  parseFeishuInteractiveText,
  parseFeishuMessageContent,
  parseFeishuPostText,
  renderFeishuQuotedContext,
  renderFeishuQuotedReplyBody,
  renderFeishuRecentContextLine,
  renderFeishuTextWithMentions,
  resolveFeishuMessageActors,
  stripFeishuStatusFooter,
  type FeishuActorRef,
  type FeishuMentionRef,
  type FeishuTextPayload,
} from "./feishu-message.js";
import {
  archiveGroupMessage,
  archiveSentFeishuBinaryMessage,
  archiveSentFeishuTextMessage,
  loadArchiveEntries,
  normalizeArchiveEntry,
} from "./group-archive.js";
import { formatFeishuAtText } from "./mention-text.js";
import {
  expandFetchedMessageItem,
  expandMergeForwardMessage,
  type FeishuFetchedMessageItem,
} from "./merge-forward.js";
import { buildFeishuReplyRef, buildFeishuReplyRefFromSentMessage } from "./message-metadata.js";
import { cacheMessageText, getCachedMessageText } from "./message-text-cache.js";
import { rewriteModelShortcutCommand } from "./model-shortcuts.js";
import {
  callFeishuApiWithUserToken,
  downloadFeishuMessageResourceWithUserToken,
  getValidUserTokenForOpenId,
} from "./oauth.js";
import {
  getFeishuClient,
  sendFeishuText,
  sendFeishuRichText,
  sendFeishuRichTextDetailed,
  sendFeishuReplyDetailed,
  createFeishuCardStream,
  formatFeishuUserFacingText,
  uploadFeishuImage,
  sendFeishuImageDetailed,
  uploadFeishuAudio,
  sendFeishuAudioDetailed,
  uploadFeishuFile,
  sendFeishuFileDetailed,
  sendFeishuVideoDetailed,
  downloadFeishuImage,
  downloadFeishuFile,
  getFeishuChatName,
  addFeishuReaction,
  removeFeishuReaction,
  type FeishuCardStream,
} from "./outbound.js";
import { getFeishuRuntime } from "./runtime.js";
import { recordSentMessage } from "./sent-message-log.js";
import {
  accumulateGroupedReplyText,
  buildFeishuStatusFooter,
  finalizeGroupedReplyText,
} from "./status-footer.js";
import { callChatApi } from "./tools/chat-api.js";
import { fetchChatHistory, getTenantAccessToken } from "./tools/chat-history.js";

const MERGE_FORWARD_DISABLED_TEXT = "[merged forward disabled]";

// ── Group mode resolution ─────────────────────────────────────────────────
/**
 * Read per-group mode from {workspace}/group-modes/{chatId}.json.
 * Returns the mode string ("default", "auto-reply", "disabled", "monitor", "manager")
 * or "default" if the file doesn't exist or is invalid.
 */
function readGroupMode(chatId: string): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    join(homedir(), ".openclaw");
  const filePath = join(stateDir, "workspace", "group-modes", `${chatId}.json`);
  if (!existsSync(filePath)) {
    return "default";
  }
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (typeof data?.mode === "string" && data.mode.trim()) {
      return data.mode.trim();
    }
    return "default";
  } catch {
    return "default";
  }
}

// ── Manager mode rate limiter (sliding window) ───────────────────────────
const groupReplyTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds
const RATE_LIMIT_MAX_REPLIES = 5;

/** Record a reply sent by this bot in a group. */
export function recordGroupReply(chatId: string): void {
  const now = Date.now();
  const timestamps = groupReplyTimestamps.get(chatId) ?? [];
  timestamps.push(now);
  groupReplyTimestamps.set(chatId, timestamps);
}

/** Check if this bot has exceeded the reply rate limit for a group. */
function isRateLimited(chatId: string): boolean {
  const now = Date.now();
  const timestamps = groupReplyTimestamps.get(chatId);
  if (!timestamps) return false;
  // Prune old entries outside the window
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  groupReplyTimestamps.set(chatId, recent);
  return recent.length >= RATE_LIMIT_MAX_REPLIES;
}

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

const HER_DEFAULT_REASONING: ReasoningLevel = "stream";

function resolveEffectiveReasoningMode(params: {
  cleanText: string;
  storePath: string;
  sessionKey: string;
}): ReasoningLevel {
  const inlineReasoning = extractReasoningDirective(params.cleanText).reasoningLevel;
  if (inlineReasoning) {
    return inlineReasoning;
  }

  const { store } = readSessionStoreJson5(params.storePath);
  const persistedRaw = store[params.sessionKey]?.reasoningLevel;
  const persistedReasoning =
    typeof persistedRaw === "string" ? normalizeReasoningLevel(persistedRaw) : undefined;

  // Pre-seed default so upstream directive handling also sees it
  // (upstream defaults to "off" when reasoningLevel is absent).
  if (!persistedReasoning && store[params.sessionKey]) {
    store[params.sessionKey].reasoningLevel = HER_DEFAULT_REASONING;
    try {
      writeFileSync(params.storePath, JSON.stringify(store, null, 2));
    } catch {
      // best-effort; upstream will still get the correct value next time
    }
  }

  return persistedReasoning ?? HER_DEFAULT_REASONING;
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

// ── Quoted message content retrieval (im.message.get) ───────────────────
// When a user replies to a message, Feishu sends parent_id (the quoted msg).
// We fetch its content so the AI has the full context of what was quoted.

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  sender: FeishuActorRef;
  content: string;
  textParts: FeishuTextPayload;
  contentType: string;
  attachments: Array<{ kind: string; imageKey?: string }>;
  /** Image keys found in the quoted message (for downstream download). */
  imageKeys?: string[];
};

type MergeForwardSourceAccess = {
  fetchItems: (messageId: string) => Promise<FeishuFetchedMessageItem[]>;
  downloadFile: (params: {
    messageId: string;
    fileKey: string;
  }) => Promise<{ buffer: Buffer; contentType?: string } | null>;
  downloadImage: (params: {
    messageId: string;
    imageKey: string;
  }) => Promise<{ buffer: Buffer; contentType?: string } | null>;
};

function isUserTokenMessageGetUnsupported(
  code: number | undefined,
  msg: string | undefined,
): boolean {
  return code === 230001 && /not supported/i.test(msg ?? "");
}

async function fetchMessageItemsViaBotClient(
  account: ResolvedFeishuAccount,
  messageId: string,
): Promise<FeishuFetchedMessageItem[]> {
  const client = getFeishuClient(account);
  const response = (await client.im.message.get({
    path: { message_id: messageId },
    params: { user_id_type: "open_id" },
  })) as {
    code?: number;
    msg?: string;
    data?: { items?: FeishuFetchedMessageItem[] };
  };
  if (response.code !== 0) {
    throw new Error(
      `message.get failed: code=${response.code ?? "unknown"} msg=${response.msg ?? ""}`,
    );
  }
  return Array.isArray(response.data?.items) ? response.data.items : [];
}

async function fetchCanonicalMessageItem(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  log?: ChannelLogSink;
}): Promise<FeishuFetchedMessageItem | null> {
  try {
    const items = await fetchMessageItemsViaBotClient(params.account, params.messageId);
    return items[0] ?? null;
  } catch (err) {
    params.log?.error(
      `[${params.account.accountId}] message.get canonicalization failed for ${params.messageId}: ${String(err)}`,
    );
    return null;
  }
}

async function buildMergeForwardSourceAccess(params: {
  account: ResolvedFeishuAccount;
  senderOpenId: string;
  log?: ChannelLogSink;
}): Promise<MergeForwardSourceAccess | undefined> {
  if (!params.senderOpenId) return undefined;
  const token = await getValidUserTokenForOpenId(params.account, params.senderOpenId);
  if (!token) {
    params.log?.info?.(
      `[${params.account.accountId}] no user token for merge_forward source recovery: ${params.senderOpenId}`,
    );
    return undefined;
  }
  return {
    fetchItems: async (messageId: string) => {
      const response = await callFeishuApiWithUserToken<{ items: unknown[] }>({
        method: "GET",
        endpoint: `/im/v1/messages/${messageId}`,
        userToken: token.access_token,
        query: { user_id_type: "open_id" },
      });
      if (response.code === 0) {
        return (response.data?.items ?? []) as FeishuFetchedMessageItem[];
      }
      if (isUserTokenMessageGetUnsupported(response.code, response.msg)) {
        return fetchMessageItemsViaBotClient(params.account, messageId);
      }
      throw new Error(
        `user-token message.get failed: code=${response.code ?? "unknown"} msg=${response.msg ?? ""}`,
      );
    },
    downloadFile: ({ messageId, fileKey }) =>
      downloadFeishuMessageResourceWithUserToken({
        userToken: token.access_token,
        messageId,
        fileKey,
        type: "file",
      }),
    downloadImage: ({ messageId, imageKey }) =>
      downloadFeishuMessageResourceWithUserToken({
        userToken: token.access_token,
        messageId,
        fileKey: imageKey,
        type: "image",
      }),
  };
}

async function getQuotedMessageContent(params: {
  account: ResolvedFeishuAccount;
  parentMessageId: string;
  currentChatId?: string;
  log?: ChannelLogSink;
  mergeForwardSourceAccess?: MergeForwardSourceAccess;
}): Promise<FeishuMessageInfo | null> {
  const { account, parentMessageId, log } = params;
  const archivedQuotedEntry =
    params.currentChatId?.startsWith("oc_") && params.currentChatId
      ? loadArchiveEntries(params.currentChatId).get(parentMessageId)
      : undefined;
  const archivedQuoted = archivedQuotedEntry ? normalizeArchiveEntry(archivedQuotedEntry) : null;
  try {
    const client = getFeishuClient(account);
    const response = (await client.im.message.get({
      path: { message_id: parentMessageId },
      params: { user_id_type: "open_id" },
    })) as {
      code?: number;
      data?: { items?: FeishuFetchedMessageItem[] };
    };
    if (response?.code !== 0) return null;
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    const item = items[0];
    if (!item) return null;
    let msgType = item.msg_type ?? "text";
    let parsedContent = parseFeishuMessageContent({
      content: item.body?.content ?? "",
      msgType,
    });
    if (msgType === "interactive") {
      loadCardCacheFromDisk();
      const cachedText =
        cardTextCache.get(parentMessageId)?.text ??
        getCachedMessageText(parentMessageId) ??
        (archivedQuoted?.textParts?.withoutFooter || archivedQuoted?.text || undefined);
      if (cachedText) {
        parsedContent = {
          ...parsedContent,
          rawText: cachedText,
          text: buildFeishuTextPayload(cachedText),
          attachments: [],
          imageKeys: [],
        };
        log?.info(`[${account.accountId}] quoted interactive msg resolved from cache/archive`);
      } else {
        parsedContent = {
          ...parsedContent,
          attachments: [],
          imageKeys: [],
        };
        log?.info(`[${account.accountId}] quoted interactive msg fallback parse (cache miss)`);
      }
    } else if (
      msgType === "file" ||
      msgType === "audio" ||
      msgType === "media" ||
      msgType === "video"
    ) {
      const expanded = await expandFetchedMessageItem({ account, item, log });
      if (expanded.text) {
        parsedContent = {
          ...parsedContent,
          rawText: expanded.text,
          text: buildFeishuTextPayload(expanded.text),
          coverage: expanded.coverage,
        };
      }
    }
    let sender = buildFeishuActorFromApiSender(item.sender);
    let mentionsResolved = parseFeishuMentions((item as { mentions?: unknown }).mentions);
    const chatId = item.chat_id ?? "";
    const resolvedActors = await resolveFeishuMessageActors({
      account,
      sender,
      mentions: mentionsResolved,
      chatId,
      log,
    });
    sender = resolvedActors.sender;
    mentionsResolved = resolvedActors.mentions;
    if (archivedQuoted) {
      if (archivedQuoted.actor) {
        sender = applyFeishuKnownBotDisplayName(archivedQuoted.actor, account);
      }
      if (archivedQuoted.mentions?.length) {
        mentionsResolved = parseFeishuMentions(
          archivedQuoted.mentions.map((mention) => ({
            key: mention.key,
            id: mention.id,
            name: mention.name,
          })),
        );
      }
      if (archivedQuoted.attachments) {
        parsedContent = {
          ...parsedContent,
          attachments: archivedQuoted.attachments.map((attachment) => ({ ...attachment })),
          imageKeys: archivedQuoted.attachments
            .map((attachment) => attachment.imageKey)
            .filter((imageKey): imageKey is string => Boolean(imageKey)),
        };
      }
      if (archivedQuoted.textParts) {
        parsedContent = {
          ...parsedContent,
          rawText: archivedQuoted.textParts.raw || archivedQuoted.text,
          text: archivedQuoted.textParts,
        };
      }
      if (archivedQuoted.messageType) {
        msgType = archivedQuoted.messageType;
      }
    }
    const content = renderFeishuTextWithMentions({
      text: parsedContent.text.withoutFooter,
      mentions: mentionsResolved,
    });
    const quotedImageKeys = parsedContent.attachments
      .filter((attachment) => attachment.kind === "image" || attachment.kind === "post_image")
      .map((attachment) => attachment.imageKey)
      .filter((imageKey): imageKey is string => Boolean(imageKey));
    return {
      messageId: item.message_id ?? parentMessageId,
      chatId,
      sender,
      content,
      textParts: {
        ...parsedContent.text,
        normalized: content,
        withoutFooter: content,
      },
      contentType: msgType,
      attachments: parsedContent.attachments.map((attachment) => ({
        kind: attachment.kind,
        ...(attachment.imageKey && { imageKey: attachment.imageKey }),
      })),
      imageKeys: quotedImageKeys.length > 0 ? quotedImageKeys : undefined,
    };
  } catch (err) {
    if (archivedQuoted) {
      return {
        messageId: archivedQuoted.msgId || parentMessageId,
        chatId: params.currentChatId ?? "",
        sender: applyFeishuKnownBotDisplayName(
          archivedQuoted.actor ?? buildFeishuActorFromApiSender({ id: archivedQuoted.senderId }),
          account,
        ),
        content: archivedQuoted.textParts?.withoutFooter || archivedQuoted.text,
        textParts: archivedQuoted.textParts ?? buildFeishuTextPayload(archivedQuoted.text),
        contentType: archivedQuoted.messageType ?? "text",
        attachments: archivedQuoted.attachments ?? [],
      };
    }
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
  return token ? `${base}#token=${token}` : base;
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
  const parsedContent = parseFeishuPostText(parsed, {
    imagePlaceholder: "<media:image>",
    mediaPlaceholder: "[video]",
  });
  if (imageKeys) imageKeys.push(...parsedContent.imageKeys);
  if (fileInfo) fileInfo.push(...parsedContent.fileInfo);
  return parsedContent.text.withoutFooter || null;
}

/** Extract text from an interactive (card) message's degraded body.
 *  When fetched via im.message.get, CardKit cards are returned in a legacy format:
 *  { title?, elements: [[{tag,text,...}, ...], ...] }
 *  We extract text/link content and collect image keys.
 *  Returns null if the structure is unrecognisable (caller falls back to raw content). */
// oxlint-disable-next-line typescript/no-explicit-any
function flattenInteractiveBody(parsed: any, imageKeys?: string[]): string | null {
  const parsedContent = parseFeishuInteractiveText(parsed, {
    imagePlaceholder: "<media:image>",
  });
  if (imageKeys) imageKeys.push(...parsedContent.imageKeys);
  if (parsedContent.coverage === "none") {
    return null;
  }
  return parsedContent.text.withoutFooter || null;
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
  const parsedContent = parseFeishuMessageContent({
    content,
    msgType,
    imagePlaceholder: "<media:image>",
    mediaPlaceholder: "[video]",
  });
  if (imageKeys) imageKeys.push(...parsedContent.imageKeys);
  if (fileInfo) fileInfo.push(...parsedContent.fileInfo);
  if (msgType === "image" || msgType === "file" || msgType === "media" || msgType === "audio") {
    return null;
  }
  return parsedContent.text.withoutFooter || null;
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
      void handleInboundMessage(data, { account, config, abortSignal, log, setStatus, core }).catch(
        (err) => {
          log?.error(`[${account.accountId}] error handling message: ${String(err)}`);
        },
      );
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
  return parseFeishuMentions(message?.mentions).map((mention) => ({
    key: mention.key,
    id: mention.actor.canonicalId,
    name: mention.name,
  }));
}

function stripInjectedStatusFooter(text: string): string {
  return stripFeishuStatusFooter(text);
}

type FeishuBotIdentityPromptAccount = Pick<
  ResolvedFeishuAccount,
  "appId" | "accountId" | "name" | "knownBots" | "knownBotOpenIds" | "botOpenId"
>;

function resolveBotOpenIdForPrompt(
  account: FeishuBotIdentityPromptAccount,
  appId: string,
): string | undefined {
  const normalizedAppId = appId.trim();
  if (!normalizedAppId) {
    return undefined;
  }
  if (normalizedAppId === account.appId) {
    const selfBotOpenId = account.botOpenId?.trim();
    return selfBotOpenId || undefined;
  }
  for (const [openId, mappedAppId] of Object.entries(account.knownBotOpenIds ?? {})) {
    if (mappedAppId.trim() !== normalizedAppId) {
      continue;
    }
    const normalizedOpenId = openId.trim();
    if (normalizedOpenId) {
      return normalizedOpenId;
    }
  }
  return undefined;
}

type FeishuKnownBotPromptTarget = {
  name: string;
  appId: string;
  openId?: string;
};

function listKnownBotPromptTargets(
  account: FeishuBotIdentityPromptAccount,
): FeishuKnownBotPromptTarget[] {
  const selfLabel = account.name || account.accountId;
  const targets: FeishuKnownBotPromptTarget[] = [
    {
      name: selfLabel,
      appId: account.appId,
      openId: account.botOpenId?.trim() || undefined,
    },
  ];
  for (const [appId, name] of Object.entries(account.knownBots)) {
    if (appId === account.appId) {
      continue;
    }
    targets.push({
      name,
      appId,
      openId: resolveBotOpenIdForPrompt(account, appId),
    });
  }
  return targets;
}

type FeishuBotIdentityPromptOptions = {
  focusText?: string;
  maxOtherBots?: number;
};

function normalizeFeishuBotPromptFocus(text?: string): string {
  return text?.trim().toLowerCase() || "";
}

function matchesFeishuBotPromptFocus(
  bot: FeishuKnownBotPromptTarget,
  normalizedFocus: string,
): boolean {
  if (!normalizedFocus) {
    return false;
  }
  for (const candidate of [bot.name, bot.appId, bot.openId]) {
    const normalizedCandidate = candidate?.trim().toLowerCase();
    if (normalizedCandidate && normalizedFocus.includes(normalizedCandidate)) {
      return true;
    }
  }
  return false;
}

function selectFeishuBotPromptTargets(
  account: FeishuBotIdentityPromptAccount,
  options?: FeishuBotIdentityPromptOptions,
): FeishuKnownBotPromptTarget[] {
  const [selfBot, ...otherBots] = listKnownBotPromptTargets(account);
  const normalizedFocus = normalizeFeishuBotPromptFocus(options?.focusText);
  const maxOtherBots = Math.max(0, options?.maxOtherBots ?? 8);
  const focusedBots = normalizedFocus
    ? otherBots.filter((bot) => matchesFeishuBotPromptFocus(bot, normalizedFocus))
    : [];
  return selfBot
    ? [selfBot, ...focusedBots.slice(0, maxOtherBots)]
    : focusedBots.slice(0, maxOtherBots);
}

export function buildFeishuBotIdentityBlock(
  account: FeishuBotIdentityPromptAccount,
  options?: FeishuBotIdentityPromptOptions,
): string {
  const lines: string[] = ["[Bot Identity]"];
  const [selfBot, ...otherBots] = selectFeishuBotPromptTargets(account, options);
  if (selfBot) {
    lines.push(
      `你是: ${selfBot.name} (app_id=${selfBot.appId}${selfBot.openId ? `, bot_open_id=${selfBot.openId}` : ""})`,
    );
  }
  if (otherBots.length > 0) {
    lines.push("系统中的其他 bot:");
    for (const bot of otherBots) {
      lines.push(
        `- ${bot.name} (app_id=${bot.appId}${bot.openId ? `, bot_open_id=${bot.openId}` : ""})`,
      );
    }
  }
  lines.push('规则: app_id 只用于稳定识别 bot 身份，不可直接填进 <at user_id="...">。');
  lines.push(
    "如果你要在群里真正艾特某个 bot，必须使用它的 bot_open_id（也是 open_id，形如 ou_xxx）。",
  );
  lines.push(
    "消息里的 sender/mentions 可能出现 app_id 或 open_id；识别 bot 看 app_id，真正构造 @ 看 open_id。",
  );
  lines.push("[End Bot Identity]", "");
  return lines.join("\n");
}

export function buildCurrentGroupReplyRuleText(params: {
  senderId: string;
  senderDisplayName?: string;
  account: FeishuBotIdentityPromptAccount;
  focusText?: string;
}): string {
  const senderName = params.senderDisplayName?.trim() || params.senderId;
  const peerBotLines = selectFeishuBotPromptTargets(params.account, {
    focusText: params.focusText,
  })
    .filter((bot) => bot.appId !== params.account.appId && bot.openId)
    .map(
      (bot) =>
        `- ${bot.name}: <at user_id="${bot.openId}">${bot.name}</at> (bot_open_id=${bot.openId}, app_id=${bot.appId})`,
    );
  return [
    "[当前群聊回复规则]",
    `你当前正在回复的人：${senderName}（open_id=${params.senderId}）。`,
    `如果你需要真正艾特他，只能使用这个精确格式：<at user_id="${params.senderId}">${senderName}</at>`,
    '如果你需要真正艾特某个 bot，只能使用它的 bot_open_id；绝对不要把 app_id 填进 <at user_id="...">。',
    ...(peerBotLines.length > 0 ? ["已知 peer bot 的正确艾特格式：", ...peerBotLines] : []),
    "绝对不要输出 @_user_N、ou_xxx、cli_xxx 作为艾特。",
    "@_user_N 只属于入站消息里的占位符，不能复制到出站回复。",
    "下面的聊天记录只是历史记录，不代表你本轮该如何构造 mention。",
    "",
  ].join("\n");
}

// ── Inbound message processing ──────────────────────────────────────────

type InboundDeps = {
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
  core: ReturnType<typeof getFeishuRuntime>;
};

export function buildFeishuGroupSessionMetaResolution(chatId: string, isGroup: boolean) {
  if (!isGroup) {
    return undefined;
  }
  const normalizedChatId = chatId.trim().toLowerCase();
  if (!normalizedChatId) {
    return undefined;
  }
  return {
    key: `feishu:group:${normalizedChatId}`,
    channel: "feishu",
    id: normalizedChatId,
    chatType: "group" as const,
  };
}

export function buildFeishuInboundIdentity(params: {
  senderId: string;
  chatId: string;
  isGroup: boolean;
  groupName?: string;
}) {
  // Group context must be anchored to the canonical chat_id, never the current sender.
  const canonicalGroupLabel = params.isGroup
    ? params.groupName?.trim() || params.chatId.trim() || undefined
    : undefined;
  return {
    From: `feishu:${params.senderId}`,
    To: `feishu:${params.chatId}`,
    ChatType: params.isGroup ? ("group" as const) : ("direct" as const),
    ConversationLabel: params.isGroup ? canonicalGroupLabel : params.senderId,
    GroupSubject: canonicalGroupLabel,
    OriginatingTo: `feishu:${params.chatId}`,
    groupResolution: buildFeishuGroupSessionMetaResolution(params.chatId, params.isGroup),
  };
}

// oxlint-disable-next-line typescript/no-explicit-any
async function handleInboundMessage(data: any, deps: InboundDeps): Promise<void> {
  const { account, config, abortSignal, log, setStatus, core } = deps;
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

  const isBotSender = senderType === "bot";
  const isGroup = chatType === "group";

  // For group chats, bot messages still need archiving + pending history buffering
  // so other bots' replies are visible in injected context.
  // For DMs, skip bot messages entirely (no self-reply loops).
  if (isBotSender && !isGroup) return;

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
  const mergeForwardSourceAccess =
    msgType === "merge_forward" || Boolean(parentId)
      ? await buildMergeForwardSourceAccess({
          account,
          senderOpenId: senderId,
          log,
        })
      : undefined;
  let rawText = extractTextContent(content, msgType, imageKeys, fileInfo);
  const currentMessageAttachments = parseFeishuMessageContent({
    content,
    msgType,
    imagePlaceholder: "<media:image>",
    mediaPlaceholder: "[video]",
  }).attachments;
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  if (msgType === "merge_forward" && messageId) {
    try {
      const expanded = await expandMergeForwardMessage({
        account,
        messageId,
        log,
        fetchItems: mergeForwardSourceAccess?.fetchItems,
        downloadFile: mergeForwardSourceAccess?.downloadFile,
        downloadImage: mergeForwardSourceAccess?.downloadImage,
      });
      if (expanded.text) {
        rawText = expanded.text;
        log?.info(`[${account.accountId}] merge_forward expanded for inbound msg ${messageId}`);
      } else {
        rawText = "[合并转发消息 — 无法展开子消息]";
      }
      // Attach downloaded media files (images go to vision pipeline, others as file paths)
      if (expanded.mediaFiles) {
        for (const mf of expanded.mediaFiles) {
          if (mf.type === "image") {
            mediaPaths.push(mf.localPath);
            mediaTypes.push(mf.contentType);
            log?.info(`[${account.accountId}] merge_forward image attached: ${mf.localPath}`);
          }
          // audio/file/video: already referenced in text via [type: ... → saved: path]
        }
      }
    } catch (err) {
      log?.info(
        `[${account.accountId}] merge_forward expansion failed for ${messageId}: ${String(err)}`,
      );
      rawText = "[合并转发消息 — 展开失败]";
    }
  }

  // ── Download images (standalone image msgs + images embedded in post) ──
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  // NOTE: mediaPaths/mediaTypes declared above merge_forward block (merge_forward may push to them)
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

  // Keep file handling deterministic and non-blocking: save every attachment
  // locally, then hand the path to the agent instead of pre-parsing Office.
  const fallbackParts: string[] = [];

  if (fileInfo.length > 0) {
    let savedIdx = imageKeys.length;
    for (const fi of fileInfo) {
      const savedPath = mediaPaths[savedIdx];
      if (!savedPath) continue;
      savedIdx++;
      fallbackParts.push(`${fi.fileName} saved at ${savedPath}`);
    }
    for (const e of fileErrors) {
      fallbackParts.push(`${e.name} (${e.reason})`);
    }
  }

  // Build the final file placeholder as deterministic local paths only.
  const filePlaceholder = fallbackParts.length > 0 ? `[file: ${fallbackParts.join("; ")}]` : null;

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
  if (messageId && cleanText) {
    cacheMessageText(messageId, cleanText);
  }
  const driveFileContextFromCurrentText = cleanText
    ? await buildDriveFileContextFromText({
        account,
        text: cleanText,
      })
    : "";
  const effectiveCleanText = driveFileContextFromCurrentText
    ? `${cleanText}\n${driveFileContextFromCurrentText}`
    : cleanText;

  // Allow through if: has text, is a reply (quoted msg context will be injected),
  // or is a group @mention (bot will respond based on context).
  // Only drop truly empty non-reply, non-mention messages.
  if (!cleanText && !parentId && !isGroup) return;

  log?.info(
    `[${account.accountId}] inbound: chat=${chatId} from=${senderId} type=${chatType}${mediaPath ? (isAudioMedia ? " +audio" : " +image") : ""}`,
  );
  setStatus({ lastInboundAt: Date.now() });
  const shouldCanonicalizeCurrentMessage = Boolean(
    messageId &&
    (isGroup || parentId || (Array.isArray(message?.mentions) && message.mentions.length > 0)),
  );
  const canonicalCurrentMessage =
    shouldCanonicalizeCurrentMessage && messageId
      ? await fetchCanonicalMessageItem({ account, messageId, log })
      : null;
  let currentMessageMentionsResolved = parseFeishuMentions(
    canonicalCurrentMessage?.mentions ?? message?.mentions,
  );
  let currentMessageActor = applyFeishuKnownBotDisplayName(
    buildFeishuActorFromEventSender(sender),
    account,
  );
  let senderDisplayName: string | undefined;
  try {
    const nameResult = await resolveFeishuSenderName({ account, senderOpenId: senderId, log });
    senderDisplayName = nameResult.name;
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
    currentMessageActor = {
      ...currentMessageActor,
      displayName: senderDisplayName,
      resolutionSource: "directory",
      resolved: true,
    };
    log?.info(`[${account.accountId}] sender resolved: ${senderId} -> ${senderDisplayName}`);
  }
  const currentMessageArchiveText = renderFeishuTextWithMentions({
    text: buildFeishuTextPayload(textFromMessage).withoutFooter,
    mentions: currentMessageMentionsResolved,
  });
  const currentMessageParentId = canonicalCurrentMessage?.parent_id ?? parentId;
  const currentMessageRootId = canonicalCurrentMessage?.root_id ?? message.root_id ?? "";
  const currentMessageThreadId = canonicalCurrentMessage?.thread_id ?? message.thread_id ?? "";
  const currentMessageReply = buildFeishuReplyRef({
    parentId: currentMessageParentId,
    rootId: currentMessageRootId,
    threadId: currentMessageThreadId,
    hasThread: Boolean(currentMessageThreadId),
  });
  if (messageId && currentMessageArchiveText) {
    cacheMessageText(messageId, currentMessageArchiveText);
  }
  let groupChatName: string | undefined;
  let currentGroupMentions: FeishuMention[] = [];
  const isCommand = cleanText.startsWith("/");
  const ACK_EMOJI = "Get";
  let ackReactionId: string | null = null;
  const addAckReaction = async () => {
    if (isCommand) return;
    if (ackReactionId) return;
    try {
      ackReactionId = await addFeishuReaction({ account, messageId, emoji: ACK_EMOJI });
      if (ackReactionId) {
        log?.info(`[${account.accountId}] added ACK reaction (${ACK_EMOJI}) to ${messageId}`);
      }
    } catch (err) {
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

  // ── Group chat handling: archive + owner-only reply gating ──
  if (isGroup) {
    const groupConfig = account.config.groups;
    const groupsEnabled = groupConfig?.enabled === true;

    if (!groupsEnabled) {
      log?.info(`[${account.accountId}] group chat disabled, ignoring group message`);
      return;
    }

    try {
      const resolvedGroupName = await getFeishuChatName(account, chatId);
      groupChatName = resolvedGroupName?.trim() || undefined;
    } catch (err) {
      log?.info(
        `[${account.accountId}] failed to resolve group name for ${chatId}: ${String(err)}`,
      );
    }

    // Archive all group messages (regardless of who sent them).
    const shouldArchive = groupConfig?.archive !== false;
    if (shouldArchive) {
      const senderName = formatFeishuActorLabel(currentMessageActor, { includeCanonicalId: false });
      try {
        archiveGroupMessage({
          chatId,
          chatName: groupChatName ?? null,
          senderId: currentMessageActor.canonicalId || senderId,
          senderName: senderName || senderId,
          text: currentMessageArchiveText || cleanText,
          msgId: messageId,
          actor: currentMessageActor,
          messageType: msgType,
          mentions: currentMessageMentionsResolved.map((mention) => ({
            key: mention.key,
            id: mention.actor.canonicalId,
            ...(mention.name && { name: mention.name }),
            renderedText: mention.renderedText,
          })),
          attachments: currentMessageAttachments,
          textParts: buildFeishuTextPayload(currentMessageArchiveText || cleanText),
          ...(currentMessageReply && { reply: currentMessageReply }),
        });
        log?.info(
          `[${account.accountId}] archived group msg from ${currentMessageActor.canonicalId || senderId} in ${chatId}`,
        );
      } catch (err) {
        log?.error(`[${account.accountId}] group archive failed: ${String(err)}`);
      }
    }

    // Parse @mentions to detect if bot was mentioned.
    const mentions = currentMessageMentionsResolved.map((mention) => ({
      key: mention.key,
      id: mention.actor.canonicalId,
      name: mention.name,
    }));
    currentGroupMentions = mentions;
    if (
      Array.isArray(message?.mentions) &&
      message.mentions.length > 0 &&
      !canonicalCurrentMessage
    ) {
      log?.error(
        `[${account.accountId}] skipping group mention routing for ${messageId} because canonical message data is unavailable`,
      );
      return;
    }
    const botAppId = account.appId;
    const botOpenId = account.botOpenId;
    const wasMentioned = Boolean(botAppId) && mentions.some((m) => m.id === botAppId);
    // isSelfBot: true if this message was sent by THIS bot (not other bots).
    const isSelfBot =
      isBotSender &&
      Boolean(botAppId) &&
      (senderId === botAppId || senderId === botOpenId);

    log?.info(
      `[${account.accountId}] group mention check: botAppId=${botAppId} mentions=${JSON.stringify(mentions.map((m) => ({ key: m.key, id: m.id, name: m.name })))} wasMentioned=${wasMentioned}`,
    );

    // Read per-group mode from workspace file (checked per-message, no restart needed).
    const groupMode = readGroupMode(chatId);

    if (groupMode === "disabled") {
      return;
    }

    if (groupMode === "monitor" || groupMode === "manager") {
      // Monitor/manager: ALL messages enter agent EXCEPT this bot's own messages.
      if (isSelfBot) {
        log?.info(`[${account.accountId}] ${groupMode} mode: self-bot msg, skipping`);
        return;
      }
      // Manager mode: rate limit to prevent storms
      if (groupMode === "manager" && isRateLimited(chatId)) {
        log?.warn(
          `[${account.accountId}] manager mode rate limited in ${chatId}, skipping`,
        );
        return;
      }
      log?.info(
        `[${account.accountId}] ${groupMode} mode: ${isBotSender ? "bot" : "human"} msg from ${senderId} in ${chatId}, processing`,
      );
      // Fall through to agent processing
    } else if (groupMode === "auto-reply") {
      // Auto-reply: only owner's messages, filter all bot messages.
      if (isBotSender) {
        log?.info(`[${account.accountId}] auto-reply mode: bot msg, archived only`);
        return;
      }
      const ownerIds = resolveGroupOwnerIds(account.config);
      const isOwner = ownerIds.length === 0 || ownerIds.includes(senderId);
      if (!isOwner) {
        log?.info(
          `[${account.accountId}] auto-reply mode: non-owner ${senderId}, archived only`,
        );
        return;
      }
      log?.info(
        `[${account.accountId}] auto-reply mode: owner ${senderId} in ${chatId}, processing`,
      );
      // Fall through to agent processing
    } else {
      // Default mode: require @mention + owner check.
      if (isBotSender) {
        log?.info(`[${account.accountId}] bot msg in group archived, skipping reply`);
        return;
      }
      if (!wasMentioned) {
        log?.info(`[${account.accountId}] group msg not mentioning bot, archived only`);
        return;
      }
      const ownerIds = resolveGroupOwnerIds(account.config);
      const isOwner = ownerIds.length === 0 || ownerIds.includes(senderId);
      if (!isOwner) {
        log?.info(
          `[${account.accountId}] non-owner ${senderId} @mentioned bot in group, ignoring`,
        );
        return;
      }
      log?.info(
        `[${account.accountId}] owner ${senderId} @mentioned bot in group, processing`,
      );
    }
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

  // Give the user immediate feedback before any slower context enrichment.
  await addAckReaction();

  // ── Fetch quoted message content (if this is a reply) ──
  let quotedContext = "";
  let quotedBodyForReply: string | undefined;
  if (parentId) {
    try {
      const quoted = await getQuotedMessageContent({
        account,
        parentMessageId: parentId,
        currentChatId: chatId,
        log,
        mergeForwardSourceAccess,
      });
      if (quoted?.content) {
        const quotedDriveFileContext = await buildDriveFileContextFromText({
          account,
          text: quoted.content,
        });
        quotedContext =
          `\n${renderFeishuQuotedContext({
            messageId: parentId,
            messageType: quoted.contentType,
            sender: quoted.sender,
            text: quoted.content.slice(0, 500),
          })}` + (quotedDriveFileContext ? `\n${quotedDriveFileContext}` : "");
        // Prefix with message_id so AI can extract it even in DMs where core strips reply_to_id.
        quotedBodyForReply = `${renderFeishuQuotedReplyBody({
          messageId: parentId,
          messageType: quoted.contentType,
          sender: quoted.sender,
          text: quoted.content.slice(0, 2000),
        })}${quotedDriveFileContext ? `\n${quotedDriveFileContext}` : ""}`;
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
  const enrichedBody = effectiveCleanText + quotedContext;
  const rawBody = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: enrichedFrom,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedBody,
  });

  // On @mention in group: fetch recent messages via API and inject into context.
  // Uses tenant_access_token (no user OAuth needed) for the /im/v1/messages API.
  // Aligns with upstream's 20-message default (DEFAULT_MESSAGE_LIMIT).
  const GROUP_INJECT_LIMIT = 20;
  let promptContextPrefix = buildFeishuBotIdentityBlock(account, {
    focusText: enrichedBody,
  });
  if (isGroup) {
    try {
      const token = await getTenantAccessToken(account);
      const now = Date.now();
      const result = await fetchChatHistory({
        account,
        token,
        chatId,
        startMs: now - 2 * 60 * 60 * 1000,
        endMs: now,
        limit: GROUP_INJECT_LIMIT,
      });
      if (result.messages.length > 0) {
        const chronological = [...result.messages].reverse();
        const lines = chronological.map((m) => {
          return renderFeishuRecentContextLine({
            messageId: m.message_id,
            chatId: m.chat_id,
            messageType: m.msg_type,
            createTime: m.create_time,
            createTimeMs: Number(m.create_time) || undefined,
            createTimeHuman: m.create_time_human,
            sender:
              m.sender_actor ??
              buildFeishuActorFromApiSender({
                id: m.sender_id,
                sender_type: m.sender_type,
              }),
            mentions:
              m.mentions_resolved ??
              parseFeishuMentions(m.mentions?.map((mention) => ({ ...mention, id: mention.id }))),
            attachments: m.attachments ?? [],
            text: m.text_parts ?? buildFeishuTextPayload(stripInjectedStatusFooter(m.text)),
            coverage: m.coverage,
            provenance: { sourcePath: "history_api", tokenMode: "tenant" },
          });
        });
        const promptFocusText = `${enrichedBody}\n${lines.join("\n")}`;
        const currentReplyRule = buildCurrentGroupReplyRuleText({
          account,
          senderId,
          senderDisplayName,
          focusText: promptFocusText,
        });
        const botIdentityBlock = buildFeishuBotIdentityBlock(account, {
          focusText: promptFocusText,
        });

        promptContextPrefix =
          botIdentityBlock +
          `[Chat messages since recent activity — ${lines.length} messages for context]\n` +
          `${lines.join("\n")}\n` +
          `[End of recent messages]\n\n` +
          `${currentReplyRule}\n`;
        log?.info(`[${account.accountId}] injected ${lines.length} recent group messages via API`);
      }
    } catch (err) {
      log?.error(`[${account.accountId}] failed to fetch recent group messages: ${String(err)}`);
    }
  }

  const inboundIdentity = buildFeishuInboundIdentity({
    senderId,
    chatId,
    isGroup,
    groupName: groupChatName,
  });

  // BodyForAgent is what the LLM actually sees (finalizeInboundContext prefers it
  // over CommandBody/RawBody/Body). Prepend group context to the full envelope
  // (rawBody) so the LLM gets bot identity in all Feishu contexts, and recent
  // group context when available.
  const bodyForAgent = promptContextPrefix ? `${promptContextPrefix}${rawBody}` : undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: rawBody,
    RawBody: cleanText,
    CommandBody: cleanText,
    ...(bodyForAgent && { BodyForAgent: bodyForAgent }),
    From: inboundIdentity.From,
    To: inboundIdentity.To,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: inboundIdentity.ChatType,
    ConversationLabel: inboundIdentity.ConversationLabel,
    GroupSubject: inboundIdentity.GroupSubject,
    SenderId: senderId,
    Provider: "feishu",
    Surface: "feishu",
    MessageSid: messageId,
    MessageSidFull: messageId,
    ReplyToId: parentId || messageId,
    ReplyToBody: quotedBodyForReply,
    OriginatingChannel: "feishu",
    OriginatingTo: inboundIdentity.OriginatingTo,
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
      groupResolution: inboundIdentity.groupResolution,
    })
    .catch((err) => {
      log?.error(`feishu: failed updating session meta: ${String(err)}`);
    });

  const effectiveReasoningMode = resolveEffectiveReasoningMode({
    cleanText,
    storePath,
    sessionKey: route.sessionKey,
  });
  // Card streaming is enabled for both private and group chats (V2 readback relies on local cache).
  // Disabled for commands (/new, /reset etc.) which have their own response flow,
  // and for reasoning=on mode which needs separate bubble delivery.
  const sharedCardStreamingEnabled = !isCommand && effectiveReasoningMode !== "on";

  // ── Card stream for typing / typewriter effect ──
  // Skip for commands (/new, /reset etc.) which have their own response flow.
  let cardStream: FeishuCardStream | undefined;

  // onReplyStart: create the card stream when the AI actually starts processing
  // (after session lane queuing — never fires for queued messages).
  const startCardStream = async () => {
    if (!sharedCardStreamingEnabled || cardStream) return;
    try {
      cardStream = await createFeishuCardStream({
        account,
        chatId,
        replyToMessageId: messageId,
        version: account.config.cardStreamVersion ?? "v1",
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
  let groupAccumulatedReplyToId: string | undefined;
  let cardStreamUpdateChain: Promise<void> = Promise.resolve();

  const queueCardStreamUpdate = (op: () => Promise<void> | void) => {
    const next = cardStreamUpdateChain.then(async () => {
      await op();
    });
    cardStreamUpdateChain = next.catch(() => {});
    return next;
  };

  const updateCardStream = (text?: string) =>
    queueCardStreamUpdate(() => {
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
    });

  const updateReasoningCardStream = (text?: string) =>
    queueCardStreamUpdate(async () => {
      if (!text || !cardStream?.started) return;
      // Flush reasoning immediately so the first visible card frame is the
      // reasoning preview, even if answer partials arrive in the same throttle window.
      cardStream.update(text);
      await cardStream.flush();
    });

  const stopCardStream = async () => {
    if (!cardStream?.started) return;
    await cardStreamUpdateChain;
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
    // Record group reply for manager mode rate limiting
    if (isGroup) recordGroupReply(chatId);
  };

  // Dispatch through the auto-reply pipeline and deliver response.
  // Strategy:
  // - reasoning=stream: onReasoningStream previews reasoning on the shared DM card.
  // - reasoning=off: onPartialReply drives the answer typewriter effect.
  // - reasoning=on: shared-card typewriter is disabled so final reasoning and answer
  //   keep their deterministic final-message order.
  // - deliver only accumulates final answer text for finalize; it does NOT update
  //   the card because live callbacks already streamed the visible content.
  //
  // Media dedup: when AI manually calls TTS, the tool result contains a MEDIA: path.
  // AI often echoes the same MEDIA: path in its final text reply. Without dedup,
  // the same audio gets uploaded+sent twice. This matches the pattern of
  // `filterMessagingToolDuplicates` (text dedup) in core reply-payloads.ts.
  // Preferred mode: tts.auto = "inbound" — system handles TTS, no AI echo, no dedup needed.
  const sentMediaUrls = new Set<string>();

  // Track whether deliver has fired so cleanup waits for lane-queued messages
  // whose deliver callback fires AFTER dispatchReplyWithBufferedBlockDispatcher
  // returns (fire-and-forget for queued messages).
  let deliverFired = false;
  let resolveDeliverGate: (() => void) | undefined;
  const deliverGate = new Promise<void>((r) => {
    resolveDeliverGate = r;
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        if (!deliverFired) {
          deliverFired = true;
          // Lazily ensure card stream + ACK exist for lane-queued messages
          // whose onReplyStart may have fired before the lane wait (and whose
          // handler cleanup already ran the first time dispatch returned).
          await Promise.all([addAckReaction(), startCardStream()]);
        }
        // Filter already-delivered media (same pattern as filterMessagingToolDuplicates for text).
        const rawMediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        const mediaUrls = rawMediaUrls.filter((u) => !sentMediaUrls.has(u));
        for (const u of mediaUrls) sentMediaUrls.add(u);
        const hasMedia = mediaUrls.length > 0;
        const skippedMedia = rawMediaUrls.length - mediaUrls.length;

        log?.info(
          `[${account.accountId}] deliver: kind=${info.kind} hasText=${!!payload.text} textLen=${payload.text?.length ?? 0} hasMedia=${hasMedia}${skippedMedia > 0 ? ` (skipped ${skippedMedia} duplicate media)` : ""}`,
        );

        const isReasoningPayload =
          payload.isReasoning === true ||
          (typeof payload.text === "string" &&
            info.kind === "block" &&
            payload.text.trimStart().startsWith("Reasoning:"));

        // Group chats without card stream: accumulate text and send as a single
        // message after the full turn completes, avoiding fragmented bubbles.
        if (isGroup && !cardStream?.started && payload.text && !isReasoningPayload) {
          const payloadReplyToId =
            typeof payload.replyToId === "string" ? payload.replyToId.trim() : "";
          if (payloadReplyToId && !groupAccumulatedReplyToId) {
            groupAccumulatedReplyToId = payloadReplyToId;
          }
          groupAccumulatedText = accumulateGroupedReplyText(groupAccumulatedText, payload.text);
          log?.info(
            `[${account.accountId}] deliver: group text accumulated (${groupAccumulatedText.length} chars total)`,
          );
          setStatus({ lastOutboundAt: Date.now() });
          if (hasMedia) {
            await deliverFeishuReply({
              payload: { mediaUrls, replyToId: payloadReplyToId || undefined },
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
          if (info.kind === "final") resolveDeliverGate?.();
          return;
        }

        if (cardStream?.started && payload.text) {
          const isVerboseTool = info.kind === "tool";

          log?.info(
            `[${account.accountId}] deliver: card-stream check: kind=${info.kind} isReasoning=${isReasoningPayload} isVerbose=${isVerboseTool} textPrefix="${payload.text.slice(0, 60).replace(/\n/g, "\\n")}"`,
          );

          if (!isReasoningPayload && !isVerboseTool) {
            cardStreamFinalText = cardStreamFinalText
              ? cardStreamFinalText + "\n\n" + payload.text
              : payload.text;
            log?.info(
              `[${account.accountId}] deliver: text accumulated for finalize (${cardStreamFinalText.length} chars total)`,
            );
            setStatus({ lastOutboundAt: Date.now() });

            if (hasMedia) {
              await deliverFeishuReply({
                payload: { mediaUrls, replyToId: payload.replyToId },
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
            if (info.kind === "final") resolveDeliverGate?.();
            return;
          }

          log?.info(
            `[${account.accountId}] deliver: bypassing card accumulation for ${isReasoningPayload ? "reasoning" : "verbose tool"} (kind=${info.kind})`,
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

        if (info.kind === "final") resolveDeliverGate?.();
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
      // For reasoning=on we intentionally skip shared-card typewriter updates so
      // the final reasoning payload can stay ahead of the final answer.
      disableBlockStreaming: !isCommand,
      onPartialReply: sharedCardStreamingEnabled
        ? (payload) => updateCardStream(payload.text)
        : undefined,
      onReasoningStream:
        sharedCardStreamingEnabled && effectiveReasoningMode === "stream"
          ? (payload) => updateReasoningCardStream(payload.text)
          : undefined,
      onReasoningEnd:
        sharedCardStreamingEnabled && effectiveReasoningMode === "stream"
          ? () => {
              // Shared-card reasoning preview is transient only; the next answer
              // partial or final payload naturally replaces it.
            }
          : undefined,
    },
  });

  // For lane-queued messages the dispatch may return before deliver fires.
  // Wait (with safety timeout) so cleanup doesn't race ahead of delivery.
  // Also bail out immediately when the gateway is shutting down (abort).
  if (!deliverFired) {
    const abortP = new Promise<void>((resolve) => {
      if (abortSignal.aborted) return resolve();
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([deliverGate, abortP, new Promise<void>((r) => setTimeout(r, 180_000))]);
  }

  // Group chats: flush accumulated text as a single post message.
  if (isGroup && groupAccumulatedText) {
    const footer = buildFeishuStatusFooter({ storePath, sessionKey: route.sessionKey, config });
    const finalGroupText = finalizeGroupedReplyText(groupAccumulatedText, footer);
    await deliverFeishuReply({
      payload: { text: finalGroupText, replyToId: groupAccumulatedReplyToId },
      account,
      chatId,
      isGroup,
      replyToMessageId: messageId,
      log,
      setStatus,
      config,
      core,
    });
    // Record group reply for manager mode rate limiting
    if (isGroup) recordGroupReply(chatId);
  }
  // Fallback: if deliver() never fired (timeout, error, or tool-only response),
  // reconstruct final text from the streaming partials that onPartialReply accumulated.
  if (cardStream?.started && !cardStreamFinalText && (cardStreamPrefix || cardStreamLastPartial)) {
    cardStreamFinalText = cardStreamPrefix
      ? cardStreamPrefix + "\n\n" + cardStreamLastPartial
      : cardStreamLastPartial;
    log?.info(
      `[${account.accountId}] cardStreamFinalText reconstructed from streaming partials (${cardStreamFinalText.length} chars)`,
    );
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
  // (v1 inline cards are mostly readable via im.message.get, but caching avoids formatting loss).
  if (cardStream?.started && cardStream.messageId && cardStreamFinalText) {
    cacheCardText(cardStream.messageId, cardStreamFinalText);
    cacheMessageText(cardStream.messageId, cardStreamFinalText);
    recordSentMessage(chatId, cardStream.messageId, cardStreamFinalText);

    // Archive bot-sent card in group message log so chat-history tool sees it.
    if (isGroup && account.config.groups?.archive !== false && cardStream.message) {
      const botActor: FeishuActorRef = buildFeishuBotActorFromAccount(account);
      archiveSentFeishuTextMessage({
        chatId,
        chatName: groupChatName ?? null,
        message: cardStream.message,
        senderId: account.appId,
        senderName: account.accountId,
        actor: botActor,
        text: cardStreamFinalText,
        textParts: buildFeishuTextPayload(cardStreamFinalText),
        reply:
          buildFeishuReplyRefFromSentMessage(cardStream.message) ??
          buildFeishuReplyRef({ parentId: messageId }),
      });
      log?.info(
        `[${account.accountId}] archived bot card stream msg ${cardStream.messageId} in ${chatId}`,
      );
    }
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
  const botActor = buildFeishuBotActorFromAccount(account);
  const payloadReplyToId = typeof payload.replyToId === "string" ? payload.replyToId.trim() : "";
  const effectiveReplyToMessageId = payloadReplyToId || replyToMessageId;
  const resolveReplyRef = (message: Parameters<typeof buildFeishuReplyRefFromSentMessage>[0]) =>
    buildFeishuReplyRefFromSentMessage(message) ??
    buildFeishuReplyRef({ parentId: effectiveReplyToMessageId });

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
        const sentMessage = await sendFeishuAudioDetailed({
          account,
          chatId,
          fileKey,
          replyToMessageId: effectiveReplyToMessageId,
        });
        if (sentMessage) {
          recordSentMessage(chatId, sentMessage.messageId, "[audio]");
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              message: sentMessage,
              senderId: account.appId,
              senderName: account.accountId,
              actor: botActor,
              reply: resolveReplyRef(sentMessage),
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
        const sentMessage = await sendFeishuVideoDetailed({
          account,
          chatId,
          fileKey,
          replyToMessageId: effectiveReplyToMessageId,
        });
        if (sentMessage) {
          recordSentMessage(chatId, sentMessage.messageId, "[video]");
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              message: sentMessage,
              senderId: account.appId,
              senderName: account.accountId,
              actor: botActor,
              reply: resolveReplyRef(sentMessage),
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
        const sentMessage = await sendFeishuImageDetailed({
          account,
          chatId,
          imageKey,
          replyToMessageId: effectiveReplyToMessageId,
        });
        if (sentMessage) {
          recordSentMessage(chatId, sentMessage.messageId, "[image]");
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              message: sentMessage,
              senderId: account.appId,
              senderName: account.accountId,
              actor: botActor,
              reply: resolveReplyRef(sentMessage),
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
        const sentMessage = await sendFeishuFileDetailed({
          account,
          chatId,
          fileKey,
          replyToMessageId: effectiveReplyToMessageId,
        });
        if (sentMessage) {
          recordSentMessage(chatId, sentMessage.messageId, `[file: ${fileName}]`);
          try {
            await archiveSentFeishuBinaryMessage({
              chatId,
              message: sentMessage,
              senderId: account.appId,
              senderName: account.accountId,
              actor: botActor,
              reply: resolveReplyRef(sentMessage),
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
        let sentMessage: Parameters<typeof buildFeishuReplyRefFromSentMessage>[0];
        if (effectiveReplyToMessageId && ci === 0) {
          sentMessage = await sendFeishuReplyDetailed({
            account,
            messageId: effectiveReplyToMessageId,
            text: chunks[ci],
          });
        } else {
          sentMessage = await sendFeishuRichTextDetailed({ account, chatId, text: chunks[ci] });
        }
        if (sentMessage) {
          recordSentMessage(chatId, sentMessage.messageId, chunks[ci]);
          cacheMessageText(sentMessage.messageId, chunks[ci]);
          archiveSentFeishuTextMessage({
            chatId,
            message: sentMessage,
            senderId: account.appId,
            senderName: account.accountId,
            actor: botActor,
            text: chunks[ci],
            textParts: buildFeishuTextPayload(chunks[ci]),
            reply: resolveReplyRef(sentMessage),
          });
        }
        setStatus({ lastOutboundAt: Date.now() });
      } catch (err) {
        log?.error(`Feishu send failed: ${String(err)}`);
      }
    }
  }
}
