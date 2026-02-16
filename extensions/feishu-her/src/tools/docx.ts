/**
 * Feishu Document (docx) tool — read, write, append, create, and manage document blocks.
 * Adapted from @m1heng-clawd/feishu with schema guardrails (no Type.Union).
 */

import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";
import { Readable } from "stream";
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

// Block types that cannot be created via documentBlockChildren.create API.
const UNSUPPORTED_CREATE_TYPES = new Set([31, 32]);

// oxlint-disable-next-line typescript/no-explicit-any
function cleanBlocksForInsert(blocks: any[]): { cleaned: any[]; skipped: string[] } {
  const skipped: string[] = [];
  const cleaned = blocks.filter((block) => {
    if (UNSUPPORTED_CREATE_TYPES.has(block.block_type)) {
      skipped.push(BLOCK_TYPE_NAMES[block.block_type] || `type_${block.block_type}`);
      return false;
    }
    return true;
  });
  return { cleaned, skipped };
}

function extractImageUrls(markdown: string): string[] {
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const url = match[1].trim();
    if (url.startsWith("http://") || url.startsWith("https://")) urls.push(url);
  }
  return urls;
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

// oxlint-disable-next-line typescript/no-explicit-any
async function insertBlocks(
  client: Lark.Client,
  docToken: string,
  blocks: any[],
  parentBlockId?: string,
) {
  const { cleaned, skipped } = cleanBlocksForInsert(blocks);
  const blockId = parentBlockId ?? docToken;
  if (cleaned.length === 0) return { children: [], skipped };
  const res = await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: blockId },
    data: { children: cleaned },
  });
  // oxlint-disable-next-line typescript/no-explicit-any
  if ((res as any).code !== 0) throw new Error((res as any).msg);
  // oxlint-disable-next-line typescript/no-explicit-any
  return { children: (res as any).data?.children ?? [], skipped };
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

// oxlint-disable-next-line typescript/no-explicit-any
async function processImages(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  insertedBlocks: any[],
): Promise<number> {
  const imageUrls = extractImageUrls(markdown);
  if (imageUrls.length === 0) return 0;
  // oxlint-disable-next-line typescript/no-explicit-any
  const imageBlocks = insertedBlocks.filter((b: any) => b.block_type === 27);
  let processed = 0;
  for (let i = 0; i < Math.min(imageUrls.length, imageBlocks.length); i++) {
    try {
      const response = await fetch(imageUrls[i]);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      const fileName = new URL(imageUrls[i]).pathname.split("/").pop() || `image_${i}.png`;
      // oxlint-disable-next-line typescript/no-explicit-any
      const uploadRes: any = await client.drive.media.uploadAll({
        data: {
          file_name: fileName,
          parent_type: "docx_image",
          parent_node: imageBlocks[i].block_id,
          size: buffer.length,
          // oxlint-disable-next-line typescript/no-explicit-any
          file: Readable.from(buffer) as any,
        },
      });
      const fileToken = uploadRes?.file_token;
      if (fileToken) {
        await client.docx.documentBlock.patch({
          path: { document_id: docToken, block_id: imageBlocks[i].block_id },
          data: { replace_image: { token: fileToken } },
        });
        processed++;
      }
    } catch {
      // Best-effort image processing.
    }
  }
  return processed;
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

async function writeDoc(client: Lark.Client, docToken: string, markdown: string) {
  const deleted = await clearDocumentContent(client, docToken);
  const { blocks } = await convertMarkdown(client, markdown);
  if (blocks.length === 0)
    return { success: true, blocks_deleted: deleted, blocks_added: 0, images_processed: 0 };
  const { children: inserted, skipped } = await insertBlocks(client, docToken, blocks);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted);
  return {
    success: true,
    blocks_deleted: deleted,
    blocks_added: inserted.length,
    images_processed: imagesProcessed,
    ...(skipped.length > 0 && {
      warning: `Skipped unsupported block types: ${skipped.join(", ")}.`,
    }),
  };
}

async function appendDoc(client: Lark.Client, docToken: string, markdown: string) {
  const { blocks } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) throw new Error("Content is empty");
  const { children: inserted, skipped } = await insertBlocks(client, docToken, blocks);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted);
  return {
    success: true,
    blocks_added: inserted.length,
    images_processed: imagesProcessed,
    // oxlint-disable-next-line typescript/no-explicit-any
    block_ids: inserted.map((b: any) => b.block_id),
    ...(skipped.length > 0 && {
      warning: `Skipped unsupported block types: ${skipped.join(", ")}.`,
    }),
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
            case "create":
              return json(await createDoc(client, params.title, params.folder_token));
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
              const res = await client.docx.documentBlock.patch({
                path: { document_id: params.doc_token, block_id: params.block_id },
                data: {
                  update_text_elements: { elements: [{ text_run: { content: params.content } }] },
                },
              });
              // oxlint-disable-next-line typescript/no-explicit-any
              if ((res as any).code !== 0) throw new Error((res as any).msg);
              return json({ success: true, block_id: params.block_id });
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
