import type { ChannelLogSink } from "openclaw/plugin-sdk";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { createArchiveTextForBuffer } from "./group-archive.js";
import { formatFeishuAtText } from "./mention-text.js";
import { getCachedMessageText } from "./message-text-cache.js";
import { downloadFeishuFile, downloadFeishuImage, getFeishuClient } from "./outbound.js";

export type FeishuFetchedMessageItem = {
  message_id?: string;
  upper_message_id?: string;
  create_time?: string;
  msg_type?: string;
  chat_id?: string;
  body?: { content?: string };
  sender?: { id?: string; sender_type?: string };
};

export type ExpandedFeishuContent = {
  text: string | null;
  coverage: "full" | "partial" | "none";
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

function mergeCoverage(
  left: ExpandedFeishuContent["coverage"],
  right: ExpandedFeishuContent["coverage"],
): ExpandedFeishuContent["coverage"] {
  if (left === "none" || right === "none") return "none";
  if (left === "partial" || right === "partial") return "partial";
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
  const zhCn = parsed.zh_cn as Record<string, unknown> | undefined;
  const enUs = parsed.en_us as Record<string, unknown> | undefined;
  const body = (
    Array.isArray(parsed.content) ? parsed : (zhCn ?? enUs ?? Object.values(parsed)[0])
  ) as Record<string, unknown> | undefined;
  const content = body?.content as Array<Array<Record<string, unknown>>> | undefined;
  if (!Array.isArray(content)) {
    return {
      text: JSON.stringify(parsed),
      coverage: "partial",
    };
  }

  const lines: string[] = [];
  let coverage: ExpandedFeishuContent["coverage"] = "full";
  for (const paragraph of content) {
    const parts: string[] = [];
    for (const el of paragraph) {
      if (el.tag === "text") parts.push(String(el.text ?? ""));
      else if (el.tag === "a") parts.push(`[${el.text ?? ""}](${el.href ?? ""})`);
      else if (el.tag === "at")
        parts.push(formatFeishuAtText({ userId: el.user_id, userName: el.user_name }));
      else if (el.tag === "img") {
        parts.push("[image]");
        coverage = "partial";
      } else if (el.tag === "media") {
        parts.push(`[video:${el.file_name ?? el.file_key ?? ""}]`);
        coverage = "partial";
      } else if (el.tag === "emotion") {
        parts.push(el.emoji_type ? `[${String(el.emoji_type)}]` : "[emotion]");
      } else if (el.tag) {
        coverage = "partial";
      }
    }
    lines.push(parts.join(""));
  }
  const title =
    typeof body?.title === "string" && body.title.trim() ? `${body.title.trim()}\n` : "";
  return {
    text: `${title}${lines.join("\n")}`.trim() || null,
    coverage,
  };
}

function extractInteractiveText(parsed: Record<string, unknown>): ExpandedFeishuContent {
  const rows = parsed.elements as Array<Array<Record<string, unknown>>> | undefined;
  if (!Array.isArray(rows)) {
    return {
      text: "[interactive card — content degraded by API, cannot recover full text]",
      coverage: "none",
    };
  }

  const lines: string[] = [];
  let coverage: ExpandedFeishuContent["coverage"] = "partial";
  for (const row of rows) {
    const parts: string[] = [];
    for (const el of row) {
      if (el.tag === "text" || el.tag === "a") parts.push(String(el.text ?? ""));
      else if (el.tag === "at")
        parts.push(formatFeishuAtText({ userId: el.user_id, userName: el.user_name }));
      else if (el.tag === "img") parts.push("[image]");
    }
    if (parts.length > 0) lines.push(parts.join(""));
  }

  return {
    text:
      lines.join("\n").trim() ||
      "[interactive card — content degraded by API, cannot recover full text]",
    coverage,
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
  if (!cachedText) return null;
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
  if (!messageId) return null;
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
      fetchItems,
      downloadFile,
      downloadImage,
      resourceDownloadMode,
    });
  }

  if (msgType === "text") {
    return {
      text: typeof parsed?.text === "string" ? parsed.text : rawContent || null,
      coverage: "full",
    };
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
      if (cached) return cached;
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
        if (cachedOriginal) return cachedOriginal;
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
      if (!imageData) return { text: "[image]", coverage: "partial" };
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
      if (cached) return cached;
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
        if (cachedOriginal) return cachedOriginal;
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
      if (!fileData) return { text: `[file: ${fileName}]`, coverage: "partial" };
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
      if (cached) return cached;
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
        if (cachedOriginal) return cachedOriginal;
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

  if (msgType === "sticker") return { text: "[sticker]", coverage: "partial" };
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
  items: FeishuFetchedMessageItem[];
  log?: ChannelLogSink;
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
  for (const item of subMessages) {
    const expanded = await expandFetchedMessageItem({
      account: params.account,
      item,
      log: params.log,
      fetchItems,
      downloadFile: params.downloadFile,
      downloadImage: params.downloadImage,
      resourceDownloadMode: isAttachmentMessageType(item.msg_type ?? "")
        ? "resolve_origin"
        : "allow",
    });
    coverage = mergeCoverage(coverage, expanded.coverage);
    if (expanded.text) blocks.push(prefixBulletBlock(expanded.text));
  }

  return {
    text: blocks.length > 0 ? blocks.join("\n") : null,
    coverage: blocks.length > 0 ? coverage : "none",
  };
}

export async function expandMergeForwardMessage(params: {
  account: ResolvedFeishuAccount;
  messageId: string;
  log?: ChannelLogSink;
  fetchItems?: FetchMessageItems;
  downloadFile?: DownloadFileResource;
  downloadImage?: DownloadImageResource;
  resourceDownloadMode?: ResourceDownloadMode;
}): Promise<ExpandedFeishuContent> {
  try {
    const fetchItems =
      params.fetchItems ??
      ((messageId: string) => fetchMessageItemsViaBotClient(params.account, messageId));
    const items = await fetchItems(params.messageId);
    const expanded = await expandMergeForwardItems({
      account: params.account,
      items,
      log: params.log,
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
