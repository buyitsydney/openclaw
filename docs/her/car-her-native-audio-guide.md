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
        │ WSS (认证由服务端处理)
        ▼
   ┌──────────┐
   │ Gemini   │
   │ Live API │
   └──────────┘
```

### 厂商需要做的事（完整清单）

| 序号 | 任务 | 复杂度 |
|------|------|--------|
| 1 | Android App 框架 + 权限配置 | 低 |
| 2 | AudioRecord 采集 + 讯飞降噪 | 中 |
| 3 | AudioTrack 播放 AI 回复 | 低 |
| 4 | WebSocket 客户端（2 条连接） | 中 |
| 5 | 工具调用分发（openclaw_help + car_control） | 中 |
| 6 | 车控 SDK 对接 | 厂商自有 |

### 厂商不需要关心的事

- AI 模型配置、system prompt、工具定义 — 全由 Bootstrap 接口返回，原样透传
- Google Cloud 认证 — 服务端自动处理
- OpenRouter API Key — 服务端自动处理
- 任何 API Key / Token — **厂商不需要任何密钥**

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

## 二、我方提供给厂商的信息

我方提供 **3 个 URL**，仅此而已。厂商不需要任何 API Key、Token 或密钥。

联调期间使用以下**固定 URL**（命名隧道，永不变化）：

```
  BOOTSTRAP_URL (App 启动时 HTTP GET 调用一次):
    https://vendor.carher.net/api/realtime/bootstrap

  PROXY_URL (WS 连接 1 — 音频双向流):
    wss://vendor-proxy.carher.net

  OPENCLAW_URL (WS 连接 2 — 后台 AI):
    wss://vendor.carher.net/ws
