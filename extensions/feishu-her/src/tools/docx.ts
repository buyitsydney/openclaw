/**
 * Feishu Document (docx) tool — read, write, append, create, and manage document blocks.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from "fs";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve, basename } from "path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/browser-support";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { readDriveFileContextByToken } from "../drive-file-read.js";
import {
  callFeishuApiWithUserToken,
  getValidUserToken,
  handleFeishuTokenError,
  requireUserToken,
  resolveOAuthRedirectUri,
} from "../oauth.js";
import { getFeishuClient, downloadDocxImage, downloadWhiteboardImage } from "../outbound.js";
import { resolveDriveShareUrl } from "./share-url.js";

// ── Helpers ──

/** Extract meaningful error info from Lark SDK AxiosErrors.
 *  The SDK often throws `AxiosError: Request failed with status code 400`
 *  without surfacing the actual error code/message from the response body. */
function extractLarkError(err: unknown): { code?: number; msg: string } {
  if (err && typeof err === "object") {
    // oxlint-disable-next-line typescript/no-explicit-any
    const axiosErr = err as any;
    const data = axiosErr?.response?.data;
    if (data?.code && data?.msg) return { code: data.code, msg: data.msg };
    if (data?.error?.message) return { msg: data.error.message };
  }
  return { msg: String(err) };
}

