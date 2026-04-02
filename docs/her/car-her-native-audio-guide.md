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

| 序号 | 任务                                                                    | 复杂度            |
| ---- | ----------------------------------------------------------------------- | ----------------- |
| 1    | Android App 框架 + 权限配置                                             | 低                |
| 2    | AudioRecord 采集 + 讯飞降噪                                             | 中                |
| 3    | AudioTrack 播放 AI 回复                                                 | 低                |
| 4    | WebSocket 客户端（2 条连接）                                            | 中                |
| 5    | 工具调用分发（openclaw_help + car_control）                             | 中                |
| 6    | 车控 SDK 对接                                                           | 厂商自有          |
| 7    | ⚠️ inject 安全机制（turnComplete gate + 队列 + RESPONSE_REJECTED 恢复） | 中（见第 6.5 节） |

### 厂商不需要关心的事

- AI 模型配置、system prompt、工具定义 — 全由 Bootstrap 接口返回，原样透传
- Google Cloud 认证 — 服务端自动处理
- OpenRouter API Key — 服务端自动处理
- Token 生成/轮换 — 由我方生成并提供，厂商只需写入 App 配置

### 与 v1（WebView 方案）的对比

| 维度       | v1 WebView 方案            | v2 原生音频方案                |
| ---------- | -------------------------- | ------------------------------ |
| 麦克风采集 | WebView `getUserMedia`     | Android `AudioRecord` 原生 API |
| 降噪       | 浏览器内置（有限）         | 讯飞 SDK 本地降噪              |
| 麦克风选择 | `enumerateDevices`（受限） | 原生 API 直接指定设备          |
| 扬声器选择 | `setSinkId`（不可靠）      | `AudioTrack` 原生 API          |
| 音频质量   | 受 WebView 限制            | 完全可控                       |
| 协议对接   | 前端 JS 封装好             | 厂商需实现 WebSocket 客户端    |
| UI 界面    | WebView 渲染               | 原生 UI 或 WebView 仅做展示    |

---

## 二、我方提供给厂商的信息

我方提供 **3 个 URL + 1 个 Token**。

### 认证 Token

所有 API 请求需要携带认证 Token（query parameter 方式）。Token 由我方生成并提供，厂商写入 App 配置即可。

- Token 格式：32 位 hex 字符串（如 `a1b2c3d4e5f6789012345678abcdef01`）
- 传递方式：URL query parameter `?token=<TOKEN>`
- 适用范围：BOOTSTRAP_URL 和 OPENCLAW_URL 需要 token；PROXY_URL 不需要
- Token 变更：我方重置 token 后会通知厂商更新配置，**不需要重新编译 App**

**建议：** 将 token 存储在 App 的配置文件或 SharedPreferences 中，不要硬编码在代码里。这样 token 变更时只需更新配置，无需重新编译。

### 3 个 URL

联调期间使用以下**固定 URL**（命名隧道，永不变化）：

```
  BOOTSTRAP_URL (App 启动时 HTTP GET 调用一次):
    https://s1-u12-fe.carher.net/api/realtime/bootstrap?token=d797792d4ed14132b6862ff5309318bc

  PROXY_URL (WS 连接 1 — 音频双向流):
    wss://s1-u12-proxy.carher.net

  OPENCLAW_URL (WS 连接 2 — 后台 AI):
    wss://s1-u12-fe.carher.net/ws?token=d797792d4ed14132b6862ff5309318bc
```

> 这些 URL 通过 Cloudflare 命名隧道映射到我方服务器，域名固定不变，重启服务后 URL 和 Token 均不变。

**3 个 URL 的用途：**

