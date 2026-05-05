import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { parseFeishuInteractiveText, parseFeishuPostText } from "./feishu-message.js";
import { createArchiveTextForBuffer } from "./group-archive.js";
import { formatFeishuAtText } from "./mention-text.js";
import { getCachedMessageText } from "./message-text-cache.js";
import { downloadFeishuFile, downloadFeishuImage, getFeishuClient } from "./outbound.js";

export type FeishuFetchedMessageItem = {
  message_id?: string;
  upper_message_id?: string;
  parent_id?: string;
  root_id?: string;
  thread_id?: string;
  create_time?: string;
  msg_type?: string;
  chat_id?: string;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
  mentions?: Array<{ key?: string; id?: string; name?: string }>;
};

export type MergeForwardMediaFile = {
  type: "image" | "file" | "audio" | "video";
  localPath: string;
  fileName: string;
  contentType: string;
};

export type ExpandedFeishuContent = {
  text: string | null;
  coverage: "full" | "partial" | "none";
  mediaFiles?: MergeForwardMediaFile[];
};

type FetchMessageItems = (messageId: string) => Promise<FeishuFetchedMessageItem[]>;
type DownloadFileResource = (params: {
  messageId: string;
  fileKey: string;
}) => Promise<{ buffer: Buffer; contentType?: string } | null>;
type DownloadImageResource = (params: {
  messageId: string;
  imageKey: string;
}) => Promise<{ buffer: Buffer; contentType?: string } | null>;

type ResourceDownloadMode = "allow" | "resolve_origin" | "forbid";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

function resolveInboundMediaDir(): string {
  const base = process.env.OPENCLAW_HOME ?? join(homedir(), ".openclaw");
  const dir = join(base, "media", "inbound");
  if (!existsSync(dir)) {mkdirSync(dir, { recursive: true });}
  return dir;
}

