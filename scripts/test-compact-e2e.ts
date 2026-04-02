#!/usr/bin/env bun
/**
 * Compact E2E 测试脚本 — 验证 H1-H7 假设
 *
 * 完整测试方案见: docs/her/context-compact-architecture.md 第 16 章
 *
 * 前置条件:
 *   1. ~/.openclaw/openclaw.json 中 contextTokens 已改为 50000, model 改为 sonnet-4-6
 *   2. gateway 已通过 ./start.sh 重启
 *
 * 运行: bun scripts/test-compact-e2e.ts
 * 清理: bun scripts/test-compact-e2e.ts --cleanup
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayClient } from "../src/gateway/client.js";

const GATEWAY_URL = "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = "my-local-token-12345";
const SESSIONS_DIR = join(homedir(), ".openclaw/agents/main/sessions");
const SESSIONS_JSON = join(SESSIONS_DIR, "sessions.json");
const WORKSPACE_MEMORY_DIR = join(homedir(), ".openclaw/workspace/memory");
const TEST_SESSION_PREFIX = "test-compact-";
const RESULTS_FILE = join(homedir(), ".openclaw/compact-test-results.json");

// ---- Logging ----

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logSection(msg: string) {
  console.log(`\n${"=".repeat(60)}`);
  log(msg);
  console.log("=".repeat(60));
}

// ---- File Helpers ----

async function listSessionFiles(): Promise<string[]> {
  const files = await readdir(SESSIONS_DIR);
  return files.filter((f) => f.endsWith(".jsonl"));
}

async function findNewSessionFiles(before: string[]): Promise<string[]> {
  const after = await listSessionFiles();
  const beforeSet = new Set(before);
  return after.filter((f) => !beforeSet.has(f));
}

type JsonlEntry = Record<string, unknown>;

async function readJsonlFile(filename: string): Promise<JsonlEntry[]> {
  const content = await readFile(join(SESSIONS_DIR, filename), "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JsonlEntry);
}

function findCompactionEntries(entries: JsonlEntry[]): JsonlEntry[] {
  return entries.filter((e) => e.type === "compaction");
}

function _countMessages(entries: JsonlEntry[], role?: string): number {
  return entries.filter((e) => {
    if (e.type !== "message") {
      return false;
    }
    if (!role) {
      return true;
    }
    const msg = e.message as { role?: string } | undefined;
    return msg?.role === role;
  }).length;
}

function getLastAssistantText(entries: JsonlEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== "message") {
      continue;
    }
    const msg = e.message as { role?: string; content?: unknown } | undefined;
    if (msg?.role !== "assistant") {
      continue;
    }
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      const textBlocks = msg.content
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b?.text ?? "");
      return textBlocks.join("\n");
    }
  }
  return "";
}

async function listMemoryFiles(): Promise<string[]> {
  try {
    return await readdir(WORKSPACE_MEMORY_DIR);
  } catch {
    return [];
  }
}

// ---- Gateway Connection ----

type RunCompletion = { resolve: (evt: unknown) => void; timer: NodeJS.Timeout };
const runCompletions = new Map<string, RunCompletion>();

function connectToGateway(): Promise<GatewayClient> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway connect timeout (15s)")), 15_000);
    const client = new GatewayClient({
      url: GATEWAY_URL,
      token: GATEWAY_TOKEN,
      clientName: "test" as never,
      clientDisplayName: "compact-e2e-test",
      clientVersion: "dev",
      mode: "test" as never,
      connectDelayMs: 0,
      onEvent: (evt) => {
        if (
          evt.event === "chat" &&
          evt.payload &&
          typeof evt.payload === "object" &&
          "state" in evt.payload &&
          evt.payload.state === "final"
        ) {
          const runId = "runId" in evt.payload ? (evt.payload.runId as string) : null;
          if (runId) {
            const pending = runCompletions.get(runId);
            if (pending) {
              clearTimeout(pending.timer);
              runCompletions.delete(runId);
              pending.resolve(evt);
            }
          }
        }
      },
      onHelloOk: () => {
        clearTimeout(timer);
        resolve(client);
      },
      onConnectError: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    client.start();
  });
}

async function sendAndWait(
  client: GatewayClient,
  sessionKey: string,
  message: string,
  timeoutMs = 180_000,
): Promise<void> {
  const idempotencyKey = randomUUID();
  const completionPromise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      runCompletions.delete(idempotencyKey);
      reject(new Error(`run timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    runCompletions.set(idempotencyKey, { resolve, timer });
  });
  const requestPromise = client.request("chat.send", {
    sessionKey,
    message,
    idempotencyKey,
  });
  await Promise.race([requestPromise.then(() => completionPromise), completionPromise]);
}

// ---- Test Scenarios ----

interface HypothesisResult {
  id: string;
  name: string;
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  details: Record<string, unknown>;
  durationMs: number;
}

const KEY_FACTS = {
  name: { prompt: "我叫张三", verify: "张三" },
  city: { prompt: "我住在杭州", verify: "杭州" },
  number: { prompt: "我最喜欢的数字是42", verify: "42" },
  language: { prompt: "我最擅长的编程语言是Rust", verify: "Rust" },
  password: { prompt: "我的密码提示是'蓝色大象在跳舞123'", verify: "蓝色大象" },
};

const FILLER_PROMPTS = [
  "请详细解释量子计算的工作原理，包括量子比特、量子纠缠、量子叠加、量子门、量子退相干等核心概念，每个至少200字。",
  "请详细比较 React、Vue、Angular、Svelte、Solid 五个前端框架的架构设计、状态管理、路由、生态系统，每个框架至少150字。",
  "请详细解释 Transformer 架构，包括 Self-Attention、Multi-Head Attention、Positional Encoding、Layer Normalization、Feed-Forward Network 的数学推导。",
  "请详细描述全球气候变化的成因、影响、应对策略，包括温室效应机制、海平面上升预测、碳交易经济学、可再生能源进展。",
  "请详细解释分布式系统理论：CAP定理、ACID vs BASE、Paxos、Raft、两阶段提交、三阶段提交、向量时钟、Gossip协议。",
  "请用2000字解释现代编译器流程：词法分析、语法分析、语义分析、中间代码生成、代码优化、目标代码生成。",
  "请详细解释密码学算法：AES、RSA、ECC、SHA-256、数字签名、零知识证明，每个给出数学基础和安全性分析。",
  "请详细解释 Linux 内核内存管理：虚拟内存、页表、TLB、NUMA、伙伴系统、slab分配器、OOM killer、ZRAM。",
  "请详细解释数据库存储引擎：B+树索引、LSM-Tree、WAL、MVCC、Buffer Pool、查询优化器成本模型、Join算法。",
  "请详细比较微服务 vs 单体：服务发现、负载均衡、熔断、saga事务、CQRS、Service Mesh、可观测性。",
  "请从零设计搜索引擎：爬虫、URL调度、倒排索引、TF-IDF、PageRank、查询处理、缓存策略。",
  "请解释深度学习优化：SGD、Momentum、Adam、LAMB、Lookahead，以及 CosineAnnealing、OneCycleLR、Warmup。",
  "请解释 OS 进程调度：FCFS、SJF、Round Robin、多级反馈队列、CFS、实时调度（EDF、RMS）。",
  "请解释网络协议栈：以太网、IP路由、BGP、OSPF、TCP拥塞控制、QUIC、HTTP/2、HTTP/3、gRPC。",
  "请解释函数式编程：纯函数、Monad、Functor、Applicative、类型类、ADT、模式匹配、尾递归优化。",
];

/**
 * H1: 配置生效验证 + H2: 摘要结构 + H6: 压缩率
 * 这三个用同一个 session 测试，因为都依赖 auto-compact 触发
 */
