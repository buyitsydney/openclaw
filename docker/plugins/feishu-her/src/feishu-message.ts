import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import { resolveFeishuAccountLabel, type ResolvedFeishuAccount } from "./accounts.js";
import { formatFeishuAtText } from "./mention-text.js";
import { getFeishuClient } from "./outbound.js";
import { callChatApi } from "./tools/chat-api.js";

// Re-export shared types from feishu-types.ts (extracted to break circular dep)
export type {
  FeishuMessageCoverage,
  FeishuActorIdType,
  FeishuActorKind,
  FeishuResolutionSource,
  FeishuActorRef,
  FeishuAttachmentKind,
  FeishuAttachmentRef,
  FeishuTextPayload,
  FeishuReplyRef,
} from "./feishu-types.js";

import type {
  FeishuActorRef,
  FeishuActorIdType,
  FeishuActorKind,
  FeishuAttachmentKind,
  FeishuAttachmentRef,
  FeishuMessageCoverage,
  FeishuReplyRef,
  FeishuResolutionSource,
  FeishuTextPayload,
} from "./feishu-types.js";

export type FeishuMentionRef = {
  key: string;
  id: string;
  name?: string;
  renderedText: string;
  actor: FeishuActorRef;
};

export type FeishuCanonicalMessage = {
  messageId: string;
  chatId?: string;
  messageType: string;
  createTime?: string;
  createTimeMs?: number;
  createTimeHuman?: string;
  sender: FeishuActorRef;
  mentions: FeishuMentionRef[];
  attachments: FeishuAttachmentRef[];
  reply?: FeishuReplyRef;
  text: FeishuTextPayload;
  coverage: FeishuMessageCoverage;
  provenance?: {
    sourcePath: "live_event" | "history_api" | "quoted_lookup" | "local_archive" | "cache";
    tokenMode?: "tenant" | "user";
    archiveHit?: boolean;
    cacheHit?: boolean;
  };
};

export type FeishuFileInfo = {
  kind: "file" | "audio" | "video";
  fileKey: string;
  fileName: string;
};

export type ParsedFeishuContent = {
  rawText: string;
  text: FeishuTextPayload;
  coverage: FeishuMessageCoverage;
  attachments: FeishuAttachmentRef[];
  imageKeys: string[];
  fileInfo: FeishuFileInfo[];
};

type FeishuChatMemberListItem = {
  member_id?: string;
  name?: string;
};

type FeishuChatMemberListData = {
  items?: FeishuChatMemberListItem[];
  has_more?: boolean;
  page_token?: string;
};

export type FeishuChatMemberNameMaps = {
  openIdToName: Map<string, string>;
  appIdToName: Map<string, string>;
};

const CHAT_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const chatMemberNameCache = new Map<string, { expireAt: number; maps: FeishuChatMemberNameMaps }>();
const directSenderNameCache = new Map<string, { name: string; expireAt: number }>();
const FOOTER_RE = /\n{2}(🧠 [^\n]+)$/u;

function trimIfString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function detectActorKind(senderType: string, canonicalIdType: FeishuActorIdType): FeishuActorKind {
  if (senderType === "app" || senderType === "bot") {
    return "bot";
  }
  if (senderType === "user") {
    return "human";
  }
  if (senderType === "system") {
    return "system";
  }
  if (canonicalIdType === "app_id") {
    return "bot";
  }
  if (canonicalIdType === "open_id" || canonicalIdType === "user_id") {
    return "human";
  }
  return "unknown";
}

function buildActor(params: {
  openId?: string;
  appId?: string;
  userId?: string;
  unionId?: string;
  senderType?: string;
  displayName?: string;
  resolutionSource: FeishuResolutionSource;
}): FeishuActorRef {
  const rawIds: FeishuActorRef["rawIds"] = {};
  const openId = trimIfString(params.openId);
  const appId = trimIfString(params.appId);
  const userId = trimIfString(params.userId);
  const unionId = trimIfString(params.unionId);
  if (openId) {
    rawIds.open_id = openId;
  }
  if (appId) {
    rawIds.app_id = appId;
  }
  if (userId) {
    rawIds.user_id = userId;
  }
  if (unionId) {
    rawIds.union_id = unionId;
  }
  const canonicalId = openId || appId || userId || "";
  const canonicalIdType: FeishuActorIdType = openId
    ? "open_id"
    : appId
      ? "app_id"
      : userId
        ? "user_id"
        : "unknown";
  const senderType = trimIfString(params.senderType);
  const displayName = trimIfString(params.displayName) || undefined;
  return {
    canonicalId,
    canonicalIdType,
    senderType,
    actorKind: detectActorKind(senderType, canonicalIdType),
    ...(displayName && { displayName }),
    rawIds,
    resolutionSource: params.resolutionSource,
    resolved: Boolean(canonicalId || displayName),
  };
}

