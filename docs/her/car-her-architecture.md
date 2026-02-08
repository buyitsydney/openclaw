# Car Her 架构设计：从旁路集成到主干道集成

## 背景

Car Her 是基于 OpenClaw realtime 插件的车载语音助手产品。Her 作为前台快思考语音界面，与 OpenClaw 慢思考大脑配合。

当前 realtime 插件采用"旁路"方式集成 OpenClaw——绕过 Gateway 直接调用底层函数、使用独立 session。这导致 Her 无法享受 OpenClaw 的定时提醒、heartbeat 主动推送等核心能力。

本文档描述如何将 Her 从旁路集成重构为主干道集成，**对 OpenClaw 核心代码零修改**，全部变更限制在 `extensions/realtime/` 内。

---

## 问题诊断

### 当前集成方式（旁路）

```
Her 前端
  │
  ↓ WebSocket (:18790)
realtime server.ts
  │
  ↓ 直接调用 runEmbeddedPiAgent()
  │ session key = "realtime:{timestamp}-{random}"  ← 独立 session
  │ 手动管理 session store
  │ 手动解析 model config
  │ 不经过 Gateway
  ↓
OpenClaw Agent（在独立 session 中运行）
```

### 问题

1. **Session 隔离**：Her 用 `realtime:xxx` session key，与 main session (`agent:main:main`) 隔离。cron/heartbeat 的 system events 进入 main session，Her 永远看不到。

2. **不更新 lastRoute**：Telegram/webchat 每次对话都更新 main session 的 `lastChannel`/`lastTo`，heartbeat 投递时自动找到正确通道。Her 不做这个更新。

3. **绕过 Gateway**：webchat 走 `chat.send`、CLI 走 `agent` method、Telegram 走 auto-reply pipeline，全部经过 Gateway。只有 Her 绕过了 Gateway 的 session 管理、run tracking、event broadcasting 等基础设施。

4. **重复造轮子**：`server.ts` 自己管 session store（~50 行），自己解析 model config（~15 行），自己调 `runEmbeddedPiAgent`——全是 Gateway 已做好的事。`core-bridge.ts` 用 195 行代码 hack 式地动态 import 7 个核心模块。

### 对比：其他通道如何集成

| 通道 | 调用方式 | Session Key | 享受 cron/heartbeat |
|------|---------|-------------|-------------------|
| Telegram | auto-reply pipeline | `agent:main:main`（DM 默认） | 是 |
| webchat | Gateway `chat.send` | `agent:main:main` | 是 |
| CLI | Gateway `agent` method | `agent:main:main` | 是 |
| **Her（当前）** | **直接调 `runEmbeddedPiAgent`** | **`realtime:xxx`** | **否** |

---

## 目标架构（主干道集成）

```
Her 前端
  │
  ↓ WebSocket (:18790)
realtime server.ts
  │
  ↓ callGateway({ method: "agent", sessionKey: mainSessionKey })
  │ 使用 main session
  │ Gateway 管 session / tracking / broadcasting
  │ extraSystemPrompt 传递 backend mode + conversation context
  ↓
Gateway (:18789)
  │
  ↓ agentCommand()
OpenClaw Agent（在 main session 中运行，天然看到 system events）
```

### 核心变更

**一句话总结**：把 `handleHelpRequest` 中 ~120 行的手动 session 管理 + `runEmbeddedPiAgent` 调用，替换为 ~20 行的 `callGateway({ method: "agent" })`。

---

## 用户体验对比

### 场景 1：设置提醒

**重构前**：

```
用户: "提醒我下午3点开会"
Her → openclaw_help → OpenClaw agent 调用 cron tool
→ cron job 创建成功（schedule: at 15:00）
→ OpenClaw 回复: "好的，已设置下午3点提醒"
Her: "好的天哥，下午3点我会提醒你开会"

... 下午 3:00 ...

cron 触发 → systemEvent → main session 事件队列
→ heartbeat 运行，agent 看到提醒
→ agent 回复投递到 Telegram（lastChannel）
→ 用户在 Telegram 收到提醒
→ Her 前端：什么都没发生（session 隔离，看不到）
```

**重构后**：

```
用户: "提醒我下午3点开会"
Her → openclaw_help → callGateway(agent, main session)
→ OpenClaw agent 调用 cron tool
→ cron job 创建成功
→ 回复: "好的，已设置下午3点提醒"
Her: "好的天哥，下午3点我会提醒你开会"

... 下午 3:00 ...

cron 触发 → systemEvent → main session 事件队列
→ heartbeat 运行，agent 看到提醒
→ agent 回复投递到 lastChannel

如果 Her 在线（更新了 lastRoute）：
  → Gateway broadcast → realtime server 收到 → 推送到 Her → 语音播报
如果 Her 离线：
  → 投递到 Telegram/上次活跃通道（和之前一样）
```

### 场景 2：跨通道上下文延续

**重构前**：

```
（在 Telegram 和 OpenClaw 聊了关于项目的事）
用户切到 Her: "刚才我跟你说的那个项目怎么样了？"
Her → openclaw_help → OpenClaw agent（独立 realtime session）
→ agent 看不到 Telegram 的对话历史（不同 session）
→ "抱歉，我不太确定你说的是哪个项目..."
```

**重构后**：

```
（在 Telegram 和 OpenClaw 聊了关于项目的事）
用户切到 Her: "刚才我跟你说的那个项目怎么样了？"
Her → openclaw_help → callGateway(agent, main session)
→ agent 在 main session 中，能看到之前 Telegram 的对话历史
→ "天哥，你说的是那个电商平台项目，上次我们讨论了..."
```

### 场景 3：Heartbeat 主动推送

