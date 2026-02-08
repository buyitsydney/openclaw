# Car Her 车载 AI 助手 — 域控厂商对接指南

## 一、项目简介

Car Her 是一个车载 AI 语音助手。用户通过车载麦克风说话，AI 实时理解语义并执行操作（如控制空调），然后通过车载扬声器语音回复。

AI 助手的界面是一个 **Web 页面**（HTML + JS），由我方托管在固定 URL 上，运行在 Android WebView 中。AI 推理在云端完成，车端只需要：

1. 一个 Android App，内嵌 WebView 加载我方提供的固定 URL
2. 通过 JS Bridge 暴露车辆控制接口给 WebView

```
┌──────────────── 域控设备 ────────────────┐
│                                           │
│   WebView (加载我方固定 URL)              │
│     │                                     │
│     │  AI 判断需要控制空调                 │
│     │  → JS 调用 Android.carControl(...)  │
│     │                                     │
│     ↓  JS Bridge（Android 标准机制）       │
│                                           │
│   CarBridge.kt（厂商实现）                │
│     │                                     │
│     ↓  厂商车控 SDK                       │
│                                           │
│   CAN 总线 → 空调 ECU → 出风             │
└───────────────────────────────────────────┘
         │
         │ WebSocket（4G/WiFi）
         ↓
   云端 AI 服务（我方托管）
```

**关键设计**：前端页面由我方通过固定 URL 托管，厂商 App 只需加载该 URL。我方更新前端代码后，厂商 App 下次启动自动获取最新版本，无需重编译 App。

---

## 二、前置验证（开发前必做）

开始开发之前，必须先验证域控硬件环境是否满足要求。

### 2.1 硬件要求

| 项目 | 最低要求 | 推荐 |
|------|---------|------|
| Android OS | 7.0 (API 24) | 10+ |
| WebView / Chromium | 66+ | 80+ |
| 网络 | 4G / WiFi（需访问境外服务） | — |
| 麦克风 | 系统可识别的音频输入设备 | — |
| 扬声器 | 系统可识别的音频输出设备 | — |

### 2.2 验证步骤

**第一步：浏览器全链路验证**

在域控设备的 Chrome 浏览器中直接打开以下地址：

```
https://carher.carher.net/car-check.html
```

这是我方提供的环境检测页面，会自动检测：
- Android 版本
- Chromium 内核版本
- WebSocket / getUserMedia / AudioContext / AudioWorklet 支持情况
- 麦克风采集测试

**全部显示绿色 = 硬件环境满足要求**。JS Bridge 项显示灰色是正常的（浏览器中无此接口，壳 App 中才有）。

也可以手动查看 WebView 版本：设置 → 应用 → Android System WebView（或 Chrome）→ 版本号。

**第二步：浏览器直接测试语音对话**

环境检测通过后，在域控 Chrome 浏览器中打开：

```
https://carher.carher.net/mobile.html?proxy=wss%3A%2F%2Fproxy.carher.net&openclaw=wss%3A%2F%2Fapi.carher.net%2Fws
```

点击"开始"按钮，授权麦克风后，直接对话测试。如果语音对话正常工作，说明网络、音频、WebSocket 全链路通过。

**验证结论**：
- 两步全部通过 → 可以开始开发壳 App
- 环境检测有红色项 → 硬件不满足要求，需升级 WebView 或系统版本
- 环境检测通过但语音对话失败 → 可能是网络问题（需能访问境外服务），联系我方排查

---

## 三、厂商开发任务

共两件事：**做一个 WebView 壳 App** + **实现车控 Bridge**。

### 任务 1：WebView 壳 App

创建一个 Android App，核心只有一个 Activity，用 WebView 全屏加载我方提供的固定 URL。

**要求：**
- WebView 基于 Chromium 66+（建议 80+，用于支持 AudioWorklet 和现代 JS 语法）
- 允许 JavaScript 执行
- 允许 WebView 自动播放音频（不需要用户手势触发）
- 自动授予麦克风权限（不弹窗）
- 注入 JS Bridge 对象（任务 2）

**参考代码（Kotlin）：**

```kotlin
class CarHerActivity : Activity() {
    private lateinit var webView: WebView

    // 我方提供的固定 URL（不会变化，我方更新前端代码后自动生效）
    private val CAR_HER_URL = "https://carher.carher.net/mobile.html" +
        "?proxy=wss%3A%2F%2Fproxy.carher.net" +
        "&openclaw=wss%3A%2F%2Fapi.carher.net%2Fws"

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
            settings.mediaPlaybackRequiresUserGesture = false
            settings.domStorageEnabled = true

            // 自动授予麦克风权限
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread { request.grant(request.resources) }
                }
            }

            // 注入 JS Bridge（见任务 2）
            addJavascriptInterface(CarBridge(this@CarHerActivity), "Android")
        }

        // 加载我方固定 URL
        webView.loadUrl(CAR_HER_URL)

        setContentView(webView)
    }
}
```

**AndroidManifest.xml 权限：**

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

**验证标准：** App 启动后全屏显示 AI 助手界面，点击"开始"后可以语音对话。

---

### 任务 2：实现车控 Bridge

在 App 中创建一个 `CarBridge` 类，通过 `@JavascriptInterface` 注解暴露方法给 WebView。

**原理说明：**

```
Android 标准 API:
  webView.addJavascriptInterface(对象实例, "全局变量名")

效果:
  WebView 中的 JS 代码可以调用 window.全局变量名.方法名()
  调用会自动转发到 Android 原生层的对应方法
```

我方前端代码会调用 `Android.carControl(action, paramsJson)`，厂商需要实现这个方法。

**参考代码（Kotlin）：**

