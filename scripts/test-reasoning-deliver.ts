/**
 * 测试 deliver 回调中 reasoning 检测逻辑是否正确。
 * 模拟 card stream 激活时各种 payload 到达 deliver 的场景。
 *
 * 用法: npx tsx scripts/test-reasoning-deliver.ts
 */

type ReplyDispatchKind = "tool" | "block" | "final";

interface DeliverPayload {
  text?: string;
}

interface DeliverInfo {
  kind: ReplyDispatchKind;
}

type DeliverResult = {
  action: "accumulate" | "bypass-reasoning" | "bypass-tool" | "normal-send";
  text: string;
};

function simulateDeliver(
  payload: DeliverPayload,
  info: DeliverInfo,
  cardStreamStarted: boolean,
): DeliverResult {
  const text = payload.text ?? "";

  if (cardStreamStarted && text) {
    const isReasoningBlock = info.kind === "block" && text.trimStart().startsWith("Reasoning:");
    const isVerboseTool = info.kind === "tool";

    if (!isReasoningBlock && !isVerboseTool) {
      return { action: "accumulate", text };
    }

    return {
      action: isReasoningBlock ? "bypass-reasoning" : "bypass-tool",
      text,
    };
  }

  return { action: "normal-send", text };
}

// ── Test cases ──────────────────────────────────────────────────────────

const tests: {
  name: string;
  payload: DeliverPayload;
  info: DeliverInfo;
  cardStream: boolean;
  expected: string;
}[] = [
  {
    name: "主文本 (card stream active)",
    payload: { text: "你好，这是回复内容" },
    info: { kind: "block" },
    cardStream: true,
    expected: "accumulate",
  },
  {
    name: "Reasoning (card stream active, kind=block)",
    payload: { text: "Reasoning:\n_Let me think about this_" },
    info: { kind: "block" },
    cardStream: true,
    expected: "bypass-reasoning",
  },
  {
    name: "Tool result (card stream active, kind=tool)",
    payload: { text: "🔧 Read: file.txt" },
    info: { kind: "tool" },
    cardStream: true,
    expected: "bypass-tool",
  },
  {
    name: "Final reply (card stream active, kind=final)",
    payload: { text: "最终回复" },
    info: { kind: "final" },
    cardStream: true,
    expected: "accumulate",
  },
  {
    name: "Reasoning (card stream NOT active)",
    payload: { text: "Reasoning:\n_Thinking_" },
    info: { kind: "block" },
    cardStream: false,
    expected: "normal-send",
  },
  {
    name: "Tool (card stream NOT active)",
    payload: { text: "🔧 Exec: curl" },
    info: { kind: "tool" },
    cardStream: false,
    expected: "normal-send",
  },
  // 边界：reasoning 带 responsePrefix
  {
    name: "Reasoning with leading whitespace",
    payload: { text: "  Reasoning:\n_text_" },
    info: { kind: "block" },
    cardStream: true,
    expected: "bypass-reasoning",
  },
  // 关键：如果 reasoning 被 dispatch-from-config 的 onBlockReply 处理后，
  // 是否 kind 可能变成 "final" 而不是 "block"？
  {
    name: "Reasoning but kind=final (edge case)",
    payload: { text: "Reasoning:\n_text_" },
    info: { kind: "final" },
    cardStream: true,
    expected: "accumulate", // kind=final 不匹配 reasoning check
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const result = simulateDeliver(t.payload, t.info, t.cardStream);
  const ok = result.action === t.expected;
  if (ok) {
    passed++;
    console.log(`✅ ${t.name}: ${result.action}`);
  } else {
    failed++;
    console.log(`❌ ${t.name}: expected=${t.expected} actual=${result.action}`);
    console.log(`   payload.text prefix: "${(t.payload.text ?? "").slice(0, 40)}"`);
  }
}

console.log(`\n${passed}/${passed + failed} passed`);

// ── 额外检查：reasoning 是否可能以 kind="final" 而非 "block" 到达 ──
// 追踪 dispatch-from-config.ts 的 reply flow:
// 1. onBlockReply → dispatcher.sendBlockReply → deliver(payload, {kind:"block"})
// 2. final reply → dispatcher.sendFinalReply → deliver(payload, {kind:"final"})
//
// reasoning 通过 onBlockReply 发出 → kind 一定是 "block"
// 所以 kind="final" + "Reasoning:" 是不可能出现的。

console.log("\n─── 追踪分析 ───");
console.log("reasoning 路径: onBlockReply → sendBlockReply → deliver(kind='block') ✅");
console.log("如果 deliver 中 reasoning 不出现 → reasoning 根本没有到达 onBlockReply");
console.log("");
console.log("可能原因:");
console.log("1. includeReasoning=false (session reasoning 未开启)");
console.log("2. formattedReasoning 为空 (AI 没有产生 thinking blocks)");
console.log("3. formattedReasoning === lastReasoningSent (重复过滤)");
console.log("4. blockReplyBreak='text_end' 时 reasoning 在 message_end 后才发出，");
console.log("   但此时 cardStream 可能已经 stopped");

// ── 关键发现：检查 stopCardStream 时序 ──
console.log("\n─── 时序分析（关键！） ───");
console.log("代码流程:");
console.log("  1. dispatchReplyWithBufferedBlockDispatcher() 返回");
console.log("  2. → stopCardStream() 被调用");
console.log("  3. → cardStream.stop() 设置 stopped=true");
console.log("");
console.log("但是！dispatcher 是异步队列。如果 reasoning 在队列中还没处理,");
console.log("而 stopCardStream 已经开始 → cardStream.started 变 false?");
console.log("");
console.log("检查: dispatchReplyWithBufferedBlockDispatcher 是否等待队列清空?");
console.log("→ 看 dispatch.ts: withReplyDispatcher 会 await dispatcher.waitForIdle()");
console.log("→ 所以 reasoning 应该在 stopCardStream 之前完成投递");
console.log("");
console.log("再查: cardStream.stop() 只设置 stopped=true 阻止新的 card 更新,");
console.log("不改 cardStream.started。所以 deliver 中 cardStream?.started 应该还是 true");
console.log("");
console.log("结论: 如果 reasoning 确实以 kind='block' + 'Reasoning:' 前缀到达 deliver,");
console.log("检测逻辑应该能命中。问题很可能在上游 — reasoning 根本没到 deliver。");

if (failed > 0) {
  process.exit(1);
}