async function testH1_H2_H6(client: GatewayClient): Promise<HypothesisResult[]> {
  const sessionKey = `${TEST_SESSION_PREFIX}h1h2h6-${Date.now()}`;
  const start = Date.now();
  const filesBefore = await listSessionFiles();
  let triggerRound = -1;
  let compactionSummary = "";
  let tokensBefore = 0;

  logSection("H1 + H2 + H6: Auto-compact 触发 / 摘要结构 / 压缩率");
  log(`sessionKey = ${sessionKey}`);

  for (let i = 0; i < FILLER_PROMPTS.length; i++) {
    log(`  发送消息 #${i + 1}/${FILLER_PROMPTS.length}...`);
    try {
      await sendAndWait(client, sessionKey, FILLER_PROMPTS[i]);
      log(`  ✓ 消息 #${i + 1} 完成`);
    } catch (err) {
      log(`  ✗ 消息 #${i + 1} 失败: ${String(err)}`);
      break;
    }

    const newFiles = await findNewSessionFiles(filesBefore);
    for (const f of newFiles) {
      const entries = await readJsonlFile(f);
      const compactions = findCompactionEntries(entries);
      if (compactions.length > 0) {
        triggerRound = i + 1;
        const c = compactions[0];
        compactionSummary = typeof c.summary === "string" ? c.summary : "";
        tokensBefore = Number(c.tokensBefore ?? 0);
        log(`  ★ AUTO-COMPACT 在第 ${triggerRound} 轮触发！`);
        log(`  tokensBefore = ${tokensBefore}`);
        log(`  summary 长度 = ${compactionSummary.length} chars`);
        break;
      }
    }
    if (triggerRound > 0) {
      break;
    }
  }

  // H1 结果
  const h1Status =
    triggerRound >= 5 && triggerRound <= 15 ? "PASS" : triggerRound > 0 ? "WARN" : "FAIL";
  const h1: HypothesisResult = {
    id: "H1",
    name: "配置生效验证",
    status: h1Status,
    details: { triggerRound, expected: "5-15" },
    durationMs: Date.now() - start,
  };

  // H2: 检查摘要结构
  const structureKeywords = [
    "goal",
    "progress",
    "decision",
    "next step",
    "objective",
    "status",
    "plan",
  ];
  const summaryLower = compactionSummary.toLowerCase();
  const matchedKeywords = structureKeywords.filter((kw) => summaryLower.includes(kw));
  const h2Status =
    matchedKeywords.length >= 3
      ? "PASS"
      : matchedKeywords.length >= 1
        ? "WARN"
        : compactionSummary
          ? "FAIL"
          : "SKIP";
  const h2: HypothesisResult = {
    id: "H2",
    name: "摘要结构验证",
    status: h2Status,
    details: {
      summaryLength: compactionSummary.length,
      matchedKeywords,
      summaryPreview: compactionSummary.slice(0, 500),
      fullSummary: compactionSummary,
    },
    durationMs: Date.now() - start,
  };

  // H6: 压缩率（发一条简单消息拿 post-compact 的 totalTokens 很难直接获取，用 summary 长度近似）
  const summaryTokensEstimate = Math.ceil(compactionSummary.length / 4);
  const compressionRatio = tokensBefore > 0 ? 1 - summaryTokensEstimate / tokensBefore : 0;
  const h6Status =
    compressionRatio >= 0.6 && compressionRatio <= 0.95
      ? "PASS"
      : compressionRatio > 0
        ? "WARN"
        : "SKIP";
  const h6: HypothesisResult = {
    id: "H6",
    name: "压缩率",
    status: h6Status,
    details: {
      tokensBefore,
      summaryTokensEstimate,
      compressionRatio: `${(compressionRatio * 100).toFixed(1)}%`,
    },
    durationMs: Date.now() - start,
  };

  return [h1, h2, h6];
}

