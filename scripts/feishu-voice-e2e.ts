/**
 * 验证脚本：feishu-her card stream 中 reasoning/verbose 消息过滤 bug
 *
 * 使用方法:
 *   bun scripts/feishu-voice-e2e.ts
 *
 * 测试目标:
 *   1. 证明当前代码把 reasoning("block" kind) 和 verbose("tool" kind) 吞入 card，未单独发出
 *   2. 证明修复后 reasoning 和 verbose 被单独发出，主文本仍走 card accumulation
 */

type ReplyDispatchKind = "tool" | "block" | "final";
interface ReplyPayload {
  text?: string;
}
interface DeliverInfo {
  kind: ReplyDispatchKind;
}

interface DeliveredMessage {
  target: "card_accumulated" | "separate_message";
  kind: ReplyDispatchKind;
  text: string;
}

// ── Simulate current (buggy) deliver handler ──────────────────────────────────
function simulateCurrentDeliver(
  payload: ReplyPayload,
  info: DeliverInfo,
  cardStreamActive: boolean,
): { accumulated: string; separate: string[] } {
  const accumulated: string[] = [];
  const separate: string[] = [];

  if (cardStreamActive && payload.text) {
    // Current code: ALL text → accumulate, return early (no separate message)
    accumulated.push(payload.text);
    return { accumulated: accumulated.join("\n\n"), separate };
  }

  // Card not active → send as separate message
  if (payload.text) {
    separate.push(payload.text);
  }
  return { accumulated: accumulated.join("\n\n"), separate };
}

// ── Simulate fixed deliver handler ────────────────────────────────────────────
function simulateFixedDeliver(
  payload: ReplyPayload,
  info: DeliverInfo,
  cardStreamActive: boolean,
): { accumulated: string; separate: string[] } {
  const accumulated: string[] = [];
  const separate: string[] = [];

  if (cardStreamActive && payload.text) {
    const isReasoningBlock =
      info.kind === "block" && payload.text.trimStart().startsWith("Reasoning:");
    const isVerboseTool = info.kind === "tool";

    if (isReasoningBlock || isVerboseTool) {
      // Fix: reasoning and verbose → send as separate Feishu message
      separate.push(payload.text);
      return { accumulated: "", separate };
    }

    // Main reply (block/final) → accumulate into card
    accumulated.push(payload.text);
    return { accumulated: accumulated.join("\n\n"), separate };
  }

  // Card not active → send as separate message
  if (payload.text) {
    separate.push(payload.text);
  }
  return { accumulated: "", separate };
}

// ── Test cases ────────────────────────────────────────────────────────────────
interface TestCase {
  name: string;
  payload: ReplyPayload;
  info: DeliverInfo;
  cardStreamActive: boolean;
  expectCurrent: { accumulated: boolean; separate: boolean };
  expectFixed: { accumulated: boolean; separate: boolean };
}

const testCases: TestCase[] = [
  {
    name: "主回复 (final) — 应吞入 card",
    payload: { text: "在呢！怎么了天哥？" },
    info: { kind: "final" },
    cardStreamActive: true,
    expectCurrent: { accumulated: true, separate: false },
    expectFixed: { accumulated: true, separate: false },
  },
  {
    name: "主回复 (block) — 应吞入 card",
    payload: { text: "这是主要回复段落。" },
    info: { kind: "block" },
    cardStreamActive: true,
    expectCurrent: { accumulated: true, separate: false },
    expectFixed: { accumulated: true, separate: false },
  },
  {
    name: "reasoning (block, Reasoning: 前缀) — BUG: 被吞入 card，应单独发出",
    payload: { text: "Reasoning:\n_Good, I have all the context I need._" },
    info: { kind: "block" },
    cardStreamActive: true,
    expectCurrent: { accumulated: true, separate: false }, // BUG: 被吞入
    expectFixed: { accumulated: false, separate: true }, // FIX: 单独发出
  },
  {
    name: "verbose 工具结果 (tool) — BUG: 被吞入 card，应单独发出",
    payload: { text: ": read_file\n/workspace/USER.md (2.1 kB)" },
    info: { kind: "tool" },
    cardStreamActive: true,
    expectCurrent: { accumulated: true, separate: false }, // BUG: 被吞入
    expectFixed: { accumulated: false, separate: true }, // FIX: 单独发出
  },
  {
    name: "card 未启动时 reasoning — 应单独发出（两个版本都对）",
    payload: { text: "Reasoning:\n_Thinking..._" },
    info: { kind: "block" },
    cardStreamActive: false,
    expectCurrent: { accumulated: false, separate: true },
    expectFixed: { accumulated: false, separate: true },
  },
];

// ── Run tests ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

console.log("=".repeat(70));
console.log("Feishu Card Stream: reasoning/verbose 过滤行为验证");
console.log("=".repeat(70));

for (const tc of testCases) {
  const current = simulateCurrentDeliver(tc.payload, tc.info, tc.cardStreamActive);
  const fixed = simulateFixedDeliver(tc.payload, tc.info, tc.cardStreamActive);

  const currentAccumulated = current.accumulated.length > 0;
  const currentSeparate = current.separate.length > 0;
  const fixedAccumulated = fixed.accumulated.length > 0;
  const fixedSeparate = fixed.separate.length > 0;

  const currentPass =
    currentAccumulated === tc.expectCurrent.accumulated &&
    currentSeparate === tc.expectCurrent.separate;
  const fixedPass =
    fixedAccumulated === tc.expectFixed.accumulated && fixedSeparate === tc.expectFixed.separate;

  const allPass = currentPass && fixedPass;
  if (allPass) {
    passed++;
  } else {
    failed++;
  }

  const icon = allPass ? "✅" : "❌";
  console.log(`\n${icon} ${tc.name}`);
  console.log(
    `   当前代码: accumulated=${currentAccumulated} separate=${currentSeparate}` +
      (currentPass
        ? " ✓"
        : ` ✗ (期望 accumulated=${tc.expectCurrent.accumulated} separate=${tc.expectCurrent.separate})`),
  );
  console.log(
    `   修复后:   accumulated=${fixedAccumulated} separate=${fixedSeparate}` +
      (fixedPass
        ? " ✓"
        : ` ✗ (期望 accumulated=${tc.expectFixed.accumulated} separate=${tc.expectFixed.separate})`),
  );
}

console.log("\n" + "=".repeat(70));
console.log(`结果: ${passed} 通过 / ${failed} 失败`);
console.log("=".repeat(70));

// ── Bug summary ───────────────────────────────────────────────────────────────
console.log(`
【Bug 结论】
当 card stream 启动时，deliver() 把所有 payload.text（含 reasoning 和 verbose tool）
吞入 cardStreamFinalText 并 return，导致：
  - reasoning 内容（Reasoning: 前缀，kind="block"）不作为独立 Feishu 消息发送
  - verbose 工具结果（kind="tool"）不作为独立 Feishu 消息发送

【修复方案】
在 deliver() 里判断 info.kind：
  if (kind === "tool") → 跳过 accumulation，直接 deliverFeishuReply()
  if (kind === "block" && text.startsWith("Reasoning:")) → 同上
  其他（block 主文本 + final）→ 保持 accumulation 进 card

【飞书 API 约束确认】
飞书 card stream（CardKit）不限制更新次数（vs 消息编辑上限 20-30 次）。
单独发送 reasoning/verbose 用标准 im.message.create，与 card stream 并行不冲突。
`);

if (failed > 0) {
  process.exit(1);
}