**重构前**：

```
OpenClaw heartbeat 运行（每 30 分钟）
→ 检查邮件/日历/待办
→ 发现有重要信息
→ 投递到 Telegram（lastChannel，Her 从不在候选里）
→ Her 前端完全不知道
```

**重构后**：

```
OpenClaw heartbeat 运行
→ 检查邮件/日历/待办
→ 发现有重要信息
→ 投递到 lastChannel

如果用户最后一次对话是在 Her：
  → realtime server 作为 Gateway 客户端收到 broadcast
  → 推送到 Her → 语音播报: "天哥，你有一封重要邮件..."
如果用户最后一次对话是在 Telegram：
  → 投递到 Telegram（正常流程）
```

### 场景 4：Her 对话历史持久化

**重构前**：

```
Her 的对话存在 realtime:xxx 独立 session
→ 重启 Her 后 session 丢失
→ webchat/CLI 看不到 Her 的对话
→ 其他通道看不到 Her 发生了什么
```

**重构后**：

```
Her 的对话在 main session 中
→ webchat 可以看到 Her 发起的请求和结果
→ CLI `openclaw sessions history` 能查到
→ 所有通道共享同一个对话上下文
```

---

## 实现推演

### 需要修改的文件（全部在 extensions/realtime/ 内）

#### 1. `extensions/realtime/src/server.ts` — 核心改动

**改动范围**：`handleHelpRequest` 函数（~120 行 → ~30 行）

**删除**（约 90 行）：
- 手动加载 `coreDeps`（第 258-262 行）
- 手动解析 config 中的 agentId、storePath、agentDir、workspaceDir（第 264-273 行）
- 手动管理 session store：loadSessionStore、创建 sessionEntry、saveSessionStore（第 275-293 行）
- 手动解析 sessionFile（第 295-300 行）
- 手动解析 model config：agentDefaults、modelRef、provider/model 拆分（第 317-328 行）
- 手动解析 thinkLevel、timeoutMs（第 330-331 行）
- 手动调用 `runEmbeddedPiAgent`（第 336-353 行）
- 手动提取 payloads 文本（第 356-361 行）

**替换为**（约 20 行）：

```typescript
async function handleHelpRequest(
  client: RealtimeClient,
  request: string,
  api: OpenClawPluginApi,
): Promise<string> {
  const conversationContext = client.conversation.join("\n");
  const prompt = `用户通过语音助手请求帮助：\n\n## 对话上下文\n${conversationContext || "（暂无之前的对话）"}\n\n## 当前请求\n${request}\n\n请处理这个请求，返回给语音助手说的内容。`;
  const extraSystemPrompt = buildBackendModePrompt(conversationContext);

  const result = await callGateway<{ result?: { text?: string } }>({
    method: "agent",
    params: {
      message: prompt,
      idempotencyKey: `realtime:${client.sessionId}:${Date.now()}`,
      lane: "realtime",
      extraSystemPrompt,
    },
    expectFinal: true,
    timeoutMs: 120_000,
  });

  return result?.result?.text || "抱歉，我暂时无法处理这个请求。";
}
```

**注意**：不传 `sessionKey` 参数，Gateway 会自动使用 main session（`resolveExplicitAgentSessionKey` 默认行为）。

**新增**（约 10 行）：在文件顶部添加 `callGateway` 的导入（通过 core-bridge 或直接动态 import）。

#### 2. `extensions/realtime/src/core-bridge.ts` — 大幅精简

**改动范围**：整个文件（195 行 → ~40 行）

**删除**（约 155 行）：
- `CoreAgentDeps` 类型定义中的绝大部分字段：`runEmbeddedPiAgent`、`resolveStorePath`、`loadSessionStore`、`saveSessionStore`、`resolveSessionFilePath`、`resolveAgentDir`、`resolveAgentWorkspaceDir`、`resolveThinkingDefault`、`resolveAgentTimeoutMs`、`DEFAULT_MODEL`、`DEFAULT_PROVIDER`
- `loadCoreAgentDeps` 中对应的 7 个 `importCoreModule` 调用（减少到 1-2 个）

**保留**：
- `resolveOpenClawRoot`、`importCoreModule` 基础设施（bootstrap/capsule 仍需）
- capsule 生成所需的最少依赖（如果 capsule 也改用 Gateway 调用，可以全部删除）

**可选的进一步精简**：如果 `generateLiveMemoryCapsule` 也改用 `callGateway`（完全可行），则 `core-bridge.ts` 可以**整个删除**。

#### 3. `extensions/realtime/src/live-memory-capsule-agent.ts` — 可选精简

**如果保留当前方式**：不需要改动。

**如果也改用 Gateway**：~110 行 → ~25 行，删除手动 session 管理和 `runEmbeddedPiAgent` 调用，替换为 `callGateway`。

#### 4. `extensions/realtime/src/prompt.ts` — 小幅增强

**改动范围**：增加约 15-20 行

**新增**：在 `buildBackendModePrompt` 中加入提醒设置规范，指导 OpenClaw 如何使用 cron tool：

```typescript
// 新增段落
`
## 提醒设置规范
当用户要求设置提醒/闹钟/定时任务时：
- 使用 cron tool 的 add action
- schedule.kind 为 "at"（一次性）或 "cron"（周期性）
- 回复要口语化、确认时间，适合语音播报
`
```

#### 5. `extensions/realtime/index.ts` — 无需改动或极小改动

当前的 `before_agent_start` hook 用 `ctx.sessionKey?.startsWith("realtime:")` 判断是否注入 backend mode prompt。

**问题**：重构后 session key 变成 main session（`agent:main:main`），不再以 `realtime:` 开头。

**解决**：改用 `lane` 或 `messageProvider` 来判断：

```typescript
api.on("before_agent_start", async (event, ctx) => {
  // 通过 lane 判断是否是 realtime 请求
  if (ctx.lane !== "realtime") return {};
  // ...
});
```

如果 hook 的 `ctx` 不包含 `lane`，则可以通过 `extraSystemPrompt` 参数直接传递（`callGateway` 的 agent 方法已支持 `extraSystemPrompt`），这样 hook 都不需要了。

**实际判断**：由于 `callGateway` 的 `agent` 方法支持 `extraSystemPrompt` 参数，我们在 `handleHelpRequest` 中直接传递 backend mode prompt，**不再需要 `before_agent_start` hook**。

因此 `index.ts` 可以**删除** hook 注册代码（约 15 行）。

#### 6. 前端文件 — 零改动

- `tools.js` — 零改动（`openclaw_help` tool 定义不变）
- `inject-delivery.js` — 零改动
- `script.js` / `mobile-script.js` — 零改动
- `geminilive.js` / `mediaUtils.js` — 零改动

**原因**：前端只和 realtime WebSocket server 交互，server 内部如何调 OpenClaw 对前端透明。

### 完整文件改动清单

| 文件 | 改动类型 | 改动量 | 说明 |
|------|---------|-------|------|
| `src/server.ts` | 重写 handleHelpRequest | 删 ~90 行，加 ~20 行 | 核心改动：callGateway 替代 runEmbeddedPiAgent |
| `src/core-bridge.ts` | 大幅精简 | 删 ~155 行 | 移除不再需要的 core module imports |
| `src/prompt.ts` | 增强 | 加 ~15 行 | 新增提醒设置规范段落 |
| `index.ts` | 精简 | 删 ~15 行 | 移除 before_agent_start hook |
| `src/live-memory-capsule-agent.ts` | 可选精简 | 删 ~85 行，加 ~15 行 | 如果也改用 callGateway |
| **前端所有文件** | **零改动** | **0** | 前端完全无感 |

**净效果**：删除约 250-350 行代码，新增约 50 行代码。**代码量减少 200-300 行。**

### OpenClaw 核心代码改动

**零。**

- `src/gateway/` — 不改。使用已有的 `agent` method。
- `src/cron/` — 不改。使用已有的 cron tool。
- `src/infra/` — 不改。使用已有的 system events + heartbeat。
- `src/agents/` — 不改。
- `src/plugins/` — 不改。
- 其他任何核心模块 — 不改。

---

## callGateway 集成细节

### 导入方式

realtime 插件不能直接 `import { callGateway } from "openclaw/...""`（它是插件，不是核心代码）。两种方式：

