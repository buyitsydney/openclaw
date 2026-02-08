# Car Her MVP Demo 方案

> 环境：安卓域控，与域控厂商合作

## 零、环境要求与验证

### Android 版本 vs WebView 版本

这是两个独立的版本号：

- **Android 版本**：操作系统版本（如 Android 10、12、14）
- **WebView 版本**：内置浏览器引擎版本，基于 Chromium（如 WebView 90 = Chromium 90）

Android 7.0 之后 WebView 可独立更新，版本号与 Android 版本无关。但车机域控通常没有 Google Play，WebView 版本取决于厂商出厂刷入的版本。

### 最低要求

| 项目 | 最低要求 | 推荐 | 原因 |
|------|---------|------|------|
| Android OS | 7.0 (API 24) | 10+ (API 29) | 7.0 起 WebView 可独立更新；10+ 音频 HAL 更好 |
| WebView / Chromium | **66** | **80+** | 66 = AudioWorklet 引入版本；80+ JS 语法兼容性更好 |

### 我们用到的 Web API 与最低 Chromium 版本

| Web API | 用途 | 最低 Chromium 版本 |
|---------|------|-------------------|
| WebSocket | 连接 Gemini Proxy 和 OpenClaw | 全版本支持 |
| getUserMedia | 麦克风采集 | 53+ |
| AudioContext | 音频处理 | 35+ |
| **AudioWorklet** | **音频采集和播放核心** | **66+（硬性要求）** |
| ES2020+ 语法 | optional chaining 等 | 80+ |

**瓶颈是 AudioWorklet（Chromium 66+）。** 其余 API 要求更低。

### 如何让厂商确认

#### 方式一：查系统设置（最快）

请厂商在域控设备上提供：
1. **Android 版本**：设置 → 关于 → Android 版本号
2. **WebView 版本**：设置 → 应用 → Android System WebView（或 Chrome）→ 版本号

如果找不到 "Android System WebView"，说明 Chrome 充当了 WebView 引擎，查 Chrome 版本即可。

#### 方式二：代码查询

```kotlin
// Android API 26+
val pkg = WebView.getCurrentWebViewPackage()
Log.d("CarHer", "WebView: ${pkg?.packageName} v${pkg?.versionName}")
```

#### 方式三：自检页面（最靠谱）

我们提供了 `car-check.html` 自检页面，厂商在域控设备浏览器中打开即可看到完整检测结果：

```
extensions/realtime/live-frontend/frontend/car-check.html
```

检测内容：
- Android 版本（从 UserAgent 解析）
- Chromium 内核版本
- WebSocket / getUserMedia / AudioContext / AudioWorklet / ES2020+ 支持情况
- 麦克风实际采集测试（点击按钮授权后自动测试）
- 完整 User-Agent 字符串

**使用方法**：运行 `start-remote.sh` 后，脚本会自动输出环境检测页面 URL。厂商在域控设备浏览器中打开即可。全部显示绿色 = 可以运行 Car Her。

### 厂商一站式验证流程

运行 `start-remote.sh` 后，脚本输出三个 URL。厂商只需要一台域控设备 + 浏览器：

```
步骤 1: 打开「环境检测页面」URL（car-check.html）
        → 自动检测 Android 版本、Chromium 内核、所有 Web API
        → 点击「测试麦克风」按钮验证音频采集
        → 全部绿色 = 设备兼容

步骤 2: 打开「手机/车机版」URL（mobile.html）
        → 点击底部「调试」按钮，查看环境检测结果（已内嵌）
        → 确认所有项目通过

步骤 3: 点击「开始」按钮
        → 测试语音对话全流程
        → 说话 → Gemini 回复 → 验证端到端通路
```

**两个检测入口的区别：**

| | car-check.html（独立页面） | mobile.html 调试 tab |
|---|---|---|
| 需要后端服务 | 不需要 | 需要（连接 Gemini/OpenClaw） |
| 适用场景 | 设备初筛、厂商自助验证 | 集成验证、全流程测试 |
| 麦克风实测 | 有（点击按钮） | 有（点击"开始"后自动） |
| JS Bridge 检测 | 有 | 有 |

---

## 一、现有资产

当前已有一套**可工作的手机 demo**，前端是纯 Web 应用：

