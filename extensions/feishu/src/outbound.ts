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

/** Upload an image buffer to Feishu and return the image_key.
 *  Uses raw HTTP API because the SDK's `image_file` param name
 *  doesn't match the actual API field name `image`. */
export async function uploadFeishuImage(params: {
  account: ResolvedFeishuAccount;
  buffer: Buffer;
}): Promise<string> {
  const client = getFeishuClient(params.account);
  // Obtain tenant access token via the SDK's token manager.
  // oxlint-disable-next-line typescript/no-explicit-any
  const token = await (client as any).tokenManager.getTenantAccessToken({});
  if (!token) throw new Error("Feishu: failed to obtain tenant access token");

  const blob = new Blob([params.buffer]);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", blob, "image.jpg");

  const res = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json();
  if (json.code !== 0 || !json.data?.image_key) {
    throw new Error(`Feishu image upload failed: code=${json.code} msg=${json.msg}`);
  }
  return json.data.image_key;
}

/** Download an image from a Feishu message using the message resource API.
 *  Requires `im:message` or `im:resource` permission.
 *  Returns the raw image buffer, or null if download fails. */
export async function downloadFeishuImage(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  imageKey: string;
}): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const client = getFeishuClient(params.account);
  const resp = await client.im.messageResource.get({
    params: { type: "image" },
    path: { message_id: params.messageId, file_key: params.imageKey },
  });
  if (!resp) return null;
  const stream = resp.getReadableStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const buffer = Buffer.concat(chunks);
  // Try to extract content-type from response headers.
  // oxlint-disable-next-line typescript/no-explicit-any
  const headers = resp.headers as any;
  const contentType =
    (typeof headers?.get === "function" ? headers.get("content-type") : headers?.["content-type"]) ??
    "image/jpeg";
  return { buffer, contentType: typeof contentType === "string" ? contentType : "image/jpeg" };
}

/** Send an image message to a Feishu chat or user. */
export async function sendFeishuImage(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  imageKey: string;
  caption?: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content: JSON.stringify({ image_key: params.imageKey }),
      msg_type: "image",
    },
  });
  // Send caption as a follow-up text message if provided.
  if (params.caption) {
    await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: params.caption }),
        msg_type: "text",
      },
    });
  }
}
