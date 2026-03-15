import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.hoisted(() => vi.fn());
const sendFeishuRichTextDetailedMock = vi.hoisted(() => vi.fn());
const sendFeishuTextMock = vi.hoisted(() => vi.fn());
const uploadFeishuImageMock = vi.hoisted(() => vi.fn());
const sendFeishuImageDetailedMock = vi.hoisted(() => vi.fn());
const uploadFeishuAudioMock = vi.hoisted(() => vi.fn());
const sendFeishuAudioDetailedMock = vi.hoisted(() => vi.fn());
const uploadFeishuFileMock = vi.hoisted(() => vi.fn());
const sendFeishuFileDetailedMock = vi.hoisted(() => vi.fn());
const sendFeishuVideoDetailedMock = vi.hoisted(() => vi.fn());
const addFeishuReactionMock = vi.hoisted(() => vi.fn());
const removeFeishuReactionMock = vi.hoisted(() => vi.fn());
const deleteFeishuMessageMock = vi.hoisted(() => vi.fn());
const archiveSentFeishuTextMessageMock = vi.hoisted(() => vi.fn());
const archiveSentFeishuBinaryMessageMock = vi.hoisted(() => vi.fn());
const cacheMessageTextMock = vi.hoisted(() => vi.fn());
const recordSentMessageMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    loadWebMedia: loadWebMediaMock,
  };
});

vi.mock("./outbound.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound.js")>("./outbound.js");
  return {
    ...actual,
    sendFeishuRichTextDetailed: sendFeishuRichTextDetailedMock,
    sendFeishuText: sendFeishuTextMock,
    uploadFeishuImage: uploadFeishuImageMock,
    sendFeishuImageDetailed: sendFeishuImageDetailedMock,
    uploadFeishuAudio: uploadFeishuAudioMock,
    sendFeishuAudioDetailed: sendFeishuAudioDetailedMock,
    uploadFeishuFile: uploadFeishuFileMock,
    sendFeishuFileDetailed: sendFeishuFileDetailedMock,
    sendFeishuVideoDetailed: sendFeishuVideoDetailedMock,
    addFeishuReaction: addFeishuReactionMock,
    removeFeishuReaction: removeFeishuReactionMock,
    deleteFeishuMessage: deleteFeishuMessageMock,
  };
});

vi.mock("./group-archive.js", () => ({
  archiveSentFeishuTextMessage: archiveSentFeishuTextMessageMock,
  archiveSentFeishuBinaryMessage: archiveSentFeishuBinaryMessageMock,
}));

vi.mock("./message-text-cache.js", () => ({
  cacheMessageText: cacheMessageTextMock,
}));

vi.mock("./sent-message-log.js", () => ({
  recordSentMessage: recordSentMessageMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
  }),
}));

import { feishuPlugin } from "./channel.js";

const cfg = {
  channels: {
    feishu: {
      enabled: true,
      name: "her",
      appId: "cli_her",
      appSecret: "sec_her",
    },
  },
} as OpenClawConfig;

describe("feishu-her channel outbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendFeishuRichTextDetailedMock.mockResolvedValue({
      messageId: "om_sent_text_1",
      messageType: "interactive",
      chatId: "oc_group_1",
    });
    sendFeishuTextMock.mockResolvedValue("om_sent_fallback_1");
    uploadFeishuImageMock.mockResolvedValue("img_v3_test");
    sendFeishuImageDetailedMock.mockResolvedValue({
      messageId: "om_sent_image_1",
      messageType: "image",
      chatId: "oc_group_1",
    });
    uploadFeishuAudioMock.mockResolvedValue("audio_v3_test");
    sendFeishuAudioDetailedMock.mockResolvedValue({
      messageId: "om_sent_audio_1",
      messageType: "audio",
      chatId: "oc_group_1",
    });
    uploadFeishuFileMock.mockResolvedValue("file_v3_test");
    sendFeishuFileDetailedMock.mockResolvedValue({
      messageId: "om_sent_file_1",
      messageType: "file",
      chatId: "oc_group_1",
    });
    sendFeishuVideoDetailedMock.mockResolvedValue({
      messageId: "om_sent_video_1",
      messageType: "media",
      chatId: "oc_group_1",
    });
    addFeishuReactionMock.mockResolvedValue("reaction_1");
    removeFeishuReactionMock.mockResolvedValue(true);
    deleteFeishuMessageMock.mockResolvedValue({ ok: true, code: 0, msg: "ok" });
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("png"),
      contentType: "image/png",
    });
  });

  it("uses direct outbound so replyTo stays inside feishu-her adapter", () => {
    expect(feishuPlugin.outbound?.deliveryMode).toBe("direct");
  });

  it("forwards replyToId on sendText and archives explicit reply metadata", async () => {
    const result = await feishuPlugin.outbound?.sendText?.({
      cfg,
      to: "oc_group_1",
      text: "请引用这条旧消息回复",
      accountId: "default",
      replyToId: "om_reply_target",
    } as never);

    expect(sendFeishuRichTextDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc_group_1",
        text: "请引用这条旧消息回复",
        replyToMessageId: "om_reply_target",
      }),
    );
    expect(archiveSentFeishuTextMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc_group_1",
        text: "请引用这条旧消息回复",
        reply: expect.objectContaining({
          parentId: "om_reply_target",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "feishu",
        messageId: "om_sent_text_1",
      }),
    );
  });

  it("forwards replyToId on sendMedia for both caption and binary message", async () => {
    const result = await feishuPlugin.outbound?.sendMedia?.({
      cfg,
      to: "oc_group_1",
      text: "图片说明也必须挂引用",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
      replyToId: "om_reply_target",
    } as never);

    expect(sendFeishuImageDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc_group_1",
        imageKey: "img_v3_test",
        replyToMessageId: "om_reply_target",
      }),
    );
    expect(sendFeishuRichTextDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc_group_1",
        text: "图片说明也必须挂引用",
        replyToMessageId: "om_reply_target",
      }),
    );
    expect(archiveSentFeishuBinaryMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc_group_1",
        reply: expect.objectContaining({
          parentId: "om_reply_target",
        }),
      }),
    );
    expect(archiveSentFeishuTextMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "oc_group_1",
        reply: expect.objectContaining({
          parentId: "om_reply_target",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "feishu",
        messageId: "om_sent_image_1",
      }),
    );
  });
});
