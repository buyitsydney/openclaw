# 豆包端到端语音大模型集成方案：替换 Gemini Live 快脑

## 背景

Her 的实时语音架构采用"快慢双脑"设计：

- **快脑（Gemini Live）**：端到端语音对话，简单问题直接回答，复杂问题通过 `openclaw_help` tool call 转交后台
- **慢脑（OpenClaw/Claude Opus）**：深度处理，记忆检索、任务执行、工具调用

本文档设计使用**豆包端到端实时语音大模型（火山引擎）**替换 Gemini Live 作为快脑的集成方案。

### 设计约束

1. **OpenClaw 零改动** — 后台大脑不感知前端语音模型的切换
2. **不破坏现有功能** — Gemini Live 链路保持完整可用，有用户在使用中
3. **复用现有基础设施** — WebSocket 隧道、OpenClaw 连接管理、inject 投递机制

---

## 一、现有 Gemini Live 链路分析

### 完整数据流

```
用户说话（麦克风）
  ↓ 浏览器 Web Audio API 采集 PCM
  ↓ 通过 WebSocket 发送到 Gemini Proxy (server.py :8080)
  ↓ 转发到 Google Gemini Live API
  ↓
Gemini Live 模型处理
  ├── 简单问题 → 直接生成语音流 → 返回前端播放
  └── 复杂问题 → 输出 toolCall JSON
                    ↓
前端 JS (mobile-script.js) 收到 TOOL_CALL 事件
  │ 解析 functionCalls[].name / id / args
  │
  ├── name === "openclaw_help"
  │     ├── 立即回 sendToolResponse（ACK："请求 #N 已收到"）
  │     └── 通过 openclawConnection.sendHelp(request, callId) → WebSocket(:18790)
  │           ↓
  │     OpenClaw Realtime Server (server.ts)
  │           ↓ handleHelpRequest() → runEmbeddedPiAgent() / callGateway()
  │           ↓ Claude Opus 执行任务（查天气、设提醒、查记忆...）
  │           ↓ 返回 help_result via WebSocket
  │           ↓
  │     前端收到 onHelpResult → push 到 pendingInjects
  │           ↓ tryDeliverInjects() → inject-delivery.js
  │           ↓ client_content { role: model + role: user "请播报" }
  │           ↓
  │     Gemini 收到注入内容 → 生成语音播报 → 用户听到结果
  │
  └── 其他 tool（如 car_control）
        └── 本地执行 → sendToolResponse 直接回传

```

### 关键组件

| 组件          | 文件                 | 职责                                           |
| ------------- | -------------------- | ---------------------------------------------- |
| Gemini 代理   | `server.py`          | WebSocket 代理，转发音频流到 Google API        |
| 前端主逻辑    | `mobile-script.js`   | tool call 分发、inject 队列、音频播放          |
| Gemini 客户端 | `geminilive.js`      | Gemini Live API 协议封装、sendToolResponse     |
| Tool 定义     | `tools.js`           | `OpenClawHelpTool` 类、`OpenClawConnection` 类 |
| Inject 投递   | `inject-delivery.js` | 异步结果注入 Gemini、原子 client_content       |
| OpenClaw 后端 | `server.ts`          | WebSocket server、help request 处理            |

### Gemini 侧 Tool Call 协议

```javascript
// 1. Gemini 输出 tool call
{ type: "TOOL_CALL", data: { functionCalls: [
  { name: "openclaw_help", id: "call_xxx", args: { request: "查天气" } }
]}}

// 2. 前端立即 ACK（解除 Gemini 阻塞）
client.sendToolResponse(id, "openclaw_help", {
  result: "请求 #1 已收到，后台正在处理..."
});

// 3. 异步结果通过 client_content 注入
client.sendMessage({
  client_content: {
    turns: [
      { role: "model", parts: [{ text: "查询结果..." }] },
      { role: "user", parts: [{ text: "请播报" }] }
    ],
    turn_complete: true
  }
});
```

---

## 二、豆包集成架构设计

### 核心思路

豆包和 Gemini Live 在 Her 架构中扮演**完全相同的角色**：ASR + LLM（快脑）+ TTS + Tool Call。

