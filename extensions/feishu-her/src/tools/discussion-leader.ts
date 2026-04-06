/**
 * Discussion leader tool — set the discussion leader via Redis.
 * Only call when a human explicitly designates a new leader.
 * No turn_id required — leader is a group-level concept, not turn-specific.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { setDiscussionLeader, getDiscussionParticipants } from "../discussion-state.js";
import { readGroupMode } from "../group-mode.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const SetLeaderSchema = Type.Object({
  chat_id: Type.String({ description: "群聊 ID (oc_xxx)" }),
  leader_app_id: Type.String({ description: "新主导者的 app_id (cli_xxx)" }),
});

export function registerDiscussionLeaderTool(api: OpenClawPluginApi) {
  api.registerTool({
    name: "set_discussion_leader",
    label: "Set Discussion Leader",
    description:
      "设置讨论模式的主导者（leader）。" +
      "仅在人类明确指定你为新主导者时调用（例如'你来主导/你负责/你当leader'）。" +
      "人类只是提问（'你觉得呢'）不算指定，不要调用。如果不确定，不要调用。",
    parameters: SetLeaderSchema,
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_toolCallId: string, params: any) {
      const { chat_id, leader_app_id } = params as {
        chat_id: string;
        leader_app_id: string;
      };
      if (!chat_id?.startsWith("oc_")) {
        return json({ error: "Invalid chat_id, must start with oc_" });
      }
      if (!leader_app_id?.startsWith("cli_")) {
        return json({ error: "Invalid leader_app_id, must start with cli_" });
      }

      // Reject if group is not in discussion mode.
      const mode = readGroupMode(chat_id);
      if (mode.mode !== "discussion") {
        return json({
          error:
            `当前群模式是 ${mode.mode}，不是 discussion。` +
            "请先调用 reset_discussion 进入讨论模式。",
        });
      }

      const ok = await setDiscussionLeader(chat_id, leader_app_id);
      if (!ok) {
        return json({ error: "Failed to set leader (Redis unavailable)" });
      }
      const participants = await getDiscussionParticipants(chat_id);
      return json({
        success: true,
        chat_id,
        leader: leader_app_id,
        participants,
        instruction: "Leader 已切换。不要发送群消息确认，让新 leader 自己开场。",
      });
    },
  });
}
