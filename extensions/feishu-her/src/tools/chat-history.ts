/**
 * feishu_group_history — proactively fetch group chat history using user_access_token.
 *
 * Core tool for the "query-time pull" architecture: instead of relying on passive
 * bot event archiving (which misses other bots' messages), Her pulls history
 * on-demand with the user's own token, getting the same view as the human user.
 *
 * Actions:
 *   list_history  — paginated chat timeline with time range
 *   list_thread   — fetch replies within a specific thread
 *   get_message   — fetch a single message by ID
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  buildFeishuActorFromApiSender,
  buildFeishuTextPayload,
  parseFeishuMentions,
  parseFeishuMessageContent,
  resolveFeishuChatMemberNameMaps,
  resolveFeishuMessageActors,
  type FeishuActorRef,
  type FeishuAttachmentRef,
  type FeishuMentionRef,
  type FeishuTextPayload,
} from "../feishu-message.js";
import {
  applyArchiveTextToMessage,
  archiveGroupMessage,
  buildArchiveFailureText,
  createArchiveTextForBuffer,
  getArchiveEntryDisplaySender,
  loadArchiveEntries,
  type GroupArchiveEntry,
} from "../group-archive.js";
import { expandMergeForwardMessage, type FeishuFetchedMessageItem } from "../merge-forward.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  getValidUserTokenForOpenId,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
  type FeishuUserToken,
} from "../oauth.js";
import { downloadFeishuFile, downloadFeishuImage, getFeishuClient } from "../outbound.js";
import { parseTime } from "./time-utils.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const MERGE_FORWARD_DISABLED_TEXT = "[merged forward disabled]";

// Time conversion: use shared time-utils (parseTime)
function parseTimeParam(value: string | undefined, fallbackMs: number): number {
  return parseTime(value, fallbackMs);
}

function msToFeishuTs(ms: number): string {
  return String(Math.floor(ms / 1000));
}

// ── Message normalization ──

export type NormalizedMessage = {
  message_id: string;
  msg_type: string;
  sender_id: string;
  sender_id_type?: "open_id" | "app_id" | "user_id" | "unknown";
  sender_type: string;
  sender_actor_kind?: "human" | "bot" | "system" | "unknown";
  sender_name?: string;
  sender_open_id?: string;
  sender_app_id?: string;
  sender_user_id?: string;
  sender_union_id?: string;
  sender_actor?: FeishuActorRef;
  chat_id?: string;
  create_time: string;
  create_time_human: string;
  text: string;
  text_parts?: FeishuTextPayload;
  has_thread: boolean;
  thread_id?: string;
  parent_id?: string;
  root_id?: string;
  mentions?: Array<{
    id: string;
    name: string;
    key: string;
    id_type?: "open_id" | "app_id" | "user_id" | "unknown";
    actor_kind?: "human" | "bot" | "system" | "unknown";
    open_id?: string;
    app_id?: string;
    user_id?: string;
    union_id?: string;
  }>;
  mentions_resolved?: FeishuMentionRef[];
  attachments?: FeishuAttachmentRef[];
  file_key?: string;
  file_name?: string;
  image_key?: string;
  coverage: "full" | "partial" | "none";
};

function buildNormalizedMention(mention: FeishuMentionRef) {
  const actor = mention.actor;
  return {
    id: actor.canonicalId || mention.id,
    name: mention.name ?? actor.displayName ?? mention.id,
    key: mention.key,
    ...(actor.canonicalIdType && { id_type: actor.canonicalIdType }),
    ...(actor.actorKind && { actor_kind: actor.actorKind }),
    ...(actor.rawIds.open_id && { open_id: actor.rawIds.open_id }),
    ...(actor.rawIds.app_id && { app_id: actor.rawIds.app_id }),
    ...(actor.rawIds.user_id && { user_id: actor.rawIds.user_id }),
    ...(actor.rawIds.union_id && { union_id: actor.rawIds.union_id }),
  };
}

function applySenderIdentityFields(message: NormalizedMessage): void {
  const actor = message.sender_actor;
  if (!actor) {
    return;
  }
  message.sender_id = actor.canonicalId || message.sender_id;
  message.sender_type = actor.senderType || message.sender_type;
  message.sender_id_type = actor.canonicalIdType;
  message.sender_actor_kind = actor.actorKind;
  if (actor.displayName) {
    message.sender_name = actor.displayName;
  }
  if (actor.rawIds.open_id) {
    message.sender_open_id = actor.rawIds.open_id;
  }
  if (actor.rawIds.app_id) {
    message.sender_app_id = actor.rawIds.app_id;
  }
  if (actor.rawIds.user_id) {
    message.sender_user_id = actor.rawIds.user_id;
  }
  if (actor.rawIds.union_id) {
    message.sender_union_id = actor.rawIds.union_id;
  }
}

// oxlint-disable-next-line typescript/no-explicit-any
function normalizeMessage(raw: any): NormalizedMessage {
  const msgType: string = raw.msg_type ?? "unknown";
  const body = raw.body?.content ?? "{}";
  const parsedContent = parseFeishuMessageContent({
    content: body,
    msgType,
  });
  const mentionsResolved = parseFeishuMentions(raw.mentions);
  const mentions =
    mentionsResolved.length > 0 ? mentionsResolved.map(buildNormalizedMention) : undefined;

  const createTimeMs = raw.create_time ? Number(raw.create_time) : 0;
  const senderActor = buildFeishuActorFromApiSender(raw.sender);
  const firstFileAttachment = parsedContent.attachments.find((attachment) => attachment.fileKey);
  const firstImageAttachment = parsedContent.attachments.find((attachment) => attachment.imageKey);

  const normalized: NormalizedMessage = {
    message_id: raw.message_id ?? "",
    msg_type: msgType,
    sender_id: senderActor.canonicalId,
    sender_id_type: senderActor.canonicalIdType,
    sender_type: senderActor.senderType,
    sender_actor_kind: senderActor.actorKind,
    ...(senderActor.rawIds.open_id && { sender_open_id: senderActor.rawIds.open_id }),
    ...(senderActor.rawIds.app_id && { sender_app_id: senderActor.rawIds.app_id }),
    ...(senderActor.rawIds.user_id && { sender_user_id: senderActor.rawIds.user_id }),
    ...(senderActor.rawIds.union_id && { sender_union_id: senderActor.rawIds.union_id }),
    sender_actor: senderActor,
    ...(raw.chat_id && { chat_id: raw.chat_id }),
    create_time: raw.create_time ?? "",
    create_time_human: createTimeMs ? new Date(createTimeMs).toISOString() : "",
    text: parsedContent.text.normalized,
    text_parts: parsedContent.text,
    has_thread: Boolean(raw.thread_id),
    ...(raw.thread_id && { thread_id: raw.thread_id }),
    ...(raw.parent_id && { parent_id: raw.parent_id }),
    ...(raw.root_id && { root_id: raw.root_id }),
    ...(mentions && mentions.length > 0 && { mentions }),
    ...(mentionsResolved.length > 0 && { mentions_resolved: mentionsResolved }),
    ...(parsedContent.attachments.length > 0 && { attachments: parsedContent.attachments }),
    ...(firstFileAttachment?.fileKey && { file_key: firstFileAttachment.fileKey }),
    ...(firstFileAttachment?.fileName && { file_name: firstFileAttachment.fileName }),
    ...(firstImageAttachment?.imageKey && { image_key: firstImageAttachment.imageKey }),
    coverage: parsedContent.coverage,
  };
  applySenderIdentityFields(normalized);
  return normalized;
}

async function enrichNormalizedMessages(params: {
  account: ResolvedFeishuAccount;
  messages: NormalizedMessage[];
  chatId?: string;
}) {
  const groupBuckets = new Map<string, NormalizedMessage[]>();

  for (const message of params.messages) {
    const effectiveChatId = params.chatId ?? message.chat_id;
    if (effectiveChatId?.startsWith("oc_")) {
      let bucket = groupBuckets.get(effectiveChatId);
      if (!bucket) {
        bucket = [];
        groupBuckets.set(effectiveChatId, bucket);
      }
      bucket.push(message);
      continue;
    }

    if (!message.sender_actor) continue;
    const resolved = await resolveFeishuMessageActors({
      account: params.account,
      sender: message.sender_actor,
      mentions: message.mentions_resolved,
    });
    message.sender_actor = resolved.sender;
    applySenderIdentityFields(message);
    if (resolved.mentions.length > 0) {
      message.mentions_resolved = resolved.mentions;
      message.mentions = resolved.mentions.map(buildNormalizedMention);
    }
  }

  for (const [chatId, bucket] of groupBuckets) {
    let nameMaps = {
      openIdToName: new Map<string, string>(),
      appIdToName: new Map<string, string>(),
    };
    try {
      nameMaps = await resolveFeishuChatMemberNameMaps({
        account: params.account,
        chatId,
      });
    } catch {}
    for (const message of bucket) {
      if (!message.sender_actor) continue;
      const resolved = await resolveFeishuMessageActors({
        account: params.account,
        sender: message.sender_actor,
        mentions: message.mentions_resolved,
        chatId,
        nameMaps,
      });
      message.sender_actor = resolved.sender;
      applySenderIdentityFields(message);
      if (resolved.mentions.length > 0) {
        message.mentions_resolved = resolved.mentions;
        message.mentions = resolved.mentions.map(buildNormalizedMention);
      }
    }
  }

  for (const message of params.messages) {
    const senderName = message.sender_name?.trim();
    if (senderName) {
      applySenderIdentityFields(message);
      continue;
    }
    if (message.sender_actor?.displayName) {
      applySenderIdentityFields(message);
    }
  }
}

type HistoryApiError = Error & {
  feishuCode?: number;
  unsupportedForCurrentToken?: boolean;
};

function isUnsupportedForCurrentToken(code: number | undefined, msg: string | undefined): boolean {
  return (
    code === APP_TYPE_UNSUPPORTED_CODE || (code === 230001 && /not supported/i.test(msg ?? ""))
  );
}

function isUnsupportedTokenError(error: unknown): boolean {
  return Boolean((error as HistoryApiError | undefined)?.unsupportedForCurrentToken);
}

function buildHistoryApiError(code: number | undefined, msg: string | undefined): HistoryApiError {
  const error = new Error(
    `Feishu API error: code=${code ?? "unknown"} msg=${msg ?? ""}`,
  ) as HistoryApiError;
  if (typeof code === "number") error.feishuCode = code;
  if (isUnsupportedForCurrentToken(code, msg)) error.unsupportedForCurrentToken = true;
  return error;
}

async function fetchMessageItemsViaTenantToken(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
}): Promise<FeishuFetchedMessageItem[]> {
  const client = getFeishuClient(params.account);
  const res = (await client.im.message.get({
    path: { message_id: params.messageId },
    params: { user_id_type: "open_id" },
  })) as {
    code?: number;
    msg?: string;
    data?: { items?: FeishuFetchedMessageItem[] };
  };
  if (res.code !== 0) {
    throw buildHistoryApiError(res.code, res.msg);
  }
  return Array.isArray(res.data?.items) ? res.data.items : [];
}

async function fetchMessageItemsWithToken(params: {
  account: ResolvedFeishuAccount;
  token: string;
  messageId: string;
}): Promise<FeishuFetchedMessageItem[]> {
  const res = await callFeishuApiWithUserToken<{ items: unknown[] }>({
    method: "GET",
    endpoint: `/im/v1/messages/${params.messageId}`,
    userToken: params.token,
    query: { user_id_type: "open_id" },
  });
  if (res.code === 0) {
    return (res.data?.items ?? []) as FeishuFetchedMessageItem[];
  }
  if (isUnsupportedForCurrentToken(res.code, res.msg)) {
    return fetchMessageItemsViaTenantToken({
      account: params.account,
      messageId: params.messageId,
    });
  }
  throw buildHistoryApiError(res.code, res.msg);
}

function shouldRefetchMessageForStableMentions(raw: unknown): raw is {
  message_id?: string;
  mentions?: unknown[];
} {
  if (!raw || typeof raw !== "object") return false;
  const message = raw as { message_id?: unknown; mentions?: unknown };
  if (typeof message.message_id !== "string" || !message.message_id.trim()) return false;
  return Array.isArray(message.mentions) && message.mentions.length > 0;
}

async function canonicalizeMentionedMessage(params: {
  account: ResolvedFeishuAccount;
  token: string;
  rawItem: unknown;
}) {
  if (!shouldRefetchMessageForStableMentions(params.rawItem)) {
    return params.rawItem;
  }
  const items = await fetchMessageItemsWithToken({
    account: params.account,
    token: params.token,
    messageId: params.rawItem.message_id!,
  });
  return items[0] ?? params.rawItem;
}

async function hydrateMergeForwardMessage(params: {
  message: NormalizedMessage;
  account: ResolvedFeishuAccount;
}) {
  if (params.message.msg_type !== "merge_forward" || !params.message.message_id) return;
  try {
    const expanded = await expandMergeForwardMessage({
      account: params.account,
      messageId: params.message.message_id,
    });
    if (expanded.text) {
      params.message.text = expanded.text;
      params.message.coverage = expanded.coverage;
    } else {
      params.message.text = "[合并转发消息 — 无法展开子消息]";
      params.message.coverage = "none";
    }
  } catch {
    params.message.text = "[合并转发消息 — 展开失败]";
    params.message.coverage = "none";
  }
}

const ARCHIVE_SUPPLEMENTABLE = new Set([
  "media",
  "video",
  "nonsupport",
  "interactive",
  "file",
  "image",
  "audio",
]);

/**
 * Strip redundant fields from a NormalizedMessage before returning to the agent.
 * Removes duplicated sender identifiers, the nested sender_actor object,
 * mentions_resolved (superset of mentions), and text_parts.raw/normalized
 * which duplicate the top-level `text` field.
 *
 * This reduces per-message output by ~60% with zero information loss.
 * See docs/her/her-context-protection.md for rationale.
 */