export function buildFeishuBotActorFromAccount(
  account: Pick<ResolvedFeishuAccount, "appId" | "accountId" | "name" | "botOpenId">,
): FeishuActorRef {
  const displayName = resolveFeishuAccountLabel(account);
  const botOpenId = trimIfString(account.botOpenId);
  return {
    canonicalId: account.appId,
    canonicalIdType: "app_id",
    senderType: "app",
    actorKind: "bot",
    ...(displayName && { displayName }),
    rawIds: {
      app_id: account.appId,
      ...(botOpenId && { open_id: botOpenId }),
    },
    resolutionSource: "config",
    resolved: true,
  };
}

function extractActorIdFromUnknownId(value: unknown): {
  openId?: string;
  appId?: string;
  userId?: string;
  unionId?: string;
} {
  if (typeof value !== "string") {
    return {};
  }
  const id = value.trim();
  if (!id) {
    return {};
  }
  if (id.startsWith("ou_")) {
    return { openId: id };
  }
  if (id.startsWith("cli_")) {
    return { appId: id };
  }
  if (id.startsWith("on_")) {
    return { unionId: id };
  }
  return { userId: id };
}

export function buildFeishuActorFromEventSender(sender: unknown): FeishuActorRef {
  const senderObj = (sender ?? {}) as {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      app_id?: string;
      user_id?: string;
      union_id?: string;
      name?: string;
      id?: string;
    };
  };
  const ids = senderObj.sender_id ?? {};
  const fallbackIds = extractActorIdFromUnknownId(ids.id);
  const openId = trimIfString(ids.open_id ?? fallbackIds.openId);
  const appId = trimIfString(ids.app_id ?? fallbackIds.appId);
  const senderType = trimIfString(senderObj.sender_type);
  return buildActor({
    openId,
    appId,
    userId: ids.user_id ?? fallbackIds.userId,
    unionId: ids.union_id ?? fallbackIds.unionId,
    senderType,
    displayName: ids.name,
    resolutionSource: "event",
  });
}

export function buildFeishuActorFromApiSender(sender: unknown): FeishuActorRef {
  const senderObj = (sender ?? {}) as {
    id?: string;
    sender_type?: string;
  };
  const ids = extractActorIdFromUnknownId(senderObj.id);
  const senderType = trimIfString(senderObj.sender_type);
  return buildActor({
    openId: ids.openId,
    appId: ids.appId,
    userId: ids.userId,
    unionId: ids.unionId,
    senderType,
    resolutionSource: "history_api",
  });
}

function resolveKnownFeishuBotDisplayName(
  account: Pick<ResolvedFeishuAccount, "appId" | "accountId" | "name" | "knownBots">,
  appId: string,
): string | undefined {
  const normalizedAppId = trimIfString(appId);
  if (!normalizedAppId) {
    return undefined;
  }
  if (normalizedAppId === account.appId) {
    return resolveFeishuAccountLabel(account);
  }
  return trimIfString(account.knownBots?.[normalizedAppId]) || undefined;
}

function resolveKnownFeishuBotOpenId(
  account: Pick<ResolvedFeishuAccount, "appId" | "botOpenId" | "knownBotOpenIds">,
  appId: string,
): string | undefined {
  const normalizedAppId = trimIfString(appId);
  if (!normalizedAppId) {
    return undefined;
  }
  if (normalizedAppId === account.appId) {
    return trimIfString(account.botOpenId) || undefined;
  }
  for (const [openId, mappedAppId] of Object.entries(account.knownBotOpenIds ?? {})) {
    if (trimIfString(mappedAppId) !== normalizedAppId) {
      continue;
    }
    const normalizedOpenId = trimIfString(openId);
    if (normalizedOpenId) {
      return normalizedOpenId;
    }
  }
  return undefined;
}

export function applyFeishuKnownBotDisplayName(
  actor: FeishuActorRef,
  account: Pick<
    ResolvedFeishuAccount,
    "appId" | "accountId" | "name" | "knownBots" | "knownBotOpenIds" | "botOpenId"
  >,
): FeishuActorRef {
  let knownAppId =
    actor.rawIds.app_id ?? (actor.canonicalIdType === "app_id" ? actor.canonicalId : "");

  const displayName = knownAppId
    ? resolveKnownFeishuBotDisplayName(account, knownAppId)
    : undefined;
  const knownOpenId = knownAppId ? resolveKnownFeishuBotOpenId(account, knownAppId) : undefined;
  const rawIds = {
    ...actor.rawIds,
    ...(knownAppId && { app_id: knownAppId }),
    ...(knownOpenId && { open_id: knownOpenId }),
  };

  if (!knownAppId && !displayName && !knownOpenId) {
    return actor;
  }
  if (knownAppId && !displayName) {
    return {
      ...actor,
      canonicalId: knownAppId,
      canonicalIdType: "app_id",
      senderType: "app",
      actorKind: "bot",
      rawIds,
      resolutionSource: "config",
      resolved: true,
    };
  }

  return {
    ...actor,
    canonicalId: knownAppId,
    canonicalIdType: "app_id",
    senderType: "app",
    actorKind: "bot",
    displayName,
    rawIds,
    resolutionSource: "config",
    resolved: true,
  };
}

