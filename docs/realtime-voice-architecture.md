# Realtime Voice Architecture v2

实时语音交互架构：Her (快思考) + OpenClaw (慢思考)

## 设计原则

1. **极简**：Her 只有 1 个 Tool（`openclaw_help`），无其他复杂协议
2. **快慢分离**：Her 负责即时响应，OpenClaw 负责深度处理
3. **单一数据流**：所有结果通过 `tool_response` 返回，无 inject/监督者
4. **零侵入**：作为独立插件实现，不修改 OpenClaw 核心代码

---

## 角色定义

### Her（前台，快思考）

**身份**：车载语音助手，负责低延时语音对话

**能力边界**：
- 基于 prompt 内的信息即时回答
- 简单问候、情感交流、闲聊
- 用户画像里已有的信息（来自 liveMemoryCapsule）

**不具备**：
- 可靠的长期记忆检索
- 外部信息查询能力
- 复杂推理/规划能力
- 任何外部操作能力

**核心规则**：
- 简单问题直接回答，要亲切称呼用户（如"天哥"）
- 不知道用户称呼时主动询问
- 任何不确定的事情 → 调用 `openclaw_help`
- **宁可多问 OpenClaw，不要瞎猜**

### OpenClaw（后台，慢思考）

**身份**：后台高智能代理，负责深度任务处理

**能力**：
- 复杂任务：编程、写文章、做报告、数据分析
- 记忆检索：USER.md / MEMORY.md
- 外部操作：搜索、浏览器、发消息、设置提醒
- 深度推理：规划、对比、归纳、纠错

**核心规则**：
- 收到请求后完整处理
- 审视对话上下文，发现需要补充的信息
- 在处理过程中自动更新 Memory
- 返回给 Her 的内容要口语化、简洁

---

## 数据流

```
                          用户
                            │
                       语音输入
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Her (快思考)                                │
│                                                                 │
│  收到用户输入 → 判断能否快思考解决                               │
│                                                                 │
│  ┌─────────────┐              ┌──────────────────────────┐     │
│  │ 能解决      │              │ 不能解决 / 不确定         │     │
│  │ - 问候闲聊  │              │ - 需要记忆/查询的事情     │     │
│  │ - 已知信息  │              │ - 复杂任务/外部操作       │     │
│  │ - 简单常识  │              │ - 任何拿不准的情况        │     │
│  └──────┬──────┘              └───────────┬──────────────┘     │
│         │                                  │                    │
│         ↓                                  ↓                    │
│    直接回答              toolCall(openclaw_help, request)       │
│    "天哥你好！"                            │                    │
└─────────────────────────────────────────────┼────────────────────┘
                                             │
                                             ↓
┌─────────────────────────────────────────────────────────────────┐
│                     OpenClaw (慢思考)                            │
│                                                                 │
│  收到：请求 + 完整对话上下文                                     │
│                                                                 │
│  处理：                                                         │
│  1. 执行任务（查询/编程/写作/设置提醒等）                        │
│  2. 审视上下文，发现需要补充的信息                               │
│  3. 自动更新 Memory（如有必要）                                  │
│                                                                 │
│  返回：tool_response                                            │
│  - 任务结果（口语化，适合播报）                                  │
│  - 上下文补充信息（如有）                                        │
└─────────────────────────────────────────────┬────────────────────┘
                                             │
                                             ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Her (快思考)                                │
│                                                                 │
│  收到 tool_response → 用自己的话播报给用户                       │
└─────────────────────────────────────────────────────────────────┘
                            │
                       语音输出
                            ↓
                          用户
```

---

## 场景推演

### 场景 1：简单问候（快思考直接解决）

```
用户: "你好啊"
Her: [快思考] 这是问候，我可以直接回答
Her: "天哥你好！开车还顺利吗？"
```

**关键**：Her 要亲切称呼用户（从 liveMemoryCapsule 获取）

### 场景 2：需要记忆的问题

```
用户: "我爸爸在哪？"
Her: [快思考] 这涉及用户家人信息，liveMemoryCapsule 里有
Her: "你爸妈在海南度假呢，计划待三个月。"
```

**关键**：如果 liveMemoryCapsule 里已有信息，Her 可以直接回答

### 场景 3：复杂查询