**方式 A：动态 import（和当前 core-bridge 一致）**

```typescript
// 精简后的 core-bridge.ts
export async function loadCallGateway() {
  const mod = await importCoreModule<{
    callGateway: typeof import("../../src/gateway/call.js").callGateway;
  }>("gateway/call.js");
  return mod.callGateway;
}
```

**方式 B：通过 plugin API 的 runtime 调用**

如果 `api.runtime` 暴露了 gateway 调用能力（需要确认），可以直接用。当前 `PluginRuntime` 不包含 `callGateway`，所以**方式 A 更可行**。

### Gateway 认证

`callGateway` 在本地运行时（同一台机器），认证通过 config 中的 gateway token 自动处理。realtime 插件和 Gateway 在同一进程/机器上，不需要额外配置。

### Lane 机制

传 `lane: "realtime"` 确保 Her 的请求不会和 Telegram/webchat 的请求在 main session 上产生竞争。Gateway 的 lane 机制会串行化同一 session 上不同 lane 的请求。

---

## 提醒推送到 Her 前端

### 自然推送路径（无需额外开发）

重构后，Her 使用 main session。当 cron 提醒触发时：

1. cron → systemEvent → main session 事件队列
2. heartbeat 运行（`wakeMode: "now"` 立即触发）
3. agent 看到 system event，产出回复
4. heartbeat delivery 决定投递到 `lastChannel`

如果用户最后一次对话是通过 Her，`lastRoute` 会被更新为指向 Her 所在的通道。

### 待确认：lastRoute 更新

Gateway 的 `agent` method 在收到请求时，会根据 `channel` 参数更新 `lastRoute`。需要确认：

- 如果不传 `channel` 参数（Her 不是传统通道），`lastRoute` 不会被更新 → heartbeat 仍投递到上次的传统通道（Telegram 等）
- 这实际上是**合理的默认行为**：Her 是语音界面，用户不一定在线，heartbeat 投递到 Telegram 作为兜底更可靠

### 可选增强：Gateway Event 监听

如果希望 Her 在线时主动收到推送（而非等待 heartbeat 投递到 Telegram）：

在 realtime server 中新增一个轻量的 Gateway WebSocket 客户端，监听 broadcast events。当收到与 main session 相关的 `chat` 事件时，推送到 Her 前端。

这是**可选的增强**，不是必须的。基础版（heartbeat 投递到 Telegram）已经能工作。

---

## 全场景推演

### 正面场景（重构后提升）

#### S1. 设置提醒 — 从"断链"到"跑通"

```
重构前：Her 设置提醒成功，但提醒触发时投递到 Telegram，Her 前端无感知
重构后：Her 设置提醒成功，提醒触发后 heartbeat 投递到 lastChannel（可能是 Telegram），
       Her 本身不收到（因为不更新 lastRoute），但 cron 确实跑在 main session 了
结论：本质改善不大 — 提醒触发后仍然投递到 Telegram，不是 Her
      真正让 Her 收到提醒还需要额外的 Gateway event 监听（P1 增强）
```

