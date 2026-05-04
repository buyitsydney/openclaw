# Agent Run Loop 架构详解

> 基于 `@mariozechner/pi-agent-core` 源码（OpenClaw Docker 容器实际运行的 agent loop）和 OpenClaw `pi-embedded-runner` 源码分析。
>
> **注意**：Claude Code CLI 的 query loop (`claude code/query.ts`) 是另一套独立实现，和 Docker 容器里跑的不是同一个东西。本文档分析的是 Docker 容器的真实运行架构。

## 架构总览

```
用户消息 (飞书/webchat)
  ↓
OpenClaw Gateway (feishu-her extension)
  ↓
pi-embedded-runner/run.ts — 外层控制 (session lane 排队, 超时, failover)
  ↓
pi-embedded-runner/run/attempt.ts — 单次尝试 (模型选择, compaction, 工具注册)
  ↓
@mariozechner/pi-agent-core/agent-loop.js — 核心 agent 循环 ← 本文重点
  ↓
@mariozechner/pi-ai — LLM API 调用 (Anthropic/OpenRouter/OpenAI)
```

## 1. 核心 Agent Loop: `runLoop()`

**源码位置:** `node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js`

### 双层循环结构

```javascript
async function runLoop(currentContext, newMessages, config, signal, emit, streamFn) {
    let firstTurn = true;
    let pendingMessages = (await config.getSteeringMessages?.()) || [];

    // 外层循环: 处理 follow-up 消息
    while (true) {
        let hasMoreToolCalls = true;

        // 内层循环: 处理 tool calls + steering 消息
        while (hasMoreToolCalls || pendingMessages.length > 0) {
            // 1. 注入 pending 消息 (用户在 AI 工作期间发的新消息)
            // 2. 调用 LLM, 流式接收响应
            // 3. 检查响应中是否有 toolCall
            // 4. 如果有 → 执行工具 → 继续内层循环
            // 5. 如果没有 → 退出内层循环
        }

        // 内层循环结束 → 检查有没有 follow-up 消息
        const followUpMessages = (await config.getFollowUpMessages?.()) || [];
        if (followUpMessages.length > 0) {
            pendingMessages = followUpMessages;
            continue;  // 有后续消息 → 回到外层循环
        }

        break;  // 没有后续消息 → 彻底结束
    }
}
```

### AI 如何决定 "继续" 还是 "停止"

**停止条件：AI 的响应中没有 `toolCall` block。**

```javascript
// agent-loop.js:111-112
const toolCalls = message.content.filter((c) => c.type === "toolCall");
hasMoreToolCalls = toolCalls.length > 0;
```

**这意味着：**
- AI **自己决定** 什么时候停——通过不再调用工具
- **内层循环没有次数限制**——AI 可以连续调用 100 次工具
- **内层循环没有时间限制**——在 agent-loop 层面完全无超时

### 特殊退出条件

```javascript
// agent-loop.js:105-108
if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;  // 立即退出，不再循环
}
```

| stopReason | 含义 | 触发源 |
|-----------|------|--------|
| (无, 正常) | AI 输出文本无 toolCall | AI 自主决定 |
| `"error"` | LLM API 调用出错 | 网络/API 错误 |
| `"aborted"` | AbortController signal 触发 | 外层超时或用户中断 |

## 2. 一轮完整 Agent Run 的数据流

```
用户: "帮我搜一下最近的会议纪要"
  ↓
[LLM 调用 #1]
  AI 响应: "我来搜索飞书文档" + toolCall(feishu_search, {query:"会议纪要"})
  ↓ hasMoreToolCalls = true → 继续
[工具执行] feishu_search → 返回 3 个文档链接
  ↓
[LLM 调用 #2]
  AI 响应: "找到3个文档，读取最新的" + toolCall(feishu_doc, {id:"xxx"})
  ↓ hasMoreToolCalls = true → 继续
[工具执行] feishu_doc → 返回文档内容
  ↓
[LLM 调用 #3]
  AI 响应: "这是会议纪要的总结：...（纯文本，无 toolCall）"
  ↓ hasMoreToolCalls = false → 退出内层循环
  ↓ followUpMessages = [] → 退出外层循环
  ↓
Agent Run 结束，发送最终回复给用户
```

**3 次 LLM 调用 + 2 次工具执行 = 1 轮 agent run。全部由 AI 自主决定。**

## 3. Steering 消息和 Follow-up 消息

agent-loop 支持两种消息注入机制：

