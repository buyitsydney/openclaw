import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/feishu";

const CAPABILITY_ACTIONS = ["status"] as const;

const FeishuChatCapabilitySchema = Type.Object({
  action: stringEnum(CAPABILITY_ACTIONS, {
    description: "status: return current implemented chat capabilities and known pending items.",
  }),
});

const SUPPORTED_SCOPES = [
  "im:chat:create",
  "im:chat:read",
  "im:chat:update",
  "im:chat:delete",
  "im:chat:operate_as_owner",
  "im:chat.members:read",
  "im:chat.members:write_only",
  "im:chat.members:bot_access",
  "im:chat.managers:write_only",
  "im:chat.moderation:read",
  "im:chat.menu_tree:read",
  "im:chat.tabs:write_only",
  "im:chat.chat_pins:write_only",
  "im:chat.top_notice:write_only",
] as const;

const KNOWN_LIMITATIONS = [
  {
    scope: "im:chat.announcement:read",
    code: 232097,
    reason: "Unable to operate docx type chat announcement",
    note: "This is a chat announcement type limitation, not a missing scope.",
  },
  {
    scope: "im:chat.access_event.bot_p2p_chat:read",
    reason: "event_only",
    note: "This permission is event subscription only and not a synchronous OpenAPI pull endpoint.",
  },
] as const;

const PENDING_UNMAPPED = [
  "im:chat:moderation:write_only",
  "im:chat.announcement:write_only",
  "im:chat.chat_pins:read",
  "im:chat.menu_tree:write_only",
  "im:chat.tabs:read",
  "im:chat.widgets:read",
  "im:chat.widgets:write_only",
  "im:chat.collab_plugins:read",
  "im:chat.collab_plugins:write_only",
] as const;

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function registerFeishuChatCapabilityTool(api: OpenClawPluginApi) {
  api.registerTool(
    {
      name: "feishu_chat_capability",
      label: "Feishu Chat Capability Status",
      description:
        "Return implemented chat capabilities and recorded known limitations/pending mappings.",
      parameters: FeishuChatCapabilitySchema,
      async execute(_toolCallId: string, rawParams: unknown) {
        const params = rawParams as { action?: string };
        if (params.action !== "status") {
          return json({ ok: false, code: -1, msg: "unknown action", data: null });
        }
        return json({
          ok: true,
          code: 0,
          msg: "ok",
          data: {
            implemented_tools: [
              "feishu_chat",
              "feishu_chat_manage",
              "feishu_chat_members",
              "feishu_chat_controls",
              "feishu_chat_tabs",
              "feishu_chat_pins",
              "feishu_chat_top_notice",
            ],
            supported_scopes: [...SUPPORTED_SCOPES],
            known_limitations: [...KNOWN_LIMITATIONS],
            pending_unmapped: [...PENDING_UNMAPPED],
          },
        });
      },
    },
    { name: "feishu_chat_capability" },
  );
  api.logger.info?.("feishu: registered feishu_chat_capability tool");
}
