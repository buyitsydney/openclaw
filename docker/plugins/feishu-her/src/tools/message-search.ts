/**
 * feishu_message_search — cross-domain message search using Feishu's search/v2/message API.
 *
 * Searches across ALL messages visible to the user (including groups the bot hasn't joined
 * and the user's own private chats). Returns message IDs, then auto-fetches content for
 * messages the bot has permission to read.
 *
 * Scope: search:message (all users, no special backend permission needed).
 * Auth: user_access_token only.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getOAuthDirectSender } from "./oauth-direct.js";
import { getTenantAccessToken } from "./chat-history.js";

// ── Schema ──

const MESSAGE_TYPES = ["file", "image", "media"] as const;
const CHAT_TYPES = ["group_chat", "p2p_chat"] as const;
const FROM_TYPES = ["bot", "user"] as const;

const FeishuMessageSearchSchema = Type.Object({
  query: Type.String({
    description:
      "Search keyword (required). Matches message content across all chats visible to the user.",
  }),
  from_ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by sender open_id list. Only return messages sent by these users.",
    }),
  ),
  chat_ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by chat_id list (oc_xxx). Only return messages from these chats.",
    }),
  ),
  at_chatter_ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter by @mentioned user open_id list. Only return messages that @mention these users.",
    }),
  ),
  message_type: Type.Optional(
    stringEnum(MESSAGE_TYPES, {
      description:
        "Filter by message FORMAT (not content): file, image, media (video). " +
        "Note: query is text keyword matching — pure image/file messages have no searchable text, " +
        "so combining message_type=image with a text query will likely return 0 results.",
    }),
  ),
  chat_type: Type.Optional(
    stringEnum(CHAT_TYPES, {
      description: "Filter by chat type: group_chat or p2p_chat. Omit for both.",
    }),
  ),
  from_type: Type.Optional(
    stringEnum(FROM_TYPES, {
      description: "Filter by sender type: bot or user. Omit for both.",
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description:
        "Start time (ISO 8601, e.g. 2026-03-20T00:00:00+08:00). Messages sent after this time.",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description:
        "End time (ISO 8601, e.g. 2026-03-21T00:00:00+08:00). Messages sent before this time.",
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description:
        "Maximum messages to return (default 10, max 50). Each message requires a separate API call to read content.",
    }),
  ),
  read_content: Type.Optional(
    Type.Boolean({
      description:
        "Auto-read message content for each result (default true). Set false for faster search when you only need message IDs.",
    }),
  ),
});

// ── Helpers ──

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function toUnixSecondsStr(input: string | number): string {
  if (typeof input === "number") return String(Math.floor(input));
  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) return String(Math.floor(parsed / 1000));
  return String(input);
}

type MessageSearchResult = {
  message_id: string;
  content?: string;
  sender?: string;
  chat_id?: string;
  chat_type?: string;
  create_time?: string;
  message_type?: string;
  error?: string;
};

// oxlint-disable-next-line typescript/no-explicit-any
function parseMessageItem(msg: any): MessageSearchResult {
  let contentText = msg.body?.content ?? "";
  try {
    const parsed = JSON.parse(contentText);
    if (parsed.text) contentText = parsed.text;
    else if (parsed.content) contentText = JSON.stringify(parsed);
  } catch {
    // keep as-is
  }
  return {
    message_id: msg.message_id ?? "",
    content: contentText,
    sender: msg.sender?.id,
    chat_id: msg.chat_id,
    chat_type: msg.chat_type,
    create_time: msg.create_time,
    message_type: msg.msg_type,
  };
}

async function readMessageContent(
  account: ResolvedFeishuAccount,
  userToken: string,
  messageId: string,
): Promise<MessageSearchResult> {
  // Try user_access_token first, then fallback to tenant_access_token.
  // GET /im/v1/messages/:id only supports tenant_access_token officially,
  // but user_access_token works for some message types. Tenant fallback
  // handles the rest (same pattern as chat-history.ts fetchMessageItemsWithToken).
  try {
    const userRes = await callFeishuApiWithUserToken<{
      items?: Array<Record<string, unknown>>;
    }>({
      method: "GET",
      endpoint: `/im/v1/messages/${encodeURIComponent(messageId)}`,
      userToken,
      query: { user_id_type: "open_id" },
    });

    if (userRes.code === 0 && userRes.data?.items?.[0]) {
      return parseMessageItem(userRes.data.items[0]);
    }

    // Fallback to tenant_access_token
    const tenantToken = await getTenantAccessToken(account);
    const tenantRes = await callFeishuApiWithUserToken<{
      items?: Array<Record<string, unknown>>;
    }>({
      method: "GET",
      endpoint: `/im/v1/messages/${encodeURIComponent(messageId)}`,
      userToken: tenantToken,
      query: { user_id_type: "open_id" },
    });

    if (tenantRes.code === 0 && tenantRes.data?.items?.[0]) {
      return parseMessageItem(tenantRes.data.items[0]);
    }

    return { message_id: messageId, error: `code=${tenantRes.code} msg=${tenantRes.msg}` };
  } catch (err) {
    return {
      message_id: messageId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Registration ──

export function registerFeishuMessageSearchTool(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const redirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_message_search",
      label: "Feishu Message Search",
      description:
        "Cross-domain keyword search across ALL messages visible to the user — including groups " +
        "the bot hasn't joined and the user's private chats. Returns message content when readable. " +
        "Supports filtering by sender (from_ids), chat (chat_ids), @mentions (at_chatter_ids), " +
        "message type (file/image/media), chat type (group/p2p), sender type (bot/user), and time range. " +
        "Requires user OAuth (search:message scope).",
      parameters: FeishuMessageSearchSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const guard = await requireUserToken({
            account: firstAccount,
            redirectUri,
            tokenPromise: getValidUserToken(firstAccount),
            toolLabel: "飞书消息搜索",
            sendDirectToUser: getOAuthDirectSender(firstAccount),
          });
          if (!guard.ok) return guard.authResponse;
          const userToken = guard.token;

          const maxResults = Math.min(Math.max(params.max_results ?? 10, 1), 50);
          const readContent = params.read_content !== false;

          // Build request body
          const body: Record<string, unknown> = { query: params.query };
          if (params.from_ids?.length) body.from_ids = params.from_ids;
          if (params.chat_ids?.length) body.chat_ids = params.chat_ids;
          if (params.at_chatter_ids?.length) body.at_chatter_ids = params.at_chatter_ids;
          if (params.message_type) body.message_type = params.message_type;
          if (params.chat_type) body.chat_type = params.chat_type;
          if (params.from_type) body.from_type = params.from_type;
          if (params.start_time) body.start_time = toUnixSecondsStr(params.start_time);
          if (params.end_time) body.end_time = toUnixSecondsStr(params.end_time);

          // Search — collect message IDs (paginate if needed)
          const allMessageIds: string[] = [];
          let pageToken: string | undefined;

          while (allMessageIds.length < maxResults) {
            const pageSize = Math.min(maxResults - allMessageIds.length, 50);
            const query: Record<string, string> = {
              page_size: String(pageSize),
            };
            if (pageToken) query.page_token = pageToken;

            const res = await callFeishuApiWithUserToken<{
              items?: string[];
              has_more?: boolean;
              page_token?: string;
            }>({
              method: "POST",
              endpoint: "/search/v2/message",
              userToken: userToken.access_token,
              body,
              query,
            });

            if (res.code !== 0) {
              return json({
                error: `Search failed: code=${res.code} msg=${res.msg}`,
                query: params.query,
                results: [],
              });
            }

            const ids = res.data?.items ?? [];
            allMessageIds.push(...ids);

            if (!res.data?.has_more || ids.length === 0) break;
            pageToken = res.data.page_token;
          }

          if (allMessageIds.length === 0) {
            return json({
              query: params.query,
              count: 0,
              results: [],
            });
          }

          // Read content for each message (parallel, best-effort)
          let results: MessageSearchResult[];
          if (readContent) {
            results = await Promise.all(
              allMessageIds
                .slice(0, maxResults)
                .map((id) => readMessageContent(firstAccount, userToken.access_token, id)),
            );
          } else {
            results = allMessageIds.slice(0, maxResults).map((id) => ({ message_id: id }));
          }

          const readable = results.filter((r) => !r.error).length;
          const unreadable = results.filter((r) => r.error).length;

          return json({
            query: params.query,
            count: results.length,
            readable,
            unreadable,
            results,
            ...(unreadable > 0 && {
              hint: `${unreadable} message(s) could not be read (bot lacks permission). These are likely from private chats or restricted groups.`,
            }),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const authResp = await handleFeishuTokenError(err, firstAccount, redirectUri, getOAuthDirectSender(firstAccount));
          if (authResp) return authResp;
          return json({ error: message });
        }
      },
    },
    { name: "feishu_message_search" },
  );
  api.logger.info?.("feishu: registered feishu_message_search tool");
}
