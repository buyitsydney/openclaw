import type { FeishuReplyRef } from "./feishu-message.js";

function trimIfString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type FeishuSentMessageRef = {
  messageId: string;
  chatId?: string;
  messageType: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
  createTime?: string;
};

export function buildFeishuReplyRef(params: {
  parentId?: string | null;
  rootId?: string | null;
  threadId?: string | null;
  hasThread?: boolean | null;
  quoted?: FeishuReplyRef["quoted"];
}): FeishuReplyRef | undefined {
  const parentId = trimIfString(params.parentId);
  const rootId = trimIfString(params.rootId);
  const threadId = trimIfString(params.threadId);
  const hasThread = params.hasThread === true || Boolean(threadId);
  if (!parentId && !rootId && !threadId && !hasThread && !params.quoted) {
    return undefined;
  }
  return {
    ...(parentId && { parentId }),
    ...(rootId && { rootId }),
    ...(threadId && { threadId }),
    ...(hasThread && { hasThread: true }),
    ...(params.quoted && { quoted: params.quoted }),
  };
}

export function buildFeishuSentMessageRef(
  raw: {
    message_id?: unknown;
    chat_id?: unknown;
    msg_type?: unknown;
    parent_id?: unknown;
    root_id?: unknown;
    thread_id?: unknown;
    create_time?: unknown;
  },
  fallback: {
    chatId?: string;
    messageType: string;
  },
): FeishuSentMessageRef | undefined {
  const messageId = trimIfString(raw.message_id);
  if (!messageId) {
    return undefined;
  }
  const chatId = trimIfString(raw.chat_id) || trimIfString(fallback.chatId) || undefined;
  const messageType = trimIfString(raw.msg_type) || trimIfString(fallback.messageType) || "text";
  const parentId = trimIfString(raw.parent_id) || undefined;
  const rootId = trimIfString(raw.root_id) || undefined;
  const threadId = trimIfString(raw.thread_id) || undefined;
  const createTime = trimIfString(raw.create_time) || undefined;
  return {
    messageId,
    ...(chatId && { chatId }),
    messageType,
    ...(parentId && { parentId }),
    ...(rootId && { rootId }),
    ...(threadId && { threadId }),
    ...(createTime && { createTime }),
  };
}

export function buildFeishuReplyRefFromSentMessage(
  message: FeishuSentMessageRef | null | undefined,
): FeishuReplyRef | undefined {
  if (!message) {
    return undefined;
  }
  return buildFeishuReplyRef({
    parentId: message.parentId,
    rootId: message.rootId,
    threadId: message.threadId,
  });
}
