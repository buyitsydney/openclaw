import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { callChatApi, makeLocalErrorResult, makeToolResult } from "./chat-api.js";

const TOP_NOTICE_ACTIONS = ["put", "delete"] as const;
const TOP_NOTICE_TYPES = ["message", "announcement"] as const;

const FeishuChatTopNoticeSchema = Type.Object({
  action: stringEnum(TOP_NOTICE_ACTIONS, {
    description: "put or delete chat top notice (not message pin).",
  }),
  chat_id: Type.Optional(
    Type.String({
      description: "Chat ID (oc_xxx). Required for all actions.",
    }),
  ),
  notice_type: Type.Optional(
    stringEnum(TOP_NOTICE_TYPES, {
      description:
        "Required for put. message=top pinned message, announcement=top group announcement.",
    }),
  ),
  message_id: Type.Optional(
    Type.String({
      description: "Message ID (om_xxx). Required when notice_type=message.",
    }),
  ),
});

type TopNoticeParams = {
  action: (typeof TOP_NOTICE_ACTIONS)[number];
  chat_id?: string;
  notice_type?: (typeof TOP_NOTICE_TYPES)[number];
  message_id?: string;
};

function getFirstAccountOrNull(api: OpenClawPluginApi): ResolvedFeishuAccount | null {
  const accounts = listEnabledFeishuAccounts(api.config);
  return accounts[0] ?? null;
}

export function registerFeishuChatTopNoticeTools(api: OpenClawPluginApi) {
  const account = getFirstAccountOrNull(api);
  if (!account) return;

  api.registerTool(
    {
      name: "feishu_chat_top_notice",
      label: "Feishu Chat Top Notice",
      description: "Set or clear Feishu chat top notice (top banner, not message pin).",
      parameters: FeishuChatTopNoticeSchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as TopNoticeParams;
        if (!params.chat_id) return makeLocalErrorResult("chat_id is required");

        switch (params.action) {
          case "put": {
            if (!params.notice_type) {
              return makeLocalErrorResult("notice_type is required for put");
            }
            if (params.notice_type === "message" && !params.message_id) {
              return makeLocalErrorResult("message_id is required when notice_type=message");
            }
            if (params.notice_type === "announcement" && params.message_id) {
              return makeLocalErrorResult("message_id must be empty when notice_type=announcement");
            }

            const noticeItem =
              params.notice_type === "message"
                ? { action_type: "1", message_id: params.message_id as string }
                : { action_type: "2" };

            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: `/im/v1/chats/${params.chat_id}/top_notice/put_top_notice`,
              body: { chat_top_notice: [noticeItem] },
            });
            return makeToolResult(result);
          }
          case "delete": {
            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: `/im/v1/chats/${params.chat_id}/top_notice/delete_top_notice`,
            });
            return makeToolResult(result);
          }
          default:
            return makeLocalErrorResult(`unknown action: ${String(params.action)}`);
        }
      },
    },
    { name: "feishu_chat_top_notice" },
  );
  api.logger.info?.("feishu: registered feishu_chat_top_notice tool");
}