### getSteeringMessages()
**时机：** 内层循环每次迭代开始前
**用途：** 用户在 AI 工作期间发的新消息，插入到下一次 LLM 调用之前
**效果：** AI 在下一个 turn 中能看到用户的新消息

### getFollowUpMessages()
**时机：** 内层循环结束后（AI 不再调用工具时）
**用途：** 检查是否有排队的后续消息需要处理
**效果：** 如果有 → 回到外层循环继续处理，不结束 run

## 4. 工具执行机制

### 两种模式

```javascript
// agent-loop.js:224-227
if (config.toolExecution === "sequential") {
    return executeToolCallsSequential(...);
}
return executeToolCallsParallel(...);
```

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `sequential` | 逐个执行, 前一个完成才执行下一个 | 有副作用的工具 (写文件, 执行命令) |
| `parallel` | 所有工具并行执行 | 只读工具 (搜索, 读文件) |

### 工具执行流水线

```
1. prepareToolCall()
   ├── 查找工具定义
   ├── 验证参数 (validateToolArguments)
   ├── beforeToolCall hook (可拦截)
   └── 返回 "prepared" 或 "immediate" (错误直接返回)

2. executePreparedToolCall()
   ├── tool.execute(id, args, signal, onProgress)
   ├── 收集 progress events
   └── 返回 result 或 error

3. finalizeExecutedToolCall()
   ├── afterToolCall hook (可修改结果)
   └── emit tool_execution_end event

4. 结果包装为 toolResult 消息
   → 加入 currentContext.messages
   → 加入 newMessages
   → 进入下一轮 LLM 调用
```

### 工具结果如何反馈给 AI

```javascript
// agent-loop.js:116-119
if (hasMoreToolCalls) {
    toolResults.push(...(await executeToolCalls(...)));
    for (const result of toolResults) {
        currentContext.messages.push(result);   // 加入上下文
        newMessages.push(result);               // 记录到 session
    }
}
```

下一次 LLM 调用时，`currentContext.messages` 包含了所有历史 + 新的工具结果，AI 可以看到工具返回了什么。

## 5. OpenClaw Embedded Runner: 外层包装

**源码位置:** `openclaw/src/agents/pi-embedded-runner/`

OpenClaw 在 `pi-agent-core` 的 agent loop 外面包了一层，负责：

### 5.1 Session Lane 串行队列

```typescript
// run.ts:259
const sessionLane = resolveSessionLane(params.sessionKey || params.sessionId);
return enqueueSession(() => enqueueGlobal(async () => {
    // 整个 run 在 lane 队列里串行执行
}));
```

**同一个 session 的所有 run 严格串行。** 前一个 run 不结束，后面的全部排队。

### 5.2 Run 级别超时（外层 setTimeout）

```typescript
// attempt.ts:2240-2270
const abortTimer = setTimeout(() => {
    log.warn(`embedded run timeout: runId=... timeoutMs=${params.timeoutMs}`);
    abortRun(true);  // 触发 AbortController → signal 传播到 agent-loop
}, Math.max(1, params.timeoutMs));
```

**超时来源链：**
```
config: agents.defaults.timeoutSeconds (默认 600)
  → resolveAgentTimeoutMs() (src/agents/timeout.ts)
    → params.timeoutMs
      → setTimeout(abortRun, timeoutMs)
        → AbortController.abort()
          → agent-loop 收到 signal
            → stopReason = "aborted"
              → 立即退出循环
```

**关键：这个超时是在 agent-loop 外面的 `setTimeout`，不是 agent-loop 自身的机制。agent-loop 自身没有超时。**

### 5.3 Run 级别的重试循环

```typescript
// run.ts:809
while (true) {
    if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
        return { error: "retry_limit" };
    }
    const attempt = await runEmbeddedAttempt({...});
    // 根据 attempt 结果决定: 重试 / failover 到其他模型 / 返回结果
}
```

这个 `while(true)` 是 **retry 循环**（模型降级、auth 重试），不是 tool 循环。

### 5.4 超时杀死 run 时发生什么

```
1. setTimeout 触发 → abortRun(true)
2. AbortController.abort() → signal 传播到 agent-loop
3. agent-loop 的 streamAssistantResponse() 检测到 signal:
   a. 正在等 LLM 响应 → 中断流式连接 → stopReason="aborted" → 退出
   b. 正在执行工具 → tool.execute 收到 signal → 中断 (bash 子进程可能继续运行)
4. agent-loop 返回 → run 结束 → session lane 释放
```