function applyFeishuKnownBotMentionDisplayNames(
  mentions: FeishuMentionRef[],
  account: Pick<
    ResolvedFeishuAccount,
    "appId" | "accountId" | "name" | "knownBots" | "knownBotOpenIds" | "botOpenId"
  >,
): FeishuMentionRef[] {
  return mentions.map((mention) => {
    const actor = applyFeishuKnownBotDisplayName(mention.actor, account);
    const name = actor.displayName ?? mention.name;
    return {
      ...mention,
      ...(name && { name }),
      actor,
      renderedText: formatFeishuAtText({ userId: actor.canonicalId, userName: name }),
    };
  });
}

export function parseFeishuMentions(rawMentions: unknown): FeishuMentionRef[] {
  if (!Array.isArray(rawMentions)) {
    return [];
  }
  const mentions: FeishuMentionRef[] = [];
  for (const raw of rawMentions) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const mention = raw as {
      key?: string;
      name?: string;
      id?: string | { open_id?: string; app_id?: string; user_id?: string; union_id?: string };
    };
    const key = trimIfString(mention.key);
    if (!key) {
      continue;
    }
    const name = trimIfString(mention.name) || undefined;
    const idValue = mention.id;
    const ids =
      typeof idValue === "object" && idValue
        ? {
            openId: trimIfString(idValue.open_id),
            appId: trimIfString(idValue.app_id),
            userId: trimIfString(idValue.user_id),
            unionId: trimIfString(idValue.union_id),
          }
        : extractActorIdFromUnknownId(idValue);
    const actor = buildActor({
      openId: ids.openId,
      appId: ids.appId,
      userId: ids.userId,
      unionId: ids.unionId,
      displayName: name,
      resolutionSource: "event",
    });
    const id = actor.canonicalId;
    mentions.push({
      key,
      id,
      ...(name && { name }),
      renderedText: formatFeishuAtText({ userId: id, userName: name }),
      actor,
    });
  }
  return mentions;
}

function parseJsonContent(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

const FEISHU_SCHEMA2_AT_TAG_RE = /<at\s+id="?([^"\s>]+)"?\s*><\/at>/gi;

function resolvePostBody(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(parsed.content)) {
    return parsed;
  }
  const zhCn = parsed.zh_cn as Record<string, unknown> | undefined;
  const enUs = parsed.en_us as Record<string, unknown> | undefined;
  const first = Object.values(parsed)[0];
  if (zhCn && typeof zhCn === "object") {
    return zhCn;
  }
  if (enUs && typeof enUs === "object") {
    return enUs;
  }
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

function extractSchema2TextNodeContent(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }
  const textNode = node as Record<string, unknown>;
  return trimIfString(textNode.content) || trimIfString(textNode.text) || "";
}

function extractSchema2HeaderTitle(parsed: Record<string, unknown>): string {
  const header = parsed.header;
  if (!header || typeof header !== "object") {
    return "";
  }
  const title = (header as Record<string, unknown>).title;
  return extractSchema2TextNodeContent(title);
}

type InteractiveParseAccumulator = {
  attachments: FeishuAttachmentRef[];
  imageKeys: string[];
  fileInfo: FeishuFileInfo[];
  imagePlaceholder: string;
  coverage: FeishuMessageCoverage;
};