```

> 这些 URL 通过 Cloudflare 命名隧道映射到我方服务器，域名固定不变，重启服务后 URL 不会改变。

**3 个 URL 的用途：**

| 名称 | 协议 | 用途 | 说明 |
|------|------|------|------|
| BOOTSTRAP_URL | HTTP GET | App 启动时调用一次，获取 AI 配置 JSON | 返回的 JSON 包含发给 WS1 的两条 setup 消息 |
| PROXY_URL | WebSocket | WS 连接 1 — 音频上行/下行、AI 文本、工具调用 | 这是 Gemini Live 的代理入口 |
| OPENCLAW_URL | WebSocket | WS 连接 2 — 发送 help 请求、接收 help 结果和主动推送 | 这是后台 AI 的 WebSocket |

### 2.1 BOOTSTRAP_URL 返回值

**请求：**

```
GET <BOOTSTRAP_URL>
```

**返回 JSON 示例（厂商只需使用 `geminiProxy` 下的两个字段）：**

```json
{
  "liveMemoryCapsule": "（厂商忽略此字段）",
  "geminiProxy": {
    "serviceSetup": {
      "service_url": "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
    },
    "sessionSetup": {
      "setup": {
        "model": "projects/gen-lang-client-0519229117/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio",
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
          "parts": [{ "text": "（AI 系统提示词，厂商无需关心内容）" }]
        },
        "tools": {
          "function_declarations": [
            {
              "name": "openclaw_help",
              "description": "...",
              "parameters": { "..." : "..." }
            },
            {
              "name": "car_control",
              "description": "...",
              "parameters": { "..." : "..." }
            }
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
  }
}
```

**厂商使用方式：**

| 字段 | 怎么用 |
|------|--------|
| `geminiProxy.serviceSetup` | 原样 JSON 序列化，作为 WS 连接 1 的**第一条消息**发送 |
| `geminiProxy.sessionSetup` | 原样 JSON 序列化，作为 WS 连接 1 的**第二条消息**发送 |
| 其他字段 | 忽略 |

**Kotlin 参考代码（调用 BOOTSTRAP_URL）：**

```kotlin
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * 调用 Bootstrap 获取 AI 配置。
 * @param bootstrapUrl 我方提供的 BOOTSTRAP_URL，如 "https://vendor.carher.net/api/realtime/bootstrap"
 * @return 解析后的 JSON 对象
 */
fun fetchBootstrap(bootstrapUrl: String): JSONObject {
    val client = OkHttpClient()
    val request = Request.Builder().url(bootstrapUrl).get().build()
    val response = client.newCall(request).execute()
    if (!response.isSuccessful) {
        throw RuntimeException("Bootstrap failed: HTTP ${response.code}")
    }
    val body = response.body?.string() ?: throw RuntimeException("Bootstrap: empty body")
    return JSONObject(body)
}

// 使用示例:
// val config = fetchBootstrap("https://vendor.carher.net/api/realtime/bootstrap")
// val serviceSetup: JSONObject = config.getJSONObject("geminiProxy").getJSONObject("serviceSetup")
// val sessionSetup: JSONObject = config.getJSONObject("geminiProxy").getJSONObject("sessionSetup")
```

### 2.2 BOOTSTRAP_URL 调用时机

| 场景 | 是否需要重新调用 |
|------|----------------|
| App 首次启动 | 是 |
| 每次建立新的语音会话 | 是（配置可能动态变化） |
| WS 断开后重连 | 是 |
| 语音对话进行中 | 不需要 |

---

## 三、完整启动流程（按顺序执行）

以下是 App 从启动到开始语音对话的完整步骤。**严格按顺序执行，不可跳步。**

```
Step 1: HTTP GET  BOOTSTRAP_URL    → 拿到 config JSON
Step 2: WebSocket OPENCLAW_URL     → 等收到 {"type":"connected",...}
Step 3: WebSocket PROXY_URL        → 发 serviceSetup → 发 sessionSetup → 等收到 {"setupComplete":{}}（共 1 条回复）
Step 4: AudioRecord 开始采集       → 编码后通过 WS1 持续发送
Step 5: AudioTrack 准备播放        → 接收 WS1 下行音频并播放
```

### Step 1: 调用 BOOTSTRAP_URL

```kotlin
// 在后台线程执行（网络请求）
val config = fetchBootstrap(BOOTSTRAP_URL)  // 见上方 2.1 的代码

// 提取 WS1 需要的两条 setup 消息
val serviceSetup: JSONObject = config.getJSONObject("geminiProxy").getJSONObject("serviceSetup")
val sessionSetup: JSONObject = config.getJSONObject("geminiProxy").getJSONObject("sessionSetup")
```

### Step 2: 连接 OPENCLAW_URL（WS 连接 2）

```kotlin
import okhttp3.*

// OPENCLAW_URL 由我方提供，如 "wss://vendor.carher.net/ws"
val openclawWs: WebSocket = OkHttpClient().newWebSocket(
    Request.Builder().url(OPENCLAW_URL).build(),
    object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = JSONObject(text)
            when (msg.optString("type")) {
                "connected" -> {
                    // Step 2 完成：保存 sessionId
                    val sessionId = msg.optString("sessionId")
                    Log.i("WS2", "Connected, sessionId=$sessionId")
                    // 现在可以进入 Step 3
                }
                "help_result" -> {
                    // openclaw_help 的结果，注入给 WS1（见第六章）
                    val reply = msg.getString("reply")
                    val callId = msg.getString("callId")
                    injectToGemini(reply)
                }
                "inject" -> {
                    // 服务端主动推送（如定时提醒），注入给 WS1
                    val reply = msg.getString("reply")
                    injectToGemini(reply)
                }
            }
        }
    }
)
```

**等待条件：** 收到 `{"type":"connected","sessionId":"..."}` 后再进入 Step 3。

### Step 3: 连接 PROXY_URL（WS 连接 1）

```kotlin
// PROXY_URL 由我方提供，如 "wss://vendor-proxy.carher.net"
val proxyWs: WebSocket = OkHttpClient().newWebSocket(
    Request.Builder().url(PROXY_URL).build(),
    object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            // 连接成功后，按顺序发送 2 条消息（来自 Step 1 的 config）

            // 第一条：serviceSetup（原样发送，不修改）
            webSocket.send(serviceSetup.toString())

            // 第二条：sessionSetup（原样发送，不修改）
            webSocket.send(sessionSetup.toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val msg = JSONObject(text)

            // 发送完 2 条 setup 后，等这 1 条回复
            if (msg.has("setupComplete")) {
                Log.i("WS1", "AI session ready!")
                // Step 3 完成，可以开始发送音频（Step 4）
                startAudioCapture()
                return
            }

            // 后续消息处理（见第五章）
            handleWS1Message(msg)
        }
    }
)
```

**关键点：**
- 发送 serviceSetup 和 sessionSetup 后，只会收到 **1 条** `{"setupComplete":{}}` 回复
- 收到 setupComplete 表示 AI 会话就绪，可以开始发送音频

### Step 4: 启动音频采集并发送到 WS1

```kotlin
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64

