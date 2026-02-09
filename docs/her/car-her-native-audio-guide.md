# Car Her 车端原生音频 App — 厂商对接指南 v2

> 本文档是 `car-her-vendor-guide.md`（WebView 方案 v1）的升级版。v1 方案依赖 WebView 内的 `getUserMedia` 采集音频，在车载 Android 系统上存在麦克风枚举受限、无法使用厂商降噪算法等问题。v2 方案改为 **原生 App 直接管理音频 I/O**，通过标准 WebSocket 协议与云端 AI 对接。

---

## 一、架构总览

```
┌──────────────────── 车端 Android App ────────────────────┐
│                                                           │
│  ┌─────────────┐     ┌──────────────┐                    │
│  │ AudioRecord  │ ──▶ │ 讯飞降噪 SDK │                    │
│  │ (车载麦克风) │     │ (本地处理)    │                    │
│  └─────────────┘     └──────┬───────┘                    │
│                             │ 纯净 PCM 16kHz 16bit       │
│                             ▼                             │
│  ┌────────────────────────────────────────────┐          │
│  │         CarHer Audio Client (核心模块)      │          │
│  │                                            │          │
│  │  WS 连接 1: Gemini Proxy                   │          │
│  │    ├─ 发送: realtime_input (音频上行)       │          │
│  │    ├─ 接收: audio response (音频下行)       │          │
│  │    ├─ 接收: text/transcript (文本)          │          │
│  │    └─ 收发: tool_call / tool_response       │          │
│  │                                            │          │
│  │  WS 连接 2: OpenClaw Realtime              │          │
│  │    ├─ 发送: help 请求                       │          │
│  │    ├─ 接收: help_result 结果                │          │
│  │    ├─ 接收: inject 主动推送                 │          │
│  │    └─ 发送: transcript 记录                 │          │
│  └────────────────────────────────────────────┘          │
│                             │                             │
│                             ▼ PCM 音频解码                │
│  ┌──────────────┐                                        │
│  │ AudioTrack    │ ◀── 播放 AI 语音回复                  │
│  │ (车载扬声器)  │                                        │
│  └──────────────┘                                        │
│                                                           │
│  ┌──────────────┐                                        │
│  │ CarControl    │ ◀── 本地执行车控指令                   │
│  │ (车控 SDK)    │                                        │
│  └──────────────┘                                        │
│                                                           │
│  ┌──────────────┐                                        │
│  │ [可选] WebView│ ◀── UI 展示（文本/状态/调试）          │
│  └──────────────┘                                        │
└───────────────────────────────────────────────────────────┘
         │ WSS              │ WSS
         ▼                  ▼
   ┌──────────┐     ┌───────────────┐
   │ WS Proxy │     │ OpenClaw      │
   │ (Gemini) │     │ Realtime WS   │
   └────┬─────┘     └───────────────┘
        │ WSS (认证)
        ▼
   ┌──────────┐
   │ Gemini   │
   │ Live API │
   └──────────┘
```

### 与 v1（WebView 方案）的对比

| 维度 | v1 WebView 方案 | v2 原生音频方案 |
|------|----------------|----------------|
| 麦克风采集 | WebView `getUserMedia` | Android `AudioRecord` 原生 API |
| 降噪 | 浏览器内置（有限） | 讯飞 SDK 本地降噪 |
| 麦克风选择 | `enumerateDevices`（受限） | 原生 API 直接指定设备 |
| 扬声器选择 | `setSinkId`（不可靠） | `AudioTrack` 原生 API |
| 音频质量 | 受 WebView 限制 | 完全可控 |
| 协议对接 | 前端 JS 封装好 | 厂商需实现 WebSocket 客户端 |
| UI 界面 | WebView 渲染 | 原生 UI 或 WebView 仅做展示 |

---

## 二、音频管道规格

### 2.1 上行（麦克风 → 云端）