**Tool Call 本质上就是模型输出一个 JSON，前端 App 转发给 OpenClaw。** 与语音模型无关。

因此集成策略是：**在前端层新增一个豆包引擎，与 Gemini 引擎平行存在，通过配置切换，共享 OpenClaw 连接层。**

### 架构图

```
                            用户
                              │
                         语音输入（麦克风）
                              │
                    ┌─────────┴─────────┐
                    │                   │
              [Gemini 模式]       [豆包模式]
                    │                   │
            ┌───────┴───────┐    ┌──────┴──────┐
            │ server.py     │    │ 火山引擎    │
            │ :8080 WS 代理 │    │ RTC SDK     │
            │ → Google API  │    │ → 火山 RTC  │
            └───────┬───────┘    └──────┬──────┘
                    │                   │
                    │   统一的 Tool Call 处理层
                    │          │
                    └────┬─────┘
                         │
                    ┌────┴────┐
                    │ 前端 JS │
                    │ 统一的  │
                    │ tool    │
                    │ dispatch│
                    └────┬────┘
                         │
              ┌──────────┴──────────┐
              │                     │
        openclaw_help          本地 tool
              │               (car_control)
              ↓
        OpenClaw WS (:18790)      ← 完全不变
              │
        server.ts → Agent
              │
        Claude Opus 处理
              │
        结果返回
              │
              ↓
        ┌─────┴─────┐
        │            │
   [Gemini 模式] [豆包模式]
   inject via    UpdateVoiceChat
   client_content  回传结果
        │            │
        └─────┬──────┘
              │
         语音播报
              │
            用户
```

### 模式切换

通过 URL 参数或 UI 选择器切换，**同一时间只有一个引擎激活**：

```
mobile.html?engine=gemini   → 现有链路（默认，不改动）
mobile.html?engine=doubao   → 豆包链路（新增）
```

---

## 三、豆包侧 Tool Call 完整流程