fun startAudioCapture() {
    val sampleRate = 16000
    val bufferSize = AudioRecord.getMinBufferSize(
        sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
    )
    val recorder = AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,  // 启用系统 AEC
        sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize
    )
    recorder.startRecording()

    // 在独立线程持续读取并发送
    Thread {
        val frame = ByteArray(640)  // 20ms @ 16kHz = 320 samples = 640 bytes
        while (isRecording) {
            val read = recorder.read(frame, 0, frame.size)
            if (read <= 0) continue

            // [可选] 讯飞降噪: frame = iflySpeechDenoiser.process(frame)

            // Base64 编码
            val base64 = Base64.encodeToString(frame, 0, read, Base64.NO_WRAP)

            // 封装为 Gemini 要求的 JSON 格式，通过 WS1 发送
            val json = """{"realtime_input":{"media_chunks":[{"mime_type":"audio/pcm","data":"$base64"}]}}"""
            proxyWs.send(json)
        }
        recorder.stop()
        recorder.release()
    }.start()
}
```

**重要规则：**
- 使用 WebSocket **text frame** 发送（OkHttp 的 `send(String)` 就是 text frame）
- 持续发送，即使用户没有说话（静音检测由云端 AI 处理）
- 每帧独立发送，不要攒多帧合并

### Step 5: 接收 AI 音频并播放

```kotlin
import android.media.AudioTrack
import android.media.AudioAttributes
import android.media.AudioFormat

// 创建 AudioTrack（注意：下行是 24kHz，和上行的 16kHz 不同！）
val audioTrack = AudioTrack.Builder()
    .setAudioAttributes(AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build())
    .setAudioFormat(AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(24000)  // 下行 24kHz
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build())
    .setBufferSizeInBytes(AudioTrack.getMinBufferSize(
        24000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT))
    .setTransferMode(AudioTrack.MODE_STREAM)
    .build()
audioTrack.play()

// 在 WS1 的 onMessage 中处理音频（见第五章 handleWS1Message）
// 收到音频数据时:
fun playAudio(base64Audio: String) {
    val pcmBytes = Base64.decode(base64Audio, Base64.DEFAULT)
    audioTrack.write(pcmBytes, 0, pcmBytes.size)
}
```

**启动完成，用户可以开始语音对话。**

---

## 四、音频管道规格

### 4.1 上行（麦克风 → 云端）

| 参数 | 值 | 说明 |
|------|----|------|
| 采样率 | **16000 Hz** | 强制要求，不可修改 |
| 位深 | **16 bit** | signed int16, little-endian |
| 声道 | **单声道 (mono)** | — |
| 编码 | **PCM → Base64** | 原始 PCM 字节转 Base64 字符串 |
| 发送频率 | 每 **20ms** 一帧 | 320 samples = 640 bytes PCM |

**处理流水线：**

```
AudioRecord.read(buffer)     // 640 bytes (20ms @ 16kHz)
    │
    ▼
讯飞降噪SDK.process(buffer)   // 输入输出同格式
    │
    ▼
Base64.encode(buffer)         // 640B → ~856 字符
    │
    ▼ 封装为 JSON 并发送到 WS 连接 1:

{"realtime_input": {"media_chunks": [{"mime_type": "audio/pcm", "data": "<base64字符串>"}]}}
```

**重要：**
- 使用 WebSocket **text frame** 发送（不是 binary frame）
- 持续发送，即使用户没有说话（静音检测由云端 AI 处理）
- 不要攒多帧合并发送，每帧独立发送

### 4.2 下行（云端 → 扬声器）

AI 回复的音频在 WS 连接 1 的 JSON 消息中。**注意：下行采样率是 24kHz，和上行的 16kHz 不同。**

| 参数 | 值 |
|------|----|
| 采样率 | **24000 Hz** |
| 位深 | **16 bit** signed int16, little-endian |
| 声道 | **单声道 (mono)** |

**收到音频消息时：**

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

**处理方式：**

```
提取 serverContent.modelTurn.parts[0].inlineData.data
    │
    ▼
Base64.decode → raw PCM bytes
    │
    ▼
AudioTrack.write(pcmBytes)  // 24kHz, 16bit, mono
    │
    ▼
