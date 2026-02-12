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
  sendFeishuRichText,
  sendFeishuReply,
  createFeishuCardStream,
  uploadFeishuImage,
  sendFeishuImage,
  downloadFeishuImage,
  getBotOpenId,
  getFeishuChatName,
  addFeishuReaction,
  removeFeishuReaction,
  type FeishuCardStream,
} from "./outbound.js";
import { resolveGroupOwnerIds } from "./accounts.js";
import { getFeishuRuntime } from "./runtime.js";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Permission error extraction ─────────────────────────────────────────
// Detect Feishu API permission errors (code 99991672) and extract the grant URL
// so the agent can report actionable guidance instead of an opaque error.

type PermissionError = { code: number; message: string; grantUrl?: string };

export function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== "object") return null;
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;
  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };
  if (feishuErr.code !== 99991672) return null;
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  return { code: feishuErr.code, message: msg, grantUrl: urlMatch?.[0] };
}

// Cache permission-error notifications to avoid spamming on every API call.
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000;

// ── Sender name resolution (contact/v3/users) ──────────────────────────
// Resolve open_id -> display name so the agent sees "张三" not "ou_xxx".
// TTL-cached per open_id to minimise API calls.

const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

type SenderNameResult = { name?: string; permissionError?: PermissionError };

async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderOpenId: string;
  log?: ChannelLogSink;
}): Promise<SenderNameResult> {
  const { account, senderOpenId, log } = params;
  if (!senderOpenId) return {};
  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };
  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });
    const user = res?.data?.user;
    const name: string | undefined =
      user?.name ||
      user?.display_name ||
      user?.nickname ||
      user?.en_name;
    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }
    // API succeeded but returned no usable name — log for diagnostics
    log?.info(
      `[${account.accountId}] sender name lookup returned no name for ${senderOpenId}` +
        ` (code=${res?.code}, hasUser=${!!user}, keys=${user ? Object.keys(user).join(",") : "n/a"})`,
    );
    return {};
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      log?.info(`[${account.accountId}] permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    log?.info(`[${account.accountId}] failed to resolve sender name for ${senderOpenId}: ${String(err)}`);
    return {};
  }
}

// ── Quoted message content retrieval (im.message.get) ───────────────────
// When a user replies to a message, Feishu sends parent_id (the quoted msg).
// We fetch its content so the AI has the full context of what was quoted.

export type FeishuMessageInfo = {
  messageId: string;
  chatId: string;
  senderId?: string;
  content: string;
  contentType: string;
};

async function getQuotedMessageContent(params: {
  account: ResolvedFeishuAccount;
  parentMessageId: string;
  log?: ChannelLogSink;
}): Promise<FeishuMessageInfo | null> {
  const { account, parentMessageId, log } = params;
  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const response: any = await client.im.message.get({
      path: { message_id: parentMessageId },
    });
    if (response?.code !== 0) return null;
    const item = response?.data?.items?.[0];
    if (!item) return null;
    let content: string = item.body?.content ?? "";
    try {
      const parsed = JSON.parse(content);
      if (item.msg_type === "text" && parsed.text) {
        content = parsed.text;
      } else if (item.msg_type === "post" && parsed.zh_cn) {
        // Flatten post body to plain text.
        content = flattenPostBody(parsed.zh_cn) ?? content;
      }
    } catch {
      // Keep raw content if parsing fails.
    }
    return {
      messageId: item.message_id ?? parentMessageId,
      chatId: item.chat_id ?? "",
      senderId: item.sender?.id,
      content,
      contentType: item.msg_type ?? "text",
    };
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      log?.info(`[${account.accountId}] permission error fetching quoted msg: code=${permErr.code}`);
    } else {
      log?.info(`[${account.accountId}] failed to fetch quoted msg ${parentMessageId}: ${String(err)}`);
    }
    return null;
  }
}

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

/**
 * Resolve the Webchat URL for welcome messages.
 * Priority: WEBCHAT_URL env var > auto-compute from gateway config.
 * Docker containers get the env var via start-user.sh (external port mapping).
 * Local instances auto-compute from config (localhost + gateway port + token).
 */
function resolveWebchatUrl(config: OpenClawConfig): string | undefined {
  // Docker / explicit override takes priority
  const envUrl = process.env.WEBCHAT_URL;
  if (envUrl) return envUrl;

  // Auto-compute from gateway config
  const port = config.gateway?.port ?? 18789;
  const token = config.gateway?.auth?.token;
  const base = `http://localhost:${port}`;
  return token ? `${base}?token=${token}` : base;
}

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
      // Return immediately so the SDK sends the ACK frame within milliseconds.
      // Without this, Feishu's ~3-5s ACK timeout expires before the AI finishes
      // processing (6-27s observed), causing Feishu to retry at +15s/+5m/+1h/+6h.
      void handleInboundMessage(data, { account, config, log, setStatus, core }).catch(
        (err) => {
          log?.error(`[${account.accountId}] error handling message: ${String(err)}`);
        },
      );
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