```
extensions/realtime/live-frontend/frontend/
├── mobile.html            — UI（HTML + CSS）
├── mobile-script.js       — 主逻辑（连接管理、消息处理、UI 状态）
├── geminilive.js          — Gemini Live API 客户端（WebSocket 协议封装）
├── mediaUtils.js          — 媒体工具（麦克风采集、音频播放、jitter buffer）
├── tools.js               — OpenClaw 工具定义 + WebSocket 连接管理
├── inject-delivery.js     — OpenClaw 结果注入 Gemini 的投递逻辑
├── remote-setup.js        — 远程访问 URL 参数自动配置
└── audio-processors/
    ├── capture.worklet.js  — 麦克风采集 AudioWorklet
    └── playback.worklet.js — 音频播放 AudioWorklet
```

数据流：

```
用户说话
  │
  ↓ navigator.mediaDevices.getUserMedia()
麦克风 (16kHz PCM16)
  │
  ↓ AudioWorklet → Float32 → PCM16 → Base64
WebSocket → Gemini Proxy (:8080) → Google Gemini Live API
  │
  │  Gemini 返回音频 + 文本 + tool calls
  ↓
mobile-script.js handleMessage()
  ├── AUDIO → AudioPlayer (24kHz PCM16) → 扬声器
  ├── INPUT/OUTPUT_TRANSCRIPTION → UI 显示 + 发送到 OpenClaw
  ├── TOOL_CALL (openclaw_help) → OpenClaw WS (:18790)
  │     → realtime server → agent 处理 → 返回结果
  │     → inject-delivery.js → 注入回 Gemini → 语音播报
  └── TURN_COMPLETE → 触发 inject 投递
```

**关键事实：前端只依赖标准 Web API（WebSocket、getUserMedia、AudioWorklet），WebView 90+ 全部支持。**

---

## 二、MVP 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                       域控 (Android + WebView 90+)                   │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     WebView (mobile.html)                     │  │
│  │                                                               │  │
│  │  ┌─ AudioStreamer ──┐  ┌─ AudioPlayer ──┐  ┌─ tools.js ──┐  │  │
│  │  │ getUserMedia()   │  │ AudioWorklet   │  │ OpenClaw WS │  │  │
│  │  │ 16kHz PCM16      │  │ 24kHz PCM16    │  │ :18790      │  │  │
│  │  └────────┬─────────┘  └───────┬────────┘  └──────┬──────┘  │  │
│  │           │                    │                    │         │  │
│  │           ↓                    ↑                    │         │  │
│  │  ┌─ geminilive.js ────────────────────────────┐    │         │  │
│  │  │ WebSocket → Gemini Proxy → Gemini Live API │    │         │  │
│  │  └────────────────────────────────────────────┘    │         │  │
│  │                                                     │         │  │
│  │  ┌─ car-control.js（新增）──────────────────────┐  │         │  │
│  │  │ Gemini tool: car_control                      │  │         │  │
│  │  │  → 调用 Android.carControl(action, params)    │  │         │  │
│  │  └──────────────────────────────┬────────────────┘  │         │  │
│  └─────────────────────────────────┼───────────────────┘         │  │
│                                    │ JS Bridge                    │  │
│  ┌─────────────────────────────────↓───────────────────────────┐  │
│  │              Android Native Layer (Java/Kotlin)              │  │
│  │                                                              │  │
│  │  ┌─ CarBridge.kt ──────────────────────────────────────┐    │  │
│  │  │ @JavascriptInterface                                 │    │  │
│  │  │ fun carControl(action, paramsJson) → JSON result     │    │  │
│  │  └──────────────┬───────────────────────────────────────┘    │  │
│  │                 │                                             │  │
│  │  ┌──────────────↓───────────────────────────────────────┐    │  │
│  │  │ 厂商车控 SDK → CAN 总线 → 空调 / 座椅 / 车窗 ECU    │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  麦克风 → Android Audio HAL → getUserMedia() → WebView              │
│  WebView AudioPlayer → Android Audio HAL → 车载扬声器               │
└─────────────────────────────────────────────────────────────────────┘
          │                              │
          │ WebSocket (公网/Tailscale)    │ WebSocket
          ↓                              ↓
