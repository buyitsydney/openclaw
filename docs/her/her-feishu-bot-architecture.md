# 飞书通道架构设计

通过飞书（Lark）机器人与 OpenClaw 对话，让用户在飞书客户端内获得 AI 助手体验。

**状态：已实现并验证通过 (2026-02-25 更新)**（含 Web Search + Browser Use + @mention 能力）

## 核心结论

- **对现有 OpenClaw 核心代码：零修改** -- 已验证
- **对现有 Her（realtime 插件）代码：零修改** -- 已验证
- **全部新增代码限制在 `extensions/feishu-her/` 目录内** -- 已验证（原 extensions/feishu/，重命名以物理隔离于 upstream）
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

> **注意：步骤顺序很重要！需要发布两次。** 第一次发布让 Bot 在飞书客户端可见；之后配置长连接事件订阅（要求 SDK 客户端已在线），再第二次发布才能收发消息。

1. 在飞书开放平台（open.feishu.cn）创建一个自建应用，启用机器人能力
2. 获取 `app_id` + `app_secret`
3. 添加权限（批量导入 86 个，见企业部署文档）
4. **第一次发布**：创建版本 → 设置可用范围 → 发布（让 Bot 在飞书客户端可见）
5. 去飞书客户端搜索 Bot，确认能找到（此时无法聊天，正常）
6. 在 OpenClaw config 中配置 `channels.feishu.appId` + `channels.feishu.appSecret`
7. **启动 Gateway**（飞书 WSClient 自动连接，日志显示 `Feishu WSClient connected`）
8. **回到飞书后台**：事件订阅 → 选"使用长连接接收事件" → 保存 → 添加 `im.message.receive_v1`
9. **第二次发布**：创建版本 → 发布（包含事件订阅配置）
10. 在飞书里找到机器人，开始聊天

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
extensions/feishu-her/
  openclaw.plugin.json        # 插件清单（id: feishu-her）
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
extensions/feishu-her/gateway.ts
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
extensions/feishu-her/outbound.ts
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
function resolveReceiveId(raw: string): { receiveId; receiveIdType };

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
    // loadWebMedia(maxBytes=30MB) -> 按 contentType 路由:
    //   audio/* -> convertToOpus -> uploadFeishuAudio -> sendFeishuAudio (msg_type: "audio")
    //   video/* -> uploadFeishuFile -> sendFeishuVideo (msg_type: "media")
    //   image/* -> uploadFeishuImage -> sendFeishuImage (msg_type: "image")
    //   其他   -> uploadFeishuFile -> sendFeishuFile (msg_type: "file")
    // 飞书 IM 文件上限 30MB，超限在 loadWebMedia 层拦截并返回清晰错误
    // 失败时 fallback 为文本发送 URL
    if (text) await sendFeishuRichText({ account, chatId: to, text });
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

在飞书开放平台配置以下 9 个核心权限：

- `im:message` -- 获取与发送单聊、群组消息
- `im:message:send_as_bot` -- 以应用身份发消息
- `im:resource` -- 获取与上传图片或文件资源（图片收发所需）
- `im:message.group_msg` -- 获取群组中所有消息（敏感权限，群聊归档用）
- `im:message.p2p_msg:readonly` -- 读取用户发给机器人的单聊消息
- `im:chat:readonly` -- 获取群信息（获取群名，归档索引用）
- `cardkit:card:write` -- 创建与更新卡片（AI 流式回复打字机效果）
- `contact:user.base:readonly` -- 读取用户基本信息（**@mention 必需**，用于通过 open_id 查用户姓名，不配则 `sender name lookup` 返回空）
- `contact:department.base:readonly` -- 读取部门信息（通讯录按部门查人时需要）

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
- `package.json` -- 不修改。飞书 SDK 仅在 `extensions/feishu-her/package.json` 中

### 对 Her（realtime 插件）：零修改（已验证）

- `extensions/realtime/src/server.ts` -- 不修改。Her 的 WebSocket 服务独立运行
- `extensions/realtime/live-frontend/` -- 不修改。Her 前端完全不受影响
- `extensions/realtime/src/prompt.ts` -- 不修改。Her 的 system prompt 不变

### 实际代码量

| 文件                   | 行数      | 说明                                                                                                                 |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `openclaw.plugin.json` | 9         | 插件清单                                                                                                             |
| `package.json`         | 39        | 依赖 + 通道元数据                                                                                                    |
| `index.ts`             | 17        | 入口注册                                                                                                             |
| `src/channel.ts`       | 300       | ChannelPlugin 主体 + sendMedia 全媒体上传（音频/视频/图片/文件）+ 目标解析                                           |
| `src/runtime.ts`       | 14        | Runtime 单例                                                                                                         |
| `src/gateway.ts`       | 733       | WSClient + pipeline 集成 + 富文本解析 + 回复投递 + 图片下载/接收 + CardKit 流式卡片 + 群聊归档 + CardKit 状态 footer |
| `src/outbound.ts`      | 690       | Lark SDK 消息发送 + ID 类型识别 + 图片/音频/视频/文件上传发送/下载 + Markdown→Post 转换 + CardKit API                |
| `src/accounts.ts`      | 133       | 账户 / 凭证解析 + 群聊主人 ID 解析                                                                                   |
| **总计**               | **~1800** | 全部在 `extensions/feishu-her/` 内                                                                                   |

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

## 安全架构：两层防护模型（2026-02-15 设计，2026-02-16 实现完成）

> **已实现。** 语音 realtime 通道已具备与飞书文字通道对齐的两层防护。

### 飞书文字通道的安全模型（已实现，参考标准）

飞书文字聊天之所以安全，靠的是**两层防护**：

| 层                  | 机制                             | 效果                               | 实现位置                                                |
| ------------------- | -------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| **Layer 1：找不到** | 飞书可用范围 = 只选一人          | 其他员工在飞书客户端搜不到这个 Bot | 飞书开放平台（平台级隔离）                              |
| **Layer 2：被拒绝** | `dm.allowFrom = [ou_xxx]` 白名单 | 即使找到 Bot，发消息也被忽略       | `extensions/feishu-her/src/channel.ts` resolveAllowFrom |

```
普通员工 → 搜索董事长的 Bot → 搜不到（Layer 1）
普通员工 → 猜到 Bot ID 发消息 → Bot 忽略（Layer 2）
董事长   → 搜索自己的 Bot  → 正常对话 ✓
```

### 语音 realtime 通道的安全模型（已实现）

| 层                  | 飞书文字                    | 语音 realtime                                                                               |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| **Layer 1：找不到** | 可用范围 = 一人，搜不到 Bot | 端口不暴露（Docker 不 -p 18790、cloudflared 不隧道），外部完全看不到入口                    |
| **Layer 2：被拒绝** | `dm.allowFrom` 白名单       | per-container 唯一 token 认证（双层校验：server.py + server.ts），无效返回 401              |
| **授权途径**        | 飞书平台自动配对            | 飞书 Bot `/voice` 私聊发送带 token 的语音 URL；管理员通过 `start-user.sh --reset` 生成/重置 |

```
普通员工 → 端口扫描董事长容器 → 18790 未暴露，找不到（Layer 1）
普通员工 → 猜到内部 URL → token 不对，401 拒绝（Layer 2）
董事长   → 飞书 Bot 输入 /voice → Bot 私聊回复语音链接 → 正常语音 ✓
厂商     → 管理员提供 token → 写入 App 配置 → 正常对接 ✓
```

### 实现详情

1. **不暴露 realtime 端口**：`start-user.sh` 不映射 `-p 18790`，`generate-tunnel-config.sh` 不隧道该端口
2. **Frontend proxy 内部转发**：`server.py`（端口 8000）代理 `/api/realtime/bootstrap` 和 `/ws` 到容器内部 `localhost:18790`
3. **Per-container 唯一 token**：`start-user.sh` 启动时自动生成（如不存在），存储在 Docker volume `/data/.openclaw/.voice-token`
4. **双层 token 校验**：server.py（Layer 2a）和 server.ts（Layer 2b）各自独立校验同一个 token，纵深防御
5. **飞书 Bot `/voice`**：通过私聊发送带 token 的完整语音 URL；`/voice reset` 重置 token 并发送新 URL
6. **管理员 `--reset`**：`./start-user.sh --id=N --reset` 重置 token，不重启容器，立即生效，打印厂商可用的完整 URL

> **修改范围**：全部在可修改代码内（`extensions/realtime/`、`extensions/feishu-her/`、`start-user.sh`、`scripts/`），不触碰上游 `src/` 代码。

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

| 行为                      | 结果                                          |
| ------------------------- | --------------------------------------------- |
| 飞书发消息、收到回复      | 飞书能看到，**Webchat 也能看到**（广播机制）  |
| Telegram 发消息、收到回复 | Telegram 能看到，**Webchat 也能看到**         |
| Webchat 发消息、收到回复  | 只有 Webchat 能看到，飞书/Telegram **看不到** |

### 并发行为

当 agent 正在处理某个通道的消息时，其他通道的消息被排入 followup 队列。队列 drain 时通过 `routeReply()` 尝试将回复路由回原始通道。如果路由失败，回复会 fallback 到当前活跃的 dispatcher（通常是 webchat）。

实际影响：同时在 Webchat 和飞书聊天时，后到的消息可能被排队，回复可能出现在非预期的通道。

### 结论：保持默认配置

对于个人单用户场景，`dmScope = "main"` 是最佳选择：

- 跨通道共享记忆（飞书聊的内容，Webchat 里也知道）
- 只要避免同时在多个通道聊天，不会遇到并发冲突
- 如果未来需要同时多通道独立聊天，可改为 `per-channel-peer`，代价是失去跨通道记忆