/**
 * H3: 信息保留 (单次 compact) + H7: Memory Flush
 */
async function testH3_H7(client: GatewayClient): Promise<HypothesisResult[]> {
  const sessionKey = `${TEST_SESSION_PREFIX}h3h7-${Date.now()}`;
  const start = Date.now();
  const filesBefore = await listSessionFiles();
  const memoryFilesBefore = await listMemoryFiles();

  logSection("H3 + H7: 信息保留 + Memory Flush");
  log(`sessionKey = ${sessionKey}`);

  // 植入 5 个关键事实
  const factText = Object.values(KEY_FACTS)
    .map((f) => f.prompt)
    .join("。");
  log("  植入关键事实...");
  await sendAndWait(client, sessionKey, `请记住以下关于我的信息：${factText}。请确认你记住了。`);
  log("  ✓ 事实已植入");

  // 用长消息填充 context 直到 compact
  let compacted = false;
  for (let i = 0; i < FILLER_PROMPTS.length; i++) {
    log(`  填充消息 #${i + 1}...`);
    await sendAndWait(client, sessionKey, FILLER_PROMPTS[i]);
    log(`  ✓ 完成`);

    const newFiles = await findNewSessionFiles(filesBefore);
    for (const f of newFiles) {
      const entries = await readJsonlFile(f);
      if (findCompactionEntries(entries).length > 0) {
        compacted = true;
        log("  ★ Compaction 已触发！");
        break;
      }
    }
    if (compacted) {
      break;
    }
  }

  if (!compacted) {
    // 手动触发
    log("  Auto-compact 未触发，手动 /compact...");
    await sendAndWait(client, sessionKey, "/compact");
    compacted = true;
    log("  ✓ 手动 compact 完成");
  }

  // 验证 5 个事实
  log("  验证事实保留...");
  await sendAndWait(
    client,
    sessionKey,
    "请回答以下问题，每个用一行回答：\n1. 我叫什么名字？\n2. 我住在哪个城市？\n3. 我最喜欢的数字是什么？\n4. 我最擅长的编程语言是什么？\n5. 我的密码提示是什么？",
  );

  const newFiles = await findNewSessionFiles(filesBefore);
  let lastReply = "";
  for (const f of newFiles) {
    const entries = await readJsonlFile(f);
    lastReply = getLastAssistantText(entries);
  }

  log(`  回复: ${lastReply.slice(0, 300)}`);

  const recallResults: Record<string, boolean> = {};
  let recallCount = 0;
  for (const [key, fact] of Object.entries(KEY_FACTS)) {
    const found = lastReply.includes(fact.verify);
    recallResults[key] = found;
    if (found) {
      recallCount++;
    }
  }

  const h3Status = recallCount >= 4 ? "PASS" : recallCount >= 3 ? "WARN" : "FAIL";
  const h3: HypothesisResult = {
    id: "H3",
    name: "信息保留 (单次 compact)",
    status: h3Status,
    details: {
      recallCount,
      total: 5,
      recallResults,
      replyPreview: lastReply.slice(0, 500),
    },
    durationMs: Date.now() - start,
  };

  // H7: Memory Flush 验证
  const memoryFilesAfter = await listMemoryFiles();
  const newMemoryFiles = memoryFilesAfter.filter((f) => !memoryFilesBefore.includes(f));
  let memoryContent = "";
  if (newMemoryFiles.length > 0) {
    try {
      memoryContent = await readFile(join(WORKSPACE_MEMORY_DIR, newMemoryFiles[0]), "utf-8");
    } catch {
      // ignore
    }
  }
  // 也检查已有文件是否有新内容
  const todayFile = `${new Date().toISOString().slice(0, 10)}.md`;
  if (!memoryContent) {
    try {
      memoryContent = await readFile(join(WORKSPACE_MEMORY_DIR, todayFile), "utf-8");
    } catch {
      // ignore
    }
  }

  const memoryHasKeyInfo = Object.values(KEY_FACTS).some((f) => memoryContent.includes(f.verify));
  const h7Status = memoryHasKeyInfo ? "PASS" : memoryContent ? "WARN" : "FAIL";
  const h7: HypothesisResult = {
    id: "H7",
    name: "Memory Flush",
    status: h7Status,
    details: {
      newMemoryFiles,
      todayFileExists: memoryContent.length > 0,
      memoryHasKeyInfo,
      memoryPreview: memoryContent.slice(0, 500),
    },
    durationMs: Date.now() - start,
  };

  return [h3, h7];
}

