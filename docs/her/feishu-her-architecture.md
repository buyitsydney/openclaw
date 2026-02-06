# 飞书通道架构设计

通过飞书（Lark）机器人与 OpenClaw 对话，让用户在飞书客户端内获得 AI 助手体验。

**状态：已实现并验证通过 (2026-02-06)**

## 核心结论

- **对现有 OpenClaw 核心代码：零修改** -- 已验证
- **对现有 Her（realtime 插件）代码：零修改** -- 已验证
- **全部新增代码限制在 `extensions/feishu/` 目录内** -- 已验证
- **风险评估：极低** -- 已通过端到端测试确认
- **实际新增代码：~705 行**（包含 cron 直投修复）

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

1. 在飞书开放平台（open.feishu.cn）创建一个自建应用，启用机器人能力
2. 获取 `app_id` + `app_secret`
3. 添加权限：`im:message` + `im:message:send_as_bot`
4. 事件订阅：添加 `im.message.receive_v1`，选择"长连接"模式
5. 发布应用版本
6. 在 OpenClaw config 中配置 `channels.feishu.appId` + `channels.feishu.appSecret`
7. 启动 Gateway，飞书机器人自动上线
8. 在飞书里找到机器人，开始聊天

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
    outbound.ts              # Lark.Client 消息发送（text / reply）
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

### 3.1 Outbound 适配器（channel.ts outbound）

插件同时实现 `sendText` 和 `sendMedia`，确保 cron 定时任务的直投路径 (`deliverOutboundPayloads`) 能正常工作：

```typescript
outbound: {
  deliveryMode: "gateway",
  sendText: async ({ to, text, accountId, cfg }) => { ... },
  sendMedia: async ({ to, text, accountId, cfg }) => {
    // 媒体文件暂不支持，仅投递 caption 文本
    if (text) await sendFeishuText({ account, chatId: to, text });
    return { channel: "feishu" };
  },
}
```

**背景**：OpenClaw 的 cron 定时任务使用 `deliverOutboundPayloads` 直投路径（不经 gateway WebSocket），该路径要求通道同时实现 `sendText` + `sendMedia` 才视为已配置。

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

在飞书开放平台配置以下权限：
- `im:message` -- 接收消息事件（读取用户发给机器人的单聊消息）
- `im:message:send_as_bot` -- 以应用身份发消息

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
| `src/channel.ts` | 219 | ChannelPlugin 主体 + sendMedia 适配 |
| `src/runtime.ts` | 15 | Runtime 单例 |
| `src/gateway.ts` | 228 | WSClient + pipeline 集成 + 回复投递 |
| `src/outbound.ts` | 72 | Lark SDK 消息发送 + 智能 ID 类型识别 |
| `src/accounts.ts` | 110 | 账户 / 凭证解析 |
| **总计** | **~705** | 全部在 `extensions/feishu/` 内 |

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

---

## 后续增强方向

当前 MVP 实现覆盖了核心聊天 + 定时任务功能，以下为可选增强：

1. **富文本回复**：Markdown -> 飞书 Post 格式转换，支持加粗/链接/代码块
2. **图片/文件收发**：通过 `im:resource` 权限处理媒体附件（当前 `sendMedia` 仅投递文本）
3. **交互卡片**：使用飞书 Interactive Card 展示结构化回复
4. **群聊支持**：@mention 检测、群权限策略、群级别配置
5. **Onboarding CLI**：`openclaw setup` 交互式引导配置飞书凭证
6. **状态探测**：`openclaw channels status` 显示飞书连接状态
7. **Typing 指示器**：发送"正在输入..."临时消息

---

## 总结

飞书通道本质上是在 OpenClaw 的通道体系中新增一个标准通道插件。它与 Her（realtime 语音通道）完全平行，与 Telegram/Slack/Discord 完全同构。

- 实际新增代码 ~705 行，全部在 `extensions/feishu/` 内
- 不修改 OpenClaw 核心代码的任何一行
- 不修改 Her（realtime 插件）的任何一行
- 不修改任何已有扩展的任何一行
- 风险极低：官方 API + 独立插件 + 活跃维护的 SDK
- 端到端聊天已验证通过