| 名称          | 协议      | 用途                                                 | 需要 Token |
| ------------- | --------- | ---------------------------------------------------- | ---------- |
| BOOTSTRAP_URL | HTTP GET  | App 启动时调用一次，获取 AI 配置 JSON                | 是         |
| PROXY_URL     | WebSocket | WS 连接 1 — 音频上行/下行、AI 文本、工具调用         | 否         |
| OPENCLAW_URL  | WebSocket | WS 连接 2 — 发送 help 请求、接收 help 结果和主动推送 | 是         |

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
        "model": "projects/<YOUR_PROJECT_ID>/locations/us-central1/publishers/google/models/gemini-live-2.5-flash-native-audio",
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
              "parameters": { "...": "..." }
            },
            {
              "name": "car_control",
              "description": "...",
              "parameters": { "...": "..." }
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

| 字段                       | 怎么用                                                |
| -------------------------- | ----------------------------------------------------- |
| `geminiProxy.serviceSetup` | 原样 JSON 序列化，作为 WS 连接 1 的**第一条消息**发送 |
| `geminiProxy.sessionSetup` | 原样 JSON 序列化，作为 WS 连接 1 的**第二条消息**发送 |
| 其他字段                   | 忽略                                                  |

**Kotlin 参考代码（调用 BOOTSTRAP_URL）：**

```kotlin
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/**
 * 调用 Bootstrap 获取 AI 配置。
 * @param bootstrapUrl 我方提供的 BOOTSTRAP_URL（含 token），如
 *   "https://s1-u12-fe.carher.net/api/realtime/bootstrap?token=d797792d..."
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

// 使用示例（token 从 App 配置读取，不要硬编码）:
// val token = AppConfig.getVoiceToken()
// val config = fetchBootstrap("https://s1-u12-fe.carher.net/api/realtime/bootstrap?token=$token")
// val serviceSetup: JSONObject = config.getJSONObject("geminiProxy").getJSONObject("serviceSetup")
// val sessionSetup: JSONObject = config.getJSONObject("geminiProxy").getJSONObject("sessionSetup")
```

### 2.2 BOOTSTRAP_URL 调用时机

| 场景                 | 是否需要重新调用       |
| -------------------- | ---------------------- |
| App 首次启动         | 是                     |
| 每次建立新的语音会话 | 是（配置可能动态变化） |
| WS 断开后重连        | 是                     |
| 语音对话进行中       | 不需要                 |

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

// OPENCLAW_URL 由我方提供，含 token，如 "wss://s1-u12-fe.carher.net/ws?token=d797792d..."
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
                "help_result" -> onWS2HelpResult(msg)   // 见第 6.3 节
                "inject" -> onWS2Inject(msg)             // 见第 6.4 节
            }
        }
    }
)
```

**等待条件：** 收到 `{"type":"connected","sessionId":"..."}` 后再进入 Step 3。

### Step 3: 连接 PROXY_URL（WS 连接 1）

```kotlin
// PROXY_URL 由我方提供，如 "wss://s1-u12-proxy.carher.net"
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

| 参数     | 值                | 说明                          |
| -------- | ----------------- | ----------------------------- |
| 采样率   | **16000 Hz**      | 强制要求，不可修改            |
| 位深     | **16 bit**        | signed int16, little-endian   |
| 声道     | **单声道 (mono)** | —                             |
| 编码     | **PCM → Base64**  | 原始 PCM 字节转 Base64 字符串 |
| 发送频率 | 每 **20ms** 一帧  | 320 samples = 640 bytes PCM   |

> 完整实现代码见 Step 4，发送规则见 Step 4 "重要规则"。

### 4.2 下行（云端 → 扬声器）

AI 回复的音频在 WS 连接 1 的 JSON 消息中。**注意：下行采样率是 24kHz，和上行的 16kHz 不同。**

| 参数   | 值                                     |
| ------ | -------------------------------------- |
| 采样率 | **24000 Hz**                           |
| 位深   | **16 bit** signed int16, little-endian |
| 声道   | **单声道 (mono)**                      |

> 完整实现代码见 Step 5，JSON 格式见 5.2 消息示例。

### 4.3 指定麦克风设备