**致命场景：abort 发生在 AI 已发出 toolCall 但工具还没返回时：**
- AI 的 assistant 消息（含 toolCall）已写入 session 历史
- 工具结果没有写入（被 abort 打断）
- 下一个 run 继承这个损坏的历史
- API 拒绝: `unexpected tool_use_id found in tool_result blocks`
- **session 永久废掉，直到 /new 重置**

## 6. "一整晚干活" 的实现机制

Agent 不是一个 run 跑一整晚。而是**多个 run 通过消息事件串联**：

```
[Run 1: HEARTBEAT cron]  → AI 检查任务 → 调用 exec → 完成 (3min)
                             ↓ exec 在后台继续运行
[等待]
                             ↓ exec 完成
[Run 2: exec completed]  → AI 处理结果 → 写报告 → 完成 (2min)
                             ↓
[Run 3: 用户消息]         → AI 回复 → 完成 (30s)
                             ↓
[Run 4: HEARTBEAT cron]  → AI 继续未完成的任务 → 完成 (5min)
```

**触发下一个 run 的信号：**

| 触发源 | 说明 |
|--------|------|
| 用户消息 | 飞书私聊/群聊 |
| HEARTBEAT cron | 定时唤醒 |
| `exec completed` | 后台 exec 命令完成回调 |
| 其他 cron jobs | 每日晨报、日报等 |

**Session 跨 run 连续：** 每个 run 的对话历史持久化到 `.jsonl`。下一个 run 加载历史，AI 从上下文知道之前做到哪里。

## 7. Docker-13 案例复盘

### 时间线（session JSONL 铁证）

```
22:38:36  Run 开始 (Queued messages)
          AI 连续工作, 多次 tool call:
22:40:27    → exec probe 检查
22:40:48    → 再 probe
22:41:01    → exec 跑 25 并发
22:42:18    → 工具返回, AI 继续
22:44:57    → exec 跑下一步
22:46:01    → AI: "跑50并发" + exec tool_call
22:46:58    → AI: "队列清空" + exec tool_call (压测脚本)
22:48:36  ⚡ ABORT! setTimeout 触发 (600s = 22:38:36 + 10min)
          └── exec 的结果回来了, 但 run 已被杀
          └── session 历史: assistant 有 toolCall, 没有对应 toolResult
          └── session 损坏
```

**根因：AI 在一个 run 里连续调了 ~10 次工具，总耗时超过 600s。外层 setTimeout 强杀了 run，导致 toolCall/toolResult 配对断裂。**

### 后续影响

```
22:48:38  新 run 开始 (HEARTBEAT cron)
          AI 尝试继续, 部分成功 (从损坏的 session 恢复)
22:58:38  又被 setTimeout 杀了 (又一个 600s)
22:58:38  后续用户消息全部 deliverFired=false
          └── API 拒绝: "unexpected tool_use_id in tool_result"
```

## 8. 两层超时模型总结

```
OpenClaw Embedded Runner
├── setTimeout(abortRun, timeoutMs)     ← 默认 600s, 可配置
│   └── 强杀整个 agent-loop
│       └── 可能导致 session 损坏
│
└── @mariozechner/pi-agent-core agent-loop
    ├── 无超时, while(true) 永远循环
    ├── AI 自主决定停止 (不再发 toolCall)
    └── 每个工具自己的超时:
        ├── Bash: 默认 120s, 最大 600s
        ├── exec: 无硬超时 (后台运行, 结果异步通知)
        └── 其他工具: 一般几秒内返回
```

**核心矛盾：agent-loop 设计为无限循环（AI 自主控制），但 embedded runner 在外面强加了 600s 超时。当 AI 的任务天然需要 >600s 时（多步骤复杂任务），系统会强杀 run 并可能损坏 session。**

## 9. 配置建议

```json5
{
  agents: {
    defaults: {
      // 当前默认 600s (src/agents/timeout.ts)
      // 太长: OpenRouter 挂了要等 10 分钟
      // 太短: 复杂任务被频繁打断
      // 建议: 180s — 覆盖大部分 3-5 轮 tool call 场景
      timeoutSeconds: 180
    }
  }
}
```

**长任务的正确做法：** 不要让 AI 在一个 run 里做完所有事。用 `exec` 在后台执行耗时操作，exec 完成后通过 `exec completed` 通知触发新 run 来处理结果。这样每个 run 都很短（几十秒），不会触发超时。