基于火山引擎官方文档 [函数调用 Function Calling](https://www.volcengine.com/docs/6348/1554654)。

### 3.1 接入方式选择

火山引擎提供两种 Function Calling 实现方式：

| 方式           | 通信                                               | 适用场景           |
| -------------- | -------------------------------------------------- | ------------------ |
| **服务端实现** | 火山通过 HTTP POST 回调你的公网 URL                | 函数部署在服务器上 |
| **客户端实现** | 通过 RTC SDK 的 `onRoomBinaryMessageReceived` 回调 | 函数在客户端本地   |

**Her 选择：客户端实现。** 原因：

1. `openclaw_help` 需要转发到 OpenClaw WebSocket，是客户端行为
2. 车控 tool（`car_control`）在客户端本地执行
3. 不需要额外搭建公网回调服务器
4. 与 Gemini 现有的前端 tool call 处理模式一致

### 3.2 工具声明

在 `StartVoiceChat` 时通过 `LLMConfig.Tools` 声明：

```json
{
  "LLMConfig": {
    "Mode": "ArkV3",
    "ModelName": "doubao-seed-1.6",
    "Tools": [
      {
        "type": "function",
        "function": {
          "name": "openclaw_help",
          "description": "当需要执行复杂任务时调用此工具，如：搜索信息、查询天气、执行计算、访问用户记忆等。OpenClaw 后台会处理这些请求并返回结果。",
          "parameters": {
            "type": "object",
            "properties": {
              "request": {
                "type": "string",
                "description": "需要后台处理的请求描述，用自然语言说明你需要什么帮助"
              }
            },
            "required": ["request"]
          }
        }
      }
    ]
  }
}
```

> 注意：工具定义格式与 Gemini 的 `function_declarations` 本质相同，都是 OpenAI 兼容的 JSON Schema。

### 3.3 Tool Call 数据流

```
用户说话
  ↓ RTC SDK 采集音频 → 火山 RTC 服务
  ↓ 豆包 ASR 识别 → LLM (doubao-seed-1.6) 理解意图
  ↓
LLM 决策：需要调用 openclaw_help
  ↓
火山系统通过 RTC 数据通道下发两条消息：

  1. 函数调用通知（magic: "info"）
     → { event_type: "function_calling", function: "openclaw_help", tool_call_id: "call_xxx" }
     → 前端收到后可播放安抚语（"好的，我查一下"）

  2. 函数调用指令（magic: "tool"）
     → { tool_calls: [{ id: "call_xxx", function: { name: "openclaw_help", arguments: "{\"request\":\"查天气\"}" } }] }
     → 前端解析 → 转发到 OpenClaw WebSocket

OpenClaw 处理完毕 → 返回 help_result
  ↓
前端通过 sendUserBinaryMessage 回传结果：

  方式一（经 LLM 润色后播报）：
    Command: "function"
    Message: { ToolCallID: "call_xxx", Content: "今天上海晴天，25度" }
    → LLM 润色 → TTS 播报

  方式二（直接 TTS 播报）：
    Command: "ExternalTextToSpeech"
    Message: "今天上海晴天，25度"
    InterruptMode: 2
    → 直接 TTS 播报（更快，适合 OpenClaw 已经润色过的结果）
```

### 3.4 与 Gemini 流程对比

| 环节              | Gemini Live                            | 豆包 S2S                                     |
| ----------------- | -------------------------------------- | -------------------------------------------- |
| 音频采集          | Web Audio API → WebSocket              | RTC SDK → 火山 RTC                           |
| 语音识别          | Gemini 内部                            | 豆包 ASR（火山引擎）                         |
| 意图理解          | Gemini 模型                            | doubao-seed-1.6 LLM                          |
| Tool 定义         | `function_declarations` (sessionSetup) | `LLMConfig.Tools` (StartVoiceChat)           |
| Tool Call 输出    | `TOOL_CALL` 事件 (WebSocket JSON)      | `onRoomBinaryMessageReceived` (二进制 TLV)   |
| Tool Call 格式    | `{ name, id, args }`                   | `{ name, id, arguments }` (JSON string)      |
| ACK 机制          | `sendToolResponse` (processing)        | `sendUserBinaryMessage` (安抚语 TTS)         |
| 结果回传          | `client_content` inject                | `UpdateVoiceChat` / `sendUserBinaryMessage`  |
| 语音合成          | Gemini 内部                            | 豆包 TTS（精品/复刻音色）                    |
| **OpenClaw 对接** | **openclawConnection.sendHelp()**      | **openclawConnection.sendHelp()** ← 完全相同 |

**关键洞察**：OpenClaw 对接层（`OpenClawConnection` 类、`sendHelp()`、`onHelpResult` 回调）**完全复用**，不需要任何修改。变化的只是：

- 上游：从 Gemini WebSocket 事件 → 火山 RTC 二进制消息
- 下游：从 Gemini client_content inject → 火山 UpdateVoiceChat / sendUserBinaryMessage

---

## 四、实现方案

### 4.1 新增文件

```
extensions/realtime/live-frontend/frontend/
  ├── doubao-engine.js          ← 新增：豆包 RTC 引擎封装
  ├── doubao-config.js          ← 新增：豆包配置（AppId、Token、音色等）
  └── ... 现有文件全部不改动
```

### 4.2 doubao-engine.js 核心设计

```javascript
/**
 * DoubaoEngine — 封装火山引擎 RTC SDK 的语音对话引擎
 * 与 GeminiLive (geminilive.js) 平行存在，实现相同的上层接口
 */
class DoubaoEngine {
  constructor(config) {
    this.rtcEngine = null;
    this.rtcRoom = null;
    this.config = config; // AppId, Token, RoomId, BotUserId, etc.
    this.onToolCall = null; // 回调：收到 tool call
    this.onAudio = null; // 回调：收到语音流
    this.onTranscript = null; // 回调：收到字幕/转录
    this.onTurnComplete = null; // 回调：AI 说完一轮
  }

  async connect() {
    // 1. 创建 RTC Engine
    this.rtcEngine = VERTC.createEngine(this.config.appId);

    // 2. 加入 RTC 房间
    await this.rtcEngine.joinRoom(this.config.roomToken, {
      roomId: this.config.roomId,
      userId: this.config.userId,
    });

    // 3. 调用 StartVoiceChat API（服务端）启动 AI 对话
    await this.startVoiceChat();

    // 4. 监听 RTC 二进制消息（tool call 通道）
    this.rtcEngine.on("onRoomBinaryMessageReceived", (event) => {
      this.handleBinaryMessage(event.userId, event.message);
    });

    // 5. 监听音频流（AI 回复的语音）
    this.rtcEngine.on("onRemoteAudioFrame", (frame) => {
      if (this.onAudio) this.onAudio(frame);
    });
  }

  async startVoiceChat() {
    // 调用火山引擎服务端 API
    const response = await fetch("/api/doubao/start-voice-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        AppId: this.config.appId,
        RoomId: this.config.roomId,
        TaskId: this.config.taskId,
        Config: {
          ASRConfig: { Provider: "volcano" },
          LLMConfig: {
            Mode: "ArkV3",
            ModelName: "doubao-seed-1.6",
            SystemMessages: this.config.systemPrompt,
            Tools: this.config.tools, // openclaw_help 等
          },
          TTSConfig: {
            Provider: "volcano",
            voice_type: this.config.voiceType || "zh_female_vv_jupiter_bigtts",
          },
        },
      }),
    });
    return response.json();
  }

  handleBinaryMessage(userId, message) {
    if (message.byteLength < 8) return;

    const magic = new TextDecoder().decode(message.slice(0, 4));
    const dataView = new DataView(message);
    const length = dataView.getUint32(4, false); // big-endian
    const payload = new TextDecoder().decode(message.slice(8, 8 + length));

    if (magic === "info") {
      // 函数调用通知 — 可播放安抚语
      const info = JSON.parse(payload);
      console.log(`[Doubao] FC notification: ${info.function}, callId=${info.tool_call_id}`);
      // 播放安抚语
      this.sendComfortMessage("好的，我查一下");
    } else if (magic === "tool") {
      // 函数调用指令 — 解析并转发
      const data = JSON.parse(payload);
      for (const tc of data.tool_calls) {
        const args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;

        if (this.onToolCall) {
          this.onToolCall({
            name: tc.function.name,
            id: tc.id,
            args: args,
          });
        }
      }
    }
  }

  sendComfortMessage(text) {
    const msg = JSON.stringify({
      Command: "ExternalTextToSpeech",
      Message: text,
      InterruptMode: 3, // 低优先级，可被结果打断
    });
    const buffer = this.stringToTLV(msg, "ctrl");
    this.rtcRoom.sendUserBinaryMessage(this.config.botUserId, buffer);
  }

  sendToolResult(toolCallId, content, directTTS = true) {
    if (directTTS) {
      // 方式二：直接 TTS 播报（OpenClaw 结果已经是口语化的）
      const msg = JSON.stringify({
        Command: "ExternalTextToSpeech",
        Message: content,
        InterruptMode: 2, // 高优先级，立即播报
      });
      const buffer = this.stringToTLV(msg, "ctrl");
      this.rtcRoom.sendUserBinaryMessage(this.config.botUserId, buffer);
    } else {
      // 方式一：经 LLM 润色后播报
      const msg = JSON.stringify({
        Command: "function",
        Message: JSON.stringify({ ToolCallID: toolCallId, Content: content }),
      });
      // 通过 UpdateVoiceChat 服务端 API 回传
      fetch("/api/doubao/update-voice-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          AppId: this.config.appId,
          RoomId: this.config.roomId,
          TaskId: this.config.taskId,
          Command: "function",
          Message: JSON.stringify({ ToolCallID: toolCallId, Content: content }),
        }),
      });
    }
  }

  stringToTLV(inputString, type) {
    const typeBuffer = new Uint8Array(4);
    for (let i = 0; i < type.length; i++) {
      typeBuffer[i] = type.charCodeAt(i);
    }
    const valueBuffer = new TextEncoder().encode(inputString);
    const tlvBuffer = new Uint8Array(8 + valueBuffer.length);
    tlvBuffer.set(typeBuffer, 0);
    const len = valueBuffer.length;
    tlvBuffer[4] = (len >> 24) & 0xff;
    tlvBuffer[5] = (len >> 16) & 0xff;
    tlvBuffer[6] = (len >> 8) & 0xff;
    tlvBuffer[7] = len & 0xff;
    tlvBuffer.set(valueBuffer, 8);
    return tlvBuffer.buffer;
  }

  disconnect() {
    if (this.rtcRoom) this.rtcRoom.leaveRoom();
    if (this.rtcEngine) this.rtcEngine.destroy();
  }
}
```

### 4.3 mobile-script.js 改动（最小化）

在 `TOOL_CALL` 处理分支，抽取一个统一的 `handleToolCall(name, id, args)` 函数，Gemini 和豆包共用：

```javascript
// 新增：统一 tool call 处理器（从现有 TOOL_CALL case 中提取）
function handleToolCall(name, id, args, engine) {
  if (name === "openclaw_help") {
    const request = args?.request || "";
    const seq = ++state.helpCounter;
    state.helpRequests.set(id, { request, seq });

    // ACK — 引擎差异处理
    if (engine === "gemini") {
      state.client.sendToolResponse(id, "openclaw_help", {
        result: `请求 #${seq} 已收到，后台正在处理。...`,
      });
    }
    // 豆包的 ACK 通过安抚语实现，在 DoubaoEngine.handleBinaryMessage 中自动处理

    // 转发到 OpenClaw — 完全复用
    const tool = state.client?.functionsMap?.["openclaw_help"];
    if (tool) tool.functionToCall(args, id);
  } else {
    // 本地 tool
    const tool = state.client?.functionsMap?.[name];
    if (tool) {
      const result = tool.functionToCall(args, id);
      if (engine === "gemini") {
        state.client.sendToolResponse(id, name, result || { ok: true });
      } else {
        state.doubaoEngine.sendToolResult(id, JSON.stringify(result), true);
      }
    }
  }
}
```

### 4.4 结果回传差异

|                       | Gemini                              | 豆包                          |
| --------------------- | ----------------------------------- | ----------------------------- |
| **onHelpResult 回调** | 完全复用                            | 完全复用                      |
| **结果投递**          | inject-delivery.js → client_content | DoubaoEngine.sendToolResult() |

```javascript
// 豆包模式下的 onHelpResult 回调
openclawConnection.onHelpResult = (callId, reply) => {
  if (state.engine === "gemini") {
    // 现有逻辑：push to pendingInjects → tryDeliverInjects
    state.pendingInjects.push({ seq: entry.seq, reply });
    tryDeliverInjects();
  } else if (state.engine === "doubao") {
    // 豆包模式：直接通过 RTC 回传
    state.doubaoEngine.sendToolResult(callId, reply, true);
  }
};
```

### 4.5 需要新增的服务端代理

豆包 `StartVoiceChat` / `UpdateVoiceChat` 是火山引擎的服务端 API（需要 AK/SK 签名），不能从浏览器直接调用。需要在 `server.py` 或新建一个轻量代理中转发：

```python
# server.py 新增路由（或独立 doubao-proxy.py）
@app.route('/api/doubao/start-voice-chat', methods=['POST'])
def doubao_start_voice_chat():
    """代理 StartVoiceChat 请求到火山引擎"""
    body = request.json
    # 添加火山引擎签名
    response = volcengine_api_call('StartVoiceChat', body)
    return jsonify(response)

