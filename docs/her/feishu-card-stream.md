# 飞书 Card Stream 机制与已知问题

## 架构

飞书 Her 对每条非命令消息使用 **CardKit 流式卡片**（typewriter 打字机效果）：

```
用户发消息
  → onReplyStart: async createFeishuCardStream() → 创建卡片实体，开始 streaming_mode
  → onPartialReply: updateCardStream(text) → 每次 AI 生成部分文本，更新卡片
  → deliver(payload, info):
      - kind="block"/"final" 主文本 → 吞入 cardStreamFinalText（不重复发消息）
      - kind="tool" verbose 工具结果 → (见 bug fix)
      - kind="block" Reasoning 前缀 → (见 bug fix)
  → stopCardStream(): 发送最终卡片内容（含 footer），关闭 streaming_mode
```

## 飞书 API 约束

| 方式                           | 次数限制                  | 适用场景        |
| ------------------------------ | ------------------------- | --------------- |
| 消息编辑（PATCH messages/:id） | ~20-30 次（超限静默失败） | 少量更新        |
| CardKit 卡片实体更新           | **无明确上限**            | 高频流式输出 ✅ |

## Bug：reasoning 和 verbose 消息被过滤

### 根因

`deliver()` 回调在 card stream 启动后，对 **所有** `payload.text` 做 early return（吞入 card 不发独立消息），不区分 `info.kind`：

```ts
// 原代码（有 bug）
if (cardStream?.started && payload.text) {
  cardStreamFinalText += payload.text;
  return; // ← 不区分 kind，reasoning 和 verbose 都被吞
}
```

`ReplyDispatchKind` 只有 3 种值：

| kind                          | 内容             | 修复前行为   | 修复后行为            |
| ----------------------------- | ---------------- | ------------ | --------------------- |
| `"final"`                     | 主回复文本       | 吞入 card ✅ | 吞入 card ✅          |
| `"block"` (非 Reasoning)      | 段落文本         | 吞入 card ✅ | 吞入 card ✅          |
| `"block"` (`Reasoning:` 前缀) | 思考过程         | 吞入 card ❌ | 单独发 Feishu 消息 ✅ |
| `"tool"`                      | verbose 工具结果 | 吞入 card ❌ | 单独发 Feishu 消息 ✅ |

### 时序竞争（race condition）

`createFeishuCardStream()` 是异步的（需要飞书 API 返回）。  
偶尔 reasoning 的 `deliver()` 在 `cardStream.started = true` 之前到达 → 走正常投递路径 → 显示。  
这解释了为什么 reasoning 「偶尔出现一次，其余时候消失」。

### 修复（`extensions/feishu-her/src/gateway.ts`）

```ts
// 修复后
if (cardStream?.started && payload.text) {
  const isReasoningBlock =
    info.kind === "block" && payload.text.trimStart().startsWith("Reasoning:");
  const isVerboseTool = info.kind === "tool";

  if (isReasoningBlock || isVerboseTool) {
    // 绕开 accumulation，单独发 Feishu 消息
    await deliverFeishuReply({ payload, account, chatId, isGroup, ... });
    return;
  }

  // 主文本 → 继续吞入 card（card 流式已经展示过了）
  cardStreamFinalText += payload.text;
  return;
}
```

### 验证脚本

`scripts/feishu-voice-e2e.ts` — 纯逻辑模拟，覆盖 5 个 case，运行：

```bash
npx tsx scripts/feishu-voice-e2e.ts
```

## 使用 reasoning 和 verbose

```
/reasoning:on      开启思考过程可见（每次回复前发独立气泡）
/reasoning:off     关闭
/verbose:on        开启工具调用摘要（每个工具调用发独立气泡）
/verbose:full      开启工具调用 + 结果（更详细）
/verbose:off       关闭
```

## Card Stream 性能基准（实测数据）

测试环境：Mac → 飞书 API（2026-02-18）

| 操作                              | 平均耗时 | 说明                |
| --------------------------------- | -------- | ------------------- |
| `im.message.create` (一次性文本)  | ~824ms   | 基线：不用卡片      |
| `cardkit.card.create`             | ~225ms   | 创建卡片实体        |
| `im.message.create` (卡片)        | ~423ms   | 发送卡片消息        |
| `cardElement.content` (单次更新)  | ~241ms   | 流式更新正文        |
| `cardElement.content` (sendFinal) | ~284ms   | 最终文本推送        |
| `card.settings` (finalize)        | ~358ms   | 关闭 streaming_mode |

### 固定开销分析

```
启动开销 = card.create(225) + message.create(423) = ~648ms
结束开销 = sendFinal(284) + finalize(358)        = ~642ms
───────────────────────────────────────────────────
总固定开销                                         ≈ 1,290ms
```

### 实际时间线对比（假设 AI 生成 10s）

| 模式            | 用户首次看到内容 | 用户看到完整回复 | 感受               |
| --------------- | ---------------- | ---------------- | ------------------ |
| **一次性发送**  | ~10.8s           | ~10.8s           | 等 10s 瞬间出现    |
| **Card Stream** | ~0.9s            | ~11.3s           | 立即看到，逐字显示 |

Card Stream 首字节快 ~10s，但总完成时间慢 ~0.5s。

### 已知瓶颈

1. **启动阻塞**：`onReplyStart` 中 `await startCardStream()` 阻塞 AI 启动 ~648ms
2. **结束串行**：`sendFinal` → `finalize` 串行执行 ~642ms（卡片冻结可感知）
3. **throttle 300ms**：默认 `DEFAULT_STREAM_THROTTLE_MS = 300`，API 调用 ~241ms 刚好卡在窗口内

### Reasoning 时序问题

当前 `blockReplyBreak` 默认为 `"text_end"`，导致 reasoning 在主文本之后才发出。
`blockReplyBreak` 由 `agentCfg.blockStreamingBreak` 控制（不在 plugin `replyOptions` 中）。
设置 `agents.defaults.blockStreamingBreak: "message_end"` 可让 reasoning 先于主文本发出。

验证脚本: `scripts/feishu-card-stream-perf.ts`