// ── Group chat message archive ──────────────────────────────────────────

/** Resolve the base directory for group chat archives.
 *  Uses OPENCLAW_HOME env var if set (Docker), otherwise ~/.openclaw. */
function resolveGroupArchiveDir(): string {
  const base = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
  return join(base, "feishu-groups");
}

type GroupIndexEntry = { name: string; lastMessage: string };

/** Append a message to the group's JSONL archive and update index.json.
 *  Creates directories + files on first call for a given chatId. */
function archiveGroupMessage(params: {
  chatId: string;
  chatName: string | null;
  senderId: string;
  senderName: string;
  text: string;
  msgId: string;
}): void {
  const archiveDir = resolveGroupArchiveDir();
  const chatDir = join(archiveDir, params.chatId);

  // Ensure directories exist.
  if (!existsSync(chatDir)) {
    mkdirSync(chatDir, { recursive: true });
  }

  // Append message to JSONL.
  const record = {
    ts: Math.floor(Date.now() / 1000),
    sender: params.senderName || params.senderId,
    senderId: params.senderId,
    text: params.text,
    msgId: params.msgId,
  };
  appendFileSync(join(chatDir, "messages.jsonl"), JSON.stringify(record) + "\n");

  // Update index.json.
  const indexPath = join(archiveDir, "index.json");
  let index: Record<string, GroupIndexEntry> = {};
  try {
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }
  } catch {
    // Corrupted index — start fresh.
  }
  index[params.chatId] = {
    name: params.chatName || index[params.chatId]?.name || params.chatId,
    lastMessage: new Date().toISOString(),
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
}

// ── Mention parsing helpers ─────────────────────────────────────────────

type FeishuMention = { key: string; id: string; name?: string };

/** Parse the mentions array from the Feishu event body.
 *  SDK returns mentions[].id as an object { open_id, union_id, user_id },
 *  not a plain string. We extract the open_id for comparison. */
// oxlint-disable-next-line typescript/no-explicit-any
function parseMentions(message: any): FeishuMention[] {
  const raw = message?.mentions;
  if (!Array.isArray(raw)) return [];
  return raw
    // oxlint-disable-next-line typescript/no-explicit-any
    .filter((m: any) => m.key && m.id)
    // oxlint-disable-next-line typescript/no-explicit-any
    .map((m: any) => ({
      key: m.key as string,
      // SDK gives id as { open_id, union_id, user_id } object — extract open_id.
      id:
        typeof m.id === "object" && m.id?.open_id
          ? (m.id.open_id as string)
          : String(m.id ?? ""),
      name: m.name as string | undefined,
    }));
}

/** Extract sender name from Feishu event.
 *  Tries various SDK fields; falls back to senderId. */
