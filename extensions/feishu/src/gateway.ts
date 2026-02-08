/**
 * Feishu Gateway: WebSocket long connection for receiving messages.
 *
 * Uses @larksuiteoapi/node-sdk WSClient to establish a persistent connection
 * to Feishu servers. Received messages are forwarded to OpenClaw's auto-reply pipeline.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelAccountSnapshot, ChannelLogSink, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";
import {
  getFeishuClient,
  sendFeishuText,
  uploadFeishuImage,
  sendFeishuImage,
  downloadFeishuImage,
} from "./outbound.js";
import { getFeishuRuntime } from "./runtime.js";

export type FeishuGatewayOptions = {
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
};

// Dedupe recent messages (Feishu may re-deliver on timeout).
const recentMessageIds = new Set<string>();
const MAX_RECENT = 500;

function trackMessageId(messageId: string): boolean {
  if (recentMessageIds.has(messageId)) {
    return false;
  }
  recentMessageIds.add(messageId);
  if (recentMessageIds.size > MAX_RECENT) {
    const first = recentMessageIds.values().next().value;
    if (first) recentMessageIds.delete(first);
  }
  return true;
}

/** Flatten a post body ({ title?, content: [[{tag,text}, ...]] }) into plain text.
 *  Also collects any embedded image_key values for downstream download. */
// oxlint-disable-next-line typescript/no-explicit-any
function flattenPostBody(body: any, imageKeys?: string[]): string | null {
  if (!body || !Array.isArray(body.content)) return null;
  const lines: string[] = [];
  for (const paragraph of body.content) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const el of paragraph) {
      if (el.tag === "text" || el.tag === "a") line += el.text ?? "";
      else if (el.tag === "at") line += el.user_id ? `@_user_${el.user_id}` : "";
      else if (el.tag === "img") {
        // Collect image keys for download; replace with placeholder in text.
        if (el.image_key && imageKeys) imageKeys.push(el.image_key);
        line += "<media:image>";
      } else if (el.tag === "media") line += "[media]";
      else if (el.tag === "emotion") line += el.emoji_type ? `[${el.emoji_type}]` : "";
    }
    lines.push(line);
  }
  const title = typeof body.title === "string" && body.title ? `${body.title}\n` : "";
  return `${title}${lines.join("\n")}`.trim() || null;
}

/** Extract plain text from a Feishu "post" (rich-text) message.
 *  Received format: { title?, content: [[...]] }  (flat, no locale wrapper)
 *  Send format:     { zh_cn: { title?, content: [[...]] } }  (locale-wrapped)
 *  We handle both so the parser is robust.
 *  imageKeys: collects any embedded image_key values for downstream download. */
function extractPostText(parsed: Record<string, unknown>, imageKeys?: string[]): string | null {
  // Received messages use the flat format (title + content at top level).
  if (Array.isArray(parsed.content)) {
    return flattenPostBody(parsed, imageKeys);
  }
  // Fallback: locale-wrapped format (zh_cn / en_us / first key).
  // oxlint-disable-next-line typescript/no-explicit-any
  const locales = parsed as Record<string, any>;
  const locale = locales.zh_cn ?? locales.en_us ?? Object.values(locales)[0];
  return flattenPostBody(locale, imageKeys);
}

/** Extract plain text from Feishu message content JSON.
 *  imageKeys: collects image_key values from post messages and standalone image messages. */
function extractTextContent(
  content: string,
  msgType: string,
  imageKeys?: string[],
): string | null {
  try {
    const parsed = JSON.parse(content);
    if (msgType === "text") {
      return (parsed.text as string) ?? null;
    }
    // Rich-text (post) messages: flatten nested paragraphs into plain text.
    // Embedded img tags have their image_key collected for download.
    if (msgType === "post") {
      return extractPostText(parsed, imageKeys);
    }
    // Standalone image messages: collect image_key for download.
    if (msgType === "image") {
      if (parsed.image_key && imageKeys) imageKeys.push(parsed.image_key);
      return null; // Handled in handleInboundMessage.
    }
    if (msgType === "file") return "[file]";
    if (msgType === "audio") return "[audio]";
    if (msgType === "sticker") return "[sticker]";
    return null;
  } catch {
    return null;
  }
}

export async function startFeishuGateway(opts: FeishuGatewayOptions): Promise<void> {
  const { account, config, abortSignal, log, setStatus } = opts;
  const core = getFeishuRuntime();

  log?.info(`[${account.accountId}] connecting Feishu WSClient...`);

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      try {
        await handleInboundMessage(data, { account, config, log, setStatus, core });
      } catch (err) {
        log?.error(`[${account.accountId}] error handling message: ${String(err)}`);
      }
    },
  });

  const wsClient = new Lark.WSClient({
    appId: account.appId,
    appSecret: account.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher });

  log?.info(`[${account.accountId}] Feishu WSClient connected`);
  setStatus({ connected: true, lastConnectedAt: Date.now() });

  // Block until abort signal fires (gateway shutting down).
  return new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener(
      "abort",
      () => {
        log?.info(`[${account.accountId}] Feishu gateway stopping`);
        setStatus({ running: false, connected: false, lastStopAt: Date.now() });
        resolve();
      },
      { once: true },
    );
  });
}

// ── Inbound message processing ──────────────────────────────────────────

type InboundDeps = {
  account: ResolvedFeishuAccount;
  config: OpenClawConfig;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
  core: ReturnType<typeof getFeishuRuntime>;
};

