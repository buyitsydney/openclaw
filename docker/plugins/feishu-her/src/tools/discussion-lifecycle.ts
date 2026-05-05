/**
 * Discussion lifecycle tools — end/reset controls for discussion state.
 *
 * reset_discussion atomically writes mode=discussion to Redis + initializes turn state.
 * end_discussion clears the turn queue (mode stays discussion).
 *
 * Neither tool requires turn_id — the AI should never touch internal turn state.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  endDiscussion,
  getDiscussionParticipants,
  resetDiscussionRoom,
} from "../discussion-state.js";
import { readGroupMode, writeGroupMode, updateGroupModeContext } from "../group-mode.js";

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
});

const ResetDiscussionSchema = Type.Object({
  chat_id: Type.String({ description: "群聊 ID (oc_xxx)" }),
  owner_app_id: Type.String({ description: "新一轮首位 owner 的 app_id (cli_xxx)" }),
  chair_app_id: Type.Optional(
    Type.String({ description: "新 leader / chair 的 app_id (cli_xxx)，默认等于 owner_app_id" }),
  ),
  participant_app_ids: Type.Optional(
    Type.Array(Type.String({ description: "参与讨论的 bot app_id (cli_xxx)" })),
  ),
  context: Type.Optional(Type.String({ description: "讨论话题。首次开启或换话题时必须传入" })),
});

export function registerDiscussionLifecycleTools(api: OpenClawPluginApi) {
  api.registerTool({
    name: "end_discussion",
    label: "End Discussion",
    description:
      "结束当前讨论轮次，清空后续发言队列。" +
      "群仍处于讨论模式，下次人类发消息可以开始新一轮。" +
      "只需传 chat_id，系统自动结束当前群唯一的活跃讨论。",
    parameters: EndDiscussionSchema,
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_toolCallId: string, params: any) {
      const { chat_id } = params as { chat_id: string };
      if (!chat_id?.startsWith("oc_")) {
        return json({ error: "Invalid chat_id, must start with oc_" });
      }
      const ok = await endDiscussion(chat_id);
      if (!ok) {
        return json({ error: "Failed to end discussion (no active turn or Redis unavailable)" });
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
      "开启或重置讨论。自动切换群模式为 discussion。" +
      "首次开启讨论或需要换话题/重新开始时调用。" +
      "只需传 chat_id + owner_app_id，不需要 turn_id。",
    parameters: ResetDiscussionSchema,
    // oxlint-disable-next-line typescript/no-explicit-any
    async execute(_toolCallId: string, params: any) {
      const { chat_id, owner_app_id, chair_app_id, participant_app_ids, context } = params as {
        chat_id: string;
        owner_app_id: string;
        chair_app_id?: string;
        participant_app_ids?: string[];
        context?: string;
      };
      if (!chat_id?.startsWith("oc_")) {
        return json({ error: "Invalid chat_id, must start with oc_" });
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

      // Write mode=discussion to Redis.
      const currentMode = readGroupMode(chat_id);
      await writeGroupMode({
        chatId: chat_id,
        mode: "discussion",
        context: context?.trim() || currentMode.context,
      });

      // Update context if provided for mid-discussion topic change.
      if (context?.trim() && currentMode.mode === "discussion") {
        await updateGroupModeContext(chat_id, context.trim());
      }

      // No expectedTurnId — reset always succeeds (no stale check).
      const nextTurn = await resetDiscussionRoom({
        chatId: chat_id,
        ownerAppId: owner_app_id,
        chairAppId: chair_app_id,
        participantAppIds: normalizedParticipants,
      });
      if (!nextTurn) {
        // Concurrent reset by another bot — this bot is already in discussion mode,
        // tick timer will register it as participant.
        const participants = await getDiscussionParticipants(chat_id);
        return json({
          success: true,
          chat_id,
          already_active: true,
          participants,
          instruction: "讨论已由另一个 bot 开启，你已自动加入为参与者。等待系统分配轮次即可。",
        });
      }
      const participants = await getDiscussionParticipants(chat_id);
      return json({
        success: true,
        chat_id,
        leader: nextTurn.chairAppId,
        owner: nextTurn.ownerAppId,
        participants,
        instruction: "讨论已开始。首轮 owner 将在系统下一次 turn 注入时正式开场。",
      });
    },
  });
}