#### S2. 跨通道上下文延续 — 真正提升

```
重构前：在 Telegram 聊了项目，切到 Her 问，agent 看不到（不同 session）
重构后：Her 和 Telegram 共享 main session，agent 能看到完整对话历史
结论：显著提升，这是最大的实质收益
```

#### S3. 对话历史统一 — 真正提升

```
重构前：Her 的对话记录在 realtime:xxx session，和其他通道隔离
重构后：所有通道对话记录在 main session，webchat/CLI 都能看到
结论：显著提升
```

#### S4. Memory 更新可见性 — 真正提升

```
重构前：Her 通过 openclaw_help 让 agent 更新了 USER.md/MEMORY.md
        但更新发生在 realtime session 的 agent 上下文中
        main session 不一定知道
重构后：agent 在 main session 运行，Memory 更新天然可见
结论：微小提升（Memory 更新走文件系统，实际上 session 隔离影响不大）
```

### 负面场景（重构后退化或风险）

#### S5. 延时增加 — 确认存在

**当前路径**（旁路，0 网络开销）：
```
handleHelpRequest()
  → loadCoreAgentDeps()（首次 ~50ms，后续缓存 0ms）
  → session store 读写（~5ms）
  → runEmbeddedPiAgent()（直接函数调用，0 网络开销）
  → agent 执行（~2-30s，取决于 LLM）
  → 提取 payloads 文本
总额外开销：~5ms（忽略不计）
```

**重构后路径**（经 Gateway，有网络开销）：
```
handleHelpRequest()
  → callGateway()
    → 创建 GatewayClient（new WebSocket）
    → WebSocket connect 到 ws://127.0.0.1:18789
    → TLS 握手（如果启用）
    → 发送 connect 请求，等待 hello.ok
    → loadOrCreateDeviceIdentity()
    → loadConfig()
    → 发送 agent 请求
    → Gateway 处理：validateAgentParams → loadConfig → loadSessionEntry
                    → updateSessionStore → resolveAgentDeliveryPlan
                    → agentCommand()
    → agent 执行（~2-30s，同样）
    → 等待 expectFinal 的第二个 respond
    → 关闭 WebSocket
总额外开销：~50-150ms（本地 loopback WebSocket 连接 + 协议握手 + 关闭）
```

**评估**：
- agent 执行本身 2-30 秒，额外 50-150ms 开销占比 0.5%-7.5%
- 对于语音场景，用户已经在等 "正在查，稍等一下"，额外 100ms 无感知
- **但**：`callGateway` 每次调用都**新建+关闭** WebSocket 连接（看 call.ts 第 207-253 行），没有连接池
- **结论：延时增加存在但对用户体验影响微乎其微**

#### S6. Main Session 对话历史膨胀 — 确认存在

```
重构前：Her 每次 openclaw_help 的对话记录在独立 realtime session
        main session 干净，只有 Telegram/webchat 的对话
重构后：Her 每次 openclaw_help 都写入 main session
        对话历史 = Telegram + webchat + CLI + Her 的所有请求
        Her 每次请求会带完整的 Gemini Live 对话上下文（可能很长）
```

**风险**：
- main session 文件变大
- agent 的上下文窗口被 Her 的频繁请求占满
- 可能影响其他通道（Telegram）的对话质量
- **结论：这是最大的实质风险**

**缓解**：
- Her 的 prompt 已经是精简的（只带 conversation context），不会特别长
- OpenClaw agent 有自动的 session truncation 机制
- 但需要监控 main session 文件大小

#### S7. 并发竞争 — 需要验证

```
场景：用户同时在 Telegram 聊天 + Her 语音
重构前：完全隔离，互不干扰（不同 session）
重构后：同一 main session，lane 机制串行化
        → Telegram 的请求和 Her 的请求会排队
        → 如果 Telegram 正在处理长任务，Her 可能要等
```

**评估**：
- Gateway 的 lane 机制用 `lane: "realtime"` 可以和默认 lane 并行
- 但 agent 写 session 文件是串行的（同一 session 不能并行写）
- **结论：低风险，lane 机制设计上就是为此场景准备的**
- **需要验证**：lane 机制是否真的允许不同 lane 并行运行在同一 session 上

#### S8. Gateway 故障影响范围扩大 — 确认存在

```
重构前：Gateway 挂了
  → Telegram/webchat/CLI 不工作
  → Her 仍然工作（旁路，不依赖 Gateway）
重构后：Gateway 挂了
  → 所有通道包括 Her 都不工作
```

**评估**：
- 实际上当前 Her 也依赖 Gateway 运行（cron tool 通过 callGatewayTool 调用 Gateway）
- 但当前 Her 的"基本对话"不依赖 Gateway（直接调 runEmbeddedPiAgent）
- **结论：轻微退化，但实际影响不大（Gateway 很少挂）**

#### S9. 调试复杂度变化 — 两面性

```
重构前：调试 Her 问题时
  → server.ts 里有完整的调用链，一眼看到发生了什么
  → console.log 加在 handleHelpRequest 里就行
  → 不需要理解 Gateway 内部逻辑

重构后：调试 Her 问题时
  → callGateway 是黑盒，看不到 Gateway 内部的 session 管理
  → 错误信息来自 Gateway 的 JSON response
  → 需要同时看 Gateway 日志 + realtime 日志
  → 但 Gateway 有完善的 run tracking 和 event broadcasting
```

**评估**：日常运行更好（Gateway 的 observability 更完善），排查问题更复杂（多了一层）

---

## 延时分析

### callGateway 每次调用的固定开销

根据 `src/gateway/call.ts` 第 112-255 行的实现：

