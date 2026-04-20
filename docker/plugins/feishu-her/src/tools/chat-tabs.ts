import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { callChatApi, makeLocalErrorResult, makeToolResult } from "./chat-api.js";

const TAB_ACTIONS = ["add", "delete"] as const;
const TAB_TYPES = ["url", "doc"] as const;

const FeishuChatTabsSchema = Type.Object({
  action: stringEnum(TAB_ACTIONS, {
    description: "add or delete chat tabs.",
  }),
  chat_id: Type.Optional(
    Type.String({
      description: "Chat ID (oc_xxx). Required for all actions.",
    }),
  ),
  tab_name: Type.Optional(
    Type.String({
      description: "Tab name for add action.",
    }),
  ),
  tab_type: Type.Optional(
    stringEnum(TAB_TYPES, {
      description: "Tab type for add action: url or doc.",
    }),
  ),
  url: Type.Optional(
    Type.String({
      description: "URL for add action when tab_type=url.",
    }),
  ),
  doc_token: Type.Optional(
    Type.String({
      description: "Doc token for add action when tab_type=doc.",
    }),
  ),
  tab_ids: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tab IDs for delete action.",
    }),
  ),
});

type TabParams = {
  action: (typeof TAB_ACTIONS)[number];
  chat_id?: string;
  tab_name?: string;
  tab_type?: (typeof TAB_TYPES)[number];
  url?: string;
  doc_token?: string;
  tab_ids?: string[];
};

function getFirstAccountOrNull(api: OpenClawPluginApi): ResolvedFeishuAccount | null {
  const accounts = listEnabledFeishuAccounts(api.config);
  return accounts[0] ?? null;
}

export function registerFeishuChatTabTools(api: OpenClawPluginApi) {
  const account = getFirstAccountOrNull(api);
  if (!account) return;

  api.registerTool(
    {
      name: "feishu_chat_tabs",
      label: "Feishu Chat Tabs",
      description: "Add or delete Feishu chat tabs.",
      parameters: FeishuChatTabsSchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as TabParams;
        if (!params.chat_id) return makeLocalErrorResult("chat_id is required");

        switch (params.action) {
          case "add": {
            if (!params.tab_name) return makeLocalErrorResult("tab_name is required for add");
            if (!params.tab_type) return makeLocalErrorResult("tab_type is required for add");

            if (params.tab_type === "url" && !params.url) {
              return makeLocalErrorResult("url is required when tab_type=url");
            }
            if (params.tab_type === "doc" && !params.doc_token) {
              return makeLocalErrorResult("doc_token is required when tab_type=doc");
            }

            const tabContent =
              params.tab_type === "url"
                ? { url: params.url as string }
                : { doc_token: params.doc_token as string };

            const result = await callChatApi({
              account,
              method: "POST",
              endpoint: `/im/v1/chats/${params.chat_id}/chat_tabs`,
              body: {
                chat_tabs: [
                  {
                    tab_name: params.tab_name,
                    tab_type: params.tab_type,
                    tab_content: tabContent,
                  },
                ],
              },
            });
            return makeToolResult(result);
          }
          case "delete": {
            if (!params.tab_ids || params.tab_ids.length === 0) {
              return makeLocalErrorResult("tab_ids is required for delete");
            }
            const result = await callChatApi({
              account,
              method: "DELETE",
              endpoint: `/im/v1/chats/${params.chat_id}/chat_tabs/delete_tabs`,
              body: { tab_ids: params.tab_ids },
            });
            return makeToolResult(result);
          }
          default:
            return makeLocalErrorResult(`unknown action: ${String(params.action)}`);
        }
      },
    },
    { name: "feishu_chat_tabs" },
  );
  api.logger.info?.("feishu: registered feishu_chat_tabs tool");
}
