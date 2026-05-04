/**
 * discussion-hooks.ts — Discussion Mode integration via OpenClaw Plugin SDK hooks.
 *
 * Three-component architecture: feishu-her no longer owns the "feishu" channel.
 * Instead, it uses plugin hooks to gate inbound/outbound and inject synthetic
 * turns via api.runtime.subagent.run(). Zero coupling to openclaw-lark.
 *
 * Hook events used:
 *   before_dispatch  — gate non-owner bots (suppress their agent processing)
 *   message_sending  — cancel unauthorized outbound messages
 *   message_sent     — advance turn state + broadcast to peers
 *   message_received — track user activity for auto-exit timer
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import type { ResolvedFeishuAccount } from "./accounts.js";
import {
  claimDiscussionAssignedTurn,
  completeDiscussionTurnWithOutput,
  discussionTick,
  getDiscussionTurn,
  isDiscussionTurnOutputAllowed,
  maybeExpireDiscussionTurn,
  publishBotMessage,
  recordDiscussionActivity,
  subscribeBotMessages,
} from "./discussion-state.ts";
import { readGroupMode, readGroupModeAsync } from "./group-mode.js";
import { listTrackedGroups } from "./group-mode.js";
import { extractFeishuAtTextMentions } from "./mention-text.js";
import { stripFeishuStatusFooter } from "./feishu-message.js";

const TICK_INTERVAL_MS = 10_000;
const discussionTurnActive = new Map<string, Promise<void>>();

interface DiscussionHooksDeps {
  api: OpenClawPluginApi;
  account: ResolvedFeishuAccount;
}

/**
 * Register Discussion Mode hooks on the OpenClaw plugin API.
 * Call this once during plugin register().
 */