1. `loadConfig()` — 读取配置文件（~2ms，有缓存）
2. `buildGatewayConnectionDetails()` — URL 解析（~1ms）
3. `loadOrCreateDeviceIdentity()` — 读取/创建设备标识（~2ms，有缓存）
4. `new GatewayClient()` — 创建 WebSocket 客户端对象（~1ms）
5. `client.start()` — WebSocket 连接到 `ws://127.0.0.1:18789`（~5-20ms loopback）
6. `onHelloOk` — 等待 Gateway 认证握手完成（~5-20ms）
7. `client.request()` — 发送 agent 请求（~1ms）
8. 等待 Gateway 处理 — validateAgentParams、loadSessionEntry、updateSessionStore（~10-30ms）
9. `agentCommand()` — 和当前 `runEmbeddedPiAgent` 实质相同
10. 等待 `expectFinal` 的第二个 respond（~1ms）
11. `client.stop()` — 关闭 WebSocket（~1ms）

**总额外开销估算：30-80ms（本地 loopback，不含 TLS）**

### 对比

| 指标 | 当前 | 重构后 | 差异 |
|------|------|-------|------|
| 网络开销 | 0ms（直接函数调用） | 30-80ms（loopback WS） | +30-80ms |
| config 解析 | ~15ms（手动解析 model） | 0ms（Gateway 内部处理） | -15ms |
| session 管理 | ~5ms（手动读写 JSON） | ~10ms（Gateway 管理） | +5ms |
| **净增延时** | — | — | **+20-70ms** |
| LLM 推理时间 | 2,000-30,000ms | 2,000-30,000ms | 0ms |
| **对用户感知** | — | — | **无感知** |

**结论：延时增加约 20-70ms，相对于 LLM 推理的 2-30 秒，完全无感知。**

---

## 可维护性分析

### 代码量变化

| 文件 | 重构前 | 重构后 | 变化 |
|------|-------|-------|------|
| `server.ts` | 458 行 | ~370 行 | -88 行 |
| `core-bridge.ts` | 195 行 | ~40 行（或删除） | -155 行 |
| `live-memory-capsule-agent.ts` | 110 行 | 不变（或 ~25 行） | 0 或 -85 行 |
| `prompt.ts` | 26 行 | ~45 行 | +19 行 |
| `index.ts` | 108 行 | ~93 行 | -15 行 |
| **总计** | **897 行** | **~548 行（或 ~473 行）** | **-349 行（或 -424 行）** |

### 可维护性提升

1. **消除 core-bridge hack**：当前 195 行的动态 import 是最大的维护负担。OpenClaw 任何内部模块路径变化（重命名、拆分、移动）都会导致 core-bridge 断裂。重构后只需 import 一个稳定的 `callGateway`。

2. **消除 session 管理代码**：手动管理 session store 是 Gateway 的职责重复，也是 bug 源（如果 Gateway 的 session 格式变化，realtime 的手动管理不会同步更新）。

3. **消除 model config 解析**：手动解析 `agentDefaults.defaults.model.primary` 并拆分 provider/model 是脆弱的（如果配置结构变化就断）。

### 可维护性降低

1. **`callGateway` 是黑盒**：出问题时不能在 handleHelpRequest 里单步调试。但 Gateway 有完善的日志和 event tracking。

2. **`callGateway` 的返回值格式**：需要理解 Gateway agent method 的二段式 respond（accepted + final）。`expectFinal: true` 已经封装了这个细节，但如果 Gateway 协议变化，需要适配。

3. **动态 import `callGateway`**：仍然需要 `importCoreModule("gateway/call.js")`，如果这个路径变化也会断。但这是一个文件 vs 原来的七个文件，风险大幅降低。

---

## 与 Upstream 耦合分析

### 当前耦合点（旁路方式）

realtime 插件 **深度耦合** OpenClaw 的 **7 个内部模块**：

```typescript
// core-bridge.ts 中的 7 个 importCoreModule 调用
1. "agents/agent-scope.js"      → resolveAgentDir, resolveAgentWorkspaceDir
2. "agents/defaults.js"         → DEFAULT_MODEL, DEFAULT_PROVIDER
3. "agents/model-selection.js"  → resolveThinkingDefault
4. "agents/pi-embedded.js"      → runEmbeddedPiAgent
5. "agents/timeout.js"          → resolveAgentTimeoutMs
6. "agents/workspace.js"        → ensureAgentWorkspace
7. "config/sessions.js"         → resolveStorePath, loadSessionStore, saveSessionStore, resolveSessionFilePath
```

这些都是 OpenClaw 的**内部实现细节**，不是公开 API。upstream 可以随时重构这些模块（重命名函数、改变参数签名、移动文件位置），每次都会导致 realtime 插件断裂。

**实际发生过**：这就是为什么 `core-bridge.ts` 有 195 行——它本质上是一个脆弱的 shim 层，把内部 API 稳定化。

### 重构后耦合点（主干道方式）

realtime 插件 **只耦合** OpenClaw 的 **1 个公开接口**：

```typescript
// 只需要一个 import
callGateway({ method: "agent", params: { message, idempotencyKey, lane, extraSystemPrompt } })
```

Gateway 的 `agent` method 是 OpenClaw 的**公开协议**（WebSocket API），被 webchat、CLI、移动端、第三方集成共同使用。upstream 会谨慎维护其兼容性。

**如果 capsule 也改用 Gateway**：耦合进一步降为 **0 个内部模块 + 1 个公开 API**。

### 耦合对比