```kotlin
val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
val mics = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
    .filter { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC
           || it.type == AudioDeviceInfo.TYPE_USB_DEVICE
           || it.type == AudioDeviceInfo.TYPE_USB_HEADSET }

// 指定使用特定麦克风（如车顶麦克风）
audioRecord.setPreferredDevice(mics[targetIndex])
```

### 4.4 回声消除（AEC）

车内扬声器和麦克风距离近时需要 AEC。两种方案：

1. **Android 系统 AEC**（推荐）：Step 4 代码中使用 `AudioSource.VOICE_COMMUNICATION`，系统自动处理
2. **讯飞 SDK AEC**：将 AudioTrack 的播放信号作为参考信号喂入讯飞 SDK

---

## 五、WS 连接 1 下行消息处理

WS 连接 1 会收到多种 JSON 消息，App 需要根据字段判断类型并处理。

### 5.1 消息类型判断（伪代码）

```kotlin
// ⚠️ 转写文本是分段到达的，需要累积后再上报 WS2
var pendingUserTranscript: String = ""
var pendingLiveTranscript: String = ""

// Step 3 的 onMessage 已处理 setupComplete，此处处理后续所有消息
fun handleWS1Message(json: JSONObject) {
    // ⚠️ 工具调用是顶层 toolCall 字段，不在 serverContent 内！
    val toolCall = json.optJSONObject("toolCall")
    if (toolCall != null) {
        val functionCalls = toolCall.optJSONArray("functionCalls") ?: return
        for (i in 0 until functionCalls.length()) {
            val fc = functionCalls.getJSONObject(i)
            handleToolCall(fc)  // 详见第六章
        }
        return
    }

    val serverContent = json.optJSONObject("serverContent") ?: return
    val modelTurn = serverContent.optJSONObject("modelTurn")

    // 1. 用户打断
    if (serverContent.optBoolean("interrupted")) {
        audioPlayer.interrupt()  // 立即停止播放，清空缓冲
        return
    }

    // 2. 一轮回复结束（⚠️ 注意：RESPONSE_REJECTED 也是 turnComplete=true，需要额外检查 reason）
    if (serverContent.optBoolean("turnComplete")) {
        val reason = serverContent.optString("turnCompleteReason", "")
        if (reason == "RESPONSE_REJECTED") {
            // ⚠️ 厂商必须处理：AI 拒绝响应（见第 6.5 节安全机制）
            onResponseRejected()
        } else {
            onTurnComplete()
        }
        return
    }

    // 3. 用户语音转写（多段到达，需要累积；finished=true 表示完整句子结束）
    val inputTx = serverContent.optJSONObject("inputTranscription")
    if (inputTx != null) {
        val text = inputTx.optString("text")
        val finished = inputTx.optBoolean("finished")
        if (!finished) {
            pendingUserTranscript += text  // 累积 partial 片段
        } else {
            // 上报完整句子给 WS2
            if (pendingUserTranscript.isNotEmpty()) {
                ws2.send("""{"type":"transcript","role":"user","text":"$pendingUserTranscript"}""")
            }
            pendingUserTranscript = ""
        }
        onUserTranscription(text, finished)
        return
    }

    // 4. AI 语音转写（多段到达，需要累积；finished=true 表示一轮说完）
    val outputTx = serverContent.optJSONObject("outputTranscription")
    if (outputTx != null) {
        val text = outputTx.optString("text")
        val finished = outputTx.optBoolean("finished")
        if (!finished) {
            pendingLiveTranscript += text  // 累积 partial 片段
        } else {
            // 上报完整 AI 回复给 WS2
            if (pendingLiveTranscript.isNotEmpty()) {
                ws2.send("""{"type":"transcript","role":"live","text":"$pendingLiveTranscript"}""")
            }
            pendingLiveTranscript = ""
        }
        onAITranscription(text, finished)
        return
    }

    // 5. modelTurn 中的内容（音频和文本；工具调用已在上方 toolCall 分支处理）
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
            // 注意：AI 回复的转写由上方 outputTranscription 处理并上报 WS2，此处只做 UI 展示
            val text = part.optString("text")
            if (text.isNotEmpty()) {
                onAIText(text)
                continue
            }

            // 注意：工具调用（toolCall）已在上方顶层处理，不会出现在 parts 中
        }
    }
}
```

