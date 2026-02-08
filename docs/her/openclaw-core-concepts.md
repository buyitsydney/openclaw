# OpenClaw 核心概念指南

本文档用一个完整的现实类比，讲清楚 OpenClaw 中 Gateway、Channel、Session、Lane、Plugin、Heartbeat 等核心概念之间的关系。

---

## 类比设定

**你是一个 CEO，Pi（OpenClaw Agent）是你的私人助理。**

| OpenClaw 概念 | 类比 | 一句话解释 |
|---|---|---|
| **Agent（Pi）** | 私人助理 | 真正干活、思考、回复的大脑 |
| **Gateway** | Pi 的办公桌（总机台） | 所有事情都经过这里调度 |
| **Channel（通道）** | 联系方式：座机、微信、对讲机 | 消息的入口和出口 |
| **Plugin（插件）** | 安装在办公桌上的设备 | 让 Gateway 支持某种通道的代码模块 |
| **Session（会话）** | Pi 的工作笔记本 | 一段对话上下文，存为 `.jsonl` 文件 |
| **Session Key** | 笔记本的编号标签 | 会话的唯一标识，如 `agent:main:main` |
| **Session Entry** | 笔记本封面上的便签条 | 会话的元数据：上次谁来的、发给谁 |
| **lastChannel + lastTo** | 便签上的"上次联系方式" | Pi 主动找你时看这里决定用哪种方式 |
| **Lane（车道）** | 排队规则 | 控制同一笔记本上的任务串行/并行 |
| **Heartbeat** | Pi 每半小时主动巡查 | 定时检查邮箱/日历，有事主动联系你 |
| **Cron** | 日历上标注的定时提醒 | 到点触发，交给 agent 处理后投递 |

---

## 完整场景推演

### 上午 10 点：你用座机（Telegram）打给 Pi

```
你拿起座机（Telegram），拨通 Pi 办公桌上的电话。

  座机（Telegram）──→ Pi 的办公桌（Gateway）
                       │
                       ├─ 1. 翻开主笔记本 agent:main:main
                       ├─ 2. 在封面便签上更新：
                       │     上次联系方式: 座机 (lastChannel = "telegram")
                       │     号码: 123456789   (lastTo = "123456789")
                       └─ 3. 记录对话内容到笔记本
```

你说："帮我看看明天有什么会议。"

Pi 翻看日历，通过座机回复："明天上午有产品评审，下午有投资人会议。"

### 上午 11 点：你改用微信（webchat）

你打开微信给 Pi 发消息："刚才说的那个投资人会议，帮我准备一下材料。"

```
  微信（webchat）───→ Pi 的办公桌（Gateway）
                       │
                       ├─ 翻开同一本主笔记本 agent:main:main
                       │  （和座机用同一本！）
                       ├─ 更新便签：上次联系方式 → 微信
                       └─ Pi 能看到上午座机聊的内容
                          → 知道你说的是哪个会议 ✅
```

**这就是"跨通道上下文延续"** — 不同通道共享同一个 Session，Pi 能看到完整对话历史。

### 下午 1 点：你让 Pi 设提醒

通过微信说："提醒我下午 3 点开会。"

Pi 在日历上标注（创建 cron job），回复："好的，下午 3 点会提醒你。"

### 下午 2 点：你又用了座机

便签条更新回"上次联系方式: 座机"。

### 下午 3 点：提醒触发 — Pi 主动联系你

日历响了！Pi 需要主动提醒你。但你没有打电话来也没发微信。

Pi 翻开封面便签条："上次联系方式: 座机，号码 123456789"。

于是 Pi 拨打座机 → 你的 Telegram 收到提醒。

---

## 概念详解

### Session（会话）— 笔记本

Session 是 OpenClaw 中最核心的概念。它是一段对话的完整上下文，物理上存储为 `.jsonl` 文件。

**Session Key 的命名规则：**

| 场景 | Session Key | 说明 |
|------|------------|------|
| DM（默认） | `agent:main:main` | 所有 DM 共享一个主 session |
| DM（per-peer） | `agent:main:dm:+1234` | 每个聊天对象独立 session |
| Telegram 群组 | `agent:main:telegram:group:-100999` | 每个群独立 session |
| Cron 任务 | `cron:job-id` | 每个 cron job 独立 session |
| Her（当前旁路） | `realtime:timestamp-random` | 独立于 main 的临时 session |

**关键理解：** 默认配置下（`dmScope: "main"`），Telegram DM、webchat、CLI 全部共用 `agent:main:main` 这一个 session。这就是为什么不同通道能看到彼此的对话历史。

### Session Entry（便签条）— 元数据

Session Entry 存在 `sessions.json` 中，是 session 的元数据：

