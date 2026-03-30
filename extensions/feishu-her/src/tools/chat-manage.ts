import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { callChatApi, makeLocalErrorResult, makeToolResult } from "./chat-api.js";

const CHAT_MANAGE_ACTIONS = ["create", "get", "update", "delete", "update_owner"] as const;
const USER_ID_TYPES = ["open_id", "user_id", "union_id"] as const;
const CHAT_TYPES = ["private", "public"] as const;
const CHAT_MODES = ["group", "topic"] as const;

const FeishuChatManageSchema = Type.Object({
  action: stringEnum(CHAT_MANAGE_ACTIONS, {
    description:
      "create/get/update/delete/update_owner. update_owner is an explicit owner-scenario update on app-created chats.",
  }),
  chat_id: Type.Optional(
    Type.String({
      description: "Chat ID (oc_xxx). Required for get/update/delete/update_owner.",
    }),
  ),
  user_id_type: Type.Optional(
    stringEnum(USER_ID_TYPES, {
      description: "User ID type for query params. Default open_id.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: "Chat name. Required for create. Optional for update.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Chat description. Optional for create/update. Required for update_owner.",
    }),
  ),
  chat_type: Type.Optional(
    stringEnum(CHAT_TYPES, {
      description: "Chat type for create. Default private.",
    }),
  ),
  chat_mode: Type.Optional(
    stringEnum(CHAT_MODES, {
      description: "Chat mode for create. Default group.",
    }),
  ),
});

type ManageParams = {
  action: (typeof CHAT_MANAGE_ACTIONS)[number];
  chat_id?: string;
  user_id_type?: (typeof USER_ID_TYPES)[number];
  name?: string;
  description?: string;
  chat_type?: (typeof CHAT_TYPES)[number];
  chat_mode?: (typeof CHAT_MODES)[number];
};

function getFirstAccountOrNull(api: OpenClawPluginApi): ResolvedFeishuAccount | null {
  const accounts = listEnabledFeishuAccounts(api.config);
  return accounts[0] ?? null;
}

export function registerFeishuChatManageTools(api: OpenClawPluginApi) {
  const account = getFirstAccountOrNull(api);
  if (!account) return;

  api.registerTool(
    {
      name: "feishu_chat_manage",
      label: "Feishu Chat Manage",
      description:
        "Manage Feishu chats: create/get/update/delete plus explicit owner-scenario update.",
      parameters: FeishuChatManageSchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as ManageParams;
        const userIdType = params.user_id_type ?? "open_id";

        switch (params.action) {
          case "create": {
            if (!params.name) return makeLocalErrorResult("name is required for create");
            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: "/im/v1/chats",
              query: { user_id_type: userIdType },
              body: {
                name: params.name,
                chat_type: params.chat_type ?? "private",
                chat_mode: params.chat_mode ?? "group",
                ...(params.description ? { description: params.description } : {}),
              },
            });
            return makeToolResult(result);
          }
          case "get": {
            if (!params.chat_id) return makeLocalErrorResult("chat_id is required for get");
            const result = await callChatApi({
              account,
              method: "GET",
              endpoint: `/im/v1/chats/${params.chat_id}`,
              query: { user_id_type: userIdType },
            });
            return makeToolResult(result);
          }
          case "update": {
            if (!params.chat_id) return makeLocalErrorResult("chat_id is required for update");
            if (!params.name && !params.description) {
              return makeLocalErrorResult("update requires at least one of: name, description");
            }
            const result = await callChatApi({
              account,
              method: "PUT",
              endpoint: `/im/v1/chats/${params.chat_id}`,
              query: { user_id_type: userIdType },
              body: {
                ...(params.name ? { name: params.name } : {}),
                ...(params.description ? { description: params.description } : {}),
              },
            });
            return makeToolResult(result);
          }
          case "update_owner": {
            if (!params.chat_id)
              return makeLocalErrorResult("chat_id is required for update_owner");
            if (!params.description) {
              return makeLocalErrorResult("description is required for update_owner");
            }
            const result = await callChatApi({
              account,
              method: "PUT",
              endpoint: `/im/v1/chats/${params.chat_id}`,
              query: { user_id_type: userIdType },
              body: { description: params.description },
            });
            return makeToolResult(result);
          }
          case "delete": {
            if (!params.chat_id) return makeLocalErrorResult("chat_id is required for delete");
            const result = await callChatApi({
              account,
              method: "DELETE",
              endpoint: `/im/v1/chats/${params.chat_id}`,
            });
            return makeToolResult(result);
          }
          default:
            return makeLocalErrorResult(`unknown action: ${String(params.action)}`);
        }
      },
    },
    { name: "feishu_chat_manage" },
  );
  api.logger.info?.("feishu: registered feishu_chat_manage tool");
}