### 5.2 各消息类型 JSON 示例

```json
音频:     {"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"..."}}]}}}
文本:     {"serverContent":{"modelTurn":{"parts":[{"text":"好的，我帮你查一下天气"}]}}}
工具调用: {"toolCall":{"functionCalls":[{"name":"car_control","args":{...}}]}}
用户转写: {"serverContent":{"inputTranscription":{"text":"帮我查天气","finished":true}}}
AI转写:   {"serverContent":{"outputTranscription":{"text":"好的"}}}
一轮结束: {"serverContent":{"turnComplete":true}}
拒绝响应: {"serverContent":{"turnComplete":true,"turnCompleteReason":"RESPONSE_REJECTED"}}
用户打断: {"serverContent":{"interrupted":true}}
```

---

## 六、工具调用处理

AI 会通过 WS 连接 1 发送工具调用。有两种工具：`openclaw_help`（转发到云端处理）和 `car_control`（本地执行）。

### 6.1 工具调用分发（伪代码）

```kotlin
// functionCall 是 toolCall.functionCalls[] 数组中的单个元素
// Gemini Live 的 functionCall 可能包含 id 字段，也可能没有
// 优先使用 Gemini 返回的 id，没有则自行生成 UUID
fun handleToolCall(functionCall: JSONObject) {
    val name = functionCall.getString("name")
    val args = functionCall.optJSONObject("args") ?: JSONObject()
    val callId = functionCall.optString("id").ifEmpty { UUID.randomUUID().toString() }

    when (name) {
        "openclaw_help" -> handleOpenClawHelp(args.optString("request"), callId)
        "car_control"   -> handleCarControl(args, callId)
        else            -> sendToolError(callId, name, "未知工具: $name")
    }
}
```

### 6.2 car_control — 本地执行（同步）

收到后立即在本地执行，把结果通过 `tool_response` 返回给 AI。AI 收到后会语音确认。

**action 列表：**

| action               | args.params 示例                                            | 说明                         |
| -------------------- | ----------------------------------------------------------- | ---------------------------- |
| `set_ac_temperature` | `{"temperature": 25}`                                       | 设置空调温度（16-32）        |
| `set_ac_power`       | `{"on": true}`                                              | 开/关空调                    |
| `set_ac_mode`        | `{"mode": "cool"}`                                          | cool / heat / auto           |
| `set_seat_heat`      | `{"seat": "driver", "level": 2}`                            | 座椅加热 0-3（0=关）         |
| `set_window`         | `{"position": "driver", "open": true}`                      | 车窗开/关                    |
| `start_navigation`   | `{"destination": "锦里老灶火锅", "address": "人民路123号"}` | 导航到目的地（address 可选） |

**厂商实现参考（Kotlin）：**

```kotlin
fun handleCarControl(args: JSONObject, callId: String) {  // callId 由 App 生成（见 6.1）
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

    // 发送 tool_response 给 WS 连接 1（id 使用 callId）
    val response = """{"tool_response":{"functionResponses":[{"id":"$callId","name":"car_control","response":$result}]}}"""
    ws1.send(response)
}
```

### 6.3 openclaw_help — 转发到云端（异步）

AI 调用后不会等待结果，而是继续说话（如"好，我查一下"）。结果稍后通过 WS2 返回，再注入给 AI。

**流程概要**：WS1 收到 toolCall → App 发 ACK → 转发到 WS2 → 等 WS2 返回 → 等 AI 说完（turnComplete）→ 原子注入 → AI 播报。

