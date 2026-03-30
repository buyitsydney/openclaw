import crypto from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, parse } from "node:path";
import { extractPdfContent } from "openclaw/plugin-sdk/feishu";
import {
  buildFeishuTextPayload,
  formatFeishuActorLabel,
  type FeishuActorRef,
  type FeishuAttachmentRef,
  type FeishuMentionRef,
  type FeishuReplyRef,
  type FeishuTextPayload,
} from "./feishu-message.js";
import { extractFeishuAtTextMentions } from "./mention-text.js";
import {
  buildFeishuReplyRefFromSentMessage,
  type FeishuSentMessageRef,
} from "./message-metadata.js";

export type ArchiveLogSink = {
  info?: (message: string) => void;
  error?: (message: string) => void;
};

export type GroupArchiveEntry = {
  schemaVersion?: 2;
  ts: number;
  sender: string;
  senderId: string;
  text: string;
  msgId: string;
  actor?: FeishuActorRef;
  messageType?: string;
  mentions?: Array<Pick<FeishuMentionRef, "key" | "id" | "name" | "renderedText">>;
  attachments?: FeishuAttachmentRef[];
  textParts?: FeishuTextPayload;
  reply?: FeishuReplyRef;
};

const OFFICE_EXTS = new Set([".pptx", ".docx", ".xlsx", ".odt", ".odp", ".ods", ".rtf"]);
const MAX_OFFICE_CHARS = 100_000;
const MAX_PDF_PAGES = 5;
const MAX_PDF_PIXELS = 3_000_000;

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".openclaw");
}

export function resolveGroupArchiveDir(): string {
  return join(resolveStateDir(), "feishu-groups");
}

function resolveInboundMediaDir(): string {
  return join(resolveStateDir(), "media", "inbound");
}

export function loadArchiveEntries(chatId: string): Map<string, GroupArchiveEntry> {
  const archivePath = join(resolveGroupArchiveDir(), chatId, "messages.jsonl");
  const map = new Map<string, GroupArchiveEntry>();
  if (!existsSync(archivePath)) return map;
  try {
    const content = readFileSync(archivePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = normalizeArchiveEntry(JSON.parse(line) as GroupArchiveEntry);
        if (entry.msgId) map.set(entry.msgId, entry);
      } catch {
        // Ignore malformed archive lines.
      }
    }
  } catch {
    // Ignore unreadable archive files.
  }
  return map;
}