/**
 * H4: 多次 compact 后的信息衰减
 */
async function testH4(client: GatewayClient): Promise<HypothesisResult> {
  const sessionKey = `${TEST_SESSION_PREFIX}h4-${Date.now()}`;
  const start = Date.now();
  const filesBefore = await listSessionFiles();

  logSection("H4: 多次 compact 信息衰减");
  log(`sessionKey = ${sessionKey}`);

  // 植入事实
  const factText = Object.values(KEY_FACTS)
    .map((f) => f.prompt)
    .join("。");
  await sendAndWait(client, sessionKey, `请记住：${factText}。确认记住了。`);

  let compactionCount = 0;
  const recallByRound: Record<string, number> = {};

  for (let round = 1; round <= 2; round++) {
    log(`  --- 第 ${round} 轮 compact ---`);

    // 填充
    for (let i = 0; i < FILLER_PROMPTS.length; i++) {
      log(`  R${round} 填充 #${i + 1}...`);
      await sendAndWait(client, sessionKey, FILLER_PROMPTS[i]);

      const newFiles = await findNewSessionFiles(filesBefore);
      let found = false;
      for (const f of newFiles) {
        const entries = await readJsonlFile(f);
        const compactions = findCompactionEntries(entries);
        if (compactions.length > compactionCount) {
          compactionCount = compactions.length;
          found = true;
          log(`  ★ 第 ${compactionCount} 次 compact 触发！`);
          break;
        }
      }
      if (found) {
        break;
      }
    }

    if (compactionCount < round) {
      log(`  手动触发 /compact...`);
      await sendAndWait(client, sessionKey, "/compact");
      compactionCount = round;
    }

    // 验证
    await sendAndWait(
      client,
      sessionKey,
      "请回答：1.我叫什么？2.住哪？3.最喜欢的数字？4.最擅长的语言？5.密码提示？每个一行。",
    );

    const newFiles = await findNewSessionFiles(filesBefore);
    let reply = "";
    for (const f of newFiles) {
      reply = getLastAssistantText(await readJsonlFile(f));
    }

    let count = 0;
    for (const fact of Object.values(KEY_FACTS)) {
      if (reply.includes(fact.verify)) {
        count++;
      }
    }
    recallByRound[`round${round}`] = count;
    log(`  第 ${round} 轮回忆: ${count}/5`);
  }

  const round1 = recallByRound.round1 ?? 0;
  const round2 = recallByRound.round2 ?? 0;
  const decayed = round2 < round1;
  const status = decayed ? "PASS" : round2 === round1 ? "WARN" : "FAIL";

  return {
    id: "H4",
    name: "多次 compact 信息衰减",
    status,
    details: { recallByRound, decayed },
    durationMs: Date.now() - start,
  };
}