**Kotlin 实现：**

```kotlin
fun handleOpenClawHelp(request: String, callId: String) {  // callId 由 App 生成（见 6.1）
    // 分配自增编号（系统 prompt 依赖 #N 来关联请求和结果）
    val seq = ++helpCounter
    helpRequests[callId] = Pair(request, seq)

    // Step 1: 立即 ACK — 必须包含 #N 编号，格式与系统 prompt 约定一致
    // 系统 prompt 告诉 Gemini："你会收到 '请求 #N 已收到，后台正在处理'"
    val ackText = "请求 #${seq} 已收到，后台正在处理。结果稍后会标注 #${seq} 自动出现，届时请播报给用户。在此之前不要再次调用 openclaw_help。"
    val ack = JSONObject().apply {
        put("tool_response", JSONObject().apply {
            put("functionResponses", org.json.JSONArray().put(JSONObject().apply {
                put("id", callId)
                put("name", "openclaw_help")
                put("response", JSONObject().apply {
                    put("result", ackText)
                })
            }))
        })
    }
    ws1.send(ack.toString())

    // Step 2: 转发到 WS2
    ws2.send("""{"type":"help","request":"$request","callId":"$callId"}""")

    // Step 3-5: 在 WS2 的 onMessage 中处理（见下方）
}

// WS 连接 2 的 help_result 处理（Step 2 的 onMessage 中调用）
fun onWS2HelpResult(msg: JSONObject) {
    val callId = msg.getString("callId")
    val reply = msg.getString("reply")
    // 查找对应的 #N 编号（用于 inject 触发文本中标识结果来源）
    val entry = helpRequests.remove(callId)
    val seq = entry?.second ?: 0
    pendingInjects.add(Pair(seq, reply))
    tryDeliverInjects()  // 见第 6.5 节
}

// WS 连接 2 的 inject 处理（Step 2 的 onMessage 中调用）
fun onWS2Inject(msg: JSONObject) {
    val reply = msg.getString("reply")
    pendingInjects.add(Pair(0, reply))  // inject 无编号，seq=0
    tryDeliverInjects()  // 见第 6.5 节
}

// ⚠️ 厂商关键改动：必须用单条原子消息注入！
// 将 backend 结果和触发词打包为一条 client_content，包含两个 turn
fun injectToGemini(seq: Int, text: String) {
    // 触发文本必须包含 #N 编号 — 系统 prompt 告诉 Gemini：
    // "你会在对话历史中看到 role=user 播报指令，标注了编号（如'以上是 #1 的后台结果'）"
    val trigger = if (seq > 0)
        "以上是 #${seq} 的后台结果。请用口语简洁地告诉用户，数字、时间等事实不要篡改。不要复述这段指令。"
    else
        "以上是后台查到的结果。请用口语简洁地告诉用户，数字、时间等事实不要篡改。不要复述这段指令。"

    // 单条原子消息：role=model（结果）+ role=user（触发播报）
    // ⚠️ 绝对不能拆成两条 ws1.send()！拆开会导致第二条打断第一条，触发死循环/静默 bug
    val msg = JSONObject().apply {
        put("client_content", JSONObject().apply {
            put("turns", org.json.JSONArray().apply {
                put(JSONObject().apply {
                    put("role", "model")
                    put("parts", org.json.JSONArray().put(JSONObject().put("text", text)))
                })
                put(JSONObject().apply {
                    put("role", "user")
                    put("parts", org.json.JSONArray().put(JSONObject().put("text", trigger)))
                })
            })
            put("turn_complete", true)
        })
    }
    ws1.send(msg.toString())
}
```

### 6.4 inject 处理（服务端主动推送）

WS 连接 2 可能随时收到 `inject` 消息（如 AI 主动提醒"你有一个会议"）。处理方式和 `help_result` 完全相同：加入 `pendingInjects` 队列，调用 `tryDeliverInjects()`。