```
用户: "查一下明天上海的天气"
Her: [快思考] 天气查询需要外部信息
Her: "好，我查一下" → toolCall(openclaw_help)

OpenClaw:
  - 执行天气查询
  - 返回 tool_response: "明天上海多云，气温10到15度，傍晚可能有小雨"

Her: "明天上海多云，10到15度，傍晚可能下雨，记得带把伞。"
```

### 场景 4：长任务

```
用户: "帮我查明天去海南的机票"
Her: [快思考] 机票查询是复杂任务
Her: "好的，我帮你查" → toolCall(openclaw_help)

[两段式协议]
1. 立即返回 ACK: tool_response({status: "processing"})
   → Her 可以继续说话："正在查，稍等一下"

2. OpenClaw 完成后，结果进入 pendingResults 队列
   → 在安全窗口（TURN_COMPLETE + audio idle）自动投递给 Gemini
   → Her 播报："机票查好了，最便宜的是..."
```

**关键**：
- 立即 ACK 解除阻塞，Her 不会傻等
- 结果在安全窗口自动投递，不需要用户追问

### 场景 5：Her 没意识到的问题

```
用户: "今晚聚会我准备喝点"
Her: [快思考] 闲聊，我直接回应
Her: "听起来挺有意思！"

用户: "对了，查一下明天的天气"
Her: → toolCall(openclaw_help, "查明天天气")

OpenClaw:
  - 执行天气查询
  - 同时审视对话上下文，发现用户提到"喝点"
  - 查 Memory，发现用户有健康相关记录
  - 返回: "明天天气多云...另外，刚才你提到要喝酒，提醒你注意健康。"

Her: "明天多云，15度左右。对了，你刚说要喝点，身体能行吗？"
```

**关键**：OpenClaw 每次被调用时都会审视完整上下文，有机会发现 Her 遗漏的问题

---

## 为什么去掉 Supervisor（监督者）

### 之前的问题

1. **context 不同步**：Supervisor 和 Help 的 conversation 都只有转录，不包含已经投递给 Gemini 的内容
2. **重复投递**：Help 返回结果后，Supervisor 不知道，可能再投递一遍类似内容
3. **时机问题**：Supervisor 的 TurnAssembler 可能在 Gemini 还没播报完时就触发
4. **协议复杂**：inject + 控制句机制容易被 RESPONSE_REJECTED

### 新设计

| 原来 Supervisor 做的事 | 新架构里谁做 |
|------------------------|-------------|
| 监控对话 | OpenClaw 每次被调用时都能看到完整上下文 |
| 发现需要提醒的事情 | OpenClaw 在处理任务时顺便检查 |
| 更新 Memory | OpenClaw 在处理任务时自动更新 |

**结论**：Supervisor 的所有职责都可以在 OpenClaw 被调用时完成，不需要单独的监督者。

---

## Prompt 设计

### Her (Gemini Live) 的 System Prompt

> **变化**：相比原来，大幅简化。去掉了"控制句"、"inject 协议"等复杂规则。

```
你是 Her，车载语音助手，负责快思考。用户正在开车。

## 你的身份
- 你是用户的贴心助手，温柔、自然
- 如果知道用户名字（见下方画像），要亲切称呼
- 如果不知道，第一次对话时可以礼貌询问

## 能力边界
你只能基于以下信息做快思考：
- 用户刚说的话
- 下方的用户画像摘要（liveMemoryCapsule）
- 常识

你不具备：
- 可靠的长期记忆检索
- 外部信息查询
- 复杂推理能力
- 任何外部操作能力

## 判断规则
收到用户输入后判断：

**快思考能解决** → 直接回答：
- 问候、闲聊、情感交流
- 画像摘要里明确有的信息
- 简单常识

**需要慢思考** → 调用 openclaw_help：
- 画像里没有的用户信息
- 需要查询/检索的事情
- 深度思考/规划/分析
- 设置提醒、发消息、编程等操作
- 任何不确定的事情

**核心原则：宁可多问 OpenClaw，不要瞎猜！**

## 工具调用后
收到 tool_response 后，用你自己的话对用户播报结论，简洁、口语化。

## 用户画像摘要
{liveMemoryCapsule}
```

### OpenClaw 处理 Help 请求时的 Prompt

