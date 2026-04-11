import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { callChatApi, makeLocalErrorResult, makeToolResult } from "./chat-api.js";

const CONTROL_ACTIONS = ["get_moderation", "get_menu_tree"] as const;
const USER_ID_TYPES = ["open_id", "user_id", "union_id"] as const;

const FeishuChatControlsSchema = Type.Object({
  action: stringEnum(CONTROL_ACTIONS, {
    description: "get_moderation or get_menu_tree.",
  }),
  chat_id: Type.Optional(
    Type.String({
      description: "Chat ID (oc_xxx). Required for all actions.",
    }),
  ),
  user_id_type: Type.Optional(
    stringEnum(USER_ID_TYPES, {
      description: "user_id_type for moderation query. Default open_id.",
    }),
  ),
  page_size: Type.Optional(
    Type.Number({
      description: "Page size for moderation query.",
    }),
  ),
});

type ControlParams = {
  action: (typeof CONTROL_ACTIONS)[number];
  chat_id?: string;
  user_id_type?: (typeof USER_ID_TYPES)[number];
  page_size?: number;
};

function getFirstAccountOrNull(api: OpenClawPluginApi): ResolvedFeishuAccount | null {
  const accounts = listEnabledFeishuAccounts(api.config);
  return accounts[0] ?? null;
}

export function registerFeishuChatControlTools(api: OpenClawPluginApi) {
  const account = getFirstAccountOrNull(api);
  if (!account) return;

  api.registerTool(
    {
      name: "feishu_chat_controls",
      label: "Feishu Chat Controls",
      description: "Read Feishu chat moderation and menu tree settings.",
      parameters: FeishuChatControlsSchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as ControlParams;
        if (!params.chat_id) return makeLocalErrorResult("chat_id is required");

        switch (params.action) {
          case "get_moderation": {
            const result = await callChatApi({
              account,
              method: "GET",
              endpoint: `/im/v1/chats/${params.chat_id}/moderation`,
              query: {
                user_id_type: params.user_id_type ?? "open_id",
                page_size: params.page_size,
              },
            });
            return makeToolResult(result);
          }
          case "get_menu_tree": {
            const result = await callChatApi({
              account,
              method: "GET",
              endpoint: `/im/v1/chats/${params.chat_id}/menu_tree`,
            });
            return makeToolResult(result);
          }
          default:
            return makeLocalErrorResult(`unknown action: ${String(params.action)}`);
        }
      },
    },
    { name: "feishu_chat_controls" },
  );
  api.logger.info?.("feishu: registered feishu_chat_controls tool");
}
