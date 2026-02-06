# 飞书 Her 前端架构设计

通过飞书（Lark）机器人与 OpenClaw 对话，让用户在飞书客户端内获得与 Her 相同的 AI 助手体验。

## 核心结论

- **对现有 OpenClaw 核心代码：零修改**
- **对现有 Her（realtime 插件）代码：零修改**
- **全部新增代码限制在 `extensions/feishu/` 目录内**
- **风险评估：极低**（官方 API + 独立插件 + 不碰任何已有代码）

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

### 最终效果

用户在飞书客户端里，找到 AI 机器人，打开私聊窗口，直接发消息。体验与跟同事聊天完全一致：

```
用户（飞书私聊）: 明天上海天气怎么样？
机器人（飞书私聊）: 明天上海多云，10到15度，傍晚可能有小雨，记得带伞。

用户（飞书私聊）: 帮我写一封邮件给客户
机器人（飞书私聊）: 好的，我来帮你草拟...
```

### 配置流程

1. 在飞书开放平台（open.feishu.cn）创建一个自建应用，启用机器人能力
2. 获取 `app_id` + `app_secret`
3. 运行 `openclaw setup` 选择 Feishu，输入凭证
4. 启动 Gateway，飞书机器人上线
5. 在飞书里找到机器人，开始聊天

---

## 架构设计

### 在 OpenClaw 通道体系中的位置

```
┌──────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                       │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Telegram │ │  Slack   │ │ Discord  │ │ WhatsApp │   │
│  │(已有插件) │ │(已有插件) │ │(已有插件) │ │(已有插件) │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
│       │            │            │            │          │
│       └────────────┴────────────┴────────────┘          │
│                         │                                │
│                   统一 Agent 管道                         │
│               (auto-reply pipeline)                      │
│                         │                                │
│       ┌─────────────────┼─────────────────┐             │
│       │                 │                 │             │
│  ┌────┴─────┐    ┌──────┴──────┐   ┌─────┴──────┐     │
│  │  Feishu  │    │   Matrix    │   │    Line    │     │
│  │ (新增！) │    │ (已有插件)  │   │ (已有插件) │     │
│  └──────────┘    └─────────────┘   └────────────┘     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │      Her (realtime 插件) - 不受任何影响            │   │
│  │      完全独立的实时语音通道                         │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

**关键点：飞书插件与 Her 完全平行，互不影响。**

Her 是实时语音通道（Gemini Live + WebSocket），走的是快慢思考架构。
飞书是文字聊天通道，走的是标准 auto-reply pipeline（与 Telegram/Slack 相同）。
两者在 OpenClaw 内部是完全独立的通道，共享同一个 Agent 大脑和 Memory。

### 飞书插件内部架构

```
extensions/feishu/
  openclaw.plugin.json        # 插件清单
  package.json                # 依赖：@larksuiteoapi/node-sdk
  index.ts                    # 入口：register() -> api.registerChannel()
  src/
    channel.ts               # ChannelPlugin<ResolvedFeishuAccount> 实现
    runtime.ts               # PluginRuntime 单例存取
    gateway.ts               # WSClient 生命周期管理 + 消息监听
    outbound.ts              # 发送消息（text / media / card）
    onboarding.ts            # CLI 配置引导（输入 app_id / app_secret）
    accounts.ts              # 多账户解析
    config-schema.ts         # 配置项 JSON Schema
    probe.ts                 # 连接状态探测
    types.ts                 # 飞书 API 类型定义
```

### 数据流

```
飞书用户
  │
  │ 发送消息（飞书客户端 -> 飞书服务器）
  ↓
飞书服务器
  │
  │ 事件推送（WebSocket 长连接 或 Webhook）
  ↓
extensions/feishu/gateway.ts
  │
  │ 解析消息 -> 构建 inbound message
  ↓
OpenClaw auto-reply pipeline（核心代码，不修改）
  │
  │ Agent 处理 -> 生成回复
  ↓
extensions/feishu/outbound.ts
  │
  │ client.im.message.create()
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

遵循 OpenClaw 标准插件模式，与 `extensions/slack/index.ts` 结构一致：

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

两种接入模式供用户选择：

**模式 A：WebSocket 长连接（推荐）**

