/**
 * Real cloud E2E for feishu_doc with strict isolation.
 *
 * Guarantees:
 * - local source is snapshotted to test/fixtures (source file untouched)
 * - cloud write targets a new doc under dedicated test folder (online docs untouched)
 * - verification runs on that exact cloud test doc
 *
 * Required env:
 * - FEISHU_E2E_TARGET_WIKI_URL
 * - FEISHU_E2E_TEST_PARENT_NODE_TOKEN
 *
 * Optional env:
 * - FEISHU_E2E_SOURCE_FILE (default: docs/her/her-feishu-bot-enterprise-deploy.md)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { registerFeishuDocTools } from "../extensions/feishu-her/src/tools/docx.js";

type Block = {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  table?: {
    property?: {
      row_size?: number;
      column_size?: number;
    };
  };
  [key: string]: unknown;
};

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function parseWikiToken(url: string): string {
  const u = new URL(url);
  const match = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!match?.[1]) {
    throw new Error(`Invalid wiki URL: ${url}`);
  }
  return match[1];
}

function extractBlockText(block: Block): string {
  for (const [key, val] of Object.entries(block)) {
    if (
      !["block_id", "block_type", "parent_id", "children", "table"].includes(key) &&
      typeof val === "object" &&
      val &&
      // oxlint-disable-next-line typescript/no-explicit-any
      Array.isArray((val as any).elements)
    ) {
      // oxlint-disable-next-line typescript/no-explicit-any
      return ((val as any).elements as any[])
        .map((e) => e?.text_run?.content ?? "")
        .join("")
        .trim();
    }
  }
  return "";
}

function computeMetrics(blocks: Block[], docToken: string) {
  const topLevel = blocks.filter((b) => b.parent_id === docToken && b.block_type !== 1);
  const tables = blocks.filter((b) => b.block_type === 31);
  const headings = blocks
    .filter((b) => b.block_type >= 3 && b.block_type <= 9)
    .map((b) => extractBlockText(b))
    .filter(Boolean);

  let totalCells = 0;
  let emptyCells = 0;
  for (const t of tables) {
    const cellIds = t.children ?? [];
    totalCells += cellIds.length;
    for (const cellId of cellIds) {
      const cell = blocks.find((b) => b.block_id === cellId);
      const textId = cell?.children?.[0];
      if (!textId) {
        emptyCells++;
        continue;
      }
      const textBlock = blocks.find((b) => b.block_id === textId);
      if (!textBlock || extractBlockText(textBlock).length === 0) {
        emptyCells++;
      }
    }
  }

  return {
    total_blocks: blocks.length,
    top_level_blocks: topLevel.length,
    heading_count: headings.length,
    table_count: tables.length,
    total_cells: totalCells,
    empty_cells: emptyCells,
  };
}

async function main() {
  const targetWikiUrl = requiredEnv("FEISHU_E2E_TARGET_WIKI_URL");
  const parentNodeToken = requiredEnv("FEISHU_E2E_TEST_PARENT_NODE_TOKEN");
  const sourceFile = resolve(
    process.env.FEISHU_E2E_SOURCE_FILE?.trim() ||
      join(process.cwd(), "docs/her/her-feishu-bot-enterprise-deploy.md"),
  );

  const sourceContent = readFileSync(sourceFile, "utf8");
  if (!sourceContent.trim()) {
    throw new Error(`Source file is empty: ${sourceFile}`);
  }

  const hash = createHash("sha1").update(sourceContent).digest("hex").slice(0, 10);
  const runId = new Date().toISOString().replaceAll(":", "-");
  const fixtureDir = join(process.cwd(), "test/fixtures/feishu-doc-cloud-e2e");
  const reportDir = join(process.cwd(), "test/reports/feishu-doc-cloud-e2e");
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const snapshotPath = join(fixtureDir, `source-${runId}-${hash}.md`);
  writeFileSync(snapshotPath, sourceContent, "utf8");

  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const feishu = cfg?.channels?.feishu;
  const appId = feishu?.appId?.trim();
  const appSecret = feishu?.appSecret?.trim();
  if (!appId || !appSecret) {
    throw new Error("Missing channels.feishu.appId/appSecret in ~/.openclaw/openclaw.json");
  }

  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });

  const wikiToken = parseWikiToken(targetWikiUrl);
  // oxlint-disable-next-line typescript/no-explicit-any
  const nodeRes: any = await client.wiki.space.getNode({ params: { token: wikiToken } });
  if (nodeRes.code !== 0) {
    throw new Error(`wiki.getNode failed: ${nodeRes.code} ${nodeRes.msg}`);
  }
  const spaceId = nodeRes.data?.node?.space_id;
  if (!spaceId) {
    throw new Error("Cannot resolve space_id from target wiki URL");
  }

  const title = `[E2E][docx] ${basename(sourceFile)} ${runId}`;
  // oxlint-disable-next-line typescript/no-explicit-any
  const createRes: any = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: "docx",
      node_type: "origin",
      title,
      parent_node_token: parentNodeToken,
    },
  });
  if (createRes.code !== 0) {
    throw new Error(`wiki.spaceNode.create failed: ${createRes.code} ${createRes.msg}`);
  }
  const testNodeToken = createRes.data?.node?.node_token;
  const docToken = createRes.data?.node?.obj_token;
  if (!docToken) {
    throw new Error("Created test node has empty obj_token");
  }

  const registerTool = (...args: unknown[]) => {
    // captures the tool definition below
    // oxlint-disable-next-line typescript/no-explicit-any
    (registerTool as any)._calls.push(args);
  };
  // oxlint-disable-next-line typescript/no-explicit-any
  (registerTool as any)._calls = [] as unknown[];

  registerFeishuDocTools({
    config: {
      channels: {
        feishu: {
          enabled: true,
          appId,
          appSecret,
        },
      },
    },
    logger: { info: () => {} },
    // oxlint-disable-next-line typescript/no-explicit-any
    registerTool: registerTool as any,
  } as never);

  // oxlint-disable-next-line typescript/no-explicit-any
  const docTool = (registerTool as any)._calls
    // oxlint-disable-next-line typescript/no-explicit-any
    .map((c: any[]) => c[0])
    // oxlint-disable-next-line typescript/no-explicit-any
    .find((t: any) => t?.name === "feishu_doc");
  if (!docTool) {
    throw new Error("Failed to register feishu_doc tool");
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  const writeRes: any = await docTool.execute("e2e-write", {
    action: "write",
    doc_token: docToken,
    source_file: snapshotPath,
  });
  // oxlint-disable-next-line typescript/no-explicit-any
  const listRes: any = await docTool.execute("e2e-list", {
    action: "list_blocks",
    doc_token: docToken,
  });

  // oxlint-disable-next-line typescript/no-explicit-any
  const writeDetails = writeRes?.details ?? {};
  // oxlint-disable-next-line typescript/no-explicit-any
  if (typeof writeDetails.error === "string" && writeDetails.error.length > 0) {
    throw new Error(`feishu_doc write error: ${writeDetails.error}`);
  }
  // oxlint-disable-next-line typescript/no-explicit-any
  const listDetails = listRes?.details ?? {};
  // oxlint-disable-next-line typescript/no-explicit-any
  if (typeof listDetails.error === "string" && listDetails.error.length > 0) {
    throw new Error(`feishu_doc list_blocks error: ${listDetails.error}`);
  }

  const blocks = (listDetails.blocks ?? []) as Block[];
  const metrics = computeMetrics(blocks, docToken);
  const report = {
    run_id: runId,
    source_file: sourceFile,
    source_snapshot: snapshotPath,
    target_wiki_url: targetWikiUrl,
    test_parent_node_token: parentNodeToken,
    created_node_token: testNodeToken,
    created_doc_token: docToken,
    created_doc_token_note: `Use drive/v1/metas/batch_query to resolve real share_url for ${docToken}`,
    write_result: writeDetails,
    metrics,
  };
  const reportPath = join(reportDir, `report-${runId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify(report, null, 2));
  console.log(`report_path=${reportPath}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