function saveMediaToDisk(params: {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}): string {
  const dir = resolveInboundMediaDir();
  const ext = MIME_TO_EXT[params.contentType] ?? params.fileName.split(".").pop() ?? "bin";
  const id = `mf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safeName = params.fileName.replace(/[/\\:*?"<>|]/g, "_").slice(0, 100);
  const filePath = join(dir, `${safeName}---${id}.${ext}`);
  writeFileSync(filePath, params.buffer);
  return filePath;
}

function mergeCoverage(
  left: ExpandedFeishuContent["coverage"],
  right: ExpandedFeishuContent["coverage"],
): ExpandedFeishuContent["coverage"] {
  if (left === "none" || right === "none") {return "none";}
  if (left === "partial" || right === "partial") {return "partial";}
  return "full";
}

function prefixBulletBlock(text: string): string {
  const lines = text.split("\n");
  return lines.map((line, idx) => `${idx === 0 ? "- " : "  "}${line}`).join("\n");
}

function parseJsonContent(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractPostText(parsed: Record<string, unknown>): ExpandedFeishuContent {
  const parsedContent = parseFeishuPostText(parsed, {
    imagePlaceholder: "[image]",
    mediaPlaceholder: "[video]",
    collectEmbeddedFiles: false,
  });
  return {
    text: parsedContent.text.withoutFooter || null,
    coverage: parsedContent.coverage,
  };
}

function extractInteractiveText(parsed: Record<string, unknown>): ExpandedFeishuContent {
  const parsedContent = parseFeishuInteractiveText(parsed, {
    imagePlaceholder: "[image]",
    placeholderText: "[interactive card — content degraded by API, cannot recover full text]",
  });
  return {
    text: parsedContent.text.withoutFooter || null,
    coverage: parsedContent.coverage,
  };
}

function inferCoverageFromArchiveText(archiveText: string): ExpandedFeishuContent["coverage"] {
  return archiveText.includes("<file name=") ? "full" : "partial";
}

function isSourcePermissionDenied(error: unknown): boolean {
  const message = String(error);
  return /230002|1062524|out of the chat|source parent no permission|permission denied/i.test(
    message,
  );
}

function getCachedExpandedMessage(messageId: string): ExpandedFeishuContent | null {
  const cachedText = getCachedMessageText(messageId);
  if (!cachedText) {return null;}
  return {
    text: cachedText,
    coverage: inferCoverageFromArchiveText(cachedText),
  };
}

async function expandDownloadedFile(params: {
  buffer: Buffer;
  contentType?: string;
  fileName: string;
  defaultBaseName: string;
}): Promise<ExpandedFeishuContent> {
  const archiveText = await createArchiveTextForBuffer({
    buffer: params.buffer,
    contentType: params.contentType,
    fileName: params.fileName,
    defaultBaseName: params.defaultBaseName,
  });
  if (!archiveText) {
    return {
      text: `[file: ${params.fileName}]`,
      coverage: "partial",
    };
  }
  return {
    text: archiveText,
    coverage: inferCoverageFromArchiveText(archiveText),
  };
}

async function fetchMessageItemsViaBotClient(
  account: ResolvedFeishuAccount,
  messageId: string,
): Promise<FeishuFetchedMessageItem[]> {
  const client = getFeishuClient(account);
  const response = (await client.im.message.get({
    path: { message_id: messageId },
    params: { user_id_type: "open_id" },
  })) as {
    code?: number;
    msg?: string;
    data?: { items?: FeishuFetchedMessageItem[] };
  };
  if (response.code !== 0) {
    throw new Error(
      `merge_forward fetch failed: code=${response.code ?? "unknown"} msg=${response.msg ?? ""}`,
    );
  }
  return Array.isArray(response.data?.items) ? response.data.items : [];
}

function isAttachmentMessageType(msgType: string): boolean {
  return (
    msgType === "image" ||
    msgType === "file" ||
    msgType === "audio" ||
    msgType === "media" ||
    msgType === "video"
  );
}

function buildMergedForwardAttachmentPlaceholder(params: {
  msgType: string;
  fileName?: string;
  reason?: "permission_denied" | "unavailable";
}): ExpandedFeishuContent {
  const fileName = params.fileName?.trim();
  const detail =
    params.reason === "permission_denied"
      ? "source chat inaccessible for current user"
      : "source attachment unavailable";
  if (params.msgType === "image") {
    return {
      text: fileName
        ? `[image in merged-forward: ${fileName} — ${detail}]`
        : `[image in merged-forward: ${detail}]`,
      coverage: "partial",
    };
  }
  if (params.msgType === "audio") {
    return {
      text: `[audio in merged-forward: ${fileName || "audio"} — ${detail}]`,
      coverage: "partial",
    };
  }
  if (params.msgType === "media" || params.msgType === "video") {
    return {
      text: `[video in merged-forward: ${fileName || "video"} — ${detail}]`,
      coverage: "partial",
    };
  }
  return {
    text: `[file in merged-forward: ${fileName || "file"} — ${detail}]`,
    coverage: "partial",
  };
}

async function resolveOriginalMessageItem(params: {
  account: ResolvedFeishuAccount;
  item: FeishuFetchedMessageItem;
  fetchItems: FetchMessageItems;
  log?: ChannelLogSink;
}): Promise<FeishuFetchedMessageItem | null> {
  const messageId = params.item.message_id?.trim();
  if (!messageId) {return null;}
  const items = await params.fetchItems(messageId);
  const original = items.find((item) => item.message_id === messageId) ?? items[0] ?? null;
  if (!original) {
    params.log?.info?.(
      `[${params.account.accountId}] merge_forward source lookup returned no items for ${messageId}`,
    );
    return null;
  }
  return original;
}

export async function expandFetchedMessageItem(params: {
  account: ResolvedFeishuAccount;
  item: FeishuFetchedMessageItem;
  log?: ChannelLogSink;
  sharedDownloadedKeys?: Set<string>;
  fetchItems?: FetchMessageItems;
  downloadFile?: DownloadFileResource;
  downloadImage?: DownloadImageResource;
  resourceDownloadMode?: ResourceDownloadMode;
}): Promise<ExpandedFeishuContent> {
  const fetchItems =
    params.fetchItems ??
    ((messageId: string) => fetchMessageItemsViaBotClient(params.account, messageId));
  const downloadFile =
    params.downloadFile ??
    ((fileParams: { messageId: string; fileKey: string }) =>
      downloadFeishuFile({
        account: params.account,
        messageId: fileParams.messageId,
        fileKey: fileParams.fileKey,
      }));
  const downloadImage =
    params.downloadImage ??
    ((imageParams: { messageId: string; imageKey: string }) =>
      downloadFeishuImage({
        account: params.account,
        messageId: imageParams.messageId,
        imageKey: imageParams.imageKey,
      }));
  const resourceDownloadMode = params.resourceDownloadMode ?? "allow";
  const msgType = params.item.msg_type ?? "unknown";
  const messageId = params.item.message_id ?? "";
  const rawContent = params.item.body?.content ?? "";
  const parsed = parseJsonContent(rawContent);

  if (msgType === "merge_forward" && messageId) {
    return expandMergeForwardMessage({
      account: params.account,
      messageId,
      log: params.log,
      sharedDownloadedKeys: params.sharedDownloadedKeys,
      fetchItems,
      downloadFile,
      downloadImage,
      resourceDownloadMode,
    });
  }

  if (msgType === "text") {
    let text = typeof parsed?.text === "string" ? parsed.text : rawContent || null;
    // Resolve @_user_N mention placeholders to real names
    if (text && params.item.mentions?.length) {
      for (const m of params.item.mentions) {
        if (m.key && m.name) {
          text = text.replaceAll(m.key, `@${m.name}`);
        }
      }
    }
    return { text, coverage: "full" };
  }
  if (msgType === "post") {
    return parsed ? extractPostText(parsed) : { text: rawContent || null, coverage: "partial" };
  }
  if (msgType === "interactive") {
    return parsed
      ? extractInteractiveText(parsed)
      : {
          text: "[interactive card — content degraded by API, cannot recover full text]",
          coverage: "none",
        };
  }
  if (msgType === "system") {
    return {
      text:
        typeof parsed?.content === "string"
          ? parsed.content
          : typeof parsed?.text === "string"
            ? parsed.text
            : rawContent || null,
      coverage: "full",
    };
  }
  if (msgType === "image") {
    const imageKey = typeof parsed?.image_key === "string" ? parsed.image_key : "";
    if (resourceDownloadMode === "resolve_origin") {
      const fileName = `image-${messageId || "unknown"}.png`;
      const cached = getCachedExpandedMessage(messageId);
      if (cached) {return cached;}
      try {
        const originalItem = await resolveOriginalMessageItem({
          account: params.account,
          item: params.item,
          fetchItems,
          log: params.log,
        });
        if (!originalItem) {
          return buildMergedForwardAttachmentPlaceholder({ msgType, fileName });
        }
        const cachedOriginal = getCachedExpandedMessage(originalItem.message_id ?? "");
        if (cachedOriginal) {return cachedOriginal;}
        return await expandFetchedMessageItem({
          account: params.account,
          item: originalItem,
          log: params.log,
          fetchItems,
          downloadFile,
          downloadImage,
          resourceDownloadMode: "allow",
        });
      } catch (error) {
        params.log?.info?.(
          `[${params.account.accountId}] merge_forward source image recovery failed (${messageId}): ${String(error)}`,
        );
        return buildMergedForwardAttachmentPlaceholder({
          msgType,
          fileName,
          reason: isSourcePermissionDenied(error) ? "permission_denied" : "unavailable",
        });
      }
    }
    if (resourceDownloadMode === "forbid") {
      return buildMergedForwardAttachmentPlaceholder({ msgType });
    }
    if (!imageKey || !messageId) {
      return { text: "[image]", coverage: "partial" };
    }
    try {
      const imageData = await downloadImage({ messageId, imageKey });
      if (!imageData) {return { text: "[image]", coverage: "partial" };}
      const archive = await expandDownloadedFile({
        buffer: imageData.buffer,
        contentType: imageData.contentType,
        fileName: `image-${messageId}.png`,
        defaultBaseName: `image-${messageId}`,
      });
      return {
        text: archive.text ? `[image]\n${archive.text}` : "[image]",
        coverage: "partial",
      };
    } catch (error) {
      params.log?.info?.(
        `[${params.account.accountId}] image expansion failed (${messageId}): ${String(error)}`,
      );
      if (isSourcePermissionDenied(error)) {
        return buildMergedForwardAttachmentPlaceholder({
          msgType,
          fileName: `image-${messageId || "unknown"}.png`,
          reason: "permission_denied",
        });
      }
      return { text: "[image]", coverage: "partial" };
    }
  }

  const fileKey = typeof parsed?.file_key === "string" ? parsed.file_key : "";
  if (msgType === "file" && fileKey && messageId) {
    const fileName =
      typeof parsed?.file_name === "string" && parsed.file_name.trim()
        ? parsed.file_name.trim()
        : `file-${messageId}`;
    if (resourceDownloadMode === "resolve_origin") {
      const cached = getCachedExpandedMessage(messageId);
      if (cached) {return cached;}
      try {
        const originalItem = await resolveOriginalMessageItem({
          account: params.account,
          item: params.item,
          fetchItems,
          log: params.log,
        });
        if (!originalItem) {
          return buildMergedForwardAttachmentPlaceholder({ msgType, fileName });
        }
        const cachedOriginal = getCachedExpandedMessage(originalItem.message_id ?? "");
        if (cachedOriginal) {return cachedOriginal;}
        return await expandFetchedMessageItem({
          account: params.account,
          item: originalItem,
          log: params.log,
          fetchItems,
          downloadFile,
          downloadImage,
          resourceDownloadMode: "allow",
        });
      } catch (error) {
        params.log?.info?.(
          `[${params.account.accountId}] merge_forward source file recovery failed (${messageId}): ${String(error)}`,
        );
        return buildMergedForwardAttachmentPlaceholder({
          msgType,
          fileName,
          reason: isSourcePermissionDenied(error) ? "permission_denied" : "unavailable",
        });
      }
    }
    if (resourceDownloadMode === "forbid") {
      return buildMergedForwardAttachmentPlaceholder({ msgType, fileName });
    }
    try {
      const fileData = await downloadFile({ messageId, fileKey });
      if (!fileData) {return { text: `[file: ${fileName}]`, coverage: "partial" };}
      return expandDownloadedFile({
        buffer: fileData.buffer,
        contentType: fileData.contentType,
        fileName,
        defaultBaseName: `file-${messageId}`,
      });
    } catch (error) {
      params.log?.info?.(
        `[${params.account.accountId}] file expansion failed (${messageId}): ${String(error)}`,
      );
      if (isSourcePermissionDenied(error)) {
        return buildMergedForwardAttachmentPlaceholder({
          msgType,
          fileName,
          reason: "permission_denied",
        });
      }
      return { text: `[file: ${fileName}]`, coverage: "partial" };
    }
  }
  if (msgType === "file") {
    const fileName =
      typeof parsed?.file_name === "string" && parsed.file_name.trim()
        ? parsed.file_name.trim()
        : `file-${messageId}`;
    return { text: `[file: ${fileName}]`, coverage: "partial" };
  }

  if ((msgType === "audio" || msgType === "media" || msgType === "video") && fileKey && messageId) {
    const defaultName = msgType === "audio" ? `audio-${messageId}.ogg` : `video-${messageId}.mp4`;
    const fileName =
      typeof parsed?.file_name === "string" && parsed.file_name.trim()
        ? parsed.file_name.trim()
        : defaultName;
    if (resourceDownloadMode === "resolve_origin") {
      const cached = getCachedExpandedMessage(messageId);
      if (cached) {return cached;}
      try {
        const originalItem = await resolveOriginalMessageItem({
          account: params.account,
          item: params.item,
          fetchItems,
          log: params.log,
        });
        if (!originalItem) {
          return buildMergedForwardAttachmentPlaceholder({ msgType, fileName });
        }
        const cachedOriginal = getCachedExpandedMessage(originalItem.message_id ?? "");
        if (cachedOriginal) {return cachedOriginal;}
        return await expandFetchedMessageItem({
          account: params.account,
          item: originalItem,
          log: params.log,
          fetchItems,
          downloadFile,
          downloadImage,
          resourceDownloadMode: "allow",
        });
      } catch (error) {
        params.log?.info?.(
          `[${params.account.accountId}] merge_forward source media recovery failed (${messageId}): ${String(error)}`,
        );
        return buildMergedForwardAttachmentPlaceholder({
          msgType,
          fileName,
          reason: isSourcePermissionDenied(error) ? "permission_denied" : "unavailable",
        });
      }
    }
    if (resourceDownloadMode === "forbid") {
      return buildMergedForwardAttachmentPlaceholder({ msgType, fileName });
    }
    try {
      const fileData = await downloadFile({ messageId, fileKey });
      if (!fileData) {
        return {
          text: msgType === "audio" ? `[audio: ${fileName}]` : `[video: ${fileName}]`,
          coverage: "partial",
        };
      }
      const effectiveContentType =
        msgType === "audio" && fileData.contentType === "application/octet-stream"
          ? "audio/ogg"
          : fileData.contentType;
      const archive = await expandDownloadedFile({
        buffer: fileData.buffer,
        contentType: effectiveContentType,
        fileName,
        defaultBaseName: `${msgType}-${messageId}`,
      });
      return {
        text: archive.text
          ? `${msgType === "audio" ? "[audio]" : "[video]"}\n${archive.text}`
          : fileName,
        coverage: "partial",
      };
    } catch (error) {
      params.log?.info?.(
        `[${params.account.accountId}] media expansion failed (${messageId}): ${String(error)}`,
      );
      if (isSourcePermissionDenied(error)) {
        return buildMergedForwardAttachmentPlaceholder({
          msgType,
          fileName,
          reason: "permission_denied",
        });
      }
      return {
        text: msgType === "audio" ? `[audio: ${fileName}]` : `[video: ${fileName}]`,
        coverage: "partial",
      };
    }
  }
  if (msgType === "audio") {
    const fileName =
      typeof parsed?.file_name === "string" && parsed.file_name.trim()
        ? parsed.file_name.trim()
        : `audio-${messageId}.ogg`;
    return { text: `[audio: ${fileName}]`, coverage: "partial" };
  }
  if (msgType === "media" || msgType === "video") {
    const fileName =
      typeof parsed?.file_name === "string" && parsed.file_name.trim()
        ? parsed.file_name.trim()
        : `video-${messageId}.mp4`;
    return { text: `[video: ${fileName}]`, coverage: "partial" };
  }

  if (msgType === "sticker") {return { text: "[sticker]", coverage: "partial" };}
  if (msgType === "nonsupport") {
    return {
      text: "[unsupported message type — likely video, cannot recover full text]",
      coverage: "none",
    };
  }

  return {
    text: rawContent || `[${msgType}]`,
    coverage: rawContent ? "partial" : "none",
  };
}

export async function expandMergeForwardItems(params: {
  account: ResolvedFeishuAccount;
  parentMessageId: string;
  items: FeishuFetchedMessageItem[];
  log?: ChannelLogSink;
  /** Shared across nested layers to prevent duplicate downloads */
  sharedDownloadedKeys?: Set<string>;
  fetchItems?: FetchMessageItems;
  downloadFile?: DownloadFileResource;
  downloadImage?: DownloadImageResource;
}): Promise<ExpandedFeishuContent> {
  const fetchItems =
    params.fetchItems ??
    ((messageId: string) => fetchMessageItemsViaBotClient(params.account, messageId));
  const subMessages = params.items
    .filter(
      (item) =>
        typeof item.upper_message_id === "string" && item.upper_message_id.trim().length > 0,
    )
    .toSorted((a, b) => {
      const timeA = Number.parseInt(a.create_time ?? "0", 10);
      const timeB = Number.parseInt(b.create_time ?? "0", 10);
      return timeA - timeB;
    });

  if (subMessages.length === 0) {
    return { text: null, coverage: "none" };
  }

  let coverage: ExpandedFeishuContent["coverage"] = "full";
  const blocks: string[] = [];
  const mediaFiles: MergeForwardMediaFile[] = [];

  const downloadFile =
    params.downloadFile ??
    ((fileParams: { messageId: string; fileKey: string }) =>
      downloadFeishuFile({
        account: params.account,
        messageId: fileParams.messageId,
        fileKey: fileParams.fileKey,
      }));
  const downloadImage =
    params.downloadImage ??
    ((imageParams: { messageId: string; imageKey: string }) =>
      downloadFeishuImage({
        account: params.account,
        messageId: imageParams.messageId,
        imageKey: imageParams.imageKey,
      }));

  // Deduplicate across all nesting layers
  const downloadedKeys = params.sharedDownloadedKeys ?? new Set<string>();

  // Batch-resolve sender names (best-effort, don't block on failure)
  const senderNames = new Map<string, string>();
  // Only resolve human users (ou_ prefix), skip bots (cli_ prefix) and other types
  const humanSenderIds = [
    ...new Set(
      subMessages.filter((m) => m.sender?.id?.startsWith("ou_")).map((m) => m.sender!.id!),
    ),
  ];
  // For bot senders, use mention name or app_id prefix
  for (const m of subMessages) {
    const sid = m.sender?.id;
    if (sid && !sid.startsWith("ou_") && !senderNames.has(sid)) {
      // Find bot name from mentions (bot might be @mentioned somewhere)
      const mentionName = m.mentions?.find((mt) => mt.id === sid)?.name;
      senderNames.set(sid, mentionName ?? `bot:${sid.slice(0, 16)}`);
    }
  }
  if (humanSenderIds.length > 0) {
    const client = getFeishuClient(params.account);
    await Promise.allSettled(
      humanSenderIds.map(async (senderId) => {
        try {
          // oxlint-disable-next-line typescript/no-explicit-any
          const res: any = await client.contact.user.get({
            path: { user_id: senderId },
            params: { user_id_type: "open_id" },
          });
          if (res.code === 0 && res.data?.user?.name) {
            senderNames.set(senderId, res.data.user.name);
          }
        } catch {
          // best-effort — skip if lookup fails
        }
      }),
    );
  }

  for (const item of subMessages) {
    const msgType = item.msg_type ?? "unknown";
    const messageId = item.message_id ?? "";
    const rawContent = item.body?.content ?? "";
    const parsed = parseJsonContent(rawContent);

    // Build sender + time prefix for this sub-message
    const senderId = item.sender?.id ?? "";
    const senderName = senderNames.get(senderId) ?? senderId.slice(0, 12) ?? "unknown";
    const timeStr = item.create_time
      ? new Date(Number.parseInt(item.create_time, 10)).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        })
      : "";
    const senderPrefix = timeStr ? `[${senderName} ${timeStr}]` : `[${senderName}]`;

    // Try direct media download for attachment types (using bot token)
    // IMPORTANT: use parentMessageId for resource downloads — Feishu API error 234003
    // ("File not in msg") if you use the sub-message's own message_id
    const downloadMsgId = params.parentMessageId;
    if (isAttachmentMessageType(msgType) && downloadMsgId && parsed) {
      try {
        let downloaded: { buffer: Buffer; contentType?: string } | null = null;
        let fileName = "";
        let mediaType: MergeForwardMediaFile["type"] = "file";

        if (msgType === "image") {
          const imageKey = typeof parsed.image_key === "string" ? parsed.image_key : "";
          if (imageKey && !downloadedKeys.has(imageKey)) {
            downloadedKeys.add(imageKey);
            downloaded = await downloadImage({ messageId: downloadMsgId, imageKey });
            fileName = `image-${messageId.slice(-8)}.png`;
            mediaType = "image";
          } else if (imageKey) {
            // Already downloaded, skip
            blocks.push(prefixBulletBlock("[image: already included above]"));
            continue;
          }
        } else {
          const fileKey = typeof parsed.file_key === "string" ? parsed.file_key : "";
          fileName =
            typeof parsed.file_name === "string" && parsed.file_name.trim()
              ? parsed.file_name.trim()
              : `${msgType}-${messageId.slice(-8)}`;
          if (fileKey && !downloadedKeys.has(fileKey)) {
            downloadedKeys.add(fileKey);
            downloaded = await downloadFile({ messageId: downloadMsgId, fileKey });
          } else if (fileKey) {
            blocks.push(prefixBulletBlock(`[${msgType}: ${fileName} — already included above]`));
            continue;
          }
          if (msgType === "audio") {mediaType = "audio";}
          else if (msgType === "media" || msgType === "video") {mediaType = "video";}
        }

        if (downloaded) {
          const ct = downloaded.contentType ?? "application/octet-stream";
          const localPath = saveMediaToDisk({
            buffer: downloaded.buffer,
            contentType: ct,
            fileName,
          });
          mediaFiles.push({ type: mediaType, localPath, fileName, contentType: ct });
          blocks.push(
            prefixBulletBlock(`${senderPrefix} [${mediaType}: ${fileName} → saved: ${localPath}]`),
          );
          coverage = mergeCoverage(coverage, "full");
          params.log?.info?.(
            `[${params.account.accountId}] merge_forward media saved: ${mediaType} ${fileName} → ${localPath}`,
          );
          continue;
        }
      } catch (err) {
        params.log?.info?.(
          `[${params.account.accountId}] merge_forward media download failed (${messageId}): ${String(err)}`,
        );
        // fall through to text expansion
      }
    }

    // Text expansion (non-media or media download failed)
    const expanded = await expandFetchedMessageItem({
      account: params.account,
      item,
      log: params.log,
      fetchItems,
      downloadFile: params.downloadFile,
      downloadImage: params.downloadImage,
      resourceDownloadMode: isAttachmentMessageType(msgType) ? "forbid" : "allow",
    });
    coverage = mergeCoverage(coverage, expanded.coverage);
    if (expanded.text) {blocks.push(prefixBulletBlock(`${senderPrefix} ${expanded.text}`));}
    if (expanded.mediaFiles) {mediaFiles.push(...expanded.mediaFiles);}
  }

  return {
    text: blocks.length > 0 ? blocks.join("\n") : null,
    coverage: blocks.length > 0 ? coverage : "none",
    mediaFiles: mediaFiles.length > 0 ? mediaFiles : undefined,
  };
}

export async function expandMergeForwardMessage(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  log?: ChannelLogSink;
  sharedDownloadedKeys?: Set<string>;
  fetchItems?: FetchMessageItems;
  downloadFile?: DownloadFileResource;
  downloadImage?: DownloadImageResource;
  resourceDownloadMode?: ResourceDownloadMode;
}): Promise<ExpandedFeishuContent> {
  try {
    const sharedDownloadedKeys = params.sharedDownloadedKeys ?? new Set<string>();
    const fetchItems =
      params.fetchItems ??
      ((messageId: string) => fetchMessageItemsViaBotClient(params.account, messageId));
    const items = await fetchItems(params.messageId);
    const expanded = await expandMergeForwardItems({
      account: params.account,
      parentMessageId: params.messageId,
      items,
      log: params.log,
      sharedDownloadedKeys,
      fetchItems,
      downloadFile: params.downloadFile,
      downloadImage: params.downloadImage,
    });
    if (expanded.text) {
      params.log?.info?.(
        `[${params.account.accountId}] merge_forward expanded: ${items.length} api item(s), ${expanded.text.split("\n").length} readable line(s)`,
      );
    } else {
      params.log?.info?.(
        `[${params.account.accountId}] merge_forward fetch returned no readable sub-messages`,
      );
    }
    return expanded;
  } catch (error) {
    params.log?.info?.(
      `[${params.account.accountId}] merge_forward fetch failed: ${String(error)}`,
    );
    return { text: null, coverage: "none" };
  }
}