```typescript
import * as Lark from "@larksuiteoapi/node-sdk";

// startAccount: Gateway 启动时调用
async function startFeishuAccount(ctx: ChannelGatewayContext) {
  const { appId, appSecret } = ctx.account;

  const client = new Lark.Client({ appId, appSecret });
  const wsClient = new Lark.WSClient({ appId, appSecret });

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        // 1. 提取消息内容
        const chatId = data.message.chat_id;
        const senderId = data.sender.sender_id.open_id;
        const content = JSON.parse(data.message.content);
        const text = content.text;

        // 2. 交给 OpenClaw auto-reply pipeline 处理
        //    （通过 runtime 调用，与 Telegram/Slack 完全相同的路径）
        await handleInboundMessage({ chatId, senderId, text, client });
      },
    }),
  });
}
```

- 无需公网 IP、无需域名备案
- 适合本地开发和家庭/个人服务器部署
- 连接由飞书 SDK 自动维护（断线重连）

**模式 B：Webhook 回调**

```typescript
// 需要公网可达的 HTTP 端点
// 适合有公网服务器的生产部署
const eventDispatcher = new Lark.EventDispatcher({
  encryptKey: account.encryptKey,
}).register({
  "im.message.receive_v1": async (data) => {
    // 同上，交给 auto-reply pipeline
  },
});
```

### 3. 消息发送（outbound.ts）

```typescript
async function sendTextToFeishu(params: {
  client: Lark.Client;
  chatId: string;
  text: string;
}) {
  await params.client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: params.chatId,
      content: JSON.stringify({ text: params.text }),
      msg_type: "text",
    },
  });
}
```

支持的消息类型：
- `text`：纯文本（主要使用）
- `post`：富文本（Markdown 风格）
- `image`：图片（需先上传获取 file_key）
- `interactive`：交互卡片（可用于结构化回复）
- `file`：文件附件

### 4. Onboarding 配置引导（onboarding.ts）

```
$ openclaw setup
? 选择通道: Feishu (Lark Bot)
? App ID: cli_xxxxxxxxxx
? App Secret: ********
? 接入模式: WebSocket 长连接（推荐）

✅ Feishu 配置完成！
   在飞书开放平台启用机器人能力，添加 im:message 和 im:message:send 权限
   然后在飞书客户端搜索你的机器人名称开始聊天
```

### 5. 配置存储

配置存储在 OpenClaw 标准 config 中，路径 `channels.feishu.*`：

```yaml
channels:
  feishu:
    default:
      appId: "cli_xxxxxxxxxx"
      appSecret: "encrypted:..."
      mode: "websocket"          # websocket | webhook
      encryptKey: ""             # webhook 模式下可选
      dm:
        policy: "pairing"        # pairing | allowlist | open | disabled
        allowFrom: []
```

### 6. 权限需求

在飞书开放平台配置以下权限：
- `im:message` -- 接收消息事件
- `im:message:send` -- 发送消息
- `im:resource`（可选）-- 上传/下载文件和图片

---

## 对现有代码的影响分析

### 对 OpenClaw 核心代码：零修改

| 核心模块 | 是否修改 | 说明 |
|---------|---------|------|
| `src/channels/` | 否 | 飞书通过 `api.registerChannel()` 动态注册，无需修改 registry |
| `src/auto-reply/` | 否 | 飞书走标准 auto-reply pipeline，无需任何改动 |
| `src/config/` | 否 | 插件配置由扩展自管理 |
| `src/cli/` | 否 | onboarding 通过 `ChannelOnboardingAdapter` 注入 |
| `src/infra/` | 否 | outbound 通过 `ChannelOutboundAdapter` 注入 |
| `src/plugin-sdk/` | 否 | 使用现有 SDK 类型，无需新增 |
| `src/routing/` | 否 | 路由自动识别已注册的通道 |
| `package.json` | 否 | 飞书 SDK 仅在 `extensions/feishu/package.json` 中 |

**原理**：OpenClaw 的插件体系设计就是为了让新通道以零侵入方式接入。飞书插件与 Slack、Matrix、Zalo 等已有扩展完全一样——只在 `extensions/feishu/` 目录内添加代码。

### 对 Her（realtime 插件）：零修改

| Her 模块 | 是否修改 | 说明 |
|---------|---------|------|
| `extensions/realtime/src/server.ts` | 否 | Her 的 WebSocket 服务独立运行 |
| `extensions/realtime/live-frontend/` | 否 | Her 前端完全不受影响 |
| `extensions/realtime/live-frontend/server.py` | 否 | Gemini 代理服务独立运行 |
| `extensions/realtime/src/prompt.ts` | 否 | Her 的 system prompt 不变 |