@app.route('/api/doubao/update-voice-chat', methods=['POST'])
def doubao_update_voice_chat():
    """代理 UpdateVoiceChat 请求到火山引擎"""
    body = request.json
    response = volcengine_api_call('UpdateVoiceChat', body)
    return jsonify(response)
```

---

## 五、延迟推演

### 5.1 Gemini Live 延迟拆解

```
[用户说话结束]
  → 音频通过 WebSocket 传到 Gemini Proxy (server.py)     ~5ms (localhost)
  → Gemini Proxy 转发到 Google API                       ~50-200ms (跨国/VPN)
  → Gemini 模型处理（ASR + LLM + TTS 一体化）            ~300-800ms
  → 语音流回传                                            ~50-200ms (跨国/VPN)
  → 前端播放
总延迟（简单回复）: ~400ms - 1.2s

[Tool Call 场景]
  → Gemini 识别意图 + 输出 tool call                     ~300-500ms
  → 前端 ACK + 发安抚语                                  ~10ms
  → OpenClaw 处理（Claude Opus 推理）                    ~2-30s
  → inject 回传 Gemini → 播报                            ~300-800ms
总延迟（Tool Call）: ~3-32s
```

### 5.2 豆包延迟拆解

```
[用户说话结束]
  → 音频通过 RTC SDK 传到火山 RTC                        ~20-50ms (国内直连)
  → 豆包模型处理（ASR + LLM + TTS）                      ~300-800ms
  → 语音流通过 RTC 回传                                   ~20-50ms (国内直连)
  → 前端播放
