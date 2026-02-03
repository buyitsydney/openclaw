# Realtime Voice Architecture

实时语音交互架构设计：Gemini Live + OpenClaw 双脑协作

## 设计原则

1. **极简**：Live 只需要 1 个 Tool，上下文自动同步
2. **无感**：Live 不需要关心记忆、同步，OpenClaw 自己是大脑
3. **零冲击**：不影响 OpenClaw 现有的 WebChat/Telegram 体验
4. **零侵入**：作为独立插件实现，不修改 OpenClaw 核心代码，方便同步上游更新

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
│    上帝视角：实时看到所有对话（WebSocket 自动收到）                           │
│    自主决策：自己判断要保存什么、要提醒什么                                   │
│    Live 不需要告诉它"请保存"，它自己是大脑！                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## WebSocket 自动同步

Live 与 OpenClaw 之间通过 WebSocket 长连接自动同步，Live 完全无感：

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
- 告诉 OpenClaw 保存什么

OpenClaw 自己判断：
- 这个信息要保存吗
- 有冲突要提醒吗
- 用户画像要更新吗
```

## System Prompt 同步

### Live 的 System Prompt 结构

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

# WebSocket 自动同步给 OpenClaw
# OpenClaw 自己判断：这是用户偏好变化！

OpenClaw:
  1. 更新 USER.md（偏好：咖啡）
  2. 判断：这影响 Live 对用户的认知
  3. 推送 System Prompt 更新给 Live

OpenClaw → Live (WebSocket):
  {
    type: "prompt_update",
    section: "user_profile",
    content: "用户偏好：喜欢咖啡，不喜欢茶..."
  }

Live: 更新自己 System Prompt 的用户画像部分
# 下次对话就知道用户喜欢咖啡了
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

# WebSocket 自动同步
# OpenClaw 自己判断：用户偏好变化，要保存！
# 更新 USER.md
# 推送 System Prompt 更新给 Live

# Live 不需要调用任何 tool！
```

### 场景 4：主动提醒

```
用户: "明天帮我订个会议室"
Live: "好的"

# OpenClaw 看到后，检查日程
# 发现：用户明天要出差北京！

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
