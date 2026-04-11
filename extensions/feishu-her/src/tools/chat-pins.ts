import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { callChatApi, makeLocalErrorResult, makeToolResult } from "./chat-api.js";

const PIN_ACTIONS = ["pin", "unpin"] as const;

const FeishuChatPinsSchema = Type.Object({
  action: stringEnum(PIN_ACTIONS, {
    description: "pin or unpin a message in a chat.",
  }),
  message_id: Type.Optional(
    Type.String({
      description: "Message ID (om_xxx). Required for pin/unpin.",
    }),
  ),
});

type PinParams = {
  action: (typeof PIN_ACTIONS)[number];
  message_id?: string;
};

function getFirstAccountOrNull(api: OpenClawPluginApi): ResolvedFeishuAccount | null {
  const accounts = listEnabledFeishuAccounts(api.config);
  return accounts[0] ?? null;
}

export function registerFeishuChatPinTools(api: OpenClawPluginApi) {
  const account = getFirstAccountOrNull(api);
  if (!account) return;

  api.registerTool(
    {
      name: "feishu_chat_pins",
      label: "Feishu Chat Pins",
      description: "Pin or unpin messages in Feishu chats.",
      parameters: FeishuChatPinsSchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as PinParams;
        if (!params.message_id) {
          return makeLocalErrorResult("message_id is required");
        }

        switch (params.action) {
          case "pin": {
            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: "/im/v1/pins",
              body: { message_id: params.message_id },
            });
            return makeToolResult(result);
          }
          case "unpin": {
            const result = await callChatApi({
              account,
              method: "DELETE",
              endpoint: `/im/v1/pins/${params.message_id}`,
            });
            return makeToolResult(result);
          }
          default:
            return makeLocalErrorResult(`unknown action: ${String(params.action)}`);
        }
      },
    },
    { name: "feishu_chat_pins" },
  );
  api.logger.info?.("feishu: registered feishu_chat_pins tool");
}