| 参数 | 值 | 说明 |
|------|----|------|
| 采样率 | **16000 Hz** | Gemini Live 强制要求 |
| 位深 | **16 bit** | signed int16, little-endian |
| 声道 | **单声道 (mono)** | — |
| 编码 | **PCM → Base64** | 原始 PCM 字节转 Base64 字符串 |
| 发送频率 | 每 **20-50ms** 一帧 | 建议 20ms（320 samples = 640 bytes） |

```
AudioRecord(16kHz, MONO, PCM_16BIT)
    │
    ▼ raw PCM bytes (640B per 20ms frame)
    │
讯飞降噪 SDK.process(pcmBytes)
    │
    ▼ 降噪后 PCM bytes
    │
Base64.encode(cleanPcmBytes)
    │
    ▼ base64 string
    │
封装为 Gemini realtime_input JSON → 发送到 WS 连接 1
```

### 2.2 下行（云端 → 扬声器）

Gemini 返回的音频在 JSON 消息中：

```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [{
        "inlineData": {
          "mimeType": "audio/pcm;rate=24000",
          "data": "<base64 编码的 PCM 音频>"
        }
      }]
    }
  }
}
```

| 参数 | 值 |
|------|----|
| 采样率 | **24000 Hz** |
| 位深 | **16 bit** signed int16, little-endian |
| 声道 | **单声道 (mono)** |
| 编码 | Base64 → PCM bytes |

```
WS 收到 JSON → 提取 inlineData.data
    │
    ▼ Base64.decode → raw PCM bytes (24kHz)
    │
AudioTrack(24000, MONO, PCM_16BIT).write(pcmBytes)
    │
    ▼ 车载扬声器播放
```

---

## 三、WebSocket 连接 1 — Gemini Proxy

### 3.1 连接地址

```
wss://<我方提供的 proxy 地址>
```

> 联调期间使用 Cloudflare 随机隧道地址，正式上线后会提供固定域名。

### 3.2 握手流程

连接成功后，App 需要按顺序发送两条 JSON 消息：

**第一条：Service Setup（认证信息）**

```json
{
  "service_url": "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
}
```

> `service_url` 固定不变。不需要传 `bearer_token`，服务端会自动生成。

**第二条：Session Setup（会话配置）**

```json
{
  "setup": {
    "model": "projects/<project_id>/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio",
    "generation_config": {
      "response_modalities": ["AUDIO"],
      "temperature": 1,
      "speech_config": {
        "voice_config": {
          "prebuilt_voice_config": {
            "voice_name": "Puck"
          }
        }
      },
      "enable_affective_dialog": true
    },
    "system_instruction": {
      "parts": [{ "text": "<system prompt，由 bootstrap 接口获取>" }]
    },
    "tools": {
      "function_declarations": [
        // openclaw_help + car_control 工具定义（见第五章）
      ]
    },
    "realtime_input_config": {
      "automatic_activity_detection": {
        "disabled": false,
        "silence_duration_ms": 500,
        "prefix_padding_ms": 500
      }
    },
    "input_audio_transcription": {},
    "output_audio_transcription": {}
  }
}
```

> `model`、`project_id` 和完整的 `system_instruction` 通过 **Bootstrap 接口** 获取（见 3.5 节）。

**服务端回复：Setup Complete**

```json
{ "setupComplete": {} }
```

收到此消息后，即可开始发送音频。

### 3.3 发送音频（上行）

每帧音频封装为：

```json
{
  "realtime_input": {
    "media_chunks": [{
      "mime_type": "audio/pcm",
      "data": "<base64 编码的 16kHz PCM 音频帧>"
    }]
  }
}
```

- 持续发送，即使用户没有说话（VAD 由 Gemini 服务端处理）
- 建议每 20ms 一帧（640 bytes PCM → ~856 bytes base64）
- 使用 WebSocket text frame 发送（不是 binary frame）

### 3.4 接收消息（下行）

Gemini 返回多种消息类型，App 需要处理以下几种：

