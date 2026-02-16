/**
 * Feishu Document (docx) tool — read, write, append, create, and manage document blocks.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { createReadStream, existsSync, statSync, unlinkSync } from "fs";
import { mkdirSync, writeFileSync } from "fs";
import { stringEnum } from "openclaw/plugin-sdk";
import { homedir } from "os";
import { tmpdir } from "os";
import { isAbsolute, join, resolve, basename } from "path";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { getFeishuClient, downloadWhiteboardImage } from "../outbound.js";

// ── Helpers ──

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/** Build a tool result that includes both JSON text and inline images for vision. */
function jsonWithImages(
  data: unknown,
  images: Array<{ base64: string; mimeType: string; label: string }>,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const content: any[] = [{ type: "text" as const, text: JSON.stringify(data, null, 2) }];
  for (const img of images) {
    content.push({ type: "image" as const, data: img.base64, mimeType: img.mimeType });
  }
  return { content, details: data };
}

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: "Page",
  2: "Text",
  3: "Heading1",
  4: "Heading2",
  5: "Heading3",
  12: "Bullet",
  13: "Ordered",
  14: "Code",
  15: "Quote",
  17: "Todo",
  18: "Bitable",
  21: "Diagram",
  22: "Divider",
  23: "File",
  27: "Image",
  30: "Sheet",
  31: "Table",
  32: "TableCell",
  43: "Board",
};

// Table block type — cannot be created via descendant API; needs a two-step
// approach: documentBlockChildren.create (empty table) + documentBlock.patch (fill cells).
const TABLE_BLOCK_TYPE = 31;

/** Extract table dimensions and cell content from convertMarkdown output.
 *  Preserves text formatting (bold, italic, etc.) from the original elements. */
// oxlint-disable-next-line typescript/no-explicit-any
function extractTableData(
  // oxlint-disable-next-line typescript/no-explicit-any
  blockMap: Map<string, any>,
  tableBlockId: string,
  // oxlint-disable-next-line typescript/no-explicit-any
): { rowSize: number; columnSize: number; cellElements: any[][] } {
  const tableBlock = blockMap.get(tableBlockId);
  if (!tableBlock || tableBlock.block_type !== TABLE_BLOCK_TYPE)
    throw new Error(`Block ${tableBlockId} is not a Table`);

  const { row_size: rowSize, column_size: columnSize } = tableBlock.table.property;
  const cellIds: string[] = tableBlock.children ?? tableBlock.table?.cells ?? [];

  // oxlint-disable-next-line typescript/no-explicit-any
  const cellElements: any[][] = [];
  for (const cellId of cellIds) {
    const cellBlock = blockMap.get(cellId);
    const textBlockId = cellBlock?.children?.[0];
    const textBlock = textBlockId ? blockMap.get(textBlockId) : undefined;
    if (!textBlock) {
      cellElements.push([]);
      continue;
    }
    // Text content lives under a type-specific key (e.g. "text" for Text blocks).
    const typeKey = Object.keys(textBlock).find(
      (k) =>
        !["block_id", "block_type", "parent_id", "children"].includes(k) &&
        typeof textBlock[k] === "object" &&
        textBlock[k]?.elements,
    );
    cellElements.push(typeKey ? (textBlock[typeKey].elements ?? []) : []);
  }

  return { rowSize, columnSize, cellElements };
}

/** Collect all descendant blocks reachable from a set of root IDs.
 *  Used for descendant API calls with a subset of first-level blocks. */
// oxlint-disable-next-line typescript/no-explicit-any
function collectDescendantsForIds(
  // oxlint-disable-next-line typescript/no-explicit-any
  blocks: any[],
  // oxlint-disable-next-line typescript/no-explicit-any
  blockMap: Map<string, any>,
  rootIds: string[],
  // oxlint-disable-next-line typescript/no-explicit-any
): { descendants: any[]; childrenId: string[] } {
  const included = new Set<string>();

  function collect(blockId: string) {
    if (included.has(blockId)) return;
    included.add(blockId);
    const block = blockMap.get(blockId);
    if (block?.children && Array.isArray(block.children)) {
      for (const childId of block.children) collect(childId);
    }
  }

  for (const id of rootIds) collect(id);

  const descendants = blocks
    .filter((b) => included.has(b.block_id))
    // oxlint-disable-next-line typescript/no-explicit-any
    .map((b: any) => {
      const { parent_id: _pid, ...rest } = b;
      return rest;
    });

  return { descendants, childrenId: rootIds };
}