总延迟（简单回复）: ~340ms - 900ms

[Tool Call 场景]
  → 豆包 LLM 识别意图 + 输出 tool call                   ~300-500ms
  → 安抚语播放                                            ~10ms
  → OpenClaw 处理（Claude Opus 推理）                    ~2-30s（不变）
  → 结果回传 → TTS 播报                                  ~100-300ms
总延迟（Tool Call）: ~2.5-31s
```

### 5.3 延迟对比

| 场景                           | Gemini Live       | 豆包 S2S       | 差异                                 |
| ------------------------------ | ----------------- | -------------- | ------------------------------------ |
| **简单闲聊**                   | 400ms - 1.2s      | 340ms - 900ms  | **豆包更快**（国内直连 vs 跨国 VPN） |
| **Tool Call（OpenClaw 处理）** | 3 - 32s           | 2.5 - 31s      | **豆包略快**（省去跨国往返）         |
| **网络抖动**                   | 高（VPN + 跨国）  | 低（国内 RTC） | **豆包显著更稳**                     |
| **首次连接**                   | ~1-2s (WebSocket) | ~0.5-1s (RTC)  | 豆包更快                             |

**关键结论**：

- 简单对话豆包更快（省去 VPN/跨国延迟）
- Tool Call 场景瓶颈在 OpenClaw（Claude 推理 2-30s），语音模型差异可忽略
- 豆包用 RTC 协议比 WebSocket 更抗抖动（UDP vs TCP）
- **对于国内车载场景，豆包延迟优势是决定性的**（不依赖 VPN）

---

## 六、价格推演

### 6.1 Gemini Live 成本

| 计费项                 | 价格              | 备注                |
| ---------------------- | ----------------- | ------------------- |
| 音频输入               | $100 / 百万 token | ~$0.06/分钟         |
| 音频输出               | $200 / 百万 token | ~$0.24/分钟         |
| **综合**               | **~$0.30/分钟**   |                     |
| OpenClaw (Claude Opus) | 另计              | 仅 tool call 时触发 |

### 6.2 豆包成本

| 计费项                 | 价格                         | 备注                 |
| ---------------------- | ---------------------------- | -------------------- |
| 豆包 S2S token 输入    | ¥0.8 / 百万 token (~$0.11)   |                      |
| 豆包 S2S token 输出    | ¥2.0 / 百万 token (~$0.28)   |                      |
| RTC 通话费用           | 按时长计费（License 模式）   | 基础版 ¥约 0.01/分钟 |
| **综合**               | **~$0.01-0.05/分钟**（估算） |                      |
| OpenClaw (Claude Opus) | 另计（不变）                 | 仅 tool call 时触发  |
| 免费试用               | 100 万 token                 | 约 10+ 小时对话      |

### 6.3 成本对比

| 场景                    | Gemini Live | 豆包             | 节省        |
| ----------------------- | ----------- | ---------------- | ----------- |
| 每分钟对话              | ~$0.30      | ~$0.01-0.05      | **6-30 倍** |
| 每天 1 小时对话         | ~$18        | ~$0.6-3          |             |
| 200 台车 × 每天 30 分钟 | ~$1,800/天  | ~$60-300/天      |             |
| **年成本（200 车）**    | ~$657,000   | ~$22,000-110,000 | **6-30 倍** |

**关键结论**：豆包在规模化部署时的成本优势是 Gemini 的 6-30 倍。对 Autolink 200+ 台车的场景，年节省 $50-60 万。

---

## 七、OpenClaw 主链路集成分析

### 7.1 OpenClaw 零改动验证

逐一检查 OpenClaw 的每个触及点：

| 组件                              | 是否改动 | 原因                                                                |
| --------------------------------- | -------- | ------------------------------------------------------------------- |
| `server.ts`（Realtime WS Server） | ❌ 不改  | 收到的 help request 格式不变（`{ type: "help", request, callId }`） |
| `handleHelpRequest()`             | ❌ 不改  | 不感知上游是 Gemini 还是豆包                                        |
| `OpenClawConnection`（tools.js）  | ❌ 不改  | `sendHelp()` / `onHelpResult` 完全复用                              |
| `inject-delivery.js`              | ❌ 不改  | 仅 Gemini 模式使用，豆包模式不经过此路径                            |
| Gateway / Agent                   | ❌ 不改  | 不感知语音前端的存在                                                |
| MEMORY.md / USER.md               | ❌ 不改  | Agent 正常读写                                                      |
| cron / heartbeat                  | ❌ 不改  | 与语音前端无关                                                      |

**结论：OpenClaw 100% 零改动。** 豆包集成的所有改动都在前端层（`mobile-script.js` 的引擎分支 + 新增的 `doubao-engine.js`）。

### 7.2 关键接口不变性证明

```
OpenClaw Realtime WebSocket 协议（:18790）
  ↓