| 消息类型 | 识别方式 | 处理 |
|---------|---------|------|
| **音频回复** | `serverContent.modelTurn.parts[].inlineData` | Base64 解码后播放 |
| **文本回复** | `serverContent.modelTurn.parts[].text` | 展示在 UI（如有） |
| **Turn Complete** | `serverContent.turnComplete: true` | 一轮回复结束 |
| **Interrupted** | `serverContent.interrupted: true` | 用户打断了 AI |
| **输入转写** | `serverContent.inputTranscription.text` | 用户语音的文字版 |
| **输出转写** | `serverContent.outputTranscription.text` | AI 回复的文字版 |
| **工具调用** | `serverContent.modelTurn.parts[].functionCall` | 见第五章 |

**音频回复示例：**

```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [{
        "inlineData": {
          "mimeType": "audio/pcm;rate=24000",
          "data": "base64encodedPCMaudio..."
        }
      }]
    }
  }
}
```

**输入转写（用户说了什么）：**

```json
{
  "serverContent": {
    "inputTranscription": {
      "text": "帮我把空调调到25度",
      "finished": true
    }
  }
}
```

### 3.5 Bootstrap 接口（获取配置）

在建立 WS 连接 1 之前，先调用 HTTP 接口获取会话配置：

```
GET https://<openclaw-realtime-host>/api/realtime/bootstrap
```

返回 JSON：

```json
{
  "liveMemoryCapsule": "用户画像摘要文本...",
  "model": "projects/.../models/gemini-live-2.5-flash-native-audio",
  "projectId": "gen-lang-client-0519229117"
}
```

- `liveMemoryCapsule`：注入到 `system_instruction` 中的用户画像
- `model`：完整的 Gemini model URI
- `projectId`：Google Cloud project ID

---

## 四、WebSocket 连接 2 — OpenClaw Realtime

### 4.1 连接地址

```
wss://<我方提供的 openclaw 地址>/ws
```

### 4.2 消息协议

**连接成功后，服务端发送：**

```json
{ "type": "connected", "sessionId": "abc123" }
```

**App → 服务端：**

| 消息类型 | 格式 | 用途 |
|---------|------|------|
| `help` | `{"type": "help", "request": "今天的天气", "callId": "call_xxx"}` | 转发 Gemini 的 openclaw_help 工具调用 |
| `transcript` | `{"type": "transcript", "role": "user", "text": "你好"}` | 上报用户/AI 对话文本 |
| `turn_complete` | `{"type": "turn_complete"}` | 通知一轮对话结束 |

**服务端 → App：**

| 消息类型 | 格式 | 处理 |
|---------|------|------|
| `help_result` | `{"type": "help_result", "callId": "call_xxx", "reply": "北京气温4.5°C..."}` | 将 reply 注入 Gemini 对话（见第五章） |
| `inject` | `{"type": "inject", "reply": "提醒：你有一个会议..."}` | 服务端主动推送，需注入 Gemini |
| `prompt_update` | `{"type": "prompt_update", "section": "memory", "content": "..."}` | 系统 prompt 热更新 |

---

## 五、工具调用处理

Gemini 会发送两种工具调用：`openclaw_help`（云端）和 `car_control`（本地）。

### 5.1 openclaw_help（云端 — 经过 OpenClaw）

**流程：**

```
Gemini → functionCall(openclaw_help, {request: "今天天气"})
    │
    ▼ App 收到
    │
    ├─ 1. 向 Gemini 发送 tool_response（立即 ACK）
    │     {"tool_response": {"functionResponses": [{
    │       "id": "<functionCallId>",
    │       "name": "openclaw_help",
    │       "response": {"result": "正在处理，请稍等"}
    │     }]}}
    │
    └─ 2. 向 OpenClaw WS 发送 help 请求
          {"type": "help", "request": "今天天气", "callId": "<functionCallId>"}
              │
              ▼ OpenClaw 处理（可能需要数秒）
              │
         收到 help_result:
         {"type": "help_result", "callId": "<id>", "reply": "北京气温4.5°C..."}
              │
              ▼ 注入 Gemini 对话历史
              向 Gemini 发送 client_content:
              {"client_content": {
                "turns": [{"role": "model", "parts": [{"text": "北京气温4.5°C..."}]}],
                "turn_complete": false
              }}
              │
              ▼ 再发送控制信号
              {"client_content": {
                "turns": [{"role": "model", "parts": [{"text": "以上信息来自 backend ai，请你根据实际情况回复用户信息！"}]}],
                "turn_complete": true
              }}
```