function flattenFeishuSchema2InteractiveElement(
  element: Record<string, unknown>,
  acc: InteractiveParseAccumulator,
): string {
  const tag = trimIfString(element.tag);
  switch (tag) {
    case "markdown":
      return trimIfString(element.content) || "";
    case "plain_text":
      return extractSchema2TextNodeContent(element);
    case "div": {
      const parts: string[] = [];
      const directText = extractSchema2TextNodeContent(element.text);
      if (directText) {
        parts.push(directText);
      }
      const fields = Array.isArray(element.fields)
        ? (element.fields as Array<Record<string, unknown>>)
        : [];
      for (const field of fields) {
        const fieldText = extractSchema2TextNodeContent(field.text);
        if (fieldText) {
          parts.push(fieldText);
        }
      }
      return parts.join("\n");
    }
    case "note": {
      const elements = Array.isArray(element.elements)
        ? (element.elements as Array<Record<string, unknown>>)
        : [];
      return elements
        .map((child) => flattenFeishuSchema2InteractiveElement(child, acc))
        .filter(Boolean)
        .join(" ");
    }
    case "column_set": {
      const columns = Array.isArray(element.columns)
        ? (element.columns as Array<Record<string, unknown>>)
        : [];
      return columns
        .map((column) => flattenFeishuSchema2InteractiveElement(column, acc))
        .filter(Boolean)
        .join("\n");
    }
    case "column": {
      const elements = Array.isArray(element.elements)
        ? (element.elements as Array<Record<string, unknown>>)
        : [];
      return elements
        .map((child) => flattenFeishuSchema2InteractiveElement(child, acc))
        .filter(Boolean)
        .join("\n");
    }
    case "action": {
      const actions = Array.isArray(element.actions)
        ? (element.actions as Array<Record<string, unknown>>)
        : [];
      const labels = actions
        .map((action) => flattenFeishuSchema2InteractiveElement(action, acc))
        .filter(Boolean);
      if (labels.length === 0) {
        return "";
      }
      acc.coverage = "partial";
      return `[actions: ${labels.join(" | ")}]`;
    }
    case "button": {
      const label = extractSchema2TextNodeContent(element.text);
      acc.coverage = "partial";
      return label ? `[button: ${label}]` : "[button]";
    }
    case "img": {
      const imageKey = trimIfString(element.img_key) || trimIfString(element.image_key);
      if (imageKey) {
        acc.imageKeys.push(imageKey);
      }
      acc.attachments.push({
        kind: "image",
        ...(imageKey && { imageKey }),
        coverage: "partial",
      });
      acc.coverage = "partial";
      return acc.imagePlaceholder;
    }
    case "hr":
      acc.coverage = "partial";
      return "---";
    default: {
      const elements = Array.isArray(element.elements)
        ? (element.elements as Array<Record<string, unknown>>)
        : [];
      if (elements.length > 0) {
        return elements
          .map((child) => flattenFeishuSchema2InteractiveElement(child, acc))
          .filter(Boolean)
          .join("\n");
      }
      return "";
    }
  }
}

function parseFeishuSchema2InteractiveText(
  parsed: Record<string, unknown>,
  options?: {
    imagePlaceholder?: string;
    placeholderText?: string;
    unescapeEntities?: boolean;
  },
): ParsedFeishuContent | null {
  const body = parsed.body;
  if (!body || typeof body !== "object") {
    return null;
  }
  const elements = Array.isArray((body as Record<string, unknown>).elements)
    ? ((body as Record<string, unknown>).elements as Array<Record<string, unknown>>)
    : null;
  if (!elements) {
    return null;
  }
  const imagePlaceholder = options?.imagePlaceholder ?? "[image]";
  const acc: InteractiveParseAccumulator = {
    attachments: [],
    imageKeys: [],
    fileInfo: [],
    imagePlaceholder,
    coverage: "full",
  };
  const lines: string[] = [];
  const title = extractSchema2HeaderTitle(parsed);
  if (title) {
    lines.push(title);
  }
  for (const element of elements) {
    const text = flattenFeishuSchema2InteractiveElement(element, acc).trim();
    if (text) {
      lines.push(text);
    }
  }
  let rawText = lines.join("\n\n").trim();
  if (options?.unescapeEntities !== false) {
    rawText = unescapeHtmlEntities(rawText);
  }
  rawText = rawText.replace(FEISHU_SCHEMA2_AT_TAG_RE, (_match, userId: string) =>
    formatFeishuAtText({ userId }),
  );
  if (!rawText || rawText.includes("请升级至最新版本客户端")) {
    return null;
  }
  return {
    rawText,
    text: buildFeishuTextPayload(rawText),
    coverage: acc.coverage,
    attachments: acc.attachments,
    imageKeys: acc.imageKeys,
    fileInfo: acc.fileInfo,
  };
}