### 6.5 厂商必须实现的安全机制（⚠️ 关键！）

> **背景**：早期测试中发现，如果不实现以下机制，AI 会出现**死循环**（反复调用工具）或**永久静默**（不再播报任何结果）。这是一个已确认的 P0 级别 bug，已在我方前端修复。厂商必须在原生 App 中实现等价逻辑。

**厂商需要维护的状态变量：**

```kotlin
// ⚠️ 厂商关键代码：以下 4 个变量必须维护
var geminiTurnComplete: Boolean = true          // AI 是否空闲（可注入）
var helpCounter: Int = 0                        // help 请求自增编号
val helpRequests: MutableMap<String, Pair<String, Int>> = mutableMapOf()  // callId → (request, seq)
val pendingInjects: MutableList<Pair<Int, String>> = mutableListOf()      // (seq, reply) 队列
```

**机制 1：turnComplete Gate（注入门控）**

```kotlin
// ⚠️ 厂商关键代码：不能在 AI 说话中途注入！
fun tryDeliverInjects() {
    if (!geminiTurnComplete) return       // AI 正在说话，等它说完
    if (pendingInjects.isEmpty()) return  // 没有待注入内容

    val (seq, reply) = pendingInjects.removeAt(0)  // 每次只注入一条

    // 标记为注入中（等下一次 turnComplete 后才能再注入）
    geminiTurnComplete = false

    // 等 AudioTrack 播完当前音频后再注入（避免打断正在播放的语音）
    waitForAudioPlaybackIdle {
        injectToGemini(seq, reply)
    }
}
```

**机制 2：turnComplete 事件驱动注入**

```kotlin
// 收到正常的 turnComplete 时
fun onTurnComplete() {
    geminiTurnComplete = true
    tryDeliverInjects()  // 尝试投递下一个 pending inject

    // 通知 WS2 一轮结束（后台用于跟踪对话状态）
    ws2.send("""{"type":"turn_complete"}""")
}
```

**机制 3：RESPONSE_REJECTED 恢复（⚠️ 不处理会导致永久卡死）**

```kotlin
// ⚠️ 厂商关键代码：RESPONSE_REJECTED 必须恢复 gate！
fun onResponseRejected() {
    Log.w("WS1", "Gemini RESPONSE_REJECTED - 恢复注入 gate")

    // 恢复 gate，否则后续所有 inject 永远无法投递
    geminiTurnComplete = true
    tryDeliverInjects()  // 尝试重新投递
}
```

**为什么这三个机制缺一不可：**

| 缺少的机制                | 后果                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 无 turnComplete Gate      | inject 在 AI 说话中途发送，`client_content` 打断正在进行的生成，触发 `RESPONSE_REJECTED`，后续 inject 卡死 |
| 无 inject 队列            | 多个 help_result 同时到达时互相覆盖，丢失结果                                                              |
| 无 RESPONSE_REJECTED 恢复 | 一旦发生 reject，`geminiTurnComplete` 永远是 `false`，所有后续 inject 卡死                                 |

---

## 七、完整时序图

### 7.1 一次完整的语音对话（用户问天气）

```
时间线 →

[用户说] "帮我查一下今天北京天气"

App:  AudioRecord → 讯飞降噪 → Base64 → realtime_input → WS1
                                                          │
AI:   (VAD 检测到语音结束)                                │
      ← inputTranscription: "帮我查一下今天北京天气"      ←┘
      ← toolCall: openclaw_help({request:"今天北京天气"})

App:  → WS1: tool_response (ACK)
      → WS2: help 请求

AI:   ← audio: "好的，我帮你查一下"                       (App 播放)
      ← turnComplete                                      (App: geminiTurnComplete = true)

      ... 等待 3-5 秒 ...

WS2:  ← help_result: "北京现在气温4.5°C，多云"

App:  pendingInjects.add(Pair(seq=1, reply))
      tryDeliverInjects():
        geminiTurnComplete == true → 可以注入
        geminiTurnComplete = false
        → WS1: 单条原子 client_content:
            role=model "北京现在气温4.5°C，多云"
            role=user  "以上是 #1 的后台结果。请用口语简洁地告诉用户..."
            turn_complete=true

AI:   ← audio: "北京现在气温大约4度半，天气多云"           (App 播放)
      ← turnComplete                                      (App: geminiTurnComplete = true)

[用户听到回复]
```

