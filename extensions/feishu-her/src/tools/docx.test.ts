import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());
const downloadDocxImageMock = vi.hoisted(() => vi.fn());
const downloadWhiteboardImageMock = vi.hoisted(() => vi.fn());
const readDriveFileContextByTokenMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
  downloadDocxImage: downloadDocxImageMock,
  downloadWhiteboardImage: downloadWhiteboardImageMock,
}));

vi.mock("../drive-file-read.js", () => ({
  readDriveFileContextByToken: readDriveFileContextByTokenMock,
}));

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

import { registerFeishuDocTools } from "./docx.js";

type ToolDef = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content?: unknown; details: unknown }>;
};

type WhiteboardMimeFixture = {
  capturedIssue: {
    title: string;
  };
  simulatedDoc: {
    title: string;
    blocks: Array<{ block_id: string; block_type: number; board?: { token?: string } }>;
    downloadedWhiteboardImage: {
      contentType: string;
      base64: string;
    };
  };
};

type DocxInlineImageFixture = {
  capturedIssue: {
    title: string;
  };
  simulatedDoc: {
    title: string;
    blocks: Array<{
      block_id: string;
      block_type: number;
      image?: { token?: string; caption?: { content?: string } };
    }>;
    downloadedDocxImage: {
      contentType: string;
      base64: string;
    };
  };
};

const whiteboardMimeFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../test/fixtures/feishu-docx-whiteboard-jpeg-mime-mismatch.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as WhiteboardMimeFixture;

const docxInlineImageFixture = JSON.parse(
  readFileSync(
    new URL("../../../../test/fixtures/feishu-docx-inline-image-download.json", import.meta.url),
    "utf8",
  ),
) as DocxInlineImageFixture;