```json
{
  "agent:main:main": {
    "sessionId": "abc-123",
    "updatedAt": 1738900000000,
    "lastChannel": "telegram",
    "lastTo": "123456789",
    "lastAccountId": "bot_xxx"
  }
}
```

**`lastChannel` 和 `lastTo` 的作用：** 当 Pi 需要主动联系你（heartbeat、cron 提醒）时，Pi 不知道你现在在哪里，只能看便签条上记录的"上次用的联系方式"。

**注意：`lastChannel` 记录的是"用户最后一次联系 Pi 的通道"，不是"某个特定操作发生时的通道"。** 这意味着如果你在 Telegram 设了提醒，之后又用了飞书，提醒触发时会发到飞书。具体分析见下方"lastChannel 设计分析"章节。

### Channel（通道）— 消息的入口和出口

Channel 是用户和 Pi 之间的消息传输通道。每个 Channel 由一个 Plugin 实现。

内置通道：`telegram`、`discord`、`slack`、`signal`、`imessage`、`whatsapp`（web）

扩展通道（Plugin）：`msteams`、`matrix`、`zalo`、`voice-call`、`realtime`（Her）

**每个 Channel 做三件事：**
1. **接收消息** → 调用 Gateway 的 `agent` 方法
2. **更新 lastChannel** → 记录"最后一次联系来自哪里"
3. **投递回复** → 把 agent 的回复发送给用户

### Lane（车道）— 排队机制

Lane 是控制 agent 执行并发的队列系统。采用**双层嵌套**结构：

**第一层：Session Lane（每 session 一个队列）**

```
session:agent:main:main  → 并发上限 = 1（永远）
session:agent:main:telegram:group:-100999 → 并发上限 = 1
```

同一个 session 上的所有请求必须排队执行，因为不能同时往一本笔记本上写字。

**第二层：Global Lane（全局流量控制）**

```
"main"     → 并发上限 = 4（可配置）
"cron"     → 并发上限 = 1（可配置）
"subagent" → 并发上限 = 8（可配置）
```

控制整个系统同时能跑多少个 agent。

**执行流程：**

```
任务进入 → Session Lane 排队（保证同一 session 串行）
              ↓ 放行后
         Global Lane 排队（控制总并行度）
              ↓ 放行后
         实际执行 Agent
```

详细推演见下方"Lane 并发推演"章节。

### Plugin（插件）— 扩展模块

Plugin 是 Gateway 的扩展机制，可以注册：

- **Channel**：新的消息通道（如 `extensions/msteams`）
- **Tool**：新的 agent 工具
- **Hook**：在 agent 生命周期中注入逻辑（如 `before_agent_start`）
- **Gateway Method**：新的 Gateway API 方法
- **CLI Command**：新的命令行命令

Her 的 realtime 插件比较特殊 — 它没有注册为标准 Channel（不通过 Gateway 的 `agent` 方法），而是启动了自己的 WebSocket 服务器，直接调用底层的 `runEmbeddedPiAgent`。这就是"旁路集成"的含义。

### Heartbeat — 定时巡查

Heartbeat 是 Gateway 的定时任务，默认每 30 分钟运行一次：

1. 检查 main session 的 system events（邮件、日历等）
2. 如果有需要通知用户的内容，产出回复
3. 调用 `resolveHeartbeatDeliveryTarget()` 决定投递到哪里
4. 默认 `target: "last"` → 读取 session entry 的 `lastChannel`/`lastTo`
5. 投递到对应通道

---

## lastChannel 设计分析

### 设计意图

`lastChannel` 的设计哲学是**"投递到用户最可能在的地方"**，而不是"投递到操作发起的地方"。

类比：你让 Pi 设了一个提醒，Pi 在日历上标注了。到时间时，Pi 不会想"这个提醒是老板用座机设的，所以我要打座机"，而是想"老板上次用的是微信，所以他现在可能在微信上"。

### 实际行为

```
10:00  你用 Telegram 说"提醒我 3 点开会"  → lastChannel = telegram
11:00  你用飞书聊了别的事                  → lastChannel = feishu
15:00  提醒触发 → 看 lastChannel → 发到飞书
```

### cron 支持指定通道

cron job 的 payload 中可以显式指定 `channel`，不一定用 `"last"`：

```json
{
  "kind": "agentTurn",
  "message": "提醒用户开会",
  "deliver": true,
  "channel": "telegram",
  "to": "123456789"
}
```

但默认情况下，agent 创建 cron job 时不会自动填入当前通道，所以 `channel` 默认为 `"last"`。

如果希望"原路返回"（提醒发回设置时的通道），需要 agent 在创建 cron job 时显式指定 `channel` 字段。

---

## Lane 并发推演