/** Extract image sources from Markdown — supports both HTTP URLs and local file paths.
 *  Local paths (absolute, relative, file://) are resolved and verified to exist. */
function extractImageSources(markdown: string, workspaceDir?: string): string[] {
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  const sources: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const src = match[1].trim();
    if (src.startsWith("http://") || src.startsWith("https://")) {
      sources.push(src);
    } else {
      // Local file path: absolute, relative, or file:// URL
      let filePath = src.startsWith("file://") ? src.slice(7) : src;
      if (!isAbsolute(filePath)) {
        filePath = resolve(workspaceDir ?? join(homedir(), ".openclaw", "workspace"), filePath);
      }
      if (existsSync(filePath)) {
        sources.push(filePath);
      }
    }
  }
  return sources;
}

/** Create an empty table via documentBlockChildren.create, then fill each cell
 *  with content via documentBlock.patch. The descendant API rejects Table(31)
 *  blocks, so tables need this two-step approach. */
// oxlint-disable-next-line typescript/no-explicit-any
async function createAndFillTable(
  client: Lark.Client,
  docToken: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  tableData: { rowSize: number; columnSize: number; cellElements: any[][] },
  // oxlint-disable-next-line typescript/no-explicit-any
): Promise<any[]> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const createRes: any = await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: docToken },
    data: {
      children: [
        {
          block_type: TABLE_BLOCK_TYPE,
          table: {
            property: {
              row_size: tableData.rowSize,
              column_size: tableData.columnSize,
            },
          },
        },
      ],
    },
  });
  if (createRes.code !== 0) throw new Error(createRes.msg);

  const createdBlocks = createRes.data?.children ?? [];
  // oxlint-disable-next-line typescript/no-explicit-any
  const tableBlock = createdBlocks.find((b: any) => b.block_type === TABLE_BLOCK_TYPE);
  if (!tableBlock) throw new Error("Table not found in creation response");

  const cellIds: string[] = tableBlock.children ?? [];

  // Fill each cell: get its text child block ID, then patch with content.
  for (let i = 0; i < Math.min(cellIds.length, tableData.cellElements.length); i++) {
    const elements = tableData.cellElements[i];
    if (elements.length === 0) continue;
    try {
      // oxlint-disable-next-line typescript/no-explicit-any
      const cellRes: any = await client.docx.documentBlock.get({
        path: { document_id: docToken, block_id: cellIds[i] },
      });
      const textBlockId = cellRes.data?.block?.children?.[0];
      if (!textBlockId) continue;
      await client.docx.documentBlock.patch({
        path: { document_id: docToken, block_id: textBlockId },
        data: { update_text_elements: { elements } },
      });
    } catch {
      // Best-effort: continue filling remaining cells.
    }
  }

  return createdBlocks;
}

// ── Core functions ──

