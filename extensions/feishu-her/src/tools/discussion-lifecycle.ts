/**
 * Discussion lifecycle tools — explicit end/reset controls for discussion state.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import {
  endDiscussion,
  getDiscussionParticipants,
  resetDiscussionRoom,
} from "../discussion-state.js";
import { updateGroupModeContext } from "../group-mode.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function normalizeCliIds(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

const EndDiscussionSchema = Type.Object({
  chat_id: Type.String({ description: "群聊 ID (oc_xxx)" }),
  turn_id: Type.String({ description: "当前正在处理的人类消息对应 turn_id" }),
});

const ResetDiscussionSchema = Type.Object({
  chat_id: Type.String({ description: "群聊 ID (oc_xxx)" }),
  turn_id: Type.String({ description: "当前正在处理的人类消息对应 turn_id" }),
  owner_app_id: Type.String({ description: "新一轮首位 owner 的 app_id (cli_xxx)" }),
  chair_app_id: Type.Optional(
    Type.String({ description: "新 leader / chair 的 app_id (cli_xxx)，默认等于 owner_app_id" }),
  ),
  participant_app_ids: Type.Optional(
    Type.Array(Type.String({ description: "参与讨论的 bot app_id (cli_xxx)" })),
  ),
  context: Type.Optional(
    Type.String({
      description: "新话题/讨论主题。重开讨论时如果话题变了必须传入，会自动更新 group-modes 文件",
    }),
  ),
});

export function registerDiscussionLifecycleTools(api: OpenClawPluginApi) {
  api.registerTool({
    name: "end_discussion",
    label: "End Discussion",
    description:
      "显式结束当前 discussion。" +
      "只有当你确认讨论应当收官时才调用。调用后不会再自动分配下一棒。",
    parameters: EndDiscussionSchema,
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_toolCallId: string, params: any) {
      const { chat_id, turn_id } = params as { chat_id: string; turn_id: string };
      if (!chat_id?.startsWith("oc_")) {
        return json({ error: "Invalid chat_id, must start with oc_" });
      }
      if (!turn_id?.startsWith("turn-")) {
        return json({ error: "Invalid turn_id, must start with turn-" });
      }
      const ok = await endDiscussion(chat_id, turn_id);
      if (!ok) {
        return json({ error: "Failed to end discussion" });
      }
      return json({
        success: true,
        chat_id,
        instruction:
          "讨论已结束。若你需要公开收官，现在可以发送最后一条总结；不要再 @ 下一棒，也不要再恢复旧状态。",
      });
    },
  });

  api.registerTool({
    name: "reset_discussion",
    label: "Reset Discussion",
    description:
      "显式重开当前 discussion，并指定新的首轮 owner / chair。" +
      "适用于 leader 决定切换到新议题、新 leader、或强制清空旧队列后重新开始。",
    parameters: ResetDiscussionSchema,
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_toolCallId: string, params: any) {
      const { chat_id, turn_id, owner_app_id, chair_app_id, participant_app_ids, context } =
        params as {
          chat_id: string;
          turn_id: string;
          owner_app_id: string;
          chair_app_id?: string;
          participant_app_ids?: string[];
          context?: string;
        };
      if (!chat_id?.startsWith("oc_")) {
        return json({ error: "Invalid chat_id, must start with oc_" });
      }
      if (!turn_id?.startsWith("turn-")) {
        return json({ error: "Invalid turn_id, must start with turn-" });
      }
      if (!owner_app_id?.startsWith("cli_")) {
        return json({ error: "Invalid owner_app_id, must start with cli_" });
      }
      if (chair_app_id && !chair_app_id.startsWith("cli_")) {
        return json({ error: "Invalid chair_app_id, must start with cli_" });
      }
      const normalizedParticipants = normalizeCliIds(participant_app_ids);
      for (const participantAppId of normalizedParticipants) {
        if (!participantAppId.startsWith("cli_")) {
          return json({ error: `Invalid participant_app_id: ${participantAppId}` });
        }
      }

      if (context?.trim()) {
        updateGroupModeContext(chat_id, context.trim());
      }

      const nextTurn = await resetDiscussionRoom({
        chatId: chat_id,
        ownerAppId: owner_app_id,
        chairAppId: chair_app_id,
        participantAppIds: normalizedParticipants,
        expectedTurnId: turn_id,
      });
      if (!nextTurn) {
        return json({ error: "Failed to reset discussion" });
      }
      const participants = await getDiscussionParticipants(chat_id);
      return json({
        success: true,
        chat_id,
        leader: nextTurn.chairAppId,
        owner: nextTurn.ownerAppId,
        turn_id: nextTurn.turnId,
        participants,
        context_updated: !!context?.trim(),
        instruction:
          "讨论已重新开始，首轮 owner 将在系统下一次 turn 注入时正式开场。当前请求不要再补发公开确认，让新的讨论自己开始。",
      });
    },
  });
}