// oxlint-disable-next-line typescript/no-explicit-any
async function handleInboundMessage(data: any, deps: InboundDeps): Promise<void> {
  const { account, config, log, setStatus, core } = deps;
  const message = data.message;
  const sender = data.sender;

  if (!message || !sender) return;

  const messageId: string = message.message_id ?? "";
  const chatId: string = message.chat_id ?? "";
  const chatType: string = message.chat_type ?? ""; // "p2p" | "group"
  const msgType: string = message.message_type ?? "text";
  const content: string = message.content ?? "{}";
  const senderId: string = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? "";
  const senderType: string = sender.sender_type ?? "";

  // Skip bot messages.
  if (senderType === "bot") return;

  // Deduplicate.
  if (messageId && !trackMessageId(messageId)) return;

  // ── Extract text and collect embedded image keys ──
  const imageKeys: string[] = [];
  const rawText = extractTextContent(content, msgType, imageKeys);

  // ── Download images (standalone image msgs + images embedded in post) ──
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  if (imageKeys.length > 0 && messageId) {
    for (const imageKey of imageKeys) {
      try {
        log?.info(`[${account.accountId}] downloading image: key=${imageKey} msg=${messageId}`);
        const imgData = await downloadFeishuImage({ account, messageId, imageKey });
        if (imgData) {
          const saved = await core.channel.media.saveMediaBuffer(
            imgData.buffer,
            imgData.contentType,
            "inbound",
          );
          mediaPaths.push(saved.path);
          mediaTypes.push(saved.contentType ?? imgData.contentType ?? "image/jpeg");
          log?.info(`[${account.accountId}] image saved: ${saved.path}`);
        }
      } catch (err) {
        log?.error(`[${account.accountId}] image download failed (key=${imageKey}): ${String(err)}`);
      }
    }
    // Primary media fields use the first image.
    if (mediaPaths.length > 0) {
      mediaPath = mediaPaths[0];
      mediaType = mediaTypes[0];
    }
  }

  // For image-only messages, use a placeholder if no text was extracted.
  const textFromMessage = rawText ?? (mediaPath ? "<media:image>" : null);
  if (!textFromMessage) {
    // Debug: log unrecognized message types so we can add support.
    log?.info(`[${account.accountId}] skipped msg: msgType=${msgType} content=${content.slice(0, 200)}`);
    return;
  }

  // Strip @mentions (Feishu uses @_user_N patterns in text).
  const cleanText = textFromMessage.replace(/@_user_\d+/g, "").trim();
  if (!cleanText) return;

  const isGroup = chatType === "group";

  log?.info(`[${account.accountId}] inbound: chat=${chatId} from=${senderId} type=${chatType}${mediaPath ? " +image" : ""}`);
  setStatus({ lastInboundAt: Date.now() });

  // DM access control: for now use "open" policy (private bot, only you can see it).
  // Full pairing/allowlist support can be added later.

  // Resolve agent route for this message.
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "feishu",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "dm", id: chatId },
  });

  // Build envelope for the agent.
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: senderId,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: cleanText,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: cleanText,
    CommandBody: cleanText,
    From: `feishu:${senderId}`,
    To: `feishu:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: senderId,
    SenderId: senderId,
    Provider: "feishu",
    Surface: "feishu",
    MessageSid: messageId,
    MessageSidFull: messageId,
    ReplyToId: messageId,
    OriginatingChannel: "feishu",
    OriginatingTo: `feishu:${chatId}`,
    // Attach image media for vision processing if downloaded.
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  });

  // Record session metadata (fire-and-forget).
  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      log?.error(`feishu: failed updating session meta: ${String(err)}`);
    });

  // Dispatch through the auto-reply pipeline and deliver response.
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverFeishuReply({
          payload,
          account,
          chatId,
          log,
          setStatus,
          config,
          core,
        });
      },
      onError: (err, info) => {
        log?.error(`[${account.accountId}] Feishu ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

// ── Reply delivery ──────────────────────────────────────────────────────

async function deliverFeishuReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedFeishuAccount;
  chatId: string;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
  config: OpenClawConfig;
  core: ReturnType<typeof getFeishuRuntime>;
}): Promise<void> {
  const { payload, account, chatId, log, setStatus, config, core } = params;

  // Handle media (images) if present.
  const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  for (const url of mediaUrls) {
    try {
      const media = await core.channel.media.fetchRemoteMedia({ url });
      if (!media?.buffer) {
        log?.error(`Feishu media fetch returned empty for ${url}`);
        continue;
      }
      // Feishu image upload supports JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO.
      const isImage = !media.contentType || media.contentType.startsWith("image/");
      if (isImage) {
        const imageKey = await uploadFeishuImage({ account, buffer: media.buffer });
        await sendFeishuImage({ account, chatId, imageKey });
        setStatus({ lastOutboundAt: Date.now() });
      } else {
        // Non-image media: send URL as text fallback.
        await sendFeishuText({ account, chatId, text: `[media] ${url}` });
        setStatus({ lastOutboundAt: Date.now() });
      }
    } catch (err) {
      log?.error(`Feishu media send failed for ${url}: ${String(err)}`);
      // Fallback: send URL as text.
      try {
        await sendFeishuText({ account, chatId, text: `[media] ${url}` });
      } catch { /* ignore fallback error */ }
    }
  }

  if (payload.text) {
    const chunkLimit = 4000;
    const chunkMode = core.channel.text.resolveChunkMode(config, "feishu", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendFeishuText({ account, chatId, text: chunk });
        setStatus({ lastOutboundAt: Date.now() });
      } catch (err) {
        log?.error(`Feishu send failed: ${String(err)}`);
      }
    }
  }
}