async function convertMarkdown(client: Lark.Client, markdown: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.docx.document.convert({
    data: { content_type: "markdown", content: markdown },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    blocks: res.data?.blocks ?? [],
    firstLevelBlockIds: res.data?.first_level_block_ids ?? [],
  };
}

/** Insert blocks with table support. Walks firstLevelBlockIds in order:
 *  non-table blocks are batched and inserted via the descendant API (which
 *  supports nested structures like bullet lists); table blocks are created
 *  separately via documentBlockChildren.create + cell patching. */
// oxlint-disable-next-line typescript/no-explicit-any
async function insertBlocksWithTables(
  client: Lark.Client,
  docToken: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  blocks: any[],
  firstLevelBlockIds: string[],
): Promise<{ children: any[]; tablesCreated: number }> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const blockMap = new Map<string, any>();
  for (const b of blocks) blockMap.set(b.block_id, b);
  // oxlint-disable-next-line typescript/no-explicit-any
  const allInserted: any[] = [];
  let tablesCreated = 0;
  let currentBatch: string[] = [];

  // Flush accumulated non-table blocks via descendant API.
  async function flushBatch() {
    if (currentBatch.length === 0) return;
    const { descendants, childrenId } = collectDescendantsForIds(blocks, blockMap, currentBatch);
    if (childrenId.length > 0) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const res: any = await client.docx.documentBlockDescendant.create({
        path: { document_id: docToken, block_id: docToken },
        data: { children_id: childrenId, descendants },
      });
      if (res.code !== 0) throw new Error(res.msg);
      allInserted.push(...(res.data?.children ?? []));
    }
    currentBatch = [];
  }

  for (const flId of firstLevelBlockIds) {
    const block = blockMap.get(flId);
    if (block?.block_type === TABLE_BLOCK_TYPE) {
      // Flush pending non-table blocks, then create the table.
      await flushBatch();
      const tableData = extractTableData(blockMap, flId);
      const created = await createAndFillTable(client, docToken, tableData);
      allInserted.push(...created);
      tablesCreated++;
    } else {
      currentBatch.push(flId);
    }
  }

  // Flush any remaining non-table blocks.
  await flushBatch();

  return { children: allInserted, tablesCreated };
}

async function clearDocumentContent(client: Lark.Client, docToken: string) {
  const existing = await client.docx.documentBlock.list({ path: { document_id: docToken } });
  // oxlint-disable-next-line typescript/no-explicit-any
  if ((existing as any).code !== 0) throw new Error((existing as any).msg);
  // oxlint-disable-next-line typescript/no-explicit-any
  const childIds = ((existing as any).data?.items ?? [])
    // oxlint-disable-next-line typescript/no-explicit-any
    .filter((b: any) => b.parent_id === docToken && b.block_type !== 1)
    // oxlint-disable-next-line typescript/no-explicit-any
    .map((b: any) => b.block_id) as string[];
  if (childIds.length > 0) {
    const res = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length },
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    if ((res as any).code !== 0) throw new Error((res as any).msg);
  }
  return childIds.length;
}

/** Upload images from markdown URLs into the corresponding empty Image blocks.
 *  Uses insertedBlocks first; falls back to documentBlock.list if no Image
 *  blocks found (defensive against API response variance). */