| 维度 | 旁路方式 | 主干道方式 |
|------|---------|----------|
| 耦合的模块数 | 7 个内部模块 | 1 个公开 API |
| API 稳定性 | 内部实现，随时可变 | 公开协议，向后兼容 |
| upstream 重构影响 | 高（任何内部模块变化都可能断） | 低（只有协议变化才影响） |
| 适配工作量 | 每次 upstream 更新都要检查 7 个模块 | 几乎不需要适配 |
| core-bridge.ts | 195 行 hack shim | ~40 行或删除 |

**结论：与 upstream 的耦合显著降低，不是加深。**

---

## 诚实的总结

### 这个重构真正解决的问题

1. **跨通道上下文共享**（S2）— 显著提升
2. **对话历史统一**（S3）— 显著提升
3. **代码量和维护负担**（core-bridge 精简）— 显著提升
4. **与 upstream 耦合**（7 个内部模块 → 1 个公开 API）— 显著降低

### 这个重构没有真正解决的问题

1. **提醒推送到 Her 前端**（S1）— 没有直接解决。重构让提醒 job 跑在 main session，但提醒触发后 heartbeat 投递到 lastChannel（Telegram），Her 不会收到。需要额外的 Gateway event 监听才能让 Her 在线时收到推送。

2. **Heartbeat 主动推送到 Her**（S3）— 同上。Her 不是传统通道，不更新 lastRoute，heartbeat 不知道投递给 Her。

### 这个重构引入的新风险

1. **Main session 膨胀**（S6）— 需要监控。Her 频繁调用 openclaw_help 会增加 main session 的对话量。
2. **Gateway 单点故障扩大**（S8）— 轻微。Her 基本对话原来不依赖 Gateway，重构后依赖。
3. **调试间接性**（S9）— 日常更好，排查更间接。

### 最终评估

**值得做**。核心收益（耦合降低、代码精简、上下文共享）远大于风险（延时微增、session 膨胀可控、Gateway 依赖可接受）。

但要诚实：**提醒推送到 Her 前端不是这个重构能直接解决的**，需要额外的 P1 增强（Gateway event 监听）。

---

## 多用户隔离（Multi-Agent）

### 设计目标

支持 N 个用户同时使用同一个 gateway 的 realtime 插件，每个用户独立记忆、独立会话，互不干扰。用于厂商联调时给不同工程师各自一个独立的 Her 实例。

### 实现方案

通过 URL query param `?agentId=xxx` 贯穿 WebSocket、Bootstrap、Help Request 全链路：

```
用户 A（个人）: mobile.html?proxy=...&openclaw=...
  → agentId 缺省 = resolveDefaultAgentId(cfg) = "main"
  → workspace: ~/.openclaw/workspace/
  → 记忆: 完整个人画像

用户 B（厂商）: mobile.html?proxy=...&openclaw=...&agentId=user1
  → agentId = "user1"
  → workspace: ~/.openclaw/workspace-user1/
  → 记忆: 空（全新用户）
```

### 数据流

```
Frontend                    RealtimePlugin                  OpenClawAgent
   │                              │                              │
   │ WS connect ?agentId=user1    │                              │
   ├─────────────────────────────→│ client.agentId = "user1"     │
   │                              │                              │
   │ GET /bootstrap?agentId=user1 │                              │
   ├─────────────────────────────→│ 读取 user1 的 USER.md        │
   │                              │ 生成 user1 专属 capsule      │
   │←─────────────────────────────┤                              │
   │                              │                              │
   │ help request "查天气"         │                              │
   ├─────────────────────────────→│ runAgent(agentId="user1")    │
   │                              ├─────────────────────────────→│
   │                              │ 使用 user1 的 workspace      │
   │                              │←─────────────────────────────┤
   │←─────────────────────────────┤                              │
```

### 隔离保证

| 维度 | 隔离方式 |
|------|---------|
| 工作区 | `resolveAgentWorkspaceDir(cfg, agentId)` → 每个 agent 独立目录 |
| Session | `resolveStorePath(cfg, { agentId })` → 每个 agent 独立 session store |
| Memory Capsule | `cachedCapsules` Map，per-agent 缓存，不会串 |
| 前端 Prompt | SYSTEM_PROMPT 不含用户特定信息，用户画像仅来自 capsule |

### 已修复的泄漏

1. **SYSTEM_PROMPT 硬编码用户名** — 移除了 `mobile-script.js` 和 `index.html` 中示例的具体姓名 `（如"天哥"）`
2. **Capsule 缓存全局共享** — `server.ts` 中从单一全局变量改为 `Map<agentId, capsule>`，防止 main 的记忆胶囊泄漏给其他用户
3. **Capsule session 历史污染** — capsule agent 复用持久 session，旧 session 中 agent 通过 `exec`/`find` 发现并读取了 main 用户的 workspace 文件，导致泄漏。修复：`live-memory-capsule-agent.ts` 每次生成 capsule 使用全新 session UUID

### 当前临时 Hack（容器化后可移除）

> 以下是软防护措施，依赖 prompt 指令而非操作系统级隔离。容器化部署后应移除这些 hack，改用文件系统物理隔离。

1. **Capsule prompt 禁止工具使用** — `live-memory-capsule-agent.ts` 的 prompt 中加了 `⚠️ 严禁使用任何工具（exec、read、memory_search 等）`，防止 agent 逃逸 workspace 边界搜索其他用户文件
2. **Capsule prompt 空材料短路** — 当 USER.md 和 MEMORY.md 都为空时，指示 agent 直接输出"暂无用户信息"，不进行任何搜索

**为什么需要这些 hack**：capsule 生成使用 `runEmbeddedPiAgent`，该 agent 拥有完整工具集（exec、read、write、memory_search），且工具未沙箱化到 workspace 目录。agent 可以通过 `find ~/.openclaw/` 发现并读取其他用户的文件。