/**
 * Strip `[local archive: ...]` suffix from message text.
 * Bot messages with coverage=full often embed a full markdown copy after
 * this marker, doubling the text size.
 *
 * Only applied to coverage=full messages — for partial/none messages,
 * the archive section contains UNIQUE extracted content (file text,
 * image descriptions) that isn't present elsewhere.
 */
function stripLocalArchiveSuffix(text: string): string {
  const marker = "\n[local archive: ";
  const idx = text.indexOf(marker);
  if (idx === -1) return text;
  return text.substring(0, idx).trimEnd();
}

function compactMessageForOutput(msg: NormalizedMessage): Record<string, unknown> {
  // Only strip [local archive:] from full-coverage messages where it's a duplicate.
  // For partial/none coverage, the archive contains unique extracted content.
  const text = msg.coverage === "full" ? stripLocalArchiveSuffix(msg.text) : msg.text;

  const compact: Record<string, unknown> = {
    message_id: msg.message_id,
    msg_type: msg.msg_type,
    sender_id: msg.sender_id,
    sender_type: msg.sender_type,
    ...(msg.sender_name && { sender_name: msg.sender_name }),
    create_time_human: msg.create_time_human,
    text,
    has_thread: msg.has_thread,
    coverage: msg.coverage,
  };

  // Keep withoutFooter only when it differs from text (bot messages with footers)
  if (msg.text_parts?.withoutFooter && msg.text_parts.withoutFooter !== msg.text) {
    compact.text_without_footer = msg.text_parts.withoutFooter;
  }

  // Optional fields — only include when present
  if (msg.thread_id) compact.thread_id = msg.thread_id;
  if (msg.parent_id) compact.parent_id = msg.parent_id;
  if (msg.root_id) compact.root_id = msg.root_id;
  if (msg.mentions && msg.mentions.length > 0) compact.mentions = msg.mentions;
  if (msg.attachments && msg.attachments.length > 0) compact.attachments = msg.attachments;
  if (msg.file_name) compact.file_name = msg.file_name;
  if (msg.file_key) compact.file_key = msg.file_key;
  if (msg.image_key) compact.image_key = msg.image_key;

  return compact;
}

