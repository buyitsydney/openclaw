# 飞书通道架构设计

通过飞书（Lark）机器人与 OpenClaw 对话，让用户在飞书客户端内获得 AI 助手体验。

**状态：已实现并验证通过 (2026-02-09)**

## 核心结论

- **对现有 OpenClaw 核心代码：零修改** -- 已验证
- **对现有 Her（realtime 插件）代码：零修改** -- 已验证
- **全部新增代码限制在 `extensions/feishu/` 目录内** -- 已验证
- **风险评估：极低** -- 已通过端到端测试确认
- **实际新增代码：~1800 行**（包含 cron 直投修复 + 富文本解析修复 + 图片收发 + 图片接收（vision）+ 目标解析 + 命令授权修复 + 富文本回复 + CardKit 流式卡片 + 群聊归档）

---

## 为什么飞书可行

飞书（Lark）是字节跳动的企业协作平台，其开放能力与 Telegram/Slack/Discord 处于同一级别：

- 官方 Bot API，完全开放，鼓励开发者接入
- 支持私聊（1 对 1 与机器人直接对话）和群聊
- 官方 Node.js/TypeScript SDK：`@larksuiteoapi/node-sdk`（活跃维护，每周更新）
- 支持 WebSocket 长连接（无需公网 IP / 备案域名）和 Webhook 两种模式
- 个人可免费创建飞书组织 + 在开放平台创建自建应用
- 零封号风险（官方 API，飞书鼓励这么做）

---

## 用户体验

### 最终效果（已验证）

用户在飞书客户端里，找到 AI 机器人，打开私聊窗口，直接发消息。体验与跟同事聊天完全一致：

```
用户（飞书私聊）: hi
机器人（飞书私聊）: 嗨天哥！你从飞书发消息过来了 🎉 飞书通道已经接通了！

用户（飞书私聊）: 你怎么知道我在用飞书呢？
机器人（飞书私聊）: 因为消息头里写着呢！[Feishu ou_4e2a42036050d192b367829818e700d5 ...]
```

### 配置流程（已验证）

> **注意：步骤顺序很重要！** 飞书的"长连接"事件订阅要求 SDK 客户端已在线才能保存，所以必须先启动 Gateway，再回飞书后台配置事件。

1. 在飞书开放平台（open.feishu.cn）创建一个自建应用，启用机器人能力
2. 获取 `app_id` + `app_secret`
3. 添加权限：`im:message` + `im:message:send_as_bot` + `im:resource` + `im:message.group_msg` + `im:message.p2p_msg:readonly` + `im:chat:readonly` + `cardkit:card:write`
4. 在 OpenClaw config 中配置 `channels.feishu.appId` + `channels.feishu.appSecret`
5. **先启动 Gateway**（飞书 WSClient 自动连接，日志显示 `Feishu WSClient connected`）
6. **回到飞书后台**：事件订阅 → 选"使用长连接接收事件" → 保存 → 添加 `im.message.receive_v1`
7. 创建版本 → 设置可用范围 → 发布
8. 在飞书里找到机器人，开始聊天

详细步骤见 [企业部署文档](her-feishu-bot-enterprise-deploy.md)。

---

## 架构设计

### 在 OpenClaw 通道体系中的位置

```
                        OpenClaw Gateway
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ Telegram │ │  Slack   │ │ Discord  │ │ WhatsApp │
  │(已有插件) │ │(已有插件) │ │(已有插件) │ │(已有插件) │
  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
       │            │            │            │
       └────────────┴────────────┴────────────┘
                         │
                   统一 Agent 管道
               (auto-reply pipeline)
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
  ┌────┴─────┐    ┌──────┴──────┐   ┌─────┴──────┐
  │  Feishu  │    │   Matrix    │   │    Line    │
  │  (新增)  │    │ (已有插件)  │   │ (已有插件) │
  └──────────┘    └─────────────┘   └────────────┘

  ┌──────────────────────────────────────────────────┐
  │      Her (realtime 插件) - 不受任何影响            │
  │      完全独立的实时语音通道                         │
  └──────────────────────────────────────────────────┘
```

**关键点：飞书插件与 Her 完全平行，互不影响。**

Her 是实时语音通道（Gemini Live + WebSocket），走的是快慢思考架构。
飞书是文字聊天通道，走的是标准 auto-reply pipeline（与 Telegram/Slack 相同）。
两者在 OpenClaw 内部是完全独立的通道，共享同一个 Agent 大脑和 Memory。

### 飞书插件实际文件结构

```
extensions/feishu/
  openclaw.plugin.json        # 插件清单
  package.json                # 依赖：@larksuiteoapi/node-sdk
  index.ts                    # 入口：register() -> api.registerChannel()
  src/
    channel.ts               # ChannelPlugin<ResolvedFeishuAccount> 实现
    runtime.ts               # PluginRuntime 单例存取
    gateway.ts               # WSClient 长连接 + 消息监听 + auto-reply pipeline 集成
    outbound.ts              # Lark.Client 消息发送（text / reply / image upload+send）
    accounts.ts              # 多账户解析 + 凭证解析（config / env）
```

### 数据流（已验证）

```
飞书用户
  │
  │ 发送消息（飞书客户端 -> 飞书服务器）
  ↓
飞书服务器
  │
  │ 事件推送（WebSocket 长连接）
  ↓
extensions/feishu/gateway.ts
  │
  │ EventDispatcher 接收 im.message.receive_v1 事件
  │ -> 提取文本 / 过滤 bot 消息 / 去重
  │ -> 构建 inbound context (finalizeInboundContext)
  ↓
OpenClaw auto-reply pipeline（核心代码，未修改）
  │
  │ dispatchReplyWithBufferedBlockDispatcher
  │ -> Agent 处理 -> 生成回复
  ↓
extensions/feishu/outbound.ts
  │
  │ Lark.Client.im.message.create()
  ↓
飞书服务器
  │
  │ 推送回复给用户
  ↓
飞书用户（收到回复）
```

---

## 实现细节

### 1. 插件注册（index.ts）

遵循 OpenClaw 标准插件模式：

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { feishuPlugin } from "./src/channel.js";
import { setFeishuRuntime } from "./src/runtime.js";

const plugin = {
  id: "feishu",
  name: "Feishu",
  description: "Feishu (Lark) channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
  },
};

export default plugin;
```

### 2. Gateway 适配器（gateway.ts）

使用 WebSocket 长连接模式（推荐，无需公网 IP）：

```typescript
const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    // 提取消息内容、过滤 bot、去重
    // 构建 ctxPayload -> finalizeInboundContext()
    // 调用 dispatchReplyWithBufferedBlockDispatcher() 进入 auto-reply pipeline
  },
});

const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.info });
await wsClient.start({ eventDispatcher });
```

核心 pipeline 集成方式（与 Google Chat 扩展相同）：
- `core.channel.routing.resolveAgentRoute()` -- 解析 agent 路由
- `core.channel.reply.finalizeInboundContext()` -- 构建标准 inbound context
- `core.channel.reply.dispatchReplyWithBufferedBlockDispatcher()` -- 进入 auto-reply pipeline
- `deliverFeishuReply()` -- 通过 Lark SDK 发送回复

### 3. 消息发送（outbound.ts）

`sendFeishuText` 通过 `resolveReceiveId()` 智能识别飞书 ID 类型：

```typescript
// 根据 ID 前缀自动推断 receive_id_type：
//   oc_ -> chat_id（群聊）, ou_ -> open_id（用户）, on_ -> union_id
// 同时自动 strip routeReply 可能添加的 "feishu:" 前缀
function resolveReceiveId(raw: string): { receiveId, receiveIdType }

