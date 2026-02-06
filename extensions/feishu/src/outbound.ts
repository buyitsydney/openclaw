import * as Lark from "@larksuiteoapi/node-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";

// Cache Lark clients per appId to avoid redundant token fetches.
const clientCache = new Map<string, Lark.Client>();

export function getFeishuClient(account: ResolvedFeishuAccount): Lark.Client {
  const key = account.appId;
  let client = clientCache.get(key);
  if (!client) {
    client = new Lark.Client({
      appId: account.appId,
      appSecret: account.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
    clientCache.set(key, client);
  }
  return client;
}

/**
 * Strip the optional `feishu:` routing prefix that routeReply may prepend,
 * then infer the Feishu receive_id_type from the ID prefix:
 *   oc_ -> chat_id, ou_ -> open_id, on_ -> union_id, else open_id.
 */
function resolveReceiveId(raw: string): {
  receiveId: string;
  receiveIdType: "chat_id" | "open_id" | "union_id";
} {
  const stripped = raw.replace(/^feishu:/i, "");
  if (stripped.startsWith("oc_")) return { receiveId: stripped, receiveIdType: "chat_id" };
  if (stripped.startsWith("ou_")) return { receiveId: stripped, receiveIdType: "open_id" };
  if (stripped.startsWith("on_")) return { receiveId: stripped, receiveIdType: "union_id" };
  // Default to open_id for unknown prefixes.
  return { receiveId: stripped, receiveIdType: "open_id" };
}

/** Send a plain text message to a Feishu chat or user. */
export async function sendFeishuText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content: JSON.stringify({ text: params.text }),
      msg_type: "text",
    },
  });
}

/** Send a reply to a specific message (quote-reply). */
export async function sendFeishuReply(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  text: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  await client.im.message.reply({
    path: { message_id: params.messageId },
    data: {
      content: JSON.stringify({ text: params.text }),
      msg_type: "text",
    },
  });
}