function compactMessagesForOutput(messages: NormalizedMessage[]): Record<string, unknown>[] {
  return messages.map(compactMessageForOutput);
}

function buildCoverageSummary(messages: NormalizedMessage[]) {
  const coverage = { full: 0, partial: 0, none: 0 };
  for (const message of messages) coverage[message.coverage]++;
  return coverage;
}

function buildArchiveFileName(message: NormalizedMessage): string {
  if (message.file_name) return message.file_name;
  switch (message.msg_type) {
    case "image":
      return `image-${message.message_id}.jpg`;
    case "audio":
      return `audio-${message.message_id}.ogg`;
    case "media":
      return `video-${message.message_id}.mp4`;
    default:
      return `file-${message.message_id}`;
  }
}

function buildArchiveErrorReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const message = String(error).trim();
  return message || "archive_failed";
}

async function ensureArchivedMessages(params: {
  account: ResolvedFeishuAccount;
  messages: NormalizedMessage[];
  chatId?: string;
  hydrateMissingAttachments?: boolean;
}) {
  const archives = new Map<string, Map<string, GroupArchiveEntry>>();
  const hydrateMissingAttachments = params.hydrateMissingAttachments ?? true;

  const resolveArchive = (chatId: string): Map<string, GroupArchiveEntry> => {
    let archive = archives.get(chatId);
    if (!archive) {
      archive = loadArchiveEntries(chatId);
      archives.set(chatId, archive);
    }
    return archive;
  };

  for (const message of params.messages) {
    if (message.msg_type === "merge_forward") {
      await hydrateMergeForwardMessage({ message, account: params.account });
      continue;
    }

    if (!ARCHIVE_SUPPLEMENTABLE.has(message.msg_type)) continue;

    const chatId = params.chatId ?? message.chat_id;
    const archive = chatId ? resolveArchive(chatId) : undefined;
    const existing = archive?.get(message.message_id);
    if (existing) {
      applyArchiveTextToMessage(message, existing.text);
      message.sender_name = getArchiveEntryDisplaySender(existing);
      if (existing.actor) {
        message.sender_actor = existing.actor;
        applySenderIdentityFields(message);
      }
      if (message.msg_type === "nonsupport") message.msg_type = "media_local";
      continue;
    }

    if (!hydrateMissingAttachments) continue;

    let archiveText: string | null = null;
    const fileName = buildArchiveFileName(message);
    try {
      if (message.msg_type === "image" && message.image_key) {
        const imageData = await downloadFeishuImage({
          account: params.account,
          messageId: message.message_id,
          imageKey: message.image_key,
        });
        if (imageData) {
          archiveText = await createArchiveTextForBuffer({
            buffer: imageData.buffer,
            contentType: imageData.contentType,
            fileName,
            defaultBaseName: `image-${message.message_id}`,
          });
        }
      } else if (message.file_key) {
        const fileData = await downloadFeishuFile({
          account: params.account,
          messageId: message.message_id,
          fileKey: message.file_key,
        });
        if (fileData) {
          const effectiveContentType =
            fileName.endsWith(".ogg") && fileData.contentType === "application/octet-stream"
              ? "audio/ogg"
              : fileData.contentType;
          archiveText = await createArchiveTextForBuffer({
            buffer: fileData.buffer,
            contentType: effectiveContentType,
            fileName,
            defaultBaseName: `${message.msg_type}-${message.message_id}`,
          });
        }
      }
    } catch (error) {
      archiveText = buildArchiveFailureText(fileName, buildArchiveErrorReason(error));
    }

    if (!archiveText) continue;

    if (chatId) {
      const ts = message.create_time ? Math.floor(Number(message.create_time) / 1000) : undefined;
      archiveGroupMessage({
        chatId,
        chatName: null,
        senderId: message.sender_actor?.canonicalId || message.sender_id,
        senderName:
          message.sender_name ||
          message.sender_actor?.displayName ||
          message.sender_actor?.canonicalId ||
          message.sender_id,
        text: archiveText,
        msgId: message.message_id,
        ts,
        actor: message.sender_actor,
        messageType: message.msg_type,
        textParts: buildFeishuTextPayload(archiveText),
      });
      archive?.set(message.message_id, {
        schemaVersion: 2,
        ts: ts ?? Math.floor(Date.now() / 1000),
        sender:
          message.sender_name ||
          message.sender_actor?.displayName ||
          message.sender_actor?.canonicalId ||
          message.sender_id,
        senderId: message.sender_actor?.canonicalId || message.sender_id,
        text: archiveText,
        msgId: message.message_id,
        actor: message.sender_actor,
        messageType: message.msg_type,
        textParts: buildFeishuTextPayload(archiveText),
      });
    }

    applyArchiveTextToMessage(message, archiveText);
    if (message.msg_type === "nonsupport") message.msg_type = "media_local";
  }
}

