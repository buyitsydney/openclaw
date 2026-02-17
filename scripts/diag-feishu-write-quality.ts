/**
 * Diagnostic: reproduce feishu_doc write quality issues.
 *
 * This script uses the REAL writeDoc flow (clear + convert + insertBlocksWithTables)
 * on a new document, then reads back and compares content quality.
 *
 * Key checks:
 * 1. documentBlock.list pagination (has_more handling)
 * 2. clearDocumentContent completeness
 * 3. Block ordering after write
 * 4. Table cell content preservation
 * 5. Block count limits
 *
 * Usage: npx tsx scripts/diag-feishu-write-quality.ts
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const configPath = join(homedir(), ".openclaw", "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const feishu = config?.channels?.feishu;
const client = new Lark.Client({
  appId: feishu.appId,
  appSecret: feishu.appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
});

// ── Test 1: Check documentBlock.list pagination behavior ──

async function testListPagination(docToken: string) {
  console.log("\n=== Test 1: documentBlock.list pagination ===");

  // First call: default page_size (should be 500)
  const res1: any = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  const items1 = res1.data?.items ?? [];
  const hasMore1 = res1.data?.has_more ?? false;
  const pageToken1 = res1.data?.page_token ?? "";

  console.log(`  First page: ${items1.length} blocks, has_more=${hasMore1}`);
  if (hasMore1) {
    console.log(`  ⚠️ PAGINATION NEEDED! page_token=${pageToken1.substring(0, 30)}...`);

    // Fetch all pages
    let allBlocks = [...items1];
    let pageToken = pageToken1;
    let pageNum = 2;
    while (pageToken) {
      const res: any = await client.docx.documentBlock.list({
        path: { document_id: docToken },
        params: { page_token: pageToken },
      });
      const items = res.data?.items ?? [];
      allBlocks.push(...items);
      pageToken = res.data?.has_more ? (res.data?.page_token ?? "") : "";
      console.log(`  Page ${pageNum}: ${items.length} blocks, has_more=${res.data?.has_more}`);
      pageNum++;
    }
    console.log(`  Total blocks (all pages): ${allBlocks.length}`);
    return allBlocks;
  }

  console.log(`  ✅ All blocks returned in single page`);
  return items1;
}

// ── Test 2: Write and verify content ──

async function testWriteAndVerify() {
  const mdPath = join(process.cwd(), "docs/her/her-feishu-bot-enterprise-deploy.md");
  const markdown = readFileSync(mdPath, "utf-8");
  const lines = markdown.split("\n");
  console.log(
    `\n=== Test 2: Write and verify (${lines.length} lines, ${markdown.length} chars) ===`,
  );

  // Step 1: Convert markdown
  const escaped = markdown.replace(/\$(\d)/g, (_, d) => `\\$${d}`);
  const convertRes: any = await client.docx.document.convert({
    data: { content_type: "markdown", content: escaped },
  });
  if (convertRes.code !== 0) {
    console.log(`  ❌ Convert failed: ${convertRes.msg}`);
    return;
  }
  const allBlocks = convertRes.data?.blocks ?? [];
  const firstLevelIds: string[] = convertRes.data?.first_level_block_ids ?? [];
  const blockMap = new Map(allBlocks.map((b: any) => [b.block_id, b]));

  // Count block types
  let tableCount = 0;
  let totalCells = 0;
  for (const id of firstLevelIds) {
    const block = blockMap.get(id);
    if (block?.block_type === 31) {
      tableCount++;
      const cells = block.children ?? [];
      totalCells += cells.length;
    }
  }
  console.log(
    `  Converted: ${allBlocks.length} total blocks, ${firstLevelIds.length} first-level, ${tableCount} tables, ${totalCells} cells`,
  );

  // Step 2: Create fresh doc
  const docRes: any = await client.docx.document.create({
    data: { title: "[Diag] Write Quality Test", folder_token: "" },
  });
  const docToken = docRes.data?.document?.document_id;
  console.log(`  Created doc: ${docToken}`);

  // Step 3: Write (same flow as docx.ts writeDoc — but without clear since new doc)
  console.log(`  Writing content...`);
  const writeStart = Date.now();
  let blocksInserted = 0;
  let tablesCreated = 0;

  // Insert non-table blocks in batch, tables separately
  let currentBatch: string[] = [];

  async function flushBatch() {
    if (currentBatch.length === 0) {
      return;
    }
    const toInsert = currentBatch.splice(0);

    // Collect all descendants
    const included = new Set<string>();
    function collect(blockId: string) {
      if (included.has(blockId)) {
        return;
      }
      included.add(blockId);
      const block = blockMap.get(blockId);
      if (block?.children) {
        for (const childId of block.children) {
          collect(childId);
        }
      }
    }
    for (const id of toInsert) {
      collect(id);
    }

    const descendants = allBlocks
      .filter((b: any) => included.has(b.block_id))
      .map((b: any) => {
        const { parent_id: _pid, ...rest } = b;
        return rest;
      });

    try {
      const res: any = await client.docx.documentBlockDescendant.create({
        path: { document_id: docToken, block_id: docToken },
        data: { children_id: toInsert, descendants },
      });
      if (res.code !== 0) {
        console.log(`  ❌ Insert batch failed: ${res.code} ${res.msg}`);
      } else {
        blocksInserted += (res.data?.children ?? []).length;
      }
    } catch (err: any) {
      const data = err?.response?.data;
      console.log(`  ❌ Insert batch error: ${data?.code} ${data?.msg ?? err.message}`);
    }
  }

  for (const flId of firstLevelIds) {
    const block = blockMap.get(flId);
    if (block?.block_type === 31) {
      await flushBatch();
      // Create table using same logic as docx.ts createAndFillTable
      const tableData = extractTableData(blockMap, flId);
      if (!tableData) {
        continue;
      }
      await createAndFillTableDiag(client, docToken, tableData);
      tablesCreated++;
    } else {
      currentBatch.push(flId);
    }
  }
  await flushBatch();
  const writeMs = Date.now() - writeStart;
  console.log(
    `  Write complete: ${writeMs}ms, ${blocksInserted} non-table blocks, ${tablesCreated} tables`,
  );

  // Step 4: Read back and verify
  console.log(`\n  === Verification ===`);
  const allDocBlocks = await listAllBlocks(docToken);
  console.log(`  Total blocks in doc: ${allDocBlocks.length}`);

  // Count block types in doc
  const typeCounts: Record<string, number> = {};
  for (const b of allDocBlocks) {
    const type = b.block_type ?? 0;
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }
  console.log(`  Block types: ${JSON.stringify(typeCounts)}`);

  // Check first-level children order
  const firstLevel = allDocBlocks.filter(
    (b: any) => b.parent_id === docToken && b.block_type !== 1,
  );
  console.log(`  First-level children: ${firstLevel.length}`);

  // Read raw content for comparison
  const contentRes: any = await client.docx.document.rawContent({
    path: { document_id: docToken },
  });
  const rawContent: string = contentRes.data?.content ?? "";
  console.log(`  Raw content length: ${rawContent.length} chars`);

  // Extract headings from raw content
  const headingBlocks = allDocBlocks.filter((b: any) => b.block_type >= 3 && b.block_type <= 9);
  const headings = headingBlocks.map((b: any) => {
    const typeKey = Object.keys(b).find((k) => typeof b[k] === "object" && b[k]?.elements);
    const text = typeKey
      ? (b[typeKey].elements ?? []).map((e: any) => e.text_run?.content ?? "").join("")
      : "";
    return { type: b.block_type, text: text.substring(0, 50) };
  });
  console.log(`\n  Headings in order (${headings.length}):`);
  for (const h of headings) {
    console.log(`    H${h.type - 2}: ${h.text}`);
  }

  // Check tables
  const tables = allDocBlocks.filter((b: any) => b.block_type === 31);
  console.log(`\n  Tables: ${tables.length}`);
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const prop = t.table?.property ?? {};
    const cellIds: string[] = t.children ?? [];

    // Check cell content
    let emptyCells = 0;
    let filledCells = 0;
    for (const cellId of cellIds) {
      const cell = allDocBlocks.find((b: any) => b.block_id === cellId);
      if (!cell?.children?.length) {
        emptyCells++;
        continue;
      }
      const textBlock = allDocBlocks.find((b: any) => b.block_id === cell.children[0]);
      const typeKey = textBlock
        ? Object.keys(textBlock).find(
            (k) => typeof textBlock[k] === "object" && textBlock[k]?.elements,
          )
        : undefined;
      const hasContent =
        typeKey && textBlock[typeKey].elements?.some((e: any) => e.text_run?.content?.length > 0);
      if (hasContent) {
        filledCells++;
      } else {
        emptyCells++;
      }
    }
    console.log(
      `    Table ${i + 1}: ${prop.row_size}×${prop.column_size}, cells=${cellIds.length}, filled=${filledCells}, empty=${emptyCells}`,
    );
  }

  // Check for duplicate headings (sign of failed clear)
  const headingTexts = headings.map((h) => h.text);
  const duplicates = headingTexts.filter((t, i) => headingTexts.indexOf(t) !== i);
  if (duplicates.length > 0) {
    console.log(`\n  ❌ DUPLICATE HEADINGS: ${JSON.stringify([...new Set(duplicates)])}`);
  } else {
    console.log(`\n  ✅ No duplicate headings`);
  }

  // Compare heading order with source markdown headings
  const mdHeadings = markdown
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => {
      const match = l.match(/^(#{1,6})\s+(.*)/);
      return match ? { level: match[1].length, text: match[2].substring(0, 50) } : null;
    })
    .filter(Boolean) as { level: number; text: string }[];

  console.log(`\n  Source markdown headings: ${mdHeadings.length}`);
  console.log(`  Doc headings: ${headings.length}`);

  // Check first few headings match
  const minLen = Math.min(mdHeadings.length, headings.length, 10);
  let orderOk = true;
  for (let i = 0; i < minLen; i++) {
    const md = mdHeadings[i];
    const doc = headings[i];
    // H1 = block_type 3, H2 = 4, etc.
    const mdLevel = md.level + 2;
    const match = doc.type === mdLevel && doc.text.startsWith(md.text.substring(0, 20));
    if (!match) {
      console.log(
        `    ❌ Heading ${i + 1} mismatch: expected H${md.level} "${md.text}" got H${doc.type - 2} "${doc.text}"`,
      );
      orderOk = false;
    }
  }
  if (orderOk) {
    console.log(`  ✅ First ${minLen} headings match source order`);
  }

  console.log(`\n  📎 Check doc: https://bytedance.feishu.cn/docx/${docToken}`);

  // Now test WRITE to same doc (clear + rewrite) — this is the actual bug scenario
  console.log(`\n=== Test 3: Write to EXISTING doc (clear + rewrite) ===`);
  const writeStart2 = Date.now();

  // Clear
  const clearBlocks = await listAllBlocks(docToken);
  const clearChildIds = clearBlocks
    .filter((b: any) => b.parent_id === docToken && b.block_type !== 1)
    .map((b: any) => b.block_id);
  console.log(
    `  Blocks to clear: ${clearChildIds.length} first-level (${clearBlocks.length} total)`,
  );

  if (clearChildIds.length > 0) {
    const delRes: any = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: clearChildIds.length },
    });
    console.log(`  Delete result: code=${delRes.code}`);
  }

  // Verify clear
  const afterClear = await listAllBlocks(docToken);
  const remainingChildren = afterClear.filter(
    (b: any) => b.parent_id === docToken && b.block_type !== 1,
  );
  console.log(
    `  After clear: ${afterClear.length} total blocks, ${remainingChildren.length} first-level children remaining`,
  );
  if (remainingChildren.length > 0) {
    console.log(`  ❌ CLEAR INCOMPLETE! ${remainingChildren.length} blocks still remain`);
    for (const b of remainingChildren.slice(0, 5)) {
      console.log(`    Remaining: type=${b.block_type} id=${b.block_id}`);
    }
  } else {
    console.log(`  ✅ Clear complete`);
  }

  // Rewrite
  console.log(`  Rewriting...`);
  blocksInserted = 0;
  tablesCreated = 0;
  currentBatch = [];

  for (const flId of firstLevelIds) {
    const block = blockMap.get(flId);
    if (block?.block_type === 31) {
      await flushBatch();
      const tableData = extractTableData(blockMap, flId);
      if (!tableData) {
        continue;
      }
      await createAndFillTableDiag(client, docToken, tableData);
      tablesCreated++;
    } else {
      currentBatch.push(flId);
    }
  }
  await flushBatch();
  const rewriteMs = Date.now() - writeStart2;
  console.log(`  Rewrite complete: ${rewriteMs}ms`);

  // Verify rewrite
  const allDocBlocks2 = await listAllBlocks(docToken);
  const firstLevel2 = allDocBlocks2.filter(
    (b: any) => b.parent_id === docToken && b.block_type !== 1,
  );
  const tables2 = allDocBlocks2.filter((b: any) => b.block_type === 31);
  console.log(
    `  After rewrite: ${allDocBlocks2.length} total blocks, ${firstLevel2.length} first-level, ${tables2.length} tables`,
  );

  const headingBlocks2 = allDocBlocks2.filter((b: any) => b.block_type >= 3 && b.block_type <= 9);
  const headings2 = headingBlocks2.map((b: any) => {
    const typeKey = Object.keys(b).find((k) => typeof b[k] === "object" && b[k]?.elements);
    return typeKey
      ? (b[typeKey].elements ?? [])
          .map((e: any) => e.text_run?.content ?? "")
          .join("")
          .substring(0, 50)
      : "";
  });

  const dups2 = headings2.filter((t: string, i: number) => headings2.indexOf(t) !== i);
  if (dups2.length > 0) {
    console.log(`  ❌ DUPLICATE HEADINGS after rewrite: ${JSON.stringify([...new Set(dups2)])}`);
  } else {
    console.log(`  ✅ No duplicate headings after rewrite`);
  }

  // Check table content after rewrite
  for (let i = 0; i < tables2.length; i++) {
    const t = tables2[i];
    const prop = t.table?.property ?? {};
    const cellIds: string[] = t.children ?? [];
    let emptyCells = 0;
    let filledCells = 0;
    for (const cellId of cellIds) {
      const cell = allDocBlocks2.find((b: any) => b.block_id === cellId);
      if (!cell?.children?.length) {
        emptyCells++;
        continue;
      }
      const textBlock = allDocBlocks2.find((b: any) => b.block_id === cell.children[0]);
      const typeKey = textBlock
        ? Object.keys(textBlock).find(
            (k) => typeof textBlock[k] === "object" && textBlock[k]?.elements,
          )
        : undefined;
      const hasContent =
        typeKey && textBlock[typeKey].elements?.some((e: any) => e.text_run?.content?.length > 0);
      if (hasContent) {
        filledCells++;
      } else {
        emptyCells++;
      }
    }
    console.log(
      `    Table ${i + 1}: ${prop.row_size}×${prop.column_size}, filled=${filledCells}, empty=${emptyCells}`,
    );
  }
}

// ── Helpers ──

async function listAllBlocks(docToken: string): Promise<any[]> {
  const allBlocks: any[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await client.docx.documentBlock.list({
      path: { document_id: docToken },
      params: pageToken ? { page_token: pageToken, page_size: 500 } : { page_size: 500 },
    });
    allBlocks.push(...(res.data?.items ?? []));
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return allBlocks;
}

function extractTableData(blockMap: Map<string, any>, tableBlockId: string) {
  const tableBlock = blockMap.get(tableBlockId);
  if (!tableBlock || tableBlock.block_type !== 31) {
    return null;
  }
  const { row_size: rowSize, column_size: columnSize } = tableBlock.table?.property ?? {};
  const cellIds: string[] = tableBlock.children ?? [];
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

const TABLE_BLOCK_TYPE = 31;
const TABLE_CELL_TYPE = 32;
const MAX_TABLE_CREATE = 9;
const TABLE_TOTAL_WIDTH = 700;
const API_RATE_DELAY_MS = 350;
const BATCH_CHUNK = 150;

function calcColumnWidths(colCount: number): number[] {
  const w = Math.floor(TABLE_TOTAL_WIDTH / colCount);
  return Array.from({ length: colCount }, (_, i) =>
    i === colCount - 1 ? TABLE_TOTAL_WIDTH - w * (colCount - 1) : w,
  );
}

async function createAndFillTableDiag(
  client: Lark.Client,
  docToken: string,
  tableData: { rowSize: number; columnSize: number; cellElements: any[][] },
) {
  const { rowSize, columnSize, cellElements } = tableData;
  const createRows = Math.min(rowSize, MAX_TABLE_CREATE);
  const createCols = Math.min(columnSize, MAX_TABLE_CREATE);
  const colWidths = calcColumnWidths(columnSize);

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
    console.log(`  ❌ Table create failed: ${createRes.code} ${createRes.msg}`);
    return;
  }

  const tableBlock = (createRes.data?.children ?? []).find(
    (b: any) => b.block_type === TABLE_BLOCK_TYPE,
  );
  if (!tableBlock) {
    return;
  }
  const tableBlockId = tableBlock.block_id;

  // Expand columns
  for (let c = createCols; c < columnSize; c++) {
    await new Promise((r) => setTimeout(r, API_RATE_DELAY_MS));
    await client.docx.documentBlock.patch({
      path: { document_id: docToken, block_id: tableBlockId },
      data: { insert_table_column: { column_index: c } } as any,
    });
  }

  // Expand rows
  for (let r = createRows; r < rowSize; r++) {
    await new Promise((r) => setTimeout(r, API_RATE_DELAY_MS));
    await client.docx.documentBlock.patch({
      path: { document_id: docToken, block_id: tableBlockId },
      data: { insert_table_row: { row_index: r } } as any,
    });
  }

  // List all blocks to map cells
  const allDocBlocks = await listAllBlocks(docToken);
  const tableInList = allDocBlocks.find((b: any) => b.block_id === tableBlockId);
  const allCellIds: string[] = tableInList?.children ?? [];

  // Build cell → text block map
  const cellTextMap = new Map<string, string>();
  for (const cellId of allCellIds) {
    const cellBlock = allDocBlocks.find((b: any) => b.block_id === cellId);
    if (cellBlock?.block_type === TABLE_CELL_TYPE && cellBlock.children?.length > 0) {
      cellTextMap.set(cellId, cellBlock.children[0]);
    }
  }

  // Batch fill
  const batchRequests: any[] = [];
  for (let i = 0; i < Math.min(allCellIds.length, cellElements.length); i++) {
    const elements = cellElements[i];
    if (elements.length === 0) {
      continue;
    }
    const textBlockId = cellTextMap.get(allCellIds[i]);
    if (!textBlockId) {
      continue;
    }
    batchRequests.push({
      block_id: textBlockId,
      update_text_elements: { elements },
    });
  }

  for (let i = 0; i < batchRequests.length; i += BATCH_CHUNK) {
    const chunk = batchRequests.slice(i, i + BATCH_CHUNK);
    try {
      await client.docx.documentBlock.batchUpdate({
        path: { document_id: docToken },
        data: { requests: chunk },
      });
    } catch (err: any) {
      console.log(`  ⚠️ batch_update failed for table: ${err?.response?.data?.msg ?? err.message}`);
    }
  }
}

testWriteAndVerify().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