┌─────────────────────┐    ┌──────────────────────┐
│ Gemini Proxy (:8080)│    │ OpenClaw Gateway     │
│ (认证+转发)          │    │ + Realtime (:18790)  │
│ (云端/家庭服务器)     │    │ (云端/家庭服务器)     │
└─────────────────────┘    └──────────────────────┘
```

三条连接线：

| 连接 | 协议 | 起点 | 终点 | 作用 |
|------|------|------|------|------|
| 1 | WebSocket | WebView | Gemini Proxy | 音频双向流 + tool calls |
| 2 | WebSocket | WebView | OpenClaw Realtime | help 请求/结果 + transcript 同步 |
| 3 | JS Bridge | WebView JS | Android Native | 车端硬件控制（同步调用，纯本地） |

---

## 三、分工

### 我方提供

| 交付物 | 说明 |
|--------|------|
| 前端文件包 | `mobile.html` + 所有 JS 文件（含新增的 `car-control.js`） |
| 壳 App 模板代码 | `CarHerActivity.kt` + `CarBridge.kt` 空壳（可直接编译运行） |
| JS Bridge 接口文档 | `Android.carControl(action, paramsJson)` 的完整协议定义 |
| 后端服务 | Gemini Proxy + OpenClaw Gateway（云端部署或隧道访问） |

### 厂商负责

| 任务 | 说明 |
|------|------|
| 构建 Android App | 基于我方模板，创建 WebView 壳 App |
| 对接车控 SDK | 在 `CarBridge.kt` 中接入真实的车辆控制 API |
| 音频路由 | 确保车载麦克风 → WebView、WebView → 车载扬声器正常工作 |
| 系统权限 | 白名单麦克风/网络权限，确保 App 开机自启 |
| 提供测试环境 | 域控开发板或实车 |

---

## 四、逐步推演

### Step 0：零代码验证（30 分钟）

**目标：确认域控设备能跑 mobile.html。**

操作：
1. Mac 上启动后端服务 + Cloudflare 隧道（和现有手机 demo 一样）
2. 域控设备连 WiFi 或 4G
3. 打开域控设备上的 **Chrome 浏览器**（不是壳 App，先用 Chrome 验证）
4. 输入 URL：`https://frontend-tunnel/mobile.html?proxy=wss://proxy-tunnel&openclaw=wss://openclaw-tunnel`
5. 点"开始" → 说话 → 看 Gemini 是否回复

验证清单：

| 项目 | 预期 | 如果失败 |
|------|------|---------|
| 麦克风权限弹窗 | 弹出并授权 | 检查域控 Android 权限设置 |
| getUserMedia | 成功获取音频流 | 打开 debug overlay 看错误日志 |
| WebSocket 到 Gemini Proxy | 连接成功 | 检查网络/DNS/防火墙 |
| WebSocket 到 OpenClaw | 连接成功 | 同上 |
| 语音输入 → Gemini 回复 | 听到语音回复 | 检查 debug overlay 中的 Gemini 连接状态 |
| AudioWorklet 播放 | 声音从扬声器出来 | 检查音频输出设备路由 |

**Chrome 验证通过 = demo 完成 80%。** 剩余工作是壳 App + 车控。

---

### Step 1：WebView 壳 App（半天）

**为什么需要壳 App？**
- Chrome 有地址栏，不专业
- Chrome 无法注入 JS Bridge（车控需要）
- Chrome 麦克风每次要手动授权
- 量产时也是壳 App 形态

**厂商创建 Android 项目，核心代码：**

```kotlin
// CarHerActivity.kt
class CarHerActivity : Activity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 全屏沉浸模式
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false  // 允许自动播放音频
            settings.domStorageEnabled = true
            settings.allowFileAccess = true

            // 自动授予麦克风权限（不弹窗）
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread { request.grant(request.resources) }
                }
            }

            // 注入 JS Bridge
            addJavascriptInterface(CarBridge(this@CarHerActivity), "Android")
        }

        // 方案 A: 远程加载（开发阶段，改 JS 不用重编译 App）
        val proxy = "wss://proxy-tunnel-url"
        val openclaw = "wss://openclaw-tunnel-url"
        webView.loadUrl("https://frontend-tunnel/mobile.html?proxy=$proxy&openclaw=$openclaw")

        // 方案 B: 本地 assets 加载（离线可用，发布用）
        // webView.loadUrl("file:///android_asset/frontend/mobile.html")

        setContentView(webView)
    }
}
```