// ── Tenant token fallback for enterprises where Feishu rejects a user token
// on /im/v1/messages with an "app/token not supported" error. The
// tenant_access_token uses the same API and response format.

const APP_TYPE_UNSUPPORTED_CODE = 231204;

type TokenClient = {
  tokenManager?: {
    getTenantAccessToken: (params: Record<string, never>) => Promise<string | null | undefined>;
  };
};

export async function getTenantAccessToken(account: ResolvedFeishuAccount): Promise<string> {
  const client = getFeishuClient(account) as unknown as TokenClient;
  const token = await client.tokenManager?.getTenantAccessToken({});
  if (!token) throw new Error("failed_to_get_tenant_access_token");
  return token;
}

// ── API wrappers ──

const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 200;
const API_PAGE_SIZE = 50;

type ListHistoryResult = {
  messages: NormalizedMessage[];
  has_more: boolean;
  page_token?: string;
  total_fetched: number;
  coverage_summary: { full: number; partial: number; none: number };
  time_range: { start: string; end: string };
};

export async function fetchChatHistory(params: {
  account: ResolvedFeishuAccount;
  token: string;
  chatId: string;
  startMs: number;
  endMs: number;
  limit: number;
  pageToken?: string;
}): Promise<ListHistoryResult> {
  const messages: NormalizedMessage[] = [];
  let pageToken = params.pageToken;
  let remaining = params.limit;
  let hasMore = false;

  while (remaining > 0) {
    const perPage = Math.min(remaining, API_PAGE_SIZE);
    const query: Record<string, string> = {
      container_id_type: "chat",
      container_id: params.chatId,
      start_time: msToFeishuTs(params.startMs),
      end_time: msToFeishuTs(params.endMs),
      sort_type: "ByCreateTimeDesc",
      page_size: String(perPage),
    };
    if (pageToken) query.page_token = pageToken;

    const res = await callFeishuApiWithUserToken<{
      items: unknown[];
      has_more: boolean;
      page_token?: string;
    }>({
      method: "GET",
      endpoint: "/im/v1/messages",
      userToken: params.token,
      query,
    });

    if (res.code !== 0) {
      throw buildHistoryApiError(res.code, res.msg);
    }

    const items = res.data?.items ?? [];
    for (const item of items) {
      const canonicalItem = await canonicalizeMentionedMessage({
        account: params.account,
        token: params.token,
        rawItem: item,
      });
      const normalized = normalizeMessage(canonicalItem);
      await hydrateMergeForwardMessage({
        message: normalized,
        account: params.account,
      });
      messages.push(normalized);
      remaining--;
      if (remaining <= 0) break;
    }

    hasMore = res.data?.has_more ?? false;
    pageToken = res.data?.page_token;
    if (!hasMore || !pageToken || remaining <= 0) break;
  }

  await enrichNormalizedMessages({
    account: params.account,
    messages,
    chatId: params.chatId,
  });

  const coverage = buildCoverageSummary(messages);

  return {
    messages,
    has_more: hasMore,
    ...(pageToken && { page_token: pageToken }),
    total_fetched: messages.length,
    coverage_summary: coverage,
    time_range: {
      start: new Date(params.startMs).toISOString(),
      end: new Date(params.endMs).toISOString(),
    },
  };
}