---

## 已知问题（未修复）

### [P2] ~~ACK Reaction 重复调用（日志刷屏）~~ ✅ 已修复 (2026-02-22)

**问题**：每次用户发消息时，日志中出现大量重复的 `added ACK reaction (Get) to om_xxx`，约每 6 秒一次，持续整个 AI 处理过程（3 分钟处理 = 30+ 条重复日志）。

**根因**：upstream `createTypingController`（`src/auto-reply/reply/typing.ts`）设计为每 `typingIntervalSeconds`（默认 6 秒）重复调用 `onReplyStart` 回调作为心跳。在 Telegram/Discord 等频道中，typing 指示器会自动过期（约 5 秒），所以需要定期刷新。但飞书的 emoji reaction 是持久的（不会过期），`addFeishuReaction` 被重复调用只是白白浪费 API 调用和刷屏日志。

**调用链**：`feishu-her/gateway.ts onReplyStart` → `dispatchReplyWithBufferedBlockDispatcher` → `createReplyDispatcherWithTyping` → `createTypingController` → `setInterval(triggerTyping, 6000)` → `onReplyStart()`（循环）

**修复**：`extensions/feishu-her/src/gateway.ts` 在 `addAckReaction()` 开头加 guard —— `if (ackReactionId) return;`，已添加过则跳过。心跳机制对 card stream 无影响（`startCardStream` 已有自己的 guard）。回复完成后 `removeAckReaction()` 正常移除 emoji（typing indicator 语义不变）。

**验证**：Docker 1 日志确认修复后每条消息只有 1 次 `added ACK reaction` + 1 次 `removed ACK reaction`，零重复。

### [P0] Agent Run 超时后飞书用户无错误通知 (2026-02-16 定位)

**问题**：agent 回复到一半出错（如 compaction 重试挂死、LLM 超时等），飞书用户看到 typing 停止后再无任何反馈——没有错误消息、没有提示重试。

**完整时间线（2026-02-15 06:41-06:51 CST 实际案例）**：

1. 06:41:34 — agent run 启动（opus-4.6, thinking=low）
2. 06:42:39 — agent 完成回复，Pi SDK 自动触发 context compaction
3. 06:43:20 — 第一次 compaction 失败，SDK 发出 `willRetry=true` 开始重试
4. 06:44:39 — typing indicator TTL 2 分钟到期，停止显示
5. 06:51:34 — 10 分钟 timeout 触发 `abortRun(true)`
6. 06:51:34 之后 — **永久死锁**，无任何日志，进程挂起

**根因分析（两个独立问题叠加）**：

**问题 A — OpenClaw 核心 Bug #16331：compaction retry 死锁** ✅ 已修复

`src/agents/pi-embedded-runner/run/attempt.ts` 第 990 行 `await waitForCompactionRetry()` **没有**用 `abortable()` 包装。当 timeout 触发 abort 时，如果 Pi SDK 在 abort 期间不发出 `auto_compaction_end` 事件，这个 Promise 永远不 resolve，导致整个调用链死锁。

- GitHub Issue: https://github.com/openclaw/openclaw/issues/16331
- 修复 PR: https://github.com/openclaw/openclaw/pull/16533（2026-02-14 合并到 upstream main）
- **本地状态**：✅ 已通过 upstream v2026.2.14 合并修复（2026-02-16）

**问题 B — 飞书插件缺少 error→用户通知机制** ⏳ 待修复

即使核心 bug 修复后 run 能正常返回错误结果，飞书 gateway 也不会通知用户：

- `gateway.ts` L1256 `onError` 只处理 delivery 错误（飞书 API 发送失败），不处理 agent run 错误
- `gateway.ts` L439 顶层 `.catch()` 只 log 不通知用户
- `agent-runner-execution.ts` L578 有 `"⚠️ Agent failed before reply: ..."` 错误文本，但 run 挂死时这行代码永远不会执行
- Telegram/Discord 等其他 channel 也有同样的问题——这是 OpenClaw 核心架构层面的缺失

**修复方案**：

1. ~~**拉取 upstream**：合并 `origin/main` 获取 PR #16533 的 compaction timeout 修复（防死锁）~~ ✅ 已完成
2. **飞书 error notification**：在 `handleInboundMessage` 的 `.catch()` 中给用户发一条错误消息（如 "⚠️ 处理消息时出错，请稍后重试"）

---

## 已修复的问题

### @mention 支持（AI 可 @提及用户和 @所有人）(2026-02-25)

**问题**：AI 在飞书群聊或私聊中无法 @提及用户。尝试 @某人时，输出的是原始 `<at user_id="xxx"></at>` 标签文本，飞书不解析为 @mention 蓝标。同时 `sender name lookup` 无法查到用户姓名，只返回 `open_id`/`union_id`。

**根因（两个独立问题）**：

1. **`markdownToPost` 不解析 `<at>` 标签**：`parseInlineElements` 的正则只匹配 `**粗体**`、`*斜体*`、`` `code` ``、`[链接](url)`，没有匹配 Feishu 的 `<at user_id="xxx">Name</at>` 语法。当 AI 输出包含 `<at>` 的 Markdown 并通过 `sendFeishuRichText` 发送 Post 消息时，`<at>` 标签被当成普通文本输出。
2. **缺少通讯录权限**：飞书应用未配置 `contact:user.base:readonly` 和 `contact:department.base:readonly`，导致 `resolveFeishuSenderName` 调用 `client.contact.user.get()` 时 API 返回的 user 对象只有 `open_id`/`union_id`/`mobile_visible`，没有 `name` 字段。

**修复（三处改动）**：

1. **`outbound.ts` — `PostElement` 类型**：新增 `user_id?: string` 字段，支持 `{ tag: "at", user_id: "ou_xxx" }` 元素
2. **`outbound.ts` — `parseInlineElements` 正则**：新增 `<at\s+user_id="([^"]+)">([^<]*)</at>` 匹配，检测到后生成 `{ tag: "at", user_id: match[9] }` Post 元素
3. **`skills/feishu/SKILL.md`**：新增「@提及用户」章节，指导 AI 先用 `feishu_chat(action="members")` 或 `feishu_directory` 获取 open_id，再在 `message` 工具参数中使用 `<at user_id="ou_xxx">Name</at>` 语法

**权限要求**：

| 权限                               | 用途                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `contact:user.base:readonly`       | 通过 open_id 查询用户姓名（sender name lookup + @mention 前获取 open_id） |
| `contact:department.base:readonly` | 按部门查询用户列表                                                        |

**验证（2026-02-25 本地 Her + Docker 1 双路实测）**：

- 本地 Her 日志：`sender resolved: ou_4e2a42036050d192b367829818e700d5 -> 卜弋天`（权限生效后姓名正常返回）
- Docker 1 日志：`sender resolved: ou_e5e4e73b7658b1169b8dcb7aa43c9348 -> 卜弋天`
- AI 成功在群聊中 @提及个人（蓝标显示）和 @所有人
- text 格式消息中 `<at user_id="xxx">` 原生透传，Post 格式消息中 `<at>` 标签正确转为 `{ tag: "at", user_id }` 元素

**注意**：`contact:user.base:readonly` 在飞书个人版仍无法返回姓名（平台限制），企业版/旗舰版正常。

### feishu_directory department_id_type 修复 (2026-02-25)

**问题**：企业通讯录权限配置正确后，`feishu_directory(action="list_users", department_id="xxx")` 仍返回 `400 Bad Request`（code 99992357, "Invalid ids"）。

**根因**：`directory.ts` 中 `listUsers` 和 `listDepartments` 调用飞书 API 时未指定 `department_id_type` 参数。飞书 API 默认按 `open_department_id`（`od-` 前缀）解析，但代码传入的是 `department_id`（如 `5f6991e2a129dg7g`），格式不匹配导致 400。

**修复**：在 `findByDepartment` 和 `department.list` 的 `params` 中显式添加 `department_id_type: "department_id"`。

**实测验证（docker13）**：修复后 24 次 `feishu_directory` 调用全部成功（零 400/403 错误），成功查询 50+ 部门、遍历用户、按 open_id 查个人信息并发送私聊消息。

### 文件下载错误码解析（飞书 API 400 精准诊断）(2026-02-22)

**问题**：用户在飞书发送超过 100MB 的文件（如 VSCode-darwin-universal.zip ~200MB），Her 只能看到笼统的 "download failed"，无法告知用户具体原因。董事长发送多个大文件时 agent 不知道为什么下载失败，超时 10 分钟后无任何有意义的反馈。

**根因**：`gateway.ts` 的 file download catch 块只检查 `msg.includes("exceeds")` 来判断文件过大，但 Lark SDK 使用 `responseType: 'stream'`，AxiosError 的 `message` 只是通用的 `"Request failed with status code 400"`，不包含 "exceeds"。飞书实际返回的错误详情在 `response.data` 中，但该字段是一个 ReadableStream（未被消费/解析）。

**飞书 API 文档确认**（`GET /im/v1/messages/{message_id}/resources/{file_key}`）HTTP 400 对应 4 种错误码：

| 错误码 | 含义                                          |
| ------ | --------------------------------------------- |
| 234001 | invalid params（参数错误）                    |
| 234003 | file not in message（资源不属于该消息）       |
| 234004 | app not in chat（Bot 不在群聊中）             |
| 234037 | file exceeds 100 MB limit（文件超过下载限额） |

**修复**（`extensions/feishu-her/src/gateway.ts`）：