### 场景：你同时打座机 + 发微信 + 用对讲机

三个请求都指向 `agent:main:main` session：

```
Session Lane "session:agent:main:main" [并发=1]
┌─────────────────────────────────────────────────┐
│  [执行中] 座机来的请求                           │
│  [排队 1] 微信来的请求   ← 等座机完成           │
│  [排队 2] 对讲机来的请求 ← 等微信完成           │
└─────────────────────────────────────────────────┘
```

**为什么 session 并发必须 = 1？**

Session 的对话历史存在 `.jsonl` 文件中。如果两个 agent 同时运行在同一个 session 上：

1. 两个 agent 读到相同的对话历史
2. 两个 agent 各自产出回复
3. 两个 agent 同时往 `.jsonl` 文件追加内容 → **数据错乱**
4. agent A 的回复和 agent B 的回复交错写入 → 对话历史损坏

虽然有 `session-write-lock.ts` 文件锁保护单次写入，但 agent 运行过程中会多次读写 session 文件。两个 agent 并行运行会导致"读到过时的上下文 → 回复不连贯"。

**Session Lane 并发 = 1 不是配置选项，是安全保障。** 代码中永远不会对 session lane 调用 `setCommandLaneConcurrency`。

### 场景：不同 session 可以并行

```
Session Lane "session:agent:main:main"           [并发=1]  → 座机请求
Session Lane "session:agent:main:telegram:group:-100999" [并发=1]  → 群聊请求

这两个任务在不同 session 上 → 互不阻塞 → 同时执行

Global Lane "main" [并发=4]
┌──────────────────────────────────────────────────┐
│  [slot 1] 座机请求（agent:main:main）            │
│  [slot 2] 群聊请求（telegram:group:-100999）     │
│  [slot 3] 空闲                                    │
│  [slot 4] 空闲                                    │
└──────────────────────────────────────────────────┘
```

**Global Lane 并发 = 4 表示**：整个系统最多同时执行 4 个 agent 运行。
不同 session 的请求可以并行，但 main lane 的 4 个坑位用完后，新请求必须等。

### 并发配置总结

| Lane 类型 | 并发上限 | 是否可配置 | 作用 |
|-----------|---------|-----------|------|
| Session Lane（`session:*`） | **1** | **不可配** | 保证同一 session 串行 |
| Global Lane `main` | 4 | 可配 `agents.defaults.maxConcurrent` | 控制总体 agent 并行度 |
| Global Lane `cron` | 1 | 可配 `cron.maxConcurrentRuns` | 控制 cron 并行度 |
| Global Lane `subagent` | 8 | 可配 `agents.defaults.subagents.maxConcurrent` | 控制子 agent 并行度 |

---

## 整体关系图

```
                              用户
                    ┌──────────┼──────────┐
                    │          │          │
               座机电话      微信      对讲机
              (Telegram)   (webchat)    (Her)
                    │          │          │
                    ↓          ↓          ↓
              ┌─ Plugin ─┐┌─ Plugin ─┐┌─ Plugin ─┐
              │ 电话机    ││ 微信客户端││ 对讲基站 │
              └─────┬─────┘└─────┬─────┘└────┬─────┘
                    │            │            │
                    ↓            ↓            ↓
         ┌──────────────────────────────────────────┐
         │           Gateway（Pi 的办公桌）          │
         │                                          │
         │  ┌─ Session Store ─────────────────────┐ │
         │  │  主笔记本 agent:main:main           │ │
         │  │    封面便签: lastChannel / lastTo    │ │
         │  │    内容: 完整对话历史                │ │
         │  └─────────────────────────────────────┘ │
         │                                          │
         │  ┌─ Lane Queue ────────────────────────┐ │
         │  │  Session Lane [并发=1/session]       │ │
         │  │    → Global Lane [并发=4]            │ │
         │  └─────────────────────────────────────┘ │
         │                                          │
         │  ┌─ Heartbeat + Cron ──────────────────┐ │
         │  │  定时巡查 → 看便签 → 投递到通道     │ │
         │  └─────────────────────────────────────┘ │
         └──────────────────────────────────────────┘
                           │
                           ↓
                    Agent（Pi 本人）
```

**一句话总结：** 你通过不同的 **通道**（Channel）联系 Pi，每个通道靠一个 **插件**（Plugin）接入 Pi 的 **办公桌**（Gateway）。Pi 把所有对话记在一本 **笔记本**（Session）里，用 **编号**（Session Key）区分不同笔记本，在 **封面便签**（Session Entry / lastChannel）上记住你上次用的联系方式。Pi 同一时间只能写一本笔记本，靠 **排队**（Lane）确保不冲突。Pi 还会 **定时巡查**（Heartbeat），有事时看便签条找到你。