车载扬声器播放
```

---

## 五、WS 连接 1 下行消息处理

WS 连接 1 会收到多种 JSON 消息，App 需要根据字段判断类型并处理。

### 5.1 消息类型判断（伪代码）

```kotlin
fun onWS1Message(jsonStr: String) {
    val json = JSONObject(jsonStr)

    if (json.has("setupComplete")) {
        // AI 会话就绪
        onSetupComplete()
        return
    }

    val serverContent = json.optJSONObject("serverContent") ?: return
    val modelTurn = serverContent.optJSONObject("modelTurn")

    // 1. 用户打断
    if (serverContent.optBoolean("interrupted")) {
        audioPlayer.interrupt()  // 立即停止播放，清空缓冲
        return
    }

    // 2. 一轮回复结束
    if (serverContent.optBoolean("turnComplete")) {
        onTurnComplete()
        return
    }

    // 3. 用户语音转写
    val inputTx = serverContent.optJSONObject("inputTranscription")
    if (inputTx != null) {
        val text = inputTx.optString("text")
        val finished = inputTx.optBoolean("finished")
        onUserTranscription(text, finished)
        // 同时上报给 WS2:
        if (finished && text.isNotEmpty()) {
            ws2.send("""{"type":"transcript","role":"user","text":"$text"}""")
        }
        return
    }

    // 4. AI 语音转写
    val outputTx = serverContent.optJSONObject("outputTranscription")
    if (outputTx != null) {
        onAITranscription(outputTx.optString("text"))
        return
    }

    // 5. modelTurn 中的内容
    if (modelTurn != null) {
        val parts = modelTurn.optJSONArray("parts") ?: return
        for (i in 0 until parts.length()) {
            val part = parts.getJSONObject(i)

            // 5a. 音频回复 → 播放
            val inlineData = part.optJSONObject("inlineData")
            if (inlineData != null) {
                val base64Audio = inlineData.getString("data")
                val pcmBytes = Base64.decode(base64Audio, Base64.DEFAULT)
                audioPlayer.play(pcmBytes)  // 写入 AudioTrack
                continue
            }

            // 5b. 文本回复 → 展示（如有 UI）
            val text = part.optString("text")
            if (text.isNotEmpty()) {
                onAIText(text)
                // 同时上报给 WS2:
                ws2.send("""{"type":"transcript","role":"live","text":"$text"}""")
                continue
            }

            // 5c. 工具调用 → 分发处理（见第六章）
            val functionCall = part.optJSONObject("functionCall")
            if (functionCall != null) {
                handleToolCall(functionCall)
                continue
            }
        }
    }
}
```

### 5.2 各消息类型完整 JSON 示例

**音频回复：**
```json
{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"base64..."}}]}}}
```

**文本回复：**
```json
{"serverContent":{"modelTurn":{"parts":[{"text":"好的，我帮你查一下天气"}]}}}
```

**工具调用（functionCall）：**
```json
{"serverContent":{"modelTurn":{"parts":[{"functionCall":{"name":"car_control","id":"call_abc123","args":{"action":"set_ac_temperature","params":{"temperature":25}}}}]}}}
```

**用户语音转写：**
```json
{"serverContent":{"inputTranscription":{"text":"帮我把空调调到25度","finished":true}}}
```

**AI 语音转写：**
```json
{"serverContent":{"outputTranscription":{"text":"好的，空调已经调到25度了"}}}
```

**一轮结束：**
```json
{"serverContent":{"turnComplete":true}}
```

**用户打断：**
```json
{"serverContent":{"interrupted":true}}
```

---

## 六、工具调用处理

AI 会通过 WS 连接 1 发送工具调用。有两种工具：`openclaw_help`（转发到云端处理）和 `car_control`（本地执行）。

### 6.1 工具调用分发（伪代码）

```kotlin
fun handleToolCall(functionCall: JSONObject) {
    val name = functionCall.getString("name")
    val callId = functionCall.getString("id")
    val args = functionCall.optJSONObject("args") ?: JSONObject()

    when (name) {
        "openclaw_help" -> handleOpenClawHelp(args.optString("request"), callId)
        "car_control"   -> handleCarControl(args, callId)
        else            -> sendToolError(callId, name, "未知工具: $name")
    }
}
```

### 6.2 car_control — 本地执行

这是**同步**操作。收到后立即在本地执行，然后把结果返回给 AI。

**完整流程：**

```
收到: functionCall(name="car_control", id="call_123", args={action:"set_ac_temperature", params:{temperature:25}})

    1. 提取 action 和 params
    2. 调用厂商车控 SDK 执行（本地，毫秒级）
    3. 得到结果
    4. 通过 WS 连接 1 发送 tool_response:
