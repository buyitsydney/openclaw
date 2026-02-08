/**
 * CarHer Mobile — minimal script for the mobile UI.
 *
 * Reuses shared libraries: geminilive.js, mediaUtils.js, tools.js, inject-delivery.js.
 * Does NOT touch index.html or script.js.
 */

// ---------------------------------------------------------------------------
// Default config (hardcoded; desktop version exposes these as input fields)
// ---------------------------------------------------------------------------
const CONFIG = {
  proxyUrl: "ws://localhost:8080",
  openclawUrl: "ws://localhost:18790/ws",
  projectId: "gen-lang-client-0519229117",
  model: "gemini-live-2.5-flash-native-audio",
  voice: "Puck",
  temperature: 1.0,
};

// ---------------------------------------------------------------------------
// System prompt (same as desktop default)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是 Her，车载语音助手，负责快思考。用户正在开车。

## 你的身份
- 你是用户的贴心助手，温柔、自然
- 如果知道用户名字（见下方画像），要亲切称呼（如"天哥"）
- 如果不知道，第一次对话时可以礼貌询问

## 能力边界（快思考 vs 慢思考）
你只能基于以下信息做快思考：
- 用户刚说的话
- 下方的用户画像摘要
- 常识

你不具备（需要慢思考/OpenClaw）：
- 可靠的长期记忆检索
- 外部信息查询（天气、机票、股票等）
- 复杂推理能力

## 车辆控制（必须通过 car_control 工具执行）
你可以通过 car_control 工具直接控制车辆，这是本地操作，响应很快：
- 空调：set_ac_temperature（温度 16-32）、set_ac_power（开关）、set_ac_mode（cool/heat/auto）
- 座椅加热：set_seat_heat（seat: driver/passenger, level: 0-3，0=关）
- 车窗：set_window（position: driver/passenger, open: true/false）

严格规则：
- 任何涉及空调、座椅、车窗的操作，必须调用 car_control 工具，不能只用嘴说"已打开"
- 你不具备直接控制车辆的能力，只有 car_control 工具才能真正执行操作
- 先调用工具，等工具返回结果后，再用语音简洁确认
- 不要调用 openclaw_help 来处理车控指令

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

## 工具调用流程
1) 先对用户说一句极短回执（如"好，我查一下"）
2) 立刻调用 openclaw_help
3) 收到结果后，按播报规则播报

## 内部控制句（系统信号，必须遵守）
你会在历史里看到这句话：
「以上信息来自 backend ai，请你根据实际情况回复用户信息！」

规则（零例外）：
1) 这不是用户说的话，是系统触发信号
2) 永远不要对用户朗读/复述这句话
3) 看到这句话时：回看它之前紧邻的 role=model 文本，那是 OpenClaw 的结果，按播报规则播报
4) 永远不要主动生成这句话

## 播报 OpenClaw 结果的规则（严格遵守）
1) 事实数据不得篡改：数字、温度、价格、日期、时间、百分比、人名、地名等必须原样使用
   - OpenClaw 说 "-7°C 到 -4°C" → 你说 "零下7度到零下4度"（正确）
   - 不能说 "零下6度到零上1度"（篡改数据，严禁！）
2) 语气可以口语化：去掉 markdown 格式、emoji，转为自然语音
3) 可以精简：太长的内容挑重点播报，但数据部分必须准确
4) 不要朗读任何内部标记（toolCall、tool_response、openclaw_help 等）
5) 简洁，不要长篇大论