/** Map Feishu error codes to human-readable explanations for the AI. */
function describeLarkError(code: number | undefined, msg: string): string {
  const explanations: Record<number, string> = {
    1770001:
      "invalid param — content may contain unsupported block types (tables must be created separately via children API, not descendant API)",
    1770004: "document has too many blocks — reduce content or split across multiple documents",
    1770007: "block has too many children — a single parent block's child count exceeds the limit",
    1770010: "table has too many columns (max ~20)",
    1770011: "table has too many cells — reduce table size",
    1770033: "raw content size exceeds limit — text is too long for a single block",
    1770034:
      "operation count exceeds limit — too many cell operations; split into multiple requests",
    1770035: "resource count exceeds limit — max 20 images per request",
  };
  if (code && explanations[code]) return `Feishu API error ${code}: ${explanations[code]}`;
  return msg;
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

type DocxRawContentResponse = {
  content?: string;
};

type DocxDocumentInfoResponse = {
  document?: {
    title?: string;
    revision_id?: string;
  };
};

type DocxBlockListResponse = {
  items?: unknown[];
  has_more?: boolean;
  page_token?: string;
};

type DocxBlockGetResponse = {
  block?: unknown;
};

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
const TABLE_CELL_TYPE = 32;

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
// Feishu table creation limit: documentBlockChildren.create supports max 9×9.
// For larger tables: create at 9×9, then extend via insert_table_row/insert_table_column.
const MAX_TABLE_CREATE = 9;
// Approximate total document width in Feishu column_width units (~700px).
const TABLE_TOTAL_WIDTH = 700;
// Delay between consecutive API calls to respect Feishu's 3 QPS rate limit.
const API_RATE_DELAY_MS = 350;

/** Calculate even column widths for a table, ensuring they sum to full width. */
function calcColumnWidths(colCount: number): number[] {
  const w = Math.floor(TABLE_TOTAL_WIDTH / colCount);
  return Array.from({ length: colCount }, (_, i) =>
    i === colCount - 1 ? TABLE_TOTAL_WIDTH - w * (colCount - 1) : w,
  );
}

/** Create and fill a table. Large tables are extended via insert_table_row/column. */
async function createAndFillTable(
  client: Lark.Client,
  docToken: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  tableData: { rowSize: number; columnSize: number; cellElements: any[][] },
  insertIndex?: number,
  // oxlint-disable-next-line typescript/no-explicit-any
): Promise<any[]> {
  const { rowSize, columnSize, cellElements } = tableData;

  // Step 1: Create table at min(rows, 9) × min(cols, 9) with column widths.
  const createRows = Math.min(rowSize, MAX_TABLE_CREATE);
  const createCols = Math.min(columnSize, MAX_TABLE_CREATE);
  const colWidths = calcColumnWidths(columnSize);

  // oxlint-disable-next-line typescript/no-explicit-any
  let createRes: any;
  try {
    createRes = await client.docx.documentBlockChildren.create({
      path: { document_id: docToken, block_id: docToken },
      data: {
        children: [
          {
            block_type: TABLE_BLOCK_TYPE,
            table: {
              property: {
                row_size: createRows,
                column_size: createCols,
                // Set column widths for proper display (only for initial cols).
                column_width: colWidths.slice(0, createCols),
              },
            },
          },
        ],
        ...(insertIndex != null && { index: insertIndex }),
      } as any, // column_width not in SDK types but accepted by API
    });
  } catch (err) {
    const { code, msg } = extractLarkError(err);
    throw new Error(
      `Failed to create ${rowSize}×${columnSize} table: ${describeLarkError(code, msg)}`,
    );
  }
  if (createRes.code !== 0) {
    throw new Error(
      `Failed to create ${rowSize}×${columnSize} table: ${describeLarkError(createRes.code, createRes.msg)}`,
    );
  }

  const createdBlocks = createRes.data?.children ?? [];
  // oxlint-disable-next-line typescript/no-explicit-any
  const tableBlock = createdBlocks.find((b: any) => b.block_type === TABLE_BLOCK_TYPE);
  if (!tableBlock) throw new Error("Table not found in creation response");
  const tableBlockId = tableBlock.block_id as string;

  // Step 2: Extend columns if needed (>9 cols), respecting rate limit.
  for (let c = createCols; c < columnSize; c++) {
    await new Promise((r) => setTimeout(r, API_RATE_DELAY_MS));
    try {
      await client.docx.documentBlock.patch({
        path: { document_id: docToken, block_id: tableBlockId },
        data: { insert_table_column: { column_index: c } } as any,
      });
    } catch (err) {
      const { code, msg } = extractLarkError(err);
      throw new Error(`Failed to add column ${c + 1}: ${describeLarkError(code, msg)}`);
    }
  }

  // Step 3: Extend rows if needed (>9 rows), respecting rate limit.
  for (let r = createRows; r < rowSize; r++) {
    await new Promise((r) => setTimeout(r, API_RATE_DELAY_MS));
    try {
      await client.docx.documentBlock.patch({
        path: { document_id: docToken, block_id: tableBlockId },
        data: { insert_table_row: { row_index: r } } as any,
      });
    } catch (err) {
      const { code, msg } = extractLarkError(err);
      throw new Error(`Failed to add row ${r + 1}: ${describeLarkError(code, msg)}`);
    }
  }

  // Step 4: Batch-read all blocks to build cell→textBlock map.
  // Uses paginated list to handle docs with 500+ blocks.
  const allDocBlocks = await listAllDocBlocks(client, docToken);

  // Re-read table to get cell IDs (including newly added rows).
  const tableInList = allDocBlocks.find(
    // oxlint-disable-next-line typescript/no-explicit-any
    (b: any) => b.block_id === tableBlockId,
  );
  const allCellIds: string[] = tableInList?.children ?? [];

  // Build cell ID → text block ID map from the list result.
  const cellTextMap = new Map<string, string>();
  for (const cellId of allCellIds) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cellBlock = allDocBlocks.find((b: any) => b.block_id === cellId);
    if (cellBlock?.block_type === TABLE_CELL_TYPE && cellBlock.children?.length > 0) {
      cellTextMap.set(cellId, cellBlock.children[0]);
    }
  }

  // Step 5: Fill all cells via batch_update (1 API call for all cells instead
  // of N individual PATCHes — verified 162 cells/480ms in diagnostics, ~70x faster).
  // oxlint-disable-next-line typescript/no-explicit-any
  const batchRequests: any[] = [];
  for (let i = 0; i < Math.min(allCellIds.length, cellElements.length); i++) {
    const elements = cellElements[i];
    if (elements.length === 0) continue;
    const textBlockId = cellTextMap.get(allCellIds[i]);
    if (!textBlockId) continue;
    batchRequests.push({
      block_id: textBlockId,
      update_text_elements: { elements },
    });
  }

  // Batch in chunks (limit not yet hit at 162, use 150 as safe max).
  const BATCH_CHUNK = 150;
  for (let i = 0; i < batchRequests.length; i += BATCH_CHUNK) {
    const chunk = batchRequests.slice(i, i + BATCH_CHUNK);
    try {
      await client.docx.documentBlock.batchUpdate({
        path: { document_id: docToken },
        data: { requests: chunk },
      });
    } catch {
      // Fallback: try individual PATCHes for this chunk.
      for (const req of chunk) {
        try {
          await client.docx.documentBlock.patch({
            path: { document_id: docToken, block_id: req.block_id },
            data: { update_text_elements: req.update_text_elements },
          });
        } catch {
          // Best-effort: continue filling remaining cells.
        }
      }
    }
  }

  return createdBlocks;
}