export function archiveGroupMessage(params: {
  chatId: string;
  chatName: string | null;
  senderId: string;
  senderName: string;
  text: string;
  msgId: string;
  ts?: number;
  actor?: FeishuActorRef;
  messageType?: string;
  mentions?: Array<Pick<FeishuMentionRef, "key" | "id" | "name" | "renderedText">>;
  attachments?: FeishuAttachmentRef[];
  textParts?: FeishuTextPayload;
  reply?: FeishuReplyRef;
}): void {
  const archiveDir = resolveGroupArchiveDir();
  const chatDir = join(archiveDir, params.chatId);

  if (!existsSync(chatDir)) {
    mkdirSync(chatDir, { recursive: true });
  }

  const record: GroupArchiveEntry = {
    schemaVersion: 2,
    ts: params.ts ?? Math.floor(Date.now() / 1000),
    sender: params.actor
      ? formatFeishuActorLabel(params.actor, { includeCanonicalId: false })
      : params.senderName || params.senderId,
    senderId: params.senderId,
    text: params.text,
    msgId: params.msgId,
    ...(params.actor && { actor: params.actor }),
    ...(params.messageType && { messageType: params.messageType }),
    ...(params.mentions && params.mentions.length > 0 && { mentions: params.mentions }),
    ...(params.attachments && params.attachments.length > 0 && { attachments: params.attachments }),
    textParts: params.textParts ?? buildFeishuTextPayload(params.text),
    ...(params.reply && { reply: params.reply }),
  };
  appendFileSync(join(chatDir, "messages.jsonl"), JSON.stringify(record) + "\n");

  const indexPath = join(archiveDir, "index.json");
  let index: Record<string, { name: string; lastMessage: string }> = {};
  try {
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }
  } catch {
    // Ignore corrupted index and rebuild it.
  }

  index[params.chatId] = {
    name: params.chatName || index[params.chatId]?.name || params.chatId,
    lastMessage: new Date((params.ts ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
}

function inferActorIdType(senderId: string): FeishuActorRef["canonicalIdType"] {
  if (senderId.startsWith("ou_")) return "open_id";
  if (senderId.startsWith("cli_")) return "app_id";
  if (senderId) return "user_id";
  return "unknown";
}

function inferActorKind(senderId: string): FeishuActorRef["actorKind"] {
  const idType = inferActorIdType(senderId);
  if (idType === "app_id") return "bot";
  if (idType === "open_id" || idType === "user_id") return "human";
  return "unknown";
}

export function normalizeArchiveEntry(entry: GroupArchiveEntry): GroupArchiveEntry {
  const senderId = entry.senderId?.trim() || "";
  const sender = entry.sender?.trim() || senderId;
  const actor =
    entry.actor ??
    ({
      canonicalId: senderId,
      canonicalIdType: inferActorIdType(senderId),
      senderType: inferActorKind(senderId) === "bot" ? "app" : "user",
      actorKind: inferActorKind(senderId),
      ...(sender && sender !== senderId ? { displayName: sender } : {}),
      rawIds:
        inferActorIdType(senderId) === "open_id"
          ? { open_id: senderId }
          : inferActorIdType(senderId) === "app_id"
            ? { app_id: senderId }
            : inferActorIdType(senderId) === "user_id"
              ? { user_id: senderId }
              : {},
      resolutionSource: "archive" as const,
      resolved: Boolean(senderId || sender),
    } satisfies FeishuActorRef);

  return {
    ...entry,
    schemaVersion: 2,
    sender,
    senderId,
    text: entry.text ?? "",
    actor,
    textParts: entry.textParts ?? buildFeishuTextPayload(entry.text ?? ""),
  };
}

export function getArchiveEntryDisplaySender(entry: GroupArchiveEntry): string {
  const normalized = normalizeArchiveEntry(entry);
  return normalized.actor
    ? formatFeishuActorLabel(normalized.actor, { includeCanonicalId: false })
    : normalized.sender || normalized.senderId;
}

export function getArchiveEntryDisplayText(entry: GroupArchiveEntry): string {
  const normalized = normalizeArchiveEntry(entry);
  return normalized.textParts?.withoutFooter || normalized.text;
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

function extensionForContentType(contentType?: string): string {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
      return ".wav";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "application/pdf":
      return ".pdf";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "application/vnd.ms-powerpoint":
      return ".ppt";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/msword":
      return ".doc";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    case "application/vnd.ms-excel":
      return ".xls";
    case "text/plain":
      return ".txt";
    case "text/csv":
      return ".csv";
    case "application/zip":
      return ".zip";
    default:
      return "";
  }
}

function resolveArchiveFileName(params: {
  fileName?: string;
  contentType?: string;
  defaultBaseName: string;
}): string {
  const trimmed = params.fileName?.trim();
  if (trimmed) return trimmed;
  return `${params.defaultBaseName}${extensionForContentType(params.contentType)}`;
}

export async function saveArchiveBuffer(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  defaultBaseName: string;
}): Promise<{ path: string; fileName: string }> {
  const fileName = resolveArchiveFileName(params);
  const parsed = parse(fileName);
  const base = sanitizeFilename(parsed.name) || sanitizeFilename(params.defaultBaseName) || "file";
  const ext = parsed.ext || extensionForContentType(params.contentType);
  const finalName = `${base}---${crypto.randomUUID()}${ext}`;
  const dir = resolveInboundMediaDir();
  const path = join(dir, finalName);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, params.buffer, { mode: 0o644 });
  return { path, fileName };
}

function buildArchivePathLine(fileName: string, savedPath: string): string {
  return `[file: ${fileName} saved at ${savedPath}]`;
}

export function buildArchiveFailureText(fileName: string, reason: string): string {
  return `[file: ${fileName} (${reason})]`;
}

export async function buildArchiveTextFromSavedFile(params: {
  fileName: string;
  savedPath: string;
  log?: ArchiveLogSink;
  includePathLine?: boolean;
}): Promise<string> {
  const ext = extname(params.fileName).toLowerCase();
  const pathLine = buildArchivePathLine(params.fileName, params.savedPath);
  const includePathLine = params.includePathLine ?? true;
  const appendPathLine = (text: string): string =>
    includePathLine ? `${text}\n${pathLine}` : text;
  if (ext === ".pdf") {
    try {
      const buffer = readFileSync(params.savedPath);
      const extracted = await extractPdfContent({
        buffer,
        maxPages: MAX_PDF_PAGES,
        maxPixels: MAX_PDF_PIXELS,
        minTextChars: 1,
      });
      const text = extracted.text.slice(0, MAX_OFFICE_CHARS).trim();
      if (!text) return includePathLine ? pathLine : "";
      return appendPathLine(`<file name="${params.fileName}">\n${text}\n</file>`);
    } catch (err) {
      params.log?.error?.(`pdf extraction failed (${params.fileName}): ${String(err)}`);
      return includePathLine ? pathLine : "";
    }
  }
  // Office files stay path-only. We still persist the local file so the agent
  // can decide whether and how to read it, but we never pre-parse them here.
  if (OFFICE_EXTS.has(ext)) return pathLine;

  return includePathLine ? pathLine : "";
}