export async function sendFeishuText(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  text: string;
}): Promise<void> {
  const client = getFeishuClient(params.account);
  const { receiveId, receiveIdType } = resolveReceiveId(params.chatId);
  await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, content: JSON.stringify({ text }), msg_type: "text" },
  });
}
```

Client 实例按 appId 缓存，避免重复创建和 token 获取。

#### 图片上传与发送（2026-02-07 新增）

`uploadFeishuImage` 使用原始 HTTP API（而非 SDK 封装）上传图片，`sendFeishuImage` 发送图片消息：

```typescript
// 使用原始 fetch 而非 SDK，因为 SDK 的 image_file 参数名与实际 API 的 image 不匹配
export async function uploadFeishuImage(params: {
  account: ResolvedFeishuAccount;
  buffer: Buffer;
}): Promise<string> {
  // 通过 SDK tokenManager 获取 tenant_access_token
  // 使用 FormData 上传：image_type="message", image=<blob>
  // 返回 image_key
}

export async function sendFeishuImage(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  imageKey: string;
  caption?: string;
}): Promise<void> {
  // 发送 msg_type="image" 消息
  // 如果有 caption，作为后续文本消息发送
}
```

### 3.1 Outbound 适配器（channel.ts outbound）

插件同时实现 `sendText`、`sendMedia` 和 `resolveTarget`，确保 cron 直投和 `message send` 工具都能正常工作：

```typescript
outbound: {
  deliveryMode: "gateway",
  resolveTarget: ({ to }) => {
    // 支持 feishu:/lark:/fs: 前缀，接受 oc_/ou_/on_ ID 格式
  },
  sendText: async ({ to, text, accountId, cfg }) => { ... },
  sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
    // 下载媒体 -> uploadFeishuImage -> sendFeishuImage
    // 失败时 fallback 为文本发送 URL
    if (text) await sendFeishuText({ account, chatId: to, text });
    return { channel: "feishu" };
  },
}
```

同时实现了 `messaging.targetResolver`，使 AI 的 `message send` 工具能正确识别飞书 ID（`oc_`/`ou_`/`on_` 前缀）。

**背景**：OpenClaw 的 cron 定时任务使用 `deliverOutboundPayloads` 直投路径（不经 gateway WebSocket），该路径要求通道同时实现 `sendText` + `sendMedia` 才视为已配置。AI 的 `message send` 工具需要 `resolveTarget` 和 `targetResolver` 来解析目标地址。

### 4. 配置存储

配置存储在 OpenClaw 标准 config 中，路径 `channels.feishu.*`：

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_xxxxxxxxxx",
      "appSecret": "xxxxxxxxxx"
    }
  },
  "plugins": {
    "entries": {
      "feishu": { "enabled": true }
    }
  }
}
```

也支持环境变量：`FEISHU_APP_ID` + `FEISHU_APP_SECRET`。

### 5. 权限需求

在飞书开放平台配置以下 7 个权限：
- `im:message` -- 获取与发送单聊、群组消息
- `im:message:send_as_bot` -- 以应用身份发消息
- `im:resource` -- 获取与上传图片或文件资源（图片收发所需）
- `im:message.group_msg` -- 获取群组中所有消息（敏感权限，群聊归档用）
- `im:message.p2p_msg:readonly` -- 读取用户发给机器人的单聊消息
- `im:chat:readonly` -- 获取群信息（获取群名，归档索引用）
- `cardkit:card:write` -- 创建与更新卡片（AI 流式回复打字机效果）

事件订阅：
- `im.message.receive_v1` -- 接收消息事件，使用长连接模式

---

## 对现有代码的影响分析

### 对 OpenClaw 核心代码：零修改（已验证）

- `src/channels/` -- 不修改。飞书通过 `api.registerChannel()` 动态注册
- `src/auto-reply/` -- 不修改。飞书走标准 auto-reply pipeline
- `src/config/` -- 不修改。插件配置由扩展自管理
- `src/cli/` -- 不修改。onboarding 通过 `ChannelPlugin.setup` 注入
- `src/infra/` -- 不修改。outbound 通过 `ChannelPlugin.outbound` 注入
- `src/plugin-sdk/` -- 不修改。使用现有 SDK 类型
- `src/routing/` -- 不修改。路由自动识别已注册的通道
- `package.json` -- 不修改。飞书 SDK 仅在 `extensions/feishu/package.json` 中

### 对 Her（realtime 插件）：零修改（已验证）

- `extensions/realtime/src/server.ts` -- 不修改。Her 的 WebSocket 服务独立运行
- `extensions/realtime/live-frontend/` -- 不修改。Her 前端完全不受影响
- `extensions/realtime/src/prompt.ts` -- 不修改。Her 的 system prompt 不变

### 实际代码量

| 文件 | 行数 | 说明 |
|------|------|------|
| `openclaw.plugin.json` | 9 | 插件清单 |
| `package.json` | 39 | 依赖 + 通道元数据 |
| `index.ts` | 17 | 入口注册 |
| `src/channel.ts` | 254 | ChannelPlugin 主体 + sendMedia 图片上传 + 目标解析 |
| `src/runtime.ts` | 14 | Runtime 单例 |
| `src/gateway.ts` | 733 | WSClient + pipeline 集成 + 富文本解析 + 回复投递 + 图片下载/接收 + CardKit 流式卡片 + 群聊归档 |
| `src/outbound.ts` | 667 | Lark SDK 消息发送 + ID 类型识别 + 图片上传/发送/下载 + Markdown→Post 转换 + CardKit API |
| `src/accounts.ts` | 133 | 账户 / 凭证解析 + 群聊主人 ID 解析 |
| **总计** | **~1800** | 全部在 `extensions/feishu/` 内 |

---

## 风险评估

### 技术风险：极低（已通过端到端测试验证）

- **破坏现有功能**：无。纯新增目录，不修改任何已有文件
- **飞书 API 稳定性**：极低风险。官方 API + 官方 SDK，字节跳动长期维护
- **封号 / 违规**：无。官方开放平台，鼓励开发者接入
- **SDK 维护状态**：良好。`@larksuiteoapi/node-sdk` 活跃更新
- **认证门槛**：极低。个人免费创建飞书组织 + 自建应用，无需企业资质
- **网络要求**：极低。WebSocket 模式无需公网 IP / 域名备案

### 与微信的对比

- **微信**：无官方 Bot API（个人号）；所有方案已死或高风险；封号率极高；需要企业资质 + 备案域名
- **飞书**：官方 API 完整开放；长期稳定；零封号风险；个人免费；WebSocket 无网络要求

---

## 多通道 Session 与消息路由分析

### Session 共享机制

当前配置 `dmScope = "main"`（默认），所有 DM 通道共享同一个 session key `agent:main:main`。这意味着飞书、Telegram、Webchat 发来的消息共享同一个对话历史和记忆。

OpenClaw 支持 4 种 `dmScope` 模式：

- `main`（当前）：所有通道共享一个对话。AI 跨通道记住所有内容
- `per-peer`：按用户隔离，同一用户跨通道仍共享
- `per-channel-peer`：按通道+用户隔离，飞书和 Telegram 各自独立
- `per-account-channel-peer`：最细粒度，按账号+通道+用户隔离

### 消息可见性（非对称设计）

Webchat（Control UI）扮演**全局监控面板**角色，通过 `broadcast("agent", ...)` 无条件接收 gateway 上所有 agent 活动。外部通道是独立的消息管道，不订阅 webchat 广播。

