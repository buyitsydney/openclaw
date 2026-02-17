/**
 * Reproduce + fix verification on SAME destination wiki page.
 *
 * Target:
 *   https://my.feishu.cn/wiki/BEjCwi1wzilCAJktm3PchKB6n6e
 * Source:
 *   docs/her/her-feishu-bot-enterprise-deploy.md
 *
 * Flow:
 * 1) Resolve wiki token -> doc token (obj_token).
 * 2) Run OLD writer (single-page list; simulates old bug-prone path), verify.
 * 3) Run FIXED writer (paginated list), verify again.
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEST_WIKI_URL = "https://my.feishu.cn/wiki/BEjCwi1wzilCAJktm3PchKB6n6e";
const SOURCE_MD = join(process.cwd(), "docs/her/her-feishu-bot-enterprise-deploy.md");

const TABLE_BLOCK_TYPE = 31;
const TABLE_CELL_TYPE = 32;
const MAX_TABLE_CREATE = 9;
const TABLE_TOTAL_WIDTH = 700;
const API_RATE_DELAY_MS = 350;
const BATCH_CHUNK = 150;

const configPath = join(homedir(), ".openclaw", "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const feishu = config?.channels?.feishu;
const client = new Lark.Client({
  appId: feishu.appId,
  appSecret: feishu.appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
});

function parseWikiToken(url: string): string {
  const u = new URL(url);
  const match = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!match) {
    throw new Error(`Invalid wiki URL: ${url}`);
  }
  return match[1];
}

async function resolveDocTokenFromWiki(wikiToken: string): Promise<string> {
  // Same endpoint used by feishu_wiki tool.
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.wiki.space.getNode({ params: { token: wikiToken } });
  if (res.code !== 0) {
    throw new Error(`wiki.getNode failed: ${res.code} ${res.msg}`);
  }
  const docToken = res.data?.node?.obj_token;
  if (!docToken) {
    throw new Error("wiki.getNode returned empty obj_token");
  }
  return docToken;
}

function calcColumnWidths(colCount: number): number[] {
  const w = Math.floor(TABLE_TOTAL_WIDTH / colCount);
  return Array.from({ length: colCount }, (_, i) =>
    i === colCount - 1 ? TABLE_TOTAL_WIDTH - w * (colCount - 1) : w,
  );
}

// oxlint-disable-next-line typescript/no-explicit-any
function extractTableData(blockMap: Map<string, any>, tableBlockId: string) {
  const tableBlock = blockMap.get(tableBlockId);
  if (!tableBlock || tableBlock.block_type !== TABLE_BLOCK_TYPE) {
    return null;
  }
  const { row_size: rowSize, column_size: columnSize } = tableBlock.table?.property ?? {};
  const cellIds: string[] = tableBlock.children ?? [];
  // oxlint-disable-next-line typescript/no-explicit-any
  const cellElements: any[][] = [];
  for (const cellId of cellIds) {
    const cell = blockMap.get(cellId);
    const textBlockId = cell?.children?.[0];
    const textBlock = textBlockId ? blockMap.get(textBlockId) : undefined;
    if (!textBlock) {
      cellElements.push([]);
      continue;
    }
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

// oxlint-disable-next-line typescript/no-explicit-any
async function listBlocksFirstPage(docToken: string): Promise<any[]> {
  // Intentionally old behavior: only first page.
  // oxlint-disable-next-line typescript/no-explicit-any
  const res: any = await client.docx.documentBlock.list({ path: { document_id: docToken } });
  if (res.code !== 0) {
    throw new Error(`list first page failed: ${res.code} ${res.msg}`);
  }
  return res.data?.items ?? [];
}

// oxlint-disable-next-line typescript/no-explicit-any
async function listBlocksAllPages(docToken: string): Promise<any[]> {
  // Fixed behavior.
  // oxlint-disable-next-line typescript/no-explicit-any
  const all: any[] = [];
  let pageToken: string | undefined;
  do {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.documentBlock.list({
      path: { document_id: docToken },
      params: pageToken ? { page_token: pageToken, page_size: 500 } : { page_size: 500 },
    });
    if (res.code !== 0) {
      throw new Error(`list all pages failed: ${res.code} ${res.msg}`);
    }
    all.push(...(res.data?.items ?? []));
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return all;
}

async function clearOld(docToken: string) {
  const items = await listBlocksFirstPage(docToken);
  const childIds = items
    // oxlint-disable-next-line typescript/no-explicit-any
    .filter((b: any) => b.parent_id === docToken && b.block_type !== 1)
    // oxlint-disable-next-line typescript/no-explicit-any
    .map((b: any) => b.block_id) as string[];
  if (childIds.length > 0) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length },
    });
    if (res.code !== 0) {
      throw new Error(`clearOld failed: ${res.code} ${res.msg}`);
    }
  }
  return childIds.length;
}

async function clearFixed(docToken: string) {
  const items = await listBlocksAllPages(docToken);
  const childIds = items
    // oxlint-disable-next-line typescript/no-explicit-any
    .filter((b: any) => b.parent_id === docToken && b.block_type !== 1)
    // oxlint-disable-next-line typescript/no-explicit-any
    .map((b: any) => b.block_id) as string[];
  if (childIds.length > 0) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length },
    });
    if (res.code !== 0) {
      throw new Error(`clearFixed failed: ${res.code} ${res.msg}`);
    }
  }
  return childIds.length;
}

async function createAndFillTable(
  docToken: string,
  // oxlint-disable-next-line typescript/no-explicit-any
  tableData: { rowSize: number; columnSize: number; cellElements: any[][] },
  mode: "old" | "fixed",
) {
  const { rowSize, columnSize, cellElements } = tableData;
  const createRows = Math.min(rowSize, MAX_TABLE_CREATE);
  const createCols = Math.min(columnSize, MAX_TABLE_CREATE);
  const colWidths = calcColumnWidths(columnSize);

  // oxlint-disable-next-line typescript/no-explicit-any
  const createRes: any = await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: docToken },
    data: {
      children: [
        {
          block_type: TABLE_BLOCK_TYPE,
          table: {
            property: {
              row_size: createRows,
              column_size: createCols,
              column_width: colWidths.slice(0, createCols),
            },
          },
        },
      ],
    } as any,
  });
  if (createRes.code !== 0) {
    throw new Error(`create table failed: ${createRes.code} ${createRes.msg}`);
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  const tableBlock = (createRes.data?.children ?? []).find(
    (b: any) => b.block_type === TABLE_BLOCK_TYPE,
  );
  if (!tableBlock) {
    throw new Error("table block missing");
  }
  const tableBlockId = tableBlock.block_id as string;

  for (let c = createCols; c < columnSize; c++) {
    await new Promise((r) => setTimeout(r, API_RATE_DELAY_MS));
    await client.docx.documentBlock.patch({
      path: { document_id: docToken, block_id: tableBlockId },
      data: { insert_table_column: { column_index: c } } as any,
    });
  }
  for (let r = createRows; r < rowSize; r++) {
    await new Promise((r) => setTimeout(r, API_RATE_DELAY_MS));
    await client.docx.documentBlock.patch({
      path: { document_id: docToken, block_id: tableBlockId },
      data: { insert_table_row: { row_index: r } } as any,
    });
  }

  const allBlocks =
    mode === "old" ? await listBlocksFirstPage(docToken) : await listBlocksAllPages(docToken);
  // oxlint-disable-next-line typescript/no-explicit-any
  const tableInList = allBlocks.find((b: any) => b.block_id === tableBlockId);
  const allCellIds: string[] = tableInList?.children ?? [];

  const cellTextMap = new Map<string, string>();
  for (const cellId of allCellIds) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cellBlock = allBlocks.find((b: any) => b.block_id === cellId);
    if (cellBlock?.block_type === TABLE_CELL_TYPE && cellBlock.children?.length > 0) {
      cellTextMap.set(cellId, cellBlock.children[0]);
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  const requests: any[] = [];
  for (let i = 0; i < Math.min(allCellIds.length, cellElements.length); i++) {
    const elements = cellElements[i];
    if (elements.length === 0) {
      continue;
    }
    const textBlockId = cellTextMap.get(allCellIds[i]);
    if (!textBlockId) {
      continue;
    }
    requests.push({
      block_id: textBlockId,
      update_text_elements: { elements },
    });
  }

  for (let i = 0; i < requests.length; i += BATCH_CHUNK) {
    const chunk = requests.slice(i, i + BATCH_CHUNK);
    await client.docx.documentBlock.batchUpdate({
      path: { document_id: docToken },
      data: { requests: chunk },
    });
  }
}

async function writeWithMode(docToken: string, markdown: string, mode: "old" | "fixed") {
  const deleted = mode === "old" ? await clearOld(docToken) : await clearFixed(docToken);

  const escaped = markdown.replace(/\$(\d)/g, (_, d) => `\\$${d}`);
  // oxlint-disable-next-line typescript/no-explicit-any
  const convertRes: any = await client.docx.document.convert({
    data: { content_type: "markdown", content: escaped },
  });
  if (convertRes.code !== 0) {
    throw new Error(`convert failed: ${convertRes.code} ${convertRes.msg}`);
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  const blocks: any[] = convertRes.data?.blocks ?? [];
  const firstLevelIds: string[] = convertRes.data?.first_level_block_ids ?? [];
  const blockMap = new Map(blocks.map((b) => [b.block_id, b]));

  let currentBatch: string[] = [];
  let tables = 0;

  async function flushBatch() {
    if (currentBatch.length === 0) {
      return;
    }
    const included = new Set<string>();
    function collect(id: string) {
      if (included.has(id)) {
        return;
      }
      included.add(id);
      const b = blockMap.get(id);
      if (b?.children) {
        for (const c of b.children) collect(c);
      }
    }
    for (const id of currentBatch) {
      collect(id);
    }
    const descendants = blocks
      .filter((b) => included.has(b.block_id))
      // oxlint-disable-next-line typescript/no-explicit-any
      .map((b: any) => {
        const { parent_id: _pid, ...rest } = b;
        return rest;
      });

    // oxlint-disable-next-line typescript/no-explicit-any
    const res: any = await client.docx.documentBlockDescendant.create({
      path: { document_id: docToken, block_id: docToken },
      data: { children_id: currentBatch, descendants },
    });
    if (res.code !== 0) {
      throw new Error(`descendant.create failed: ${res.code} ${res.msg}`);
    }
    currentBatch = [];
  }

  for (const flId of firstLevelIds) {
    const b = blockMap.get(flId);
    if (b?.block_type === TABLE_BLOCK_TYPE) {
      await flushBatch();
      const tableData = extractTableData(blockMap, flId);
      if (tableData) {
        await createAndFillTable(docToken, tableData, mode);
        tables++;
      }
    } else {
      currentBatch.push(flId);
    }
  }
  await flushBatch();

  return { deleted, tables, firstLevelCount: firstLevelIds.length };
}

async function verify(docToken: string, markdown: string) {
  const all = await listBlocksAllPages(docToken);
  const firstLevel = all.filter((b) => b.parent_id === docToken && b.block_type !== 1);
  const headings = all
    .filter((b) => b.block_type >= 3 && b.block_type <= 9)
    // oxlint-disable-next-line typescript/no-explicit-any
    .map((b: any) => {
      const key = Object.keys(b).find((k) => typeof b[k] === "object" && b[k]?.elements);
      const txt = key
        ? // oxlint-disable-next-line typescript/no-explicit-any
          (b[key].elements ?? []).map((e: any) => e.text_run?.content ?? "").join("")
        : "";
      return txt.trim();
    })
    .filter(Boolean);

  const keyOrder = [
    "背景",
    "部署前置条件",
    "方案选择",
    "架构详情",
    "IT 操作流程",
    "各通道与工具能力",
    "费用估算（200 人规模）",
    "总结",
  ];
  const positions = keyOrder.map((k) => headings.findIndex((h) => h.includes(k)));
  let ordered = true;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === -1 || positions[i - 1] === -1 || positions[i] <= positions[i - 1]) {
      ordered = false;
    }
  }

  const tableBlocks = all.filter((b) => b.block_type === TABLE_BLOCK_TYPE);
  let emptyCells = 0;
  let totalCells = 0;
  for (const t of tableBlocks) {
    const cellIds: string[] = t.children ?? [];
    totalCells += cellIds.length;
    for (const id of cellIds) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const cell = all.find((b: any) => b.block_id === id);
      const textId = cell?.children?.[0];
      // oxlint-disable-next-line typescript/no-explicit-any
      const textBlock = textId ? all.find((b: any) => b.block_id === textId) : undefined;
      if (!textBlock) {
        emptyCells++;
        continue;
      }
      const key = Object.keys(textBlock).find(
        (k) => typeof textBlock[k] === "object" && textBlock[k]?.elements,
      );
      const hasContent =
        key &&
        (textBlock[key].elements ?? []).some((e: any) => (e.text_run?.content ?? "").length > 0);
      if (!hasContent) {
        emptyCells++;
      }
    }
  }

  const rawRes: any = await client.docx.document.rawContent({ path: { document_id: docToken } });
  const rawLen = rawRes.data?.content?.length ?? 0;
  const mdLen = markdown.length;

  return {
    totalBlocks: all.length,
    firstLevel: firstLevel.length,
    headings: headings.length,
    headingOrderOk: ordered,
    tableCount: tableBlocks.length,
    emptyCells,
    totalCells,
    rawLen,
    mdLen,
    keyPositions: positions,
  };
}

async function main() {
  const markdown = readFileSync(SOURCE_MD, "utf-8");
  const wikiToken = parseWikiToken(DEST_WIKI_URL);
  const docToken = await resolveDocTokenFromWiki(wikiToken);
  console.log(`Destination wiki token: ${wikiToken}`);
  console.log(`Resolved doc token: ${docToken}`);
  console.log(
    `Source file: ${SOURCE_MD} (${markdown.split("\n").length} lines, ${markdown.length} chars)`,
  );

  console.log("\n[Phase 0] Baseline verify on current destination");
  console.log(await verify(docToken, markdown));

  console.log("\n[Phase 1] Reproduce with OLD logic (single-page list)");
  const t1 = Date.now();
  const oldRes = await writeWithMode(docToken, markdown, "old");
  const oldMs = Date.now() - t1;
  const v1 = await verify(docToken, markdown);
  console.log({ oldRes, oldMs, verify: v1 });

  console.log("\n[Phase 2] Fix with FIXED logic (paginated list)");
  const t2 = Date.now();
  const fixedRes = await writeWithMode(docToken, markdown, "fixed");
  const fixedMs = Date.now() - t2;
  const v2 = await verify(docToken, markdown);
  console.log({ fixedRes, fixedMs, verify: v2 });

  console.log(`\nDone. Check URL: ${DEST_WIKI_URL}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