async function fetchThreadMessages(params: {
  account: ResolvedFeishuAccount;
  token: string;
  threadId: string;
  pageSize: number;
  pageToken?: string;
}): Promise<{
  messages: NormalizedMessage[];
  has_more: boolean;
  page_token?: string;
}> {
  const query: Record<string, string> = {
    container_id_type: "thread",
    container_id: params.threadId,
    sort_type: "ByCreateTimeAsc",
    page_size: String(params.pageSize),
  };
  if (params.pageToken) query.page_token = params.pageToken;

  const res = await callFeishuApiWithUserToken<{
    items: unknown[];
    has_more: boolean;
    page_token?: string;
  }>({
    method: "GET",
    endpoint: "/im/v1/messages",
    userToken: params.token,
    query,
  });

  if (res.code !== 0) {
    throw buildHistoryApiError(res.code, res.msg);
  }

  const items = res.data?.items ?? [];
  const messages: NormalizedMessage[] = [];
  for (const item of items) {
    const canonicalItem = await canonicalizeMentionedMessage({
      account: params.account,
      token: params.token,
      rawItem: item,
    });
    const normalized = normalizeMessage(canonicalItem);
    await hydrateMergeForwardMessage({
      message: normalized,
      account: params.account,
    });
    messages.push(normalized);
  }
  await enrichNormalizedMessages({
    account: params.account,
    messages,
  });
  return {
    messages,
    has_more: res.data?.has_more ?? false,
    ...(res.data?.page_token && { page_token: res.data.page_token }),
  };
}