/** Fetch ALL blocks from a document, handling pagination.
 *  The Feishu API returns max 500 blocks per page; documents with 500+
 *  blocks require multiple requests via page_token. */
// oxlint-disable-next-line typescript/no-explicit-any
async function listAllDocBlocks(client: Lark.Client, docToken: string): Promise<any[]> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const allBlocks: any[] = [];
  let pageToken: string | undefined;
  do {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.documentBlock.list({
      path: { document_id: docToken },
      params: pageToken ? { page_token: pageToken, page_size: 500 } : { page_size: 500 },
    });
    if (res.code !== 0) throw new Error(res.msg);
    allBlocks.push(...(res.data?.items ?? []));
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return allBlocks;
}

// oxlint-disable-next-line typescript/no-explicit-any
async function listAllDocBlocksByUser(userToken: string, docToken: string): Promise<any[]> {
  const allBlocks: any[] = [];
  let pageToken: string | undefined;
  do {
    const res = await callFeishuApiWithUserToken<DocxBlockListResponse>({
      method: "GET",
      endpoint: `/docx/v1/documents/${encodeURIComponent(docToken)}/blocks`,
      userToken,
      query: pageToken ? { page_token: pageToken, page_size: "500" } : { page_size: "500" },
    });
    if (res.code !== 0) throw new Error(res.msg);
    allBlocks.push(...(res.data?.items ?? []));
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return allBlocks;
}

// ── Core functions ──

async function convertMarkdown(client: Lark.Client, markdown: string) {
  // Escape bare $ signs to prevent Feishu from interpreting them as LaTeX delimiters.
  // Only escapes $ followed by digits (e.g. $500, $1,000) — not LaTeX like $x^2$.
  // Backslash escape \$ renders as $ in Feishu without triggering LaTeX.
  const escaped = markdown.replace(/\$(\d)/g, (_, d) => `\\$${d}`);
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.docx.document.convert({
    data: { content_type: "markdown", content: escaped },
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
  insertIndex?: number,
): Promise<{ children: any[]; tablesCreated: number }> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const blockMap = new Map<string, any>();
  for (const b of blocks) blockMap.set(b.block_id, b);
  // oxlint-disable-next-line typescript/no-explicit-any
  const allInserted: any[] = [];
  let tablesCreated = 0;
  let currentBatch: string[] = [];
  // Track insertion position so multiple batches land in order.
  let currentIndex = insertIndex;

  // Flush accumulated non-table blocks via descendant API.
  async function flushBatch() {
    if (currentBatch.length === 0) return;
    const { descendants, childrenId } = collectDescendantsForIds(blocks, blockMap, currentBatch);
    if (childrenId.length > 0) {
      try {
        // oxlint-disable-next-line typescript/no-explicit-any
        const res: any = await client.docx.documentBlockDescendant.create({
          path: { document_id: docToken, block_id: docToken },
          data: {
            children_id: childrenId,
            descendants,
            ...(currentIndex != null && { index: currentIndex }),
          },
        });
        if (res.code !== 0) throw new Error(describeLarkError(res.code, res.msg));
        allInserted.push(...(res.data?.children ?? []));
        if (currentIndex != null) currentIndex += childrenId.length;
      } catch (err) {
        const { code, msg } = extractLarkError(err);
        throw new Error(
          `Failed to insert ${childrenId.length} blocks (${descendants.length} total descendants): ${describeLarkError(code, msg)}`,
        );
      }
    }
    currentBatch = [];
  }

  for (const flId of firstLevelBlockIds) {
    const block = blockMap.get(flId);
    if (block?.block_type === TABLE_BLOCK_TYPE) {
      // Flush pending non-table blocks, then create the table.
      await flushBatch();
      const tableData = extractTableData(blockMap, flId);
      const created = await createAndFillTable(client, docToken, tableData, currentIndex);
      allInserted.push(...created);
      tablesCreated++;
      if (currentIndex != null) currentIndex += 1;
    } else {
      currentBatch.push(flId);
    }
  }

  // Flush any remaining non-table blocks.
  await flushBatch();

  return { children: allInserted, tablesCreated };
}

async function clearDocumentContent(client: Lark.Client, docToken: string) {
  // Use paginated list to ensure all blocks are fetched (API max 500/page).
  const allBlocks = await listAllDocBlocks(client, docToken);
  const childIds = allBlocks
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
        filePath = join(resolvePreferredOpenClawTmpDir(), `feishu-img-${Date.now()}-${i}.tmp`);
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
  contentType?: string;
  error?: string;
};

type DocxImageBlockInfo = {
  blockId: string;
  imageToken: string;
  caption?: string;
  imageBase64?: string;
  contentType?: string;
  error?: string;
};

function normalizeImageMimeType(contentType: string | undefined): string | undefined {
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mimeType?.startsWith("image/") ? mimeType : undefined;
}

async function resolveInlineBoardImageMimeType(board: BoardBlockInfo): Promise<string> {
  if (!board.imageBase64) {
    throw new Error(`board ${board.blockId} is missing image payload`);
  }

  const sniffedMimeType = normalizeImageMimeType(await sniffMimeFromBase64(board.imageBase64));
  if (sniffedMimeType) {
    return sniffedMimeType;
  }

  const headerMimeType = normalizeImageMimeType(board.contentType);
  if (headerMimeType) {
    return headerMimeType;
  }

  throw new Error(`board ${board.blockId} image MIME could not be determined`);
}

async function buildInlineBoardImages(boardImages: BoardBlockInfo[]) {
  const inlineImages: Array<{ base64: string; mimeType: string; label: string }> = [];
  for (const board of boardImages) {
    if (!board.imageBase64) {
      continue;
    }

    inlineImages.push({
      base64: board.imageBase64,
      mimeType: await resolveInlineBoardImageMimeType(board),
      label: `whiteboard_${board.blockId}`,
    });
  }

  return inlineImages;
}

async function resolveInlineDocxImageMimeType(image: DocxImageBlockInfo): Promise<string> {
  if (!image.imageBase64) {
    throw new Error(`image block ${image.blockId} is missing image payload`);
  }

  const sniffedMimeType = normalizeImageMimeType(await sniffMimeFromBase64(image.imageBase64));
  if (sniffedMimeType) {
    return sniffedMimeType;
  }

  const headerMimeType = normalizeImageMimeType(image.contentType);
  if (headerMimeType) {
    return headerMimeType;
  }

  throw new Error(`image block ${image.blockId} MIME could not be determined`);
}

async function buildInlineDocxImages(docxImages: DocxImageBlockInfo[]) {
  const inlineImages: Array<{ base64: string; mimeType: string; label: string }> = [];
  for (const image of docxImages) {
    if (!image.imageBase64) {
      continue;
    }

    inlineImages.push({
      base64: image.imageBase64,
      mimeType: await resolveInlineDocxImageMimeType(image),
      label: `docx_image_${image.blockId}`,
    });
  }

  return inlineImages;
}

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

// oxlint-disable-next-line typescript/no-explicit-any
function extractDocxImageBlocks(blocks: any[]): DocxImageBlockInfo[] {
  const results: DocxImageBlockInfo[] = [];
  for (const block of blocks) {
    if (block.block_type !== 27) continue;
    const token = block.image?.token;
    if (!token || typeof token !== "string") {
      results.push({
        blockId: block.block_id,
        imageToken: "",
        caption: block.image?.caption?.content,
        error: "missing_image_token",
      });
      continue;
    }

    results.push({
      blockId: block.block_id,
      imageToken: token,
      caption: block.image?.caption?.content,
    });
  }
  return results;
}

/** Fetch whiteboard images for board blocks with their original MIME metadata. */
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
          contentType: img.contentType,
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

async function fetchDocxImages(
  account: ResolvedFeishuAccount,
  imageBlocks: DocxImageBlockInfo[],
): Promise<DocxImageBlockInfo[]> {
  const results: DocxImageBlockInfo[] = [];
  for (const imageBlock of imageBlocks) {
    if (!imageBlock.imageToken) {
      results.push(imageBlock);
      continue;
    }

    try {
      const image = await downloadDocxImage({
        account,
        imageToken: imageBlock.imageToken,
      });
      if (image) {
        results.push({
          ...imageBlock,
          imageBase64: image.buffer.toString("base64"),
          contentType: image.contentType,
        });
      } else {
        results.push({ ...imageBlock, error: "download_failed_or_empty" });
      }
    } catch (err) {
      results.push({
        ...imageBlock,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function readDoc(client: Lark.Client, docToken: string, account?: ResolvedFeishuAccount) {
  const [contentRes, infoRes, blocks] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    listAllDocBlocks(client, docToken),
  ]);
  // oxlint-disable-next-line typescript/no-explicit-any
  if ((contentRes as any).code !== 0) throw new Error((contentRes as any).msg);
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

  const docxImageBlocks = extractDocxImageBlocks(blocks);
  let docxImages: DocxImageBlockInfo[] | undefined;
  if (docxImageBlocks.length > 0 && account) {
    docxImages = await fetchDocxImages(account, docxImageBlocks);
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
    ...(docxImages &&
      docxImages.length > 0 && {
        image_count: docxImages.length,
        image_hint: `This document contains ${docxImages.length} embedded image block(s). Their images are attached below for vision analysis.`,
        images: docxImages.map((img) => ({
          block_id: img.blockId,
          image_token: img.imageToken,
          ...(img.caption && { caption: img.caption }),
          ...(img.error && { error: img.error }),
        })),
      }),
  };

  // Return with inline image content blocks so the AI can "see" embedded boards and images.
  const inlineImages = [
    ...(await buildInlineBoardImages(boardImages ?? [])),
    ...(await buildInlineDocxImages(docxImages ?? [])),
  ];

  if (inlineImages.length > 0) {
    return jsonWithImages(result, inlineImages);
  }
  return json(result);
}

const DOC_READ_MAX_CHARS = 50_000;

async function readDocByUser(
  account: ResolvedFeishuAccount,
  userToken: string,
  docToken: string,
  offset?: number,
) {
  const [contentRes, infoRes, blocks] = await Promise.all([
    callFeishuApiWithUserToken<DocxRawContentResponse>({
      method: "GET",
      endpoint: `/docx/v1/documents/${encodeURIComponent(docToken)}/raw_content`,
      userToken,
    }),
    callFeishuApiWithUserToken<DocxDocumentInfoResponse>({
      method: "GET",
      endpoint: `/docx/v1/documents/${encodeURIComponent(docToken)}`,
      userToken,
    }),
    listAllDocBlocksByUser(userToken, docToken),
  ]);
  if (contentRes.code !== 0) throw new Error(contentRes.msg);
  if (infoRes.code !== 0) throw new Error(infoRes.msg);

  // Truncation: slice content from offset, cap at DOC_READ_MAX_CHARS
  const raw = contentRes.data?.content ?? "";
  const start = Math.max(offset ?? 0, 0);
  let content: string;
  let truncated = false;
  if (raw.length - start > DOC_READ_MAX_CHARS) {
    const end = start + DOC_READ_MAX_CHARS;
    const cutPoint = raw.lastIndexOf("\n", end);
    content = raw.slice(start, cutPoint > start ? cutPoint : end);
    truncated = true;
  } else {
    content = raw.slice(start);
  }

  const blockCounts: Record<string, number> = {};
  const structuredTypes: string[] = [];
  for (const b of blocks) {
    const type = b.block_type ?? 0;
    const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
    blockCounts[name] = (blockCounts[name] || 0) + 1;
    if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name))
      structuredTypes.push(name);
  }

  const boardBlocks = extractBoardBlocks(blocks);
  let boardImages: BoardBlockInfo[] | undefined;
  if (boardBlocks.length > 0) {
    boardImages = await fetchBoardImages(account, boardBlocks);
  }

  const docxImageBlocks = extractDocxImageBlocks(blocks);
  let docxImages: DocxImageBlockInfo[] | undefined;
  if (docxImageBlocks.length > 0) {
    docxImages = await fetchDocxImages(account, docxImageBlocks);
  }

  const hints: string[] = [];
  if (structuredTypes.length > 0) {
    hints.push(
      `This document contains ${structuredTypes.join(", ")} which are NOT included in the plain text above. Use feishu_doc with action: "list_blocks" to get full content.`,
    );
  }
  if (truncated) {
    hints.push(
      `Document truncated (showing ${content.length} of ${raw.length} chars from offset ${start}). Pass offset=${start + content.length} to continue reading.`,
    );
  }

  const result = {
    title: infoRes.data?.document?.title,
    content,
    revision_id: infoRes.data?.document?.revision_id,
    total_chars: raw.length,
    returned_chars: content.length,
    ...(start > 0 && { offset: start }),
    ...(truncated && { next_offset: start + content.length, truncated: true }),
    block_count: blocks.length,
    block_types: blockCounts,
    ...(hints.length > 0 && { hint: hints.join(" ") }),
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
    ...(docxImages &&
      docxImages.length > 0 && {
        image_count: docxImages.length,
        image_hint: `This document contains ${docxImages.length} embedded image block(s). Their images are attached below for vision analysis.`,
        images: docxImages.map((img) => ({
          block_id: img.blockId,
          image_token: img.imageToken,
          ...(img.caption && { caption: img.caption }),
          ...(img.error && { error: img.error }),
        })),
      }),
  };

  const inlineImages = [
    ...(await buildInlineBoardImages(boardImages ?? [])),
    ...(await buildInlineDocxImages(docxImages ?? [])),
  ];

  if (inlineImages.length > 0) {
    return jsonWithImages(result, inlineImages);
  }
  return json(result);
}

async function getBlockByUser(userToken: string, docToken: string, blockId: string) {
  const res = await callFeishuApiWithUserToken<DocxBlockGetResponse>({
    method: "GET",
    endpoint: `/docx/v1/documents/${encodeURIComponent(docToken)}/blocks/${encodeURIComponent(blockId)}`,
    userToken,
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { block: res.data?.block };
}

async function readDriveFile(account: ResolvedFeishuAccount, fileToken: string) {
  const result = await readDriveFileContextByToken({
    account,
    fileToken,
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return json({
    title: result.title,
    content_type: result.contentType,
    object_type: "file",
    content: result.content,
  });
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
  try {
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
  } catch (err) {
    // Provide recovery guidance: backup path is available for restore.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `write failed after clearing document (${deleted} blocks deleted). ` +
        `${detail}. ` +
        `Content had ${blocks.length} blocks (${firstLevelBlockIds.length} first-level). ` +
        (backupPath
          ? `Backup saved at ${backupPath} — use feishu_doc write with smaller sections or split tables into separate append calls.`
          : ""),
    );
  }
}

async function appendDoc(client: Lark.Client, docToken: string, markdown: string) {
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) throw new Error("Content is empty");
  try {
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
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `append failed. ${detail}. ` +
        `Content had ${blocks.length} blocks (${firstLevelBlockIds.length} first-level). ` +
        "Try splitting into smaller sections. Tables should be appended separately from text content.",
    );
  }
}

async function createDoc(
  account: ResolvedFeishuAccount,
  client: Lark.Client,
  title: string,
  folderToken: string,
) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  });
  if (res.code !== 0) throw new Error(res.msg);
  const documentId =
    typeof res.data?.document?.document_id === "string" ? res.data.document.document_id.trim() : "";
  if (!documentId) {
    throw new Error("create doc failed: missing document_id");
  }
  const shareResult = await resolveDriveShareUrl(account, documentId, "docx");
  if (!shareResult.ok) {
    throw new Error(
      `create doc share_url resolve failed: token=${documentId} error=${shareResult.error}`,
    );
  }
  return {
    document_id: documentId,
    title: res.data?.document?.title,
    url: shareResult.share_url,
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
  "insert_blocks",
  "delete_range",
] as const;
const DOC_TYPES = [
  "doc",
  "docx",
  "sheet",
  "slides",
  "mindnote",
  "bitable",
  "file",
  "wiki",
] as const;

const FeishuDocSchema = Type.Object({
  action: stringEnum(DOC_ACTIONS, { description: "Document operation to perform" }),
  doc_token: Type.Optional(
    Type.String({
      description:
        "Document token (extract from URL /docx/XXX). Required for all actions except create.",
    }),
  ),
  doc_type: Type.Optional(
    stringEnum(DOC_TYPES, {
      description:
        "Document type for read operations. Required when reading Drive search results with object_type=file.",
    }),
  ),
  content: Type.Optional(
    Type.String({ description: "Markdown content (for write/append/update_block)" }),
  ),
  source_file: Type.Optional(
    Type.String({
      description:
        "Local file path to read content from (for write/append/create). " +
        "Use INSTEAD of content for large documents — the tool reads the file directly, " +
        "avoiding the need to pass large content through the LLM. " +
        "Absolute or relative to ~/.openclaw/workspace/.",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Document title (for create, required)" })),
  folder_token: Type.Optional(
    Type.String({
      description:
        "Target folder token (for create, required). Root/app-space creation is disabled.",
    }),
  ),
  block_id: Type.Optional(
    Type.String({ description: "Block ID (for get_block/update_block/delete_block)" }),
  ),
  after_block_id: Type.Optional(
    Type.String({ description: "Insert content after this block (for insert_blocks)" }),
  ),
  before_block_id: Type.Optional(
    Type.String({ description: "Insert content before this block (for insert_blocks)" }),
  ),
  start_block_id: Type.Optional(
    Type.String({ description: "Range start block ID, inclusive (for delete_range)" }),
  ),
  end_block_id: Type.Optional(
    Type.String({ description: "Range end block ID, inclusive (for delete_range)" }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "Character offset for read action. Use next_offset from a truncated response to continue reading large documents.",
    }),
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

/** Resolve content from either inline `content` or `source_file` path.
 *  source_file lets the AI pass a file path instead of huge inline content,
 *  eliminating 30K+ output tokens for large documents. */
function resolveContent(params: { content?: string; source_file?: string }): string {
  if (params.content && params.source_file) {
    throw new Error(
      "Provide either content or source_file, not both. " +
        "Use source_file for large documents to avoid LLM output token overhead.",
    );
  }
  if (params.source_file) {
    let filePath = params.source_file;
    if (!isAbsolute(filePath)) {
      filePath = resolve(join(homedir(), ".openclaw", "workspace"), filePath);
    }
    if (!existsSync(filePath)) {
      throw new Error(`source_file not found: ${filePath}`);
    }
    const content = readFileSync(filePath, "utf-8");
    if (content.length === 0) {
      throw new Error(`source_file is empty: ${filePath}`);
    }
    return content;
  }
  if (!params.content) {
    throw new Error("Either content or source_file is required.");
  }
  return params.content;
}

// ── Registration ──

export function registerFeishuDocTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];
  const getClient = () => getFeishuClient(firstAccount);
  const oauthRedirectUri = resolveOAuthRedirectUri(api.config as Record<string, unknown>);

  api.registerTool(
    {
      name: "feishu_doc",
      label: "Feishu Doc",
      description:
        "Feishu document operations. Actions: read, write, append, create, list_blocks, get_block, update_block, delete_block, insert_blocks, delete_range",
      parameters: FeishuDocSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          const client = getClient();
          const requireReadAccess = () =>
            requireUserToken({
              account: firstAccount,
              redirectUri: oauthRedirectUri,
              tokenPromise: getValidUserToken(firstAccount),
              toolLabel: "飞书文档读取",
            });
          switch (params.action) {
            case "read":
              if (params.doc_type === "file") {
                return await readDriveFile(firstAccount, params.doc_token);
              }
              return await (async () => {
                const guard = await requireReadAccess();
                if (!guard.ok) return guard.authResponse;
                return readDocByUser(
                  firstAccount,
                  guard.token.access_token,
                  params.doc_token,
                  params.offset,
                );
              })();
            case "write": {
              const content = resolveContent(params);
              return json(await writeDoc(client, params.doc_token, content));
            }
            case "append": {
              const content = resolveContent(params);
              return json(await appendDoc(client, params.doc_token, content));
            }
            case "create": {
              const title = typeof params.title === "string" ? params.title.trim() : "";
              if (!title) {
                throw new Error("title is required for create");
              }
              const folderToken =
                typeof params.folder_token === "string" ? params.folder_token.trim() : "";
              if (!folderToken || folderToken === "0") {
                throw new Error(
                  "folder_token is required for create. Bot app root creation is disabled; provide a user-shared folder token.",
                );
              }
              const created = await createDoc(firstAccount, client, title, folderToken);
              // If content or source_file was provided, write it into the newly created document.
              if (params.content || params.source_file) {
                const content = resolveContent(params);
                const writeResult = await writeDoc(client, created.document_id, content);
                return json({ ...created, ...writeResult });
              }
              return json(created);
            }
            case "list_blocks": {
              const guard = await requireReadAccess();
              if (!guard.ok) return guard.authResponse;
              // Paginated: fetches all blocks even for 500+ block documents.
              const items = await listAllDocBlocksByUser(
                guard.token.access_token,
                params.doc_token,
              );
              // Detect board blocks and fetch their images automatically.
              const boards = extractBoardBlocks(items);
              let boardData: BoardBlockInfo[] | undefined;
              if (boards.length > 0) {
                boardData = await fetchBoardImages(firstAccount, boards);
              }
              const imageBlocks = extractDocxImageBlocks(items);
              let imageData: DocxImageBlockInfo[] | undefined;
              if (imageBlocks.length > 0) {
                imageData = await fetchDocxImages(firstAccount, imageBlocks);
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
                ...(imageData &&
                  imageData.length > 0 && {
                    image_count: imageData.length,
                    images: imageData.map((img) => ({
                      block_id: img.blockId,
                      image_token: img.imageToken,
                      ...(img.caption && { caption: img.caption }),
                      ...(img.error && { error: img.error }),
                    })),
                  }),
              };
              const listImages = [
                ...(await buildInlineBoardImages(boardData ?? [])),
                ...(await buildInlineDocxImages(imageData ?? [])),
              ];
              if (listImages.length > 0) {
                return jsonWithImages(listResult, listImages);
              }
              return json(listResult);
            }
            case "get_block": {
              const guard = await requireReadAccess();
              if (!guard.ok) return guard.authResponse;
              return json(
                await getBlockByUser(guard.token.access_token, params.doc_token, params.block_id),
              );
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
            case "insert_blocks": {
              if (!params.after_block_id && !params.before_block_id) {
                throw new Error(
                  "Either after_block_id or before_block_id is required for insert_blocks",
                );
              }
              const content = resolveContent(params);
              const childrenRes = await client.docx.documentBlockChildren.get({
                path: { document_id: params.doc_token, block_id: params.doc_token },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              const childItems = (childrenRes as any).data?.items ?? [];

              let insertIndex: number;
              if (params.after_block_id) {
                const idx = childItems.findIndex(
                  // oxlint-disable-next-line typescript/no-explicit-any
                  (item: any) => item.block_id === params.after_block_id,
                );
                if (idx === -1) throw new Error(`Block ${params.after_block_id} not found`);
                insertIndex = idx + 1;
              } else {
                const idx = childItems.findIndex(
                  // oxlint-disable-next-line typescript/no-explicit-any
                  (item: any) => item.block_id === params.before_block_id,
                );
                if (idx === -1) throw new Error(`Block ${params.before_block_id} not found`);
                insertIndex = idx;
              }

              const { blocks, firstLevelBlockIds } = await convertMarkdown(client, content);
              if (blocks.length === 0) throw new Error("Content is empty");

              const { children: inserted, tablesCreated } = await insertBlocksWithTables(
                client,
                params.doc_token,
                blocks,
                firstLevelBlockIds,
                insertIndex,
              );
              const imageResult = await processImages(client, params.doc_token, content, inserted);
              return json({
                success: true,
                blocks_inserted: inserted.length,
                insert_position: insertIndex,
                images_processed: imageResult.processed,
                // oxlint-disable-next-line typescript/no-explicit-any
                block_ids: inserted.map((b: any) => b.block_id),
                ...(tablesCreated > 0 && { tables_created: tablesCreated }),
                ...(imageResult.errors.length > 0 && { image_errors: imageResult.errors }),
              });
            }
            case "delete_range": {
              if (!params.start_block_id || !params.end_block_id) {
                throw new Error(
                  "Both start_block_id and end_block_id are required for delete_range",
                );
              }
              const childrenRes = await client.docx.documentBlockChildren.get({
                path: { document_id: params.doc_token, block_id: params.doc_token },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              const childItems = (childrenRes as any).data?.items ?? [];
              const startIdx = childItems.findIndex(
                // oxlint-disable-next-line typescript/no-explicit-any
                (item: any) => item.block_id === params.start_block_id,
              );
              if (startIdx === -1)
                throw new Error(`Start block ${params.start_block_id} not found`);
              const endIdx = childItems.findIndex(
                // oxlint-disable-next-line typescript/no-explicit-any
                (item: any) => item.block_id === params.end_block_id,
              );
              if (endIdx === -1) throw new Error(`End block ${params.end_block_id} not found`);
              if (endIdx < startIdx) {
                throw new Error("end_block_id must come after start_block_id in the document");
              }
              const count = endIdx - startIdx + 1;
              await client.docx.documentBlockChildren.batchDelete({
                path: { document_id: params.doc_token, block_id: params.doc_token },
                data: { start_index: startIdx, end_index: endIdx + 1 },
              });
              return json({
                success: true,
                blocks_deleted: count,
                start_index: startIdx,
                end_index: endIdx,
              });
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          const authResp = await handleFeishuTokenError(err, firstAccount, oauthRedirectUri);
          if (authResp) return authResp;
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_doc" },
  );
  api.logger.info?.("feishu: registered feishu_doc tool");
}