| 行为 | 结果 |
|------|------|
| 飞书发消息、收到回复 | 飞书能看到，**Webchat 也能看到**（广播机制） |
| Telegram 发消息、收到回复 | Telegram 能看到，**Webchat 也能看到** |
| Webchat 发消息、收到回复 | 只有 Webchat 能看到，飞书/Telegram **看不到** |

### 并发行为

当 agent 正在处理某个通道的消息时，其他通道的消息被排入 followup 队列。队列 drain 时通过 `routeReply()` 尝试将回复路由回原始通道。如果路由失败，回复会 fallback 到当前活跃的 dispatcher（通常是 webchat）。

实际影响：同时在 Webchat 和飞书聊天时，后到的消息可能被排队，回复可能出现在非预期的通道。

### 结论：保持默认配置

对于个人单用户场景，`dmScope = "main"` 是最佳选择：

- 跨通道共享记忆（飞书聊的内容，Webchat 里也知道）
- 只要避免同时在多个通道聊天，不会遇到并发冲突
- 如果未来需要同时多通道独立聊天，可改为 `per-channel-peer`，代价是失去跨通道记忆

---

## 已修复的问题

### Cron 定时任务投递修复 (2026-02-06)

**问题**：通过 cron 工具设置的飞书定时提醒无法投递，报 `Outbound not configured for channel: feishu`。

**根因**：
1. `deliverOutboundPayloads`（cron 直投路径）要求通道同时实现 `sendText` + `sendMedia`，飞书插件缺少 `sendMedia`
2. `sendFeishuText` 硬编码 `receive_id_type: "chat_id"`，但 cron payload 使用的是 `open_id`（`ou_` 前缀）

**修复**：
1. 在 `channel.ts` 添加 `sendMedia` 方法（文本投递，媒体暂不支持）
2. 在 `outbound.ts` 新增 `resolveReceiveId()` 函数，根据 ID 前缀自动识别类型

**验证**：修复后 cron 定时任务成功投递到飞书（`lastStatus: "ok"`）

### 飞书富文本（post）消息解析修复 (2026-02-07)

**问题**：用户在飞书中发送包含序号列表的消息（如 `1. xxx`）时，AI 完全收不到消息，被静默丢弃。

**根因**：
1. 飞书客户端会自动将包含序号/列表的文本从 `text` 类型转换为 `post`（富文本）类型
2. `extractTextContent` 只处理了 `text`/`image`/`file`/`audio`/`sticker`，未处理 `post` 类型
3. 初版修复错误地按**发送格式**（`{ zh_cn: { title, content } }` 带 locale 包裹）解析，但飞书**接收到的** `post` 消息结构是扁平的 `{ title, content: [[...]] }`，没有 locale 包裹

**教训**：发送和接收使用不同的 JSON 结构是外部 API 的常见陷阱。必须查阅官方文档确认接收格式，不能凭记忆或发送格式推断。

**修复**：
1. 新增 `flattenPostBody()` 函数解析 `{ title?, content: [[{tag,text}, ...]] }` 结构
2. `extractPostText()` 优先检查扁平格式（接收场景），兜底支持 locale 包裹格式
3. 支持 `text`、`a`（链接）、`at`（@提及）、`img`（图片）、`media`（视频）、`emotion`（表情）标签
4. 新增 debug 日志：未识别的消息类型会打印 `skipped msg: msgType=xxx` 便于后续排查

**验证**：修复后带序号的列表消息成功被 AI 接收并回复

**官方文档参考**：https://feishu.apifox.cn/doc-1945309（接收消息内容 - 富文本 post 结构）

### 图片收发 + 目标解析 (2026-02-07)

**新增功能**：

1. **图片上传与发送**：AI 现在可以通过飞书发送图片（如摄像头截图、生成的图片等）
2. **飞书目标解析器**：AI 的 `message send` 工具现在能正确识别飞书地址（`oc_`/`ou_`/`on_` 前缀）

**实现细节**：

- `outbound.ts`：新增 `uploadFeishuImage()`（原始 HTTP API 上传图片到飞书，返回 `image_key`）和 `sendFeishuImage()`（通过 `image_key` 发送图片消息，支持可选 caption）
- `gateway.ts`：`deliverFeishuReply()` 新增媒体处理逻辑 -- 下载媒体 URL → 判断是否为图片 → 上传到飞书 → 发送图片消息；非图片或失败时回退为文本
- `channel.ts`：
  - `sendMedia` 从纯文本回退升级为真正的图片上传发送
  - 新增 `messaging.targetResolver` 和 `outbound.resolveTarget`，支持 `feishu:`/`lark:`/`fs:` 前缀 + `oc_`/`ou_`/`on_` ID 格式

**踩坑记录**：

- Lark SDK 的 `client.im.image.create` 类型定义的参数名是 `image_file`，但飞书实际 API 要求的字段名是 `image`。SDK 类型与 API 不一致导致上传失败（`code: 234001, Invalid request param`）。最终绕过 SDK，使用原始 `fetch` + `FormData` 解决
- 需要额外的 `im:resource` 或 `im:resource:upload` 权限才能上传图片

**验证**：AI 成功通过飞书发送小米摄像头实时截图

### 图片接收与 Vision 识别 (2026-02-08)

**问题**：用户在飞书中发送图片时，AI 报告"只收到了 `[image]` 的占位符，实际图片没有传过来"，无法识别图片内容。

**根因**：

飞书发送"图片+文字"消息时，自动组装为 `post`（富文本）类型，图片以 `{tag: "img", image_key: "xxx"}` 嵌入。旧代码的 `flattenPostBody` 将 `img` 标签转为文本 `"[image]"` 占位符，未下载实际图片。单独发送图片时 `msgType="image"`，也仅返回 `"[image]"` 文本。两种场景下 AI 都只看到纯文字，无法进行 vision 处理。

**修复**：

1. `outbound.ts` 新增 `downloadFeishuImage()` -- 使用飞书 SDK 的 `client.im.messageResource.get()` API，通过 `message_id` + `image_key` 下载消息中的图片，返回 `Buffer` + `contentType`
2. `gateway.ts` 重构消息提取流程：
   - `extractTextContent()` / `flattenPostBody()` 新增 `imageKeys` 参数，解析时收集所有 `image_key`
   - `post` 富文本中的 `img` 标签和独立 `image` 消息的 `image_key` 统一收集
   - `handleInboundMessage()` 遍历收集到的 `imageKeys`，调用 `downloadFeishuImage` 下载、`saveMediaBuffer` 保存
   - 在 `ctxPayload` 中设置 `MediaPath`/`MediaType`/`MediaPaths`/`MediaTypes`
3. OpenClaw 下游的 `buildInboundMediaNote` + `applyMediaUnderstanding` 自动将图片传给 AI 的 vision 模型

**权限**：需要 `im:resource` 权限（获取与上传图片或文件资源）

**验证**：用户发送截图后，AI 成功识别图片内容（OpenRouter 账单截图，正确读出金额等信息）。日志链路完整：

```
[feishu] downloading image: key=img_v3_02un_... msg=om_x100b574b16d534acc...
[feishu] image saved: /Users/.../.openclaw/media/inbound/c8e7df25-....png
[feishu] inbound: chat=oc_... from=ou_... type=p2p +image
[agent/embedded] embedded run start: ... messageChannel=feishu
```

---

## 多用户飞书部署（Docker 容器 + 独立 Bot）

> **完整的企业部署方案（200 Bot + 200 Docker）、IT 操作流程、用户管理、费用估算**，详见：
> - [Her 飞书 Bot 企业部署](her-feishu-bot-enterprise-deploy.md) — 方案全貌 + IT 操作清单
>
> 以下仅保留本文档特有的隐私分析和开发记录。

### 隐私与安全分析