export function parseFeishuPostText(
  parsed: Record<string, unknown>,
  options?: {
    imagePlaceholder?: string;
    mediaPlaceholder?: string;
    collectEmbeddedFiles?: boolean;
  },
): ParsedFeishuContent {
  const body = resolvePostBody(parsed);
  if (!body || !Array.isArray(body.content)) {
    return {
      rawText: JSON.stringify(parsed),
      text: buildFeishuTextPayload(JSON.stringify(parsed)),
      coverage: "partial",
      attachments: [],
      imageKeys: [],
      fileInfo: [],
    };
  }

  const imagePlaceholder = options?.imagePlaceholder ?? "[image]";
  const mediaPlaceholder = options?.mediaPlaceholder ?? "[video]";
  const attachments: FeishuAttachmentRef[] = [];
  const imageKeys: string[] = [];
  const fileInfo: FeishuFileInfo[] = [];
  const lines: string[] = [];
  let coverage: FeishuMessageCoverage = "full";
  for (const paragraph of body.content as Array<Array<Record<string, unknown>>>) {
    const parts: string[] = [];
    for (const el of paragraph) {
      if (el.tag === "text") {
        parts.push(trimIfString(el.text));
      } else if (el.tag === "a") {
        parts.push(`[${trimIfString(el.text)}](${trimIfString(el.href)})`);
      } else if (el.tag === "at") {
        parts.push(formatFeishuAtText({ userId: el.user_id, userName: el.user_name }));
      } else if (el.tag === "img") {
        const imageKey = trimIfString(el.image_key);
        if (imageKey) {
          imageKeys.push(imageKey);
        }
        attachments.push({
          kind: "post_image",
          ...(imageKey && { imageKey }),
          coverage: "partial",
        });
        parts.push(imagePlaceholder);
        coverage = "partial";
      } else if (el.tag === "media") {
        const fileKey = trimIfString(el.file_key);
        const fileName = trimIfString(el.file_name) || "video";
        const coverImageKey = trimIfString(el.image_key) || undefined;
        attachments.push({
          kind: "post_media",
          ...(fileKey && { fileKey }),
          ...(fileName && { fileName }),
          ...(coverImageKey && { coverImageKey }),
          coverage: "partial",
        });
        if (coverImageKey) {
          imageKeys.push(coverImageKey);
        }
        if (fileKey && options?.collectEmbeddedFiles !== false) {
          fileInfo.push({ kind: "video", fileKey, fileName });
        }
        parts.push(mediaPlaceholder === "[video]" ? `[video:${fileName}]` : mediaPlaceholder);
        coverage = "partial";
      } else if (el.tag === "emotion") {
        parts.push(el.emoji_type ? `[${trimIfString(el.emoji_type)}]` : "[emotion]");
      } else if (typeof el.tag === "string" && el.tag) {
        coverage = "partial";
      }
    }
    lines.push(parts.join(""));
  }

  const title = trimIfString(body.title);
  const rawText = `${title ? `${title}\n` : ""}${lines.join("\n")}`.trim();
  return {
    rawText,
    text: buildFeishuTextPayload(rawText),
    coverage,
    attachments,
    imageKeys,
    fileInfo,
  };
}

export function parseFeishuInteractiveText(
  parsed: Record<string, unknown>,
  options?: {
    imagePlaceholder?: string;
    placeholderText?: string;
    unescapeEntities?: boolean;
  },
): ParsedFeishuContent {
  const schema2Content = parseFeishuSchema2InteractiveText(parsed, options);
  if (schema2Content) {
    return schema2Content;
  }
  const topElements = parsed.elements;
  const placeholderText =
    options?.placeholderText ?? "[interactive card — content not extractable via API]";
  if (!Array.isArray(topElements)) {
    return {
      rawText: placeholderText,
      text: buildFeishuTextPayload(placeholderText),
      coverage: "none",
      attachments: [],
      imageKeys: [],
      fileInfo: [],
    };
  }

  // v1 card elements: [{tag:"div", text:{tag:"lark_md", content:"..."}}, ...]
  // Degraded rich-text rows: [[{tag:"text", text:"..."}, ...], ...]
  const isV1CardElements =
    topElements.length > 0 &&
    !Array.isArray(topElements[0]) &&
    typeof topElements[0] === "object" &&
    typeof (topElements[0] as Record<string, unknown>).tag === "string";

  if (isV1CardElements) {
    const acc: InteractiveParseAccumulator = {
      attachments: [],
      imageKeys: [],
      fileInfo: [],
      imagePlaceholder: options?.imagePlaceholder ?? "[image]",
      coverage: "full",
    };
    const lines: string[] = [];
    const title = extractSchema2HeaderTitle(parsed);
    if (title) {
      lines.push(title);
    }
    for (const element of topElements as Array<Record<string, unknown>>) {
      const text = flattenFeishuSchema2InteractiveElement(element, acc).trim();
      if (text) {
        lines.push(text);
      }
    }
    let rawText = lines.join("\n\n").trim();
    if (options?.unescapeEntities !== false) {
      rawText = unescapeHtmlEntities(rawText);
    }
    if (rawText && !rawText.includes("请升级至最新版本客户端")) {
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: acc.coverage,
        attachments: acc.attachments,
        imageKeys: acc.imageKeys,
        fileInfo: acc.fileInfo,
      };
    }
  }

  // Degraded rich-text rows (API-degraded v2 cards or legacy v1 with 2D array)
  const rows = topElements as Array<Array<Record<string, unknown>>>;
  const imagePlaceholder = options?.imagePlaceholder ?? "[image]";
  const attachments: FeishuAttachmentRef[] = [];
  const imageKeys: string[] = [];
  const lines: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    const parts: string[] = [];
    for (const el of row) {
      if (el.tag === "text" || el.tag === "a") {
        parts.push(trimIfString(el.text));
      } else if (el.tag === "at") {
        parts.push(formatFeishuAtText({ userId: el.user_id, userName: el.user_name }));
      } else if (el.tag === "img") {
        const imageKey = trimIfString(el.image_key);
        if (imageKey) {
          imageKeys.push(imageKey);
        }
        attachments.push({
          kind: "image",
          ...(imageKey && { imageKey }),
          coverage: "partial",
        });
        parts.push(imagePlaceholder);
      }
    }
    const line = parts.join("").trim();
    if (line) {
      lines.push(line);
    }
  }
  const title = trimIfString(parsed.title);
  let rawText = `${title ? `${title}\n` : ""}${lines.join("\n")}`.trim();
  if (options?.unescapeEntities !== false) {
    rawText = unescapeHtmlEntities(rawText);
  }
  if (!rawText || rawText.includes("请升级至最新版本客户端")) {
    rawText = placeholderText;
    return {
      rawText,
      text: buildFeishuTextPayload(rawText),
      coverage: "none",
      attachments: [],
      imageKeys: [],
      fileInfo: [],
    };
  }
  return {
    rawText,
    text: buildFeishuTextPayload(rawText),
    coverage: "partial",
    attachments,
    imageKeys,
    fileInfo: [],
  };
}

