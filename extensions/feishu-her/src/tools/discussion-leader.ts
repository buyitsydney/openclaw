/**
 * Discussion leader tool — allows Her to set the discussion leader via Redis.
 * Only the bot explicitly designated by a human should call this.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { setDiscussionLeader, getDiscussionParticipants } from "../discussion-state.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const SetLeaderSchema = Type.Object({
  chat_id: Type.String({ description: "群聊 ID (oc_xxx)" }),
  turn_id: Type.String({ description: "当前正在处理的人类消息对应 turn_id" }),
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
      const { chat_id, turn_id, leader_app_id } = params as {
        chat_id: string;
        turn_id: string;
        leader_app_id: string;
      };
      if (!chat_id?.startsWith("oc_")) {
        return json({ error: "Invalid chat_id, must start with oc_" });
      }
      if (!turn_id?.startsWith("turn-")) {
        return json({ error: "Invalid turn_id, must start with turn-" });
      }
      if (!leader_app_id?.startsWith("cli_")) {
        return json({ error: "Invalid leader_app_id, must start with cli_" });
      }
      const ok = await setDiscussionLeader(chat_id, leader_app_id, turn_id);
      if (!ok) {
        return json({ error: "Failed to set leader" });
      }
      const participants = await getDiscussionParticipants(chat_id);
      return json({
        success: true,
        chat_id,
        leader: leader_app_id,
        participants,
        instruction:
          "Leader 已切换完成。不要再发送任何群消息确认这次切换，也不要公开交接；立即结束当前轮次，让新的 leader 自己开场。",
      });
    },
  });
}
