/**
 * Feishu Mail tool — read user mailbox messages.
 *
 * Requires user_access_token (OAuth) with scopes:
 *   - mail:user_mailbox.message:readonly
 *   - mail:user_mailbox.message.body:read
 *   - mail:user_mailbox.folder:read
 * (All backend-granted by the Feishu app SSOT; fetched at auth time.)
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";

// ── Schema ──

const MAIL_ACTIONS = ["list_folders", "list_messages", "get_message"] as const;

const FeishuMailSchema = Type.Object({
  action: stringEnum(MAIL_ACTIONS, {
    description:
      "list_folders: list the user's mailbox folders. " +
      "list_messages: list messages in a folder (paginated). " +
      "get_message: fetch a single message body by message_id.",
  }),
  folder_id: Type.Optional(
    Type.String({
      description: "Folder ID for list_messages. Use list_folders to discover. Default: INBOX.",
    }),
  ),
  message_id: Type.Optional(Type.String({ description: "Message ID for get_message action." })),
  page_size: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Max messages per page for list_messages (default 20).",
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: "Pagination token from a previous list_messages response." }),
  ),
});

// ── Helpers ──

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string, details?: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, details }, null, 2),
      },
    ],
    isError: true,
  };
}

// ── Actions ──

async function listFolders(userToken: string) {
  const res = await callFeishuApiWithUserToken<{ items?: unknown[] }>({
    method: "GET",
    endpoint: "/mail/v1/user_mailboxes/me/folders",
    userToken,
  });
  if (res.code !== 0) {
    return err(`Feishu mail folders API code=${res.code} msg=${res.msg}`);
  }
  const items = res.data?.items ?? [];
  return ok({ folders: items, count: items.length });
}

async function listMessages(
  userToken: string,
  folderId: string,
  pageSize: number,
  pageToken?: string,
) {
  const query: Record<string, string> = {
    folder_id: folderId,
    page_size: String(pageSize),
  };
  if (pageToken) {
    query.page_token = pageToken;
  }

  const res = await callFeishuApiWithUserToken<{
    items?: Array<{
      message_id: string;
      subject?: string;
      from_address?: string;
      from_name?: string;
      received_time?: string;
      is_read?: boolean;
      has_attachment?: boolean;
    }>;
    page_token?: string;
    has_more?: boolean;
  }>({
    method: "GET",
    endpoint: "/mail/v1/user_mailboxes/me/messages",
    query,
    userToken,
  });
  if (res.code !== 0) {
    return err(`Feishu mail list_messages code=${res.code} msg=${res.msg}`);
  }
  const items = res.data?.items ?? [];
  return ok({
    folder_id: folderId,
    count: items.length,
    has_more: res.data?.has_more ?? false,
    next_page_token: res.data?.page_token,
    messages: items.map((m) => ({
      message_id: m.message_id,
      subject: m.subject,
      from: m.from_name ? `${m.from_name} <${m.from_address}>` : m.from_address,
      received_time: m.received_time,
      is_read: m.is_read,
      has_attachment: m.has_attachment,
    })),
  });
}

async function getMessage(userToken: string, messageId: string) {
  const res = await callFeishuApiWithUserToken<{
    message_id?: string;
    subject?: string;
    from_address?: string;
    from_name?: string;
    to?: Array<{ mail_address?: string; name?: string }>;
    cc?: Array<{ mail_address?: string; name?: string }>;
    received_time?: string;
    body_html?: string;
    body_plain_text?: string;
    attachments?: unknown[];
  }>({
    method: "GET",
    endpoint: `/mail/v1/user_mailboxes/me/messages/${encodeURIComponent(messageId)}`,
    userToken,
  });
  if (res.code !== 0) {
    return err(`Feishu mail get_message code=${res.code} msg=${res.msg}`);
  }
  const d = res.data ?? {};
  return ok({
    message_id: d.message_id,
    subject: d.subject,
    from: d.from_name ? `${d.from_name} <${d.from_address}>` : d.from_address,
    to: d.to,
    cc: d.cc,
    received_time: d.received_time,
    body: d.body_plain_text || d.body_html,
    body_type: d.body_plain_text ? "plain" : "html",
    attachments: d.attachments ?? [],
  });
}

// ── Register ──

export function registerFeishuMailTools(api: OpenClawPluginApi): void {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    return;
  }
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const redirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool({
    name: "feishu_mail",
    label: "Feishu Mail",
    description:
      "Feishu user mailbox (邮件) operations. Actions: list_folders (enumerate mailbox folders), " +
      "list_messages (list messages in a folder, paginated), get_message (fetch full message by ID). " +
      "Requires user OAuth — first use returns an auth_url. Backend scopes are the single source of truth.",
    parameters: FeishuMailSchema,
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_toolCallId: string, params: any) {
      try {
        const guard = await requireUserToken({
          account: firstAccount,
          redirectUri,
          tokenPromise: getValidUserToken(firstAccount),
          toolLabel: "飞书邮箱",
        });
        if (!guard.ok) {
          return guard.authResponse;
        }
        const userToken = guard.token.access_token;

        const action = params?.action as (typeof MAIL_ACTIONS)[number];
        if (action === "list_folders") {
          return await listFolders(userToken);
        }
        if (action === "list_messages") {
          const folderId = (params?.folder_id as string) ?? "INBOX";
          const pageSize = (params?.page_size as number) ?? 20;
          const pageToken = params?.page_token as string | undefined;
          return await listMessages(userToken, folderId, pageSize, pageToken);
        }
        if (action === "get_message") {
          const messageId = params?.message_id as string | undefined;
          if (!messageId) {
            return err("message_id required for get_message");
          }
          return await getMessage(userToken, messageId);
        }
        return err(`unknown action: ${String(action)}`);
      } catch (e: unknown) {
        const authResp = await handleFeishuTokenError(e, firstAccount, redirectUri);
        if (authResp) {
          return authResp;
        }
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  api.logger.info?.("feishu: registered feishu_mail tool");
}
