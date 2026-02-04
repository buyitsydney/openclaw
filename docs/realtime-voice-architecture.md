# Realtime Voice Architecture

实时语音交互架构设计：Gemini Live + OpenClaw 双脑协作

## 设计原则

1. **极简**：Live 只需要 1 个 Tool（`openclaw_help(request)`），其余走自动事件流
2. **无感**：Live 不需要理解“同步协议细节”，但**并不等于**“永远不需要调用 tool”
3. **零冲击**：不影响 OpenClaw 现有的 WebChat/Telegram 体验
4. **零侵入**：作为独立插件实现，不修改 OpenClaw 核心代码，方便同步上游更新

## 重要纠偏：设计假设 vs 当前实现（必读）

本文件早期版本隐含了两个强假设：

- OpenClaw 会“实时看到所有对话并自主监督/记忆/提醒”
- Live 说“好的，记住了”即可，OpenClaw 会自动写入记忆并同步回 Live

**结合当前代码与运行日志，这两个假设在早期确实不成立；但现在已经补齐了“监督回路”。** 当前实现的真实行为是：

- `transcript` 会被记录（内存数组 + 打日志），并进入 turn 组装器
- 每次 `turn_complete`（或 user+live 形成完整 turn）都会触发一次后台 Supervisor Run（独立于 `help`）
- Supervisor Run 可能：
  - 写入 `USER.md` / `MEMORY.md`（从而触发 `prompt_update`）
  - 输出一条需要立刻提醒用户的短句（通过 `inject` 推送到前端）
  - 输出空/`NO_REPLY`（协议层视为“不提醒”，不会 inject）
- Live 的“system prompt 文本”和“tools/function declarations”属于两部分配置：  
  - 文本来自 `/api/realtime/bootstrap.systemPrompt`  
  - tools 定义来自 Gemini Live 的 setup payload（不在 system prompt 文本里）

因此，若目标是“OpenClaw 上帝视角监督（主动提醒/自动记忆）”，关键是让 transcript 流稳定地闭合为 turn，并在每个 turn 上触发 Supervisor Run（已实现；详见后文）。
## 系统参与者

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              用户                                            │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ 语音
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Gemini Live (前台)                                   │
│                                                                             │
│    职责：语音交互、简单对话                                                   │
│    Tool：openclaw_help(request)  ← 只有 1 个参数！                           │
│    上下文：WebSocket 自动同步（Live 无感）                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                      WebSocket 长连接（自动双向同步）
                                  │
┌─────────────────────────────────┴───────────────────────────────────────────┐
│                         OpenClaw (后台大哥)                                  │
│                                                                             │
│    现状：help 触发 Agent；同时每个 turn 会触发 Supervisor Run（可 inject/写记忆）│
│    目标：基于 transcript 的“轮次/回合”进行监督、记忆、提醒（已跑通可验证链路）  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## WebSocket 自动同步

Live 与 OpenClaw 之间通过 WebSocket 长连接传递事件流。

当前已实现的“自动流”：

- `transcript`（用户/Live 的转写文本）→ OpenClaw 插件接收并记录
- `help`（由 Live tool 调用触发）→ OpenClaw 插件调用后台 Agent 并返回结果
- `prompt_update`（当 USER.md/MEMORY.md 被写入时）→ 插件广播给 Live

当前已实现的“自动流”补齐项：

- OpenClaw 基于 transcript turn 自动监督（Supervisor Run）
- OpenClaw 主动 `inject`（已在 WS Frames 中验证可到达前端）

事件流示意如下：

```
┌─────────┐                           ┌─────────┐
│  Live   │ ─── user: "你好" ──────→  │OpenClaw │
│         │ ─── live: "你好天哥" ───→  │         │
│         │                           │ 实时    │
│  无感   │ ←── inject: "提醒..." ─── │ 看到    │
│  自动   │ ←── prompt_update ─────── │ 所有    │
└─────────┘                           └─────────┘

Live 不需要：
- 手动调用 sync
- 在 Tool 参数中传递对话上下文
- 把完整对话塞进 tool 参数（对话会通过 transcript 流送达）

OpenClaw 自己判断：
-（目标）这个信息要保存吗 / 有冲突要提醒吗 / 用户画像要更新吗
-（现状）只有在 help 时才会做上述判断
```

## System Prompt 同步

### Live 的 System Prompt 结构

重要：这里的 “System Prompt” 指**文本指令**。Gemini Live 的 tools/function declarations 是 setup payload 的另一部分配置，不会出现在该文本中。

```
┌─────────────────────────────────────────────────────────────────┐
│  ## 用户画像                                                     │ ← OpenClaw 同步
│  {来自 OpenClaw USER.md 的内容}                                  │
├─────────────────────────────────────────────────────────────────┤
│  ## 重要记忆                                                     │ ← OpenClaw 同步
│  {来自 OpenClaw MEMORY.md 的摘要}                                │
├─────────────────────────────────────────────────────────────────┤
│  ## 行为规则                                                     │ ← Live 特有，不同步
│  1. 日常对话直接回答                                             │
│  2. 复杂任务调用 openclaw_help                                   │
│  3. 收到后台回复后自然说出来                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 同步机制

| 内容 | 来源 | 同步方向 | 触发时机 |
|------|------|---------|---------|
| 用户画像 | OpenClaw USER.md | OpenClaw → Live | USER.md 更新时 |
| 重要记忆 | OpenClaw MEMORY.md | OpenClaw → Live | MEMORY.md 更新时 |
| 行为规则 | Live 特有 | 不同步 | - |

### 自动更新流程

```
用户: "我现在更喜欢喝咖啡了，不喝茶了"
Live: "好的，记住了"

# WebSocket transcript 自动同步给 OpenClaw（已实现）
# 监督回路会基于 turn 触发 Supervisor Run，可能写入 USER/MEMORY 或 inject。

OpenClaw:
  1.（已实现）监督回路触发后台 Supervisor Run 分析这一轮对话
  2.（已实现）Supervisor 决定是否写入 USER.md / MEMORY.md，或输出 inject 提醒文本
  3.（已实现）若文件被写入，插件广播 prompt_update 给 Live