// oxlint-disable-next-line typescript/no-explicit-any
function extractSenderName(sender: any): string {
  return (
    sender?.sender_id?.name ??
    sender?.sender_id?.id ??
    sender?.sender_id?.open_id ??
    ""
  );
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
  // parent_id is the message being replied to (quoted message).
  const parentId: string = message.parent_id ?? "";

  // Skip bot messages.
  if (senderType === "bot") return;

  // Debug: log raw inbound for diagnosis (create_time helps detect replayed messages).
  const createTime: string = message.create_time ?? "";
  log?.info(
    `[${account.accountId}] raw inbound: msgId=${messageId} createTime=${createTime} msgType=${msgType} from=${senderId} parentId=${parentId} content=${content.slice(0, 120)}`,
  );

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
  const isGroup = chatType === "group";

  // Allow through if: has text, is a reply (quoted msg context will be injected),
  // or is a group @mention (bot will respond based on context).
  // Only drop truly empty non-reply, non-mention messages.
  if (!cleanText && !parentId && !isGroup) return;

  log?.info(`[${account.accountId}] inbound: chat=${chatId} from=${senderId} type=${chatType}${mediaPath ? " +image" : ""}`);
  setStatus({ lastInboundAt: Date.now() });

  // ── Group chat handling: archive + owner-only reply gating ──
  if (isGroup) {
    const groupConfig = account.config.groups;
    const groupsEnabled = groupConfig?.enabled === true;

    if (!groupsEnabled) {
      log?.info(`[${account.accountId}] group chat disabled, ignoring group message`);
      return;
    }

    // Archive all group messages (regardless of who sent them).
    const shouldArchive = groupConfig?.archive !== false;
    if (shouldArchive) {
      const senderName = extractSenderName(sender);
      // Fetch chat name (cached) — fire-and-forget to not block processing.
      let chatName: string | null = null;
      try {
        chatName = await getFeishuChatName(account, chatId);
      } catch {
        // Ignore — index will use chatId as fallback name.
      }
      try {
        archiveGroupMessage({
          chatId,
          chatName,
          senderId,
          senderName: senderName || senderId,
          text: cleanText,
          msgId: messageId,
        });
        log?.info(`[${account.accountId}] archived group msg from ${senderId} in ${chatId}`);
      } catch (err) {
        log?.error(`[${account.accountId}] group archive failed: ${String(err)}`);
      }
    }

    // Parse @mentions to detect if bot was mentioned.
    const mentions = parseMentions(message);
    let botOpenId: string | null = null;
    try {
      botOpenId = await getBotOpenId(account);
    } catch (err) {
      log?.error(`[${account.accountId}] getBotOpenId failed: ${String(err)}`);
    }
    const wasMentioned = botOpenId ? mentions.some((m) => m.id === botOpenId) : false;

    log?.info(
      `[${account.accountId}] group mention check: botOpenId=${botOpenId} mentions=${JSON.stringify(mentions.map((m) => ({ key: m.key, id: m.id, name: m.name })))} wasMentioned=${wasMentioned}`,
    );

    if (!wasMentioned) {
      // Not @mentioned — just archive (already done above), don't reply.
      log?.info(`[${account.accountId}] group msg not mentioning bot, skipping reply`);
      return;
    }

    // Bot was @mentioned. Check if sender is the owner.
    const ownerIds = resolveGroupOwnerIds(account.config);
    const isOwner = ownerIds.length === 0 || ownerIds.includes(senderId);

    if (!isOwner) {
      // Non-owner @mentioned bot — stay completely silent.
      log?.info(`[${account.accountId}] non-owner ${senderId} @mentioned bot in group, ignoring`);
      return;
    }

    // Owner @mentioned bot in group — proceed to reply.
    log?.info(`[${account.accountId}] owner ${senderId} @mentioned bot in group, processing`);
  }

  // DM access control: for now use "open" policy (private bot, only you can see it).
  // Full pairing/allowlist support can be added later.

  // Send webchat URL reminder on /new (new session).
  // URL resolution: WEBCHAT_URL env var (Docker) > auto-compute from gateway config (local).
  if (cleanText === "/new") {
    const webchatUrl = resolveWebchatUrl(config);
    if (webchatUrl) {
      const welcomeText =
        `你好！我是你的 AI 助手 🤖\n\n` +
        `除了飞书对话，你还可以通过网页版和我聊天：\n${webchatUrl}\n\n` +
        `网页版支持代码高亮、文件上传等更丰富的功能。`;
      try {
        await sendFeishuRichText({ account, chatId, text: welcomeText });
        log?.info(`[${account.accountId}] welcome sent to ${senderId}`);
      } catch (err) {
        log?.error(`[${account.accountId}] welcome send failed: ${String(err)}`);
      }
    }
  }

  // ── Resolve sender display name (best-effort, non-blocking) ──
  let senderDisplayName: string | undefined;
  try {
    const nameResult = await resolveFeishuSenderName({ account, senderOpenId: senderId, log });
    senderDisplayName = nameResult.name;
    // Surface permission errors once per cooldown period so the admin knows.
    if (nameResult.permissionError) {
      const cooldownKey = account.appId ?? "default";
      const lastNotified = permissionErrorNotifiedAt.get(cooldownKey) ?? 0;
      if (Date.now() - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
        permissionErrorNotifiedAt.set(cooldownKey, Date.now());
        log?.error(
          `[${account.accountId}] Feishu permission error (sender name): ${nameResult.permissionError.message}` +
            (nameResult.permissionError.grantUrl ? ` Grant: ${nameResult.permissionError.grantUrl}` : ""),
        );
      }
    }
  } catch {
    // Best-effort — continue without display name.
  }
  if (senderDisplayName) {
    log?.info(`[${account.accountId}] sender resolved: ${senderId} -> ${senderDisplayName}`);
  }

  // ── Fetch quoted message content (if this is a reply) ──
  let quotedContext = "";
  if (parentId) {
    try {
      const quoted = await getQuotedMessageContent({ account, parentMessageId: parentId, log });
      if (quoted?.content) {
        quotedContext = `\n[Quoted message: "${quoted.content.slice(0, 500)}"]`;
        log?.info(`[${account.accountId}] quoted msg fetched: ${parentId} -> ${quoted.content.slice(0, 80)}`);
      }
    } catch (err) {
      log?.info(`[${account.accountId}] quoted msg fetch failed: ${String(err)}`);
    }
  }

  // Resolve agent route for this message.
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "feishu",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "dm", id: chatId },
  });

  // Build envelope for the agent.
  // Include sender display name and quoted context in the body so the AI sees them.
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const enrichedFrom = senderDisplayName ? `${senderDisplayName} (${senderId})` : senderId;
  const enrichedBody = cleanText + quotedContext;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: enrichedFrom,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedBody,
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
    // Private bot: all senders are authorized to use commands (/new, /reset, etc.).
    CommandAuthorized: true,
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

  // ── Card stream for typing / typewriter effect ──
  // Skip for commands (/new, /reset etc.) which have their own response flow.
  const isCommand = cleanText.startsWith("/");
  let cardStream: FeishuCardStream | undefined;

  // onReplyStart: create the card stream when the AI actually starts processing
  // (after session lane queuing — never fires for queued messages).
  const startCardStream = async () => {
    if (isCommand || cardStream) return;
    try {
      cardStream = await createFeishuCardStream({
        account,
        chatId,
        log: (msg) => log?.info(`[${account.accountId}] ${msg}`),
        warn: (msg) => log?.error(`[${account.accountId}] ${msg}`),
      });
      if (cardStream.started) {
        log?.info(`[${account.accountId}] card stream started`);
      }
    } catch (err) {
      log?.error(`[${account.accountId}] card stream create failed: ${String(err)}`);
    }
  };

  // Track completed paragraphs across assistant messages.
  // onPartialReply text is per-paragraph (deltaBuffer resets each assistant message).
  // We detect paragraph boundaries by checking if the new text is a continuation of
  // the previous text — if not, a new assistant message started and we freeze the
  // previous paragraph into the prefix.
  let cardStreamPrefix = "";
  let cardStreamLastPartial = "";
  let cardStreamFinalText = "";

  const updateCardStream = (text?: string) => {
    if (!text || !cardStream?.started) return;
    // Detect paragraph boundary: if text doesn't start with the previous partial,
    // it means deltaBuffer was reset (new assistant message). Freeze the previous
    // paragraph into the prefix.
    if (cardStreamLastPartial && !text.startsWith(cardStreamLastPartial)) {
      cardStreamPrefix = cardStreamPrefix
        ? cardStreamPrefix + "\n\n" + cardStreamLastPartial
        : cardStreamLastPartial;
    }
    cardStreamLastPartial = text;
    // Combine finished paragraphs with the current in-progress paragraph.
    const full = cardStreamPrefix ? cardStreamPrefix + "\n\n" + text : text;
    cardStream.update(full);
  };

  const stopCardStream = async () => {
    if (!cardStream?.started) return;
    // 1. Stop accepting new updates and cancel any scheduled timer.
    //    This prevents stray delayed flushes from firing after finalize.
    cardStream.stop();
    // 2. Push the full accumulated text as one final card update.
    //    onPartialReply may miss the tail of the last paragraph because deliver()
    //    can fire after the last partial — ensure the card shows the complete text.
    if (cardStreamFinalText) {
      await cardStream.sendFinal(cardStreamFinalText);
    }
    // 3. Close streaming mode so "[生成中...]" clears.
    await cardStream.finalize(cardStreamFinalText);
  };

  // ── ACK reaction: add a "typing" emoji when we start processing ──
  // Shows users an immediate visual indicator that their message was received.
  // The emoji is removed after the reply is delivered (like the test bot behavior).
  const ACK_EMOJI = "Get";
  let ackReactionId: string | null = null;
  const addAckReaction = async () => {
    if (isCommand) return;
    try {
      ackReactionId = await addFeishuReaction({ account, messageId, emoji: ACK_EMOJI });
      if (ackReactionId) {
        log?.info(`[${account.accountId}] added ACK reaction (${ACK_EMOJI}) to ${messageId}`);
      }
    } catch (err) {
      // Non-fatal: ACK reaction is a UX nicety, not critical.
      log?.info(`[${account.accountId}] ACK reaction failed: ${String(err)}`);
    }
  };
  const removeAckReaction = async () => {
    if (!ackReactionId) return;
    try {
      await removeFeishuReaction({ account, messageId, reactionId: ackReactionId });
      log?.info(`[${account.accountId}] removed ACK reaction from ${messageId}`);
    } catch (err) {
      log?.info(`[${account.accountId}] ACK reaction removal failed: ${String(err)}`);
    }
    ackReactionId = null;
  };

  // Dispatch through the auto-reply pipeline and deliver response.
  // Strategy: onPartialReply drives the card typewriter (streaming display).
  // deliver only accumulates text for finalize — it does NOT update the card,
  // because onPartialReply already streamed the same content.
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        log?.info(
          `[${account.accountId}] deliver: kind=${info.kind} hasText=${!!payload.text} textLen=${payload.text?.length ?? 0} hasMedia=${!!(payload.mediaUrls?.length || payload.mediaUrl)}`,
        );

        const hasMedia = !!(payload.mediaUrls?.length || payload.mediaUrl);

        if (cardStream?.started && payload.text) {
          // deliver is called after the entire turn ends (all paragraphs at once).
          // onPartialReply + paragraph boundary detection already displayed everything.
          // Just accumulate text for finalize (summary). Do NOT update the card.
          cardStreamFinalText = cardStreamFinalText
            ? cardStreamFinalText + "\n\n" + payload.text
            : payload.text;
          log?.info(`[${account.accountId}] deliver: text accumulated for finalize (${cardStreamFinalText.length} chars total)`);
          setStatus({ lastOutboundAt: Date.now() });

          // Media attachments still need separate delivery.
          if (hasMedia) {
            await deliverFeishuReply({
              payload: { mediaUrls: payload.mediaUrls, mediaUrl: payload.mediaUrl },
              account,
              chatId,
              isGroup,
              replyToMessageId: isGroup ? messageId : undefined,
              log,
              setStatus,
              config,
              core,
            });
          }
          return;
        }

        // Card stream not active or no text — deliver normally.
        await deliverFeishuReply({
          payload,
          account,
          chatId,
          isGroup,
          replyToMessageId: isGroup ? messageId : undefined,
          log,
          setStatus,
          config,
          core,
        });
      },
      onError: (err, info) => {
        log?.error(`[${account.accountId}] Feishu ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: async () => {
        // Fire ACK reaction and card stream in parallel when AI starts processing.
        await Promise.all([addAckReaction(), startCardStream()]);
      },
    },
    replyOptions: {
      // Disable block streaming when card stream is active (non-command messages).
      // onPartialReply exclusively drives the card typewriter effect.
      disableBlockStreaming: !isCommand,
      onPartialReply: !isCommand
        ? (payload) => updateCardStream(payload.text)
        : undefined,
    },
  });
  // Ensure card stream is stopped and ACK reaction is removed after dispatch completes.
  await Promise.all([
    cardStream?.started ? stopCardStream() : Promise.resolve(),
    removeAckReaction(),
  ]);
}

// ── Reply delivery ──────────────────────────────────────────────────────

async function deliverFeishuReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedFeishuAccount;
  chatId: string;
  isGroup?: boolean;
  replyToMessageId?: string;
  log?: ChannelLogSink;
  setStatus: (patch: Partial<ChannelAccountSnapshot>) => void;
  config: OpenClawConfig;
  core: ReturnType<typeof getFeishuRuntime>;
}): Promise<void> {
  const { payload, account, chatId, isGroup, replyToMessageId, log, setStatus, config, core } = params;

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
    for (let ci = 0; ci < chunks.length; ci++) {
      try {
        // In group chats, first chunk uses quote-reply to the original message.
        if (isGroup && replyToMessageId && ci === 0) {
          await sendFeishuReply({ account, messageId: replyToMessageId, text: chunks[ci] });
        } else {
          await sendFeishuRichText({ account, chatId, text: chunks[ci] });
        }
        setStatus({ lastOutboundAt: Date.now() });
      } catch (err) {
        log?.error(`Feishu send failed: ${String(err)}`);
      }
    }
  }
}