1. 从 `AxiosError.response.data` 提取飞书错误码，防御性处理 4 种数据形态：pre-parsed object → Buffer → string → AsyncIterable（ReadableStream 消费）
2. 按错误码映射为人类可读的 reason：234037 → "file too large (Feishu limits downloads to 100 MB)"，234001 → "invalid request parameters"，等
3. 未知错误码使用飞书原始 msg 或 HTTP status fallback

**验证**（2026-02-22 Docker 1 实测）：

- 发送 VSCode-darwin-universal.zip（~200MB）→ AI 回复："收到 VSCode-darwin-universal.zip，但飞书限制 100MB 下载不了。想怎么处理？"
- 日志链路完整：`file download failed (key=... name=VSCode-darwin-universal.zip): AxiosError: Request failed with status code 400` → agent 收到 `file too large` reason → 正确输出人话

### 插件启用架构修复：消除部署脚本硬编码 (2026-02-16)

**问题**：将飞书插件从 `extensions/feishu/` 重命名为 `extensions/feishu-her/`（物理隔离 upstream）后，Docker 容器 (carher-1) 进入启动失败循环。

**根因**：`start-user.sh` 第 439 行硬编码了 `plugins.entries['feishu'] = {'enabled': True}`，而插件 ID 已变为 `feishu-her`。Config 校验器找不到 ID 为 `feishu` 的插件，校验失败，容器挂掉。

**背景**：OpenClaw bundled 插件（`extensions/` 目录下）默认全部关闭（`BUNDLED_ENABLED_BY_DEFAULT` 是空集合），必须在 config 中 `plugins.entries.插件ID.enabled = true` 才能加载。

**修复**（三处改动）：

1. **`docker/carher-config.json`**：在基础配置的 `plugins.entries` 中添加 `feishu-her: {enabled: true}`（与 `realtime` 并列）。插件启用跟着代码走，不跟着部署脚本走。
2. **`start-user.sh`**：删除硬编码的 `plugins.entries.feishu`。per-user config 只保留 `channels.feishu`（频道凭证，使用稳定的频道名而非插件 ID）。
3. **`start-user.sh` SOURCE_DIRS**：补全 Docker 自动重建监控列表，新增 `docker/`、`pnpm-workspace.yaml`、`.npmrc`、`patches/`、`tsconfig.json`，并将 `scripts/carher-entrypoint.sh` 扩展为 `scripts/`。确保 Dockerfile COPY 进镜像的每个文件/目录都在监控范围内。

**架构原则**：

- 插件启用配置放在 `docker/carher-config.json`（与代码同仓库、同版本控制）
- `start-user.sh` 只管 per-user 数据（飞书凭证、模型选择），不涉及插件 ID
- 以后改插件名只需改 `docker/carher-config.json` 一处，不影响部署脚本和 200 企业用户

**验证**：本地 Her + Docker 1 双路语音并发测试通过，飞书消息收发正常，语音对话正常，所有隧道端点 200。

### Upstream v2026.2.14 升级完成 (2026-02-16)

**目标**：合并 upstream `v2026.2.14`（38 个 commits），获取 compaction timeout 修复、新 plugin-auto-enable 等核心能力。

**合并冲突处理**：

- `pnpm-lock.yaml`：取 upstream 版本，`pnpm install --no-frozen-lockfile` 重新生成
- `.gitignore`：手动合并，保留两边条目，去重

**类型适配（只改类型声明，不改逻辑）**：

- `feishu-her/src/channel.ts`：`sendText`/`sendMedia` 返回值新增 `messageId` 字段
- `feishu-her/src/gateway.ts`：`peer.kind` 从 `"dm"` 改为 `"direct"`（`ChatType` 枚举变更）
- `feishu-her/src/outbound.ts`：`Buffer` → `new Uint8Array()` 解决 `BlobPart` 类型不兼容
- `feishu-her/src/tools/chat.ts`：`page_size` 从 `String` 改为 `number`
- `feishu-her/src/tools/directory.ts`：`user_id_type` 添加联合类型断言
- `feishu-her/src/tools/bitable.ts`：`fields` 添加 `as any` 适配 Lark SDK 更严格的类型
- `realtime/index.ts`：移除不再公开导出的 `OpenClawPluginDefinition` 等类型
- `realtime/src/core-bridge.ts`：改为从 `dist/extensionAPI.js` 导入（新构建系统 flat output）
- `src/extensionAPI.ts`：新增 `resolveDefaultAgentId` 导出

**新版本关键行为变更**：

1. **plugin-auto-enable**：bundled 插件在 `channels.*` 有对应配置时自动启用 → 需要 `plugins.deny: ["feishu"]` 阻止上游 feishu 插件与 feishu-her 冲突
2. **scope-based WebSocket API**：Control UI 需要设备身份来获取 scopes → `dangerouslyDisableDeviceAuth` 会清空 scopes 导致 Web UI 失败
3. **构建系统变更**：`tsdown` + `rolldown` 产生 flat `dist/` 输出（带 hash 文件名），不再是嵌套目录

**Web UI 认证配置**：

- 本地 Her：不需要 `controlUi` 配置，localhost 设备配对自动批准（`isLocalClient → silent: true`）
- Docker 容器：`gateway.controlUi.allowInsecureAuth: true`（token auth + 设备身份，跳过配对审批）
- **永远不要使用** `dangerouslyDisableDeviceAuth: true`（会清空 scopes）

**验证**：本地 Her + Docker 1/3/4 全部重启验证通过。飞书消息收发、语音链路、Web UI 全部正常。零 missing-scope 错误，零 error/fatal/crash。

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
>
> - [Her 飞书 Bot 企业部署](her-feishu-bot-enterprise-deploy.md) — 方案全貌 + IT 操作清单
>
> 以下仅保留本文档特有的隐私分析和开发记录。

### 隐私与安全分析

#### 当前个人飞书 Bot 的安全状态

| 配置项    | 当前值             | 风险                                                   | 建议                                   |
| --------- | ------------------ | ------------------------------------------------------ | -------------------------------------- |
| dm.policy | open（默认）       | 如果在公司组织，同事可搜到 Bot 并进入你的 main session | 个人组织无风险；公司组织应设 allowlist |
| dmScope   | main（默认）       | 所有飞书用户共享同一个 session 和记忆                  | 个人组织无风险；多人场景需改 per-peer  |
| 可用范围  | 取决于开放平台设置 | "全部员工"意味着全公司可见                             | 限制为仅自己                           |

**已确认（2026-02-09）**：Bot 创建在**飞书个人版**组织，成员仅 Bob（所有者），无其他人。当前配置安全，不需要加 allowlist。

#### Docker 容器飞书 Bot 的安全保证

| 维度         | 保证                                       | 残留风险                                                 |
| ------------ | ------------------------------------------ | -------------------------------------------------------- |
| 数据隔离     | 容器内独立文件系统，记忆互不可见           | 容器运行在你的 Mac 上，你有 root 权限可 docker exec 读取 |
| 飞书消息隔离 | 每个容器一个独立 Bot，消息管道完全分离     | 你作为 Bot 创建者可在开放平台查审计日志                  |
| 访问控制     | dm.policy=allowlist 限制只有目标用户能使用 | 需要提前获取目标用户的飞书 open_id                       |
| 凭证安全     | 每个 Bot 的 appId/appSecret 只在对应容器内 | Bot 凭证由你保管和分发                                   |
| Google Cloud | 所有容器共享你的 gcloud 凭证               | 语音用量计在你的账户上                                   |

#### 各角色能做什么

| 操作              | 你（管理员）            | 老板（使用者） | 其他人            |
| ----------------- | ----------------------- | -------------- | ----------------- |
| 跟老板的 Bot 对话 | 被 allowlist 拒绝       | 正常使用       | 被 allowlist 拒绝 |
| 读老板的对话记忆  | 技术上能（docker exec） | 自然产生       | 不能              |
| 读你的对话记忆    | 自然产生                | 不能           | 不能              |
| 停止/重启容器     | 能                      | 不能           | 不能              |
| 查看 Bot 审计日志 | 能（开放平台）          | 不能           | 不能              |

### 开发 TODO