OpenClaw → Live (WebSocket):
  {
    type: "prompt_update",
    section: "user_profile",
    content: "用户偏好：喜欢咖啡，不喜欢茶..."
  }

Live:（部分实现）收到 prompt_update 后更新前端缓存；是否“热更新到 Gemini Live 会话”需要单独实现
```

## OpenClaw 双模式设计

**核心：OpenClaw 根据请求来源自动切换模式，对现有体验零影响！**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              OpenClaw                                        │
│                                                                             │
│    请求来源判断：                                                            │
│    ├─ WebChat/Telegram → 直接模式（现有，完全不变！）                        │
│    └─ Realtime WebSocket → 后台模式（新增）                                 │
│                                                                             │
│    ┌─────────────────────────────┐    ┌─────────────────────────────┐       │
│    │      直接模式（现有）        │    │     后台模式（新增）         │       │
│    │                             │    │                             │       │
│    │  - 直接面向用户             │    │  - 面向 Live                │       │
│    │  - 输出直接给用户看         │    │  - 输出给 Live 说           │       │
│    │  - 现有 System Prompt       │    │  - 后台 System Prompt       │       │
│    │  - 完全不改动！             │    │  - 知道自己是后台支援者     │       │
│    └─────────────────────────────┘    └─────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 直接模式（现有，不变）

用户通过 WebChat、Telegram 等渠道直接和 OpenClaw 对话：

```
用户 (WebChat) → OpenClaw → 回复给用户

# 完全不受 Realtime 功能影响
# 现有体验保持不变
```

### 后台模式（新增）

用户通过 Live 语音交互，OpenClaw 在后台支援：

```
用户 (语音) → Live → (WebSocket) → OpenClaw (后台模式)
                                        │
                                        ↓
                                   返回给 Live 说的内容
```

### 后台模式 System Prompt

```markdown
# 你是后台支援者

你不直接与用户交流。前台有一个语音助手（Live）正在和用户实时对话。

## 你的角色
- 你是幕后的"大哥"，拥有上帝视角
- 你实时看到 Live 和用户的所有对话
- 你的回复是给 Live 说的，不是直接给用户的

## 当前对话
{REALTIME_CONVERSATION}

## 你需要做什么
1. 收到 help 请求时，执行任务，返回给 Live 说的内容
2. 自主判断是否需要保存记忆、更新用户画像
3. 发现需要提醒用户的事情时，主动推送给 Live

## 输出要求
- 直接输出希望 Live 说的内容
- 口语化，适合语音播报
- 简洁
```

## Live 配置

### System Prompt

```
你是天哥的语音助手。

## 用户画像
{USER_PROFILE}  ← OpenClaw 同步更新

## 重要记忆
{MEMORY_SUMMARY}  ← OpenClaw 同步更新

## 规则
1. 日常对话直接回答
2. 复杂任务 → 说确认语，调用 openclaw_help
3. 收到后台回复后自然说出来

后台会自己处理记忆等事情，你不用管。
```

### Tool 定义（只有 1 个！）

```javascript
const tools = [{
  name: "openclaw_help",
  description: "请求后台帮助处理复杂任务（搜索、计算、分析等）",
  parameters: {
    type: "object",
    properties: {
      request: { 
        type: "string", 
        description: "需要帮助的内容" 
      }
    },
    required: ["request"]
  }
}];

// 不需要传 conversation！
// OpenClaw 通过 WebSocket 已经知道所有上下文
```

## 信息流

### 场景 1：普通对话

```
用户: "你好"
Live: "你好天哥！"

# WebSocket 自动同步，OpenClaw 记录到 session
# Live 无感，不需要做任何额外操作
```

### 场景 2：需要帮助

```
用户: "北京天气怎么样"
Live: "好的，让我查一下"
Live: 调用 openclaw_help("查北京天气")

# OpenClaw 已经知道完整上下文（WebSocket 自动同步）
# 执行天气查询
# 返回：{ reply: "北京今天15度，晴" }

Live: 播报 "北京今天15度，晴"
```

### 场景 3：自动保存记忆

```
用户: "我现在喜欢喝咖啡了"
Live: "好的，记住了"

# 现状（已实现）：transcript 会被同步到 OpenClaw 插件并记录，并以 turn 为单位触发 Supervisor Run
# Supervisor Run 会自主判断：是否值得写入 USER/MEMORY（并不保证每次都写）
```

### 场景 4：主动提醒

```
用户: "明天帮我订个会议室"
Live: "好的"

# 目标：OpenClaw 在监督回路中看到这轮对话，检查日程并发现冲突/提醒点

OpenClaw → Live: {
  type: "inject",
  reply: "等等，你明天不是要去北京出差吗？会议是线上的吗？"
}

Live: 自然播报这句提醒
```

## API 设计（极简）

```typescript
// WebSocket /api/realtime/ws
// 建立连接后自动双向同步

// Live → OpenClaw（自动流，Live 无感）
type LiveMessage = 
  | { type: "transcript", role: "user" | "live", text: string }
  | { type: "help", request: string, callId: string }
  | { type: "turn_complete" }
  | { type: "gemini_event", event: string, data: unknown, timestamp: number }

// OpenClaw → Live
type OpenClawMessage =
  | { type: "help_result", callId: string, reply: string }
  | { type: "inject", reply: string }
  | { type: "prompt_update", section: string, content: string }