async function fetchSingleMessage(params: {
  account: ResolvedFeishuAccount;
  token: string;
  messageId: string;
}): Promise<NormalizedMessage> {
  const items = await fetchMessageItemsWithToken({
    account: params.account,
    token: params.token,
    messageId: params.messageId,
  });
  if (items.length === 0) throw new Error("Message not found");
  const message = normalizeMessage(items[0]);
  await hydrateMergeForwardMessage({
    message,
    account: params.account,
  });
  await enrichNormalizedMessages({
    account: params.account,
    messages: [message],
    chatId: items[0]?.chat_id,
  });
  return message;
}

// ── Schema ──

const ACTIONS = ["list_history", "list_thread", "get_message"] as const;

const ChatHistorySchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "list_history: fetch group chat messages within a time range (default: last 1 hour). " +
      "list_thread: fetch replies in a specific thread. " +
      "get_message: fetch a single message by ID.",
  }),
  chat_id: Type.Optional(
    Type.String({ description: "Group chat_id (oc_xxx). Required for list_history." }),
  ),
  start_time: Type.Optional(
    Type.String({
      description:
        "Start of time range (ISO 8601 string or Unix ms). Defaults to 1 hour ago. " +
        "Example: '2026-03-07T00:00:00+08:00' or '1741276800000'.",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: "End of time range (ISO 8601 string or Unix ms). Defaults to now.",
    }),
  ),
  thread_id: Type.Optional(
    Type.String({
      description: "Thread ID for list_thread action. Get this from messages with has_thread=true.",
    }),
  ),
  message_id: Type.Optional(
    Type.String({ description: "Message ID (om_xxx) for get_message action." }),
  ),
  page_size: Type.Optional(
    Type.Number({
      description:
        "Maximum number of messages to return (default 20, max 200). " +
        "Use a small value (3-10) for quick lookups, larger (50-100) for comprehensive summaries.",
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: "Pagination token from previous response." }),
  ),
  include_thread_replies: Type.Optional(
    Type.Boolean({
      description:
        "For list_history: automatically fetch thread replies for messages with threads. " +
        "Default false. Set true for comprehensive summaries (slower, more API calls).",
    }),
  ),
});