> **原则**：基于现有 `buildBackendModePrompt` 改进，不是完全重写。现有的三方角色定义保留。

**现有 prompt 核心内容（保留不变）**：

```typescript
// extensions/realtime/src/prompt.ts
你是 OpenClaw，是后台的大脑与监督者（后台大哥）。你不会直接对用户说话。

系统有三方：
- 用户：真实人类。用户只与 Live 语音对话，用户也只能听到 Live 的回复。
- Live：前台语音助手，负责低延时语音对话与播报。它的智能/上下文/工具能力都弱于你。
- 你（OpenClaw）：后台高智能代理。你旁观 Live↔用户对话，在需要时支援 Live。

路由语义：
- 你收到的"对话上下文/事件"都来自 Live 的同步。
- 你输出的任何文字都会被送给 Live，由 Live 决定如何对用户表达；用户不会直接看到你。

目标：
- Live 保证低延时与自然对话体验；
- 你在关键时刻提供强智能支援（补全信息、纠错、提醒、规划）。
```

**建议在动态 prompt（handleHelpRequest）中增加**：

```
## 处理要求

1. **执行任务**：完成 Live 请求的具体事项

2. **审视上下文**：处理时检查对话是否有需要补充的信息
   - 发现重要事项但 Live 没注意到 → 在结果后提醒

3. **输出格式**：
   - 口语化，适合语音播报
   - 简洁，不要长篇大论
```

> **注意**：OpenClaw 原有能力已包含自动更新 USER.md / MEMORY.md，不需要额外提醒。

---

## 技术实现要点

### 现有代码分析

**1. 立即 ACK（保留）**：
```javascript
// script.js line 524-528
state.client.sendToolResponse(functionCallId, "openclaw_help", {
  ok: true,
  status: "processing",
  jobId: functionCallId,
});
```

**2. 异步结果投递（现有实现）**：
```javascript
// script.js onHelpResult
openclawConnection.onHelpResult = (callId, reply) => {
  state.pendingInjects.push(reply);  // 进入队列
  tryDeliverInjects();
};

// inject-delivery.js deliverNextInject
client.sendTextMessage(reply, { role: "model" });     // inject 内容
client.sendTextMessage(controlLine, { role: "user" }); // 控制句（触发 Gemini 播报）
```

### 新设计

**去掉控制句**：
```javascript
// inject-delivery.js 改为只发 role=model
client.sendTextMessage(reply, { role: "model" });
// 不发 controlLine
```

**去掉 Supervisor 整个路径**：
- 删除 `server.ts` 中 `runSupervisorTurn` 相关代码
- 删除 `enqueueSupervisorTurn` 调用
- 删除 `turnAssembler` 相关代码（如果只用于 Supervisor）

### conversation 记录完整化

**现有问题**：`client.conversation` 只记录转录，不记录 tool 调用和结果

**改进**：
```typescript
// 当 Help 返回结果时，也记录到 conversation
client.conversation.push(`[OpenClaw]: ${result}`);
```

这样即使将来还需要审视上下文，也能看到完整信息。

---

## 实现状态

| 能力 | 状态 | 备注 |
|------|------|------|
| Her 调用 openclaw_help | ✅ 已实现 | |
| 两段式 ACK | ✅ 已实现 | 立即返回 processing |
| 结果异步投递 | ✅ 已实现 | 安全窗口投递 |
| Supervisor 监督 | ❌ 建议去掉 | 简化架构 |
| 控制句触发 | ❌ 建议去掉 | 减少 RESPONSE_REJECTED |
| liveMemoryCapsule | ✅ 已实现 | 用户画像摘要 |
| Her 亲切称呼用户 | ⚠️ 需改进 prompt | |
| conversation 记录完整 | ⚠️ 需改进 | 加入 tool 调用记录 |

---

## 下一步 TODO

| 优先级 | 任务 | 描述 |
|--------|------|------|
| P0 | 去掉 Supervisor | 删除监督者相关代码 |
| P0 | 去掉控制句 | 修改 inject-delivery.js |
| P1 | 改进 Her prompt | 强调亲切称呼、快慢思考分工 |
| P1 | conversation 完整化 | 记录 tool 调用和结果 |
| P2 | 改进 OpenClaw prompt | 增加上下文审视要求 |