> 企业部署相关的验证记录已迁移至 [her-feishu-bot-enterprise-deploy.md](her-feishu-bot-enterprise-deploy.md#已完成的验证2026-02-09)。

- [ ] **P1**: 支持 `--feishu-allow=ou_xxx` 参数设置 allowlist
- [x] **P2**: 引用卡片消息优化 — 用户引用 AI 的 CardKit 卡片消息时，`getQuotedMessageContent()` 获取到的是降级 body。已通过本地缓存（CardKit stream 结束时缓存 messageId->finalText）+ 降级 elements 解析 fallback 解决。同时新增引用消息图片下载支持（standalone image、post embedded、interactive degraded img）。注：SDK 无 `card.get()` 读取 API，`cardkit.card.idConvert` 方案不可行，改用缓存方案（2026-02-14）。**增强（2026-02-25）**：卡片文本缓存升级为磁盘持久化（`~/.openclaw/feishu-card-text-cache.json`），TTL 7 天，上限 500 条，gateway 重启后缓存不丢失
- [ ] **P3**: 在 getting-started.md 中补充飞书 Bot 创建的详细截图指南

### 富文本回复 (2026-02-09)

**问题**：AI 回复中的 Markdown 格式（`**粗体**`、代码块等）在飞书中原样显示为纯文本符号。

**修复**：新增 `markdownToPost()` 转换函数 + `sendFeishuRichText()` 发送函数。检测文本是否包含 Markdown，有则转为飞书 Post 富文本消息（`msg_type: "post"`），无则保持纯文本（`msg_type: "text"`）。

**修改文件**：

- `outbound.ts` — 新增 `markdownToPost`、`parseInlineElements`、`hasMarkdown`、`sendFeishuRichText`（~140 行）
- `channel.ts` — `outbound.sendText` 和 `sendMedia` caption 改用 `sendFeishuRichText`
- `gateway.ts` — welcome 消息和 AI 回复 chunks 改用 `sendFeishuRichText`

**飞书 Post 富文本支持矩阵**（实测 2026-02-09）：

| 格式                      | 支持   | 渲染效果                       |
| ------------------------- | ------ | ------------------------------ |
| **粗体** `**text**`       | 完美   | bold style                     |
| _斜体_ `*text*`           | 完美   | italic style                   |
| **_粗斜体_** `***text***` | 完美   | bold+italic style              |
| 无序列表 `- item`         | 完美   | bullet 前缀，支持嵌套          |
| 有序列表 `1. item`        | 完美   | 数字前缀，支持嵌套             |
| 行内代码 `` `code` ``     | 完美   | bold+反引号                    |
| 代码块 ` ```lang ``` `    | 很棒   | code_block 标签，语法高亮+行号 |
| 链接 `[text](url)`        | 完美   | a 标签，可点击                 |
| 分隔线 `---`              | 完美   | hr 标签                        |
| Emoji                     | 完美   | 原生渲染                       |
| ~~删除线~~ `~~text~~`     | 不支持 | 原样显示                       |
| 引用块 `> text`           | 不支持 | 原样显示                       |
| 表格                      | 不支持 | 原样显示                       |
| 标题层级 `## ###`         | 降级   | 统一渲染为粗体（无大小区分）   |

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

| 消息内容                             | handler 耗时 | 飞书是否重推 | 重推间隔         |
| ------------------------------------ | ------------ | ------------ | ---------------- |
| "在吗"（简单对话）                   | **9,013ms**  | 是           | +19s（首次重试） |
| "/new"（新会话）                     | **6,537ms**  | 是           | +19s（首次重试） |
| "帮我查一下上海天气"（工具调用）     | **27,107ms** | 是           | +19s（首次重试） |
| "在吗" 重试（trackMessageId 拦截）   | **10ms**     | 否           | -                |
| "/new" 重试（trackMessageId 拦截）   | **7ms**      | 否           | -                |
| "查天气" 重试（trackMessageId 拦截） | **7ms**      | 否           | -                |

**关键发现**：

- 飞书 WebSocket 的 ACK 超时窗口约 **3-5 秒**
- 所有正常消息的 handler 耗时均 **6-27 秒**，远超超时窗口 → ACK 永远迟到
- 内存去重 `trackMessageId` 能拦截重试消息（10ms 内返回），ACK 及时发出 → 重试链中断
- **容器重启 → 内存去重缓存清空 → 重试消息无法拦截 → 每次都走完整 handler → ACK 每次都超时 → 7.1 小时持续重推**

### 飞书事件重试间隔

| 重试次序 | 间隔    | 累计    |
| -------- | ------- | ------- |
| 第 1 次  | +15 秒  | 15s     |
| 第 2 次  | +5 分钟 | 5m15s   |
| 第 3 次  | +1 小时 | 1h5m15s |
| 第 4 次  | +6 小时 | 7h5m15s |

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

| 消息内容                       | msgId（后4位） | 是否被飞书重推 |
| ------------------------------ | -------------- | -------------- |
| "/new"                         | f87c           | 否             |
| "帮我看一下北京天气吧"         | 4566           | 否             |
| "看一下无锡天气"（断电重启后） | e14b           | 否             |
| "/reset"                       | 1612           | 否             |
| "/new"                         | 9416           | 否             |

**断电测试**：发送"北京天气"后立即断电重启。ACK 已及时发出（飞书不重推），但 AI 回复因进程被 kill 而丢失。这是 `void` 方案的已知代价——trade-off：**消除重复推送 vs 极端断电时可能丢一条回复**。

**状态：已修复（2026-02-10），修改文件 `extensions/feishu-her/src/gateway.ts`。**

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

| 层            | 确认项                                                          | 结果                                     |
| ------------- | --------------------------------------------------------------- | ---------------------------------------- |
| OpenClaw 框架 | `onPartialReply` 回调（AI 每输出一个 token 就回调）             | 已有，Telegram draft stream 用的就是这个 |
| 飞书 SDK      | `cardkit.v1.card.create()` + `cardkit.v1.cardElement.content()` | SDK 1.58.0 已支持，类型定义完整          |
| 飞书 SDK      | `im.message.create({ msg_type: "interactive" })` 发送卡片消息   | 已支持                                   |

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

| Bug                                     | 根因                                                                                                                                                                                                                 | 修复                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 多段落时后一段覆盖前一段，中间内容丢失  | `onPartialReply` 的 text 是段落内累积（每个 assistant message 开始时 deltaBuffer reset），直接写入卡片会覆盖前面段落                                                                                                 | `updateCardStream` 内检测段落边界（新 text 不以上一次 text 为前缀 → 新段落），将前一段冻结到 `cardStreamPrefix`，写入 `prefix + 当前段落`                                               |
| 最后所有段落又从头到尾 stream 一遍      | `deliver` 在整个 turn 结束后才批量调用（不是每段之间），每次都调 `cardStream.update()` + `flush()`，重复写入已经流式展示过的内容                                                                                     | `deliver` 不再调用 `cardStream.update()`，只累积 `cardStreamFinalText` 给 finalize 用                                                                                                   |
| 聊天列表预览卡在"正在回复中..."不消失   | 创建卡片时设置了自定义 `summary.content: "正在回复中..."`，这是独立持久化字段，关闭 streaming_mode 不会自动清除                                                                                                      | 创建卡片时**不设** `summary.content`。飞书默认的"[生成中...]"由 `streaming_mode` 控制，关闭后平台自动移除，自动回落到卡片内容的摘要                                                     |
| 回复末尾内容截断（最后几个 token 丢失） | `onPartialReply` 可能未收到最后一小段文本（AI 最后的 token 直接通过 `deliver` 发出），而 `deliver` 只累积不更新 card                                                                                                 | `stopCardStream` 中 `stop()` 后用 `sendFinal(cardStreamFinalText)` 直接推送完整文本，绕过 throttle/inFlight 机制                                                                        |
| "[生成中...]"偶发不消失（竞争条件）     | `flush()` 在 `inFlight=true` 时 schedule 延迟 flush 然后立即 return，导致 `finalize(streaming_mode=false)` 先于延迟的 content update 到达飞书，飞书收到更高 sequence 的 content update 后可能重新激活 streaming 状态 | `stopCardStream` 先调 `stop()`（取消 timer + 阻止新 update），再用 `sendFinal` 直接 await 推送完整文本（无竞争），最后 `finalize`。保证 sequence 顺序：`sendFinal(N)` → `finalize(N+1)` |

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

| 维度                 | Telegram                                                         | 飞书                                                        |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| 原生 typing API      | `sendChatAction("typing")`（顶部状态栏）                         | 无                                                          |
| 流式文本             | `sendMessageDraft()`（OpenClaw 自实现的 hack，私聊+topics 限定） | `cardkit.cardElement.content()`（官方 API，原生打字机动画） |
| 效果                 | draft 消息逐步更新（非官方）                                     | 卡片内容逐字出现（官方打字机效果）                          |
| 最终样式             | 普通文本气泡                                                     | 卡片样式（有边框）                                          |
| 流式结束             | draftStream.stop()                                               | card.settings(streaming_mode=false)                         |
| 禁用 block streaming | `disableBlockStreaming: Boolean(draftStream)`                    | `disableBlockStreaming: !isCommand`                         |

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
8. ~~**Context Window 自动约束**~~：已实现（2026-02-15）-- 默认限制 context window 为 240K token（`contextTokens` + `contextWindow` 对齐），防止用户无感知地大量消耗 token 导致高额费用。详见 [context-window-architecture.md](context-window-architecture.md)
9. ~~**飞书端 Context Window 可视化**~~：已实现（2026-02-15）-- 每条 AI 回复的 CardKit 卡片底部自动追加状态行，格式: `🧠 **模型名** · 📊 Xk/240k (Y%) · 🧹 N次压缩`，数据源复用 `/status` session store，>=70% 自动警告。实现位于 `extensions/feishu-her/src/gateway.ts`
10. ~~**Claude Max 用量查询 `/quota`**~~：已实现（2026-02-19）-- 飞书输入 `/quota` 实时查询 Anthropic Claude Max 订阅用量。原理：发送一个最小 API 请求（`max_tokens: 1`），从响应头提取 `anthropic-ratelimit-unified-*` 系列 headers，展示 5h/7d 滚动窗口 utilization、重置时间、降级阈值、安全评估。与当前使用的 AI 模型无关（即使 primary 设为 OpenRouter，只要环境变量 `ANTHROPIC_OAUTH_TOKEN` 存在就能查询）。详见 [anthropic-max-enterprise.md](anthropic-max-enterprise.md)
11. ~~**@mention 发送**~~：已实现（2026-02-25）-- AI 可在飞书消息中 @提及用户（`<at user_id="ou_xxx">Name</at>`）和 @所有人（`<at user_id="all">`）。`markdownToPost` 解析 `<at>` 标签生成 Post `{ tag: "at", user_id }` 元素，text 格式原生透传。需要 `contact:user.base:readonly` + `contact:department.base:readonly` 权限

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

### 主人身份识别（Owner 机制）

> **重大认知（2026-02-24 实验验证）：** Owner 身份决定 AI 是否拥有 cron、gateway 等高权限工具。
> 源码中 `cron` 等工具标记 `ownerOnly: true`（见 `src/agents/tools/cron-tool.ts`），
> 非 owner 发送者的工具列表会被 `applyOwnerOnlyToolPolicy` 过滤（见 `src/agents/tool-policy.ts`）。
> CLI `agent` 命令硬编码 `senderIsOwner: true`（见 `src/commands/agent.ts:162`），因此 CLI 测试无法验证此机制。

#### 三层配置与优先级

| 配置                              | 位置   | 作用                                                           | 影响范围         |
| --------------------------------- | ------ | -------------------------------------------------------------- | ---------------- |
| `channels.feishu.dm.allowFrom`    | 频道级 | 单聊白名单（谁能发消息）+ **副作用：白名单成员被识别为 owner** | 访问控制 + owner |
| `channels.feishu.groups.ownerIds` | 频道级 | 群聊中的主人 ID（@bot 才回复）                                 | 仅群聊           |
| `commands.ownerAllowFrom`         | 全局级 | **显式声明 owner**（优先级最高，独立于频道白名单）             | 所有频道         |

**Owner 判定逻辑**（源码 `src/auto-reply/command-auth.ts`）：

```
1. 如果 commands.ownerAllowFrom 有具体 ID → 匹配则 senderIsOwner=true
2. 否则 fallback 到 dm.allowFrom 列表 → 匹配则 senderIsOwner=true
3. 两者都为空/不匹配 → senderIsOwner=false → ownerOnly 工具被过滤
```

**关键陷阱：`["*"]` 不等于所有人是 owner！**

| 配置值                       | 效果                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `dm.allowFrom: ["ou_xxx"]`   | 只有 ou_xxx 能聊天，且 ou_xxx 是 owner                                      |
| `dm.allowFrom: []` 或未设    | 所有人能聊天，但**无人是 owner**                                            |
| `dm.allowFrom: ["*"]`        | 所有人能聊天，但**无人是 owner**（`*` 触发 allowAll 路径，跳过 owner 匹配） |
| `ownerAllowFrom: ["ou_xxx"]` | ou_xxx 是 owner（不影响谁能聊天）                                           |
| `ownerAllowFrom: ["*"]`      | **无人是 owner**（同理，`*` 不匹配任何具体 ID）                             |

#### 企业部署场景

| 场景                      | 推荐配置                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| 一人一 Bot（专属 Her）    | `dm.allowFrom: ["ou_主人"]` — 同时限制访问 + 识别 owner                                    |
| 多人共享 Bot（测试/演示） | `dm.allowFrom` 留空（不限制访问）+ `commands.ownerAllowFrom: ["ou_管理员1", "ou_管理员2"]` |
| 群聊主人与 DM 主人不同    | 额外设 `groups.ownerIds: ["ou_群主人"]`，否则 fallback 到 `dm.allowFrom`                   |

#### 实验记录（2026-02-24，本地 carher-1）

| 测试 | dm.allowFrom | ownerAllowFrom    | AI 使用 cron 的方式                         | 结论                       |
| ---- | ------------ | ----------------- | ------------------------------------------- | -------------------------- |
| A    | 空           | 无                | `Exec: run openclaw cron`（fallback，失败） | 无 owner → cron 工具不可见 |
| B    | 空           | `["ou_e5e4e..."]` | `⏰ Cron`（原生工具，成功）                 | ownerAllowFrom 独立生效    |

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

> **已知问题（2026-02-15 已修复）：容器重启后 session write lock 死锁**
>
> 容器被 kill 时进程来不及释放 `.jsonl.lock` 文件，残留在 named volume 上。新容器启动后，主进程 PID 与旧容器相同（容器内永远是低号 PID），`isAlive(pid)` 误判为有效锁，导致 agent 无法写入 session 文件（10 秒超时报错 `session file locked`）。
>
> **修复**：`scripts/carher-entrypoint.sh` 在 gateway 启动前清理所有残留 `.jsonl.lock` 文件。容器刚启动时不可能有合法的 session write 在进行，清理零风险。

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
      allowFrom: ["ou_主人的openid"] # 单聊白名单 = 主人身份
    groups:
      enabled: true # 启用群聊支持（默认 false）
      archive: true # 归档群消息（默认 true）
      # ownerIds: ["ou_xxx"]            # 可选：显式指定群聊主人 ID（默认复用 dm.allowFrom）
```

### 飞书权限要求

群聊归档需要 `im:message.group_msg` 权限（获取群组中所有消息），而非仅 `im:message.group_at_msg`（只收 @bot 的消息），因为归档需要看到所有人的消息。

IT 创建 Bot 时在权限管理中额外开通：

| 权限                   | 用途                                |
| ---------------------- | ----------------------------------- |
| `im:message.group_msg` | 接收群聊所有消息（归档用）          |
| `im:chat:readonly`     | 获取群信息（群名，用于 index.json） |

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

**我们的飞书实现（`extensions/feishu-her/`）只在本地 dev 分支，未提交到 origin/main，未发布到 npm。**

### 代码规模对比

| 维度          | 我们的版本 | @openclaw/feishu (m1heng)   |
| ------------- | ---------- | --------------------------- |
| 源文件数      | 5 个       | 30 个                       |
| 总代码量      | ~1,800 行  | ~6,025 行                   |
| Lark SDK 版本 | ^1.50.0    | ^1.58.0                     |
| 附带 Skills   | 0          | 4 个（doc/wiki/drive/perm） |

### 功能对比

| 功能                               | 我们的版本                       | m1heng 版                | 说明                                                                                     |
| ---------------------------------- | -------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| **核心消息收发**                   | ✅                               | ✅                       | 均完整                                                                                   |
| **CardKit 流式卡片（打字机效果）** | ✅ 官方 API                      | ❌ 无                    | **我们的核心差异化能力**，~250 行核心逻辑，踩了 4 个竞争条件坑                           |
| **群聊 JSONL 归档**                | ✅                               | ❌ 无                    | **我们的核心差异化能力**，~60 行，企业场景刚需                                           |
| **ACK 超时修复**                   | ✅ `void` 异步                   | ❌ `await` 阻塞          | m1heng 版有此 bug：handler 6-27s 阻塞 ACK → 飞书 3-5s 超时重推，且无 trackMessageId 去重 |
| **Markdown 渲染**                  | 自研 `markdownToPost()` 140 行   | 飞书卡片原生 `tag: "md"` | m1heng 更简洁，且**支持表格**（我们的 Post 格式不支持）                                  |
| **图片收发 + Vision**              | ✅                               | ✅                       | 均完整                                                                                   |
| **飞书文档读写 (docx)**            | ❌                               | ✅ 521 行                | Markdown↔Block 双向转换，支持 20+ 种 Block 类型                                          |
| **知识库 Wiki**                    | ❌                               | ✅ 232 行                | 空间/节点导航 + 创建/移动/重命名                                                         |
| **云盘 Drive**                     | ❌                               | ✅ 227 行                | 文件夹 CRUD + 文件管理                                                                   |
| **多维表格 Bitable**               | ❌                               | ✅ 461 行                | 20+ 字段类型，筛选/排序/分页                                                             |
| **权限管理 Perm**                  | ❌                               | ✅ 173 行                | 协作者 CRUD                                                                              |
| **通讯录 Directory**               | ❌                               | ✅ 177 行                | 列出企业用户/群组                                                                        |
| **@mention 发送**                  | ✅ 已实现（2026-02-25）          | ✅ 126 行                | AI 可在消息中 @提及用户和 @所有人。text 原生透传 + Post 格式 `<at>` 标签解析             |
| **引用消息获取**                   | ✅ 已实现（2026-02-25 修复）     | ✅                       | `getQuotedMessageContent()` + `ReplyToId`/`ReplyToBody` 正确传递引用上下文给 AI          |
| **Emoji 表情回应**                 | ✅ 已实现                        | ✅ 160 行                | 消息 reaction，我们支持双机制（自动 ACK + AI 主动 react）                                |
| **Typing 提示**                    | CardKit 流式卡片 + Get emoji ACK | Emoji reaction 加/移除   | 双重方案：CardKit 流式打字 + Get emoji 收到即反馈                                        |
| **输入状态 (typing indicator)**    | CardKit streaming + Get emoji    | emoji reaction           | 我们双管齐下                                                                             |
| **权限错误自动诊断**               | ❌                               | ✅                       | 缺权限时提取 grant URL 通知 agent，200 bot 部署排障利器                                  |
| **Config Schema 验证**             | 空 schema                        | ✅ Typebox 完整校验      | 减少配置错误                                                                             |
| **Onboarding 引导**                | ❌                               | ✅ 359 行                | CLI 交互式配置                                                                           |
| **多账户并行**                     | 支持（单账户使用）               | 完善的并行启动           | —                                                                                        |
| **Markdown 表格渲染**              | ❌ 不支持                        | ✅ 支持                  | 卡片原生 md 支持表格                                                                     |
| **Render Mode 可配**               | 固定 Post 格式                   | auto/raw/card 三种       | 按内容自动选择卡片或文本                                                                 |

### 架构差异

| 维度     | 我们的版本                                                          | m1heng 版                                                                                  |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 入口     | `gateway.ts` 单文件 733 行大函数                                    | `bot.ts` 871 行 + `monitor.ts` 190 行，职责分离                                            |
| 回复派发 | `dispatchReplyWithBufferedBlockDispatcher`（自研 card stream 驱动） | `dispatchReplyFromConfig` + `createReplyDispatcherWithTyping`（OpenClaw 标准 typing 框架） |
| SDK 封装 | 直接操作 Lark SDK + 手写 HTTP（绕 SDK bug）                         | 封装了 `createFeishuClient` + `createEventDispatcher`                                      |
| 发送层   | `outbound.ts` 667 行（含 CardKit streaming 全部逻辑）               | `send.ts` 358 行 + `outbound.ts` 55 行 + `reply-dispatcher.ts` 179 行                      |

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

## 后续 TODO（从开源版本吸收到自研版本）

策略：**直接吸收社区版能力到本地 `extensions/feishu-her/`**，使其成为最强版本——既有流式卡片 + 群聊归档（社区版没有的），又有飞书文档/Wiki/云盘/Bitable 工具（当前没有的）。

基于对 `@m1heng-clawd/feishu` v0.1.9 源码的详细分析和实际测试（2026-02-12），按优先级排列：

### P1 — 短期必做（核心体验 + 飞书生态工具）

| #   | 任务                                | 状态                    | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **飞书文档读写**                    | ✅ 已验证               | `feishu_doc` 工具，读取/写入/追加/创建文档。日志 11:32 确认 wiki→doc 链路零报错，800 字总结                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | **知识库 Wiki 导航**                | ✅ 已验证               | `feishu_wiki` 工具，空间列表/节点导航。`listNodes` 自动附带 hint 引导 AI 用 `feishu_doc` 读取正文。日志 11:32 确认 wiki→doc 全链路正常                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 3   | **云盘文件管理**                    | ✅ 已验证               | `feishu_drive` 工具，文件夹列表/创建/移动/删除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | **多维表格 Bitable**                | ✅ 已验证               | `feishu_bitable` 工具，读取/创建/更新多维表格记录。权限已升级为 `bitable:app`（读写），19 项全量测试 18 项通过（2026-02-15）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **引用消息内容获取**                | ✅ 已验证               | `getQuotedMessageContent()` 自动获取被引用消息内容。增强：CardKit 流式卡片引用通过本地缓存解析实际文字（而非降级占位符）；引用图片消息自动下载图片供 AI vision 识别；引用 post 消息修复 flat format 兼容（2026-02-14）。**Bug 修复（2026-02-25）**：`ReplyToId` 从错误的 `messageId` 修正为 `parentId                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |     | messageId`，新增 `ReplyToBody` 传递引用文本（最长 2000 字符），AI 现在能在 inbound context 中看到完整引用内容。卡片文本缓存升级为磁盘持久化（7 天 TTL，500 条上限），解决 gateway 重启后引用 stream card 内容丢失问题 |
| 6   | **权限错误自动诊断**                | ✅ 已验证               | `extractPermissionError()` 正确检测 code=99991672 并提取 grant URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | **发送者姓名解析**                  | ❌ 个人版不可用         | `resolveFeishuSenderName()` 代码正常，权限已开通，API 返回 `code=0` 但 user 对象只有 `open_id,union_id,mobile_visible`，无 `name` 字段。**飞书个人版通讯录 API 不返回用户姓名（平台限制）**，需企业版/旗舰版                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | **画板/白板内容读取**               | ✅ 已验证               | `feishu_doc` 的 `read` 自动检测 block type_43，Board API 导出 PNG + vision image block 返回。日志 11:35/12:18/12:19 确认图片自动 resize 后 AI 成功理解画板内容（2063 字总结）。需要 `board:whiteboard:node:read` 权限（已开通）。**独家能力**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 9   | **Emoji 表情回应**                  | ✅ 已验证               | 两个机制：(1) 自动 ACK reaction — 收到消息时加 `Get` emoji，AI 回复后移除（typing indicator）；(2) AI 主动 react — 通过 `message` tool 的 `action="react"` 对消息加任意 emoji（已验证 THUMBSUP）。需要 `im:message.reaction:create` 权限                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | **回复样式（quote-reply）**         | ✅ 已验证               | CardKit 流式卡片通过 `im.message.reply` + `msg_type=interactive` 发送，AI 回复自动关联用户原消息，显示 `回复 Bob: xxx` 引用样式。私聊和群聊均生效                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 11  | **聊天文件附件读取（PPT/PDF/...）** | ✅ 已实现               | **完整实现**（2026-02-15，错误感知修复 2026-02-22）：(1) `extractTextContent()` 提取 `file_key` + `file_name`；(2) `downloadFeishuFile()` 通过 `im.messageResource.get({ type: "file" })` 下载文件（**飞书 API 限制 ≤100 MB**）；(3) 文件保存到本地磁盘；(4) **Office 文件自动提取文本**：飞书插件层集成 `officeparser`（纯 JS npm 包，支持 PPTX/DOCX/XLSX/ODT/ODP/ODS/RTF），自定义 AST 遍历提取 slide 分页 + 图表数据（含标签和数值）+ 表格内容 + 全部文本，注入 `<file>` 标签传给 AI；(5) PDF 走核心 `extractFileBlocks` 管线（pdfjs-dist）；(6) 图片作为文件发送时自动检测 image MIME 走 vision；(7) **下载失败时 AI 收到飞书具体错误码对应的清晰原因**（如 234037="file too large"、234001="invalid request parameters"、234003="resource does not belong to this message"、234004="bot is not in the chat"），而非笼统的 "download failed"。实现：从 AxiosError 的 `response.data`（可能是 ReadableStream/Buffer/string/object）中消费并解析飞书 JSON 错误体。Docker 部署零配置（officeparser 随 npm install 自动安装）。**已验证**：PPT 含图表数据+分页+表格全部正确提取，效果追平 python-pptx。**错误感知验证**（2026-02-22 Docker 1）：发送 VSCode-darwin-universal.zip（~200MB），AI 正确回复"收到 VSCode-darwin-universal.zip，但飞书限制 100MB 下载不了"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 12  | **文档写入安全性**                  | ✅ 已修复（2026-02-16） | **六层修复**：(1) **嵌套块 API 升级**：`insertBlocks()` 从 `documentBlockChildren.create` 升级为 `documentBlockDescendant.create`。旧 API 将所有块扁平化为文档根的直接子节点，嵌套无序列表（`- 一级\n  - 二级`）因 parent-child 关系冲突直接 400 报错。新 API 通过 `children_id`（顶层块 ID）+ `descendants`（全部块含 children 数组）原生支持嵌套结构。**已通过诊断脚本 100% 验证**：convert API 对嵌套无序列表返回 5 个块（3 个 first-level + 2 个 nested），嵌套有序列表则全部 first-level（不受影响）。(2) **增量编辑（格式保留）**：`update_block` 新增 `find`/`replace_with` 参数，读取当前 block 的 text*elements 做精准替换，保留加粗/链接/斜体等格式。(3) **write 前自动备份**：`writeDoc()` 在 `clearDocumentContent()` 前自动将文档纯文本导出到 `~/.openclaw/feishu-doc-backups/{docToken}*{timestamp}.md`。(4) **create 支持 content**：`feishu_doc create`现在接受`content` 参数，自动 create+write，不再创建空文档。(5) **Markdown 表格创建**：`insertBlocksWithTables()`按`firstLevelBlockIds` 顺序处理，遇到表格用两步法（`documentBlockChildren.create`创建空表格 +`documentBlock.patch` 逐格填充内容），其余块走 descendant API。**已通过诊断脚本 100% 验证**：4x3 表格 12 格全部填充成功。(6) **图片写入（本地+远程）**：`processImages()` 支持 HTTP URL 和本地文件路径（绝对路径/相对路径/file:// URL）。远程图片 fetch→temp file→`createReadStream`→upload；本地文件直接 `createReadStream`→upload，无需 temp file。Lark SDK 的 `drive.media.uploadAll`必须用`fs.createReadStream`（`Readable.from(buffer)` 会导致 400 "Error when parsing request"）。**已通过诊断脚本 100% 验证**：小胖子照片本地文件上传成功。**全量回归测试 101 块 0 错误 16 种格式全部通过**。**已修复的飞书平台限制**：Markdown 表格已支持（两步法），`drive.fileVersion.create()` 接口不存在（API 编辑不触发版本快照）。SKILL.md 引导 AI 优先走增量编辑路径 |
| 13  | **聊天视频附件读取**                | ✅ 已实现（2026-02-16） | **董事长需求**（2026-02-16）：用户在飞书聊天中发送视频附件，Her 无法接收和理解视频内容，回复"视频没有传过来"。**根因**：`extractTextContent()` 处理了 `text/post/image/file/audio/sticker`，唯独没有 `media`（视频消息类型）。**飞书视频消息结构（已确认）**：`msg_type="media"`，content=`{ "file_key": "file_v2_xxx", "image_key": "img_xxx" }`。`file_key` 是视频文件本体，`image_key` 是封面图。下载 API 与文件附件完全相同：`im/v1/messages/{message_id}/resources/{file_key}?type=file`（已有 `downloadFeishuFile`），上限 100MB。**实现方案**：**Step A（零新依赖，立即可用）**：(1) `extractTextContent` 增加 `media` 分支，收集 `file_key` + `image_key`；(2) 封面图走 `downloadFeishuImage`→vision（AI 能看到封面）；(3) 视频文件走 `downloadFeishuFile`→保存到本地磁盘；(4) 注入 `<file>` 标签告诉 AI 视频已下载到哪个路径 + 封面图可见。**Step B（进阶，按需）**：B1 ffmpeg 抽帧（Docker 加 apt install ffmpeg ~80MB），每 N 秒截一帧送 vision；B2 Gemini 原生视频理解（Files API 直传 MP4，支持最长 45 分钟含音频，效果最佳但需路由逻辑）。**模型能力**：Gemini 2.5 原生支持视频输入，Claude Opus/Sonnet 不支持视频（只支持图片/音频/PDF）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

| 14 | **[P0] feishu_doc 大文档写入不可用** | ✅ 已修复（2026-02-16） | **实测发现**（2026-02-16）：AI 尝试将本地大文档同步写入飞书云文档时频繁 400。**诊断脚本 100% 验证的根因**：(1) **`documentBlockDescendant.create` 不支持表格块**（`block_type=31`）——包含任何表格的请求直接 `1770001 invalid param`。(2) **`documentBlockChildren.create` 表格创建硬限制 9×9**——超过 9 行或 9 列的表格 `1770001 invalid param`（脚本验证 9×3✅ 10×3❌ 5×8✅ 5×10❌ 9×9✅ 9×10❌）。(3) **纯文本/列表/标题块实际无限制**——descendant API 单次 500 块、文档累计 2000 块、单块 50000 字符全部通过。**已修复（五项改进）**：(1) **大表格自动拆分**：`createAndFillTable()` 检测到表格超过 9 行时，自动拆分为多个 ≤9 行的子表格，每个子表格重复表头行。11×3 表格 → 9×3 + 3×3，**诊断验证全部填充成功**。(2) **错误信息增强**：`extractLarkError()` 从 AxiosError 提取 `response.data.code/msg`，`describeLarkError()` 映射错误码为可操作说明，`writeDoc`/`appendDoc` 顶层 catch 附加块统计 + 备份路径 + 恢复建议。(3) **$ 符号转义**：`convertMarkdown()` 预处理 `$(\d)` → `＄$1`（全角美元符），防止飞书将 `$500` 渲染为 LaTeX。(4) **SKILL.md 更新**：表格 9×9 限制说明 + 自动拆分行为。(5) **诊断脚本 100% 验证**：`diag-feishu-block-fixes.ts`（$ 转义 ✅、表格分离 ✅、错误信息 ✅）、`diag-feishu-table-limits.ts`（9×9 限制确认）、`diag-feishu-table-split.ts`（11×3 拆分为 9×3+3×3 全部填充 ✅）。 |

| 15 | **[P0] feishu_doc 大文档写入 LLM 超时** | ✅ 已修复（2026-02-16） | **实测发现**（2026-02-16）：AI 调用 `feishu_doc write` 写入 673 行文档时，LLM 需要将完整文档内容作为 tool 参数输出（~30K output tokens），流式传输 2-3 分钟后 `Network connection lost`，导致写入完全失败。**根因**：`feishu_doc write` 只接受 `content` 参数（inline markdown），AI 必须先读文件到上下文（~30K input tokens），再逐 token 输出完整内容作为工具参数（~30K output tokens）——双倍 token 浪费 + 网络超时风险。**修复**：新增 `source_file` 参数，工具直接从磁盘读取文件内容，AI 只需传一个文件路径字符串。write/append/create 三个 action 均支持。SKILL.md 明确指导：超过 ~20 行的内容必须用 `source_file`。**效果**：AI output 从 ~30K tokens 降至 ~50 tokens（仅文件路径），消除网络超时风险，工具调用延迟从 2-3 分钟降至 <1 秒。 |

| 16 | **聊天文件/音频/视频发送** | ✅ 已实现（2026-02-17） | **AI 可通过 `message` tool 发送任意文件到飞书聊天**。实现：(1) `sendMedia` 调用 `loadWebMedia(maxBytes=30MB)` 加载本地/远程文件（`sandboxValidated + readFile` 绕过 localRoots 限制）；(2) 按 contentType 自动路由：`audio/*` → `convertToOpus` → `uploadFeishuAudio` → `sendFeishuAudio`（`msg_type: "audio"`），`video/*` → `uploadFeishuFile` → `sendFeishuVideo`（`msg_type: "media"`，飞书要求视频用 media 而非 file，否则 230055 错误），`image/*` → `uploadFeishuImage` → `sendFeishuImage`，其他 → `uploadFeishuFile` → `sendFeishuFile`（`msg_type: "file"`）；(3) 飞书 IM 文件上限 30MB，在 `loadWebMedia` 层和 `uploadFeishuFile` 层双重拦截；(4) 错误传播：catch 块匹配 size/format 错误（"exceeds"/"limit"/"文件太大"/"230055"）并 re-throw 给 AI，确保 AI 收到可操作反馈。`deliverFeishuReply`（gateway 路径）同样实现了完整的音频/视频/图片/文件路由。**E2E 脚本验证**：WAV 17.7MB 音频 + MP4 3.1MB 视频均成功发送到飞书。Docker 1 压力测试：10 个 <30MB 小文件全部成功，10 个 >30MB 大文件全部正确拦截并返回清晰错误。 |

注：**Markdown 卡片/表格渲染**已由 CardKit 流式卡片天然支持（schema 2.0 + `tag: "markdown"`），无需额外实现。实测 car her 表格渲染完美，社区版 post 模式反而渲染异常。

#### 飞书开发者后台权限清单

**已开通（2026-02-15 更新，共 25 个 tenant 级别权限）：**

| 权限 scope                         | 用途         | 需要的功能                                                                                                     |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------- |
| `im:message`                       | 发送消息     | 基础消息收发                                                                                                   |
| `im:message:send_as_bot`           | Bot 发送消息 | 基础消息收发                                                                                                   |
| `im:message.group_msg`             | 群消息       | 群聊                                                                                                           |
| `im:message.p2p_msg:readonly`      | 单聊消息     | 私聊                                                                                                           |
| `im:chat:readonly`                 | 读取群信息   | 群名获取                                                                                                       |
| `im:resource`                      | 消息资源     | 图片下载                                                                                                       |
| `cardkit:card:write`               | 卡片写入     | CardKit 流式卡片                                                                                               |
| `contact:contact.base:readonly`    | 通讯录读取   | 发送者姓名解析（已开通，API 调用成功但个人版不返回 name 字段——平台限制，需企业版）                             |
| `contact:user.base:readonly`       | 用户基本信息 | **@mention 必需**：通过 open_id 查询用户姓名，AI 构建 `<at>` 标签前需获取 open_id→name 映射（2026-02-25 新增） |
| `contact:department.base:readonly` | 部门信息     | 通讯录按部门查人（2026-02-25 新增）                                                                            |
| `docs:doc`                         | 旧版文档     | 兼容                                                                                                           |
| `docx:document`                    | 新版文档完整 | 文档读写                                                                                                       |
| `docx:document:readonly`           | 文档只读     | 文档读取                                                                                                       |
| `docx:document:write_only`         | 文档写入     | 文档追加/写入                                                                                                  |
| `docx:document:create`             | 创建文档     | 新建文档                                                                                                       |
| `docx:document.block:convert`      | Block 转换   | Markdown→Block                                                                                                 |
| `drive:drive`                      | 云盘读写     | 云盘文件列表/创建文件夹（2026-02-15 升级）                                                                     |
| `drive:drive.metadata:readonly`    | 文件元数据   | 云空间文件元数据查看（2026-02-15 新增）                                                                        |
| `drive:drive.search:readonly`      | 搜索云文档   | 云文档搜索（2026-02-15 新增）                                                                                  |
| `drive:drive:version:readonly`     | 文档版本查看 | 查看文档版本信息（2026-02-15 新增）                                                                            |
| `wiki:wiki`                        | 知识库完整   | Wiki 读写                                                                                                      |
| `wiki:wiki:readonly`               | 知识库只读   | Wiki 导航/读取                                                                                                 |
| `board:whiteboard:node:create`     | 画板节点创建 | 画板内容创建                                                                                                   |
| `board:whiteboard:node:read`       | 画板节点读取 | 画板导出为 PNG 图片（P1 #8，已验证）                                                                           |
| `bitable:app`                      | 多维表格读写 | 多维表格记录读取/创建/更新（P1 #4，2026-02-15 升级并验证）                                                     |
| `im:message.reactions:read`        | 表情回应读取 | 读取消息上的 emoji 回应列表                                                                                    |
| `im:message.reactions:write_only`  | 表情回应写入 | Emoji reaction 自动 ACK + AI 主动 react（P1 #9）                                                               |

**尚未开通（需要时申请）：**

（当前所有已知需要的权限均已开通）

**资源级权限（非 API scope，在飞书 UI 中配置）：**

- 知识库空间权限：需将 bot 添加为空间成员，或设置"飞书个人版所有人可见"，或通过包含 bot 的群组间接授权

### P2 — 中期（企业功能扩展）

| #   | 任务                   | 参考文件                   | 工作量 | 说明                                                                                                                                                    |
| --- | ---------------------- | -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **权限管理工具**       | `perm.ts` ~170 行 + skill  | 0.5 天 | `feishu_perm` 工具，协作者 CRUD                                                                                                                         |
| 10  | **通讯录查询**         | ✅ 已完成                  | —      | `feishu_directory` 工具（`directory.ts` 162 行），用户列表/用户详情/部门列表。个人版限制：不返回用户姓名（仅 open_id/status），企业版正常（2026-02-15） |
| 10b | **群聊管理**           | ✅ 已完成                  | —      | `feishu_chat` 工具（`chat.ts` 142 行），Bot 已加入的群列表/群详情/群成员列表。SDK 方法名修复：`chatMembers.get`（非 `.list`）（2026-02-15）             |
| 11  | **Config Schema 验证** | `config-schema.ts` ~172 行 | 1 天   | Typebox 完整配置校验，减少 200 bot 部署时的配置错误                                                                                                     |
| 12  | **Onboarding CLI**     | `onboarding.ts` ~359 行    | 1.5 天 | `openclaw setup` 交互式引导配置飞书凭证                                                                                                                 |
| 13  | **状态探测**           | `probe.ts` ~44 行          | 0.5 天 | `openclaw channels status` 显示飞书连接状态                                                                                                             |

### P3 — 按需

| #   | 任务              | 参考文件                | 工作量 | 说明                                                                                                                                                                            |
| --- | ----------------- | ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | **@mention 发送** | ✅ 已实现（2026-02-25） | —      | AI 可在消息中 @提及用户（`<at user_id="ou_xxx">Name</at>`）和 @所有人。`markdownToPost` 解析 `<at>` 标签生成 Post 元素，text 格式原生透传。需 `contact:user.base:readonly` 权限 |

### 自研独有，不在开源版本中（持续维护）

| 能力                  | 状态      | 说明                                                                                                                                                                                                   |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CardKit 流式卡片      | ✅ 已验证 | 官方打字机动画，~250 行核心，竞争条件已全部修复。天然支持 Markdown 表格渲染（社区版 post 模式反而异常）                                                                                                |
| 群聊 JSONL 归档       | ✅ 已验证 | 本地归档 + index.json + skill 读取，~60 行。社区版完全没有此能力，群聊总结场景远远领先                                                                                                                 |
| ACK 超时修复          | ✅ 已验证 | `void` 异步 + `trackMessageId` 去重。社区版 WebSocket 模式仍有此 bug                                                                                                                                   |
| 企业 200 Bot 部署     | ✅ 已验证 | Docker 容器隔离 + CSV 用户管理 + 滚动升级                                                                                                                                                              |
| 纯 @mention 回复      | ✅ 已验证 | 群聊中纯 @bot（不带文字）不再被丢弃，正常触发回复（2026-02-12）                                                                                                                                        |
| 群聊管理 + 通讯录查询 | ✅ 已验证 | `feishu_chat`（群列表/群详情/群成员）+ `feishu_directory`（用户/部门查询）。19 项全量测试 18 项通过，唯一失败项为云盘 create_folder 工具层 bug（2026-02-15）                                           |
| Wiki→Doc 全链路       | ✅ 已验证 | `feishu_wiki` 返回 hint 引导 AI 用 `feishu_doc` 读取正文。日志 11:32 确认 wiki(2次)→doc(3次) 全链路零报错、800 字总结（2026-02-12）                                                                    |
| **画板/白板内容读取** | ✅ 已验证 | `feishu_doc` 的 `read` 自动检测 block type_43，Board API 导出 PNG + vision。日志 11:35/12:18/12:19 三次确认图片 resize + AI 2063 字总结。**社区版和所有已知飞书 bot 均未实现——独家优势**（2026-02-12） |

#### 实测对比：本地 car her vs Docker 社区版（2026-02-12 12:45-12:49）

测试文档："usb 拓扑"，包含 1 个表格（日期/任务/状态/备注）+ 3 个画板（3c 拓扑图、road test→fdi→cdi 流程图、RK3399 USB 完整拓扑大图）。

| 维度             | 本地 car her（自研）                                                              | Docker her（社区版）                                |
| ---------------- | --------------------------------------------------------------------------------- | --------------------------------------------------- |
| 文档定位         | 直接成功                                                                          | 第 1 次失败（"没找到 USB 拓扑文档"），第 2 次才成功 |
| 表格内容         | 读到（2685 字总结含表格细节）                                                     | 读到（"包含表格的文档"）                            |
| 画板内容（3 个） | 全部读到（`Image exceeds→resized`，AI 通过 vision 看到画板 PNG 并描述了拓扑细节） | 完全没读到（日志无任何 Image 处理）                 |
| 输出方式         | 1 条 CardKit 流式卡片                                                             | 5 条碎片消息逐条发送                                |
| 输出字数         | 2685 字完整总结                                                                   | 碎片式（每次 tool 中间结果都发一条消息）            |
| 加载体验         | 流式卡片打字机动画                                                                | typing emoji reaction（闪烁）                       |
| 群消息           | 正常处理+归档                                                                     | "我无法主动搜索或读取群组的历史聊天记录"            |
| 插件健康度       | 无警告                                                                            | 大量 `duplicate plugin id detected` 警告            |

#### 下一步任务（2026-02-17）

基于最新实测与复盘，后续任务按优先级如下：

1. **~~删除/微改默认走块级操作（P0）~~ ✅ 已完成（2026-02-25）**
   - 通过 SKILL.md 编辑策略升级实现：6 级优先级，`write` 降至最后手段。
   - AI 现在优先使用 `find/replace` > `update_block` > `insert_blocks` > `delete_block/delete_range` > `append` > `write`。

2. **~~补齐中间插入能力（P0）~~ ✅ 已完成（2026-02-25）**
   - 新增 `insert_blocks` action，支持 `after_block_id` / `before_block_id` 定位。
   - 底层 `insertBlocksWithTables()` 支持 `insertIndex` 参数。
   - API 实测验证：嵌套结构（列表、表格）均可在任意位置插入。

3. **~~补齐范围删除/批量删除（P1）~~ ✅ 已完成（2026-02-25）**
   - 新增 `delete_range` action，接受 `start_block_id` + `end_block_id`（均含）。
   - 底层调用 `documentBlockChildren.batchDelete` 一次性删除范围内所有 block。

4. **写后强校验标准化（P0）**
   - 写后必须做 `list_blocks` 校验：表格数、空单元格、关键标题顺序。
   - 禁止仅凭 `read/rawContent` 宣称“0 diff”。
   - SKILL.md 已有验证 SOP 指导。

5. **回归测试补齐（P1）**
   - 为 `update_block` 的整块 `content` 覆盖模式补测试（含格式影响）。
   - 保留并持续执行“同源文件 + 同 destination”脚本回归，确保真实场景稳定。
   - 已为 `insert_blocks` 和 `delete_range` 补充 4 个单元测试（2026-02-25）。

#### 回归防回退测试状态（2026-02-17）

已完成“旧版失败 -> 新版通过（测试代码零改动）”的防回退验证，并沉淀为可复用流程：

1. **新增 unit 防线（已通过）**
   - 文件：`extensions/feishu-her/src/tools/docx.test.ts`
   - 覆盖点：
     - `list_blocks` 分页拉全量（避免 500 截断）
     - `write` 清空阶段分页删除全部顶层块
     - `source_file` 读取优先级与参数互斥校验

2. **新增 e2e 防线（已通过）**
   - 文件：`extensions/feishu-her/src/tools/docx.e2e.test.ts`
   - 命令：`pnpm test:e2e:feishu-her`
   - 覆盖点：
     - 650 旧块场景下 `write` 必须全部清空后再写入
     - 750 块场景下 `list_blocks` 必须返回全量（非 500）

3. **旧版失败验证（已完成）**
   - 临时切换实现：`git restore --source 07eaaee5b -- extensions/feishu-her/src/tools/docx.ts`
   - 同一套测试不改动，结果：
     - unit：4/4 失败（分页调用次数与 source_file 语义不满足）
     - e2e：2/2 失败（`blocks_deleted` 500 vs 650、`list_blocks` 500 vs 750）

4. **切回新版验证（已完成）**
   - 恢复实现：`git restore --source HEAD -- extensions/feishu-her/src/tools/docx.ts`
   - 同一套测试不改动，结果：
     - unit：4/4 通过
     - e2e：2/2 通过

5. **CI 策略**
   - 耗时 e2e 不进默认快速链路，采用独立命令 `pnpm test:e2e:feishu-her`。
   - 默认 CI 继续以快速、确定性检查为主；e2e 走手动/专用流程。

#### Feishu Her 二开隔离与升级规范（2026-02-17）

目标：保证你只二开 `feishu-her`，同时随时低成本同步上游 `openclaw`。

1. **改动边界（硬约束）**
   - 业务功能只落在 `extensions/feishu-her/**`、对应 `skills/**` 与 `docs/her/**`。
   - 禁止把 Feishu 专有逻辑扩散到 `src/**` 通用框架层。
   - 若必须改核心，先在架构文档记录“不可避免原因 + 回退方案 + 上游对齐方案”。

2. **CI 隔离策略**
   - 上游默认 CI 行为不改：`ci.yml` 继续服务 `main`。
   - Fork 侧单独维护 `dev` 工作流（例如 `ci-dev.yml`），仅对 fork 的 `dev` 分支触发。
   - 本地门禁（pre-commit/pre-push）优先走本地未提交 hook，避免把个人流程提交进仓库主线。

3. **升级流程（固定 SOP）**
   - 固定节奏把 `upstream/main` 同步到你的 `dev`（rebase 优先）。
   - 每次同步后先跑：`pnpm check && pnpm build && pnpm test && pnpm test:e2e`。
   - Feishu 回归固定跑“同源文件 + 同 destination”脚本，验证表格、顺序、空单元格与重复写入问题。

4. **冲突处理优先级**
   - 优先保持 upstream 原实现不动，在扩展层适配。
   - 若冲突发生在框架层，优先回退到扩展层方案，不做长期框架分叉。
   - 对任何临时补丁设置“删除条件”（上游修复后移除）。

---

## 总结

飞书通道本质上是在 OpenClaw 的通道体系中新增一个标准通道插件。它与 Her（realtime 语音通道）完全平行，与 Telegram/Slack/Discord 完全同构。

- 实际新增代码 ~1,800 行，全部在 `extensions/feishu-her/` 内
- 不修改 OpenClaw 核心代码的任何一行
- 不修改 Her（realtime 插件）的任何一行
- 不修改任何已有扩展的任何一行
- 风险极低：官方 API + 独立插件 + 活跃维护的 SDK
- 端到端聊天已验证通过
- 与开源社区版本对比后决策：**直接吸收社区版生态工具到自研版本**，打造最强飞书插件（2026-02-12）
