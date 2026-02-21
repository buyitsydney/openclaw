# OpenClaw Context Compact 架构设计文档

> 日期: 2026-02-21
> 作者: AI 架构分析
> 版本: OpenClaw dev branch + `@mariozechner/pi-coding-agent@0.52.x`
> 相关文档: [context-window-architecture.md](context-window-architecture.md) (上下文窗口管理架构)

---

## 1. 引用来源

### 1.1 OpenClaw 源码

| 文件                                                                            | 说明                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/agents/compaction.ts`                                                      | 核心压缩工具函数: 分阶段总结、自适应分块、历史修剪 |
| `src/agents/pi-extensions/compaction-safeguard.ts`                              | safeguard 模式扩展 (390 行)                        |
| `src/agents/pi-embedded-runner/compact.ts`                                      | compact 入口和队列化执行 (741 行)                  |
| `src/agents/pi-embedded-runner/run.ts`                                          | agent 主循环，含 overflow recovery                 |
| `src/agents/pi-embedded-runner/run/attempt.ts`                                  | 单次 attempt, `createAgentSession()` 调用点        |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts`                       | 工具结果截断 (329 行)                              |
| `src/agents/pi-embedded-runner/history.ts`                                      | 历史限制逻辑                                       |
| `src/agents/context-window-guard.ts`                                            | 上下文窗口守卫 (warn/block)                        |
| `src/agents/pi-settings.ts`                                                     | compact 保留 token 配置                            |
| `src/config/defaults.ts`                                                        | `applyCompactionDefaults()`                        |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js` | SDK 底层 compact 实现                              |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/utils.js`      | SDK 摘要 prompt 和工具函数                         |
| `node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js`         | SDK `AgentSession.compact()`                       |

### 1.2 OpenClaw 官方文档