> **关键**：`openclaw_help` 是异步工具。先立即返回 ACK，后续通过 `client_content` 注入结果。这样 Gemini 可以在等待期间先对用户说"好，我查一下"。

### 5.2 car_control（本地执行）

**流程：**

```
Gemini → functionCall(car_control, {action: "set_ac_temperature", params: {temperature: 25}})
    │
    ▼ App 收到
    │
    ├─ 调用厂商车控 SDK（本地执行，毫秒级）
    │
    ▼ 得到结果
    │
    └─ 向 Gemini 发送 tool_response（同步返回）
       {"tool_response": {"functionResponses": [{
         "id": "<functionCallId>",
         "name": "car_control",
         "response": {"ok": true, "message": "空调已设置为25度"}
       }]}}
```

### 5.3 inject 处理（服务端主动推送）

当 OpenClaw 有主动消息（如定时提醒）时，WS 连接 2 会收到 `inject` 消息：

```json
{"type": "inject", "reply": "提醒：你今天下午3点有一个会议"}
```

处理方式与 help_result 注入相同：

```
收到 inject
    │
    ▼ 注入 Gemini 对话（client_content, role="model"）
    ▼ 发送控制信号（turn_complete: true）
    ▼ Gemini 会语音播报注入的内容
```

### 5.4 工具定义（放入 setup 消息的 tools 字段）

```json
{
  "function_declarations": [
    {
      "name": "openclaw_help",
      "description": "当需要执行复杂任务时调用此工具，如：搜索信息、查询天气、执行计算、访问用户记忆等。",
      "parameters": {
        "type": "object",
        "required": ["request"],
        "properties": {
          "request": {
            "type": "string",
            "description": "需要后台处理的请求描述"
          }
        }
      }
    },
    {
      "name": "car_control",
      "description": "控制车辆功能。用户说'开空调'、'调到25度'、'打开座椅加热'等车控指令时调用。",
      "parameters": {
        "type": "object",
        "required": ["action"],
        "properties": {
          "action": {
            "type": "string",
            "description": "操作类型: set_ac_temperature | set_ac_power | set_ac_mode | set_seat_heat | set_window"
          },
          "params": {
            "type": "object",
            "description": "操作参数，如 {temperature: 25}"
          }
        }
      }
    }
  ]
}
```

---

## 六、完整时序图

### 6.1 启动流程

```
App 启动
    │
    ├─ 1. HTTP GET /api/realtime/bootstrap
    │     → 获取 liveMemoryCapsule, model, projectId
    │
    ├─ 2. 连接 WS 2 (OpenClaw Realtime)
    │     → 收到 {"type": "connected", "sessionId": "..."}
    │
    ├─ 3. 连接 WS 1 (Gemini Proxy)
    │     → 发送 service_url
    │     → 发送 setup (含 system_instruction + tools)
    │     → 收到 setupComplete
    │
    ├─ 4. 启动 AudioRecord + 讯飞降噪
    │     → 开始发送音频帧
    │
    └─ 5. 启动 AudioTrack
          → 准备接收和播放音频
```

### 6.2 一次完整对话

