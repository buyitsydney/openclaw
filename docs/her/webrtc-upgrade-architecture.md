# WebRTC 语音架构升级设计

将 Her 手机端语音从 WebSocket + Cloudflare 隧道升级为 WebRTC，实现飞书会议级别的语音流畅度。

**核心策略：基于已有的 OpenClaw iOS App（`apps/ios/`）扩展，不造新轮子。**

## 现状问题

当前手机远程架构（mobile.html via Cloudflare 隧道）：

```
手机浏览器 → WebSocket (TCP) → Cloudflare 隧道 (TCP) → server.py → WebSocket (TCP) → Gemini
```

实测数据：

- recvGapAvg: 225-456ms（正常 <100ms），drainGapMax 飙到 19s
- 每 2-8 分钟断连一次（WebSocket 1006）
- 浏览器后台节流暂停 AudioContext

桌面端直连 localhost 无此问题。

---

## 已有 iOS App 基础设施

`apps/ios/` 已经具备：

| 能力         | 实现                                        | 文件                                        |
| ------------ | ------------------------------------------- | ------------------------------------------- |
| Gateway 连接 | Bonjour 发现 + WebSocket                    | `Gateway/GatewayConnectionController.swift` |
| 语音采集     | AVAudioEngine + SFSpeechRecognizer          | `Voice/TalkModeManager.swift`               |
| 音频播放     | PCMStreamingAudioPlayer + ElevenLabs TTS    | `Voice/TalkModeManager.swift`               |
| 音频会话     | AVAudioSession (.playAndRecord, .voiceChat) | `Voice/TalkModeManager.swift`               |
| 后台音频     | AVAudioSession 已配置                       | 可后台持续运行                              |
| 打断检测     | 语音识别 + interruptOnSpeech                | `Voice/TalkModeManager.swift`               |
| 唤醒词       | VoiceWakeManager                            | `Voice/VoiceWakeManager.swift`              |
| 摄像头       | CameraController                            | `Camera/CameraController.swift`             |

当前 Talk Mode 的语音流程：

```
麦克风 → SFSpeechRecognizer → 文本 → chat.send (Gateway WebSocket) → 等待回复 → ElevenLabs TTS → 播放
```

**问题**：这是"语音转文字 → 文字回复 → TTS"模式，不是实时双向语音流。延迟高（等完整识别 + Agent 处理 + TTS 合成）。

---

## 目标架构

在 iOS App 中新增 **Gemini Live 实时语音模式**，与 Gateway 的 realtime 插件对接：

```
╔═══════════════════════════════════════════════════════════════════╗
║                         用户（开车）                              ║
║                                                                   ║
║     ┌──────────────┐                    ┌──────────────┐         ║
║     │  iOS App      │                    │  Mac 桌面浏览器│         ║
║     │  (OpenClaw)   │                    │  (不变)       │         ║
║     └──────┬───────┘                    └──────┬───────┘         ║
╚════════════╪═══════════════════════════════════╪═════════════════╝
             │                                   │
     WebRTC (UDP)  ← Gemini 音频双向流            │ WebSocket (TCP)
     WebSocket     ← OpenClaw 信令+tool call      │ ← 音频+信令
             │                                   │
╔════════════╪═══════════════════════════════════╪═════════════════╗
║            ↓             Mac 本地               ↓                 ║
║                                                                   ║
║  ┌─────────────────┐                                             ║
║  │  WebRTC Bridge   │ (新增，音频中转)                            ║
║  └────────┬────────┘                                             ║
║           │ WebSocket (localhost)                                  ║
║           ↓                                                       ║
║  ┌──────────────────┐       ┌──────────────────────────┐         ║
║  │    server.py      │       │  OpenClaw Realtime 插件   │         ║
║  │  (不修改)         │       │  port 18790 (不修改)      │         ║
║  └────────┬─────────┘       └──────────┬───────────────┘         ║
║           │                            │                          ║
║           ↓                            ↓                          ║
║  ┌──────────────────┐       ┌──────────────────────────┐         ║
║  │  Google Gemini    │       │  OpenClaw Gateway         │         ║
║  │  Live API         │       │  port 18789 (不修改)      │         ║
║  └──────────────────┘       └──────────────────────────┘         ║
╚═══════════════════════════════════════════════════════════════════╝
```

### iOS App 两条连接

1. **WebRTC → WebRTC Bridge → server.py → Gemini** — 双向实时音频（UDP，低延迟）
2. **WebSocket → OpenClaw Realtime 插件 (18790)** — tool call、inject、transcript（TCP，已有基础设施）