```

**发送给 WS 连接 1 的 tool_response：**

```json
{
  "tool_response": {
    "functionResponses": [{
      "id": "call_123",
      "name": "car_control",
      "response": {
        "ok": true,
        "message": "空调已设置为25度"
      }
    }]
  }
}
```

AI 收到后会语音确认："好的，空调已经调到25度了"。

**car_control 的 action 列表：**

| action | args.params 示例 | 说明 |
|--------|-----------------|------|
| `set_ac_temperature` | `{"temperature": 25}` | 设置空调温度（16-32） |
| `set_ac_power` | `{"on": true}` | 开/关空调 |
| `set_ac_mode` | `{"mode": "cool"}` | cool / heat / auto |
| `set_seat_heat` | `{"seat": "driver", "level": 2}` | 座椅加热 0-3（0=关） |
| `set_window` | `{"position": "driver", "open": true}` | 车窗开/关 |
| `start_navigation` | `{"destination": "锦里老灶火锅", "address": "人民路123号"}` | 导航到目的地（address 可选） |

**厂商实现参考（Kotlin）：**

```kotlin
fun handleCarControl(args: JSONObject, callId: String) {
    val action = args.optString("action")
    val params = args.optJSONObject("params") ?: JSONObject()

    val result = when (action) {
        "set_ac_temperature" -> {
            val temp = params.optInt("temperature", 24)
            // TODO: 替换为厂商车控 SDK 调用
            """{"ok":true,"message":"空调已设置为${temp}度"}"""
        }
        "set_ac_power" -> {
            val on = params.optBoolean("on", true)
            """{"ok":true,"message":"空调已${if (on) "打开" else "关闭"}"}"""
        }
        "set_ac_mode" -> {
            val mode = params.optString("mode", "auto")
            """{"ok":true,"message":"空调模式已切换为${mode}"}"""
        }
        "set_seat_heat" -> {
            val seat = params.optString("seat", "driver")
            val level = params.optInt("level", 1)
            """{"ok":true,"message":"${seat}座椅加热已设为${level}档"}"""
        }
        "set_window" -> {
            val pos = params.optString("position", "driver")
            val open = params.optBoolean("open", true)
            """{"ok":true,"message":"${pos}车窗已${if (open) "打开" else "关闭"}"}"""
        }
        "start_navigation" -> {
            val destination = params.optString("destination", "")
            val address = params.optString("address", "")
            // TODO: 调用厂商导航 SDK，设置目的地
            // NavigationSDK.startNavigation(destination, address)
            """{"ok":true,"message":"已开始导航到${destination}"}"""
        }
        else -> """{"ok":false,"error":"未知操作: $action"}"""
    }

    // 发送 tool_response 给 WS 连接 1
    val response = """{"tool_response":{"functionResponses":[{"id":"$callId","name":"car_control","response":$result}]}}"""
    ws1.send(response)
}
```

### 6.3 openclaw_help — 转发到云端

这是**异步**操作。AI 调用后不会等待结果，而是继续说话（比如"好，我查一下"）。结果稍后通过 WS 连接 2 返回，再注入给 AI。

**完整流程：**

```
收到: functionCall(name="openclaw_help", id="call_456", args={request:"今天北京天气"})

Step 1: 立即向 WS 连接 1 发送 ACK（让 AI 知道工具已收到）

    {"tool_response": {"functionResponses": [{
        "id": "call_456",
        "name": "openclaw_help",
        "response": {"result": "正在处理，请稍等"}
    }]}}

Step 2: 向 WS 连接 2 发送 help 请求

    {"type": "help", "request": "今天北京天气", "callId": "call_456"}

Step 3: 等待 WS 连接 2 返回结果（可能需要 2-30 秒）

    ← {"type": "help_result", "callId": "call_456", "reply": "北京现在气温4.5°C，多云，南风约7公里/小时"}

Step 4: 将结果注入 WS 连接 1（让 AI 知道查询结果，并语音播报）

    发送第一条（注入内容）:
    {"client_content": {
        "turns": [{"role": "model", "parts": [{"text": "北京现在气温4.5°C，多云，南风约7公里/小时"}]}],
        "turn_complete": false
    }}

    发送第二条（触发 AI 播报）:
    {"client_content": {
        "turns": [{"role": "model", "parts": [{"text": "以上信息来自 backend ai，请你根据实际情况回复用户信息！"}]}],
        "turn_complete": true
    }}