#### 当前个人飞书 Bot 的安全状态

| 配置项 | 当前值 | 风险 | 建议 |
|--------|--------|------|------|
| dm.policy | open（默认） | 如果在公司组织，同事可搜到 Bot 并进入你的 main session | 个人组织无风险；公司组织应设 allowlist |
| dmScope | main（默认） | 所有飞书用户共享同一个 session 和记忆 | 个人组织无风险；多人场景需改 per-peer |
| 可用范围 | 取决于开放平台设置 | "全部员工"意味着全公司可见 | 限制为仅自己 |

**已确认（2026-02-09）**：Bot 创建在**飞书个人版**组织，成员仅 Bob（所有者），无其他人。当前配置安全，不需要加 allowlist。

#### Docker 容器飞书 Bot 的安全保证

| 维度 | 保证 | 残留风险 |
|------|------|---------|
| 数据隔离 | 容器内独立文件系统，记忆互不可见 | 容器运行在你的 Mac 上，你有 root 权限可 docker exec 读取 |
| 飞书消息隔离 | 每个容器一个独立 Bot，消息管道完全分离 | 你作为 Bot 创建者可在开放平台查审计日志 |
| 访问控制 | dm.policy=allowlist 限制只有目标用户能使用 | 需要提前获取目标用户的飞书 open_id |
| 凭证安全 | 每个 Bot 的 appId/appSecret 只在对应容器内 | Bot 凭证由你保管和分发 |
| Google Cloud | 所有容器共享你的 gcloud 凭证 | 语音用量计在你的账户上 |

#### 各角色能做什么

| 操作 | 你（管理员） | 老板（使用者） | 其他人 |
|------|------------|--------------|--------|
| 跟老板的 Bot 对话 | 被 allowlist 拒绝 | 正常使用 | 被 allowlist 拒绝 |
| 读老板的对话记忆 | 技术上能（docker exec） | 自然产生 | 不能 |
| 读你的对话记忆 | 自然产生 | 不能 | 不能 |
| 停止/重启容器 | 能 | 不能 | 不能 |
| 查看 Bot 审计日志 | 能（开放平台） | 不能 | 不能 |

### 开发 TODO