export function buildFeishuTextPayload(rawText: string): FeishuTextPayload {
  const normalized = rawText.trim();
  const footerMatch = normalized.match(FOOTER_RE);
  if (!footerMatch || footerMatch.index === undefined) {
    return {
      raw: rawText,
      normalized,
      withoutFooter: normalized,
    };
  }
  const withoutFooter = normalized.slice(0, footerMatch.index).trimEnd();
  return {
    raw: rawText,
    normalized,
    withoutFooter,
    footer: footerMatch[1],
  };
}

export function stripFeishuStatusFooter(text: string): string {
  return buildFeishuTextPayload(text).withoutFooter;
}

export function parseFeishuMessageContent(params: {
  content: string;
  msgType: string;
  imagePlaceholder?: string;
  interactivePlaceholder?: string;
  mediaPlaceholder?: string;
}): ParsedFeishuContent {
  const parsed = parseJsonContent(params.content);
  if (!parsed) {
    return {
      rawText: params.content,
      text: buildFeishuTextPayload(params.content),
      coverage: "none",
      attachments: [],
      imageKeys: [],
      fileInfo: [],
    };
  }

  switch (params.msgType) {
    case "text": {
      const rawText = trimIfString(parsed.text) || params.content;
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "full",
        attachments: [],
        imageKeys: [],
        fileInfo: [],
      };
    }
    case "post":
      return parseFeishuPostText(parsed, {
        imagePlaceholder: params.imagePlaceholder,
        mediaPlaceholder: params.mediaPlaceholder,
      });
    case "image": {
      const imageKey = trimIfString(parsed.image_key);
      const rawText = params.imagePlaceholder ?? `[image: ${imageKey || "unknown"}]`;
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "partial",
        attachments: [{ kind: "image", ...(imageKey && { imageKey }), coverage: "partial" }],
        imageKeys: imageKey ? [imageKey] : [],
        fileInfo: [],
      };
    }
    case "file": {
      const fileKey = trimIfString(parsed.file_key);
      const fileName = trimIfString(parsed.file_name) || fileKey || "unknown";
      const rawText = `[file: ${fileName}]`;
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "partial",
        attachments: [
          {
            kind: "file",
            ...(fileKey && { fileKey }),
            ...(fileName && { fileName }),
            coverage: "partial",
          },
        ],
        imageKeys: [],
        fileInfo: fileKey ? [{ kind: "file", fileKey, fileName }] : [],
      };
    }
    case "audio": {
      const fileKey = trimIfString(parsed.file_key);
      const fileName = trimIfString(parsed.file_name) || "voice.ogg";
      const rawText = `[audio: ${fileKey || "unknown"}]`;
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "partial",
        attachments: [
          {
            kind: "audio",
            ...(fileKey && { fileKey }),
            ...(fileName && { fileName }),
            coverage: "partial",
          },
        ],
        imageKeys: [],
        fileInfo: fileKey ? [{ kind: "audio", fileKey, fileName }] : [],
      };
    }
    case "media": {
      const imageKey = trimIfString(parsed.image_key);
      const fileKey = trimIfString(parsed.file_key);
      const fileName = trimIfString(parsed.file_name) || "unknown";
      const durationSec =
        typeof parsed.duration === "number"
          ? parsed.duration
          : Number(parsed.duration ?? 0) || undefined;
      const rawText =
        params.mediaPlaceholder ??
        `[video: ${fileName}, duration=${durationSec ?? "?"}s, cover=${imageKey || "none"}]`;
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "partial",
        attachments: [
          {
            kind: "video",
            ...(fileKey && { fileKey }),
            ...(fileName && { fileName }),
            ...(imageKey && { coverImageKey: imageKey }),
            ...(durationSec !== undefined && { durationSec }),
            coverage: "partial",
          },
        ],
        imageKeys: imageKey ? [imageKey] : [],
        fileInfo: fileKey ? [{ kind: "video", fileKey, fileName }] : [],
      };
    }
    case "interactive":
      return parseFeishuInteractiveText(parsed, {
        imagePlaceholder: params.imagePlaceholder,
        placeholderText: params.interactivePlaceholder,
      });
    case "video": {
      const rawText = "[video — not fully supported by history API]";
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "none",
        attachments: [{ kind: "video", coverage: "none" }],
        imageKeys: [],
        fileInfo: [],
      };
    }
    case "system": {
      const rawText = trimIfString(parsed.content) || trimIfString(parsed.text) || params.content;
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "full",
        attachments: [],
        imageKeys: [],
        fileInfo: [],
      };
    }
    case "merge_forward": {
      // Initial parse returns empty — gateway layer will expand via API
      return {
        rawText: "",
        text: buildFeishuTextPayload(""),
        coverage: "none",
        attachments: [],
        imageKeys: [],
        fileInfo: [],
      };
    }
    case "sticker": {
      const rawText = "[sticker]";
      return {
        rawText,
        text: buildFeishuTextPayload(rawText),
        coverage: "partial",
        attachments: [],
        imageKeys: [],
        fileInfo: [],
      };
    }
    default: {
      if (params.msgType === "nonsupport") {
        const rawText = "[unsupported message type — likely video, will check local archive]";
        return {
          rawText,
          text: buildFeishuTextPayload(rawText),
          coverage: "none",
          attachments: [],
          imageKeys: [],
          fileInfo: [],
        };
      }
      return {
        rawText: params.content,
        text: buildFeishuTextPayload(params.content),
        coverage: "none",
        attachments: [],
        imageKeys: [],
        fileInfo: [],
      };
    }
  }
}