// ---- Cleanup ----

async function cleanup() {
  logSection("清理测试数据");

  const allFiles = await readdir(SESSIONS_DIR);
  let sessionsStore: Record<string, Record<string, unknown>> = {};
  try {
    sessionsStore = JSON.parse(await readFile(SESSIONS_JSON, "utf-8"));
  } catch {
    log("  无法读取 sessions.json");
  }

  const testKeys = Object.keys(sessionsStore).filter((k) => k.includes(TEST_SESSION_PREFIX));
  const filesToDelete = new Set<string>();

  for (const key of testKeys) {
    const entry = sessionsStore[key] as { sessionFile?: string };
    if (entry?.sessionFile) {
      filesToDelete.add(entry.sessionFile);
      for (const f of allFiles) {
        if (f.startsWith(entry.sessionFile)) {
          filesToDelete.add(f);
        }
      }
    }
  }

  let deletedCount = 0;
  for (const f of filesToDelete) {
    try {
      await rm(join(SESSIONS_DIR, f), { force: true });
      deletedCount++;
      log(`  删除: ${f}`);
    } catch {
      // ignore
    }
  }

  if (testKeys.length > 0) {
    for (const key of testKeys) {
      delete sessionsStore[key];
    }
    await writeFile(SESSIONS_JSON, JSON.stringify(sessionsStore, null, 2), "utf-8");
    log(`  sessions.json: 移除 ${testKeys.length} 个条目`);
  }

  try {
    await rm(RESULTS_FILE, { force: true });
  } catch {
    // ignore
  }

  log(`  完成: ${deletedCount} 文件, ${testKeys.length} 条目`);
}

