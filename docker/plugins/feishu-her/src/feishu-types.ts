/**
 * Shared Feishu type definitions.
 *
 * Extracted from feishu-message.ts to break the circular dependency:
 *   feishu-message → outbound → message-metadata → feishu-message
 */

export type FeishuMessageCoverage = "full" | "partial" | "none";
export type FeishuActorIdType = "open_id" | "app_id" | "user_id" | "unknown";
export type FeishuActorKind = "human" | "bot" | "system" | "unknown";
export type FeishuResolutionSource =
  | "event"
  | "history_api"
  | "chat_member"
  | "directory"
  | "config"
  | "archive"
  | "cache";

export type FeishuActorRef = {
  canonicalId: string;
  canonicalIdType: FeishuActorIdType;
  senderType: string;
  actorKind: FeishuActorKind;
  displayName?: string;
  rawIds: Partial<Record<"open_id" | "user_id" | "union_id" | "app_id", string>>;
  resolutionSource: FeishuResolutionSource;
  resolved: boolean;
};

export type FeishuAttachmentKind =
  | "image"
  | "file"
  | "audio"
  | "video"
  | "post_image"
  | "post_media";

export type FeishuAttachmentRef = {
  kind: FeishuAttachmentKind;
  fileKey?: string;
  imageKey?: string;
  fileName?: string;
  durationSec?: number;
  coverImageKey?: string;
  localPath?: string;
  extractedText?: string;
  coverage: FeishuMessageCoverage;
};

export type FeishuTextPayload = {
  raw: string;
  normalized: string;
  withoutFooter: string;
  footer?: string;
};

export type FeishuReplyRef = {
  parentId?: string;
  rootId?: string;
  threadId?: string;
  hasThread?: boolean;
  quoted?: {
    messageId: string;
    messageType: string;
    sender: FeishuActorRef;
    text: FeishuTextPayload;
    attachments: FeishuAttachmentRef[];
  };
};
