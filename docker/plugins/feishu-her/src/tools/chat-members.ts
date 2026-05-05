import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { callChatApi, makeLocalErrorResult, makeToolResult } from "./chat-api.js";
import { getTenantAccessToken, fetchChatHistory } from "./chat-history.js";

const MEMBER_ACTIONS = ["list", "add", "remove", "is_in_chat", "add_managers"] as const;
const MEMBER_ID_TYPES = ["open_id", "user_id", "union_id", "app_id"] as const;

const FeishuChatMembersSchema = Type.Object({
  action: stringEnum(MEMBER_ACTIONS, {
    description: "list/add/remove/is_in_chat/add_managers for group chat members and managers.",
  }),
  chat_id: Type.Optional(
    Type.String({
      description: "Chat ID (oc_xxx). Required for all actions.",
    }),
  ),
  member_id_type: Type.Optional(
    stringEnum(MEMBER_ID_TYPES, {
      description: "member_id_type for list/add/remove query. Default open_id.",
    }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "ID list for add/remove/add_managers. For add/remove this maps to id_list. For add_managers this maps to manager_ids.",
    }),
  ),
  page_size: Type.Optional(
    Type.Number({
      description: "Page size for list action.",
    }),
  ),
  page_token: Type.Optional(
    Type.String({
      description: "Page token for list action.",
    }),
  ),
});

type MemberParams = {
  action: (typeof MEMBER_ACTIONS)[number];
  chat_id?: string;
  member_id_type?: (typeof MEMBER_ID_TYPES)[number];
  ids?: string[];
  page_size?: number;
  page_token?: string;
};

function getFirstAccountOrNull(api: OpenClawPluginApi): ResolvedFeishuAccount | null {
  const accounts = listEnabledFeishuAccounts(api.config);
  return accounts[0] ?? null;
}

export function registerFeishuChatMemberTools(api: OpenClawPluginApi) {
  const account = getFirstAccountOrNull(api);
  if (!account) {return;}

  api.registerTool(
    {
      name: "feishu_chat_members",
      label: "Feishu Chat Members",
      description:
        "Manage Feishu chat members: list/add/remove, check membership, and add managers.",
      parameters: FeishuChatMembersSchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as MemberParams;
        const memberIdType = params.member_id_type ?? "open_id";

        if (!params.chat_id) {
          return makeLocalErrorResult("chat_id is required");
        }

        switch (params.action) {
          case "list": {
            const result = await callChatApi({
              account,
              method: "GET",
              endpoint: `/im/v1/chats/${params.chat_id}/members`,
              query: {
                member_id_type: memberIdType,
                page_size: params.page_size,
                page_token: params.page_token,
              },
            });
            // Feishu API excludes bot members — append bots from group history
            const botsInGroup = await detectGroupBots(account, params.chat_id);
            if (botsInGroup.length > 0 || result.data) {
              const data = result.data ?? {};
              // oxlint-disable-next-line typescript/no-explicit-any
              (data as any).bots_in_group = botsInGroup;
              // oxlint-disable-next-line typescript/no-explicit-any
              (data as any).bot_note =
                "飞书 API 不返回 bot 成员。以上 bots_in_group 基于近 24h 群消息活跃记录，不一定齐全。用 feishu_bot_directory search 按名字搜索完整 bot 信息。";
            }
            return makeToolResult(result);
          }
          case "add": {
            if (!params.ids || params.ids.length === 0) {
              return makeLocalErrorResult("ids is required for add");
            }
            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: `/im/v1/chats/${params.chat_id}/members`,
              query: { member_id_type: memberIdType },
              body: { id_list: params.ids },
            });
            return makeToolResult(result);
          }
          case "remove": {
            if (!params.ids || params.ids.length === 0) {
              return makeLocalErrorResult("ids is required for remove");
            }
            const result = await callChatApi({
              account,
              method: "DELETE",
              endpoint: `/im/v1/chats/${params.chat_id}/members`,
              query: { member_id_type: memberIdType },
              body: { id_list: params.ids },
            });
            return makeToolResult(result);
          }
          case "is_in_chat": {
            const result = await callChatApi({
              account,
              method: "GET",
              endpoint: `/im/v1/chats/${params.chat_id}/members/is_in_chat`,
            });
            return makeToolResult(result);
          }
          case "add_managers": {
            if (!params.ids || params.ids.length === 0) {
              return makeLocalErrorResult("ids is required for add_managers");
            }
            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: `/im/v1/chats/${params.chat_id}/managers/add_managers`,
              body: { manager_ids: params.ids },
            });
            return makeToolResult(result);
          }
          default:
            return makeLocalErrorResult(`unknown action: ${String(params.action)}`);
        }
      },
    },
    { name: "feishu_chat_members" },
  );
  api.logger.info?.("feishu: registered feishu_chat_members tool");
}

/** Detect bots active in a group by scanning 24h message history. */
async function detectGroupBots(
  account: ResolvedFeishuAccount,
  chatId: string,
): Promise<Array<{ name: string; app_id: string; bot_open_id?: string; member_type: "bot" }>> {
  try {
    const token = await getTenantAccessToken(account);
    const now = Date.now();
    const result = await fetchChatHistory({
      account,
      token,
      chatId,
      startMs: now - 24 * 60 * 60 * 1000,
      endMs: now,
      limit: 50,
    });
    const knownBots = account.knownBots ?? {};
    const knownOpenIds = account.knownBotOpenIds ?? {};
    const appIdToOpenId = new Map<string, string>();
    for (const [openId, appId] of Object.entries(knownOpenIds)) {
      appIdToOpenId.set(appId.trim(), openId.trim());
    }
    const seen = new Set<string>();
    const bots: Array<{ name: string; app_id: string; bot_open_id?: string; member_type: "bot" }> =
      [];
    for (const m of result.messages) {
      const isBot =
        m.sender_actor_kind === "bot" || m.sender_type === "app" || m.sender_type === "bot";
      if (!isBot) {continue;}
      const senderId = m.sender_id?.trim();
      if (!senderId || seen.has(senderId)) {continue;}
      // sender_id is typically cli_xxx (app_id) for bots
      if (senderId.startsWith("cli_") && senderId in knownBots && !seen.has(senderId)) {
        seen.add(senderId);
        bots.push({
          name: knownBots[senderId],
          app_id: senderId,
          bot_open_id: appIdToOpenId.get(senderId),
          member_type: "bot",
        });
      } else if (senderId.startsWith("ou_") && senderId in knownOpenIds) {
        const appId = knownOpenIds[senderId];
        if (!seen.has(appId)) {
          seen.add(appId);
          seen.add(senderId);
          bots.push({
            name: knownBots[appId] ?? appId,
            app_id: appId,
            bot_open_id: senderId,
            member_type: "bot",
          });
        }
      }
    }
    return bots;
  } catch {
    return [];
  }
}