// ── Registration ──

export function registerFeishuChatHistoryTool(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const redirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    (toolCtx) => ({
      name: "feishu_group_history",
      label: "Feishu Group Chat History",
      description:
        "Fetch group chat history using the user's own Feishu permissions (same visibility as " +
        "the human user). This is the primary way to read what happened in a group — including " +
        "messages from other bots/Hers that are invisible to the bot event stream.\n\n" +
        "IMPORTANT:\n" +
        "- Always specify a time range. Default is last 1 hour. For 'today', use start of day.\n" +
        "- Messages with has_thread=true have thread replies. Use list_thread to fetch them.\n" +
        "- coverage='full' means text fully readable. 'partial' means metadata only (image/file/audio). " +
        "'none' means content degraded (interactive cards, video).\n" +
        "- merge_forward: expanded via API — sub-messages are fetched and displayed inline. Cross-chat images may show placeholders if bot lacks source chat access.\n" +
        "- To check if a user was @mentioned: compare mentions[i].id with the user's own open_id.\n" +
        "- For comprehensive group summaries, set include_thread_replies=true.\n\n" +
        "If authorization is needed, the tool returns an auth_url — send it to the user as a clickable link.",
      parameters: ChatHistorySchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        // Bind reads to the trusted current requester instead of an arbitrary stored user token.
        const requesterSenderId = toolCtx.requesterSenderId?.trim();
        const guard = await requireUserToken({
          account: firstAccount,
          redirectUri,
          tokenPromise: requesterSenderId
            ? getValidUserTokenForOpenId(firstAccount, requesterSenderId)
            : getValidUserToken(firstAccount),
          toolLabel: "群聊历史",
        });
        if (!guard.ok) return guard.authResponse;
        const userToken = guard.token;

        try {
          switch (params.action) {
            case "list_history":
              return await handleListHistory(firstAccount, userToken, params);
            case "list_thread":
              return await handleListThread(firstAccount, userToken, params);
            case "get_message":
              return await handleGetMessage(firstAccount, userToken, params);
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          handleFeishuTokenError(err);
          const msg = err instanceof Error ? err.message : String(err);
          return json({ error: msg });
        }
      },
    }),
    { name: "feishu_group_history" },
  );
  api.logger.info?.("feishu: registered feishu_group_history tool");
}

// ── Action handlers ──