**原理**：Her 是实时语音通道（Gemini Live API + WebSocket + 快慢思考架构）。飞书是文字聊天通道（标准 auto-reply pipeline）。两者在 OpenClaw 内部是完全独立的通道实例，各自有独立的 gateway 生命周期，唯一共享的是 Agent 大脑和 Memory——这正是 OpenClaw 多通道架构的设计意图。

### 新增代码量估算

| 文件 | 预估行数 | 说明 |
|------|---------|------|
| `openclaw.plugin.json` | ~5 | 插件清单 |
| `package.json` | ~15 | 依赖声明 |
| `index.ts` | ~20 | 入口注册 |
| `src/channel.ts` | ~250 | ChannelPlugin 主体（参照 Slack ~600 行，飞书更简单） |
| `src/runtime.ts` | ~15 | Runtime 单例 |
| `src/gateway.ts` | ~120 | WSClient/Webhook 生命周期 + 消息监听 |
| `src/outbound.ts` | ~80 | 消息发送（text/media） |
| `src/onboarding.ts` | ~100 | CLI 配置引导 |
| `src/accounts.ts` | ~60 | 账户解析 |
| `src/config-schema.ts` | ~30 | 配置 Schema |
| `src/probe.ts` | ~40 | 状态探测 |
| `src/types.ts` | ~30 | 类型定义 |
| **总计** | **~765** | 全部在 `extensions/feishu/` 内 |

对比：现有 `extensions/slack/` 约 600 行，`extensions/zalouser/` 约 700 行。飞书插件的复杂度在同一数量级。

---

## 风险评估

### 技术风险：极低

| 风险项 | 评估 | 说明 |
|-------|------|------|
| 破坏现有功能 | 无 | 纯新增目录，不修改任何已有文件 |
| 飞书 API 稳定性 | 极低风险 | 官方 API + 官方 SDK，字节跳动长期维护 |
| 封号 / 违规 | 无 | 官方开放平台，鼓励开发者接入 |
| SDK 维护状态 | 良好 | `@larksuiteoapi/node-sdk` 活跃更新（每周发版） |
| 认证门槛 | 极低 | 个人免费创建飞书组织 + 自建应用，无需企业资质 |
| 网络要求 | 极低 | WebSocket 模式无需公网 IP / 域名备案 |
| Her 功能影响 | 无 | 完全独立的通道，不共享任何运行时状态 |

### 与微信的对比

| 维度 | 微信 | 飞书 |
|------|------|------|
| 官方 Bot API | 无（个人号） | 有，完整开放 |
| 方案可靠性 | 所有方案已死或高风险 | 官方 API，长期稳定 |
| 封号风险 | 极高（80%+ 封号率） | 零 |
| 认证门槛 | 企业资质 + 备案域名 | 个人免费 |
| 消息限制 | 5 秒超时 / 48 小时窗口 | 无 |
| SDK 状态 | 无官方 / 第三方已停维 | 官方 SDK，每周更新 |
| 网络要求 | 大陆备案服务器 | WebSocket 模式无要求 |

---

## 实现参照

飞书插件的实现可以直接参照以下已有扩展：

- **`extensions/slack/`**：最佳参照。Slack 同样支持 Socket Mode（WebSocket 长连接）+ Bot Token 认证，架构高度相似
- **`extensions/telegram/`**：Telegram 的 Bot API + Webhook/Polling 模式也是很好的参照
- **`extensions/googlechat/`**：Google Chat 的 HTTP Webhook 模式可参照飞书的 Webhook 模式

### 关键对应关系

| 概念 | Slack | 飞书 |
|------|-------|------|
| 连接模式 | Socket Mode (WebSocket) | WSClient (WebSocket) |
| 认证凭证 | Bot Token + App Token | App ID + App Secret |
| 消息事件 | `message` event | `im.message.receive_v1` event |
| 发送消息 | `chat.postMessage` | `im.message.create` |
| 官方 SDK | `@slack/web-api` | `@larksuiteoapi/node-sdk` |
| 权限配置 | OAuth Scopes | 开放平台权限管理 |

---

## 总结

飞书 Her 前端本质上不是对 Her 的修改，而是在 OpenClaw 的通道体系中新增一个标准通道插件。它与 Her（realtime 语音通道）完全平行，与 Telegram/Slack/Discord 完全同构。

- 新增代码 ~765 行，全部在 `extensions/feishu/` 内
- 不修改 OpenClaw 核心代码的任何一行
- 不修改 Her（realtime 插件）的任何一行
- 不修改任何已有扩展的任何一行
- 风险极低：官方 API + 独立插件 + 活跃维护的 SDK