// HTTP（只需要 1 个）
// GET /api/realtime/bootstrap
// 返回初始 System Prompt
interface BootstrapResponse {
  systemPrompt: string;
  userProfile: string;
  memorySummary: string;
}
```

## 监督回路：把 transcript 变成行动（已实现）

如果目标是“Live 无感、OpenClaw 上帝视角后台监督”，必须在 `transcript` 流之上增加一个**监督回路**：

- **输入**：持续到达的 transcript（用户/Live 的文本转写）
- **触发**：以“轮次/回合（turn）”为单位触发，或节流触发（例如每 N 轮/每 T 秒）
- **处理者**：OpenClaw 后台 Agent（以后台支援者身份运行）
- **输出（动作）**：
  - 写入 `USER.md`（更新用户画像）
  - 写入 `MEMORY.md`（长期记忆摘要）
  - `inject`（立即提醒前台 Live）
  - 无动作（大多数日常对话）

当前实现已包含 transcript 驱动的监督触发：以 turn 为单位触发 Supervisor Run，并可选 inject / 写入 USER/MEMORY。

### 方案 B（推荐）：每一轮 user+live 都输入给 OpenClaw（上帝视角后台大哥）

目标：即使 Live 没有调用 `openclaw_help`，OpenClaw 也能基于实时对话**主动发现冲突/风险**，并通过 `inject` 反向提醒 Live 去确认用户。

典型例子：

```
用户: 开车去上次和王总喝酒的地方。
Live: 好的，是不是泰和酒店，我们预计 30min 到达。