// oxlint-disable-next-line typescript/no-explicit-any
async function processImages(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  insertedBlocks: any[],
): Promise<{ processed: number; errors: string[] }> {
  const imageSources = extractImageSources(markdown);
  if (imageSources.length === 0) return { processed: 0, errors: [] };

  // Try to find Image blocks from the API response first.
  // oxlint-disable-next-line typescript/no-explicit-any
  let imageBlocks = insertedBlocks.filter((b: any) => b.block_type === 27);

  // Fallback: if the response didn't include Image blocks, scan the document.
  if (imageBlocks.length === 0) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const listRes: any = await client.docx.documentBlock.list({
      path: { document_id: docToken },
    });
    // oxlint-disable-next-line typescript/no-explicit-any
    imageBlocks = ((listRes.data?.items ?? []) as any[]).filter(
      // oxlint-disable-next-line typescript/no-explicit-any
      (b: any) => b.block_type === 27 && (!b.image?.token || b.image.token === ""),
    );
  }

  if (imageBlocks.length === 0) {
    return {
      processed: 0,
      errors: [`No Image blocks found for ${imageSources.length} image source(s)`],
    };
  }

  let processed = 0;
  const errors: string[] = [];

  for (let i = 0; i < Math.min(imageSources.length, imageBlocks.length); i++) {
    const src = imageSources[i];
    const blockId = imageBlocks[i].block_id;
    const isLocal = !src.startsWith("http://") && !src.startsWith("https://");
    try {
      let filePath: string;
      let fileSize: number;
      let fileName: string;
      let needsCleanup = false;

      if (isLocal) {
        // Local file: use directly, no temp file needed.
        filePath = src;
        fileSize = statSync(filePath).size;
        fileName = basename(filePath);
        if (fileSize === 0) {
          errors.push(`local ${src}: empty file`);
          continue;
        }
      } else {
        // Remote URL: download to temp file.
        const response = await fetch(src);
        if (!response.ok) {
          errors.push(`fetch ${src}: HTTP ${response.status}`);
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
          errors.push(`fetch ${src}: empty body`);
          continue;
        }
        filePath = join(tmpdir(), `feishu-img-${Date.now()}-${i}.tmp`);
        writeFileSync(filePath, buffer);
        fileSize = buffer.length;
        fileName = new URL(src).pathname.split("/").pop() || `image_${i}.png`;
        needsCleanup = true;
      }

      // Upload to Feishu drive as docx_image.
      // The Lark SDK requires fs.ReadStream for multipart uploads.
      let fileToken: string | undefined;
      try {
        // oxlint-disable-next-line typescript/no-explicit-any
        const uploadRes: any = await client.drive.media.uploadAll({
          data: {
            file_name: fileName,
            parent_type: "docx_image",
            parent_node: blockId,
            size: fileSize,
            // oxlint-disable-next-line typescript/no-explicit-any
            file: createReadStream(filePath) as any,
          },
        });
        fileToken = uploadRes?.file_token;
      } finally {
        if (needsCleanup) {
          try {
            unlinkSync(filePath);
          } catch {
            /* cleanup best-effort */
          }
        }
      }
      if (!fileToken) {
        errors.push(`upload ${src}: no file_token returned`);
        continue;
      }

      // Patch the Image block with the uploaded token.
      await client.docx.documentBlock.patch({
        path: { document_id: docToken, block_id: blockId },
        data: { replace_image: { token: fileToken } },
      });
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`image[${i}] ${src}: ${msg}`);
    }
  }

  return { processed, errors };
}

// ── Actions ──

const STRUCTURED_BLOCK_TYPES = new Set([14, 18, 21, 23, 27, 30, 31, 32, 43]);

// ── Board / Whiteboard block extraction ──
// Block type 43 = embedded whiteboard/canvas ("画板").
// The Docx API only returns metadata for these; we use the Board API to export as PNG.

type BoardBlockInfo = {
  blockId: string;
  whiteboardToken: string;
  imageBase64?: string;
  error?: string;
};

/** Extract whiteboard tokens from block type 43 blocks. */
// oxlint-disable-next-line typescript/no-explicit-any
function extractBoardBlocks(blocks: any[]): BoardBlockInfo[] {
  const results: BoardBlockInfo[] = [];
  for (const b of blocks) {
    if (b.block_type !== 43) continue;
    // Board blocks store their token in different possible locations.
    // Try known fields: b.board?.token, b.board?.board_token, or the block_id itself
    // may serve as the whiteboard token.
    const token =
      b.board?.token ??
      b.board?.board_token ??
      b.board?.whiteboard_token ??
      // Some API versions put it directly in block children data
      b.children?.[0] ??
      null;
    if (token && typeof token === "string") {
      results.push({ blockId: b.block_id, whiteboardToken: token });
    } else {
      // If we can't find the token from the block data, the block_id sometimes
      // doubles as the whiteboard reference. Record it as a fallback.
      results.push({
        blockId: b.block_id,
        whiteboardToken: b.block_id,
        error: "token_guessed_from_block_id",
      });
    }
  }
  return results;
}