Step 5: AI 收到后会语音播报："北京现在气温大约4度半，天气多云"
```

**厂商实现参考（Kotlin）：**

```kotlin
fun handleOpenClawHelp(request: String, callId: String) {
    // Step 1: 立即 ACK
    ws1.send("""{"tool_response":{"functionResponses":[{"id":"$callId","name":"openclaw_help","response":{"result":"正在处理，请稍等"}}]}}""")

    // Step 2: 转发到 WS2
    ws2.send("""{"type":"help","request":"$request","callId":"$callId"}""")

    // Step 3-5: 在 WS2 的 onMessage 中处理（见下方）
}

// WS 连接 2 的消息处理
fun onWS2Message(jsonStr: String) {
    val msg = JSONObject(jsonStr)
    when (msg.optString("type")) {
        "connected" -> {
            // 连接成功，保存 sessionId
            sessionId = msg.optString("sessionId")
        }
        "help_result" -> {
            // Step 3: 收到结果
            val reply = msg.getString("reply")
            // Step 4: 注入 WS1
            injectToGemini(reply)
        }
        "inject" -> {
            // 服务端主动推送（如定时提醒）
            val reply = msg.getString("reply")
            injectToGemini(reply)
        }
    }
}

// 将文本注入 Gemini 对话历史，触发 AI 语音播报
fun injectToGemini(text: String) {
    // 第一条：注入内容
    ws1.send("""{"client_content":{"turns":[{"role":"model","parts":[{"text":"$text"}]}],"turn_complete":false}}""")
    // 第二条：触发播报（这是系统信号，AI 不会朗读这句话）
    ws1.send("""{"client_content":{"turns":[{"role":"model","parts":[{"text":"以上信息来自 backend ai，请你根据实际情况回复用户信息！"}]}],"turn_complete":true}}""")
}
```

### 6.4 inject 处理（服务端主动推送）

WS 连接 2 可能随时收到 `inject` 消息（如 AI 主动提醒"你有一个会议"）。处理方式和 `help_result` 完全相同：调用 `injectToGemini(reply)`。

---

## 七、音频采集与降噪

### 7.1 AudioRecord 配置

```kotlin
val sampleRate = 16000
val bufferSize = AudioRecord.getMinBufferSize(
    sampleRate,
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT
)

val audioRecord = AudioRecord(
    MediaRecorder.AudioSource.VOICE_COMMUNICATION,  // 启用系统 AEC
    sampleRate,
    AudioFormat.CHANNEL_IN_MONO,
    AudioFormat.ENCODING_PCM_16BIT,
    bufferSize
)
```

> 使用 `VOICE_COMMUNICATION` 而非 `MIC`，Android 会自动启用系统级回声消除（AEC）。

### 7.2 指定麦克风设备

```kotlin
val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
val mics = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
    .filter { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC
           || it.type == AudioDeviceInfo.TYPE_USB_DEVICE
           || it.type == AudioDeviceInfo.TYPE_USB_HEADSET }

// 指定使用特定麦克风（如车顶麦克风）
audioRecord.setPreferredDevice(mics[targetIndex])
```

### 7.3 讯飞降噪集成

```
AudioRecord.read(buffer)         // 640 bytes (20ms)
    │
    ▼
IFlySpeechDenoiser.process(buffer)  // 讯飞本地降噪
    │
    ▼ 降噪后 PCM（同格式：16kHz 16bit mono）
    │
Base64.encodeToString(buffer, Base64.NO_WRAP)
    │
    ▼ 发送到 WS 连接 1
```

**注意事项：**
- 讯飞 SDK 输入输出必须是 **16kHz, 16bit, mono**
- 降噪延迟控制在 5ms 以内
- 如果讯飞 SDK 需要其他采样率，App 负责重采样

### 7.4 回声消除（AEC）

车内扬声器和麦克风距离近时需要 AEC。两种方案：

1. **Android 系统 AEC**（推荐）：使用 `AudioSource.VOICE_COMMUNICATION`，系统自动处理
2. **讯飞 SDK AEC**：将 AudioTrack 的播放信号作为参考信号喂入讯飞 SDK

### 7.5 AudioTrack 配置

```kotlin
val audioTrack = AudioTrack.Builder()
    .setAudioAttributes(AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build())
    .setAudioFormat(AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(24000)                        // 注意：下行是 24kHz
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build())
    .setBufferSizeInBytes(/* AudioTrack.getMinBufferSize(...) */)
    .setTransferMode(AudioTrack.MODE_STREAM)
    .build()