### 7.2 一次完整的车控交互（用户开空调）

```
[用户说] "帮我把空调调到25度"

App:  AudioRecord → 讯飞降噪 → Base64 → realtime_input → WS1

AI:   ← toolCall: car_control({action:"set_ac_temperature", params:{temperature:25}})

App:  调用厂商车控 SDK (本地, <100ms)
      → WS1: tool_response({ok:true, message:"空调已设置为25度"})

AI:   ← audio: "好的，空调已经调到25度了"                  (App 播放)
      ← turnComplete

[用户听到确认，感受到空调变化]
```

### 7.3 一次完整的导航交互（记忆 + 确认 + 导航）

```
[用户说] "去上周和老王喝酒的饭店"

App:  AudioRecord → 讯飞降噪 → Base64 → realtime_input → WS1

AI:   需要查记忆 → ← toolCall: openclaw_help({request:"查询上周和老王喝酒的饭店"})

App:  ACK → WS1（AI 说"好的让我查一下"）
      help 请求 → WS2

AI:   ← turnComplete

WS2:  OpenClaw 查询记忆 → 找到"锦里老灶火锅，人民路123号"
      ← help_result: "上周和老王去的是锦里老灶火锅，地址是人民路123号"

App:  pendingInjects.add(Pair(seq, reply))
      tryDeliverInjects() → 单条原子 inject（含 #N 编号）→ WS1

AI:   ← audio: "你上周和老王去的是锦里老灶火锅，要帮你导航过去吗？"

[用户说] "好的"

AI:   ← toolCall: car_control({action:"start_navigation", params:{destination:"锦里老灶火锅", address:"人民路123号"}})

App:  调用导航 SDK (本地)
      → WS1: tool_response({ok:true, message:"已开始导航到锦里老灶火锅"})

AI:   ← audio: "好的，导航已设置好了"

[车机开始导航]
```

---

## 八、Android App 类结构参考

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
│   ├── InjectManager.kt             // ⚠️ inject 安全机制（gate + 队列 + REJECTED 恢复）
│   │   ├── helpCounter: Int         // help 请求自增编号
│   │   ├── helpRequests: Map        // callId → (request, seq) 映射
│   │   ├── pendingInjects: List     // (seq, reply) 队列
│   │   ├── geminiTurnComplete: Bool // turnComplete gate
│   │   ├── tryDeliverInjects()      // 门控投递
│   │   ├── onTurnComplete()         // 恢复 gate + 投递
│   │   └── onResponseRejected()     // REJECTED 恢复
│   └── CarControlSDK.kt             // 厂商车控封装
│       └── execute(action, params) → JSON result
│
├── ui/                               // [可选] 原生 UI 或 WebView
│   └── ...
│
└── CarHerApplication.kt              // App 入口
```

---

## 九、联调步骤

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

Step 5: 云端工具（⚠️ 重点验证 inject 安全机制）
  说"帮我查天气" → openclaw_help → 等 turnComplete → 注入结果 → AI 播报
  验证: 能查到真实天气并语音播报
  验证: 连续说两句需要查询的话（"查天气"、"查日程"），两次结果都能依次播报

Step 6: 端到端演示
  完整流程无卡顿
```

**Step 1 可以完全离线完成。Step 2-6 需要我方云端服务在线。**

---

## 十、错误处理