# OpenClaw 在后台看到这一轮对话后发现：你 1 小时后有政府接待。
# OpenClaw → Live: inject 提醒用户确认行程冲突。
```

关键原则：

- **Live 无感**：Live 不需要“主动求助”才能触发后台监督
- **OpenClaw 被动接收**：每一轮对话（用户 + Live）会自动送达 OpenClaw
- **低成本可验证**：先只做“监督 + inject”，不强制写记忆、不强制热更新 prompt

### Turn（轮次）闭环：独立模块（可迭代，不影响其它功能）

为保证“每一轮 user+live 对话都输入给 OpenClaw”，需要一个最小的 Turn 闭环模块（turn assembler）。它只负责把流式 transcript 组合成稳定的“轮次”输入，不做业务决策。

**规则 1（只采 final/完成态 transcript）**：

- 只在“转写完成”的时刻把文本纳入 turn（避免增量转写的噪声/空内容）

**规则 2（turn 闭合条件：user + live 组成一轮）**：

- 典型闭合：收到一条 `user` final 后，再收到一条 `live` final，形成一个 turn
- Turn 组装逻辑必须是独立模块，后续可以不断迭代更聪明的闭合规则，但不应影响 WebChat/Telegram 等既有链路

**规则 3（inject 去抖/限频）**：

- 暂不实现（先跑通监督闭环与核心价值，再根据测试决定是否需要）

### 监督任务（Supervisor Run）：每个 turn 都触发一次“监督判断”

一旦 turn 闭合，立刻触发一次监督任务（不依赖 `openclaw_help`）：

- **输入**：本 turn（用户+Live 两行）+ 少量近期 turn（可选）+ OpenClaw 可用的记忆/日程/工具
- **输出**：协议层只关心三种结果
  - 空字符串：无需打断（不 inject）
  - `NO_REPLY`：静默 token（不 inject）
  - 其它任意非空文本：视为需要前台播报的一句话（通过 `inject` 发送）

然后插件将输出文本通过 WebSocket 发给 Live：

```json
{ "type": "inject", "reply": "你 1 小时后有政府接待，确认现在去泰和酒店是否来得及？" }
```

> 注意：这是“监督与纠错”，不是“代替 Live 完成所有任务”。真正需要执行复杂任务时，Live 仍可以使用 `openclaw_help`。

### Turn（轮次）边界必须被定义

文档后续将统一以 turn 为最小监督单位：

- 典型 turn：用户一句话（或一个转写完成事件）+ Live 一句回复（或一个转写完成事件）
- 如果只有用户语音没有 Live 回复，也应视为“未闭合 turn”（可超时闭合）

没有 turn 边界，就无法做到“每一轮自动同步并触发监督”的确定性行为。

## 文件与会话：到底会有几份 USER/MEMORY？

当前实现（以及 OpenClaw 默认运行方式）中：

- `~/.openclaw/workspace/USER.md` 与 `~/.openclaw/workspace/MEMORY.md` 是**单一版本**（workspace/agent 级别），不是 per-session
- 不同的对话 session 隔离主要体现在 `~/.openclaw/agents/<agentId>/sessions/*.jsonl`（会话日志）上
- `~/.openclaw/workspace/memory/YYYY-MM-DD.md` 是“按天记忆文件”，但当前 realtime 插件的 prompt_sync 只监控 `USER.md` 与 `MEMORY.md`，**不会自动同步按天文件**

因此，同一时间 WebChat 与 Live 并行对话时：

- 两边读取/写入的 USER/MEMORY 是同一套
- 但它们各自的 session 上下文（jsonl）是分开的

## 对现有系统的影响

| 组件 | 影响 | 说明 |
|------|------|------|
| WebChat 体验 | **零影响** | 直接模式不变 |
| Telegram 体验 | **零影响** | 直接模式不变 |
| 核心代码 | **新增模式** | 根据来源判断模式 |
| System Prompt | **新增模板** | 后台模式专用 |
| API | **新增端点** | /api/realtime/* |
| 记忆系统 | **复用** | USER.md, MEMORY.md |

### 代码变更

```
src/
├── realtime/                    # 新增目录
│   ├── websocket.ts             # WebSocket 服务
│   ├── mode.ts                  # 后台模式逻辑
│   ├── prompt-sync.ts           # System Prompt 同步
│   └── bootstrap.ts             # 初始化
│
├── agents/
│   └── system-prompt.ts         # 新增后台模式模板
```

## 技术实现：零侵入插件方案

### 为什么要零侵入？

CarHer 是 OpenClaw 的 Fork，需要定期同步上游 bugfix：

```
git fetch origin          # 拉取 openclaw 上游更新
git merge origin/main     # 合并 bugfix
```

**如果修改核心代码**：每次合并都可能冲突，维护成本高
**零侵入插件方案**：只在 `extensions/` 下开发，几乎不会冲突

### 插件架构

OpenClaw 已有完善的插件机制，Realtime 功能完全可以作为独立插件实现：

```
extensions/
├── voice-call/              # 已有插件（参考）
└── realtime/                # 新增插件（CarHer 专用）
    ├── openclaw.plugin.json # 插件 manifest
    ├── package.json
    └── src/
        ├── index.ts         # 插件入口
        ├── server.ts        # 独立 HTTP/WebSocket 服务器
        ├── prompt-hook.ts   # before_agent_start hook
        └── file-watcher.ts  # 监听记忆文件变化
```

### 插件能力对照

| 功能 | 实现方式 | 侵入核心代码？ |
|------|---------|--------------|
| WebSocket 端点 | 插件创建独立 HTTP 服务器 | **否** |
| 后台模式 System Prompt | `before_agent_start` hook | **否** |
| 监听 USER.md 变化 | chokidar 文件监听 | **否** |
| 广播给 Live 客户端 | 插件自己管理客户端连接 | **否** |

### 代码改动清单

| 位置 | 改动类型 | 冲突风险 |
|------|---------|---------|
| `extensions/realtime/` | **新增目录** | **无** |
| OpenClaw 核心代码 | **不改** | **无** |

### 关键代码示例

**1. 插件 Manifest**

```json
// extensions/realtime/openclaw.plugin.json
{
  "name": "realtime",
  "version": "0.1.0",
  "description": "Gemini Live + OpenClaw realtime voice integration",
  "main": "dist/index.js",
  "openclaw": {
    "minVersion": "2024.1.0"
  }
}
```

**2. 插件入口 - 注册服务和 Hook**

```typescript
// extensions/realtime/src/index.ts
import type { PluginAPI } from "openclaw/plugin-sdk";
import { startRealtimeServer } from "./server.js";
import { setupPromptHook } from "./prompt-hook.js";
import { setupFileWatcher } from "./file-watcher.js";

export async function activate(api: PluginAPI) {
  // 1. 启动独立的 WebSocket 服务器（参考 voice-call 插件）
  const server = await startRealtimeServer(api);
  
  // 2. 注册 before_agent_start hook（修改 System Prompt）
  setupPromptHook(api, server);
  
  // 3. 监听记忆文件变化
  setupFileWatcher(api, server);
  
  api.log.info("Realtime plugin activated");
}
```

**3. 独立 WebSocket 服务器**

```typescript
// extensions/realtime/src/server.ts
import http from "node:http";
import { WebSocketServer } from "ws";

export async function startRealtimeServer(api: PluginAPI) {
  const port = 18790; // 独立端口，不占用 Gateway 端口
  const clients = new Set<WebSocket>();
  
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("message", (data) => handleLiveMessage(api, ws, data));
    ws.on("close", () => clients.delete(ws));
  });
  
  httpServer.listen(port);
  api.log.info(`Realtime WebSocket server listening on port ${port}`);
  
  return { clients, broadcast: (msg) => clients.forEach(c => c.send(msg)) };
}
```

**4. before_agent_start Hook（修改 System Prompt）**

```typescript
// extensions/realtime/src/prompt-hook.ts
export function setupPromptHook(api: PluginAPI, server: RealtimeServer) {
  api.on("before_agent_start", async (event, ctx) => {
    // 判断是否来自 Realtime
    if (ctx.source !== "realtime") {
      return {}; // 不是 Realtime 请求，不修改
    }
    
    // 返回后台模式 System Prompt
    return {
      systemPrompt: buildBackendModePrompt(ctx),
    };
  });
}

function buildBackendModePrompt(ctx: AgentContext): string {
  return `
# 你是后台支援者

你不直接与用户交流。前台有一个语音助手（Live）正在和用户实时对话。
你的回复是给 Live 说的，不是直接给用户的。

## 当前对话
${ctx.realtimeConversation || "（暂无）"}

## 你需要做什么
1. 收到 help 请求时，执行任务，返回给 Live 说的内容
2. 自主判断是否需要保存记忆、更新用户画像
3. 发现需要提醒用户的事情时，主动推送给 Live

## 输出要求
- 直接输出希望 Live 说的内容
- 口语化，适合语音播报
- 简洁
`;
}
```

**5. 文件监听与推送**

```typescript
// extensions/realtime/src/file-watcher.ts
import chokidar from "chokidar";
import { readFile } from "node:fs/promises";

export function setupFileWatcher(api: PluginAPI, server: RealtimeServer) {
  const workspaceDir = api.workspace.getPath();
  const watchPaths = [
    `${workspaceDir}/USER.md`,
    `${workspaceDir}/MEMORY.md`,
  ];
  
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500 },
  });
  
  watcher.on("change", async (filePath) => {
    api.log.info(`Memory file changed: ${filePath}`);
    
    const content = await readFile(filePath, "utf-8");
    const section = filePath.includes("USER.md") ? "user_profile" : "memory";
    
    // 广播给所有 Live 客户端
    server.broadcast(JSON.stringify({
      type: "prompt_update",
      section,
      content: summarize(content), // 生成摘要
    }));
  });
}
```

### System Prompt 推送机制

**重要：推送是代码自动做的，不是 OpenClaw AI 调用 tool！**

```
OpenClaw 通过 write tool 写入 USER.md
       │
       │ chokidar 监听到文件变化
       ▼
插件检测到 USER.md 变化
       │
       │ 插件自己的 broadcast() 函数
       ▼
WebSocket 广播给 Live 客户端
```

### 冲突风险评估

| 场景 | 冲突概率 |
|------|---------|
| OpenClaw 更新核心代码 | **0%** - 我们不改核心 |
| OpenClaw 更新插件 API | **极低** - 插件 API 通常向后兼容 |
| OpenClaw 更新 extensions/ 目录结构 | **极低** - 我们在自己的 realtime/ 下 |

**结论：几乎不会和上游产生冲突！**

## 实现步骤

### Phase 1：插件骨架（1-2 天）

1. **创建插件目录**
   ```bash
   mkdir -p extensions/realtime/src
   ```

2. **插件 Manifest 和 package.json**
   - `openclaw.plugin.json`
   - 依赖：`ws`, `chokidar`

3. **独立 WebSocket 服务器**
   - 端口 18790（不占用 Gateway 端口）
   - 处理 Live 客户端连接

4. **验证**：Live 可以连接到插件的 WebSocket

### Phase 2：双向通信（2-3 天）

1. **Live → OpenClaw**
   - 接收对话 transcript
   - 接收 openclaw_help 请求
   - 转发给 OpenClaw Agent

2. **OpenClaw → Live**
   - 返回 help 结果
   - 推送 inject 消息

3. **before_agent_start Hook**
   - 判断请求来源
   - 注入后台模式 System Prompt

4. **验证**：完整的 help 调用流程

### Phase 3：自动同步（2-3 天）

1. **文件监听**
   - chokidar 监听 USER.md / MEMORY.md
   - 变化时生成摘要

2. **System Prompt 推送**
   - 广播 prompt_update 给 Live
   - Live 更新自己的 System Prompt

3. **对话记录**
   - 存入 OpenClaw session

4. **验证**：用户偏好变化能同步到 Live

### Phase 4：优化（可选）

1. **主动提醒机制**
2. **上下文压缩**
3. **多 Live 客户端支持**
4. **重连机制**

## 总结

```
核心设计：
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. Live 只有 1 个 Tool：openclaw_help(request)                             │
│  2. 上下文通过 WebSocket 自动同步，Live 无感                                │
│  3. OpenClaw 是大脑，自己判断保存、提醒                                     │
│  4. System Prompt 变化自动同步给 Live                                       │
│  5. 对现有 WebChat/Telegram 体验零影响                                      │
│  6. 零侵入插件方案，不修改 OpenClaw 核心代码                                │
└─────────────────────────────────────────────────────────────────────────────┘

代码结构：
┌─────────────────────────────────────────────────────────────────────────────┐
│  extensions/realtime/          ← 全部新代码都在这里                         │
│  ├── openclaw.plugin.json      ← 插件 manifest                             │
│  ├── src/                                                                  │
│  │   ├── index.ts              ← 插件入口                                  │
│  │   ├── server.ts             ← 独立 WebSocket 服务器                     │
│  │   ├── prompt-hook.ts        ← before_agent_start hook                  │
│  │   └── file-watcher.ts       ← 监听记忆文件变化                          │
│  └── package.json                                                          │
│                                                                             │
│  OpenClaw 核心代码              ← 完全不改！                                │
└─────────────────────────────────────────────────────────────────────────────┘

同步上游：
┌─────────────────────────────────────────────────────────────────────────────┐
│  git fetch origin              # 拉取 openclaw 上游更新                    │
│  git merge origin/main         # 合并（几乎不会冲突！）                     │
│  git push carher dev:main      # 推送到 CarHer                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 详细 TODO 清单

### OpenClaw 侧（插件开发）

#### Phase 1：插件骨架

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| O-1.1 | 创建插件目录结构 | `extensions/realtime/` | ✅ |
| O-1.2 | 编写 `openclaw.plugin.json` | `extensions/realtime/openclaw.plugin.json` | ✅ |
| O-1.3 | 编写 `package.json`，添加依赖 `ws`, `chokidar` | `extensions/realtime/package.json` | ✅ |
| O-1.4 | 编写插件入口 `index.ts` | `extensions/realtime/src/index.ts` | ✅ |
| O-1.5 | 实现独立 HTTP 服务器（端口 18790） | `extensions/realtime/src/server.ts` | ✅ |
| O-1.6 | 实现 WebSocket 连接管理 | `extensions/realtime/src/server.ts` | ✅ |
| O-1.7 | 实现 `/api/realtime/bootstrap` HTTP 端点 | `extensions/realtime/src/server.ts` | ✅ |
| O-1.8 | 添加日志输出，方便调试 | 所有文件 | ✅ |

#### Phase 2：双向通信

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| O-2.1 | 实现 WebSocket 消息解析（transcript/help） | `extensions/realtime/src/server.ts` | ✅ |
| O-2.2 | 实现 `transcript` 消息处理：存入对话上下文 | `extensions/realtime/src/server.ts` | ✅ |
| O-2.3 | 实现 `help` 消息处理：调用 OpenClaw Agent | `extensions/realtime/src/server.ts` | ✅ |
| O-2.4 | 实现 `before_agent_start` hook | `extensions/realtime/index.ts` | ✅ |
| O-2.5 | 实现后台模式 System Prompt 模板 | `extensions/realtime/src/prompt.ts` | ✅ |
| O-2.6 | 实现 `help_result` 响应返回给 Live | `extensions/realtime/src/server.ts` | ✅ |
| O-2.7 | 实现 `inject` 消息推送机制 | `extensions/realtime/src/server.ts` | ✅ |
| O-2.8 | 实现对话上下文管理（按客户端隔离） | `extensions/realtime/src/server.ts` | ✅ |

#### Phase 3：自动同步

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| O-3.1 | 实现 chokidar 文件监听 | `extensions/realtime/src/file-watcher.ts` | ✅ |
| O-3.2 | 监听 `USER.md` 变化 | `extensions/realtime/src/file-watcher.ts` | ✅ |
| O-3.3 | 监听 `MEMORY.md` 变化 | `extensions/realtime/src/file-watcher.ts` | ⬜ |
| O-3.4 | 实现文件内容摘要生成 | `extensions/realtime/src/file-watcher.ts` | ✅ (基础实现) |
| O-3.5 | 实现 `prompt_update` 广播 | `extensions/realtime/src/file-watcher.ts` | ✅ |
| O-3.6 | 实现对话存入 OpenClaw session | `extensions/realtime/src/server.ts` | ✅ |

#### Phase 4：健壮性

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| O-4.1 | 实现客户端心跳检测 | `extensions/realtime/src/server.ts` | ⬜ |
| O-4.2 | 实现连接断开重连处理 | `extensions/realtime/src/server.ts` | ⬜ |
| O-4.3 | 实现错误处理和日志 | 所有文件 | ⬜ |
| O-4.4 | 实现多客户端支持 | `extensions/realtime/src/context.ts` | ⬜ |
| O-4.5 | 添加配置项（端口、超时等） | `extensions/realtime/src/config.ts` | ⬜ |

---

### Live 侧（前端开发）

#### Phase 1：基础连接

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| L-1.1 | 创建 Live 前端项目目录 | `extensions/realtime/live-frontend/` | ✅ |
| L-1.2 | 复制 Gemini Live 官方 demo 代码 | `extensions/realtime/live-frontend/` | ✅ |
| L-1.3 | 实现连接 Gemini Live API | `extensions/realtime/live-frontend/frontend/geminilive.js` | ✅ |
| L-1.4 | 实现连接 OpenClaw Realtime WebSocket | `extensions/realtime/live-frontend/frontend/tools.js` | ✅ |
| L-1.5 | 实现 `/api/realtime/bootstrap` 调用 | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |
| L-1.6 | 初始化 System Prompt（从 bootstrap 获取） | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |

#### Phase 2：对话流转

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| L-2.1 | 实现用户语音输入捕获 | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |
| L-2.2 | 实现 Gemini Live 语音响应播放 | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |
| L-2.3 | 实现 `transcript` 消息发送到 OpenClaw | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |
| L-2.4 | 配置 `openclaw_help` Tool | `extensions/realtime/live-frontend/frontend/tools.js` | ✅ |
| L-2.5 | 实现 Tool 调用时发送 `help` 消息 | `extensions/realtime/live-frontend/frontend/tools.js` | ✅ |
| L-2.6 | 实现接收 `help_result` 并返回给 Gemini | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |

#### Phase 3：同步处理

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| L-3.1 | 实现接收 `inject` 消息 | `extensions/realtime/live-frontend/frontend/tools.js` | ✅ |
| L-3.2 | 实现 `inject` 内容注入 Gemini 上下文 | `extensions/realtime/live-frontend/frontend/script.js` | ⬜ (回调定义了但未完全实现) |
| L-3.3 | 实现接收 `prompt_update` 消息 | `extensions/realtime/live-frontend/frontend/tools.js` | ✅ |
| L-3.4 | 实现动态更新 Gemini System Prompt | `extensions/realtime/live-frontend/frontend/script.js` | ⬜ (存储了但未热更新) |

#### Phase 4：UI 体验

| ID | 任务 | 文件 | 状态 |
|----|------|------|------|
| L-4.1 | 实现连接状态显示 | `extensions/realtime/live-frontend/frontend/index.html` | ✅ |
| L-4.2 | 实现语音波形显示 | `extensions/realtime/live-frontend/frontend/script.js` | ✅ (Gemini demo 自带) |
| L-4.3 | 实现对话历史显示 | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |
| L-4.4 | 实现 Tool 调用状态显示 | `extensions/realtime/live-frontend/frontend/script.js` | ✅ |
| L-4.5 | 实现断线重连 UI 提示 | `extensions/realtime/live-frontend/frontend/script.js` | ⬜ |

---

## 测试方案

### 单元测试

| 测试 ID | 测试内容 | 测试文件 |
|--------|---------|---------|
| UT-1 | WebSocket 消息解析 | `extensions/realtime/src/message-handler.test.ts` |
| UT-2 | 后台模式 System Prompt 生成 | `extensions/realtime/src/prompt-hook.test.ts` |
| UT-3 | 文件变化摘要生成 | `extensions/realtime/src/summarizer.test.ts` |
| UT-4 | 对话上下文管理 | `extensions/realtime/src/context.test.ts` |

### 集成测试

| 测试 ID | 测试场景 | 预期结果 |
|--------|---------|---------|
| IT-1 | Live 连接 OpenClaw WebSocket | 连接成功，收到欢迎消息 |
| IT-2 | Live 发送 transcript | OpenClaw 收到并记录 |
| IT-3 | Live 调用 openclaw_help | OpenClaw 返回 help_result |
| IT-4 | 修改 USER.md | Live 收到 prompt_update |
| IT-5 | 修改 MEMORY.md | Live 收到 prompt_update |

### 端到端测试

| 测试 ID | 测试场景 | 步骤 | 预期结果 |
|--------|---------|------|---------|
| E2E-1 | 简单对话 | 1. 用户说"你好"<br>2. Live 回复 | Live 直接回复，OpenClaw 记录对话 |
| E2E-2 | Help 调用 | 1. 用户说"北京天气"<br>2. Live 调用 help<br>3. OpenClaw 返回结果 | Live 播报天气信息 |
| E2E-3 | 记忆同步 | 1. 用户说"我喜欢咖啡"<br>2. OpenClaw 更新 USER.md<br>3. 用户问"我喜欢什么" | Live 知道用户喜欢咖啡 |
| E2E-4 | 主动提醒 | 1. 用户说"明天订会议室"<br>2. OpenClaw 发现日程冲突 | Live 主动提醒用户 |
| E2E-5 | 断线重连 | 1. 正常对话中<br>2. 断开 WebSocket<br>3. 自动重连 | 重连后继续对话，上下文保持 |

### 手动验收测试

```bash
# 1. 启动 OpenClaw Gateway
pnpm openclaw gateway --verbose

# 2. 确认 Realtime 插件加载
# 日志应显示：[realtime] Realtime plugin activated
# 日志应显示：[realtime] WebSocket server listening on port 18790

# 3. 启动 Live 前端
cd apps/realtime-web && pnpm dev

# 4. 打开浏览器 http://localhost:3000

# 5. 执行测试场景（见下方验收清单）
```

---

## 验收标准

### Phase 1 验收：插件骨架

| 验收项 | 验收标准 | 验收方式 |
|-------|---------|---------|
| ✅ 插件加载 | Gateway 启动时日志显示 `Realtime plugin activated` | 查看日志 |
| ✅ WebSocket 服务 | 端口 18790 可访问 | `curl http://localhost:18790/health` |
| ✅ Bootstrap API | 返回初始 System Prompt | `curl http://localhost:18790/api/realtime/bootstrap` |
| ✅ WebSocket 连接 | 客户端可连接 | `wscat -c ws://localhost:18790/ws` |

### Phase 2 验收：双向通信

| 验收项 | 验收标准 | 验收方式 |
|-------|---------|---------|
| ✅ Transcript 接收 | 发送 transcript 消息，日志显示收到 | 发送 JSON 消息查看日志 |
| ✅ Help 处理 | 发送 help 消息，收到 help_result | 发送 JSON 消息检查响应 |
| ✅ 后台模式 | help 请求使用后台模式 System Prompt | 查看 Agent 日志 |
| ✅ 完整流程 | Live 说"查天气"，能收到天气结果 | 语音交互测试 |

### Phase 3 验收：自动同步

| 验收项 | 验收标准 | 验收方式 |
|-------|---------|---------|
| ✅ 文件监听 | 修改 USER.md 后日志显示检测到变化 | 编辑文件查看日志 |
| ✅ Prompt 更新 | 修改 USER.md 后 Live 收到 prompt_update | 检查 WebSocket 消息 |
| ✅ 记忆同步 | 告诉 AI 喜好变化，后续能记住 | 语音交互测试 |
| ✅ Session 记录 | 对话保存到 OpenClaw session | 查看 session 文件 |

### 最终验收：完整体验

| 验收项 | 验收标准 |
|-------|---------|
| ✅ 低延迟 | 日常对话响应 < 500ms |
| ✅ 智能升级 | 复杂问题能正确调用 OpenClaw |
| ✅ 记忆一致 | Live 和 OpenClaw 对用户认知一致 |
| ✅ 零影响 | WebChat/Telegram 体验不变 |
| ✅ 稳定性 | 连续对话 30 分钟无崩溃 |

---

## 调试命令

```bash
# 查看 Realtime 插件日志
pnpm openclaw gateway --verbose 2>&1 | grep realtime

# 测试 WebSocket 连接
wscat -c ws://localhost:18790/ws

# 测试 Bootstrap API
curl http://localhost:18790/api/realtime/bootstrap | jq

# 发送测试消息
wscat -c ws://localhost:18790/ws -x '{"type":"transcript","role":"user","text":"你好"}'

# 查看 OpenClaw session 文件
ls -la ~/.openclaw/agents/main/sessions/

# 查看 USER.md 内容
cat ~/.openclaw/workspace/USER.md
```

---

## 已知问题与下一步 TODO

### 2026-02-03 测试发现的问题

基于实际测试日志分析，闭环已完成，但存在以下需要优化的问题：

#### 问题 1：Transcript 内容为空

**现象**：
```
12:15:57 [plugins] [realtime] realtime:... | 用户: 
12:15:59 [plugins] [realtime] realtime:... | Live: 
```
日志中 `用户:` 和 `Live:` 后面的文本内容为空。

**原因**：前端发送 transcript 时，`text` 字段可能为空（增量转写时 `finished=true` 但 `text=""`)

**优先级**：中

**修复方案**：
- 前端累积转写文本，只在有实际内容时发送
- 或后端过滤空 transcript

---

#### 问题 2：重复的 Help 请求

**现象**：
```
12:29:50 [plugins] [realtime] Help request: 查询今天的天气
12:30:14 [plugins] [realtime] Help request: 查询今天的天气
12:30:34 [plugins] [realtime] Help request: 查询今天的天气
```
同一个请求被发送了 3 次。

**原因**：
1. 用户可能多次说了相同的话
2. Live AI 在等待期间重复调用 tool
3. 没有请求去重机制

**影响**：
```
12:30:52 [diagnostic] lane wait exceeded: waitedMs=38645 queueAhead=1
```
队列堆积导致等待时间增加。

**优先级**：高

**修复方案**：
- 添加请求去重（相同 callId 跳过）
- 添加节流机制（短时间内相同请求合并）
- 前端在等待响应时禁止重复调用

---

#### 问题 3：Agent 响应时间过长

**现象**：
```
waitedMs=38645  # 38秒
waitedMs=22751  # 22秒
waitedMs=33593  # 33秒
```

**原因**：OpenClaw Agent 执行复杂任务需要时间（网络请求、工具调用链）

**影响**：用户等待体验差，Live 可能在等待期间静默

**优先级**：中

**改进方案**：
- Live 在调用 help 后立即给用户反馈（"让我查一下..."）
- Agent 支持流式返回中间状态
- 添加超时机制和友好提示

---

#### 问题 4：Agent 偶发失败

**现象**：
```
12:36:08 [plugins] [realtime] Agent reply: 抱歉，我暂时无法处理这个请求。
```

**原因**：Agent 处理失败或超时

**优先级**：中

**修复方案**：
- 添加重试机制
- 更好的错误信息返回
- 记录失败原因便于调试

---

#### 问题 5：Session 隔离问题

**现象**：
```
12:29:21 Client connected: realtime:1770121761112-dc7rjc
12:29:50 Created new agent session: 18f7aedd-8308-4f43-97d6-245ace592e1c
...
12:31:39 Client disconnected: realtime:1770121761112-dc7rjc
12:31:41 Client connected: realtime:1770121901888-yb3uiv
12:32:01 Created new agent session: 0482a6cf-a992-42fa-81c4-849cad3443ff
```
每次重连都创建新的 Agent session。

**影响**：短时间内的对话上下文可能丢失

**优先级**：低

**改进方案**：
- 支持 session 恢复（前端传递上次 sessionId）
- 或使用持久化的 session 映射

---

#### 已验证正常工作的功能

✅ **核心闭环**：Live 语音 → OpenClaw 处理 → 结果返回 → Live 语音输出

✅ **Help 调用成功**：
```
12:16:37 Help request: 查询我是否有权限访问Apple Notes
12:16:50 Agent reply: 好消息：我确实有权限访问Apple Notes...
```

✅ **复杂任务处理**：
```
12:21:14 Help request: 今天最热门的科技新闻
12:21:42 Agent reply: 今天科技圈最热的几条新闻：OpenAI发布了Codex App...
```

✅ **记忆更新同步**：
```
12:33:53 Help request: 记录天哥老婆开始创业
12:34:09 File changed: USER.md
12:34:09 Broadcasting prompt_update for user_profile
12:34:23 Agent reply: 好的，已经记下来了。
```

---

### 下一步 TODO

| 优先级 | 任务 | 描述 |
|-------|------|------|
| 🔴 高 | 请求去重 | 防止同一 help 请求重复发送 |
| 🟡 中 | 空 transcript 过滤 | 跳过空内容的转写消息 |
| 🟡 中 | 等待期反馈 | Live 调用 help 后立即给用户语音反馈 |
| 🟡 中 | 错误处理 | Agent 失败时返回更友好的消息 |
| 🟢 低 | Session 恢复 | 支持断线重连后恢复上下文 |
| 🟢 低 | Prompt 热更新 | 收到 prompt_update 时实时更新 Gemini System Prompt |
| 🟢 低 | inject 实现 | 完善 OpenClaw 主动推送消息到 Live 的功能 |

---

### 2026-02-03 严重问题：Live AI 颠三倒四

#### 问题描述

用户连续问多个问题时，Live AI 回复内容混乱，答非所问。

#### 实际对话记录

```
用户: "你在吗?"
Live: "你好天哥，我在。有什么事吗？"

用户: "我们上次聊了什么?"
Live: "好的，让我查一下我们的记录。稍等。"
[Asking OpenClaw: 回忆并总结我们上次对话的主要内容]

用户: "北京和上海明天的天气对比一下两边的差值是多少?"
[Asking OpenClaw: 查询北京和上海明天的天气，并计算两地气温的差值]

[OpenClaw返回] 上次我们的对话主要围绕几个方面：TTS语音消息发送...会议纪要系统...自我升级...

用户: "你查了吗，我很急的，在线等。"
Live: "不好意思，刚才有点延迟。我正在处理你的请求，马上返回结果。好的，上次我们调试了TTS语音发送，开发了会议纪要系统，还讨论了我的自我升级。关于明天的天气，正在查询中，请稍等。"  ← 混着说了两个话题！

[OpenClaw返回] 明天北京最高13度，最低零度左右。上海最高17度，最低5度左右...

用户: "我们上一轮到底说了什么？我觉得你的回忆不对啊。"
[Asking OpenClaw: 重新确认并总结我们上一轮对话的实际内容]

[OpenClaw返回] 明天北京最高13度...  ← 这是天气的结果，不是"上一轮"的结果！

Live: "不好意思，我可能记错了。我们上一轮主要是讨论了北京和上海明天的天气和温差。"  ← 把天气结果当成了"上一轮对话"的答案！

[OpenClaw返回] 抱歉刚才搞混了。上一轮对话实际上是你让我查北京和上海明天的天气...  ← 正确的答案

Live: "抱歉，我刚才弄混了。我们上一轮对话是关于北京和上海明天的天气和温差的。"
```

#### 根本原因：callId 是 undefined

**关键日志**：
```javascript
script.js:404 Calling function openclaw_help (id: undefined) with parameters: {"request":"上海的天气"}
```

Gemini Live API 返回的 `FunctionCall` 没有 `id` 字段（根据官方文档，`FunctionCall.id` 是 **可选的**）。

**影响**：
1. 前端发送 `help` 请求时 `callId: undefined`
2. 后端返回 `help_result` 时 `callId: undefined`
3. **前端无法匹配请求和响应**
4. 当有多个并发请求时，Live AI 随机或按顺序处理结果，导致答非所问

#### OpenClaw 后端验证

后端处理完全正确！从 session 文件 `154c4645-4f47-4624-af11-8cf834debc3d.jsonl`：

| 请求 | OpenClaw 返回 | 正确性 |
|-----|-------------|-------|
| "回忆上次对话" | TTS、会议纪要、自我升级 | ✅ 正确 |
| "北京上海天气差值" | 北京13度/0度，上海17度/5度 | ✅ 正确 |
| "重新确认上一轮" | "上一轮是天气查询" | ✅ 正确 |

**问题 100% 在前端的请求-响应匹配逻辑！**

#### 修复方案

前端自己生成 `callId`（UUID），不依赖 Gemini 返回：

```javascript
// tools.js
functionToCall(parameters, functionCallId) {
  // 如果 Gemini 没给 id，前端自己生成
  const callId = functionCallId || crypto.randomUUID();
  this.openclawConnection.sendHelp(request, callId);
  return { pending: true, callId };
}
```

然后在 `onHelpResult` 回调中根据 `callId` 匹配对应的请求。

#### 优先级

🔴 **严重** - 多轮对话基本不可用

---

### 2026-02-03 问题：Memory 不自动写入

#### 问题描述

今天（2/3）的所有对话都没有被写入 memory 文件。

```bash
ls /Users/buyitian/.openclaw/workspace/memory/
# 只有 2026-02-02.md，没有 2026-02-03.md
```

#### 原因分析

从 session 日志看，OpenClaw Agent **没有调用 write 工具写 memory**。

`prompt.ts` 第 23 行写着：
```
2. 自主判断是否需要保存记忆、更新用户画像
```

Agent 自主判断这些对话（天气查询等）不够重要，不需要记忆。

#### 影响

临时性对话不会被记录，用户问"刚才说了什么"时可能得不到正确答案。

#### 优先级

🟡 中 - 可能是预期行为，取决于对话重要性判断

---

## 实现状态总览（以当前代码/日志为准）

| 能力 | 目标 | 当前实现状态 | 备注 |
|------|------|-------------|------|
| transcript 自动同步到 OpenClaw | ✅ | ✅ 已实现 | 记录 + 参与 turn 组装 |
| help → OpenClaw Agent → help_result | ✅ | ✅ 已实现 | 这是当前唯一稳定的“触发大脑”路径 |
| OpenClaw 基于 transcript 自动监督/记忆 | ✅ | ✅ 已实现 | Supervisor Run 以 turn 为单位触发（可写 USER/MEMORY） |
| OpenClaw 主动 inject 提醒 Live | ✅ | ✅ 已实现 | 已在 WS Frames 中验证前端可收到 inject |
| USER.md/MEMORY.md 变更 → prompt_update | ✅ | ✅ 已实现 | 只监控这两个文件 |
| prompt_update 热更新到 Gemini Live 会话 | ✅ | ⚠️ 未完成 | 目前只更新前端缓存，未必影响 live 会话 |
| 多并发 tool call 的请求-响应匹配 | ✅ | ✅ 方案已明确 | 必须使用稳定 callId（自生成） |
