import type { ResolvedFeishuAccount } from "./accounts.js";
import {
  completeDiscussionTurnWithOutput,
  isDiscussionTurnOutputAllowed,
  publishBotMessage,
} from "./discussion-state.ts";
import { stripFeishuStatusFooter } from "./feishu-message.js";
import { readGroupMode } from "./group-mode.js";
import { extractFeishuAtTextMentions } from "./mention-text.js";

type DiscussionOutboundAccount = Pick<
  ResolvedFeishuAccount,
  "accountId" | "appId" | "botOpenId" | "knownBotOpenIds" | "name"
>;

function resolveDiscussionMentionIdToAppId(
  mentionId: string,
  account: DiscussionOutboundAccount,
): string | null {
  const normalizedMentionId = mentionId.trim();
  if (!normalizedMentionId) {
    return null;
  }
  if (normalizedMentionId === account.appId || normalizedMentionId === account.botOpenId) {
    return account.appId;
  }
  const mappedAppId = account.knownBotOpenIds?.[normalizedMentionId]?.trim();
  if (mappedAppId) {
    return mappedAppId;
  }
  if (normalizedMentionId.startsWith("cli_")) {
    return normalizedMentionId;
  }
  return null;
}

export function isDiscussionChatTarget(chatId: string): boolean {
  const normalizedChatId = chatId.trim();
  return (
    normalizedChatId.startsWith("oc_") && readGroupMode(normalizedChatId).mode === "discussion"
  );
}

export interface DiscussionOutboundAuthorization {
  visibleAllowed: boolean;
  turnIsCurrent: boolean;
}

export async function resolveDiscussionOutboundAuthorization(params: {
  chatId: string;
  account: DiscussionOutboundAccount;
  expectedTurnId?: string;
}): Promise<DiscussionOutboundAuthorization> {
  const chatId = params.chatId.trim();
  if (!chatId.startsWith("oc_")) {
    return { visibleAllowed: true, turnIsCurrent: true };
  }
  if (!isDiscussionChatTarget(chatId)) {
    const turnIsCurrent = !params.expectedTurnId;
    return { visibleAllowed: turnIsCurrent, turnIsCurrent };
  }
  if (!params.expectedTurnId) {
    // No turn context (e.g. direct human command or /command) — allow visible
    // reply but never advance the turn state machine.
    return { visibleAllowed: true, turnIsCurrent: false };
  }
  const turnIsCurrent = await isDiscussionTurnOutputAllowed({
    chatId,
    ownerAppId: params.account.appId,
    expectedTurnId: params.expectedTurnId,
  });
  return { visibleAllowed: turnIsCurrent, turnIsCurrent };
}

export async function authorizeDiscussionOutboundMessage(params: {
  chatId: string;
  account: DiscussionOutboundAccount;
  expectedTurnId?: string;
}): Promise<boolean> {
  return (
    await resolveDiscussionOutboundAuthorization({
      chatId: params.chatId,
      account: params.account,
      expectedTurnId: params.expectedTurnId,
    })
  ).visibleAllowed;
}

export async function handleDiscussionOutboundMessage(params: {
  messageId: string;
  chatId: string;
  text: string;
  account: DiscussionOutboundAccount;
  completeTurn?: boolean;
  expectedTurnId?: string;
}): Promise<{
  broadcastText: string;
  prioritizedOwnerAppIds: string[];
  mentionCount: number;
  suppressed: boolean;
}> {
  const chatId = params.chatId.trim();
  const messageId = params.messageId.trim();
  const broadcastText = stripFeishuStatusFooter(params.text);
  const mentions = extractFeishuAtTextMentions(broadcastText);
  const prioritizedOwnerAppIds = [
    ...new Set(
      mentions
        .map((mention) => resolveDiscussionMentionIdToAppId(mention.id, params.account))
        .filter((appId): appId is string => Boolean(appId)),
    ),
  ];

  if (!chatId || !messageId || !isDiscussionChatTarget(chatId)) {
    return {
      broadcastText,
      prioritizedOwnerAppIds,
      mentionCount: mentions.length,
      suppressed: false,
    };
  }

  const authorization = await resolveDiscussionOutboundAuthorization({
    chatId,
    account: params.account,
    expectedTurnId: params.expectedTurnId,
  });
  if (!authorization.visibleAllowed) {
    return {
      broadcastText,
      prioritizedOwnerAppIds,
      mentionCount: mentions.length,
      suppressed: true,
    };
  }

  if (params.completeTurn !== false && authorization.turnIsCurrent) {
    await completeDiscussionTurnWithOutput({
      chatId,
      ownerAppId: params.account.appId,
      prioritizedOwnerAppIds,
      nextSourceMessageId: messageId,
    });
  }

  if (broadcastText || mentions.length > 0) {
    void publishBotMessage({
      msgId: messageId,
      chatId,
      senderAppId: params.account.appId,
      senderOpenId: params.account.botOpenId ?? params.account.appId,
      senderName: params.account.name ?? params.account.accountId,
      content: broadcastText,
      msgType: "post",
      createTime: Date.now(),
      mentions:
        mentions.length > 0
          ? mentions.map((mention) => ({
              key: mention.key,
              id: mention.id,
              name: mention.name,
            }))
          : undefined,
    });
  }

  return {
    broadcastText,
    prioritizedOwnerAppIds,
    mentionCount: mentions.length,
    suppressed: false,
  };
}