```kotlin
// CarBridge.kt（空壳，Step 3 填充真实实现）
class CarBridge(private val context: Context) {
    @JavascriptInterface
    fun carControl(action: String, paramsJson: String): String {
        Log.d("CarHer", "carControl: action=$action, params=$paramsJson")
        // 暂时返回模拟成功，Step 3 接真实 SDK
        return """{"ok": true, "message": "收到指令：$action"}"""
    }
}
```

```xml
<!-- AndroidManifest.xml 权限 -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

**验证：** 装上壳 App → 全屏启动 → 语音对话正常 → 和 Chrome 体验一致但更干净。

---

### Step 2：前端加车控 Tool（半天）— 已完成 ✅

**已实现并验证通过。** 改动内容：
- `car-control.js`：CarControlTool 类 + 非车载环境模拟响应
- `mobile.html`：引入 car-control.js
- `mobile-script.js`：注册 tool + 更新 SYSTEM_PROMPT + tool call 统一 UI 显示 + tool response 回传修复
- `car-check.html`：独立环境检测页面
- `start-remote.sh`：自动打开本地调试页面 + 输出环境检测 URL

验证结果（Mac 本地 + 手机远程）：
- Gemini 正确识别车控指令并调用 `car_control` tool（UI 显示 `[Tool: car_control] {...}`）
- 模拟响应正确返回并回传给 Gemini（`sendToolResponse`）
- Gemini 收到 tool response 后语音播报确认结果
- 快思考/慢思考分流正确：车控走 `car_control`，查询走 `openclaw_help`

#### 2a. 新建 `car-control.js`

```javascript
/**
 * Car Control Tool — Gemini 调用此工具控制车辆
 * 通过 JS Bridge 调用 Android 原生层
 */
class CarControlTool extends FunctionCallDefinition {
  constructor() {
    super(
      "car_control",
      "控制车辆功能。用户说'开空调'、'调到25度'、'打开座椅加热'等车控指令时调用。",
      {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型: set_ac_temperature | set_ac_power | set_ac_mode | set_seat_heat | set_window"
          },
          params: {
            type: "object",
            description: "操作参数"
          }
        }
      },
      ["action"]
    );
  }

  functionToCall(parameters) {
    const { action, params } = parameters;
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] CAR_CONTROL | action=${action} | params=${JSON.stringify(params)}`);

    // 通过 JS Bridge 调用 Android 原生层
    if (typeof Android !== "undefined" && Android.carControl) {
      const resultJson = Android.carControl(action, JSON.stringify(params || {}));
      return JSON.parse(resultJson);
    }

    // 非车载环境（电脑浏览器调试用）— 模拟成功
    console.warn("非车载环境，模拟车控响应");
    return { ok: true, message: `[模拟] ${action} 已执行`, simulated: true };
  }
}
```

#### 2b. `mobile.html` 加 script 引用

在 `<script src="tools.js"></script>` 后面加：

```html
<script src="car-control.js"></script>
```

#### 2c. `mobile-script.js` 注册 tool

在 `connectGemini()` 中，`state.client.addFunction(openclawTool)` 之后加：

```javascript
// 注册车控 tool
const carTool = new CarControlTool();
state.client.addFunction(carTool);
```

#### 2d. `SYSTEM_PROMPT` 加车控说明

在 system prompt 的能力边界部分加入：

```
## 车辆控制（你可以直接执行）
你可以通过 car_control 工具直接控制车辆：
- 空调：温度、开关、模式（制冷/制热/自动）
- 座椅加热：等级 0-3
- 车窗：开关

用户说车控相关指令时，直接调用 car_control，不需要调用 openclaw_help。
执行后用语音简洁确认结果。
```

**验证：** 在电脑浏览器打开 mobile.html → 说"空调调到 25 度" → 控制台看到 `CAR_CONTROL | action=set_ac_temperature` + `[模拟]` 响应 → Gemini 语音播报确认。

---

### Step 2.5：部署基础设施 + 厂商文档（半天）— 已完成 ✅

**已实现并验证通过。** 改动内容：