```kotlin
class CarBridge(private val context: Context) {

    /**
     * 车辆控制入口 — 由 WebView JS 调用
     *
     * @param action     操作类型（见下方 action 列表）
     * @param paramsJson 操作参数，JSON 字符串
     * @return           结果 JSON 字符串
     */
    @JavascriptInterface
    fun carControl(action: String, paramsJson: String): String {
        val params = JSONObject(paramsJson)

        return when (action) {
            "set_ac_temperature" -> {
                val temp = params.optInt("temperature", 24)
                // TODO: 调用厂商车控 SDK 设置空调温度
                // 例如: CarService.getInstance().setACTemperature(temp)
                """{"ok": true, "message": "空调已设置为${temp}度"}"""
            }

            "set_ac_power" -> {
                val on = params.optBoolean("on", true)
                // TODO: 调用厂商车控 SDK 开关空调
                """{"ok": true, "message": "空调已${if (on) "打开" else "关闭"}"}"""
            }

            "set_ac_mode" -> {
                val mode = params.optString("mode", "auto")
                // TODO: 调用厂商车控 SDK 设置空调模式
                // mode 值: "cool"(制冷) / "heat"(制热) / "auto"(自动)
                """{"ok": true, "message": "空调模式已切换为${mode}"}"""
            }

            "set_seat_heat" -> {
                val seat = params.optString("seat", "driver")
                val level = params.optInt("level", 1)
                // TODO: 调用厂商车控 SDK 设置座椅加热
                // seat: "driver"(主驾) / "passenger"(副驾)
                // level: 0(关) / 1 / 2 / 3
                """{"ok": true, "message": "${seat}座椅加热已设为${level}档"}"""
            }

            "set_window" -> {
                val position = params.optString("position", "driver")
                val open = params.optBoolean("open", true)
                // TODO: 调用厂商车控 SDK 控制车窗
                """{"ok": true, "message": "${position}车窗已${if (open) "打开" else "关闭"}"}"""
            }

            else -> """{"ok": false, "error": "未知操作: $action"}"""
        }
    }
}
```

每个 `TODO` 处替换为厂商自己的车控 SDK 调用即可。

---

## 四、接口协议

### 调用方式

我方前端 JS 调用：

```
Android.carControl(action, paramsJson)  →  返回 resultJson
```

- `action`：String，操作类型
- `paramsJson`：String，JSON 格式的参数
- 返回值：String，JSON 格式的结果

### action 列表

| action | paramsJson 示例 | 说明 |
|--------|----------------|------|
| `set_ac_temperature` | `{"temperature": 25}` | 设置空调温度（16-32°C） |
| `set_ac_power` | `{"on": true}` | 开/关空调 |
| `set_ac_mode` | `{"mode": "cool"}` | 空调模式：cool / heat / auto |
| `set_seat_heat` | `{"seat": "driver", "level": 2}` | 座椅加热，level 0-3（0=关） |
| `set_window` | `{"position": "driver", "open": true}` | 车窗开/关 |

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

- `carControl` 是**同步调用**，必须在调用线程直接返回结果
- 如果厂商 SDK 是异步的，需要在 `carControl` 内部做阻塞等待
- 返回值必须是合法 JSON 字符串
- 无协议层超时限制，但建议尽快返回（用户在等待语音回复，体感上越快越好）

---

## 五、联调步骤

```
Step 1：前置验证（第二章）
  在域控 Chrome 浏览器打开环境检测 + 语音对话页面
  → 确认硬件环境满足要求，语音全链路通过

Step 2：壳 App 基础验证
  厂商完成 WebView 壳 App（CarBridge 先返回模拟数据）
  → 安装到域控 → 打开 → 语音对话正常

Step 3：车控联调
  厂商在 CarBridge 中接入真实车控 SDK
  → 语音说"帮我打开空调" → 空调真实启动
  → 语音说"调到25度" → 温度变为25度

Step 4：演示
  全流程端到端演示
```

---

## 六、交互流程图

一次完整的用户交互：

```
用户说话: "帮我把空调调到25度"
    │
    ↓  域控麦克风 → WebView 采集音频
    │
    ↓  WebSocket 发送到云端 AI
    │
    ↓  AI 理解语义，决定调用 car_control
    │
    ↓  WebView JS 收到指令
    │
    ↓  调用 Android.carControl("set_ac_temperature", '{"temperature":25}')
    │
    ↓  CarBridge.carControl() 执行 → 厂商 SDK → CAN 总线 → 空调
    │
    ↓  返回 {"ok": true, "message": "空调已设置为25度"}
    │
    ↓  结果回传给云端 AI
    │
    ↓  AI 生成语音回复: "好的，空调已经调到25度了"
    │
    ↓  音频流回 WebView → 车载扬声器播放
    │
用户听到回复，感受到空调变化
```

---

## 七、前端交付方式

| 项目 | 说明 |
|------|------|
| 前端页面 | 由我方通过固定 URL 托管，厂商 App 加载该 URL 即可 |
| 环境检测页面 | `https://carher.carher.net/car-check.html` |
| 语音对话页面 | `https://carher.carher.net/mobile.html?proxy=...&openclaw=...`（完整 URL 见第二章） |
| 云端 AI 服务 | 我方部署和维护，厂商无需关心 |

**重要说明：**
- 前端页面 URL 是固定的，不会变化
- 我方更新前端代码后，厂商 App 下次启动自动加载最新版本，无需重编译
- 我方重启后端服务对厂商 App 零影响（URL 不变）
- 厂商只需关注壳 App + CarBridge 实现，不需要了解前端 JS 细节

## 八、联系方式

技术对接过程中如有问题，请随时联系我方技术团队。