```

---

## 八、完整时序图

### 8.1 一次完整的语音对话（用户问天气）

```
时间线 →

[用户说] "帮我查一下今天北京天气"

App:  AudioRecord → 讯飞降噪 → Base64 → realtime_input → WS1
                                                          │
AI:   (VAD 检测到语音结束)                                │
      ← inputTranscription: "帮我查一下今天北京天气"      ←┘
      ← audio: "好的，我帮你查一下"                       (App 播放)
      ← functionCall: openclaw_help({request:"今天北京天气"})

App:  → WS1: tool_response (ACK)
      → WS2: help 请求

      ... 等待 3-5 秒 ...

WS2:  ← help_result: "北京现在气温4.5°C，多云"

App:  → WS1: client_content("北京现在气温4.5°C，多云")
      → WS1: client_content("以上信息来自 backend ai...")

AI:   ← audio: "北京现在气温大约4度半，天气多云"           (App 播放)
      ← turnComplete

[用户听到回复]
```

### 8.2 一次完整的车控交互（用户开空调）

```
[用户说] "帮我把空调调到25度"

App:  AudioRecord → 讯飞降噪 → Base64 → realtime_input → WS1

AI:   ← functionCall: car_control({action:"set_ac_temperature", params:{temperature:25}})

App:  调用厂商车控 SDK (本地, <100ms)
      → WS1: tool_response({ok:true, message:"空调已设置为25度"})

AI:   ← audio: "好的，空调已经调到25度了"                  (App 播放)
      ← turnComplete

[用户听到确认，感受到空调变化]
```

### 8.3 一次完整的导航交互（记忆 + 确认 + 导航）

```
[用户说] "去上周和老王喝酒的饭店"

App:  AudioRecord → 讯飞降噪 → Base64 → realtime_input → WS1

AI:   需要查记忆 → ← functionCall: openclaw_help({request:"查询上周和老王喝酒的饭店"})

App:  ACK → WS1（AI 说"好的让我查一下"）
      help 请求 → WS2

WS2:  OpenClaw 查询记忆 → 找到"锦里老灶火锅，人民路123号"
      ← help_result: "上周和老王去的是锦里老灶火锅，地址是人民路123号"

App:  注入结果 → WS1

AI:   ← audio: "你上周和老王去的是锦里老灶火锅，要帮你导航过去吗？"

[用户说] "好的"

AI:   ← functionCall: car_control({action:"start_navigation", params:{destination:"锦里老灶火锅", address:"人民路123号"}})

App:  调用导航 SDK (本地)
      → WS1: tool_response({ok:true, message:"已开始导航到锦里老灶火锅"})

AI:   ← audio: "好的，导航已设置好了"

[车机开始导航]
```

---

## 九、Android App 类结构参考

```
CarHerApp/
├── audio/
│   ├── AudioCaptureManager.kt      // AudioRecord + 讯飞降噪
│   │   ├── start(deviceId?)        // 启动录音
│   │   ├── stop()                  // 停止录音
│   │   └── callback: (base64) →    // 每帧回调
│   │
│   └── AudioPlaybackManager.kt     // AudioTrack 播放
│       ├── play(pcmBytes)          // 写入播放缓冲
│       ├── interrupt()             // 打断清空
│       └── isPlaying()
│
├── network/
│   ├── BootstrapClient.kt          // HTTP GET bootstrap
│   │   └── fetch(url) → Config
│   │
│   ├── GeminiProxyClient.kt        // WS 连接 1
│   │   ├── connect(url)
│   │   ├── sendRaw(json)           // 发送任意 JSON
│   │   ├── sendAudioFrame(base64)  // 封装 realtime_input
│   │   └── onMessage: (json) →
│   │
│   └── OpenClawClient.kt           // WS 连接 2
│       ├── connect(url)
│       ├── sendHelp(request, callId)
│       ├── sendTranscript(role, text)
│       └── onMessage: (json) →
│
├── tools/
│   ├── ToolHandler.kt               // 工具调用分发
│   └── CarControlSDK.kt             // 厂商车控封装
│       └── execute(action, params) → JSON result
│
├── ui/                               // [可选] 原生 UI 或 WebView
│   └── ...
│
└── CarHerApplication.kt              // App 入口
```

---

## 十、联调步骤

```
Step 1: 本地闭环（无需我方服务）
  App 能录音 → 讯飞降噪 → 播放回声
  验证: 说话后能听到降噪后的自己声音

