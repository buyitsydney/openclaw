/**
 * Feishu Chat tool — list bot's joined groups, get group info, list group members.
 * Uses GET /im/v1/chats (requires im:chat:readonly scope, already granted).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { getFeishuClient } from "../outbound.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Actions ──

/** List all groups the bot has joined. Paginates automatically up to ~500 groups. */
async function listChats(client: Lark.Client, pageSize?: number, pageToken?: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.im.chat.list({
    params: {
      page_size: pageSize ?? 100,
      ...(pageToken && { page_token: pageToken }),
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    chats: (res.data?.items ?? []).map((c: any) => ({
      chat_id: c.chat_id,
      name: c.name,
      description: c.description,
      owner_id: c.owner_id,
      avatar: c.avatar,
      external: c.external,
      tenant_key: c.tenant_key,
    })),
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
  };
}

/** Get info for a single group by chat_id. */
async function getChatInfo(client: Lark.Client, chatId: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.im.chat.get({ path: { chat_id: chatId } });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    chat_id: chatId,
    name: res.data?.name,
    description: res.data?.description,
    owner_id: res.data?.owner_id,
    chat_mode: res.data?.chat_mode,
    chat_type: res.data?.chat_type,
    external: res.data?.external,
    member_count: res.data?.user_count,
  };
}

/** List members of a specific group. SDK method is chatMembers.get (not .list). */
async function listChatMembers(
  client: Lark.Client,
  chatId: string,
  pageSize?: number,
  pageToken?: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.im.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      page_size: pageSize ?? 100,
      ...(pageToken && { page_token: pageToken }),
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    members: (res.data?.items ?? []).map((m: any) => ({
      member_id: m.member_id,
      member_id_type: m.member_id_type,
      name: m.name,
      tenant_key: m.tenant_key,
    })),
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    member_total: res.data?.member_total,
  };
}

// ── Schema ──

const CHAT_ACTIONS = ["list", "get", "members"] as const;

const FeishuChatSchema = Type.Object({
  action: stringEnum(CHAT_ACTIONS, {
    description:
      "Chat operation: list (all bot groups), get (single group info), members (list group members)",
  }),
  chat_id: Type.Optional(
    Type.String({ description: "Group chat_id (oc_xxx), required for get/members" }),
  ),
  page_size: Type.Optional(Type.Number({ description: "Results per page 1-100 (default 100)" })),
  page_token: Type.Optional(Type.String({ description: "Pagination token for next page" })),
});

// ── Registration ──

export function registerFeishuChatTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_chat",
      label: "Feishu Chat Groups",
      description:
        "Feishu group chat operations. Actions: list (all groups bot has joined, returns chat_id+name), get (single group info), members (list group members)",
      parameters: FeishuChatSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          switch (params.action) {
            case "list":
              return json(await listChats(client, params.page_size, params.page_token));
            case "get": {
              if (!params.chat_id) return json({ error: "chat_id is required for get action" });
              return json(await getChatInfo(client, params.chat_id));
            }
            case "members": {
              if (!params.chat_id) return json({ error: "chat_id is required for members action" });
              return json(
                await listChatMembers(client, params.chat_id, params.page_size, params.page_token),
              );
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_chat" },
  );
  api.logger.info?.("feishu: registered feishu_chat tool");
}