| 场景                        | 处理方式                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Bootstrap 请求失败          | 重试 3 次，间隔 2 秒                                                                      |
| WS1 断开                    | 重新调用 Bootstrap → 重连 WS1 → 重发 setup → 恢复音频流                                   |
| WS2 断开                    | 重连 WS2，不影响基本语音对话（只是 help 不可用）                                          |
| setupComplete 超时（10 秒） | 断开 WS1，重新 Bootstrap + 连接                                                           |
| help_result 超时（120 秒）  | 向 WS1 注入 "抱歉，查询超时，请稍后再试"                                                  |
| 讯飞 SDK 初始化失败         | 跳过降噪，直接用原始 PCM 继续工作                                                         |
| AudioRecord 启动失败        | 提示用户检查麦克风权限                                                                    |
| car_control 执行失败        | 返回 `{"ok":false,"error":"执行失败"}` 给 AI                                              |
| RESPONSE_REJECTED           | 恢复 inject gate（`geminiTurnComplete = true`），尝试重新投递队列中的 inject（见 6.5 节） |

---

## 十一、AndroidManifest.xml 权限

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

---

## 附录：消息格式速查

> 详细说明见正文对应章节，此处仅列格式。

**WS1 App→Gemini（发送）：**

| 用途     | JSON                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 认证     | `config.geminiProxy.serviceSetup`（原样发送）                                                                                                                                        |
| 会话配置 | `config.geminiProxy.sessionSetup`（原样发送）                                                                                                                                        |
| 音频帧   | `{"realtime_input":{"media_chunks":[{"mime_type":"audio/pcm","data":"<base64>"}]}}`                                                                                                  |
| 文本注入 | `{"client_content":{"turns":[{"role":"model","parts":[{"text":"..."}]},{"role":"user","parts":[{"text":"以上是 #N 的后台结果。请用口语简洁地告诉用户..."}]}],"turn_complete":true}}` |
| 工具响应 | `{"tool_response":{"functionResponses":[{"id":"<callId>","name":"<工具名>","response":{...}}]}}`                                                                                     |

**WS1 Gemini→App（接收）：**

| 类型     | JSON                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 会话就绪 | `{"setupComplete":{}}`                                                                                        |
| 音频     | `{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"..."}}]}}}` |
| 文本     | `{"serverContent":{"modelTurn":{"parts":[{"text":"..."}]}}}`                                                  |
| 工具调用 | `{"toolCall":{"functionCalls":[{"name":"...","args":{...}}]}}`                                                |
| 用户转写 | `{"serverContent":{"inputTranscription":{"text":"...","finished":true}}}`                                     |
| AI 转写  | `{"serverContent":{"outputTranscription":{"text":"..."}}}`                                                    |
| 一轮结束 | `{"serverContent":{"turnComplete":true}}`                                                                     |
| 拒绝响应 | `{"serverContent":{"turnComplete":true,"turnCompleteReason":"RESPONSE_REJECTED"}}`                            |
| 打断     | `{"serverContent":{"interrupted":true}}`                                                                      |

**WS2 App→OpenClaw（发送）：**

| 用途     | JSON                                               |
| -------- | -------------------------------------------------- |
| 请求帮助 | `{"type":"help","request":"...","callId":"..."}`   |
| 用户语音 | `{"type":"transcript","role":"user","text":"..."}` |
| AI 回复  | `{"type":"transcript","role":"live","text":"..."}` |
| 一轮结束 | `{"type":"turn_complete"}`                         |

**WS2 OpenClaw→App（接收）：**

| 类型        | JSON                                                                 |
| ----------- | -------------------------------------------------------------------- |
| 连接成功    | `{"type":"connected","sessionId":"..."}`                             |
| help 结果   | `{"type":"help_result","callId":"...","reply":"..."}`                |
| 主动推送    | `{"type":"inject","reply":"..."}`                                    |
| prompt 更新 | `{"type":"prompt_update","section":"...","content":"..."}`（可忽略） |

---

## 联系方式

技术对接过程中如有问题，请随时联系我方技术团队。