Step 2: 连接验证
  App 调用 Bootstrap → 获得配置
  App 连接 WS1 + WS2 → 发送 setup → 收到 setupComplete
  验证: 两个 WebSocket 都连通

Step 3: 基本语音对话
  发送音频 → AI 回复音频 → 播放
  验证: 说"你好"能听到 AI 回复

Step 4: 车控指令
  说"打开空调" → 收到 car_control → 本地执行 → 返回结果 → AI 确认
  验证: 语音说出车控指令后，车辆真实响应

Step 5: 云端工具
  说"帮我查天气" → openclaw_help → 注入结果 → AI 播报
  验证: 能查到真实天气并语音播报

Step 6: 端到端演示
  完整流程无卡顿
```

**Step 1 可以完全离线完成。Step 2-6 需要我方云端服务在线。**

---

## 十一、错误处理

| 场景 | 处理方式 |
|------|---------|
| Bootstrap 请求失败 | 重试 3 次，间隔 2 秒 |
| WS1 断开 | 重新调用 Bootstrap → 重连 WS1 → 重发 setup → 恢复音频流 |
| WS2 断开 | 重连 WS2，不影响基本语音对话（只是 help 不可用） |
| setupComplete 超时（10 秒） | 断开 WS1，重新 Bootstrap + 连接 |
| help_result 超时（120 秒） | 向 WS1 注入 "抱歉，查询超时，请稍后再试" |
| 讯飞 SDK 初始化失败 | 跳过降噪，直接用原始 PCM 继续工作 |
| AudioRecord 启动失败 | 提示用户检查麦克风权限 |
| car_control 执行失败 | 返回 `{"ok":false,"error":"执行失败"}` 给 AI |

---

## 十二、AndroidManifest.xml 权限

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

---

## 附录 A：WS 连接 1 消息格式速查

### App → WS1（发送）

```
# 认证（Bootstrap 返回，原样发送）
config.geminiProxy.serviceSetup

# 会话配置（Bootstrap 返回，原样发送）
config.geminiProxy.sessionSetup

# 音频帧（每 20ms 一帧）
{"realtime_input":{"media_chunks":[{"mime_type":"audio/pcm","data":"<base64>"}]}}

# 文本注入（openclaw 结果）
{"client_content":{"turns":[{"role":"model","parts":[{"text":"注入的文本"}]}],"turn_complete":false}}
{"client_content":{"turns":[{"role":"model","parts":[{"text":"以上信息来自 backend ai，请你根据实际情况回复用户信息！"}]}],"turn_complete":true}}

# 工具响应
{"tool_response":{"functionResponses":[{"id":"<callId>","name":"<工具名>","response":{...}}]}}
```

### WS1 → App（接收）

```
# 会话就绪
{"setupComplete":{}}

# 音频回复
{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"<base64>"}}]}}}

# 文本回复
{"serverContent":{"modelTurn":{"parts":[{"text":"..."}]}}}

# 工具调用
{"serverContent":{"modelTurn":{"parts":[{"functionCall":{"name":"car_control","id":"call_xxx","args":{...}}}]}}}

# 用户语音转写
{"serverContent":{"inputTranscription":{"text":"用户说的话","finished":true}}}

# AI 语音转写
{"serverContent":{"outputTranscription":{"text":"AI说的话"}}}

# 一轮结束
{"serverContent":{"turnComplete":true}}

# 用户打断
{"serverContent":{"interrupted":true}}
```

---

## 附录 B：WS 连接 2 消息格式速查

### App → WS2（发送）

```
# 请求帮助
{"type":"help","request":"今天天气","callId":"call_xxx"}

# 上报用户语音
{"type":"transcript","role":"user","text":"帮我查天气"}

# 上报 AI 回复
{"type":"transcript","role":"live","text":"好的，我帮你查一下"}

# 通知一轮结束
{"type":"turn_complete"}
```

### WS2 → App（接收）

```
# 连接成功
{"type":"connected","sessionId":"abc123"}

# help 结果（需要注入 WS1）
{"type":"help_result","callId":"call_xxx","reply":"北京气温4.5°C，多云"}

# 主动推送（需要注入 WS1）
{"type":"inject","reply":"提醒：你有一个会议"}

# prompt 更新（可忽略，高级功能）
{"type":"prompt_update","section":"memory","content":"..."}
```

---

## 联系方式

技术对接过程中如有问题，请随时联系我方技术团队。
