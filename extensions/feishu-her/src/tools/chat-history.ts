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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  requireUserToken,
  resolveOAuthRedirectUri,
  type FeishuUserToken,
} from "../oauth.js";
import { getFeishuClient } from "../outbound.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Time helpers ──

function parseTimeParam(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const n = Number(value);
  if (!Number.isNaN(n) && n > 1e12) return Math.floor(n);
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return d;
  return fallbackMs;
}

function msToFeishuTs(ms: number): string {
  return String(Math.floor(ms / 1000));
}

// ── Message normalization ──

type NormalizedMessage = {
  message_id: string;
  msg_type: string;
  sender_id: string;
  sender_type: string;
  create_time: string;
  create_time_human: string;
  text: string;
  has_thread: boolean;
  thread_id?: string;
  parent_id?: string;
  root_id?: string;
  mentions?: Array<{ id: string; name: string; key: string }>;
  file_key?: string;
  image_key?: string;
  coverage: "full" | "partial" | "none";
};

// oxlint-disable-next-line typescript/no-explicit-any
function extractPostText(parsed: Record<string, any>): string {
  const zhCn = parsed.zh_cn as Record<string, unknown> | undefined;
  const enUs = parsed.en_us as Record<string, unknown> | undefined;
  const content = (parsed.content ?? zhCn?.content ?? enUs?.content) as
    | Array<Array<Record<string, unknown>>>
    | undefined;
  if (!Array.isArray(content)) return JSON.stringify(parsed);
  const lines: string[] = [];
  for (const paragraph of content) {
    const parts: string[] = [];
    for (const el of paragraph) {
      if (el.tag === "text") parts.push(String(el.text ?? ""));
      else if (el.tag === "a") parts.push(`[${el.text ?? ""}](${el.href ?? ""})`);
      else if (el.tag === "at") parts.push(`@${el.user_name ?? el.user_id ?? ""}`);
      else if (el.tag === "img") parts.push(`[image:${el.image_key ?? ""}]`);
      else if (el.tag === "media") parts.push(`[media:${el.file_key ?? ""}]`);
    }
    lines.push(parts.join(""));
  }
  return lines.join("\n");
}

// oxlint-disable-next-line typescript/no-explicit-any
function normalizeMessage(raw: any): NormalizedMessage {
  const msgType: string = raw.msg_type ?? "unknown";
  const body = raw.body?.content ?? "{}";
  let text = "";
  let fileKey: string | undefined;
  let imageKey: string | undefined;
  let coverage: "full" | "partial" | "none" = "full";

  try {
    const parsed = JSON.parse(body);
    switch (msgType) {
      case "text":
        text = parsed.text ?? body;
        break;
      case "post":
        text = extractPostText(parsed);
        break;
      case "image":
        imageKey = parsed.image_key;
        text = `[image: ${imageKey ?? "unknown"}]`;
        coverage = "partial";
        break;
      case "file":
        fileKey = parsed.file_key;
        text = `[file: ${parsed.file_name ?? fileKey ?? "unknown"}]`;
        coverage = "partial";
        break;
      case "audio":
        fileKey = parsed.file_key;
        text = `[audio: ${fileKey ?? "unknown"}]`;
        coverage = "partial";
        break;
      case "media":
        imageKey = parsed.image_key;
        fileKey = parsed.file_key;
        text = `[video: ${parsed.file_name ?? "unknown"}, duration=${parsed.duration ?? "?"}s, cover=${imageKey ?? "none"}]`;
        coverage = "partial";
        break;
      case "interactive":
        text = "[interactive card — content degraded by API, cannot recover full text]";
        coverage = "none";
        break;
      case "video":
        text = "[video — not fully supported by history API]";
        coverage = "none";
        break;
      case "system":
        text = parsed.content ?? body;
        break;
      default:
        // Feishu returns "nonsupport" for video messages in history API
        if (msgType === "nonsupport") {
          text = "[unsupported message type — likely video, will check local archive]";
          coverage = "none";
        } else {
          text = body;
        }
        break;
    }
  } catch {
    text = body;
  }

  const mentions = raw.mentions as Array<{ id: string; name: string; key: string }> | undefined;

  const createTimeMs = raw.create_time ? Number(raw.create_time) : 0;

  return {
    message_id: raw.message_id ?? "",
    msg_type: msgType,
    sender_id: raw.sender?.id ?? "",
    sender_type: raw.sender?.sender_type ?? "",
    create_time: raw.create_time ?? "",
    create_time_human: createTimeMs ? new Date(createTimeMs).toISOString() : "",
    text,
    has_thread: Boolean(raw.thread_id),
    ...(raw.thread_id && { thread_id: raw.thread_id }),
    ...(raw.parent_id && { parent_id: raw.parent_id }),
    ...(raw.root_id && { root_id: raw.root_id }),
    ...(mentions && mentions.length > 0 && { mentions }),
    ...(fileKey && { file_key: fileKey }),
    ...(imageKey && { image_key: imageKey }),
    coverage,
  };
}