/** Fetch whiteboard images for board blocks. Returns base64 encoded PNGs. */
async function fetchBoardImages(
  account: ResolvedFeishuAccount,
  boardBlocks: BoardBlockInfo[],
): Promise<BoardBlockInfo[]> {
  const results: BoardBlockInfo[] = [];
  for (const bb of boardBlocks) {
    try {
      const img = await downloadWhiteboardImage({
        account,
        whiteboardToken: bb.whiteboardToken,
      });
      if (img) {
        results.push({
          ...bb,
          imageBase64: img.buffer.toString("base64"),
        });
      } else {
        results.push({ ...bb, error: "download_failed_or_empty" });
      }
    } catch (err) {
      results.push({ ...bb, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function readDoc(client: Lark.Client, docToken: string, account?: ResolvedFeishuAccount) {
  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    client.docx.documentBlock.list({ path: { document_id: docToken } }),
  ]);
  // oxlint-disable-next-line typescript/no-explicit-any
  if ((contentRes as any).code !== 0) throw new Error((contentRes as any).msg);
  // oxlint-disable-next-line typescript/no-explicit-any
  const blocks = ((blocksRes as any).data?.items ?? []) as any[];
  const blockCounts: Record<string, number> = {};
  const structuredTypes: string[] = [];
  for (const b of blocks) {
    const type = b.block_type ?? 0;
    const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
    blockCounts[name] = (blockCounts[name] || 0) + 1;
    if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name))
      structuredTypes.push(name);
  }

  // Detect embedded whiteboards (block type 43) and fetch their images.
  const boardBlocks = extractBoardBlocks(blocks);
  let boardImages: BoardBlockInfo[] | undefined;
  if (boardBlocks.length > 0 && account) {
    boardImages = await fetchBoardImages(account, boardBlocks);
  }

  const result = {
    // oxlint-disable-next-line typescript/no-explicit-any
    title: (infoRes as any).data?.document?.title,
    // oxlint-disable-next-line typescript/no-explicit-any
    content: (contentRes as any).data?.content,
    // oxlint-disable-next-line typescript/no-explicit-any
    revision_id: (infoRes as any).data?.document?.revision_id,
    block_count: blocks.length,
    block_types: blockCounts,
    ...(structuredTypes.length > 0 && {
      hint: `This document contains ${structuredTypes.join(", ")} which are NOT included in the plain text above. Use feishu_doc with action: "list_blocks" to get full content.`,
    }),
    // Metadata about board blocks (without the heavy base64 — that goes in image content blocks).
    ...(boardImages &&
      boardImages.length > 0 && {
        board_count: boardImages.length,
        board_hint: `This document contains ${boardImages.length} embedded whiteboard(s)/canvas(es). Their images are attached below for vision analysis.`,
        boards: boardImages.map((bi) => ({
          block_id: bi.blockId,
          whiteboard_token: bi.whiteboardToken,
          ...(bi.error && { error: bi.error }),
        })),
      }),
  };

  // Return with inline image content blocks so the AI can "see" whiteboard content.
  const inlineImages = (boardImages ?? [])
    .filter((bi) => bi.imageBase64)
    .map((bi) => ({
      base64: bi.imageBase64!,
      mimeType: "image/png",
      label: `whiteboard_${bi.blockId}`,
    }));

  if (inlineImages.length > 0) {
    return jsonWithImages(result, inlineImages);
  }
  return json(result);
}

/** Back up document content before destructive write. Returns backup file path or undefined. */
async function backupDocContent(
  client: Lark.Client,
  docToken: string,
): Promise<string | undefined> {
  try {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.document.rawContent({ path: { document_id: docToken } });
    const text = res?.data?.content;
    if (!text) return undefined;
    const dir = join(homedir(), ".openclaw", "feishu-doc-backups");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(dir, `${docToken}_${ts}.md`);
    writeFileSync(filePath, text, "utf-8");
    return filePath;
  } catch {
    return undefined;
  }
}

async function writeDoc(client: Lark.Client, docToken: string, markdown: string) {
  // Back up existing content before destructive clear.
  const backupPath = await backupDocContent(client, docToken);
  const deleted = await clearDocumentContent(client, docToken);
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0)
    return {
      success: true,
      blocks_deleted: deleted,
      blocks_added: 0,
      images_processed: 0,
      ...(backupPath && { backup_path: backupPath }),
    };
  const { children: inserted, tablesCreated } = await insertBlocksWithTables(
    client,
    docToken,
    blocks,
    firstLevelBlockIds,
  );
  const imageResult = await processImages(client, docToken, markdown, inserted);
  return {
    success: true,
    blocks_deleted: deleted,
    blocks_added: inserted.length,
    images_processed: imageResult.processed,
    ...(backupPath && { backup_path: backupPath }),
    ...(tablesCreated > 0 && { tables_created: tablesCreated }),
    ...(imageResult.errors.length > 0 && { image_errors: imageResult.errors }),
  };
}

