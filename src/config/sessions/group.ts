import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeHyphenSlug } from "../../shared/string-normalization.js";
import { listDeliverableMessageChannels } from "../../utils/message-channel.js";
import type { GroupKeyResolution } from "./types.js";

const getGroupSurfaces = () => new Set<string>([...listDeliverableMessageChannels(), "webchat"]);

function normalizeGroupLabel(raw?: string) {
  return normalizeHyphenSlug(raw);
}

function resolveGroupSessionKeyFromRaw(params: {
  raw?: string;
  providerHint?: string;
  chatTypeHint?: "group" | "channel";
}): GroupKeyResolution | null {
  const raw = params.raw?.trim() ?? "";
  if (!raw) {
    return null;
  }
  const isWhatsAppGroupId = raw.toLowerCase().endsWith("@g.us");
  const looksLikeGroup =
    params.chatTypeHint === "group" ||
    params.chatTypeHint === "channel" ||
    raw.includes(":group:") ||
    raw.includes(":channel:") ||
    isWhatsAppGroupId;
  if (!looksLikeGroup) {
    return null;
  }

  const parts = raw.split(":").filter(Boolean);
  const head = parts[0]?.trim().toLowerCase() ?? "";
  const headIsSurface = head ? getGroupSurfaces().has(head) || head === params.providerHint : false;
  const provider = headIsSurface
    ? head
    : (params.providerHint ?? (isWhatsAppGroupId ? "whatsapp" : undefined));
  if (!provider) {
    return null;
  }

  const second = parts[1]?.trim().toLowerCase();
  const secondIsKind = second === "group" || second === "channel";
  const kind = secondIsKind
    ? second
    : raw.includes(":channel:") || params.chatTypeHint === "channel"
      ? "channel"
      : "group";
  const id = headIsSurface
    ? secondIsKind
      ? parts.slice(2).join(":")
      : parts.slice(1).join(":")
    : raw;
  const finalId = id.trim().toLowerCase();
  if (!finalId) {
    return null;
  }

  return {
    key: `${provider}:${kind}:${finalId}`,
    channel: provider,
    id: finalId,
    chatType: kind === "channel" ? "channel" : "group",
  };
}

function shortenGroupId(value?: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 14) {
    return trimmed;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

export function buildGroupDisplayName(params: {
  provider?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const providerKey = (params.provider?.trim().toLowerCase() || "group").trim();
  const groupChannel = params.groupChannel?.trim();
  const space = params.space?.trim();
  const subject = params.subject?.trim();
  const detail =
    (groupChannel && space
      ? `${space}${groupChannel.startsWith("#") ? "" : "#"}${groupChannel}`
      : groupChannel || subject || space || "") || "";
  const fallbackId = params.id?.trim() || params.key;
  const rawLabel = detail || fallbackId;
  let token = normalizeGroupLabel(rawLabel);
  if (!token) {
    token = normalizeGroupLabel(shortenGroupId(rawLabel));
  }
  if (!params.groupChannel && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}

export function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  const from = typeof ctx.From === "string" ? ctx.From.trim() : "";
  const chatType = ctx.ChatType?.trim().toLowerCase();
  const normalizedChatType =
    chatType === "channel" ? "channel" : chatType === "group" ? "group" : undefined;
  const providerHint = ctx.Provider?.trim().toLowerCase();
  const recipientRaw = normalizedChatType
    ? typeof ctx.OriginatingTo === "string"
      ? ctx.OriginatingTo
      : ctx.To
    : undefined;
  const recipientResolution = resolveGroupSessionKeyFromRaw({
    raw: recipientRaw,
    providerHint,
    chatTypeHint: normalizedChatType,
  });
  if (recipientResolution) {
    return recipientResolution;
  }
  return resolveGroupSessionKeyFromRaw({
    raw: from,
    providerHint,
    chatTypeHint: normalizedChatType,
  });
}