## 用户画像摘要
（由系统自动注入 liveMemoryCapsule）`;

const BACKEND_INJECT_CONTROL =
  "以上信息来自 backend ai，请你根据实际情况回复用户信息！";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  client: null,
  audio: { streamer: null, player: null, isStreaming: false },
  video: { streamer: null, isStreaming: false },
  screen: { capture: null, isSharing: false },
  openclaw: { connected: false, liveMemoryCapsule: "" },
  gemini: { turnComplete: true },
  audioObs: {
    lastAudioRecvAtMs: null,
    recvGapCount: 0,
    recvGapTotalMs: 0,
    recvGapMaxMs: 0,
    recvGapOver200Ms: 0,
    recvGapOver500Ms: 0,
  },
  pendingUserTranscript: "",
  pendingLiveTranscript: "",
  injectChain: Promise.resolve(),
  pendingInjects: [],
  phase: "idle", // idle | connecting | live | error
};

// Reuse the global openclawConnection created by tools.js (loaded before us).

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
let el = {};

function initDOM() {
  const ids = [
    "transcript", "mainBtn", "videoContainer", "videoPreview",
    "micBtn", "camBtn", "screenBtn", "volBtn", "debugBtn",
    "volume", "volLabel", "volumePopup", "debugOverlay",
    "dbgOcStatus", "dbgGeminiStatus", "dbgMicStatus", "dbgAudioObs", "dbgLog",
    "jitterSlider", "jitterLabel",
  ];
  ids.forEach((id) => { el[id] = document.getElementById(id); });
}

// Jitter buffer: load saved value, apply to AudioPlayer, save on change.
function initJitterBuffer() {
  const saved = localStorage.getItem("carher.jitterBufferMs");
  const ms = saved != null ? parseInt(saved, 10) : 0;
  if (el.jitterSlider) el.jitterSlider.value = ms;
  if (el.jitterLabel) el.jitterLabel.textContent = ms === 0 ? "关闭" : ms + "ms";

  if (el.jitterSlider) {
    el.jitterSlider.addEventListener("input", () => {
      const val = parseInt(el.jitterSlider.value, 10);
      el.jitterLabel.textContent = val === 0 ? "关闭" : val + "ms";
      localStorage.setItem("carher.jitterBufferMs", val);
      if (state.audio.player) state.audio.player.setJitterBufferMs(val);
      dbgLog(`Jitter buffer: ${val}ms`);
    });
  }
}

function getJitterBufferMs() {
  const saved = localStorage.getItem("carher.jitterBufferMs");
  return saved != null ? parseInt(saved, 10) : 0;
}

// ---------------------------------------------------------------------------
// Apply URL params (from remote-setup.js / start-remote.sh)
// ---------------------------------------------------------------------------
function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("proxy")) CONFIG.proxyUrl = params.get("proxy");
  if (params.get("openclaw")) CONFIG.openclawUrl = params.get("openclaw");
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setPhase(phase) {
  state.phase = phase;
  const btn = el.mainBtn;
  btn.className = "main-btn " + phase;
  switch (phase) {
    case "idle":    btn.textContent = "开始"; break;
    case "connecting": btn.textContent = "连接中..."; break;
    case "live":    btn.textContent = "结束"; break;
    case "error":   btn.textContent = "重试"; break;
  }
}

// Keep last message reference for appending transcript chunks
let lastMsgEl = null;
let lastMsgType = null;

function addMessage(text, type, append = false) {
  if (append && lastMsgEl && lastMsgType === type) {
    // Append to existing message element
    lastMsgEl.lastChild.textContent += text;
  } else {
    const div = document.createElement("div");
    div.className = "msg " + type;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = type === "user" ? "你" : type === "assistant" ? "Her" : "SYS";
    const span = document.createElement("span");
    span.textContent = text;
    div.appendChild(tag);
    div.appendChild(span);
    el.transcript.appendChild(div);
    lastMsgEl = div;
    lastMsgType = type;
  }
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

// Debug log (accumulated, newest at bottom)
const MAX_LOG_LINES = 200;
let debugLogLines = [];

function dbgLog(line) {
  const ts = new Date().toISOString().slice(11, 23);
  debugLogLines.push(`[${ts}] ${line}`);
  if (debugLogLines.length > MAX_LOG_LINES) debugLogLines = debugLogLines.slice(-MAX_LOG_LINES);
  if (el.dbgLog) el.dbgLog.textContent = debugLogLines.join("\n");
  // Auto-scroll debug log
  if (el.dbgLog) el.dbgLog.scrollTop = el.dbgLog.scrollHeight;
}

function updateDbgStatus(id, text, ok) {
  const e = el[id];
  if (!e) return;
  e.textContent = text;
  e.className = "status-value" + (ok === true ? " ok" : ok === false ? " err" : "");
}

// Audio obs helpers (always enabled on mobile)
function resetAudioObs() {
  state.audioObs.lastAudioRecvAtMs = null;
  state.audioObs.recvGapCount = 0;
  state.audioObs.recvGapTotalMs = 0;
  state.audioObs.recvGapMaxMs = 0;
  state.audioObs.recvGapOver200Ms = 0;
  state.audioObs.recvGapOver500Ms = 0;
  if (state.audio.player && typeof state.audio.player.resetObs === "function") {
    state.audio.player.resetObs();
  }
}

// Append one line per turn (identical to PC appendDebugInfoLine format).
function appendAudioObsLine() {
  const o = state.audioObs;
  const avgMs = o.recvGapCount > 0 ? o.recvGapTotalMs / o.recvGapCount : 0;
  const playerObs = state.audio.player?.getObsSnapshot?.() || null;

  const parts = [
    "Turn complete",
    `recvGapMax=${Math.round(o.recvGapMaxMs)}ms`,
    `recvGapAvg=${Math.round(avgMs)}ms`,
    `recvGap>=200ms=${o.recvGapOver200Ms}`,
    `recvGap>=500ms=${o.recvGapOver500Ms}`,
  ];
  if (playerObs) {
    parts.push(
      `drainGapMax=${Math.round(playerObs.drainGapMaxMs)}ms`,
      `drainGapAvg=${Math.round(playerObs.drainGapAvgMs)}ms`,
      `drainGap>=200ms=${playerObs.drainGapOver200Ms}`,
    );
  }

  if (el.dbgAudioObs) {
    const existing = el.dbgAudioObs.textContent === "等待数据..." ? "" : el.dbgAudioObs.textContent;
    el.dbgAudioObs.textContent = existing + (existing ? "\n" : "") + parts.join(" | ");
  }
}

// ---------------------------------------------------------------------------
// Connection logic (mirrors script.js start flow)
// ---------------------------------------------------------------------------
async function connectOpenClaw() {
  const url = CONFIG.openclawUrl;
  const httpUrl = url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/ws$/, "");

  updateDbgStatus("dbgOcStatus", "连接中...", null);

  // Bootstrap: fetch live memory capsule
  const resp = await fetch(`${httpUrl}/api/realtime/bootstrap`);
  if (!resp.ok) throw new Error(`Bootstrap HTTP ${resp.status}`);
  const data = await resp.json();
  state.openclaw.liveMemoryCapsule = data.liveMemoryCapsule || "";
  if (!state.openclaw.liveMemoryCapsule) throw new Error("liveMemoryCapsule 为空");

  dbgLog(`Bootstrap OK: capsule ${state.openclaw.liveMemoryCapsule.length} chars`);

  // WebSocket
  await openclawConnection.connect(url);
  state.openclaw.connected = true;
  updateDbgStatus("dbgOcStatus", "已连接", true);

  // Callbacks
  openclawConnection.onHelpResult = (callId, reply) => {
    dbgLog(`Help result: ${reply.slice(0, 60)}...`);
    addMessage(`[OpenClaw] ${reply}`, "system");
    state.pendingInjects.push(reply);
    tryDeliverInjects();
  };

  openclawConnection.onPromptUpdate = (section, content) => {
    if (section === "live_memory_capsule") {
      state.openclaw.liveMemoryCapsule = content;
      dbgLog("Memory capsule updated (reconnect Gemini to apply)");
    }
  };

  openclawConnection.onInject = (reply) => {
    dbgLog(`Inject: ${reply.slice(0, 60)}...`);
    addMessage(`[Inject] ${reply}`, "system");
    state.pendingInjects.push(reply);
    tryDeliverInjects();
  };
}

function buildSystemInstructions() {
  let instructions = SYSTEM_PROMPT;
  if (state.openclaw.connected && state.openclaw.liveMemoryCapsule) {
    instructions += "\n\n" + state.openclaw.liveMemoryCapsule;
  }
  return instructions;
}

async function connectGemini() {
  updateDbgStatus("dbgGeminiStatus", "连接中...", null);

  state.client = new GeminiLiveAPI(CONFIG.proxyUrl, CONFIG.projectId, CONFIG.model);

  state.client.systemInstructions = buildSystemInstructions();
  state.client.inputAudioTranscription = true;
  state.client.outputAudioTranscription = true;
  state.client.googleGrounding = false;
  state.client.enableAffectiveDialog = true;
  state.client.responseModalities = ["AUDIO"];
  state.client.voiceName = CONFIG.voice;
  state.client.temperature = CONFIG.temperature;
  state.client.proactivity = { proactiveAudio: true };
  state.client.automaticActivityDetection = {
    disabled: false,
    silence_duration_ms: 500,
    prefix_padding_ms: 500,
    end_of_speech_sensitivity: "END_SENSITIVITY_UNSPECIFIED",
    start_of_speech_sensitivity: "START_SENSITIVITY_UNSPECIFIED",
  };
  state.client.activityHandling = "ACTIVITY_HANDLING_UNSPECIFIED";

  // Register OpenClaw help tool (slow thinking — external queries, memory, etc.)
  const openclawTool = new OpenClawHelpTool(openclawConnection);
  state.client.addFunction(openclawTool);

  // Register car control tool (local — AC, seat heat, windows via JS Bridge)
  const carTool = new CarControlTool();
  state.client.addFunction(carTool);

  state.client.onReceiveResponse = handleMessage;
  state.client.onErrorMessage = (msg) => {
    handleError(msg);
    disconnectAll();
    setPhase("error");
  };
  // GeminiLiveAPI fires onConnectionStarted (not onOpen) after WS handshake.
  state.client.onConnectionStarted = () => {
    updateDbgStatus("dbgGeminiStatus", "已连接", true);
    dbgLog("Gemini connected");
  };

  // connect() is sync (just opens WS); wrap in a Promise that resolves on open.
  await new Promise((resolve, reject) => {
    const origOnStart = state.client.onConnectionStarted;
    state.client.onConnectionStarted = () => {
      origOnStart();
      resolve();
    };
    const origOnError = state.client.onErrorMessage;
    state.client.onErrorMessage = (msg) => {
      origOnError(msg);
      reject(new Error(msg));
    };
    state.client.connect();
  });

  // Init audio player with saved jitter buffer setting
  state.audio.player = new AudioPlayer();
  state.audio.player.setJitterBufferMs(getJitterBufferMs());
  await state.audio.player.init();
  dbgLog(`AudioPlayer ready (jitter: ${state.audio.player.jitterBufferMs}ms)`);
}

// Auto-start microphone after connection
async function autoStartMic() {
  if (!state.client) return;
  state.audio.streamer = new AudioStreamer(state.client);
  await state.audio.streamer.start();
  state.audio.isStreaming = true;
  el.micBtn.classList.add("active");
  updateDbgStatus("dbgMicStatus", "开启", true);
  dbgLog("Microphone auto-started");
}

// ---------------------------------------------------------------------------
// Main start / stop
// ---------------------------------------------------------------------------
async function start() {
  setPhase("connecting");
  try {
    await connectOpenClaw();
    await connectGemini();
    await autoStartMic();
    setPhase("live");
    addMessage("已连接，开始对话", "system");
  } catch (err) {
    console.error("Start failed:", err);
    addMessage(`连接失败: ${err.message}`, "system");
    dbgLog(`ERROR: ${err.message}`);
    setPhase("error");
  }
}

function disconnectAll() {
  if (state.client?.webSocket) state.client.webSocket.close();
  state.client = null;
  if (state.audio.streamer) state.audio.streamer.stop();
  if (state.video.streamer) state.video.streamer.stop();
  if (state.screen.capture) state.screen.capture.stop();
  state.audio.isStreaming = false;
  state.video.isStreaming = false;
  state.screen.isSharing = false;
  openclawConnection.disconnect();
  state.openclaw.connected = false;

  el.micBtn.classList.remove("active");
  el.camBtn.classList.remove("active");
  el.screenBtn.classList.remove("active");
  el.videoContainer.classList.remove("active");
  el.videoPreview.srcObject = null;

  updateDbgStatus("dbgOcStatus", "未连接", false);
  updateDbgStatus("dbgGeminiStatus", "未连接", false);
  updateDbgStatus("dbgMicStatus", "关闭", false);
}

// ---------------------------------------------------------------------------
// Message handler (core — handles all Gemini response types)
// ---------------------------------------------------------------------------
function handleMessage(message) {
  switch (message.type) {
    case MultimodalLiveResponseType.TEXT:
      addMessage(message.data, "assistant");
      break;

    case MultimodalLiveResponseType.AUDIO:
      // Track audio arrival jitter (always on, no checkbox needed)
      {
        const nowMs = performance.now();
        const lastMs = state.audioObs.lastAudioRecvAtMs;
        if (lastMs != null) {
          const gapMs = nowMs - lastMs;
          state.audioObs.recvGapCount += 1;
          state.audioObs.recvGapTotalMs += gapMs;
          state.audioObs.recvGapMaxMs = Math.max(state.audioObs.recvGapMaxMs, gapMs);
          if (gapMs >= 200) state.audioObs.recvGapOver200Ms += 1;
          if (gapMs >= 500) state.audioObs.recvGapOver500Ms += 1;
        }
        state.audioObs.lastAudioRecvAtMs = nowMs;
      }
      if (state.audio.player) state.audio.player.play(message.data);
      break;

    case MultimodalLiveResponseType.INPUT_TRANSCRIPTION:
      if (!message.data.finished) {
        state.pendingUserTranscript += message.data.text || "";
        addMessage(message.data.text, "user", true);
      } else {
        if (state.openclaw.connected && state.pendingUserTranscript) {
          openclawConnection.sendTranscript("user", state.pendingUserTranscript);
          dbgLog(`Transcript→OC user: ${state.pendingUserTranscript.slice(0, 40)}`);
        }
        state.pendingUserTranscript = "";
      }
      break;

    case MultimodalLiveResponseType.OUTPUT_TRANSCRIPTION:
      if (!message.data.finished) {
        state.pendingLiveTranscript += message.data.text || "";
        addMessage(message.data.text, "assistant", true);
      } else {
        if (state.openclaw.connected && state.pendingLiveTranscript) {
          openclawConnection.sendTranscript("live", state.pendingLiveTranscript);
          dbgLog(`Transcript→OC live: ${state.pendingLiveTranscript.slice(0, 40)}`);
        }
        state.pendingLiveTranscript = "";
      }
      break;

    case MultimodalLiveResponseType.SETUP_COMPLETE:
      addMessage("Ready!", "system");
      state.gemini.turnComplete = true;
      tryDeliverInjects();
      break;

    case MultimodalLiveResponseType.TOOL_CALL: {
      const functionCalls = message.data.functionCalls;
      for (const fc of functionCalls) {
        const name = fc.name;
        const id = fc.id || crypto.randomUUID();
        const args = fc.args;

        dbgLog(`ToolCall: ${name} id=${id}`);

        // Show all tool calls in UI
        const argsStr = JSON.stringify(args, null, 0);
        addMessage(`[Tool: ${name}] ${argsStr}`, "system");

        if (name === "openclaw_help") {
          if (state.client) {
            state.client.sendToolResponse(id, "openclaw_help", {
              ok: true, status: "processing", jobId: id,
            });
          }
          const tool = state.client?.functionsMap?.[name];
          if (tool) tool.functionToCall(args, id);
        } else {
          // Local tool (e.g. car_control): execute and send result back to Gemini
          const tool = state.client?.functionsMap?.[name];
          if (tool) {
            const result = tool.functionToCall(args, id);
            if (state.client) {
              state.client.sendToolResponse(id, name, result || { ok: true });
            }
          }
        }
      }
      break;
    }

    case MultimodalLiveResponseType.TURN_COMPLETE:
      dbgLog("Turn complete");
      // Flush any remaining jitter-buffered audio before finalizing.
      if (state.audio.player) state.audio.player.onTurnComplete();
      // Only append a line when this turn actually had audio data (skip empty turns).
      if (state.audioObs.recvGapCount > 0) {
        appendAudioObsLine();
      }
      resetAudioObs();

      state.gemini.turnComplete = true;
      tryDeliverInjects();

      if (state.openclaw.connected) {
        openclawConnection.sendTurnComplete();
      }
      break;

    case MultimodalLiveResponseType.INTERRUPTED:
      addMessage("[打断]", "system");
      if (state.audio.player) state.audio.player.interrupt();
      break;

    case MultimodalLiveResponseType.RESPONSE_REJECTED:
      dbgLog("RESPONSE_REJECTED");
      break;
  }
}

function handleError(error) {
  console.error("Gemini error:", error);
  dbgLog(`Gemini ERROR: ${error}`);
  addMessage(`错误: ${error}`, "system");
}

function tryDeliverInjects() {
  if (!state.client) return;
  if (!globalThis.OpenClawInjectDelivery?.deliverNextInject) return;
  globalThis.OpenClawInjectDelivery.deliverNextInject({
    client: state.client,
    audioPlayer: state.audio.player,
    state,
    controlLine: BACKEND_INJECT_CONTROL,
    onError: (err) => console.error("Inject failed:", err),
  });
}

// ---------------------------------------------------------------------------
// Media toggles
// ---------------------------------------------------------------------------
async function toggleMic() {
  if (!state.client) return;
  if (!state.audio.isStreaming) {
    if (!state.audio.streamer) state.audio.streamer = new AudioStreamer(state.client);
    await state.audio.streamer.start();
    state.audio.isStreaming = true;
    el.micBtn.classList.add("active");
    updateDbgStatus("dbgMicStatus", "开启", true);
  } else {
    if (state.audio.streamer) state.audio.streamer.stop();
    state.audio.isStreaming = false;
    el.micBtn.classList.remove("active");
    updateDbgStatus("dbgMicStatus", "关闭", false);
  }
}

async function toggleCamera() {
  if (!state.client) return;
  if (!state.video.isStreaming) {
    if (!state.video.streamer) state.video.streamer = new VideoStreamer(state.client);
    const video = await state.video.streamer.start({ fps: 1, width: 640, height: 480 });
    state.video.isStreaming = true;
    el.videoPreview.srcObject = video.srcObject;
    el.videoContainer.classList.add("active");
    el.camBtn.classList.add("active");
    addMessage("[摄像头已开启]", "system");
  } else {
    if (state.video.streamer) state.video.streamer.stop();
    state.video.isStreaming = false;
    el.videoPreview.srcObject = null;
    el.videoContainer.classList.remove("active");
    el.camBtn.classList.remove("active");
    addMessage("[摄像头已关闭]", "system");
  }
}

async function toggleScreen() {
  if (!state.client) return;
  if (!state.screen.isSharing) {
    if (!state.screen.capture) state.screen.capture = new ScreenCapture(state.client);
    const video = await state.screen.capture.start({ fps: 0.5 });
    state.screen.isSharing = true;
    el.videoPreview.srcObject = video.srcObject;
    el.videoContainer.classList.add("active");
    el.screenBtn.classList.add("active");
    addMessage("[屏幕共享已开启]", "system");
  } else {
    if (state.screen.capture) state.screen.capture.stop();
    state.screen.isSharing = false;
    el.videoPreview.srcObject = null;
    el.videoContainer.classList.remove("active");
    el.screenBtn.classList.remove("active");
    addMessage("[屏幕共享已关闭]", "system");
  }
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
function initEvents() {
  // Main button: start or stop
  el.mainBtn.addEventListener("click", () => {
    if (state.phase === "idle" || state.phase === "error") {
      start();
    } else if (state.phase === "live") {
      disconnectAll();
      setPhase("idle");
      addMessage("已断开", "system");
    }
  });

  // Toolbar
  el.micBtn.addEventListener("click", () => { if (state.phase === "live") toggleMic(); });
  el.camBtn.addEventListener("click", () => { if (state.phase === "live") toggleCamera(); });
  el.screenBtn.addEventListener("click", () => { if (state.phase === "live") toggleScreen(); });

  // Volume popup
  el.volBtn.addEventListener("click", () => {
    el.volumePopup.classList.toggle("visible");
  });
  el.volume.addEventListener("input", () => {
    const v = el.volume.value;
    el.volLabel.textContent = v + "%";
    if (state.audio.player) state.audio.player.setVolume(v / 100);
  });
  // Close volume popup on tap outside
  document.addEventListener("click", (e) => {
    if (!el.volumePopup.contains(e.target) && e.target !== el.volBtn && !el.volBtn.contains(e.target)) {
      el.volumePopup.classList.remove("visible");
    }
  });

  // Debug overlay toggle
  el.debugBtn.addEventListener("click", () => {
    el.debugOverlay.classList.toggle("visible");
    el.debugBtn.classList.toggle("active");
  });
}

// ---------------------------------------------------------------------------
// Environment checks (populates debug overlay "环境检测" section)
// ---------------------------------------------------------------------------
function runEnvChecks() {
  const container = document.getElementById("envChecks");
  if (!container) return;

  const ua = navigator.userAgent;
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const chromeVer = chromeMatch ? parseInt(chromeMatch[1]) : null;
  const androidMatch = ua.match(/Android\s+([\d.]+)/);
  const androidVer = androidMatch ? androidMatch[1] : null;

  const checks = [
    {
      name: "系统",
      ok: true,
      label: androidVer ? `Android ${androidVer}` : (ua.includes("iPhone") ? "iOS" : "非Android"),
    },
    {
      name: "内核",
      ok: chromeVer ? chromeVer >= 66 : null,
      label: chromeVer ? `Chromium ${chromeVer}` : "未知",
    },
    {
      name: "WebSocket",
      ok: typeof WebSocket !== "undefined",
    },
    {
      name: "getUserMedia",
      ok: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    },
    {
      name: "AudioContext",
      ok: typeof (window.AudioContext || window.webkitAudioContext) !== "undefined",
    },
    {
      name: "AudioWorklet",
      ok: (() => {
        try {
          const ctx = new AudioContext();
          const has = "audioWorklet" in ctx;
          ctx.close();
          return has;
        } catch { return false; }
      })(),
    },
    {
      name: "JS Bridge（车控）",
      ok: typeof Android !== "undefined" ? true : null, // null = 非必需，不算失败
      label: typeof Android !== "undefined" ? "可用" : "未检测到（浏览器正常，壳App内可用）",
    },
  ];

  container.innerHTML = "";
  for (const c of checks) {
    const statusClass = c.ok === true ? "ok" : c.ok === false ? "err" : "";
    const label = c.label || (c.ok ? "支持" : "不支持");
    const row = document.createElement("div");
    row.className = "status-row";
    row.innerHTML = `<span class="status-label">${c.name}</span><span class="status-value ${statusClass}">${label}</span>`;
    container.appendChild(row);
  }

  const allPassed = checks.every(c => c.ok !== false);
  const summary = document.createElement("div");
  summary.className = "status-row";
  summary.style.marginTop = "4px";
  summary.style.fontWeight = "600";
  summary.innerHTML = allPassed
    ? '<span class="status-label">结论</span><span class="status-value ok">全部通过</span>'
    : '<span class="status-label">结论</span><span class="status-value err">有不支持项</span>';
  container.appendChild(summary);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  initDOM();
  applyUrlParams();
  initJitterBuffer();
  initEvents();
  runEnvChecks();
  dbgLog("Mobile UI initialized");
  dbgLog(`Proxy: ${CONFIG.proxyUrl}`);
  dbgLog(`OpenClaw: ${CONFIG.openclawUrl}`);
  dbgLog(`Jitter buffer: ${getJitterBufferMs()}ms`);
});