async function appendDoc(client: Lark.Client, docToken: string, markdown: string) {
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) throw new Error("Content is empty");
  const { children: inserted, tablesCreated } = await insertBlocksWithTables(
    client,
    docToken,
    blocks,
    firstLevelBlockIds,
  );
  const imageResult = await processImages(client, docToken, markdown, inserted);
  return {
    success: true,
    blocks_added: inserted.length,
    images_processed: imageResult.processed,
    // oxlint-disable-next-line typescript/no-explicit-any
    block_ids: inserted.map((b: any) => b.block_id),
    ...(tablesCreated > 0 && { tables_created: tablesCreated }),
    ...(imageResult.errors.length > 0 && { image_errors: imageResult.errors }),
  };
}

async function createDoc(client: Lark.Client, title: string, folderToken?: string) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    document_id: res.data?.document?.document_id,
    title: res.data?.document?.title,
    url: `https://feishu.cn/docx/${res.data?.document?.document_id}`,
  };
}

// ── Schema (flat object, no Type.Union per guardrails) ──

const DOC_ACTIONS = [
  "read",
  "write",
  "append",
  "create",
  "list_blocks",
  "get_block",
  "update_block",
  "delete_block",
] as const;

const FeishuDocSchema = Type.Object({
  action: stringEnum(DOC_ACTIONS, { description: "Document operation to perform" }),
  doc_token: Type.Optional(
    Type.String({
      description:
        "Document token (extract from URL /docx/XXX). Required for all actions except create.",
    }),
  ),
  content: Type.Optional(
    Type.String({ description: "Markdown content (for write/append/update_block)" }),
  ),
  title: Type.Optional(Type.String({ description: "Document title (for create)" })),
  folder_token: Type.Optional(Type.String({ description: "Target folder token (for create)" })),
  block_id: Type.Optional(
    Type.String({ description: "Block ID (for get_block/update_block/delete_block)" }),
  ),
  find: Type.Optional(
    Type.String({
      description:
        "Text to find in the block (for update_block). When provided with replace_with, does targeted replacement preserving formatting.",
    }),
  ),
  replace_with: Type.Optional(
    Type.String({
      description:
        "Replacement text (for update_block). Used with find for precise text substitution.",
    }),
  ),
});

// ── Registration ──

