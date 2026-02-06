/**
 * Feishu Gateway: WebSocket long connection for receiving messages.
 *
 * Uses @larksuiteoapi/node-sdk WSClient to establish a persistent connection
 * to Feishu servers. Received messages are forwarded to OpenClaw's auto-reply pipeline.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelAccountSnapshot, ChannelLogSink, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { getFeishuClient, sendFeishuText } from "./outbound.js";
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

/** Extract plain text from Feishu message content JSON. */
function extractTextContent(content: string, msgType: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (msgType === "text") {
      return (parsed.text as string) ?? null;
    }
    if (msgType === "image") return "[image]";
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

  const rawText = extractTextContent(content, msgType);
  if (!rawText) return;

  // Strip @mentions (Feishu uses @_user_N patterns in text).
  const cleanText = rawText.replace(/@_user_\d+/g, "").trim();
  if (!cleanText) return;

  const isGroup = chatType === "group";

  log?.info(`[${account.accountId}] inbound: chat=${chatId} from=${senderId} type=${chatType}`);
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