**Cloudflare 命名隧道（固定 URL，重启不变）：**
- 购买域名 `carher.net`，Cloudflare 直接托管
- 创建命名隧道 `carher`，配置三个子域名：
  - `carher.carher.net` → 前端页面（localhost:8000）
  - `proxy.carher.net` → Gemini Proxy（localhost:8080）
  - `api.carher.net` → OpenClaw Realtime（localhost:18790）
- 配置文件：`~/.cloudflared/config.yml`

**start-remote.sh 更新：**
- 默认使用命名隧道（`cloudflared tunnel run carher`），URL 固定
- 加 `--random` 回退到随机隧道模式（自用测试，厂商无法访问）
- 自动打开本地调试页面

**前端自动版本管理：**
- server.py 实时计算所有前端文件的内容 hash 作为版本号
- HTML 中的 script 标签自动注入 `?v=<hash>`（cache busting）
- `/version` 端点返回当前版本 hash
- debug overlay 显示版本号
- 改任何前端文件，刷新页面即可看到新版本，无需重启 server

**厂商文档（`car-her-vendor-guide.md`）：**
- 环境验证移到开发前（前置工作）
- 前端交付改为远程 URL 加载（厂商 App 硬编码固定 URL）
- 我方更新前端代码 → 厂商 App 下次打开自动生效
- 删除错误的"1秒超时"要求

---

### Step 3：厂商对接真实车控 SDK（半天~1天）

**厂商将 `CarBridge.kt` 空壳换成真实调用：**

```kotlin
class CarBridge(private val context: Context) {
    private val carService = CarServiceManager.getInstance(context)  // 厂商 SDK

    @JavascriptInterface
    fun carControl(action: String, paramsJson: String): String {
        val params = JSONObject(paramsJson)
        return when (action) {
            "set_ac_temperature" -> {
                val temp = params.optInt("temperature", 24)
                carService.setACTemperature(temp)
                """{"ok": true, "message": "空调已设置为${temp}度"}"""
            }
            "set_ac_power" -> {
                val on = params.optBoolean("on", true)
                carService.setACPower(on)
                """{"ok": true, "message": "空调已${if (on) "打开" else "关闭"}"}"""
            }
            "set_ac_mode" -> {
                val mode = params.optString("mode", "auto")
                carService.setACMode(mode)  // cool | heat | auto
                """{"ok": true, "message": "空调模式已切换为${mode}"}"""
            }
            "set_seat_heat" -> {
                val seat = params.optString("seat", "driver")
                val level = params.optInt("level", 1)
                carService.setSeatHeat(seat, level)
                """{"ok": true, "message": "${seat}座椅加热已设为${level}档"}"""
            }
            else -> """{"ok": false, "error": "未知操作: $action"}"""
        }
    }
}
```

**验证：** 语音说"空调调到 25 度" → 空调真实响应 → 体感出风。

---

## 五、JS Bridge 接口文档（给厂商）

### 调用方式

WebView JS 侧调用：

```javascript
const resultJson = Android.carControl(action, paramsJson);
const result = JSON.parse(resultJson);
// result.ok === true → 成功
// result.ok === false → result.error 包含错误信息
```

### action 定义

| action | params | 说明 | 返回示例 |
|--------|--------|------|---------|
| `set_ac_temperature` | `{"temperature": 25}` | 设置空调温度（16-32°C） | `{"ok":true,"message":"空调已设置为25度"}` |
| `set_ac_power` | `{"on": true}` | 开/关空调 | `{"ok":true,"message":"空调已打开"}` |
| `set_ac_mode` | `{"mode": "cool"}` | 空调模式：`cool` / `heat` / `auto` | `{"ok":true,"message":"空调模式已切换为cool"}` |
| `set_seat_heat` | `{"seat":"driver","level":2}` | 座椅加热，level 0-3（0=关） | `{"ok":true,"message":"driver座椅加热已设为2档"}` |
| `set_window` | `{"position":"driver","open":true}` | 车窗开/关 | `{"ok":true,"message":"driver车窗已打开"}` |

### 返回格式

成功：

```json
{"ok": true, "message": "空调已设置为25度"}
```

失败：

```json
{"ok": false, "error": "温度超出范围"}
```

### 注意事项