// ── Local archive cross-reference ──
// The real-time event handler archives ALL user messages (including video) with
// downloaded file paths. The history API can't recover video/interactive content,
// but the local archive has it. Cross-reference by message_id.

type ArchiveEntry = {
  ts: number;
  sender: string;
  senderId: string;
  text: string;
  msgId: string;
};

function resolveGroupArchiveDir(): string {
  const base = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
  return join(base, "feishu-groups");
}

function loadArchiveEntries(chatId: string): Map<string, ArchiveEntry> {
  const archivePath = join(resolveGroupArchiveDir(), chatId, "messages.jsonl");
  const map = new Map<string, ArchiveEntry>();
  if (!existsSync(archivePath)) return map;
  try {
    const content = readFileSync(archivePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ArchiveEntry;
        if (entry.msgId) map.set(entry.msgId, entry);
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // archive unreadable
  }
  return map;
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

function supplementFromArchive(
  messages: NormalizedMessage[],
  archive: Map<string, ArchiveEntry>,
): void {
  for (const msg of messages) {
    if (!ARCHIVE_SUPPLEMENTABLE.has(msg.msg_type)) continue;
    const entry = archive.get(msg.message_id);
    if (!entry) continue;
    // Archive text includes local file paths from real-time download.
    // Append it so Her has both API metadata and local file info.
    const localInfo = entry.text;
    if (msg.coverage === "none") {
      msg.text = localInfo;
      msg.coverage = "partial";
    } else {
      msg.text += `\n[local archive: ${localInfo}]`;
    }
    if (msg.msg_type === "nonsupport") msg.msg_type = "media_local";
  }
}

// ── Tenant token fallback for enterprises where user_access_token
// is rejected with 231204 ("b2c/b2b app not support") on im/v1/messages.
// The tenant_access_token uses the same API and response format.

const APP_TYPE_UNSUPPORTED_CODE = 231204;

type TokenClient = {
  tokenManager?: {
    getTenantAccessToken: (params: Record<string, never>) => Promise<string | null | undefined>;
  };
};

async function getTenantAccessToken(account: ResolvedFeishuAccount): Promise<string> {
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

async function fetchChatHistory(params: {
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

    if (res.code === APP_TYPE_UNSUPPORTED_CODE) {
      throw Object.assign(new Error(`Feishu API error: code=${res.code} msg=${res.msg}`), {
        feishuCode: APP_TYPE_UNSUPPORTED_CODE,
      });
    }
    if (res.code !== 0) {
      throw new Error(`Feishu API error: code=${res.code} msg=${res.msg}`);
    }

    const items = res.data?.items ?? [];
    for (const item of items) {
      messages.push(normalizeMessage(item));
      remaining--;
      if (remaining <= 0) break;
    }

    hasMore = res.data?.has_more ?? false;
    pageToken = res.data?.page_token;
    if (!hasMore || !pageToken || remaining <= 0) break;
  }

  const coverage = { full: 0, partial: 0, none: 0 };
  for (const m of messages) coverage[m.coverage]++;

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

  if (res.code === APP_TYPE_UNSUPPORTED_CODE) {
    throw Object.assign(new Error(`Feishu API error: code=${res.code} msg=${res.msg}`), {
      feishuCode: APP_TYPE_UNSUPPORTED_CODE,
    });
  }
  if (res.code !== 0) {
    throw new Error(`Feishu API error: code=${res.code} msg=${res.msg}`);
  }

  const items = res.data?.items ?? [];
  return {
    messages: items.map(normalizeMessage),
    has_more: res.data?.has_more ?? false,
    ...(res.data?.page_token && { page_token: res.data.page_token }),
  };
}

async function fetchSingleMessage(params: {
  token: string;
  messageId: string;
}): Promise<NormalizedMessage> {
  const res = await callFeishuApiWithUserToken<{ items: unknown[] }>({
    method: "GET",
    endpoint: `/im/v1/messages/${params.messageId}`,
    userToken: params.token,
  });

  if (res.code !== 0) {
    throw new Error(`Feishu API error: code=${res.code} msg=${res.msg}`);
  }

  const items = res.data?.items ?? [];
  if (items.length === 0) throw new Error("Message not found");
  return normalizeMessage(items[0]);
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
    {
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
        "- To check if a user was @mentioned: compare mentions[i].id with the user's own open_id.\n" +
        "- For comprehensive group summaries, set include_thread_replies=true.\n\n" +
        "If authorization is needed, the tool returns an auth_url — send it to the user as a clickable link.",
      parameters: ChatHistorySchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        const guard = await requireUserToken({
          account: firstAccount,
          redirectUri,
          tokenPromise: getValidUserToken(firstAccount),
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
              return await handleGetMessage(userToken, params);
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return json({ error: msg });
        }
      },
    },
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
      token,
      chatId: params.chat_id,
      startMs,
      endMs,
      limit,
      pageToken: params.page_token,
    });
  } catch (err) {
    if ((err as { feishuCode?: number }).feishuCode === APP_TYPE_UNSUPPORTED_CODE) {
      token = await getTenantAccessToken(account);
      usedTenantFallback = true;
      result = await fetchChatHistory({
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

  // Cross-reference with local archive for messages the API can't fully read
  // (video shows as "nonsupport", interactive cards are degraded).
  const archive = loadArchiveEntries(params.chat_id);
  if (archive.size > 0) {
    supplementFromArchive(result.messages, archive);
    result.coverage_summary = { full: 0, partial: 0, none: 0 };
    for (const m of result.messages) result.coverage_summary[m.coverage]++;
  }

  if (params.include_thread_replies) {
    const threaded = result.messages.filter((m) => m.has_thread && m.thread_id);
    const threadReplies: Record<string, NormalizedMessage[]> = {};

    for (const m of threaded) {
      try {
        const threadResult = await fetchThreadMessages({
          token,
          threadId: m.thread_id!,
          pageSize: API_PAGE_SIZE,
        });
        if (threadResult.messages.length > 0) {
          threadReplies[m.thread_id!] = threadResult.messages;
        }
      } catch {
        // Thread fetch failed — continue with main timeline
      }
    }

    if (Object.keys(threadReplies).length > 0) {
      return json({
        ...result,
        thread_replies: threadReplies,
        threads_fetched: Object.keys(threadReplies).length,
        user_open_id: userToken.open_id,
        ...(usedTenantFallback && { token_mode: "tenant_fallback" }),
      });
    }
  }

  return json({
    ...result,
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
      token,
      threadId: params.thread_id,
      pageSize: Math.min(limit, API_PAGE_SIZE),
      pageToken: params.page_token,
    });
  } catch (err) {
    if ((err as { feishuCode?: number }).feishuCode === APP_TYPE_UNSUPPORTED_CODE) {
      token = await getTenantAccessToken(account);
      usedTenantFallback = true;
      result = await fetchThreadMessages({
        token,
        threadId: params.thread_id,
        pageSize: Math.min(limit, API_PAGE_SIZE),
        pageToken: params.page_token,
      });
    } else {
      throw err;
    }
  }

  return json({
    ...result,
    thread_id: params.thread_id,
    total_fetched: result.messages.length,
    user_open_id: userToken.open_id,
    ...(usedTenantFallback && { token_mode: "tenant_fallback" }),
  });
}

// oxlint-disable-next-line typescript/no-explicit-any
async function handleGetMessage(userToken: FeishuUserToken, params: any) {
  if (!params.message_id) {
    return json({ error: "message_id is required for get_message action" });
  }

  const message = await fetchSingleMessage({
    token: userToken.access_token,
    messageId: params.message_id,
  });

  return json({
    message,
    user_open_id: userToken.open_id,
  });
}
