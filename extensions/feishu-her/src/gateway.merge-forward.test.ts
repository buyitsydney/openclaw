import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "./accounts.js";

const createArchiveTextForBufferMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());
const downloadFeishuFileMock = vi.hoisted(() => vi.fn());
const downloadFeishuImageMock = vi.hoisted(() => vi.fn());
const getCachedMessageTextMock = vi.hoisted(() => vi.fn());
vi.mock("./group-archive.js", () => ({
  createArchiveTextForBuffer: createArchiveTextForBufferMock,
}));
vi.mock("./message-text-cache.js", () => ({
  getCachedMessageText: getCachedMessageTextMock,
}));
vi.mock("./outbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbound.js")>();
  return {
    ...actual,
    getFeishuClient: getFeishuClientMock,
    downloadFeishuFile: downloadFeishuFileMock,
    downloadFeishuImage: downloadFeishuImageMock,
  };
});

import { expandMergeForwardItems, expandMergeForwardMessage } from "./merge-forward.js";

const MOCK_ACCOUNT: ResolvedFeishuAccount = {
  accountId: "default",
  enabled: true,
  appId: "cli_x",
  appSecret: "sec_x",
  credentialSource: "config",
  config: {},
};

describe("gateway merge_forward", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createArchiveTextForBufferMock.mockResolvedValue(null);
    downloadFeishuImageMock.mockResolvedValue(null);
    getCachedMessageTextMock.mockReturnValue(null);
  });

  it("formats merged-forward sub-messages in create_time order and hydrates source attachments", async () => {
    createArchiveTextForBufferMock.mockResolvedValue(
      '<file name="report.pdf">\nreport body\n</file>\n[local archive: report.pdf saved at /tmp/report.pdf]',
    );
    downloadFeishuFileMock.mockResolvedValue({
      buffer: Buffer.from("pdf"),
      contentType: "application/pdf",
    });
    const fetchItems = vi.fn(async (messageId: string) => {
      if (messageId === "sub-2") {
        return [
          {
            message_id: "sub-2",
            msg_type: "file",
            body: { content: JSON.stringify({ file_key: "file_source_1", file_name: "report.pdf" }) },
          },
        ];
      }
      throw new Error(`unexpected message lookup ${messageId}`);
    });
    const result = await expandMergeForwardItems({
      account: MOCK_ACCOUNT,
      fetchItems,
      items: [
        {
          message_id: "container",
          msg_type: "merge_forward",
          body: { content: "Merged and Forwarded Message" },
        },
        {
          message_id: "sub-2",
          upper_message_id: "container",
          create_time: "20",
          msg_type: "file",
          body: { content: JSON.stringify({ file_key: "file_report_1", file_name: "report.pdf" }) },
        },
        {
          message_id: "sub-1",
          upper_message_id: "container",
          create_time: "10",
          msg_type: "text",
          body: { content: JSON.stringify({ text: "alpha" }) },
        },
        {
          message_id: "sub-3",
          upper_message_id: "container",
          create_time: "15",
          msg_type: "text",
          body: { content: JSON.stringify({ text: "beta" }) },
        },
      ],
    });

    expect(result.text).toContain("- alpha");
    expect(result.text).toContain("- beta");
    expect(result.text).toContain('- <file name="report.pdf">');
    expect(result.text).toContain("report body");
    expect(result.coverage).toBe("full");
    expect(fetchItems).toHaveBeenCalledWith("sub-2");
    expect(downloadFeishuFileMock).toHaveBeenCalledWith({
      account: MOCK_ACCOUNT,
      messageId: "sub-2",
      fileKey: "file_source_1",
    });
    expect(downloadFeishuImageMock).not.toHaveBeenCalled();
  });

  it("fetches and expands merged-forward content via message.get", async () => {
    const getMessageMock = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: "container",
            msg_type: "merge_forward",
            body: { content: "Merged and Forwarded Message" },
          },
          {
            message_id: "sub-1",
            upper_message_id: "container",
            create_time: "1",
            msg_type: "text",
            body: { content: JSON.stringify({ text: "第一条" }) },
          },
          {
            message_id: "sub-2",
            upper_message_id: "container",
            create_time: "2",
            msg_type: "text",
            body: { content: JSON.stringify({ text: "第二条" }) },
          },
        ],
      },
    });
    getFeishuClientMock.mockReturnValue({
      im: {
        message: {
          get: getMessageMock,
        },
      },
    });

    const result = await expandMergeForwardMessage({
      account: MOCK_ACCOUNT,
      messageId: "om_merge_1",
    });

    expect(getMessageMock).toHaveBeenCalledWith({
      path: { message_id: "om_merge_1" },
    });
    expect(result.text).toBe("- 第一条\n- 第二条");
    expect(result.coverage).toBe("full");
  });

  it("reuses cached source text for merged-forward media", async () => {
    getCachedMessageTextMock.mockImplementation((messageId: string) =>
      messageId === "sub-2" ? "[video]\n[file: tiktok_video.mp4 saved at /tmp/tiktok_video.mp4]" : null,
    );
    const fetchItems = vi.fn(async (messageId: string) => {
      throw new Error(`unexpected message lookup ${messageId}`);
    });

    const result = await expandMergeForwardItems({
      account: MOCK_ACCOUNT,
      fetchItems,
      items: [
        {
          message_id: "container",
          msg_type: "merge_forward",
          body: { content: "Merged and Forwarded Message" },
        },
        {
          message_id: "sub-2",
          upper_message_id: "container",
          create_time: "20",
          msg_type: "media",
          body: { content: JSON.stringify({ file_key: "media_source_1", file_name: "tiktok_video.mp4" }) },
        },
      ],
    });

    expect(result.text).toContain("[video]");
    expect(result.text).toContain("tiktok_video.mp4 saved at /tmp/tiktok_video.mp4");
    expect(result.coverage).toBe("partial");
    expect(fetchItems).not.toHaveBeenCalled();
  });

  it("surfaces source-chat permission denial for merged-forward attachments", async () => {
    downloadFeishuFileMock.mockRejectedValue(
      new Error(
        'feishu user resource download failed: HTTP 400 {"code":230002,"msg":"Bot/User can NOT be out of the chat."}',
      ),
    );
    const fetchItems = vi.fn(async (messageId: string) => {
      if (messageId === "sub-2") {
        return [
          {
            message_id: "sub-2",
            msg_type: "file",
            chat_id: "oc_source_chat",
            body: { content: JSON.stringify({ file_key: "file_source_1", file_name: "report.pdf" }) },
          },
        ];
      }
      throw new Error(`unexpected message lookup ${messageId}`);
    });

    const result = await expandMergeForwardItems({
      account: MOCK_ACCOUNT,
      fetchItems,
      items: [
        {
          message_id: "container",
          msg_type: "merge_forward",
          body: { content: "Merged and Forwarded Message" },
        },
        {
          message_id: "sub-2",
          upper_message_id: "container",
          create_time: "20",
          msg_type: "file",
          body: { content: JSON.stringify({ file_key: "file_report_1", file_name: "report.pdf" }) },
        },
      ],
    });

    expect(result.text).toContain("source chat inaccessible for current user");
    expect(result.coverage).toBe("partial");
  });
});