export function renderFeishuTextWithMentions(params: {
  text: string;
  mentions?: FeishuMentionRef[];
}): string {
  let rendered = params.text;
  for (const mention of params.mentions ?? []) {
    if (!mention.key) {
      continue;
    }
    rendered = rendered.replaceAll(mention.key, mention.renderedText);
  }
  return rendered;
}

export function formatFeishuActorLabel(
  actor: FeishuActorRef,
  options?: { includeCanonicalId?: boolean },
): string {
  const includeCanonicalId = options?.includeCanonicalId !== false;
  const displayName = trimIfString(actor.displayName);
  const canonicalId = trimIfString(actor.canonicalId);
  if (displayName && canonicalId && includeCanonicalId) {
    return `${displayName} (${canonicalId})`;
  }
  return displayName || canonicalId || "unknown";
}

export function renderFeishuQuotedContext(params: {
  messageId: string;
  messageType: string;
  sender: FeishuActorRef;
  text: string;
}): string {
  const senderLabel = formatFeishuActorLabel(params.sender);
  return `[Quoted ${params.messageType} message from ${senderLabel} (message_id=${params.messageId}): "${params.text}"]`;
}

export function renderFeishuQuotedReplyBody(params: {
  messageId: string;
  messageType: string;
  sender: FeishuActorRef;
  text: string;
}): string {
  const senderLabel = formatFeishuActorLabel(params.sender);
  return [
    `[message_id=${params.messageId}]`,
    `[Quoted ${params.messageType} message from ${senderLabel}]`,
    params.text,
  ].join("\n");
}

export function renderFeishuRecentContextLine(message: FeishuCanonicalMessage): string {
  const ts =
    message.createTimeHuman ||
    (message.createTimeMs
      ? new Date(message.createTimeMs).toISOString()
      : message.createTime || "");
  const text = renderFeishuTextWithMentions({
    text: message.text.withoutFooter,
    mentions: message.mentions,
  });
  return `Feishu message from ${formatFeishuActorLabel(message.sender)} at ${ts}: ${text}`;
}

async function listFeishuChatMemberNamesByIdType(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  memberIdType: "open_id" | "union_id" | "user_id";
}): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const result = await callChatApi<FeishuChatMemberListData>({
      account: params.account,
      method: "GET",
      endpoint: `/im/v1/chats/${params.chatId}/members`,
      query: {
        member_id_type: params.memberIdType,
        page_size: 100,
        page_token: pageToken,
      },
    });
    if (!result.ok) {
      throw new Error(
        `list_chat_members_failed:${params.memberIdType}:code=${result.code} msg=${result.msg}`,
      );
    }
    for (const item of result.data?.items ?? []) {
      const memberId = trimIfString(item.member_id);
      const name = trimIfString(item.name);
      if (memberId && name) {
        nameMap.set(memberId, name);
      }
    }
    pageToken = result.data?.has_more
      ? trimIfString(result.data.page_token) || undefined
      : undefined;
  } while (pageToken);
  return nameMap;
}