**容器化后为什么可以移除**：每个容器有独立文件系统，`find` 只能看到容器内的文件，物理上不存在其他用户的数据。

### 使用方式（进程内多 Agent）

`start-mobile.sh` / `start-mobile.sh --random` 启动后自动输出多用户 URL，每个 URL 对应一个独立用户。默认不带 `agentId` 的 URL 是个人 Her（agent=main），与之前行为完全一致。

> 注意：进程内多 Agent 方案通过 prompt 级别隔离，适用于快速测试。生产部署推荐使用下方的容器化方案，提供操作系统级别的物理隔离。

### 已验证的测试结果（2026-02-08）

| 测试 | 问题 | 回答 | 隔离状态 |
|------|------|------|---------|
| user1 首次 | "你是谁，我是谁？" | "还不能确定你的名字" | 正确隔离 |
| user2 首次 | "你是谁，我是谁？" | "暂时还没有保存你的名字" | 正确隔离 |
| user1 再次 | "我是谁？" | "你好 test1" | 正确记忆 |
| user1 | "我喜欢喝什么？" | "没有记录过 test1 喜欢喝什么" | 正确隔离（不知道拿铁） |
| main（个人） | "我是谁？" | "你是天哥" | 个人 Her 完好 |
| main（个人） | "我喜欢喝什么？" | "拿铁，也爱喝龙井茶" | 个人 Her 完好 |

---

## 容器化部署（Docker）

### 设计目标

每个厂商用户 = 一个独立 Docker 容器 = 完全隔离的文件系统。不再需要 prompt 级别的防护 hack，容器物理隔离天然保证安全。

### 架构

```
你的 Mac
├── start.sh               → 个人 Her (Gateway:18789, Realtime:18790, Frontend:8000/8080)
├── start-mobile.sh         → 个人 Her 远程隧道（不变）
│
├── start-docker.sh         → 构建 Docker 镜像（一次构建，所有用户共享）
│
├── start-user.sh --id=1    → Docker 容器 carher-1 (GW:29001, RT:29002, FE:29003, WS:29004)
├── start-user.sh --id=2    → Docker 容器 carher-2 (GW:29011, RT:29012, FE:29013, WS:29014)
└── start-user.sh --id=N    → Docker 容器 carher-N (端口按规则分配)
```

### 端口分配方案

每个用户 N 使用 4 个连续端口，基址 = 29000 + (N-1) * 10：

| 用户 | Gateway | Realtime | Frontend | WS Proxy |
|------|---------|----------|----------|----------|
| User 1 | 29001 | 29002 | 29003 | 29004 |
| User 2 | 29011 | 29012 | 29013 | 29014 |
| User 3 | 29021 | 29022 | 29023 | 29024 |

个人 Her 的端口（18789/18790/8000/8080）完全不冲突。

### 脚本体系

#### `start.sh` — 个人 Her（修改）

- 移除自动弹浏览器（`open` 命令），改为统一打印所有 URL
- 其余逻辑不变

#### `start-docker.sh` — 构建镜像（新建）

```bash
./start-docker.sh              # 构建 carher:local 镜像
./start-docker.sh --rebuild    # 代码更新后强制重新构建
```

镜像包含完整的后端编译（`pnpm build`）、前端编译（`pnpm ui:build`）、Python 依赖。构建一次后所有用户容器共享。

#### `start-user.sh` — 用户容器管理（新建，核心）

```bash
./start-user.sh --id=1                  # 启动 user1 容器 + 远程隧道（默认）
./start-user.sh --id=1 --model=opus     # 启动 user1 容器，指定 Opus 模型
./start-user.sh --id=1 --local          # 启动 user1 容器（仅本地访问，不建隧道）
./start-user.sh --id=1 --down           # 停止 user1 容器
./start-user.sh --down                  # 停止所有用户容器
./start-user.sh --id=1 --logs           # 查看 user1 日志
```

执行流程：
1. 检查镜像是否存在（不存在则提示先 `start-docker.sh`）
2. 计算端口分配
3. **清理旧容器**（同 ID 自动 stop + rm，确保 `--model` 等参数生效）
4. 如有 `--model`，动态生成临时 `openclaw.json`（支持 sonnet/opus/haiku/gemini 等快捷名）
5. 启动 Docker 容器（`docker run`），挂载 Google Cloud 凭证和 OpenClaw 配置
6. 等待容器健康检查通过
7. **默认启动** 3 条 Cloudflare 随机隧道，打印手机一键 URL（`--local` 跳过）
8. Ctrl+C 时仅关闭隧道，容器保持运行；`--down` 才停止容器

#### `start-mobile.sh` — 个人远程访问（不变）

### 隔离保证

| 维度 | 保证 |
|------|------|
| 文件系统 | 每个容器独立文件系统，无法访问宿主机或其他容器的文件 |
| 记忆 | 容器内没有宿主的 USER.md / MEMORY.md |
| 配置 | 使用 `docker/carher-config.json`（Sonnet 模型），与个人配置无关 |
| 网络 | 各容器端口独立映射，互不冲突 |
| 数据持久化 | Docker volume `carher-{id}-data` 独立存储 |

**不需要进程内多 Agent 方案的 prompt hack**，因为容器内没有其他用户的文件可泄漏。

### 典型工作流

```bash
# 1. 构建镜像（首次或代码更新后）
./start-docker.sh

# 2. 启动个人 Her
./start.sh

# 3. 在另一个终端，启动厂商 user1（默认含远程隧道）
./start-user.sh --id=1
# → 打印手机可访问的 URL，发给厂商工程师

# 4. 启动 user2，指定使用 Opus 模型
./start-user.sh --id=2 --model=opus
# → 打印另一组 URL，发给另一个工程师

# 5. 停止 user1（Ctrl+C 只关隧道，以下命令关容器）
./start-user.sh --id=1 --down

# 6. 停止所有厂商容器
./start-user.sh --down
```

