/**
 * Group mode tool — allows Her to switch group chat mode via Redis.
 * Replaces the old approach where AI wrote mode files directly.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { writeGroupMode, readGroupMode } from "../group-mode.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const VALID_MODES = new Set(["owner-at", "group-at"]);

const SetGroupModeSchema = Type.Object({
  chat_id: Type.String({ description: "群聊 ID (oc_xxx)" }),
  mode: Type.String({
    description:
      "目标模式: owner-at（仅主人@触发）或 group-at（任何人@触发）。切换到 discussion 请使用 reset_discussion 工具。",
  }),
  context: Type.Optional(Type.String({ description: "用户自定义行为提示（可选）" })),
  set_by: Type.Optional(Type.String({ description: "发起切换的用户 open_id (ou_xxx)" })),
});

export function registerGroupModeTool(api: OpenClawPluginApi) {
  api.registerTool({
    name: "set_group_mode",
    label: "Set Group Mode",
    description:
      "切换群聊模式。可选模式：owner-at（仅主人@触发）、group-at（任何人@触发）。" +
      "切换到讨论模式请使用 reset_discussion 工具。" +
      "当用户说'群聊模式'、'开放艾特'时切到 group-at；" +
      "当用户说'恢复默认'、'关闭'、'别管了'时切到 owner-at。",
    parameters: SetGroupModeSchema,
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_toolCallId: string, params: any) {
      const { chat_id, mode, context, set_by } = params as {
        chat_id: string;
        mode: string;
        context?: string;
        set_by?: string;
      };
      if (!chat_id?.startsWith("oc_")) {
        return json({ error: "Invalid chat_id, must start with oc_" });
      }
      const normalizedMode = mode.trim().toLowerCase();
      if (!VALID_MODES.has(normalizedMode)) {
        if (normalizedMode === "discussion") {
          return json({
            error: "切换到讨论模式请使用 reset_discussion 工具，不要使用 set_group_mode。",
          });
        }
        return json({
          error: `Invalid mode: ${mode}. Valid modes: owner-at, group-at. For discussion mode, use reset_discussion.`,
        });
      }

      const previousMode = readGroupMode(chat_id);
      const ok = await writeGroupMode({
        chatId: chat_id,
        mode: normalizedMode,
        context: context?.trim() || undefined,
        setBy: set_by,
      });
      if (!ok) {
        return json({ error: "Failed to write mode (Redis unavailable)" });
      }
      return json({
        success: true,
        chat_id,
        previous_mode: previousMode.mode,
        mode: normalizedMode,
        context: context?.trim() || undefined,
      });
    },
  });
}