- [Compaction - OpenClaw Docs](https://docs.openclaw.ai/concepts/compaction) -- compaction 概念文档
- [Context - OpenClaw Docs](https://docs.openclaw.ai/concepts/context) -- 上下文管理概念
- [Session Pruning - OpenClaw Docs](https://docs.openclaw.ai/concepts/session-pruning) -- session 内存裁剪

### 1.3 OpenClaw GitHub Issues

- [#7477: Default compaction mode (safeguard) silently fails on large contexts](https://github.com/openclaw/openclaw/issues/7477) -- safeguard 默认模式 bug
- [#3436: Safeguard compaction mode fails to generate summary at 186k tokens](https://github.com/openclaw/openclaw/issues/3436) -- 186K token 摘要失败
- [#15006: Auto-compaction triggers prematurely due to cache tokens counted as context usage](https://github.com/openclaw/openclaw/issues/15006) -- cache token 误计

### 1.4 Claude Code / Anthropic

- [Inside Claude Code's Compaction System (Decode Claude)](https://decodeclaude.com/compaction-deep-dive/) -- 三层压缩架构详解
- [Automatic Context Compaction (Anthropic Platform Cookbook)](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction) -- SDK 级别的 compaction 指南
- [#6549: Better compaction is possible (anthropics/claude-code)](https://github.com/anthropics/claude-code/issues/6549) -- 社区改进建议

### 1.5 Cursor

- [Dynamic Context Discovery (Cursor Blog)](https://cursor.com/blog/dynamic-context-discovery) -- Cursor 动态上下文发现技术博客
- [Compact (Cursor Docs)](https://docs.cursor.com/en/agent/chat/compact) -- Cursor compact 官方文档
- [Automatic context summarization (Cursor Forum)](https://forum.cursor.com/t/automatic-context-summarization/128928) -- 社区讨论
- [Manually activating context summarization (Cursor Forum)](https://forum.cursor.com/t/manually-activating-context-summarization/131707) -- 手动 summarize 功能讨论

### 1.6 学术/行业研究

- **JetBrains Research** -- "The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management" (NeurIPS 2025 Deep Learning for Code Workshop)
  - [Blog: Cutting Through the Noise](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
  - [Paper: arXiv 2508.21433](https://arxiv.org/abs/2508.21433)
  - [GitHub: JetBrains-Research/the-complexity-trap](https://github.com/JetBrains-Research/the-complexity-trap)
- **ACON** -- "Optimizing Context Compression for Long-horizon LLM Agents" (arXiv 2510.00615)
  - [Paper: arXiv 2510.00615](https://arxiv.org/abs/2510.00615)
- **Google ADK** -- Agent Development Kit 的 compaction 实现
  - [Docs: Context Compression](https://google.github.io/adk-docs/context/compaction/)

---

## 2. 系统概述

### 2.1 Compact 是什么

Compact (Compaction) 是 OpenClaw 的上下文压缩机制。当对话历史接近或超过模型的 context window 上限时，系统将较旧的对话内容**总结为一段结构化摘要**，仅保留最近的消息，从而在有限的 token 预算内延续长时间的对话。

与简单截断不同，compaction 是**有损压缩**：通过 LLM 生成摘要来保留语义信息，而非机械地丢弃旧消息。

### 2.2 Compact 在整体架构中的位置

OpenClaw 的上下文管理是一个多层防线系统，compact 是其中的核心：

```
用户消息
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│ Layer 0: Tool Result Truncation (即时)                   │
│   单个工具结果 > context 的 30% → 截断到安全长度          │
│   硬上限: 400K chars (~100K tokens)                      │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ Layer 1: Session Pruning (每次请求, in-memory)           │
│   cache-ttl 模式: 超时的 tool results → soft-trim/clear  │
│   不修改 JSONL, 仅在 API 调用时裁剪                      │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ Layer 2: History Turn Limiting (每次 attempt)            │
│   限制到最近 N 轮 (DMHistoryLimit)                       │
│   修剪后修复 tool_use/tool_result 配对                   │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ Layer 3: Auto-Compaction ★ (核心)                        │
│   当 contextTokens > contextWindow - reserveTokens       │
│   → LLM 摘要 + 保留最近 keepRecentTokens 消息           │
│   → 摘要持久化到 JSONL                                   │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ Layer 4: Overflow Recovery (被动)                        │
│   LLM 返回 context overflow 错误                        │
│   → 强制 compact → 截断工具结果 → 重试                  │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 双层架构

OpenClaw 的 compact 系统跨越两个架构层，各自职责不同：

```
┌───────────────────────────────────────────────────────────┐
│                    OpenClaw Layer                          │
│                                                           │
│  控制 "HOW" — 如何执行 compact                            │
│                                                           │
│  - compactEmbeddedPiSession()     入口 + 队列化           │
│  - Compaction Safeguard Extension  增强摘要策略           │
│  - Context Window Guard            warn/block 守卫        │
│  - Memory Flush                    compact 前写入持久记忆  │
│  - Tool Result Truncation          截断过大工具输出        │
│  - History Turn Limiting           限制历史轮次            │
│  - before_compaction / after_compaction hooks             │
└─────────────────────────┬─────────────────────────────────┘
                          │ session.compact(customInstructions)
                          ▼
┌───────────────────────────────────────────────────────────┐
│              pi-coding-agent SDK Layer (upstream)          │
│                                                           │
│  控制 "WHEN" + "WHAT" — 何时触发 + 基础摘要逻辑          │
│                                                           │
│  - shouldCompact()                触发判断                │
│  - prepareCompaction()            确定切割点 + 分离消息   │
│  - compact()                      调用 LLM 生成摘要      │
│  - generateSummary()              发送摘要 prompt         │
│  - estimateTokens()               token 估算 (chars/4)   │
│  - 存储 compaction entry 到 JSONL                        │
└───────────────────────────────────────────────────────────┘
```

**关键架构约束**: OpenClaw 通过 `createAgentSession({ model })` 将 model 对象传给 SDK。SDK 使用 `model.contextWindow` 决定何时触发 auto-compaction，这个值来自 pi-ai 模型目录，不受 OpenClaw 层 `agents.defaults.contextTokens` 的影响。详见 [context-window-architecture.md](context-window-architecture.md) 第 3-4 节关于架构断层的分析。

---

## 4. Compact 原理详解

### 4.1 触发条件

Compact 有三种触发路径：

| 触发类型             | 触发点                         | 条件                                            | 代码位置                                     |
| -------------------- | ------------------------------ | ----------------------------------------------- | -------------------------------------------- |
| **Auto (Threshold)** | 每次 agent turn 完成后         | `contextTokens > contextWindow - reserveTokens` | SDK `_checkCompaction()`                     |
| **Auto (Overflow)**  | LLM 返回 context overflow 错误 | `isContextOverflow(error)`                      | SDK `_checkCompaction()` + OpenClaw `run.ts` |
| **Manual**           | 用户发送 `/compact` 命令       | 无条件                                          | OpenClaw `handleCompactCommand()`            |

Auto (Threshold) 的触发公式：

```
contextTokens = calculateContextTokens(assistantMessage.usage)
                // 使用 API 返回的实际 usage 数据

threshold = model.contextWindow - settings.reserveTokens
            // 默认: 200,000 - 20,000 = 180,000

trigger = contextTokens > threshold
```

### 4.2 输入参数

Compact 入口函数 `compactEmbeddedPiSession()` 接收以下参数：

```typescript
type CompactEmbeddedPiSessionParams = {
  // 会话标识
  sessionId: string;
  sessionKey?: string;
  sessionFile: string; // JSONL 会话文件路径

  // 执行环境
  workspaceDir: string; // 工作区目录
  config?: OpenClawConfig; // 运行时配置
  provider?: string; // 模型提供商 (默认 "anthropic")
  model?: string; // 模型 ID (默认 "claude-sonnet-4-5-20250514")

  // Compact 控制
  trigger?: "overflow" | "manual";
  customInstructions?: string; // /compact 附加的用户指令
  thinkLevel?: ThinkLevel; // 推理等级
  skillsSnapshot?: SkillSnapshot;

  // 内部参数
  diagId?: string; // 诊断追踪 ID
  attempt?: number; // 当前重试次数
  maxAttempts?: number; // 最大重试次数
  lane?: string; // 队列 lane
  enqueue?: typeof enqueueCommand;
};
```

### 4.3 执行流程

完整的 compact 执行流程分为 6 个阶段：

```
阶段 1: 准备
├── 解析 model + 获取 API key
├── 解析 workspace, sandbox, skills
├── 构建 system prompt + tools
├── 获取 session write lock
├── 修复 session 文件 (如损坏)
├── 创建 AgentSession
└── 确保 reserveTokens >= floor (20K)

阶段 2: 历史处理
├── sanitizeSessionHistory()        // 清理非法消息
├── validateGeminiTurns()           // Gemini 格式校验
├── validateAnthropicTurns()        // Anthropic 格式校验
├── limitHistoryTurns()             // 限制到最近 N 轮
└── sanitizeToolUseResultPairing()  // 修复 tool_use/result 配对

阶段 3: Hooks
└── before_compaction hooks (fire-and-forget)
    └── 插件异步处理, 不阻塞 compact

阶段 4: SDK Compact
├── session.compact(customInstructions)
│   ├── prepareCompaction()
│   │   ├── 查找上次 compaction 边界
│   │   ├── 计算当前 contextTokens
│   │   ├── 确定切割点 (keepRecentTokens)
│   │   ├── 分离: messagesToSummarize vs keptMessages
│   │   └── 提取文件操作 (read/modified)
│   │
│   ├── [如果启用 safeguard mode]
│   │   └── session_before_compact event → Safeguard Extension
│   │       ├── 读取 AGENTS.md 关键上下文
│   │       ├── 收集 tool failures
│   │       ├── 检查新内容是否超出历史预算
│   │       ├── 必要时 pruneHistoryForContextShare()
│   │       └── summarizeInStages() → 分阶段摘要
│   │
│   ├── [如果是 default mode]
│   │   └── generateSummary() → 单次 LLM 调用生成摘要
│   │
│   ├── [如果是 split turn]
│   │   └── 额外生成 turn prefix 摘要
│   │
│   └── 将 compaction entry 追加到 JSONL
│       {type: "compaction", summary, firstKeptEntryId, tokensBefore}

阶段 5: 后处理
├── 估算 compact 后 token 数
├── after_compaction hooks (fire-and-forget)
└── flushPendingToolResultsAfterIdle()

阶段 6: 返回结果
└── EmbeddedPiCompactResult
```

### 4.4 输出结果

```typescript
type EmbeddedPiCompactResult = {
  ok: boolean; // 操作是否成功
  compacted: boolean; // 是否实际执行了压缩
  reason?: string; // 失败原因 (如 "below threshold", "timeout")
  result?: {
    summary: string; // LLM 生成的摘要文本
    firstKeptEntryId: string; // 第一个保留的消息 ID
    tokensBefore: number; // 压缩前 token 数
    tokensAfter?: number; // 压缩后 token 数 (估算)
    details?: {
      readFiles: string[]; // 读取过的文件列表
      modifiedFiles: string[]; // 修改过的文件列表
    };
  };
};
```

### 4.5 摘要 Prompt

SDK 层使用结构化 prompt 生成摘要，有三种 prompt 模板：

**初始摘要 Prompt (INITIAL_SUMMARIZATION_PROMPT):**

要求 LLM 输出以下结构化格式：

```
## Goal
[用户的目标]

## Constraints & Preferences
- [约束和偏好]

## Progress
### Done
- [x] [已完成任务]
### In Progress
- [ ] [进行中任务]
### Blocked
- [阻塞项]

## Key Decisions
- **[决策]**: [理由]

## Next Steps
1. [下一步行动]

## Critical Context
- [需要保留的关键信息]
```

**更新摘要 Prompt (UPDATE_SUMMARIZATION_PROMPT):**

用于迭代更新已有摘要，要求：

- 保留现有摘要中的所有信息
- 将新消息中的进展更新到 Progress 中
- 更新 Next Steps

**Turn Prefix 摘要 Prompt:**

当切割点落在一个 turn 中间时，需要为 turn 前半部分生成一个简短摘要：

```
## Original Request
[用户在这个 turn 中要求什么]

## Early Progress
[在 prefix 中做了什么]

## Context for Suffix
[理解保留的后半部分需要什么信息]
```

**System Prompt:**

```
You are a context summarization assistant. Your task is to read a conversation
between a user and an AI coding assistant, then produce a structured summary
following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the
conversation. ONLY output the structured summary.
```

### 4.6 Token 计算和预算分配

**Token 估算方法:**

SDK 使用简单的 `chars / 4` 启发式：

```javascript
function estimateTokens(message) {
  let chars = 0;
  // user: 文本内容长度
  // assistant: text + thinking + toolCall 参数
  // toolResult: 文本内容 + 每张图片约 4800 chars
  return Math.ceil(chars / 4);
}
```

这是保守估计（通常高估），用于切割点决策而非精确计费。

**Token 预算分配:**

```
contextWindow (e.g. 200,000)
├── reserveTokens (20,000)           → 摘要操作自身使用
│   ├── 历史摘要: 80% = 16,000      → maxTokens for summary LLM call
│   └── Turn prefix 摘要: 50% = 10,000
├── keepRecentTokens (20,000)        → 保留最近消息
└── 可总结区域 (160,000)             → messagesToSummarize
```

Safeguard 模式额外增加了 `maxHistoryShare` (默认 0.5) 约束：历史消息最多占 context 的 50%。超出时先 prune 再总结。

### 4.7 切割点算法

SDK 的切割点选择逻辑：

1. 从最新消息向后遍历，累加 token 估算
2. 当累计达到 `keepRecentTokens` 时停止
3. 选择最近的合法切割点

**合法切割类型:**

- user, assistant, custom, bashExecution, branchSummary, compactionSummary

**不合法切割类型 (不可拆):**

- toolResult (必须跟随其 tool_use)

如果切割点落在一个 turn 中间，标记 `isSplitTurn = true`，需要额外生成 turn prefix 摘要。

### 4.8 Safeguard 扩展的增强逻辑

Safeguard 模式通过 `session_before_compact` hook 拦截 SDK 的默认压缩，提供以下增强：

1. **自适应分块**: 根据平均消息大小动态调整 chunk ratio (0.15 - 0.4)

   ```
   avgRatio = (avgTokensPerMessage * 1.2) / contextWindow
   if avgRatio > 10%:
     chunkRatio = max(0.15, 0.4 - avgRatio * 2)
   ```

2. **超大消息处理**: 单条消息 > context 50% 时跳过该消息，只记录 note

3. **分阶段总结 (summarizeInStages)**:
   - 将消息按 token 等分为 N 份 (默认 2)
   - 分别总结每份
   - 最后合并所有部分摘要

4. **历史修剪 (pruneHistoryForContextShare)**:
   - 当新内容 > maxHistoryShare 比例时，先丢弃最旧的 chunk
   - 对丢弃的 chunk 单独生成摘要，作为 previousSummary 传入

5. **附加信息**:
   - 工具失败记录 (最多 8 条)
   - 文件操作列表 (`<read-files>`, `<modified-files>`)
   - 工作区关键规则 (AGENTS.md 中的 "Session Startup" + "Red Lines"，限 2000 chars)

6. **渐进式 Fallback**:
   ```
   全量总结 → 部分总结(跳过超大消息) → 纯文本 note("Summary unavailable")
   ```

### 4.9 摘要的存储和使用

**存储**: 摘要作为 `compaction` 类型的 entry 追加到 session JSONL 文件：

```json
{
  "type": "compaction",
  "summary": "## Goal\n...",
  "firstKeptEntryId": "msg-abc123",
  "tokensBefore": 180000,
  "details": {
    "readFiles": ["src/foo.ts"],
    "modifiedFiles": ["src/bar.ts"]
  }
}
```

**使用**: 后续对话中，SDK 将摘要转为 `compactionSummary` 类型的消息插入消息历史开头。下次 compact 时，已有摘要作为 `previousSummary` 传入更新 prompt，实现**迭代式摘要更新**。

---

## 5. 两种 Compaction 模式

| 维度         | Default 模式                 | Safeguard 模式                                             |
| ------------ | ---------------------------- | ---------------------------------------------------------- |
| 摘要策略     | SDK 默认: 单次 LLM 调用      | 多阶段分块总结 + 合并                                      |
| 超大消息     | 直接发送 (可能失败)          | 跳过超大消息, 记录 note                                    |
| 历史修剪     | 无                           | maxHistoryShare (50%) 预算控制                             |
| 文件追踪     | SDK 级别提取                 | 额外格式化 `<read-files>/<modified-files>`                 |
| 工具失败     | 不追踪                       | 收集并附加到摘要                                           |
| 工作区上下文 | 不读取                       | 读取 AGENTS.md 关键章节                                    |
| Fallback     | 无 (失败即失败)              | 三级渐进 fallback                                          |
| 已知问题     | 无重大问题                   | #7477: 大 context 下 `ctx.model` 为 undefined 导致静默失败 |
| 配置 key     | `compaction.mode: "default"` | `compaction.mode: "safeguard"`                             |
| 默认         | 否 (代码默认是 safeguard)    | 是 (`applyCompactionDefaults`)                             |

---

## 6. 辅助机制

### 6.1 Session Pruning

Session pruning 在每次 LLM API 调用前裁剪内存中的 tool results，不修改磁盘上的 JSONL。

- **模式**: `cache-ttl` (仅当上次 Anthropic 调用超过 TTL 才裁剪)
- **策略**: soft-trim (截短) + hard-clear (完全移除)
- **保护**: 最近 3 条 assistant 消息、含图片的 results 不裁剪
- **配置**: `agents.defaults.sessionPruning.mode`

### 6.2 Tool Result Truncation

在 compact 之外独立运行，防止单个工具结果占满 context：

- 单个 tool result 不超过 context 的 30% (`MAX_TOOL_RESULT_CONTEXT_SHARE`)
- 硬上限 400K chars (`HARD_MAX_TOOL_RESULT_CHARS`)
- 截断时保留头部内容 + 添加警告后缀
- 作为 compact 失败后的最后防线（overflow recovery 中使用）

### 6.3 Context Window Guard

在 agent 启动时检查 context window 大小：

- **Warning**: contextWindow < 32,000 tokens → 日志警告
- **Block**: contextWindow < 16,000 tokens → 拒绝启动

### 6.4 Memory Flush

Compact 前的可选步骤：在上下文接近满时，先运行一个静默的 memory flush turn，将重要信息写入持久记忆（disk），然后再执行 compact。

### 6.5 History Turn Limiting

每次 attempt 前限制历史到最近 N 轮用户对话，主要用于 DM 场景下的历史控制：

```typescript
limitHistoryTurns(messages, getDmHistoryLimitFromSessionKey(sessionKey, config));
```

---

## 7. 优点分析

### 7.1 架构优点

1. **持久化摘要**: 摘要写入 JSONL 文件，跨 session 保留。即使 gateway 重启，摘要不丢失。

2. **结构化摘要格式**: SDK 使用标准化的 Goal/Progress/Decisions/Next Steps 格式，保留了任务连续性所需的关键信息维度。

3. **迭代式摘要更新**: 已有摘要作为 `previousSummary` 传入，不需要每次从头压缩全部历史，节省 token 开销。

4. **多层防线**: Tool result truncation → Session pruning → History limiting → Auto-compaction → Overflow recovery, 五道防线逐层递进。

5. **Hook 扩展机制**: `before_compaction` / `after_compaction` hooks 和 `session_before_compact` event 让插件可以自定义压缩行为。

6. **队列化执行**: 通过 session lane + global lane 避免死锁和并发冲突。

7. **文件操作追踪**: 记录 read/modified 文件列表，帮助 LLM 在 compact 后重建工作上下文。

8. **安全保护**: `stripToolResultDetails()` 确保敏感的 tool result details 不进入摘要 prompt; 300s 超时防止 compact 无限阻塞。

### 7.2 Safeguard 模式优点

9. **自适应分块**: 根据消息大小动态调整 chunk 比例，处理大小不均的消息序列。

10. **渐进式 Fallback**: 三级降级保证 compact 永不完全失败（最差情况给出文本 note）。

11. **工作区上下文保留**: 将 AGENTS.md 中的关键规则注入摘要，避免 compact 后"忘记"项目规则。

---

## 8. 缺点分析

### 8.1 架构缺陷

1. **双层架构断层 (Critical)**

   OpenClaw 的 `agents.defaults.contextTokens` 不传递到 SDK 的 compaction 触发逻辑。SDK 使用 `model.contextWindow`（来自模型目录）判断何时 compact，两者独立，导致用户配置了 contextTokens 但 compact 在预期阈值不触发。

   详见 [context-window-architecture.md](context-window-architecture.md) 第 3-4 节。

2. **Token 估算不精确**

   `chars / 4` 是粗略估计，对于中文内容、code blocks、特殊 token 等场景偏差可能很大。#15006 报告了 cache tokens 被计入上下文使用量导致过早触发 compact。

3. **无 Microcompaction 层**

   没有类似 Claude Code 的"冷存储 + 热尾"机制。所有 tool results 始终保留在 context 中直到被 compact 或 prune，导致大型工具输出长时间占用 context 空间。

4. **Compact 期间工具链不受保护**

   Auto-compaction 只在 `agent_end` (一个完整 turn 结束后) 触发。工具链执行期间 token 数可以无限增长。实测 (14.3 节) 显示 4 轮工具调用可以从 35K 涨到 64K，远超 40K 上限。

5. **无自动后压缩恢复 (Post-Compaction Restoration)**

   Compact 后不会自动重新读取最近的工作文件或恢复任务状态。Claude Code 在 compact 后会自动 re-read 最近 5 个文件 + 恢复 todo list + 注入 continuation message，OpenClaw 没有这个机制。

   注意: OpenClaw 通过 `sessions_history` 工具提供了**手动恢复**能力——agent 可以主动查询原始历史（JSONL 保留所有消息），但这依赖 LLM 主动调用工具，不如 Cursor/Claude Code 的自动恢复可靠。此外 `sessions_history` 有 80KB 大小限制。

### 8.2 Safeguard 模式缺陷

6. **静默失败 (#7477, #3436)**

   `ctx.model` 在 `session_before_compact` 事件中可能为 undefined，导致 safeguard 降级到 FALLBACK_SUMMARY（纯文本 note），用户无感知地丢失了上下文。

7. **摘要质量依赖模型能力**

   非 Claude 模型（如 minimax, GLM）可能无法正确处理 SDK 的 `<conversation>` 标签格式，导致生成空摘要或错误摘要。没有针对不同模型的 prompt 适配。

### 8.3 功能缺失

8. **无选择性 Compact**

   只能压缩整段历史，不能针对特定的大块内容（如某个巨大的 tool output）进行局部压缩。Claude Code #6549 提出的 `/shrink` 概念在 OpenClaw 中没有实现。

9. **无 Compact 质量评估**

   缺少对摘要质量的评估机制。无法判断一次 compact 是否保留了足够的关键信息，也没有用户反馈通道来改进摘要策略。

10. **配置向导缺失**

    Setup wizard 中没有 compaction 配置项。用户必须手动编辑 JSON 配置文件，增加了误配置的风险。

---

## 9. Cursor Compact 设计

### 9.1 核心理念: 动态上下文发现

Cursor 在 2025 年提出了"**Dynamic Context Discovery**"理念——提供尽量少的静态上下文，让 agent 按需动态拉取所需信息。

需要指出的是，OpenClaw (基于 pi-coding-agent SDK) 在多个维度上**已经采用了类似的动态发现策略**，两者并非截然对立。下面逐条分析 Cursor 博客中的五大策略，并与 OpenClaw 的实现做具体比较。

### 9.2 Cursor 的五大策略与 OpenClaw 对比

**策略 1: 长工具输出转为文件**

Cursor: 当 shell 命令或 MCP 调用返回大量内容时，不截断，而是写入文件，给 agent 提供文件路径和 `tail` 能力。

OpenClaw: 采用**截断策略** — 超过 context 30% 的工具结果会被截断到安全长度（硬上限 400K chars），保留头部并附加提示信息，告知 agent 可以用 `offset/limit` 参数分段读取原始内容。

```typescript
// src/agents/pi-embedded-runner/tool-result-truncation.ts:31-34
const TRUNCATION_SUFFIX =
  "\n\n⚠️ [Content truncated — original was too large for the model's context window. " +
  "The content above is a partial view. If you need more, request specific sections or use " +
  "offset/limit parameters to read smaller chunks.]";
```

**差异**: Cursor 完全不截断（写文件），OpenClaw 截断但提示可分段重读。Cursor 方案避免了信息丢失，OpenClaw 方案更简单但可能需要额外的重读调用。

**策略 2: 历史文件引用 (Chat History as Files)**

Cursor: 触发 summarization 时，将完整对话历史保存为文件。摘要完成后，agent 可搜索/读取原始历史来恢复细节。

OpenClaw: 采用**类似但不同的机制** — compact 后，原始对话历史**保留在 JSONL 文件中**（compact 只追加摘要 entry，不删除原始消息）。Agent 可通过 `sessions_history` 工具读取完整历史:

```typescript
// src/agents/tools/sessions-history-tool.ts
// 调用 Gateway chat.history → readSessionMessages() → 读取完整 JSONL
const result = await callGateway<{ messages: Array<unknown> }>({
  method: "chat.history",
  params: { sessionKey: resolvedKey, limit },
});
```

限制: `sessions_history` 有 80KB 硬上限 (`SESSIONS_HISTORY_MAX_BYTES`)，单条消息文本限 4000 字符，默认最多 200 条消息（硬上限 1000 条）。

此外，如果启用了 `memory.qmd.sessions.enabled`，OpenClaw 的语义搜索系统还能索引 session JSONL 进行向量搜索（实验性功能）。

**差异**: 两者都保留原始历史并提供恢复能力。Cursor 的方案更显式（保存为独立的可引用文件），OpenClaw 依赖已有的 JSONL + `sessions_history` 工具组合，但有大小限制。

**策略 3: Agent Skills 动态加载**

Cursor: Skill 描述以 name + description 形式作为静态上下文，skill 内容按需加载。

OpenClaw: **完全相同的做法**。`formatSkillsForPrompt()` 只在 system prompt 中注入 name + description + file path，agent 用 read 工具按需加载内容:

```javascript
// node_modules/@mariozechner/pi-coding-agent/dist/core/skills.js:220-234
const lines = [
  "The following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when the task matches its description.",
  "",
  "<available_skills>",
];
for (const skill of visibleSkills) {
  lines.push("  <skill>");
  lines.push(`    <name>${escapeXml(skill.name)}</name>`);
  lines.push(`    <description>${escapeXml(skill.description)}</description>`);
  lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
  lines.push("  </skill>");
}
```

**差异**: 无实质差异。两者采用完全相同的模式——名称+描述作为静态上下文，内容按需加载。OpenClaw 额外有数量限制（默认 150 个 skill，30K chars 上限）。

**策略 4: MCP 工具按需加载**

Cursor: MCP server 的工具描述写入文件夹，agent 只接收工具名列表，按需查找 schema。A/B 测试: 调用 MCP 工具的 run 中总 token 降低 46.9%。

OpenClaw: **架构不同，不直接可比**。OpenClaw 的内置工具在 system prompt 中只放名称 + 摘要（不放完整 schema），完整 schema 在工具注册表中:

```typescript
// src/agents/system-prompt.ts:309-312
const toolLines = enabledTools.map((tool) => {
  const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
  const name = resolveToolName(tool);
  return summary ? `- ${name}: ${summary}` : `- ${name}`;
});
```

对于 MCP 工具，OpenClaw 当前没有 Cursor 那样的文件夹同步 + 按需查找机制。MCP 工具如果通过插件注册，其 schema 会随工具注册表全量传递给 SDK。但核心工具只在 prompt 中放摘要行，与 Cursor 的做法本质相似。

**差异**: 内置工具处理方式相似（都是名称+摘要）。MCP 工具处理上 Cursor 更进一步（文件夹发现 + 按需加载）。

**策略 5: Terminal Session 作为文件**

Cursor: 集成终端的输出同步到文件系统，agent 可以 grep 日志。

OpenClaw: **不适用**。OpenClaw 是 gateway 架构（非 IDE），终端概念不同。Agent 的 bash 工具直接返回命令输出到 context。

### 9.3 Cursor Summarization 机制

当 context 满时，Cursor 的 summarization 流程:

1. 触发 summarization (自动或 `/Summarize` 手动)
2. 将完整历史保存为可引用的文件
3. LLM 生成摘要
4. 新的 context = 摘要 + 文件引用能力
5. Agent 可以在后续对话中搜索/读取原始历史来补充信息

---

## 10. OpenClaw vs Cursor 对比

| 维度                   | OpenClaw                                         | Cursor                             | 差异程度            |
| ---------------------- | ------------------------------------------------ | ---------------------------------- | ------------------- |
| **Skills 加载**        | name + description + path → 按需 read            | name + description → 按需 read     | 相同                |
| **工具 prompt**        | 名称 + 摘要行 (不含 schema)                      | 名称列表 → 按需查找 schema         | 相似                |
| **大工具输出**         | 截断 + 提示分段重读                              | 写入文件 + `tail`/read             | Cursor 更优         |
| **Compact 后历史恢复** | JSONL 保留 + `sessions_history` 工具 (80KB 限制) | 历史保存为文件 + 搜索/读取         | 相似, Cursor 更显式 |
| **Post-compact 恢复**  | 无自动恢复                                       | re-read 最近 5 文件 + 恢复 todo    | Cursor 更优         |
| **Summarization 触发** | contextTokens > contextWindow - reserveTokens    | context window 满                  | 相似                |
| **摘要格式**           | 结构化 (Goal/Progress/Decisions/Next Steps)      | 结构化 (working state)             | 相似                |
| **MCP 工具发现**       | 插件注册, schema 全量传递                        | 文件夹同步 + 按需加载 (节省 46.9%) | Cursor 更优         |
| **Microcompaction**    | 无                                               | 有 (冷存储 + 热尾)                 | Cursor 更优         |
| **手动 compact**       | `/compact [instructions]`                        | `/Summarize`                       | 相同                |
| **持久化**             | JSONL (会话历史 + 摘要永久保留)                  | 不明确 (非开源)                    | OpenClaw 更透明     |
| **多模型支持**         | 支持 (但摘要 prompt 不适配非 Anthropic)          | 针对每个前沿模型优化 harness       | Cursor 更优         |
| **Background agent**   | 共享 context                                     | 独立 context + delta summarization | Cursor 更优         |
| **扩展性**             | Hook 机制 (before/after_compaction)              | 不明确                             | OpenClaw 更优       |
| **语义搜索历史**       | memory.qmd.sessions (实验性)                     | 不明确                             | OpenClaw 有潜力     |

---

## 11. 行业研究启示

### 11.1 JetBrains "The Complexity Trap"

JetBrains Research 在 NeurIPS 2025 发表的研究揭示了一个反直觉的发现:

**简单的 Observation Masking (丢弃旧消息) 与 LLM Summarization 的效果相当, 而成本减半。**

具体数据:

- Qwen3-Coder 480B: Masking 的 solve rate (54.8%) 略高于 Summarization
- 成本: Masking 比 raw agent 降低 ~50%
- 混合方案 (Masking + Summarization): 额外降低 7-11% 成本

这对 OpenClaw 的启示: 当前系统可能**过度投资于 LLM summarization**。对于很多场景，简单的消息丢弃可能同样有效且更经济。

### 11.2 ACON 框架

ACON 提出了一个统一的上下文压缩优化框架:

- 使用自然语言空间的"压缩指导原则"
- 通过 paired trajectories 分析失败案例来迭代改进策略
- 实现 26-54% 的峰值 token 降低

启示: 压缩策略应该是**可学习/可迭代**的，不应是固定的 prompt。

### 11.3 Google ADK

Google 的 Agent Development Kit 使用滑动窗口方法:

- `compaction_interval`: 多少次调用触发一次压缩
- `overlap_size`: 前后窗口的重叠区域

简洁但对长期任务的记忆保持有限。

---

## 12. 改进建议

### 12.1 引入 Microcompaction (参考 Claude Code)

**问题**: 大型工具输出长时间占用 context，即使已经不再需要。

**方案**: 实现"冷存储 + 热尾"机制。

```
工具输出 (Read, Bash, Grep, Glob 等)
├── 最近 N 条: 保留完整内容在 context (hot tail)
└── 更早的: 只保留路径引用, 内容写入磁盘
    → Agent 需要时可通过路径重新读取
```

实施要点:

- 缓存策略: LRU 或基于 token 大小的淘汰
- 持久化格式: 与 JSONL 条目关联的磁盘文件
- 不修改 upstream SDK，在 OpenClaw 层通过 tool result 后处理实现

预期收益: 显著减少 auto-compaction 触发频率，延长"不需要 compact"的对话长度。

### 12.2 Post-Compaction Restoration (参考 Claude Code)

**问题**: Compact 后 LLM 对当前工作文件的理解退化。

**方案**: 在 compact 完成后自动执行恢复步骤:

1. Re-read 最近 3-5 个被修改/读取的文件 (利用 compact result 中的 `details.readFiles` 和 `details.modifiedFiles`)
2. 恢复 todo/task 状态 (如果有)
3. 注入 continuation message: "继续之前的任务，不要重新提问"

可在 `after_compaction` hook 中实现，无需修改 upstream。

### 12.3 增强 sessions_history 恢复能力 (参考 Cursor)

**现状**: OpenClaw 已通过 `sessions_history` 工具支持 compact 后的历史恢复，但有限制 (80KB 硬上限, 单条 4000 chars, 最多 1000 条)。

**改进方案 A: 放宽 sessions_history 限制**

对 compact 后的恢复场景，允许更大的历史读取量。可在 `sessions_history` 工具中增加 `recovery` 模式，放宽大小限制。

**改进方案 B: Compact 时生成人可读的历史快照**

```
compact 触发时:
1. 将 messagesToSummarize 格式化为 Markdown
2. 保存到 ~/.openclaw/history/<sessionId>/<compactionId>.md
3. 在摘要中注明路径, Agent 可通过 Read 工具按需恢复
```

与现有的 `sessions_history` (读 JSONL 原始格式) 互补，提供更友好的人可读格式。

**改进方案 C: 摘要中嵌入历史引用提示**

在 compact 摘要末尾自动附加:

```
[Note: Full conversation history is preserved in the session file.
Use the sessions_history tool with sessionKey="<key>" to recover details.]
```

让 LLM 知道可以主动查阅历史，而非只依赖摘要。

### 12.4 混合策略 (参考 JetBrains 研究)

**问题**: LLM summarization 成本高但收益不一定优于简单丢弃。

**方案**: 对不同类型的消息使用不同策略:

| 消息类型                      | 策略                | 理由                       |
| ----------------------------- | ------------------- | -------------------------- |
| 工具输出 (大量 stderr/stdout) | Masking (直接丢弃)  | 信息密度低, 总结收益小     |
| 用户指令 + AI 回复            | LLM Summarization   | 包含意图和决策, 需保留语义 |
| 文件读取结果                  | 替换为文件路径引用  | Agent 可按需重新读取       |
| 错误信息                      | 保留最近 + 丢弃更早 | 只需知道最近的错误         |

预期收益: 根据 JetBrains 研究，混合策略可在 masking 基础上再降 7-11% 成本，同时保持或提升 solve rate。

### 12.5 修复已知缺陷

**高优先级:**

1. **修复 safeguard 静默失败** (#7477): 当 `ctx.model` 为 undefined 时，应该 fall back 到 default mode 而非返回纯文本 note，同时记录 warning 日志。

2. **修复架构断层**: 让 `agents.defaults.contextTokens` 传递到 SDK 的 compaction 触发逻辑。最简单的方案: 在 `createAgentSession()` 前用 OpenClaw 解析的 contextWindow 覆盖 model 对象。详见 [context-window-architecture.md](context-window-architecture.md) 第 10 节方案分析。

3. **多模型 Prompt 适配**: 对非 Anthropic 模型 (如 minimax, GLM, Gemini) 的摘要 prompt 进行适配测试，确保 `<conversation>` 标签格式被正确理解。

**中优先级:**

4. **Compact 质量监控**: 在 `after_compaction` hook 中计算信息保留率（如: 摘要 token 数 / 原始 token 数），记录到诊断日志。当保留率过低时发出警告。

5. **用户反馈通道**: 在 compact 后添加一个可选的验证步骤，让用户确认摘要是否遗漏了重要信息。

6. **配置向导**: 在 setup wizard 中增加 compaction 配置项，减少手动 JSON 编辑的错误风险。

---

## 13. 附录: 配置参数完整参考

| 参数                                        | 默认值        | 说明                                            |
| ------------------------------------------- | ------------- | ----------------------------------------------- |
| `compaction.mode`                           | `"safeguard"` | 压缩模式: "default" 或 "safeguard"              |
| `compaction.reserveTokensFloor`             | `20000`       | OpenClaw 保证的最低 reserveTokens               |
| `compaction.maxHistoryShare`                | `0.5`         | safeguard 模式: 历史最多占 context 的比例       |
| SDK `compaction.enabled`                    | `true`        | 启用/禁用 auto-compaction                       |
| SDK `compaction.reserveTokens`              | `16384`       | SDK 默认 reserveTokens (被 OpenClaw floor 覆盖) |
| SDK `compaction.keepRecentTokens`           | `20000`       | compact 后保留的最近消息 tokens                 |
| `agents.defaults.contextTokens`             | 未设置        | context window cap (不影响 compact 触发!)       |
| `models.providers.*.models[].contextWindow` | 模型默认      | 自定义 contextWindow (影响 compact 触发)        |

---

## 14. 关键代码索引

| 文件                                                      | 核心函数/类                               | 说明                                |
| --------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| `src/agents/pi-embedded-runner/compact.ts`                | `compactEmbeddedPiSession()`              | Compact 入口 (队列化)               |
| 同上                                                      | `compactEmbeddedPiSessionDirect()`        | Compact 核心逻辑                    |
| `src/agents/compaction.ts`                                | `summarizeInStages()`                     | 分阶段总结                          |
| 同上                                                      | `pruneHistoryForContextShare()`           | 按预算修剪历史                      |
| 同上                                                      | `chunkMessagesByMaxTokens()`              | 按 token 分块                       |
| 同上                                                      | `computeAdaptiveChunkRatio()`             | 自适应分块比例                      |
| `src/agents/pi-extensions/compaction-safeguard.ts`        | `compactionSafeguardExtension()`          | Safeguard 模式实现                  |
| `src/agents/pi-embedded-runner/run.ts`                    | `runEmbeddedPiAgent()`                    | Agent 主循环 (含 overflow recovery) |
| `src/agents/pi-embedded-runner/history.ts`                | `limitHistoryTurns()`                     | 历史轮次限制                        |
| `src/agents/pi-embedded-runner/tool-result-truncation.ts` | `truncateOversizedToolResultsInSession()` | 工具结果截断                        |
| `src/agents/context-window-guard.ts`                      | `resolveContextWindowInfo()`              | Context window 解析                 |
| `src/agents/pi-settings.ts`                               | `ensurePiCompactionReserveTokens()`       | 保留 token 配置                     |
| `src/config/defaults.ts`                                  | `applyCompactionDefaults()`               | 默认配置应用                        |
| SDK `compaction.js`                                       | `compact()`                               | SDK 底层 compact                    |
| SDK `utils.js`                                            | `SUMMARIZATION_SYSTEM_PROMPT`             | 摘要 prompt                         |
| SDK `agent-session.js`                                    | `_checkCompaction()`                      | 触发判断                            |