- `carControl` 是**同步调用**，需要在调用线程返回结果
- 如果厂商 SDK 是异步的，需要在 `carControl` 内部做阻塞等待
- 返回值必须是合法 JSON 字符串
- 超时建议：车控操作应在 1 秒内返回，否则 Gemini 可能超时重试

---

## 六、时间线

```
Day 1 上午
  │
  ├── Step 0: Chrome 浏览器验证（30 min）
  │     → 确认域控 WebView 能跑 mobile.html
  │
  ├── Step 1: 厂商写壳 App（3-4 小时）
  │     我方交付：模板代码 + 前端文件包
  │     厂商交付：可运行的 WebView 壳 App
  │
Day 1 下午
  │
  ├── Step 2: 我方改前端 JS（2-3 小时）
  │     新建 car-control.js
  │     改 mobile.html、mobile-script.js、SYSTEM_PROMPT
  │     本地浏览器验证（模拟模式）
  │
Day 2 上午
  │
  ├── Step 3: 厂商对接车控 SDK（3-4 小时）
  │     CarBridge.kt 接真实 API
  │     我方协助调试 JS Bridge 通信
  │
Day 2 下午
  │
  └── 联调 + 演示
        "空调调到25度" → 空调真实响应 ✓
```

**总计：约 2 天。**

---

## 七、端到端交互推演

一次完整的用户交互：

```
1. 用户坐在车里，对着中控屏说："有点热，帮我开一下空调"

2. 域控麦克风 → Android Audio HAL → WebView getUserMedia()
   → AudioWorklet 采集 16kHz PCM → Base64
   → WebSocket → Gemini Proxy (云端)

3. Gemini Proxy → Google Gemini Live API（认证 + 转发）

4. Gemini 理解语义 → 调用 car_control tool
   → tool_call: { action: "set_ac_power", params: { on: true } }

5. mobile-script.js 收到 tool_call
   → CarControlTool.functionToCall()
   → Android.carControl("set_ac_power", '{"on":true}')

6. JS Bridge → Android CarBridge → 厂商 SDK → CAN → 空调 ECU
   → 空调启动出风
   → 返回 {"ok": true, "message": "空调已打开"}

7. tool 结果返回 Gemini → 生成语音: "好的，空调帮你打开了"
   → 音频流回 WebView → AudioWorklet → 车载扬声器

8. 用户听到回复，感受到空调出风 ✓

延迟：~1-2 秒（语音识别 + Gemini 推理 + 语音合成）
车控执行：< 100ms（纯本地 JS Bridge 调用）
```

---

## 八、风险和应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 域控 WebView 麦克风权限被系统拦截 | 中 | 无法录音 | 厂商在系统层白名单 App 的音频权限 |
| 车内噪音导致语音识别差 | 中 | 体验不佳 | Gemini 内置降噪；车载麦克风阵列比手机更好 |
| 4G 延迟导致语音卡顿 | 中 | 播放断续 | jitter buffer 已有（debug overlay 可调） |
| 厂商 SDK 异步返回 | 低 | JS Bridge 超时 | CarBridge 内部做 blocking wait |
| WebView AudioContext 采样率不支持 24kHz | 低 | 播放失败 | AudioContext 会自动 resample，Step 0 验证 |

---

## 九、从 Demo 到量产

此 Demo 架构和量产架构的关系：

```
                 Demo                          量产
前端代码     mobile.html + JS（完全相同）   mobile.html + JS（完全相同）
运行容器     Android WebView 壳 App         车载浏览器内核 / WebView
车控桥接     JS Bridge → 厂商 SDK          JS Bridge → Vehicle HAL / CAN
后端服务     Mac + Cloudflare 隧道          云端部署（Gemini Proxy + OpenClaw）
网络         WiFi / 4G                      车载 T-Box 4G/5G
麦克风       域控内置 / USB 麦克风           车载麦克风阵列 + 降噪 DSP
扬声器       域控内置 / 3.5mm 输出          车载功放 + 多声道扬声器
```

**核心价值：前端代码在 Demo 和量产之间零修改。** 变化的只是运行环境和车控桥接层的底层实现。

### Demo 不覆盖的量产需求（P2）

- 车规级可靠性（掉电恢复、无网降级）
- 多音区（主驾/副驾独立对话）
- 与车机系统深度集成（仪表盘 UI、方向盘按键唤醒）
- 离线语音识别
