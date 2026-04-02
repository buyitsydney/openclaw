import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());
const downloadWhiteboardImageMock = vi.hoisted(() => vi.fn());
const readDriveFileContextByTokenMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
  downloadWhiteboardImage: downloadWhiteboardImageMock,
}));

vi.mock("../drive-file-read.js", () => ({
  readDriveFileContextByToken: readDriveFileContextByTokenMock,
}));

import { registerFeishuDocTools } from "./docx.js";

type Block = { block_id: string; block_type: number; parent_id: string };
type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

function createStatefulDocClient(initialTopLevelCount: number) {
  const state = {
    topLevel: Array.from({ length: initialTopLevelCount }, (_, i) => ({
      block_id: `old_${i + 1}`,
      block_type: 2,
      parent_id: "doc_1",
    })) as Block[],
    nextInsertedId: 1,
  };

  function listItems(): Block[] {
    return state.topLevel;
  }

  return {
    docx: {
      document: {
        rawContent: vi.fn().mockResolvedValue({ code: 0, data: { content: "legacy" } }),
        convert: vi.fn().mockImplementation(({ data }: { data: { content: string } }) => ({
          code: 0,
          data: {
            blocks: [
              {
                block_id: `new_${state.nextInsertedId}`,
                block_type: 2,
                text: { elements: [{ text_run: { content: data.content } }] },
              },
            ],
            first_level_block_ids: [`new_${state.nextInsertedId}`],
          },
        })),
      },
      documentBlock: {
        list: vi
          .fn()
          .mockImplementation(
            ({ params }: { params?: { page_size?: number; page_token?: string } }) => {
              const pageSize = params?.page_size ?? 500;
              const token = params?.page_token;
              const all = listItems();
              const start = token ? Number.parseInt(token, 10) : 0;
              const page = all.slice(start, start + pageSize);
              const next = start + pageSize;
              const hasMore = next < all.length;
              return {
                code: 0,
                data: {
                  items: page,
                  has_more: hasMore,
                  page_token: hasMore ? String(next) : undefined,
                },
              };
            },
          ),
        patch: vi.fn(),
        batchUpdate: vi.fn(),
      },
      documentBlockDescendant: {
        create: vi.fn().mockImplementation(() => {
          const insertedId = `inserted_${state.nextInsertedId++}`;
          state.topLevel = [{ block_id: insertedId, block_type: 2, parent_id: "doc_1" }];
          return {
            code: 0,
            data: { children: [{ block_id: insertedId, block_type: 2, parent_id: "doc_1" }] },
          };
        }),
      },
      documentBlockChildren: {
        batchDelete: vi.fn().mockImplementation(({ data }: { data: { end_index: number } }) => {
          state.topLevel = state.topLevel.slice(data.end_index);
          return { code: 0 };
        }),
      },
    },
  };
}

describe("feishu-her feishu_doc e2e anti-regression", () => {
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
    downloadWhiteboardImageMock.mockResolvedValue(null);
    readDriveFileContextByTokenMock.mockResolvedValue({
      ok: true,
      token: "file_1",
      title: "file.pdf",
      contentType: "application/pdf",
      content: '<file name="file.pdf">\nhello\n</file>',
    });
  });

  function registerToolWithClient(client: unknown) {
    getFeishuClientMock.mockReturnValue(client);
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

  it("write should remove all 650 old blocks and keep only new content", async () => {
    const client = createStatefulDocClient(650);
    const tool = registerToolWithClient(client);
    const dir = mkdtempSync(join(tmpdir(), "feishu-docx-e2e-"));
    const src = join(dir, "content.md");
    writeFileSync(src, "new doc text\n", "utf8");

    const writeRes = await tool.execute("tool-call", {
      action: "write",
      doc_token: "doc_1",
      source_file: src,
    });
    const writeDetails = writeRes.details as {
      success: boolean;
      blocks_deleted: number;
      blocks_added: number;
    };
    expect(writeDetails.success).toBe(true);
    expect(writeDetails.blocks_deleted).toBe(650);
    expect(writeDetails.blocks_added).toBe(1);

    const listRes = await tool.execute("tool-call", {
      action: "list_blocks",
      doc_token: "doc_1",
    });
    const listDetails = listRes.details as { blocks: Block[] };
    expect(listDetails.blocks).toHaveLength(1);
    expect(listDetails.blocks[0]?.block_id).toContain("inserted_");
  });

  it("list_blocks should return full 750 blocks via pagination", async () => {
    const client = createStatefulDocClient(750);
    const tool = registerToolWithClient(client);
    const listRes = await tool.execute("tool-call", {
      action: "list_blocks",
      doc_token: "doc_1",
    });
    const listDetails = listRes.details as { blocks: Block[] };
    expect(listDetails.blocks).toHaveLength(750);
    expect(listDetails.blocks[0]?.block_id).toBe("old_1");
    expect(listDetails.blocks[749]?.block_id).toBe("old_750");
  });
});