export function registerDiscussionHooks(deps: DiscussionHooksDeps): { cleanup: () => void } {
  const { api, account } = deps;

  // ── Hook 1: before_dispatch — turn gating ─────────────────────────────
  // Suppress agent processing for bots that are not the current turn owner.
  api.registerHook("before_dispatch", async (event: any, ctx: any) => {
    if (ctx.channelId !== "feishu" || !event.isGroup) return;
    const sessionKey = ctx.sessionKey as string | undefined;
    if (!sessionKey) return;

    const chatId = extractChatIdFromSessionKey(sessionKey);
    if (!chatId || !chatId.startsWith("oc_")) return;

    const mode = readGroupMode(chatId);
    if (mode.mode !== "discussion") return;

    const turn = await getDiscussionTurn(chatId);
    if (!turn || turn.ownerAppId !== account.appId) {
      return { handled: true };
    }
  }, { name: "discussion-turn-gate" } as any);

  // ── Hook 2: message_sending — outbound safety net ─────────────────────
  api.registerHook("message_sending", async (event: any, ctx: any) => {
    if (ctx.channelId !== "feishu") return;
    const sessionKey = ctx.sessionKey as string | undefined;
    if (!sessionKey) return;

    const chatId = extractChatIdFromSessionKey(sessionKey);
    if (!chatId || !chatId.startsWith("oc_")) return;

    const mode = readGroupMode(chatId);
    if (mode.mode !== "discussion") return;

    const isAllowed = await isDiscussionTurnOutputAllowed({
      chatId,
      ownerAppId: account.appId,
    });
    if (!isAllowed) {
      return { cancel: true };
    }
  }, { name: "discussion-outbound-gate" } as any);

  // ── Hook 3: message_sent — advance turn + broadcast ───────────────────
  api.registerHook("message_sent", async (event: any, ctx: any) => {
    if (ctx.channelId !== "feishu") return;
    const sessionKey = ctx.sessionKey as string | undefined;
    if (!sessionKey) return;

    const chatId = extractChatIdFromSessionKey(sessionKey);
    if (!chatId || !chatId.startsWith("oc_")) return;

    const mode = readGroupMode(chatId);
    if (mode.mode !== "discussion") return;

    const text = stripFeishuStatusFooter(event.content ?? "");
    const mentions = extractFeishuAtTextMentions(text);
    const prioritizedOwnerAppIds = resolveDiscussionMentionIds(mentions, account);

    const turn = await getDiscussionTurn(chatId);
    if (turn && turn.ownerAppId === account.appId) {
      await completeDiscussionTurnWithOutput({
        chatId,
        ownerAppId: account.appId,
        prioritizedOwnerAppIds,
        nextSourceMessageId: event.messageId ?? `hook-sent-${Date.now()}`,
      });
    }

    if (text || mentions.length > 0) {
      void publishBotMessage({
        msgId: event.messageId ?? `hook-sent-${Date.now()}`,
        chatId,
        senderAppId: account.appId,
        senderOpenId: account.botOpenId ?? account.appId,
        senderName: account.name ?? account.accountId,
        content: text,
        msgType: "post",
        createTime: Date.now(),
        mentions: mentions.length > 0
          ? mentions.map((m) => ({ key: m.key, id: m.id, name: m.name }))
          : undefined,
      });
    }
  }, { name: "discussion-turn-advance" } as any);

  // ── Hook 4: message_received — track user activity ────────────────────
  api.registerHook("message_received", async (event: any, ctx: any) => {
    if (ctx.channelId !== "feishu") return;
    const sessionKey = ctx.sessionKey as string | undefined;
    if (!sessionKey) return;

    const chatId = extractChatIdFromSessionKey(sessionKey);
    if (!chatId || !chatId.startsWith("oc_")) return;

    const mode = readGroupMode(chatId);
    if (mode.mode !== "discussion") return;

    await recordDiscussionActivity(chatId);
  }, { name: "discussion-activity-tracker" } as any);

  // ── Timer: 10s tick + synthetic turn injection ─────────────────────────
  const tickTimer = setInterval(async () => {
    try {
      const trackedGroups = await listTrackedGroups();
      for (const chatId of trackedGroups) {
        if (!chatId.startsWith("oc_")) continue;

        const mode = await readGroupModeAsync(chatId);
        const isDiscussion = mode.mode === "discussion";

        await discussionTick({
          chatId,
          myAppId: account.appId,
          isDiscussionMode: isDiscussion,
        });

        if (!isDiscussion) continue;

        await maybeExpireDiscussionTurn({ chatId, nowMs: Date.now() });

        if (discussionTurnActive.has(chatId)) continue;

        const currentTurn = await getDiscussionTurn(chatId);
        if (
          !currentTurn ||
          currentTurn.ownerAppId !== account.appId ||
          currentTurn.phase !== "assigned"
        ) continue;

        const claimedTurn = await claimDiscussionAssignedTurn({
          chatId,
          myAppId: account.appId,
          nowMs: Date.now(),
        });
        if (!claimedTurn) continue;

        const turnPromise = injectSyntheticTurn(api, account, chatId, claimedTurn)
          .catch((err) => {
            api.logger.error?.(`discussion-hooks: tick inject failed for ${chatId}: ${String(err)}`);
          })
          .finally(() => { discussionTurnActive.delete(chatId); });
        discussionTurnActive.set(chatId, turnPromise);
      }
    } catch (err) {
      api.logger.error?.(`discussion-hooks: tick error: ${String(err)}`);
    }
  }, TICK_INTERVAL_MS);

  // ── Redis pub/sub: fast-path turn claim ────────────────────────────────
  subscribeBotMessages(account.appId, (msg) => {
    const mode = readGroupMode(msg.chatId);
    if (mode.mode !== "discussion") return;

    const broadcastChatId = msg.chatId.trim();
    if (!broadcastChatId.startsWith("oc_") || discussionTurnActive.has(broadcastChatId)) return;

    claimDiscussionAssignedTurn({
      chatId: broadcastChatId,
      myAppId: account.appId,
      nowMs: Date.now(),
    }).then((claimedTurn) => {
      if (!claimedTurn || discussionTurnActive.has(broadcastChatId)) return;

      const promise = injectSyntheticTurn(api, account, broadcastChatId, claimedTurn)
        .catch((err) => {
          api.logger.error?.(`discussion-hooks: fast-claim inject failed for ${broadcastChatId}: ${String(err)}`);
        })
        .finally(() => { discussionTurnActive.delete(broadcastChatId); });
      discussionTurnActive.set(broadcastChatId, promise);
    }).catch(() => {});
  });

  return {
    cleanup() {
      clearInterval(tickTimer);
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractChatIdFromSessionKey(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":");
  const groupIdx = parts.indexOf("group");
  if (groupIdx >= 0 && groupIdx + 1 < parts.length) {
    return parts[groupIdx + 1];
  }
  return undefined;
}

function resolveDiscussionMentionIds(
  mentions: Array<{ key: string; id: string; name: string }>,
  account: ResolvedFeishuAccount,
): string[] {
  return [
    ...new Set(
      mentions
        .map((m) => {
          const id = m.id.trim();
          if (!id) return null;
          if (id === account.appId || id === account.botOpenId) return account.appId;
          const mapped = account.knownBotOpenIds?.[id]?.trim();
          if (mapped) return mapped;
          if (id.startsWith("cli_")) return id;
          return null;
        })
        .filter((appId): appId is string => Boolean(appId)),
    ),
  ];
}

// Synthetic turn injection via api.runtime.subagent.run(). The session key
// encodes feishu:group:chatId so the gateway routes the reply to the correct
// Feishu group chat without us importing any channel internals.
async function injectSyntheticTurn(
  api: OpenClawPluginApi,
  account: ResolvedFeishuAccount,
  chatId: string,
  turn: { turnId: string; sourceMessageId: string },
): Promise<void> {
  const sessionKey = `agent:${account.accountId}:feishu:group:${chatId}`;
  const message = [
    "[discussion-turn] 系统已将当前轮次分配给你。",
    "请基于最近群消息直接推进；如果你本轮不发言，输出 NO_REPLY 即可。",
    "系统会在你结束后自动调度下一位。",
  ].join("");

  await api.runtime.subagent.run({
    sessionKey,
    message,
    deliver: true,
    idempotencyKey: `discussion-turn:${chatId}:${turn.turnId}:${Date.now()}`,
  });
}