// oxlint-disable-next-line typescript/no-explicit-any
async function handleListHistory(
  account: ResolvedFeishuAccount,
  userToken: FeishuUserToken,
  // oxlint-disable-next-line typescript/no-explicit-any
  params: any,
) {
  if (!params.chat_id) {
    return json({ error: "chat_id is required for list_history action" });
  }

  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;
  const startMs = parseTimeParam(params.start_time, now - ONE_HOUR);
  const endMs = parseTimeParam(params.end_time, now);

  const limit = Math.min(Math.max(params.page_size ?? DEFAULT_MESSAGE_LIMIT, 1), MAX_MESSAGE_LIMIT);

  let token = userToken.access_token;
  let usedTenantFallback = false;

  let result: ListHistoryResult;
  try {
    result = await fetchChatHistory({
      account,
      token,
      chatId: params.chat_id,
      startMs,
      endMs,
      limit,
      pageToken: params.page_token,
    });
  } catch (err) {
    if (isUnsupportedTokenError(err)) {
      token = await getTenantAccessToken(account);
      usedTenantFallback = true;
      result = await fetchChatHistory({
        account,
        token,
        chatId: params.chat_id,
        startMs,
        endMs,
        limit,
        pageToken: params.page_token,
      });
    } else {
      throw err;
    }
  }

  // Keep timeline reads lightweight: reuse existing archive text, but never
  // download or parse missing attachments while listing chat history.
  await ensureArchivedMessages({
    account,
    messages: result.messages,
    chatId: params.chat_id,
    hydrateMissingAttachments: false,
  });
  result.coverage_summary = buildCoverageSummary(result.messages);

  if (params.include_thread_replies) {
    const threaded = result.messages.filter((m) => m.has_thread && m.thread_id);
    const threadReplies: Record<string, NormalizedMessage[]> = {};

    for (const m of threaded) {
      try {
        const threadResult = await fetchThreadMessages({
          account,
          token,
          threadId: m.thread_id!,
          pageSize: API_PAGE_SIZE,
        });
        await ensureArchivedMessages({
          account,
          messages: threadResult.messages,
          hydrateMissingAttachments: false,
        });
        if (threadResult.messages.length > 0) {
          threadReplies[m.thread_id!] = threadResult.messages;
        }
      } catch {
        // Thread fetch failed — continue with main timeline
      }
    }

    if (Object.keys(threadReplies).length > 0) {
      const compactThreadReplies: Record<string, Record<string, unknown>[]> = {};
      for (const [threadId, replies] of Object.entries(threadReplies)) {
        compactThreadReplies[threadId] = compactMessagesForOutput(replies);
      }
      return json({
        ...result,
        messages: compactMessagesForOutput(result.messages),
        thread_replies: compactThreadReplies,
        threads_fetched: Object.keys(threadReplies).length,
        user_open_id: userToken.open_id,
        ...(usedTenantFallback && { token_mode: "tenant_fallback" }),
      });
    }
  }

  return json({
    ...result,
    messages: compactMessagesForOutput(result.messages),
    user_open_id: userToken.open_id,
    ...(usedTenantFallback && { token_mode: "tenant_fallback" }),
  });
}

async function handleListThread(
  account: ResolvedFeishuAccount,
  userToken: FeishuUserToken,
  // oxlint-disable-next-line typescript/no-explicit-any
  params: any,
) {
  if (!params.thread_id) {
    return json({ error: "thread_id is required for list_thread action" });
  }

  const limit = Math.min(Math.max(params.page_size ?? DEFAULT_MESSAGE_LIMIT, 1), MAX_MESSAGE_LIMIT);
  let token = userToken.access_token;
  let usedTenantFallback = false;

  let result: { messages: NormalizedMessage[]; has_more: boolean; page_token?: string };
  try {
    result = await fetchThreadMessages({
      account,
      token,
      threadId: params.thread_id,
      pageSize: Math.min(limit, API_PAGE_SIZE),
      pageToken: params.page_token,
    });
  } catch (err) {
    if (isUnsupportedTokenError(err)) {
      token = await getTenantAccessToken(account);
      usedTenantFallback = true;
      result = await fetchThreadMessages({
        account,
        token,
        threadId: params.thread_id,
        pageSize: Math.min(limit, API_PAGE_SIZE),
        pageToken: params.page_token,
      });
    } else {
      throw err;
    }
  }

  await ensureArchivedMessages({
    account,
    messages: result.messages,
  });

  return json({
    ...result,
    messages: compactMessagesForOutput(result.messages),
    thread_id: params.thread_id,
    total_fetched: result.messages.length,
    user_open_id: userToken.open_id,
    ...(usedTenantFallback && { token_mode: "tenant_fallback" }),
  });
}

// oxlint-disable-next-line typescript/no-explicit-any
async function handleGetMessage(
  account: ResolvedFeishuAccount,
  userToken: FeishuUserToken,
  params: any,
) {
  if (!params.message_id) {
    return json({ error: "message_id is required for get_message action" });
  }

  const message = await fetchSingleMessage({
    account,
    token: userToken.access_token,
    messageId: params.message_id,
  });

  await ensureArchivedMessages({
    account,
    messages: [message],
  });

  return json({
    message: compactMessageForOutput(message),
    user_open_id: userToken.open_id,
  });
}