export function registerFeishuDocTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_doc",
      label: "Feishu Doc",
      description:
        "Feishu document operations. Actions: read, write, append, create, list_blocks, get_block, update_block, delete_block",
      parameters: FeishuDocSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          switch (params.action) {
            case "read":
              return await readDoc(client, params.doc_token, firstAccount);
            case "write":
              return json(await writeDoc(client, params.doc_token, params.content));
            case "append":
              return json(await appendDoc(client, params.doc_token, params.content));
            case "create": {
              const created = await createDoc(client, params.title, params.folder_token);
              // If content was provided, write it into the newly created document.
              if (params.content) {
                const writeResult = await writeDoc(client, created.document_id, params.content);
                return json({ ...created, ...writeResult });
              }
              return json(created);
            }
            case "list_blocks": {
              const res = await client.docx.documentBlock.list({
                path: { document_id: params.doc_token },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              if ((res as any).code !== 0) throw new Error((res as any).msg);
              // oxlint-disable-next-line typescript/no-explicit-any
              const items = (res as any).data?.items ?? [];
              // Detect board blocks and fetch their images automatically.
              const boards = extractBoardBlocks(items);
              let boardData: BoardBlockInfo[] | undefined;
              if (boards.length > 0) {
                boardData = await fetchBoardImages(firstAccount, boards);
              }
              const listResult = {
                blocks: items,
                ...(boardData &&
                  boardData.length > 0 && {
                    board_count: boardData.length,
                    boards: boardData.map((bi) => ({
                      block_id: bi.blockId,
                      whiteboard_token: bi.whiteboardToken,
                      ...(bi.error && { error: bi.error }),
                    })),
                  }),
              };
              const listImages = (boardData ?? [])
                .filter((bi) => bi.imageBase64)
                .map((bi) => ({
                  base64: bi.imageBase64!,
                  mimeType: "image/png",
                  label: `whiteboard_${bi.blockId}`,
                }));
              if (listImages.length > 0) {
                return jsonWithImages(listResult, listImages);
              }
              return json(listResult);
            }
            case "get_block": {
              const res = await client.docx.documentBlock.get({
                path: { document_id: params.doc_token, block_id: params.block_id },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              if ((res as any).code !== 0) throw new Error((res as any).msg);
              // oxlint-disable-next-line typescript/no-explicit-any
              return json({ block: (res as any).data?.block });
            }
            case "update_block": {
              // Read current block to get existing elements.
              const blockInfo = await client.docx.documentBlock.get({
                path: { document_id: params.doc_token, block_id: params.block_id },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              if ((blockInfo as any).code !== 0) throw new Error((blockInfo as any).msg);
              // oxlint-disable-next-line typescript/no-explicit-any
              const block = (blockInfo as any).data?.block;

              // Determine which elements to send based on find/replace_with vs content.
              // oxlint-disable-next-line typescript/no-explicit-any
              let newElements: any[];
              let mode: string;

              if (params.find != null && params.replace_with != null) {
                // Targeted find/replace — preserves formatting of existing elements.
                // Extract current text elements from the block's type-specific data.
                const typeKey = Object.keys(block).find(
                  (k) => typeof block[k] === "object" && block[k]?.elements,
                );
                const currentElements = typeKey ? block[typeKey].elements : undefined;
                if (!currentElements || currentElements.length === 0) {
                  throw new Error("Block has no text elements to search in");
                }
                let replaced = false;
                // oxlint-disable-next-line typescript/no-explicit-any
                newElements = currentElements.map((el: any) => {
                  if (el.text_run?.content?.includes(params.find)) {
                    replaced = true;
                    return {
                      ...el,
                      text_run: {
                        ...el.text_run,
                        content: el.text_run.content.replaceAll(params.find, params.replace_with),
                      },
                    };
                  }
                  return el;
                });
                if (!replaced) {
                  throw new Error(`Text "${params.find}" not found in block ${params.block_id}`);
                }
                mode = "find_replace";
              } else {
                // Full text replacement (original behavior).
                newElements = [{ text_run: { content: params.content } }];
                mode = "full_replace";
              }

              const res = await client.docx.documentBlock.patch({
                path: { document_id: params.doc_token, block_id: params.block_id },
                data: { update_text_elements: { elements: newElements } },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              if ((res as any).code !== 0) throw new Error((res as any).msg);
              return json({ success: true, block_id: params.block_id, mode });
            }
            case "delete_block": {
              const blockInfo = await client.docx.documentBlock.get({
                path: { document_id: params.doc_token, block_id: params.block_id },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              const parentId = (blockInfo as any).data?.block?.parent_id ?? params.doc_token;
              const children = await client.docx.documentBlockChildren.get({
                path: { document_id: params.doc_token, block_id: parentId },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              const items = (children as any).data?.items ?? [];
              // oxlint-disable-next-line typescript/no-explicit-any
              const index = items.findIndex((item: any) => item.block_id === params.block_id);
              if (index === -1) throw new Error("Block not found");
              await client.docx.documentBlockChildren.batchDelete({
                path: { document_id: params.doc_token, block_id: parentId },
                data: { start_index: index, end_index: index + 1 },
              });
              return json({ success: true, deleted_block_id: params.block_id });
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_doc" },
  );
  api.logger.info?.("feishu: registered feishu_doc tool");
}