> 企业部署相关的验证记录已迁移至 [her-feishu-bot-enterprise-deploy.md](her-feishu-bot-enterprise-deploy.md#已完成的验证2026-02-09)。

- [ ] **P1**: 支持 `--feishu-allow=ou_xxx` 参数设置 allowlist
- [ ] **P2**: 在 getting-started.md 中补充飞书 Bot 创建的详细截图指南

### 富文本回复 (2026-02-09)

**问题**：AI 回复中的 Markdown 格式（`**粗体**`、代码块等）在飞书中原样显示为纯文本符号。

**修复**：新增 `markdownToPost()` 转换函数 + `sendFeishuRichText()` 发送函数。检测文本是否包含 Markdown，有则转为飞书 Post 富文本消息（`msg_type: "post"`），无则保持纯文本（`msg_type: "text"`）。

**修改文件**：
- `outbound.ts` — 新增 `markdownToPost`、`parseInlineElements`、`hasMarkdown`、`sendFeishuRichText`（~140 行）
- `channel.ts` — `outbound.sendText` 和 `sendMedia` caption 改用 `sendFeishuRichText`
- `gateway.ts` — welcome 消息和 AI 回复 chunks 改用 `sendFeishuRichText`

**飞书 Post 富文本支持矩阵**（实测 2026-02-09）：

| 格式 | 支持 | 渲染效果 |
|------|------|---------|
| **粗体** `**text**` | 完美 | bold style |
| *斜体* `*text*` | 完美 | italic style |
| ***粗斜体*** `***text***` | 完美 | bold+italic style |
| 无序列表 `- item` | 完美 | bullet 前缀，支持嵌套 |
| 有序列表 `1. item` | 完美 | 数字前缀，支持嵌套 |
| 行内代码 `` `code` `` | 完美 | bold+反引号 |
| 代码块 ` ```lang ``` ` | 很棒 | code_block 标签，语法高亮+行号 |
| 链接 `[text](url)` | 完美 | a 标签，可点击 |
| 分隔线 `---` | 完美 | hr 标签 |
| Emoji | 完美 | 原生渲染 |
| ~~删除线~~ `~~text~~` | 不支持 | 原样显示 |
| 引用块 `> text` | 不支持 | 原样显示 |
| 表格 | 不支持 | 原样显示 |
| 标题层级 `## ###` | 降级 | 统一渲染为粗体（无大小区分） |

---

## ACK 超时与事件重推 Bug（2026-02-10 确认）

### 问题现象

Docker 容器中的飞书 bot 在容器重启后，反复收到"幽灵"欢迎消息。用户未发送任何指令，但 bot 在 +15s、+5min、+1h、+6h 反复触发 `/new` 处理并发送欢迎。

### 根因（已用诊断日志 100% 确认）

飞书 WebSocket SDK (`@larksuiteoapi/node-sdk`) 的 `handleEventData` 方法中，**先 `await` 用户 handler，再发 ACK**：

```
handleEventData():
  yield eventDispatcher.invoke(...)   // ← await 用户 handler
  this.sendMessage(ACK)               // ← handler 完成后才发 ACK
```

而我们的 handler 中 `await handleInboundMessage()` 包含了**完整的 AI 处理流程**（思考 + 生成 + 发送回复），耗时远超飞书的 ACK 超时窗口。

### 修复前诊断数据（2026-02-10 本地实测）

| 消息内容 | handler 耗时 | 飞书是否重推 | 重推间隔 |
|---------|-------------|------------|---------|
| "在吗"（简单对话） | **9,013ms** | 是 | +19s（首次重试） |
| "/new"（新会话） | **6,537ms** | 是 | +19s（首次重试） |
| "帮我查一下上海天气"（工具调用） | **27,107ms** | 是 | +19s（首次重试） |
| "在吗" 重试（trackMessageId 拦截） | **10ms** | 否 | - |
| "/new" 重试（trackMessageId 拦截） | **7ms** | 否 | - |
| "查天气" 重试（trackMessageId 拦截） | **7ms** | 否 | - |

**关键发现**：
- 飞书 WebSocket 的 ACK 超时窗口约 **3-5 秒**
- 所有正常消息的 handler 耗时均 **6-27 秒**，远超超时窗口 → ACK 永远迟到
- 内存去重 `trackMessageId` 能拦截重试消息（10ms 内返回），ACK 及时发出 → 重试链中断
- **容器重启 → 内存去重缓存清空 → 重试消息无法拦截 → 每次都走完整 handler → ACK 每次都超时 → 7.1 小时持续重推**

### 飞书事件重试间隔

| 重试次序 | 间隔 | 累计 |
|---------|------|------|
| 第 1 次 | +15 秒 | 15s |
| 第 2 次 | +5 分钟 | 5m15s |
| 第 3 次 | +1 小时 | 1h5m15s |
| 第 4 次 | +6 小时 | 7h5m15s |

### 修复方案

将 handler 注册从 `await`（同步等待）改为 `void`（异步触发不等待），让 SDK 在毫秒内发出 ACK：

```typescript
// 修复前（ACK 等 AI 处理完，6-27 秒）
"im.message.receive_v1": async (data) => {
  await handleInboundMessage(data, deps);  // 阻塞 ACK
}

// 修复后（ACK 立即发出，毫秒级）
"im.message.receive_v1": async (data) => {
  void handleInboundMessage(data, deps).catch(err => log(err));
  // handler 立即 return → SDK 发 ACK → 飞书确认 → 不再重试
}
```

### 修复后验证数据（2026-02-10 本地实测）

修复后发送 5 条消息（含断电重启场景），**零重试**：

| 消息内容 | msgId（后4位） | 是否被飞书重推 |
|---------|--------------|--------------|
| "/new" | f87c | 否 |
| "帮我看一下北京天气吧" | 4566 | 否 |
| "看一下无锡天气"（断电重启后） | e14b | 否 |
| "/reset" | 1612 | 否 |
| "/new" | 9416 | 否 |

**断电测试**：发送"北京天气"后立即断电重启。ACK 已及时发出（飞书不重推），但 AI 回复因进程被 kill 而丢失。这是 `void` 方案的已知代价——trade-off：**消除重复推送 vs 极端断电时可能丢一条回复**。

**状态：已修复（2026-02-10），修改文件 `extensions/feishu/src/gateway.ts`。**

### 后续可选加固

- 持久化 `trackMessageId`（写文件/volume），防止容器重启后缓存丢失
- 基于 `createTime` 过滤过期事件（>10min 的消息直接丢弃）

---

## Typing 指示器 / 流式回复

### v1 方案：占位消息 + message.update（已回退，2026-02-10）

**方案**：用户发消息后立即发一条"正在思考..."占位消息，AI 回复后用 `im.message.update()` 原地替换。

**回退原因（三个根本缺陷）**：

1. **"已编辑"标记**：飞书对任何被 `update` 过的消息都会自动标记"（已编辑）"，无法绕过。导致每一条 AI 回复都带"已编辑"标记
2. **连续消息产生多个 placeholder**：placeholder 在 `handleInboundMessage` 进入 dispatch 之前发送，但 session lane 是串行的。第 2 条消息还在排队等第 1 条处理完，用户已经看到了 2 个"正在思考..."——欺骗用户
3. **placeholder 被 tool result 消耗**：deliver 回调可能先收到没有 text 的 tool result payload，导致 placeholder 被白白消耗，真正的文本回复无 placeholder 可更新

**教训**：飞书没有 Telegram 的 `sendChatAction("typing")` 原生 API。用真实消息模拟 typing 不可行——"已编辑"标记、多 placeholder、消耗竞争等问题无法解决。

### v2 方案：CardKit 流式卡片 + 打字机效果（已实现，2026-02-10）

**核心发现**：飞书 `cardkit.v1` API 提供**官方的"打字机"效果**——`cardElement.content()` 方法的官方描述是"以传入的文本内容覆盖已有卡片组件内容，卡片将自动识别其中的增量变更内容，并以'打字机'效果输出"。

**技术确认（三层全部通过）**：

| 层 | 确认项 | 结果 |
|----|--------|------|
| OpenClaw 框架 | `onPartialReply` 回调（AI 每输出一个 token 就回调） | 已有，Telegram draft stream 用的就是这个 |
| 飞书 SDK | `cardkit.v1.card.create()` + `cardkit.v1.cardElement.content()` | SDK 1.58.0 已支持，类型定义完整 |
| 飞书 SDK | `im.message.create({ msg_type: "interactive" })` 发送卡片消息 | 已支持 |

**数据流（多段落场景）**：

AI 的一次回复可能包含多个 assistant message（中间穿插 tool call）。例如用户问"看一下 NV 的最新 twitter"，AI 可能输出：

- 段落 1："好的，帮你看看 NVIDIA 的最新推文。需要用浏览器抓取。" → 调用 browser tool
- 段落 2："浏览器不可用，尝试用 web_fetch..." → 调用 web_fetch tool
- 段落 3："成功拿到了数据。整理一下 NVIDIA 最近的推文：..."

每个段落是一个独立的 assistant message，每个 message 开始时 `deltaBuffer` 被 reset，因此 `onPartialReply` 的 `text` 是**段落内累积**，不包含前面段落的文本。

```
─── assistant message #1 ───
  onPartialReply(text="好的，帮你看看...") → cardStream.update("好的，帮你看看...")
  卡片显示: "好的，帮你看看 NVIDIA 的最新推文。需要用浏览器抓取。" ✅

─── tool call (browser) → tool result ───

─── assistant message #2 ───
  deltaBuffer reset!
  onPartialReply(text="浏览器不可用...") → 如果直接 update，会覆盖第一段！

  正确做法：维护跨段落累积变量 cardStreamAccumulatedText
    cardStreamAccumulatedText = "好的，帮你看看...\n\n" + "浏览器不可用..."
    → cardStream.update(cardStreamAccumulatedText)
  卡片显示: 第一段 + 第二段 ✅

─── tool call (web_fetch) → tool result ───

─── assistant message #3 ───
  deltaBuffer reset!
  cardStreamAccumulatedText = 前两段 + "\n\n" + "成功拿到了数据..."
  → cardStream.update(cardStreamAccumulatedText)
  卡片显示: 第一段 + 第二段 + 第三段 ✅

─── dispatch 完成 ───
  deliver(kind=final) x3 → 只更新 cardStreamFinalText 给 finalize 用
  注意：deliver 不再调用 cardStream.update()，因为 onPartialReply 已完成流式展示
  → finalize(cardStreamFinalText): card.settings(streaming_mode=false)
  → 飞书自动移除"[生成中...]"标记，回落到卡片内容的自动摘要
```

**已发现的 bug 及修复（2026-02-10）**：

| Bug | 根因 | 修复 |
|-----|------|------|
| 多段落时后一段覆盖前一段，中间内容丢失 | `onPartialReply` 的 text 是段落内累积（每个 assistant message 开始时 deltaBuffer reset），直接写入卡片会覆盖前面段落 | `updateCardStream` 内检测段落边界（新 text 不以上一次 text 为前缀 → 新段落），将前一段冻结到 `cardStreamPrefix`，写入 `prefix + 当前段落` |
| 最后所有段落又从头到尾 stream 一遍 | `deliver` 在整个 turn 结束后才批量调用（不是每段之间），每次都调 `cardStream.update()` + `flush()`，重复写入已经流式展示过的内容 | `deliver` 不再调用 `cardStream.update()`，只累积 `cardStreamFinalText` 给 finalize 用 |
| 聊天列表预览卡在"正在回复中..."不消失 | 创建卡片时设置了自定义 `summary.content: "正在回复中..."`，这是独立持久化字段，关闭 streaming_mode 不会自动清除 | 创建卡片时**不设** `summary.content`。飞书默认的"[生成中...]"由 `streaming_mode` 控制，关闭后平台自动移除，自动回落到卡片内容的摘要 |
| 回复末尾内容截断（最后几个 token 丢失） | `onPartialReply` 可能未收到最后一小段文本（AI 最后的 token 直接通过 `deliver` 发出），而 `deliver` 只累积不更新 card | `stopCardStream` 中 `stop()` 后用 `sendFinal(cardStreamFinalText)` 直接推送完整文本，绕过 throttle/inFlight 机制 |
| "[生成中...]"偶发不消失（竞争条件） | `flush()` 在 `inFlight=true` 时 schedule 延迟 flush 然后立即 return，导致 `finalize(streaming_mode=false)` 先于延迟的 content update 到达飞书，飞书收到更高 sequence 的 content update 后可能重新激活 streaming 状态 | `stopCardStream` 先调 `stop()`（取消 timer + 阻止新 update），再用 `sendFinal` 直接 await 推送完整文本（无竞争），最后 `finalize`。保证 sequence 顺序：`sendFinal(N)` → `finalize(N+1)` |

**修复后的变量协作**：

```
gateway.ts 中的关键变量：
  cardStreamPrefix = ""       // 已完成段落的累积文本
  cardStreamLastPartial = ""  // 上一次 onPartialReply 的 text（用于检测段落边界）
  cardStreamFinalText = ""    // deliver 累积的完整文本（给 finalize 用）

updateCardStream(text):  // 由 onPartialReply 调用
  // 段落边界检测：如果 text 不以 lastPartial 为前缀，说明新 assistant message 开始了
  if (lastPartial && !text.startsWith(lastPartial)):
    cardStreamPrefix += "\n\n" + lastPartial   // 冻结上一段到 prefix
  cardStreamLastPartial = text
  cardStream.update(prefix + "\n\n" + text)    // 写入完整内容

deliver(payload, kind=final):
  // turn 结束后批量调用（不是每段之间），只累积文本给 finalize 用
  cardStreamFinalText += "\n\n" + payload.text
  // 不调用 cardStream.update()！onPartialReply 已经展示过了

stopCardStream():
  stop()                                    // 1. 取消 timer + 阻止新 update（防止 stray flush）
  sendFinal(cardStreamFinalText)            // 2. 直接推完整文本（绕过 throttle/inFlight）
  finalize(cardStreamFinalText)             // 3. card.settings(streaming_mode=false)
  → 飞书自动移除"[生成中...]"标记，回落到卡片内容的自动摘要
```

**关键：必须设置 `disableBlockStreaming: true`**

对齐 Telegram 模式。如果不设置，agent 配置 `blockStreamingDefault: "on"` 时，`onBlockReply` 和 `onPartialReply` 会同时驱动 card stream，导致文本重复/闪烁。设置后：
- `onBlockReply` 不会被调用（block pipeline 不创建）
- `onPartialReply` 正常调用，独占驱动打字机
- `deliver` 只收到 `kind="final"` payload

代码：`replyOptions: { disableBlockStreaming: !isCommand }`（Telegram 同理：`disableBlockStreaming: Boolean(draftStream)`）

**关键：不设自定义 `summary.content`，只用 `streaming_mode` 控制聊天列表预览**

飞书官方文档（https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview）FAQ：

- **`streaming_mode` 控制"[生成中...]"标记**：开启时聊天列表预览显示"[生成中...]"，关闭后自动消失，飞书回落到卡片内容的自动摘要。
- **`summary.content` 是独立持久化字段**：如果设了自定义 summary（如"正在回复中..."），关闭 streaming_mode **不会清除**它。必须手动更新，且飞书客户端可能缓存旧值。

正确做法：创建卡片时**不设 `summary.content`**，finalize 只关 `streaming_mode`：

```
cardkit.v1.card.settings({
  path: { card_id },
  data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence }
})
```

**与 Telegram 的对比**：

| 维度 | Telegram | 飞书 |
|------|----------|------|
| 原生 typing API | `sendChatAction("typing")`（顶部状态栏） | 无 |
| 流式文本 | `sendMessageDraft()`（OpenClaw 自实现的 hack，私聊+topics 限定） | `cardkit.cardElement.content()`（官方 API，原生打字机动画） |
| 效果 | draft 消息逐步更新（非官方） | 卡片内容逐字出现（官方打字机效果） |
| 最终样式 | 普通文本气泡 | 卡片样式（有边框） |
| 流式结束 | draftStream.stop() | card.settings(streaming_mode=false) |
| 禁用 block streaming | `disableBlockStreaming: Boolean(draftStream)` | `disableBlockStreaming: !isCommand` |

**接入 TypingController**：走 OpenClaw 内置的 `ReplyDispatcherWithTypingOptions.onReplyStart` 回调。typing 由 `TypingSignaler.signalRunStart()` 触发——在 `runReplyAgent` 内部（已进入 session lane 之后）才触发，不会为排队中的消息发 typing。解决了 v1 的"多 placeholder"问题。

**额外权限**：需要 `cardkit:card:write`（创建与更新卡片实例），已包含在 7 个标准权限中

---

## 后续增强方向

当前实现覆盖了核心聊天 + 定时任务 + 富文本 + 图片收发功能，以下为可选增强：

1. ~~**富文本回复**~~：已实现（2026-02-09）-- Markdown -> 飞书 Post 格式转换，见上方"富文本支持矩阵"
2. ~~**图片/文件收发**~~：已实现（2026-02-07 发送，2026-02-08 接收+vision）-- 双向图片支持
3. ~~**Typing / 流式回复**~~：已实现（2026-02-10）-- CardKit 流式卡片 + 打字机效果，见上方"v2 方案"
4. ~~**群聊支持**~~：已实现（2026-02-10）-- 群消息归档 + 主人@bot回复 + 非主人静默，见下方「群聊支持设计」章节
5. **Onboarding CLI**：`openclaw setup` 交互式引导配置飞书凭证
6. **状态探测**：`openclaw channels status` 显示飞书连接状态
7. **企业多用户部署**：见 [her-feishu-bot-enterprise-deploy.md](her-feishu-bot-enterprise-deploy.md)（200 Bot + 200 Docker 方案，已验证）

---

## 群聊支持设计

### 核心原则

Her 是专属私人秘书，**绝对不可以对外和主人以外的任何人沟通**。群聊支持的目标不是让 Her 参与群聊讨论，而是：

1. **归档**：Her 静默监听群消息，归档到本地，主人随时可在私聊中让 Her 总结/查询群聊内容
2. **主人指令**：主人在群里 @Her 时可以回复（仅限主人）
3. **安全隔离**：非主人 @Her 完全沉默，不做任何回复

### 消息处理流程

```
群聊消息到达（需 im:message.group_msg 权限，收所有消息）
  │
  ├─ 所有消息 → 无条件归档到 JSONL（含 sender 名字、文本、时间戳）
  │
  ├─ 主人 @Her → 归档 + 在群里引用回复（quote-reply）
  ├─ 非主人 @Her → 归档 + 完全沉默（绝不回复）
  └─ 任何人未 @Her → 归档 + 沉默

主人在私聊中问 "帮我看看产品群今天聊了什么"
  │
  Her → 通过 skill/tool 读取归档文件 → 总结返回给主人
```

### 主人身份识别

通过配置指定主人的飞书 open_id：

- 优先使用 `groups.ownerIds: ["ou_xxx"]`
- 如果未配置，fallback 到 `dm.allowFrom`（单聊白名单，通常就是主人）
- 大部分用户只需配 `dm.allowFrom` 即可，群聊自动复用

### 归档存储

#### 存储位置

```
~/.openclaw/feishu-groups/
├── index.json                    # 群索引
│   {
│     "oc_abc123": { "name": "产品讨论群", "lastMessage": "2026-02-06T15:30:00Z" },
│     "oc_def456": { "name": "技术架构群", "lastMessage": "2026-02-06T14:20:00Z" }
│   }
├── oc_abc123/
│   └── messages.jsonl            # 每行一条 JSON
└── oc_def456/
    └── messages.jsonl
```

#### JSONL 消息格式

```json
{"ts":1707235200,"sender":"张三","senderId":"ou_xxx","text":"明天开会记得带材料","msgId":"om_xxx"}
{"ts":1707235260,"sender":"李四","senderId":"ou_yyy","text":"收到，我准备一下PPT","msgId":"om_yyy"}
```

#### Docker 容器持久化

归档目录在 `~/.openclaw/feishu-groups/` 下，位于 Docker named volume 内：

```
-v "carher-${USER_ID}-data:/data/.openclaw"
```

- Named volume 由 Docker 管理，**容器删除重建（docker rm + docker run）不影响数据**
- 镜像重新 build（docker build）不影响数据
- 只有 `docker volume rm` 才会删除
- 200 人企业部署：每人独立 named volume，互不干扰

#### 数据量估算

- 每条消息约 200 bytes
- 每群每天 200 条 = 40KB/天
- 每人 5 个群 = 200KB/天 ≈ 6MB/月
- 200 人每月总量 ≈ 1.2GB（named volume 完全承受）

### 群名获取

首次遇到新 chatId 时，调用飞书 API `GET /im/v1/chats/{chat_id}` 获取群名，写入 `index.json`。后续消息只更新 `lastMessage` 时间戳。

### Her 读取群聊的方式

通过 agent skill 提示 Her 归档文件的位置和格式：

> 你可以读取飞书群聊记录。群索引在 `~/.openclaw/feishu-groups/index.json`，
> 消息记录在 `~/.openclaw/feishu-groups/<chatId>/messages.jsonl`
> （每行一条 JSON，含 ts/sender/text 字段）。
> 用户提到群名时，先查索引找到 chatId，再读对应的消息文件。

主人在私聊中的典型用法：
- "帮我看看产品群今天聊了什么"
- "技术群里有人提到数据库迁移的事吗"
- "总结一下今天所有群的重要消息"

### @Bot 检测机制

飞书事件体 `data.message.mentions` 数组包含被 @ 的用户/bot 信息：

```json
"mentions": [
  { "key": "@_user_1", "id": "ou_botOpenId", "id_type": "open_id", "name": "Her" }
]
```

Bot 的 `open_id` 通过 `GET /bot/v3/info` 获取（首次调用后内存缓存）。检测逻辑：

1. 解析 `mentions` 数组，检查是否有条目的 `id` 匹配 bot 的 `open_id`
2. 如果匹配（wasMentioned=true），再检查 sender 是否为主人（ownerIds / allowFrom）
3. 只有主人 + @Bot 同时满足才触发回复

### 引用回复（Quote-Reply）

群聊中 Her 回复主人时使用飞书的引用回复（`im.message.reply`），让对话上下文清晰：

- 已有 `sendFeishuReply` 函数，调用 `client.im.message.reply({ path: { message_id } })`
- 效果：飞书 UI 显示引用回复样式，其他群成员能看到 Her 在回复哪条消息
- 需要增强 `sendFeishuReply` 支持 Post 格式（当前仅支持纯文本）

### 配置项

```yaml
channels:
  feishu:
    appId: "cli_xxx"
    appSecret: "xxx"
    dm:
      allowFrom: ["ou_主人的openid"]   # 单聊白名单 = 主人身份
    groups:
      enabled: true                     # 启用群聊支持（默认 false）
      archive: true                     # 归档群消息（默认 true）
      # ownerIds: ["ou_xxx"]            # 可选：显式指定群聊主人 ID（默认复用 dm.allowFrom）
```

### 飞书权限要求

群聊归档需要 `im:message.group_msg` 权限（获取群组中所有消息），而非仅 `im:message.group_at_msg`（只收 @bot 的消息），因为归档需要看到所有人的消息。

IT 创建 Bot 时在权限管理中额外开通：

| 权限 | 用途 |
|------|------|
| `im:message.group_msg` | 接收群聊所有消息（归档用） |
| `im:chat:readonly` | 获取群信息（群名，用于 index.json） |

### 不在首期范围

- per-group 独立 agent/session 路由（已有 `peer.kind: "group"` 基础，后续可扩展）
- 群聊话题（thread）支持（飞书有 `thread_id`，暂不用）
- ~~CardKit 流式卡片在群聊中的表现~~：已验证可用（2026-02-10）
- 归档 bot 自己的群聊回复（当前只归档用户消息，bot 回复不经过 inbound 事件）
- 自动按天/按大小切分归档文件（MVP 先单文件）

---

## 与开源社区飞书插件对比分析（2026-02-12）

### 背景

OpenClaw 官方已收录社区飞书插件 `@openclaw/feishu`（npm），由 @m1heng 维护。官方文档 docs.openclaw.ai/channels 已列入飞书为 supported channel（plugin, installed separately）。

npm 上至少有 4 个飞书相关包：
- `@openclaw/feishu` v2026.2.9 — 官方命名空间，"community maintained by @m1heng"，maintainer 是 steipete（OpenClaw 作者）
- `@m1heng-clawd/feishu` v0.1.9 — m1heng 个人早期版本
- `@openclaw-cn/feishu` v2026.2.2 — 中文社区版
- `@max1874/feishu` v0.2.26 — 另一社区贡献者

**我们的飞书实现（`extensions/feishu/`）只在本地 dev 分支，未提交到 origin/main，未发布到 npm。**

### 代码规模对比

| 维度 | 我们的版本 | @openclaw/feishu (m1heng) |
|------|-----------|--------------------------|
| 源文件数 | 5 个 | 30 个 |
| 总代码量 | ~1,800 行 | ~6,025 行 |
| Lark SDK 版本 | ^1.50.0 | ^1.58.0 |
| 附带 Skills | 0 | 4 个（doc/wiki/drive/perm） |

### 功能对比

| 功能 | 我们的版本 | m1heng 版 | 说明 |
|------|-----------|-----------|------|
| **核心消息收发** | ✅ | ✅ | 均完整 |
| **CardKit 流式卡片（打字机效果）** | ✅ 官方 API | ❌ 无 | **我们的核心差异化能力**，~250 行核心逻辑，踩了 4 个竞争条件坑 |
| **群聊 JSONL 归档** | ✅ | ❌ 无 | **我们的核心差异化能力**，~60 行，企业场景刚需 |
| **ACK 超时修复** | ✅ `void` 异步 | ❌ `await` 阻塞 | m1heng 版有此 bug：handler 6-27s 阻塞 ACK → 飞书 3-5s 超时重推，且无 trackMessageId 去重 |
| **Markdown 渲染** | 自研 `markdownToPost()` 140 行 | 飞书卡片原生 `tag: "md"` | m1heng 更简洁，且**支持表格**（我们的 Post 格式不支持） |
| **图片收发 + Vision** | ✅ | ✅ | 均完整 |
| **飞书文档读写 (docx)** | ❌ | ✅ 521 行 | Markdown↔Block 双向转换，支持 20+ 种 Block 类型 |
| **知识库 Wiki** | ❌ | ✅ 232 行 | 空间/节点导航 + 创建/移动/重命名 |
| **云盘 Drive** | ❌ | ✅ 227 行 | 文件夹 CRUD + 文件管理 |
| **多维表格 Bitable** | ❌ | ✅ 461 行 | 20+ 字段类型，筛选/排序/分页 |
| **权限管理 Perm** | ❌ | ✅ 173 行 | 协作者 CRUD |
| **通讯录 Directory** | ❌ | ✅ 177 行 | 列出企业用户/群组 |
| **@mention 转发** | ❌ | ✅ 126 行 | 群里 @bot+@张三 → 回复自动 @张三 |
| **引用消息获取** | ❌ | ✅ | `getMessageFeishu` 获取被引用的原消息内容 |
| **Emoji 表情回应** | ❌ | ✅ 160 行 | 消息 reaction |
| **Typing 提示** | CardKit 流式卡片 | Emoji reaction 加/移除 | 方案不同，我们体验远优 |
| **输入状态 (typing indicator)** | CardKit streaming | emoji reaction | — |
| **权限错误自动诊断** | ❌ | ✅ | 缺权限时提取 grant URL 通知 agent，200 bot 部署排障利器 |
| **Config Schema 验证** | 空 schema | ✅ Typebox 完整校验 | 减少配置错误 |
| **Onboarding 引导** | ❌ | ✅ 359 行 | CLI 交互式配置 |
| **多账户并行** | 支持（单账户使用） | 完善的并行启动 | — |
| **Markdown 表格渲染** | ❌ 不支持 | ✅ 支持 | 卡片原生 md 支持表格 |
| **Render Mode 可配** | 固定 Post 格式 | auto/raw/card 三种 | 按内容自动选择卡片或文本 |

### 架构差异

| 维度 | 我们的版本 | m1heng 版 |
|------|-----------|-----------|
| 入口 | `gateway.ts` 单文件 733 行大函数 | `bot.ts` 871 行 + `monitor.ts` 190 行，职责分离 |
| 回复派发 | `dispatchReplyWithBufferedBlockDispatcher`（自研 card stream 驱动） | `dispatchReplyFromConfig` + `createReplyDispatcherWithTyping`（OpenClaw 标准 typing 框架） |
| SDK 封装 | 直接操作 Lark SDK + 手写 HTTP（绕 SDK bug） | 封装了 `createFeishuClient` + `createEventDispatcher` |
| 发送层 | `outbound.ts` 667 行（含 CardKit streaming 全部逻辑） | `send.ts` 358 行 + `outbound.ts` 55 行 + `reply-dispatcher.ts` 179 行 |

### m1heng 版已知问题（我们已解决）

1. **ACK 超时 bug**：`bot.ts` 中 `await handleFeishuMessage()` 阻塞 ACK 发送。AI 处理耗时 6-27s，飞书 3-5s 超时后会在 +15s/+5min/+1h/+6h 重推。且无内存去重机制（`trackMessageId`），**生产环境会出现消息重复**。我们在 2026-02-10 发现并修复（`void` 异步 + 去重缓存）。

2. **Markdown 渲染虽简洁但有局限**：m1heng 用飞书卡片 `tag: "md"` 原生 markdown，优势是支持表格、代码更少。但卡片样式有边框，不如普通消息气泡自然。我们的 Post 格式更接近普通消息外观，但不支持表格。

### 战略评估：继续自研

**结论：继续自研，选择性吸收开源能力。**

理由：

1. **自主可控是企业核心需求**：Autolink 将 Her 部署给全公司 200+ 人 + 未来 C 端车主，飞书通道是核心基础设施。依赖外部维护者的 npm 包存在断更/breaking change 风险，不可接受。

2. **踩坑经验是护城河**：ACK 超时、CardKit 4 个竞争条件、Post 格式收发不一致、SDK image 参数 bug —— 这些深水区问题的解决经验无法迁移到别人的代码库。

3. **发展方向不同**：我们的路线是企业 200 人部署 + 车载 Her + 家庭 Her → 需要多租户安全隔离、群聊归档、流式体验。m1heng 是通用社区插件 → 功能广但不深。

4. **流式卡片和群聊归档是不可替代的差异化**：m1heng 版完全没有这两个能力，这正是企业用户体验的核心。

---

## 后续 TODO（从开源版本吸收）

基于对 `@openclaw/feishu` v2026.2.9 源码的详细分析，以下能力值得移植到我们的自研版本中。按优先级排列：

### P1 — 短期必做（提升核心体验 + 企业部署必备）

| # | 任务 | 参考文件 | 工作量 | 说明 |
|---|------|---------|--------|------|
| 1 | **卡片 Markdown 渲染模式** | `send.ts` `buildMarkdownCard()` | 0.5 天 | 用飞书 interactive card 原生 markdown 替代（或补充）自研 `markdownToPost()`。优势：支持表格渲染。可实现 auto 模式——检测到代码块/表格时用 card，否则用 Post |
| 2 | **引用消息内容获取** | `send.ts` `getMessageFeishu()` | 0.5 天 | 用户回复某条消息时，自动获取被引用的原消息内容，拼入 inbound context。提升 AI 理解上下文的能力 |
| 3 | **权限错误自动诊断** | `bot.ts` `extractPermissionError()` | 0.5 天 | 飞书 API 返回权限错误（code 99991672）时，自动提取 grant URL 通知 agent。200 bot 部署时排障效率提升 10 倍 |
| 4 | **发送者姓名解析** | `bot.ts` `resolveFeishuSenderName()` | 0.5 天 | 调用 `contact/v3/users` 获取发送者真名（带 TTL 缓存），agent 能看到"张三: 明天开会"而非"ou_xxx: 明天开会"。群聊场景尤其重要 |

### P2 — 中期（企业功能扩展）

| # | 任务 | 参考文件 | 工作量 | 说明 |
|---|------|---------|--------|------|
| 5 | **@mention 转发** | `mention.ts` 126 行 | 1 天 | 群里 @bot + @张三 "帮我问问他进度" → bot 回复自动 @张三。企业群协作场景 |
| 6 | **飞书文档读写工具** | `docx.ts` 521 行 + skill | 2 天 | 注册 `feishu_doc` MCP 工具，AI 可直接读写飞书文档。核心难点：Markdown↔Block 20+ 类型双向转换 |
| 7 | **知识库 Wiki 导航** | `wiki.ts` 232 行 + skill | 1 天 | 注册 `feishu_wiki` 工具，导航 Wiki 空间/节点。依赖 feishu_doc |
| 8 | **Emoji 表情回应** | `reactions.ts` 160 行 | 0.5 天 | 消息 reaction 能力，agent 可以对消息加 emoji |
| 9 | **Config Schema 验证** | `config-schema.ts` 172 行 | 1 天 | Typebox 完整配置校验，减少 200 bot 部署时的配置错误 |

### P3 — 长期（按需）

| # | 任务 | 参考文件 | 工作量 | 说明 |
|---|------|---------|--------|------|
| 10 | **云盘文件管理** | `drive.ts` 227 行 + skill | 1 天 | `feishu_drive` 工具，文件夹 CRUD |
| 11 | **多维表格 Bitable** | `bitable.ts` 461 行 | 1.5 天 | `feishu_bitable` 工具，20+ 字段类型 |
| 12 | **权限管理** | `perm.ts` 173 行 + skill | 0.5 天 | `feishu_perm` 工具，协作者 CRUD |
| 13 | **通讯录查询** | `directory.ts` 177 行 | 1 天 | 列出企业用户/群组，200 人部署场景有用 |
| 14 | **Onboarding CLI** | `onboarding.ts` 359 行 | 1.5 天 | `openclaw setup` 交互式引导配置飞书凭证 |
| 15 | **状态探测** | `probe.ts` 44 行 | 0.5 天 | `openclaw channels status` 显示飞书连接状态 |

### 自研独有，不在开源版本中（持续维护）

| 能力 | 状态 | 说明 |
|------|------|------|
| CardKit 流式卡片 | ✅ 已实现 | 官方打字机动画，~250 行核心，竞争条件已全部修复 |
| 群聊 JSONL 归档 | ✅ 已实现 | 本地归档 + index.json + skill 读取，~60 行 |
| ACK 超时修复 | ✅ 已实现 | `void` 异步 + `trackMessageId` 去重 |
| 企业 200 Bot 部署 | ✅ 已验证 | Docker 容器隔离 + CSV 用户管理 + 滚动升级 |

---

## 总结

飞书通道本质上是在 OpenClaw 的通道体系中新增一个标准通道插件。它与 Her（realtime 语音通道）完全平行，与 Telegram/Slack/Discord 完全同构。

- 实际新增代码 ~1,800 行，全部在 `extensions/feishu/` 内
- 不修改 OpenClaw 核心代码的任何一行
- 不修改 Her（realtime 插件）的任何一行
- 不修改任何已有扩展的任何一行
- 风险极低：官方 API + 独立插件 + 活跃维护的 SDK
- 端到端聊天已验证通过
- 与开源社区版本对比后决策：**继续自研，选择性吸收开源能力**（2026-02-12）