describe("feishu-her feishu_doc anti-regression", () => {
  const convertMock = vi.hoisted(() => vi.fn());
  const createDocMock = vi.hoisted(() => vi.fn());
  const docGetMock = vi.hoisted(() => vi.fn());
  const descendantCreateMock = vi.hoisted(() => vi.fn());
  const blockListMock = vi.hoisted(() => vi.fn());
  const blockGetMock = vi.hoisted(() => vi.fn());
  const rawContentMock = vi.hoisted(() => vi.fn());
  const batchDeleteMock = vi.hoisted(() => vi.fn());
  const childrenGetMock = vi.hoisted(() => vi.fn());
  const childrenCreateMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();

    listEnabledFeishuAccountsMock.mockReturnValue([
      {
        accountId: "default",
        enabled: true,
        appId: "app_id",
        appSecret: "app_secret",
      },
    ]);

    getFeishuClientMock.mockReturnValue({
      docx: {
        document: {
          convert: convertMock,
          create: createDocMock,
          get: docGetMock,
          rawContent: rawContentMock,
        },
        documentBlock: {
          list: blockListMock,
          get: blockGetMock,
          patch: vi.fn(),
          batchUpdate: vi.fn(),
        },
        documentBlockDescendant: {
          create: descendantCreateMock,
        },
        documentBlockChildren: {
          batchDelete: batchDeleteMock,
          get: childrenGetMock,
          create: childrenCreateMock,
        },
      },
    });

    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks: [
          { block_id: "b1", block_type: 2, text: { elements: [{ text_run: { content: "x" } }] } },
        ],
        first_level_block_ids: ["b1"],
      },
    });
    createDocMock.mockResolvedValue({
      code: 0,
      data: {
        document: {
          document_id: "doc_created_1",
          title: "created",
        },
      },
    });
    docGetMock.mockResolvedValue({
      code: 0,
      data: {
        document: {
          title: whiteboardMimeFixture.simulatedDoc.title,
          revision_id: "rev_1",
        },
      },
    });
    descendantCreateMock.mockResolvedValue({
      code: 0,
      data: {
        children: [{ block_id: "b1", block_type: 2 }],
      },
    });
    blockGetMock.mockResolvedValue({
      code: 0,
      data: {
        block: { block_id: "b1" },
      },
    });
    rawContentMock.mockResolvedValue({
      code: 0,
      data: { content: "old content" },
    });
    batchDeleteMock.mockResolvedValue({ code: 0 });
    childrenGetMock.mockResolvedValue({
      code: 0,
      data: {
        items: [
          { block_id: "c1", block_type: 2 },
          { block_id: "c2", block_type: 4 },
          { block_id: "c3", block_type: 2 },
        ],
      },
    });
    childrenCreateMock.mockResolvedValue({ code: 0, data: { children: [] } });
    downloadDocxImageMock.mockResolvedValue(null);
    downloadWhiteboardImageMock.mockResolvedValue(null);
    getValidUserTokenMock.mockResolvedValue({
      access_token: "user_token",
      open_id: "ou_user",
    });
    requireUserTokenMock.mockResolvedValue({
      ok: true,
      token: {
        access_token: "user_token",
        open_id: "ou_user",
      },
    });
    resolveOAuthRedirectUriMock.mockReturnValue("https://example.com/callback");
    callFeishuApiWithUserTokenMock.mockImplementation(
      async (request: { endpoint: string; query?: Record<string, string> }) => {
        const segments = request.endpoint.split("/");
        const documentId = decodeURIComponent(segments[4] ?? "");
        if (request.endpoint.endsWith("/raw_content")) {
          const res = await rawContentMock({
            path: { document_id: documentId },
          });
          return {
            code: res.code ?? 0,
            msg: res.msg ?? "ok",
            data: res.data ?? null,
          };
        }
        if (request.endpoint.endsWith("/blocks")) {
          const params = request.query?.page_token
            ? {
                page_token: request.query.page_token,
                page_size: Number(request.query.page_size ?? "500"),
              }
            : { page_size: Number(request.query?.page_size ?? "500") };
          const res = await blockListMock({
            path: { document_id: documentId },
            params,
          });
          return {
            code: res.code ?? 0,
            msg: res.msg ?? "ok",
            data: res.data ?? null,
          };
        }
        if (request.endpoint.includes("/blocks/")) {
          const blockId = decodeURIComponent(segments[6] ?? "");
          const res = await blockGetMock({
            path: { document_id: documentId, block_id: blockId },
          });
          return {
            code: res.code ?? 0,
            msg: res.msg ?? "ok",
            data: res.data ?? null,
          };
        }
        const res = await docGetMock({
          path: { document_id: documentId },
        });
        return {
          code: res.code ?? 0,
          msg: res.msg ?? "ok",
          data: res.data ?? null,
        };
      },
    );
    readDriveFileContextByTokenMock.mockResolvedValue({
      ok: true,
      token: "file_1",
      title: "file.pdf",
      contentType: "application/pdf",
      content: '<file name="file.pdf">\nhello\n</file>',
    });
  });

  function registerAndGetTool() {
    const registerTool = vi.fn();
    registerFeishuDocTools({
      config: { channels: { feishu: { enabled: true } } },
      logger: { info: vi.fn() },
      registerTool,
    } as never);

    const tool = registerTool.mock.calls
      .map((call) => call[0] as ToolDef)
      .find((t) => t.name === "feishu_doc");
    expect(tool).toBeDefined();
    return tool!;
  }

  function getImageBlock(result: { content?: unknown }) {
    const content = Array.isArray(result.content) ? result.content : [];
    return content.find(
      (block): block is { type: "image"; data: string; mimeType: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "image" &&
        typeof (block as { data?: unknown }).data === "string" &&
        typeof (block as { mimeType?: unknown }).mimeType === "string",
    );
  }

  function getImageBlocks(result: { content?: unknown }) {
    const content = Array.isArray(result.content) ? result.content : [];
    return content.filter(
      (block): block is { type: "image"; data: string; mimeType: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "image" &&
        typeof (block as { data?: unknown }).data === "string" &&
        typeof (block as { mimeType?: unknown }).mimeType === "string",
    );
  }

  it("list_blocks should paginate and return all blocks", async () => {
    blockListMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ block_id: "p1", block_type: 2 }],
          has_more: true,
          page_token: "next_1",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ block_id: "p2", block_type: 2 }],
          has_more: false,
        },
      });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "list_blocks",
      doc_token: "doc_1",
    });

    expect(blockListMock).toHaveBeenCalledTimes(2);
    expect(blockListMock).toHaveBeenNthCalledWith(1, {
      path: { document_id: "doc_1" },
      params: { page_size: 500 },
    });
    expect(blockListMock).toHaveBeenNthCalledWith(2, {
      path: { document_id: "doc_1" },
      params: { page_token: "next_1", page_size: 500 },
    });

    const details = result.details as { blocks: Array<{ block_id: string }> };
    expect(details.blocks).toHaveLength(2);
    expect(details.blocks.map((b) => b.block_id)).toEqual(["p1", "p2"]);
  });

  it("read should preserve JPEG MIME for whiteboard images", async () => {
    rawContentMock.mockResolvedValue({
      code: 0,
      data: { content: "minutes content" },
    });
    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: whiteboardMimeFixture.simulatedDoc.blocks,
        has_more: false,
      },
    });
    downloadWhiteboardImageMock.mockResolvedValue({
      buffer: Buffer.from(
        whiteboardMimeFixture.simulatedDoc.downloadedWhiteboardImage.base64,
        "base64",
      ),
      contentType: whiteboardMimeFixture.simulatedDoc.downloadedWhiteboardImage.contentType,
    });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "read",
      doc_token: "doc_with_board",
    });

    const image = getImageBlock(result);
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/jpeg");
  });

  it("read should support drive file tokens when doc_type=file", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "read",
      doc_token: "file_token_1",
      doc_type: "file",
    });

    expect(readDriveFileContextByTokenMock).toHaveBeenCalledWith({
      account: expect.objectContaining({ accountId: "default" }),
      fileToken: "file_token_1",
    });
    expect(rawContentMock).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      title: "file.pdf",
      content_type: "application/pdf",
      object_type: "file",
      content: '<file name="file.pdf">\nhello\n</file>',
    });
  });

  it("list_blocks should preserve JPEG MIME for whiteboard images", async () => {
    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: whiteboardMimeFixture.simulatedDoc.blocks,
        has_more: false,
      },
    });
    downloadWhiteboardImageMock.mockResolvedValue({
      buffer: Buffer.from(
        whiteboardMimeFixture.simulatedDoc.downloadedWhiteboardImage.base64,
        "base64",
      ),
      contentType: whiteboardMimeFixture.simulatedDoc.downloadedWhiteboardImage.contentType,
    });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "list_blocks",
      doc_token: "doc_with_board",
    });

    const image = getImageBlock(result);
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/jpeg");
  });

  it("read should download inline docx images", async () => {
    rawContentMock.mockResolvedValue({
      code: 0,
      data: { content: "minutes content" },
    });
    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: docxInlineImageFixture.simulatedDoc.blocks,
        has_more: false,
      },
    });
    downloadDocxImageMock.mockResolvedValue({
      buffer: Buffer.from(docxInlineImageFixture.simulatedDoc.downloadedDocxImage.base64, "base64"),
      contentType: docxInlineImageFixture.simulatedDoc.downloadedDocxImage.contentType,
    });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "read",
      doc_token: "doc_with_inline_images",
    });

    const images = getImageBlocks(result);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
  });

  it("list_blocks should download inline docx images", async () => {
    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: docxInlineImageFixture.simulatedDoc.blocks,
        has_more: false,
      },
    });
    downloadDocxImageMock.mockResolvedValue({
      buffer: Buffer.from(docxInlineImageFixture.simulatedDoc.downloadedDocxImage.base64, "base64"),
      contentType: docxInlineImageFixture.simulatedDoc.downloadedDocxImage.contentType,
    });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "list_blocks",
      doc_token: "doc_with_inline_images",
    });

    const images = getImageBlocks(result);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
  });

  it("append should read content from source_file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feishu-docx-test-"));
    const filePath = join(dir, "input.md");
    writeFileSync(filePath, "# header\nbody from file\n", "utf8");
    blockListMock.mockResolvedValue({
      code: 0,
      data: { items: [] },
    });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "append",
      doc_token: "doc_1",
      source_file: filePath,
    });

    expect(convertMock).toHaveBeenCalledTimes(1);
    const convertInput = convertMock.mock.calls[0]?.[0] as {
      data: { content_type: string; content: string };
    };
    expect(convertInput.data.content_type).toBe("markdown");
    expect(convertInput.data.content).toContain("body from file");

    const details = result.details as { success: boolean; blocks_added: number };
    expect(details.success).toBe(true);
    expect(details.blocks_added).toBe(1);
  });

  it("append should reject when content and source_file are both provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "feishu-docx-test-"));
    const filePath = join(dir, "input.md");
    writeFileSync(filePath, "hello\n", "utf8");

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "append",
      doc_token: "doc_1",
      content: "inline content",
      source_file: filePath,
    });

    expect(convertMock).not.toHaveBeenCalled();
    const details = result.details as { error?: string };
    expect(details.error).toContain("Provide either content or source_file, not both");
  });

  it("write should clear all top-level blocks with paginated list (no leftover)", async () => {
    blockListMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { block_id: "old_1", block_type: 2, parent_id: "doc_1" },
            { block_id: "nested_ignored", block_type: 2, parent_id: "old_1" },
          ],
          has_more: true,
          page_token: "p2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ block_id: "old_2", block_type: 2, parent_id: "doc_1" }],
          has_more: false,
        },
      });

    const dir = mkdtempSync(join(tmpdir(), "feishu-docx-test-"));
    const filePath = join(dir, "rewrite.md");
    writeFileSync(filePath, "new content\n", "utf8");

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "write",
      doc_token: "doc_1",
      source_file: filePath,
    });

    expect(blockListMock).toHaveBeenCalledTimes(2);
    expect(batchDeleteMock).toHaveBeenCalledTimes(1);
    expect(batchDeleteMock).toHaveBeenCalledWith({
      path: { document_id: "doc_1", block_id: "doc_1" },
      data: { start_index: 0, end_index: 2 },
    });

    const details = result.details as {
      success: boolean;
      blocks_deleted: number;
      blocks_added: number;
    };
    expect(details.success).toBe(true);
    expect(details.blocks_deleted).toBe(2);
    expect(details.blocks_added).toBe(1);
  });

  it("insert_blocks should compute correct index from after_block_id", async () => {
    blockListMock.mockResolvedValue({ code: 0, data: { items: [] } });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "insert_blocks",
      doc_token: "doc_1",
      after_block_id: "c1",
      content: "inserted paragraph",
    });

    expect(childrenGetMock).toHaveBeenCalledWith({
      path: { document_id: "doc_1", block_id: "doc_1" },
    });
    // c1 is at index 0, so insert index should be 1.
    expect(descendantCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ index: 1 }),
      }),
    );
    const details = result.details as { success: boolean; insert_position: number };
    expect(details.success).toBe(true);
    expect(details.insert_position).toBe(1);
  });

  it("insert_blocks should compute correct index from before_block_id", async () => {
    blockListMock.mockResolvedValue({ code: 0, data: { items: [] } });

    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "insert_blocks",
      doc_token: "doc_1",
      before_block_id: "c3",
      content: "before c3",
    });

    // c3 is at index 2, so insert index should be 2 (before c3).
    expect(descendantCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ index: 2 }),
      }),
    );
    const details = result.details as { success: boolean; insert_position: number };
    expect(details.success).toBe(true);
    expect(details.insert_position).toBe(2);
  });

  it("delete_range should compute correct start/end indices", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "delete_range",
      doc_token: "doc_1",
      start_block_id: "c1",
      end_block_id: "c2",
    });

    expect(childrenGetMock).toHaveBeenCalledWith({
      path: { document_id: "doc_1", block_id: "doc_1" },
    });
    // c1=index 0, c2=index 1 → batchDelete(0, 2)
    expect(batchDeleteMock).toHaveBeenCalledWith({
      path: { document_id: "doc_1", block_id: "doc_1" },
      data: { start_index: 0, end_index: 2 },
    });
    const details = result.details as { success: boolean; blocks_deleted: number };
    expect(details.success).toBe(true);
    expect(details.blocks_deleted).toBe(2);
  });

  it("delete_range should error when block not found", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "delete_range",
      doc_token: "doc_1",
      start_block_id: "nonexistent",
      end_block_id: "c2",
    });

    const details = result.details as { error?: string };
    expect(details.error).toContain("not found");
  });

  it("create should reject missing folder_token to avoid app-root doc creation", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tool-call", {
      action: "create",
      title: "new doc",
    });

    expect(createDocMock).not.toHaveBeenCalled();
    const details = result.details as { error?: string };
    expect(details.error).toContain("folder_token is required for create");
  });
});
