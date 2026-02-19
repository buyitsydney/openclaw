/**
 * Feishu Card Stream 性能基准测试
 *
 * 测量 card stream 各阶段 API 调用耗时，与一次性消息发送对比。
 *
 * 用法:
 *   bun scripts/feishu-card-stream-perf.ts
 *
 * 需要环境变量 (或从 openclaw.json 自动读取):
 *   FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_TEST_CHAT_ID
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────

function loadFeishuCreds(): { appId: string; appSecret: string; chatId: string } {
  let appId = process.env.FEISHU_APP_ID ?? "";
  let appSecret = process.env.FEISHU_APP_SECRET ?? "";
  let chatId = process.env.FEISHU_TEST_CHAT_ID ?? "";

  if (!appId || !appSecret) {
    try {
      const raw = readFileSync(join(homedir(), ".openclaw/openclaw.json"), "utf-8");
      const cfg = JSON.parse(raw);
      const feishu = cfg.channels?.feishu;
      const accounts = feishu?.accounts;
      if (accounts) {
        const firstKey = Object.keys(accounts)[0];
        const acct = accounts[firstKey];
        appId = appId || acct?.appId || "";
        appSecret = appSecret || acct?.appSecret || "";
      }
      if (!chatId) {
        chatId = feishu?.testChatId || "";
      }
    } catch {}
  }

  if (!appId || !appSecret) {
    console.error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
    process.exit(1);
  }
  if (!chatId) {
    console.error(
      "缺少 FEISHU_TEST_CHAT_ID (设置环境变量或在 openclaw.json channels.feishu.testChatId)",
    );
    process.exit(1);
  }
  return { appId, appSecret, chatId };
}

// ── Timing helpers ──────────────────────────────────────────────────────

function ms(): number {
  return performance.now();
}

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(0)}ms`;
}

interface TimingRecord {
  label: string;
  durationMs: number;
}

const timings: TimingRecord[] = [];

function record(label: string, start: number) {
  const dur = performance.now() - start;
  timings.push({ label, durationMs: dur });
  console.log(`  ✓ ${label}: ${dur.toFixed(0)}ms`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const { appId, appSecret, chatId } = loadFeishuCreds();
  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });

  const STREAM_ELEMENT_ID = "perf_test_content";
  const testText =
    "这是一条 card stream 性能测试消息。\n\n" + "测试时间: " + new Date().toLocaleString("zh-CN");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  飞书 Card Stream 性能基准测试");
  console.log("═══════════════════════════════════════════════════════\n");

  // ── Test 1: 一次性消息发送 ──────────────────────────────────────────
  console.log("【测试 1】一次性消息发送 (im.message.create)");
  {
    const t0 = ms();
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: `[Perf Test] 一次性发送:\n${testText}` }),
        msg_type: "text",
      },
    });
    record("im.message.create (一次性文本)", t0);
  }

  // ── Test 2: Card Stream 完整流程 ───────────────────────────────────
  console.log("\n【测试 2】Card Stream 完整流程");

  let cardId: string | undefined;
  let cardMessageId: string | undefined;
  let sequence = 1;

  // Step 2a: card.create
  {
    const t0 = ms();
    const resp = await client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify({
          schema: "2.0",
          body: {
            elements: [
              {
                tag: "markdown",
                content: "...",
                element_id: STREAM_ELEMENT_ID,
              },
            ],
          },
          config: { streaming_mode: true },
        }),
      },
    });
    cardId = resp?.data?.card_id;
    record("cardkit.card.create", t0);
    if (!cardId) {
      console.error("card.create 失败: 无 card_id");
      return;
    }
  }

  // Step 2b: im.message.create (send card)
  {
    const t0 = ms();
    const resp = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
        msg_type: "interactive",
      },
    });
    cardMessageId = resp?.data?.message_id;
    record("im.message.create (卡片消息)", t0);
    if (!cardMessageId) {
      console.error("message.create 失败: 无 message_id");
      return;
    }
  }

  // Step 2c: cardElement.content 更新 (模拟流式)
  const chunks = [
    "正在思考",
    "正在思考...\n\n好的，",
    "正在思考...\n\n好的，让我来回答你的问题。",
    "正在思考...\n\n好的，让我来回答你的问题。\n\n这是一个非常好的问题，",
    "正在思考...\n\n好的，让我来回答你的问题。\n\n这是一个非常好的问题，我需要从几个方面来分析：\n\n1. 首先，",
    "正在思考...\n\n好的，让我来回答你的问题。\n\n这是一个非常好的问题，我需要从几个方面来分析：\n\n1. 首先，card stream 的延迟主要来自 API 调用开销\n2. 其次，",
    "正在思考...\n\n好的，让我来回答你的问题。\n\n这是一个非常好的问题，我需要从几个方面来分析：\n\n1. 首先，card stream 的延迟主要来自 API 调用开销\n2. 其次，throttle 间隔决定了更新频率\n3. 最后，finalize 步骤也需要额外的 API 调用",
  ];

  const updateTimings: number[] = [];
  console.log(`  模拟 ${chunks.length} 次流式更新 (无 throttle，连续发送):`);
  for (let i = 0; i < chunks.length; i++) {
    const t0 = ms();
    await client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
      data: { content: chunks[i], sequence: sequence++ },
    });
    const dur = performance.now() - t0;
    updateTimings.push(dur);
    console.log(`    update[${i}]: ${dur.toFixed(0)}ms`);
  }
  const avgUpdate = updateTimings.reduce((a, b) => a + b, 0) / updateTimings.length;
  timings.push({ label: "cardElement.content (平均)", durationMs: avgUpdate });
  console.log(`  ✓ cardElement.content 平均: ${avgUpdate.toFixed(0)}ms`);

  // Step 2d: sendFinal — 最后一次完整内容更新
  {
    const finalText = chunks[chunks.length - 1] + "\n\n✅ 测试完成";
    const t0 = ms();
    await client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: STREAM_ELEMENT_ID },
      data: { content: finalText, sequence: sequence++ },
    });
    record("cardElement.content (sendFinal)", t0);
  }

  // Step 2e: card.settings — 关闭 streaming_mode
  {
    const t0 = ms();
    await client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence: sequence++,
      },
    });
    record("card.settings (finalize)", t0);
  }

  // ── Test 3: 模拟实际场景对比 ──────────────────────────────────────
  console.log("\n【测试 3】模拟完整对话场景 (10s 生成 + 300ms throttle)");

  const SIM_GENERATE_MS = 10_000;
  const SIM_THROTTLE_MS = 300;
  const SIM_TOKEN_INTERVAL_MS = 20; // ~50 tokens/s

  // 3a: One-shot 模式 — 等待生成完成后一次发送
  {
    const t0 = ms();
    await sleep(SIM_GENERATE_MS);
    const sendStart = ms();
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({
          text: `[Perf Sim] One-shot: 模拟 ${SIM_GENERATE_MS}ms 生成后发送`,
        }),
        msg_type: "text",
      },
    });
    const sendDur = performance.now() - sendStart;
    const totalDur = performance.now() - t0;
    console.log(
      `  One-shot: 生成 ${SIM_GENERATE_MS}ms + 发送 ${sendDur.toFixed(0)}ms = 总计 ${totalDur.toFixed(0)}ms`,
    );
    timings.push({ label: "one-shot 总计", durationMs: totalDur });
  }

  // 3b: Card Stream 模式 — 先创建卡片，边生成边更新
  {
    const t0 = ms();

    // 创建卡片
    const createStart = ms();
    const resp = await client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify({
          schema: "2.0",
          body: {
            elements: [
              {
                tag: "markdown",
                content: "...",
                element_id: "sim_content",
              },
            ],
          },
          config: { streaming_mode: true },
        }),
      },
    });
    const simCardId = resp?.data?.card_id!;
    const createDur = performance.now() - createStart;

    // 发送卡片消息
    const msgStart = ms();
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ type: "card", data: { card_id: simCardId } }),
        msg_type: "interactive",
      },
    });
    const msgDur = performance.now() - msgStart;
    const startupOverhead = performance.now() - t0;
    console.log(
      `  启动开销: card.create ${createDur.toFixed(0)}ms + message.create ${msgDur.toFixed(0)}ms = ${startupOverhead.toFixed(0)}ms`,
    );

    // 模拟生成 + 更新
    let simSeq = 1;
    let simUpdates = 0;
    let simLastUpdate = 0;
    const genStart = ms();
    let accumulated = "";
    const totalTokens = Math.floor(SIM_GENERATE_MS / SIM_TOKEN_INTERVAL_MS);

    for (let i = 0; i < totalTokens; i++) {
      accumulated += "字";
      const now = performance.now();
      if (now - simLastUpdate >= SIM_THROTTLE_MS) {
        await client.cardkit.v1.cardElement.content({
          path: { card_id: simCardId, element_id: "sim_content" },
          data: { content: accumulated, sequence: simSeq++ },
        });
        simUpdates++;
        simLastUpdate = now;
      }
      await sleep(SIM_TOKEN_INTERVAL_MS);
    }
    const genDur = performance.now() - genStart;

    // sendFinal + finalize
    const finalStart = ms();
    await client.cardkit.v1.cardElement.content({
      path: { card_id: simCardId, element_id: "sim_content" },
      data: {
        content: `[Perf Sim] Stream: ${simUpdates} 次更新\n${accumulated.slice(0, 50)}...`,
        sequence: simSeq++,
      },
    });
    await client.cardkit.v1.card.settings({
      path: { card_id: simCardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence: simSeq++,
      },
    });
    const finalDur = performance.now() - finalStart;

    const totalDur = performance.now() - t0;
    console.log(`  生成+更新: ${genDur.toFixed(0)}ms (${simUpdates} 次 API 调用)`);
    console.log(`  结束开销: sendFinal+finalize ${finalDur.toFixed(0)}ms`);
    console.log(`  Card Stream 总计: ${totalDur.toFixed(0)}ms`);
    console.log(
      `  额外开销: 启动 ${startupOverhead.toFixed(0)}ms + 结束 ${finalDur.toFixed(0)}ms = ${(startupOverhead + finalDur).toFixed(0)}ms`,
    );
    timings.push({ label: "card-stream 总计", durationMs: totalDur });
    timings.push({ label: "card-stream 额外开销", durationMs: startupOverhead + finalDur });
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  汇总");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log("┌─────────────────────────────────────┬──────────┐");
  console.log("│ 指标                                │ 耗时     │");
  console.log("├─────────────────────────────────────┼──────────┤");
  for (const t of timings) {
    const label = t.label.padEnd(35);
    const val = `${t.durationMs.toFixed(0)}ms`.padStart(8);
    console.log(`│ ${label} │ ${val} │`);
  }
  console.log("└─────────────────────────────────────┴──────────┘");

  console.log(`
分析:
- DEFAULT_STREAM_THROTTLE_MS = 300ms（当前代码默认值）
- 每次 cardElement.content 调用平均 ~${avgUpdate.toFixed(0)}ms
- 卡片创建+发送: 约 ${timings.find((t) => t.label.includes("card.create"))?.durationMs.toFixed(0)}ms + ${timings.find((t) => t.label.includes("卡片消息"))?.durationMs.toFixed(0)}ms
- 结束处理: sendFinal + finalize 约 ${(
    (timings.find((t) => t.label.includes("sendFinal"))?.durationMs ?? 0) +
    (timings.find((t) => t.label.includes("finalize"))?.durationMs ?? 0)
  ).toFixed(0)}ms
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
