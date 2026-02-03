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