消息格式（tools.js 中定义）：

  上行：{ type: "help", request: "...", callId: "..." }      ← Gemini/豆包 均可产生
  上行：{ type: "transcript", role: "user", text: "..." }    ← Gemini/豆包 均可产生
  上行：{ type: "turn_complete" }                             ← Gemini/豆包 均可产生

  下行：{ type: "help_result", callId: "...", reply: "..." } ← 不变
  下行：{ type: "inject", reply: "..." }                     ← 仅 Gemini 模式消费
  下行：{ type: "prompt_update", section: "...", content: "..." } ← 不变
```

所有上行消息由 `OpenClawConnection.sendHelp()` / `sendTranscript()` / `sendTurnComplete()` 发出，这些方法 Gemini 和豆包**共用同一个实例**。

---

## 八、不破坏现有功能的保证

### 8.1 文件改动范围

| 文件                  | 改动                                  | 影响                                        |
| --------------------- | ------------------------------------- | ------------------------------------------- |
| `doubao-engine.js`    | **新增**                              | 不影响任何现有文件                          |
| `doubao-config.js`    | **新增**                              | 不影响任何现有文件                          |
| `mobile-script.js`    | 最小改动                              | 提取 `handleToolCall()`，增加 `engine` 分支 |
| `mobile.html`         | 增加引擎选择 UI + RTC SDK script 标签 | 默认 Gemini，不影响现有行为                 |
| `server.py`           | 增加 2 个 API 代理路由                | 新路由，不影响现有 `/ws` 路由               |
| `geminilive.js`       | ❌ 不改                               |                                             |
| `tools.js`            | ❌ 不改                               |                                             |
| `inject-delivery.js`  | ❌ 不改                               |                                             |
| `script.js`（桌面版） | ❌ 不改                               |                                             |
| `server.ts`           | ❌ 不改                               |                                             |
| `index.ts`            | ❌ 不改                               |                                             |
| OpenClaw 核心代码     | ❌ 不改                               |                                             |

### 8.2 回归测试清单

切换到豆包模式前后，以下场景必须验证 Gemini 模式不受影响：

- [ ] Gemini 简单闲聊正常
- [ ] Gemini tool call（openclaw_help）正常，结果播报正常
- [ ] Gemini 安抚语 + 异步结果 inject 正常
- [ ] Gemini RESPONSE_REJECTED 恢复正常
- [ ] 多用户 Docker 容器正常
- [ ] 远程隧道（Cloudflare）正常
- [ ] Bootstrap API 正常

---

## 九、分阶段实施计划

### Phase 0：准备（1 天）

- 注册火山引擎账号，开通 RTC + 豆包语音服务
- 获取 AppId、Token、AK/SK
- 领取 100 万 token 免费试用额度
- 本地跑通火山引擎 RTC Demo（官方 GitHub: `volcengine/rtc-aigc-demo`）

### Phase 1：最小 POC（2-3 天）

- 实现 `doubao-engine.js` 基础框架
- 实现 `server.py` 的 API 代理路由
- 跑通：用户说话 → 豆包回复（不含 tool call）
- 验证延迟和音质

### Phase 2：Tool Call 集成（2-3 天）

- 实现 Function Calling 的完整流程（info → tool → sendHelp → result → 播报）
- 验证 `openclaw_help` tool call 从豆包到 OpenClaw 的完整链路
- 验证安抚语机制
- 验证结果回传（直接 TTS vs LLM 润色两种模式）

### Phase 3：模式切换 + 回归测试（1-2 天）

- 实现 URL 参数 / UI 切换引擎
- 完整回归测试 Gemini 模式
- 完整测试豆包模式
- 远程隧道测试

### Phase 4：车载优化（持续）

- 车载噪音环境 ASR 准确率测试
- 声音复刻（品牌专属声音）
- 方言支持测试
- 混合编排模式评估（S2S 快路径 + LLM 慢路径）

---

## 十、风险与缓解

| 风险                                           | 影响                     | 缓解                                           |
| ---------------------------------------------- | ------------------------ | ---------------------------------------------- |
| 豆包 LLM（doubao-seed-1.6）快脑智能不如 Gemini | tool call 判断不准确     | 测试验证；如有问题可用 doubao-2.0-pro          |
| RTC SDK 浏览器兼容性                           | 手机浏览器可能不支持     | 火山 RTC SDK 支持主流浏览器；车载用 Native SDK |
| 火山引擎服务稳定性                             | 语音中断                 | 双引擎兜底：豆包挂了切 Gemini                  |
| 安抚语时机不对                                 | 结果已返回但安抚语还在播 | `InterruptMode: 3` 确保安抚语可被结果打断      |
| OpenClaw 处理时间过长（>30s）                  | 用户等待焦虑             | 两段式 ACK + 安抚语（与 Gemini 模式一致）      |

---

## 十一、豆包的独特优势（Gemini 不具备）

| 能力               | 说明                         | CarHer 场景                     |
| ------------------ | ---------------------------- | ------------------------------- |
| **声音复刻**       | SC2.0 版本支持自定义音色训练 | 品牌专属声音（"Autolink 小 A"） |
| **20+ 方言**       | 支持全国主流方言识别 + 生成  | 国内车主刚需                    |
| **声纹降噪**       | 只回复驾驶员，忽略乘客       | 车内多人场景                    |
| **情绪识别与生成** | 理解用户情绪 + 调整语气      | 驾驶疲劳检测、情绪安抚          |
| **联网搜索**       | 内置火山融合信息搜索         | 实时新闻/天气（无需 tool call） |
| **唱歌**           | O2.0 版本支持不同风格唱歌    | 娱乐场景                        |
| **国内合规**       | 数据不出境                   | 车规级必须                      |

---

## 附录 A：火山引擎关键文档

- [实时对话式 AI 概述](https://www.volcengine.com/docs/6348/1392584)
- [StartVoiceChat API](https://www.volcengine.com/docs/6348/1558163)
- [函数调用 Function Calling](https://www.volcengine.com/docs/6348/1554654)
- [端到端实时语音大模型](https://www.volcengine.com/docs/6348/1902994)
- [豆包语音产品简介](https://www.volcengine.com/docs/6561/1594360)
- [豆包语音计费概述](https://www.volcengine.com/docs/6561/1359369)
- [GitHub Demo](https://github.com/volcengine/rtc-aigc-demo)

## 附录 B：与现有架构文档的关系

- `realtime-voice-architecture.md` — Her 的快慢双脑设计原则（不变）
- `car-her-architecture.md` — 旁路→主干道集成、多用户隔离（不变）
- `car-her-native-audio-guide.md` — Bootstrap API / Gemini 原生集成（不变，Gemini 链路保留）
- **本文档** — 新增豆包快脑引擎，与 Gemini 引擎平行存在