// ---- Main ----

async function main() {
  if (process.argv.includes("--cleanup")) {
    await cleanup();
    return;
  }

  logSection("Compact E2E 测试开始");
  log(`测试方案: docs/her/context-compact-architecture.md 第 16 章`);
  log(`Gateway: ${GATEWAY_URL}`);
  log(`Sessions: ${SESSIONS_DIR}`);

  let client: GatewayClient;
  try {
    log("连接 Gateway...");
    client = await connectToGateway();
    log("✓ 连接成功");
  } catch (err) {
    log(`✗ 连接失败: ${String(err)}`);
    log("请确保: 1) ./start.sh 已运行  2) contextTokens=50000  3) model=sonnet-4-6");
    process.exit(1);
  }

  const results: HypothesisResult[] = [];

  // P0: H1 + H2 + H6
  try {
    results.push(...(await testH1_H2_H6(client)));
  } catch (err) {
    log(`H1/H2/H6 异常: ${String(err)}`);
    results.push(
      {
        id: "H1",
        name: "配置生效",
        status: "FAIL",
        details: { error: String(err) },
        durationMs: 0,
      },
      { id: "H2", name: "摘要结构", status: "SKIP", details: {}, durationMs: 0 },
      { id: "H6", name: "压缩率", status: "SKIP", details: {}, durationMs: 0 },
    );
  }

  // 如果 H1 失败，后续不可信但仍然跑
  if (results.find((r) => r.id === "H1")?.status === "FAIL") {
    log("\n⚠ H1 失败！配置可能未生效，后续结果仅供参考。\n");
  }

  // P0: H3 + H7
  try {
    results.push(...(await testH3_H7(client)));
  } catch (err) {
    log(`H3/H7 异常: ${String(err)}`);
    results.push(
      {
        id: "H3",
        name: "信息保留",
        status: "FAIL",
        details: { error: String(err) },
        durationMs: 0,
      },
      { id: "H7", name: "Memory Flush", status: "SKIP", details: {}, durationMs: 0 },
    );
  }

  // P2: H4 (多轮衰减)
  try {
    results.push(await testH4(client));
  } catch (err) {
    log(`H4 异常: ${String(err)}`);
    results.push({
      id: "H4",
      name: "信息衰减",
      status: "FAIL",
      details: { error: String(err) },
      durationMs: 0,
    });
  }

  // 保存结果
  await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2), "utf-8");

  // 汇总
  logSection("测试结果汇总");
  for (const r of results) {
    const icon =
      r.status === "PASS" ? "✓" : r.status === "WARN" ? "~" : r.status === "SKIP" ? "-" : "✗";
    const dur = `${(r.durationMs / 1000).toFixed(0)}s`;
    log(`  [${r.status}] ${icon} ${r.id}: ${r.name} (${dur})`);
    for (const [k, v] of Object.entries(r.details)) {
      if (k === "fullSummary" || k === "replyPreview" || k === "memoryPreview") {
        continue;
      }
      const val = typeof v === "object" && v !== null ? JSON.stringify(v) : (v as string);
      if (val.length <= 120) {
        log(`         ${k}: ${val}`);
      }
    }
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const total = results.filter((r) => r.status !== "SKIP").length;
  log(`\n  总计: ${passed}/${total} PASS`);
  log(`  结果文件: ${RESULTS_FILE}`);
  log(`  清理命令: bun scripts/test-compact-e2e.ts --cleanup`);

  client.stop();
  setTimeout(() => process.exit(0), 1000);
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
