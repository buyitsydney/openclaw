import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());
const downloadWhiteboardImageMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
  downloadWhiteboardImage: downloadWhiteboardImageMock,
}));

import { registerFeishuDocTools } from "./docx.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

describe("feishu-her feishu_doc anti-regression", () => {
  const convertMock = vi.hoisted(() => vi.fn());
  const descendantCreateMock = vi.hoisted(() => vi.fn());
  const blockListMock = vi.hoisted(() => vi.fn());
  const blockGetMock = vi.hoisted(() => vi.fn());
  const rawContentMock = vi.hoisted(() => vi.fn());
  const batchDeleteMock = vi.hoisted(() => vi.fn());

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
    downloadWhiteboardImageMock.mockResolvedValue(null);
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
});