```
用户说: "帮我查一下今天北京天气"

    [上行] App 持续发送音频帧 → WS1 → Gemini
    [下行] Gemini 转写: inputTranscription "帮我查一下今天北京天气"
    [下行] Gemini 音频回复: "好的，我帮你查一下" (播放)
    [下行] Gemini 工具调用: functionCall("openclaw_help", {request: "今天北京天气"})

    App 处理:
        → WS1: tool_response (ACK)
        → WS2: {"type": "help", "request": "今天北京天气", "callId": "xxx"}

    等待...

    [WS2 下行] help_result: "北京现在气温4.5°C，多云..."

    App 注入:
        → WS1: client_content(role="model", text="北京现在气温4.5°C，多云...")
        → WS1: client_content(role="model", text="以上信息来自 backend ai...")

    [下行] Gemini 音频回复: "北京现在气温大约4度半，天气多云" (播放)
    [下行] turnComplete
```

---

## 七、讯飞降噪集成要点

### 7.1 集成位置

```
AudioRecord.read(buffer)
    │
    ▼ 原始 PCM (16kHz, 16bit, mono)
    │
IFlySpeechDenoiser.process(buffer)
    │
    ▼ 降噪后 PCM (同格式)
    │
Base64.encode → 发送
```

### 7.2 注意事项

- 讯飞降噪 SDK 输入输出必须保持 **16kHz, 16bit, mono**（与 Gemini 要求一致）
- 降噪处理必须在**实时线程**完成，延迟控制在 5ms 以内
- 如果讯飞 SDK 需要不同采样率，App 负责重采样
- 降噪后的音频不需要再开 `echoCancellation`/`noiseSuppression`（这些是 WebRTC 的浏览器特性）

### 7.3 回声消除（AEC）

如果车内扬声器和麦克风距离近，可能需要 AEC（Acoustic Echo Cancellation）。两种方案：

1. **讯飞 SDK 自带 AEC**：将 AudioTrack 的播放信号作为参考信号喂入讯飞 SDK
2. **Android 系统 AEC**：使用 `AudioEffect.EFFECT_TYPE_AEC`（需要硬件支持）

---

## 八、Android 实现参考

### 8.1 关键类结构

```
CarHerApp
├── AudioCaptureManager       // AudioRecord + 讯飞降噪
│   ├── start(deviceId?)
│   ├── stop()
│   └── onAudioFrame(pcmBytes) → callback
│
├── AudioPlaybackManager      // AudioTrack 播放
│   ├── play(pcmBytes)        // 24kHz PCM
│   ├── interrupt()           // 用户打断时清空缓冲
│   └── onPlaybackComplete()
│
├── GeminiProxyClient         // WS 连接 1
│   ├── connect(proxyUrl)
│   ├── sendSetup(config)
│   ├── sendAudioFrame(base64)
│   ├── sendToolResponse(callId, name, response)
│   ├── sendClientContent(role, text, turnComplete)
│   └── onMessage(handler)
│
├── OpenClawClient            // WS 连接 2
│   ├── connect(realtimeUrl)
│   ├── sendHelp(request, callId)
│   ├── sendTranscript(role, text)
│   └── onMessage(handler)
│
├── ToolHandler               // 工具调用分发
│   ├── handleFunctionCall(name, args, callId)
│   ├── handleOpenClawHelp(request, callId)
│   └── handleCarControl(action, params, callId)
│
└── CarControlSDK             // 厂商车控封装
    └── execute(action, params) → result
```

### 8.2 AudioRecord 配置

```kotlin
val audioRecord = AudioRecord(
    MediaRecorder.AudioSource.VOICE_COMMUNICATION,  // 启用系统 AEC
    16000,                                           // 16kHz
    AudioFormat.CHANNEL_IN_MONO,                     // 单声道
    AudioFormat.ENCODING_PCM_16BIT,                  // 16bit
    bufferSize                                       // AudioRecord.getMinBufferSize(...)
)
```

> 使用 `VOICE_COMMUNICATION` 而非 `MIC`，可以启用 Android 系统级 AEC。

### 8.3 AudioTrack 配置