### 已验证的测试结果 — Docker 容器（2026-02-08）

容器 user1 通过 `start-user.sh --id=1 --random` 启动，使用 Sonnet 模型，通过手机远程隧道访问。

| 轮次 | 问题 | 回答 | 隔离状态 |
|------|------|------|---------|
| 第 1 轮 | "你是谁，我是谁？" | "我是 Her...你是谁呢？" | 正确隔离（不认识任何人） |
| 第 1 轮 | "你知道我是谁吗？" | "抱歉，还不知道你的名字" | 正确隔离 |
| 第 1 轮 | 自我介绍"林森"，要求后台记住 | Sonnet 写入 MEMORY.md | 正确（用 Sonnet 而非 Opus） |
| 第 2 轮 | "你知道我是谁吗？" | "你好林森！" | 正确记忆 |
| 第 2 轮 | "我即将加入 Autolink" | Sonnet 记录到 MEMORY.md | 正确 |
| 第 3 轮 | "你知道我是谁，我要去哪里？" | "你好林森，请问您需要前往 Autolink 吗？" | 正确（名字+公司都记住） |

容器内数据：USER.md 不存在（全新用户），MEMORY.md 仅有林森+Autolink 两条记录，零个人数据泄漏。个人 Her（天哥、拿铁、小胖子）数据完好无损。

### 多用户并发实测（2026-02-08）

同时运行 4 个 Docker 容器（carher-1 ~ carher-4）+ 个人 Her，3 位同事通过手机远程隧道实际使用。

| 用户 | 容器 | 姓名 | 使用内容 | 隔离验证 |
|------|------|------|---------|---------|
| User 1 | carher-1 | 林森 | 打招呼、自我介绍、确认身份 | MEMORY.md 仅记录林森+Autolink |
| User 2 | carher-2 (Opus) | Andy | 多轮天气查询（北京）、询问系统架构 | USER.md 记录 Andy/北京/Autolink |
| User 3 | carher-3 | 曹明 | 身份确认、**车控测试**（座椅加热 → 要求4档 → Her 回复最高3档 → 设为3档） | USER.md 仅记录曹明/Autolink |
| User 4 | carher-4 | — | 容器已启动，暂无交互 | 空白状态 |

**关键验证结果：**
- 3 位用户各自的 USER.md / MEMORY.md 完全独立，互不包含对方信息
- 用户 2 的天气查询能力正常（调用 help request → 后台 agent 查天气 → 返回结果）
- 用户 3 的车控功能正常（座椅加热、档位选择，含边界校验）
- per-user `--model` 参数生效（User 2 用 Opus，其余用默认 Sonnet）
- 个人 Her 数据完好无损，零泄漏

### 已发现的改进点：Agent Workspace 缺少 Car Her 专属知识

容器内 agent workspace（`/data/.openclaw/workspace/`）使用的是通用 OpenClaw 模板：

| 文件 | 内容 | 问题 |
|------|------|------|
| AGENTS.md | 通用 agent 行为指南 | 不知道自己是 Car Her |
| SOUL.md | 通用人格描述 | 无车载助手身份 |
| USER.md | 空模板（对话中逐步填充） | 正常 |
| IDENTITY.md | 空模板 | 无 Car Her 品牌定义 |
| TOOLS.md | 空模板 | 不了解车控能力范围 |

虽然 `docs/her/` 的架构文档物理存在于容器内（`/app/docs/her/`），但 agent 不知道这些文件的存在，不会主动读取。

**影响**：后台 agent（处理 help request 的 Claude）对 Car Her 的设计理念、架构、能力范围一无所知。语音交互能正常工作是因为 realtime 插件的 system prompt 和 tools 在代码层面生效，但后台 agent 缺乏上下文。

**待解决**：为 Docker 容器定制 workspace 初始文件（SOUL.md、AGENTS.md、TOOLS.md），注入 Car Her 专属身份和知识。

---

## TODO

### P0（核心重构）

- [ ] 重写 `handleHelpRequest`：用 `callGateway({ method: "agent" })` 替代 `runEmbeddedPiAgent`
- [ ] 精简 `core-bridge.ts`：移除不再需要的 core module imports（195 行 → ~40 行）
- [ ] 移除 `index.ts` 中的 `before_agent_start` hook（改用 `extraSystemPrompt` 参数）
- [ ] 测试：验证 Her → callGateway → main session → agent 流程跑通
- [ ] 测试：验证 Her 设置提醒 → cron 创建成功 → heartbeat 投递到 Telegram

### P1（增强 - 提醒推送到 Her）

- [ ] 在 realtime server 中新增 Gateway WebSocket 客户端，监听 main session 的 broadcast events
- [ ] 当 heartbeat/cron 产出回复时，如果 Her 在线，推送到 Her 前端 → Gemini 播报
- [ ] 增强 `prompt.ts`：加入提醒设置规范段落

### P1.5（可选精简）

- [ ] 将 `generateLiveMemoryCapsule` 也改用 `callGateway`，彻底消除 `core-bridge.ts`

### P2（长期 - 向 upstream 提议）

- [ ] `PluginRuntime` 增加 `callGateway` 方法，让插件不需要动态 import
- [ ] `agent` method 支持 `provider` 标记，让 heartbeat 能识别 Her 通道
- [ ] 监控 main session 文件大小，评估是否需要 session 分片策略