### 桌面端（不变）

继续走 WebSocket 直连 localhost，无任何改动。

---

## 为什么用 iOS App 而不是浏览器

| 维度         | 浏览器 (mobile.html) | iOS App (已有)            |
| ------------ | -------------------- | ------------------------- |
| 后台运行     | 锁屏 30s 后暂停      | AVAudioSession 持续运行   |
| 音频质量     | JS AudioWorklet      | 系统原生音频管线          |
| 回声消除     | 弱                   | .voiceChat 模式，硬件 AEC |
| NAT 穿透     | 需要 Cloudflare 隧道 | WebRTC STUN/TURN          |
| Gateway 连接 | 需要手动输 URL       | Bonjour 自动发现          |
| 唤醒词       | 无                   | VoiceWakeManager 已有     |
| 推送通知     | 无                   | 可接收 OpenClaw 提醒      |

---

## iOS App 改动范围

### 新增

| 文件                                    | 说明                                                 |
| --------------------------------------- | ---------------------------------------------------- |
| `Sources/Voice/GeminiLiveManager.swift` | Gemini Live 实时语音管理器（WebRTC + 音频采集/播放） |
| `Sources/Voice/GeminiLiveTab.swift`     | UI：Her 实时语音界面                                 |

### 复用（不修改）

| 组件                          | 复用方式                              |
| ----------------------------- | ------------------------------------- |
| `GatewayConnectionController` | 已有 WebSocket 连接 → realtime 插件   |
| `AVAudioSession` 配置         | TalkModeManager 已配好 .playAndRecord |
| `VoiceWakeManager`            | 唤醒后切换到 Gemini Live 模式         |
| `NodeAppModel`                | App 生命周期管理                      |

### 不修改

| 组件                              | 原因                                             |
| --------------------------------- | ------------------------------------------------ |
| server.py                         | WebRTC Bridge 作为 WS 客户端接入，和浏览器无区别 |
| extensions/realtime/src/server.ts | realtime 插件不关心音频来源                      |
| OpenClaw Gateway / 核心代码       | 完全不涉及                                       |
| 桌面端 (script.js, index.html)    | 不变                                             |
| 飞书 / Telegram 通道              | 不变                                             |
| TalkModeManager                   | 保留原有 Talk Mode，与 Gemini Live 模式并存      |

---

## 新增服务端组件：WebRTC Bridge

位置：`extensions/realtime/live-frontend/webrtc-bridge.py`

职责：

1. 接受 iOS App 的 WebRTC peer connection
2. 将 WebRTC 音频流（Opus/PCM）转为 Gemini 需要的格式
3. 通过已有的 WebSocket 协议连接 server.py → Gemini
4. 将 Gemini 返回的音频通过 WebRTC 推回 iOS App

```
iOS App ←─ WebRTC (UDP) ─→ Bridge ←─ WebSocket (localhost TCP) ─→ server.py ─→ Gemini
```

Bridge 到 server.py 走本地回环，零延迟。关键的手机到 Bridge 这一跳走 UDP。

---

## NAT 穿透

WebRTC ICE 框架自动处理：

1. **同 WiFi**：STUN 发现本地 IP，直连（<5ms）
2. **跨网络**：STUN 打洞（~50ms）
3. **打洞失败**：TURN 中继（~100ms，仍 UDP）

免费 STUN：`stun:stun.l.google.com:19302`

**去掉 Cloudflare 隧道，不再需要 3 个隧道进程。**

---

## 对现有功能的影响

零。所有改动限制在：

- iOS App 新增文件（`GeminiLiveManager.swift`, `GeminiLiveTab.swift`）
- 新增 `webrtc-bridge.py`
- `start-mobile.sh` 改为启动 Bridge（替代 Cloudflare 隧道）

---

## 实现步骤

| 阶段 | 任务                                                         | 工作量 |
| ---- | ------------------------------------------------------------ | ------ |
| 1    | WebRTC Bridge 原型（Python/aiortc）                          | 1-2 天 |
| 2    | iOS App: GeminiLiveManager（WebRTC 音频 + realtime 插件 WS） | 2-3 天 |
| 3    | iOS App: GeminiLiveTab UI                                    | 1 天   |
| 4    | 信令交换（通过 Gateway WebSocket）                           | 半天   |
| 5    | 端到端测试 + 性能对比                                        | 半天   |
| 6    | start-mobile.sh 适配                                         | 半天   |

**总计约 5-7 天。**