export async function createArchiveTextForBuffer(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  defaultBaseName: string;
  log?: ArchiveLogSink;
  includePathLine?: boolean;
}): Promise<string> {
  const saved = await saveArchiveBuffer({
    buffer: params.buffer,
    contentType: params.contentType,
    fileName: params.fileName,
    defaultBaseName: params.defaultBaseName,
  });
  return buildArchiveTextFromSavedFile({
    fileName: saved.fileName,
    savedPath: saved.path,
    log: params.log,
    includePathLine: params.includePathLine,
  });
}

function extractArchiveMentionsFromText(
  text: string,
): Array<Pick<FeishuMentionRef, "key" | "id" | "name" | "renderedText">> | undefined {
  const mentions = extractFeishuAtTextMentions(text).map((mention) => ({
    key: mention.key,
    id: mention.id,
    ...(mention.name && { name: mention.name }),
    renderedText: mention.renderedText,
  }));
  return mentions.length > 0 ? mentions : undefined;
}

export function archiveSentFeishuTextMessage(params: {
  chatId: string;
  chatName?: string | null;
  message: FeishuSentMessageRef;
  senderId: string;
  senderName?: string;
  actor?: FeishuActorRef;
  text: string;
  mentions?: Array<Pick<FeishuMentionRef, "key" | "id" | "name" | "renderedText">>;
  attachments?: FeishuAttachmentRef[];
  textParts?: FeishuTextPayload;
  reply?: FeishuReplyRef;
}): void {
  if (!params.chatId.startsWith("oc_")) return;
  const mentions =
    params.mentions && params.mentions.length > 0
      ? params.mentions
      : extractArchiveMentionsFromText(params.text);
  archiveGroupMessage({
    chatId: params.chatId,
    chatName: params.chatName ?? null,
    senderId: params.senderId,
    senderName: params.senderName ?? params.senderId,
    text: params.text,
    msgId: params.message.messageId,
    ...(params.actor && { actor: params.actor }),
    messageType: params.message.messageType,
    ...(mentions && { mentions }),
    ...(params.attachments && params.attachments.length > 0 && { attachments: params.attachments }),
    textParts: params.textParts ?? buildFeishuTextPayload(params.text),
    ...(params.reply
      ? { reply: params.reply }
      : buildFeishuReplyRefFromSentMessage(params.message)
        ? { reply: buildFeishuReplyRefFromSentMessage(params.message) }
        : {}),
  });
}

export async function archiveSentFeishuBinaryMessage(params: {
  chatId: string;
  message?: FeishuSentMessageRef;
  messageId?: string;
  senderId: string;
  senderName?: string;
  actor?: FeishuActorRef;
  messageType?: string;
  reply?: FeishuReplyRef;
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  defaultBaseName: string;
  log?: ArchiveLogSink;
}): Promise<void> {
  const messageId = params.message?.messageId ?? params.messageId;
  if (!messageId || !params.chatId.startsWith("oc_")) return;
  const text = await createArchiveTextForBuffer({
    buffer: params.buffer,
    contentType: params.contentType,
    fileName: params.fileName,
    defaultBaseName: params.defaultBaseName,
    log: params.log,
  });
  archiveGroupMessage({
    chatId: params.chatId,
    chatName: null,
    senderId: params.senderId,
    senderName: params.senderName ?? params.senderId,
    text,
    msgId: messageId,
    ...(params.actor && { actor: params.actor }),
    ...((params.messageType ?? params.message?.messageType) && {
      messageType: params.messageType ?? params.message?.messageType,
    }),
    textParts: buildFeishuTextPayload(text),
    ...(params.reply
      ? { reply: params.reply }
      : buildFeishuReplyRefFromSentMessage(params.message)
        ? { reply: buildFeishuReplyRefFromSentMessage(params.message) }
        : {}),
  });
}

type ArchiveSupplementableMessage = {
  text: string;
  coverage: "full" | "partial" | "none";
};

export function applyArchiveTextToMessage<T extends ArchiveSupplementableMessage>(
  message: T,
  archiveText: string,
): void {
  if (message.coverage === "none") {
    message.text = archiveText;
    message.coverage = "partial";
    return;
  }
  message.text += `\n[local archive: ${archiveText}]`;
}