```kotlin
val audioTrack = AudioTrack.Builder()
    .setAudioAttributes(AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build())
    .setAudioFormat(AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(24000)                        // Gemini 输出 24kHz
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build())
    .setBufferSizeInBytes(bufferSize)
    .setTransferMode(AudioTrack.MODE_STREAM)
    .build()
```

### 8.4 指定麦克风设备

```kotlin
// 枚举所有音频输入设备
val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
val devices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
    .filter { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC
           || it.type == AudioDeviceInfo.TYPE_USB_DEVICE
           || it.type == AudioDeviceInfo.TYPE_USB_HEADSET }

// 指定使用特定设备
audioRecord.setPreferredDevice(devices[targetIndex])
```

> 这就是 v1 WebView 方案无法做到的 — 原生 API 可以精确指定任意麦克风设备。

---

## 九、联调步骤

```
Step 1: 音频管道验证
  App 能录音 + 讯飞降噪 + 播放回声（本地闭环）

Step 2: WS 连接验证
  App 能连接 Gemini Proxy + OpenClaw Realtime
  → 发送 setup → 收到 setupComplete

Step 3: 语音对话验证
  发送音频 → Gemini 回复音频 → 播放
  → 基本语音对话正常

Step 4: 工具调用验证
  说"帮我查天气" → openclaw_help 调用 → 注入结果 → 播报
  说"打开空调" → car_control 调用 → 本地执行 → 确认

Step 5: 端到端演示
  完整流程：降噪录音 → 语音对话 → 工具调用 → 车控 → AI 播报
```

---

## 十、与 v1 方案的兼容

v2 原生音频方案和 v1 WebView 方案**可以共存**：

- 云端服务（WS Proxy + OpenClaw Realtime）是相同的
- 协议（WebSocket JSON 消息格式）完全一致
- v1 方案的 CarBridge 车控接口可以直接复用
- 开发阶段可以同时用 WebView 版（快速测试）和原生版（降噪验证）

**建议开发路径：**

1. 先用 v1 WebView 方案完成车控 SDK 对接（简单快速）
2. 在 v1 基础上增加原生音频管道（AudioRecord + 讯飞降噪）
3. 将 WebView 的 `getUserMedia` 音频源替换为原生音频源
4. 最终可以完全去掉 WebView，改为原生 UI

---

## 附录 A：消息格式速查

### 发送到 Gemini Proxy (WS1)

```
# 认证
{"service_url": "wss://...googleapis.com/..."}

# 会话配置
{"setup": { ... }}

# 音频帧
{"realtime_input": {"media_chunks": [{"mime_type": "audio/pcm", "data": "<base64>"}]}}

# 文本消息注入
{"client_content": {"turns": [{"role": "model", "parts": [{"text": "..."}]}], "turn_complete": true}}

# 工具响应
{"tool_response": {"functionResponses": [{"id": "<callId>", "name": "<tool>", "response": {...}}]}}
```

### 发送到 OpenClaw (WS2)

```
# 请求帮助
{"type": "help", "request": "今天天气", "callId": "xxx"}

# 上报对话文本
{"type": "transcript", "role": "user", "text": "你好"}
{"type": "transcript", "role": "live", "text": "你好，有什么需要帮助的？"}

# 通知一轮结束
{"type": "turn_complete"}
```

---

## 附录 B：错误处理

| 场景 | 处理方式 |
|------|---------|
| WS1 断开 | 自动重连，重新发送 setup，恢复音频流 |
| WS2 断开 | 自动重连，不影响基本语音对话（只是 help 不可用） |
| Gemini setupComplete 超时 | 重试连接，最多 3 次 |
| help_result 超时（120s） | 向 Gemini 注入"抱歉，查询超时" |
| 讯飞 SDK 初始化失败 | 降级为原始 PCM（不降噪），继续工作 |
| AudioRecord 启动失败 | 显示错误提示，引导用户检查麦克风权限 |

---

## 联系方式

技术对接过程中如有问题，请随时联系我方技术团队。