export async function resolveFeishuChatMemberNameMaps(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  log?: ChannelLogSink;
}): Promise<FeishuChatMemberNameMaps> {
  const cacheKey = `${params.account.accountId}:${params.chatId}`;
  const cached = chatMemberNameCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return cached.maps;
  }
  const openIdToName = await listFeishuChatMemberNamesByIdType({
    account: params.account,
    chatId: params.chatId,
    memberIdType: "open_id",
  });
  // Feishu's chat-members API never returns bot members, so app_id labels must
  // come from our explicit registry instead of runtime lookups.
  const appIdToName = new Map<string, string>(Object.entries(params.account.knownBots));
  const maps = { openIdToName, appIdToName };
  chatMemberNameCache.set(cacheKey, { maps, expireAt: now + CHAT_MEMBER_NAME_TTL_MS });
  return maps;
}

export function applyFeishuActorDisplayName(
  actor: FeishuActorRef,
  nameMaps: FeishuChatMemberNameMaps,
): FeishuActorRef {
  if (actor.displayName) {
    return actor;
  }
  const openId =
    actor.rawIds.open_id ?? (actor.canonicalIdType === "open_id" ? actor.canonicalId : "");
  const appId =
    actor.rawIds.app_id ?? (actor.canonicalIdType === "app_id" ? actor.canonicalId : "");
  const displayName =
    (openId && nameMaps.openIdToName.get(openId)) || (appId && nameMaps.appIdToName.get(appId));
  if (!displayName) {
    return actor;
  }
  return {
    ...actor,
    displayName,
    resolutionSource: "chat_member",
    resolved: true,
  };
}

export function applyFeishuMentionDisplayNames(
  mentions: FeishuMentionRef[],
  nameMaps: FeishuChatMemberNameMaps,
): FeishuMentionRef[] {
  return mentions.map((mention) => {
    const actor = applyFeishuActorDisplayName(mention.actor, nameMaps);
    const name = actor.displayName ?? mention.name;
    return {
      ...mention,
      ...(name && { name }),
      actor,
      renderedText: formatFeishuAtText({ userId: actor.canonicalId, userName: name }),
    };
  });
}

export async function resolveFeishuDirectActorDisplayName(params: {
  account: ResolvedFeishuAccount;
  actor: FeishuActorRef;
  log?: ChannelLogSink;
}): Promise<FeishuActorRef> {
  if (params.actor.displayName || params.actor.canonicalIdType !== "open_id") {
    return params.actor;
  }
  const senderOpenId = params.actor.canonicalId.trim();
  if (!senderOpenId) {
    return params.actor;
  }
  const cacheKey = `${params.account.accountId}:${senderOpenId}`;
  const cached = directSenderNameCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expireAt > now) {
    return {
      ...params.actor,
      displayName: cached.name,
      resolutionSource: "directory",
      resolved: true,
    };
  }
  try {
    const client = getFeishuClient(params.account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });
    const user = res?.data?.user;
    const name = trimIfString(user?.name || user?.display_name || user?.nickname || user?.en_name);
    if (!name) {
      return params.actor;
    }
    directSenderNameCache.set(cacheKey, { name, expireAt: now + SENDER_NAME_TTL_MS });
    return {
      ...params.actor,
      displayName: name,
      resolutionSource: "directory",
      resolved: true,
    };
  } catch (error) {
    params.log?.info?.(
      `[${params.account.accountId}] direct actor name lookup failed for ${senderOpenId}: ${String(error)}`,
    );
    return params.actor;
  }
}

export async function resolveFeishuMessageActors(params: {
  account: ResolvedFeishuAccount;
  sender: FeishuActorRef;
  mentions?: FeishuMentionRef[];
  chatId?: string;
  log?: ChannelLogSink;
  nameMaps?: FeishuChatMemberNameMaps;
}): Promise<{ sender: FeishuActorRef; mentions: FeishuMentionRef[] }> {
  let sender = applyFeishuKnownBotDisplayName(params.sender, params.account);
  let mentions = applyFeishuKnownBotMentionDisplayNames(params.mentions ?? [], params.account);

  if (params.chatId?.startsWith("oc_")) {
    const nameMaps =
      params.nameMaps ??
      (await resolveFeishuChatMemberNameMaps({
        account: params.account,
        chatId: params.chatId,
        log: params.log,
      }));
    sender = applyFeishuKnownBotDisplayName(
      applyFeishuActorDisplayName(sender, nameMaps),
      params.account,
    );
    mentions = applyFeishuKnownBotMentionDisplayNames(
      applyFeishuMentionDisplayNames(mentions, nameMaps),
      params.account,
    );
    return { sender, mentions };
  }

  sender = await resolveFeishuDirectActorDisplayName({
    account: params.account,
    actor: sender,
    log: params.log,
  });
  mentions = applyFeishuKnownBotMentionDisplayNames(mentions, params.account);
  return { sender, mentions };
}
