/**
 * Main application script for Gemini Live API Demo
 * Handles UI interactions, media streaming, and communication with Gemini API
 */

// Voice token from URL params (Layer 2 auth)
const voiceToken = new URLSearchParams(window.location.search).get("token") || "";

// Global state
const state = {
  client: null,
  audio: { streamer: null, player: null, isStreaming: false },
  video: { streamer: null, isStreaming: false },
  screen: { capture: null, isSharing: false },
  openclaw: { connected: false, liveMemoryCapsule: "", systemPrompt: null, toolDeclarations: null },
  gemini: {
    // Only inject after Gemini completes a turn (TURN_COMPLETE).
    turnComplete: true,
  },
  // Audio observability counters (client-side, O(1) overhead per audio chunk).
  audioObs: {
    lastAudioRecvAtMs: null,
    recvGapCount: 0,
    recvGapTotalMs: 0,
    recvGapMaxMs: 0,
    recvGapOver200Ms: 0,
    recvGapOver500Ms: 0,
  },
  // Accumulate transcripts before sending to OpenClaw
  pendingUserTranscript: "",
  pendingLiveTranscript: "",
  // Serialize inject delivery to Gemini to avoid interrupting active audio playback.
  injectChain: Promise.resolve(),
  pendingInjects: [], // Each item: { seq, reply } or plain string (legacy)
  // Map callId → { request, seq } for inject labeling.
  helpRequests: new Map(),
  helpCounter: 0, // Auto-increment sequence number for help requests
};

// Backend inject control line (internal). This line is used to force Gemini to
// continue generation after we inject backend context as role=model.
// (BACKEND_INJECT_CONTROL removed — inject-delivery.js sends an atomic
//  client_content with role=model result + role=user broadcast trigger.)

// Debug logger for tracking message flow
function debugLog(direction, eventType, data = {}) {
  const ts = new Date().toISOString().slice(11, 23);
  const dataStr = Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" | ");
  console.log(`[${ts}] ${direction.padEnd(15)} | ${eventType.padEnd(18)} | ${dataStr}`);
}

// DOM element cache
const elements = {};

function appendDebugInfoLine(line) {
  const el = elements.debugInfo;
  if (!el) return;
  const ts = new Date().toISOString().slice(11, 23);
  const entry = `[${ts}] ${line}`;

  const prev = el.textContent || "";
  const next = prev && prev !== "Ready to connect..." ? `${prev}\n${entry}` : entry;

  // Keep last N lines so a long session stays copy/paste friendly.
  const MAX_LINES = 400;
  const lines = next.split("\n");
  el.textContent = lines.length > MAX_LINES ? lines.slice(-MAX_LINES).join("\n") : next;
  el.scrollTop = el.scrollHeight;
}

function resetAudioObsCounters() {
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

// Initialize DOM references
function initDOM() {
  const ids = [
    "projectId",
    "model",
    "proxyUrl",
    "systemInstructions",
    "enableInputTranscription",
    "enableOutputTranscription",
    "enableAudioObs",
    "enableAffectiveDialog",
    "enableAlertTool",
    "enableCssStyleTool",
    "openclawUrl",
    "openclawStatus",
    "startBtn",
    "enableProactiveAudio",
    "voiceSelect",
    "temperature",
    "temperatureValue",
    "disableActivityDetection",
    "silenceDuration",
    "prefixPadding",
    "endSpeechSensitivity",
    "startSpeechSensitivity",
    "activityHandling",
    "connectionStatus",
    "startAudioBtn",
    "startVideoBtn",
    "startScreenBtn",
    "videoPreview",
    "micSelect",
    "cameraSelect",
    "volume",
    "volumeValue",
    "chatContainer",
    "chatInput",
    "sendBtn",
    "debugInfo",
    "setupJsonSection",
    "setupJsonDisplay",
    "jitterBufferMs",
    "jitterBufferLabel",
  ];

  ids.forEach((id) => {
    elements[id] = document.getElementById(id);
  });

  // Jitter buffer: restore saved value and wire up slider
  const savedJitter = localStorage.getItem("carher.jitterBufferMs");
  const jitterVal = savedJitter != null ? parseInt(savedJitter, 10) : 0;
  if (elements.jitterBufferMs) {
    elements.jitterBufferMs.value = jitterVal;
    if (elements.jitterBufferLabel)
      elements.jitterBufferLabel.textContent = jitterVal === 0 ? "off" : jitterVal;
    elements.jitterBufferMs.addEventListener("input", () => {
      const v = parseInt(elements.jitterBufferMs.value, 10);
      elements.jitterBufferLabel.textContent = v === 0 ? "off" : v;
      localStorage.setItem("carher.jitterBufferMs", v);
      if (state.audio.player) state.audio.player.setJitterBufferMs(v);
    });
  }
}

// Populate media device selectors
async function populateMediaDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    // Clear existing options
    elements.micSelect.innerHTML = '<option value="">Default Microphone</option>';
    elements.cameraSelect.innerHTML = '<option value="">Default Camera</option>';

    // Add audio input devices
    devices
      .filter((device) => device.kind === "audioinput")
      .forEach((device) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${device.deviceId.substr(0, 8)}`;
        elements.micSelect.appendChild(option);
      });

    // Add video input devices
    devices
      .filter((device) => device.kind === "videoinput")
      .forEach((device) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${device.deviceId.substr(0, 8)}`;
        elements.cameraSelect.appendChild(option);
      });
  } catch (error) {
    console.error("Error enumerating devices:", error);
  }
}

// Create reusable message element
function createMessage(text, className = "") {
  const div = document.createElement("div");
  div.textContent = text;
  if (className) div.className = className;
  return div;
}

// Update status display
function updateStatus(elementId, text) {
  if (elements[elementId]) {
    elements[elementId].textContent = text;
  }
}

// Connect to OpenClaw backend
async function connectOpenClaw() {
  const url = elements.openclawUrl?.value || "ws://localhost:18790/ws";
  // Convert ws(s):// to http(s):// for the bootstrap REST call.
  const httpUrl = url
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/ws$/, "");
  const agentId = getAgentIdFromPageUrl();

  try {
    updateStatus("openclawStatus", "Connecting...");

    // MUST fetch bootstrap data (Live memory capsule) before connecting Gemini.
    // This call blocks until the server has generated/loaded the capsule.
    let bootstrapUrl = agentId
      ? appendQueryParam(`${httpUrl}/api/realtime/bootstrap`, "agentId", agentId)
      : `${httpUrl}/api/realtime/bootstrap`;
    if (voiceToken) bootstrapUrl = appendQueryParam(bootstrapUrl, "token", voiceToken);
    const bootstrapResp = await fetch(bootstrapUrl);
    if (!bootstrapResp.ok) {
      throw new Error(`Bootstrap failed: HTTP ${bootstrapResp.status}`);
    }
    const bootstrap = await bootstrapResp.json();
    state.openclaw.liveMemoryCapsule = bootstrap.liveMemoryCapsule || "";
    if (!state.openclaw.liveMemoryCapsule) {
      throw new Error("Bootstrap failed: liveMemoryCapsule is empty");
    }

    // Extract system prompt from Bootstrap (single source of truth: server.ts HER_SYSTEM_PROMPT)
    const bootstrapSetup = bootstrap.geminiProxy?.sessionSetup?.setup;
    const bootstrapPrompt = bootstrapSetup?.system_instruction?.parts?.[0]?.text;
    if (bootstrapPrompt) {
      state.openclaw.systemPrompt = bootstrapPrompt;
      console.log(`🦞 Bootstrap prompt: ${bootstrapPrompt.length} chars (from server)`);
    }

    // Extract tool declarations from Bootstrap (single source of truth: server.ts TOOL_DECLARATIONS)
    const bootstrapTools = bootstrapSetup?.tools?.function_declarations;
    if (bootstrapTools && Array.isArray(bootstrapTools) && bootstrapTools.length > 0) {
      state.openclaw.toolDeclarations = bootstrapTools;
      console.log(
        `🦞 Bootstrap tools: ${bootstrapTools.length} (${bootstrapTools.map((t) => t.name).join(", ")})`,
      );
    }

    console.log("🦞 Bootstrap loaded:", {
      liveMemoryCapsule: state.openclaw.liveMemoryCapsule.slice(0, 120) + "...",
      agentId: agentId || "(default)",
    });

    // Connect WebSocket (pass agentId for multi-agent routing; append token for Layer 2 auth)
    let wsUrl = url;
    if (voiceToken) wsUrl = appendQueryParam(wsUrl, "token", voiceToken);
    await openclawConnection.connect(wsUrl, agentId);
    state.openclaw.connected = true;
    updateStatus("openclawStatus", "Connected ✓");

    // Set up callbacks
    openclawConnection.onHelpResult = (callId, reply) => {
      const entry = state.helpRequests.get(callId) || { request: "", seq: 0 };
      state.helpRequests.delete(callId);
      console.log(`🦞 Help result #${entry.seq} (${entry.request}) for ${callId}:`, reply);
      debugLog("OPENCLAW→LIVE", "HELP_RESULT", {
        callId,
        seq: entry.seq,
        request: entry.request,
        reply: reply.slice(0, 50) + "...",
      });
      // Deliver as labeled inject so Gemini can match result to query.
      addMessage(`[OpenClaw] ${reply}`, "system");
      state.pendingInjects.push({ seq: entry.seq, reply });
      tryDeliverInjects();
    };

    openclawConnection.onPromptUpdate = (section, content) => {
      console.log(`🦞 Prompt update [${section}]:`, content.slice(0, 100) + "...");
      if (section === "live_memory_capsule") {
        state.openclaw.liveMemoryCapsule = content;
        addMessage("[Live memory capsule updated: reconnect Gemini to apply]", "system");
      } else {
        // Ignore legacy sections to avoid leaking full USER.md / MEMORY.md to the browser.
      }
    };

    openclawConnection.onInject = (reply) => {
      console.log("🦞 Inject:", reply);
      // Make inject visible in the chat UI for deterministic verification.
      addMessage(`[Inject] ${reply}`, "inject");

      // Queue injects and deliver them only after Gemini finishes its current turn.
      // Live API contract: any clientContent message can interrupt current model generation.
      state.pendingInjects.push(reply);
      tryDeliverInjects();
    };
  } catch (error) {
    console.error("OpenClaw connection failed:", error);
    updateStatus("openclawStatus", "Failed: " + error.message);
    state.openclaw.connected = false;
    throw error;
  }
}

// Build system instructions — prefer Bootstrap prompt (single source of truth: server.ts)
function buildSystemInstructions() {
  // Bootstrap prompt already has capsule baked in
  if (state.openclaw.systemPrompt) {
    return state.openclaw.systemPrompt;
  }
  // Fallback: textarea value + capsule
  let instructions = elements.systemInstructions.value || "";
  if (state.openclaw.connected && state.openclaw.liveMemoryCapsule) {
    instructions += `\n\n${state.openclaw.liveMemoryCapsule}`;
  }
  return instructions;
}

function assertReadyForGeminiSetup() {
  if (!state.openclaw.connected) {
    throw new Error("OpenClaw not connected (must start with OpenClaw first)");
  }
  if (!state.openclaw.liveMemoryCapsule) {
    throw new Error("Live memory capsule missing (bootstrap must complete first)");
  }
}

// Connect to Gemini (only called from the single-button start flow)
async function connectGemini() {
  const proxyUrl = elements.proxyUrl.value || null;
  const projectId = elements.projectId.value;
  const model = elements.model.value;

  if (!proxyUrl && !projectId) {
    alert("Please provide either a Proxy URL and Project ID");
    return;
  }

  try {
    assertReadyForGeminiSetup();
    updateStatus("connectionStatus", "Connecting...");

    // Create GeminiLiveAPI instance directly
    state.client = new GeminiLiveAPI(proxyUrl, projectId, model);

    // Configure settings - use enhanced instructions if OpenClaw connected
    state.client.systemInstructions = buildSystemInstructions();
    state.client.inputAudioTranscription = elements.enableInputTranscription.checked;
    state.client.outputAudioTranscription = elements.enableOutputTranscription.checked;
    // Hard-disable Google grounding: it disables custom tools and causes racey setups.
    state.client.googleGrounding = false;
    state.client.enableAffectiveDialog = elements.enableAffectiveDialog.checked;
    state.client.responseModalities = ["AUDIO"];
    state.client.voiceName = elements.voiceSelect.value;
    state.client.temperature = parseFloat(elements.temperature.value);

    // Set proactivity configuration
    state.client.proactivity = {
      proactiveAudio: elements.enableProactiveAudio.checked,
    };

    // Set automatic activity detection configuration
    state.client.automaticActivityDetection = {
      disabled: elements.disableActivityDetection.checked,
      silence_duration_ms: parseInt(elements.silenceDuration.value),
      prefix_padding_ms: parseInt(elements.prefixPadding.value),
      end_of_speech_sensitivity: elements.endSpeechSensitivity.value,
      start_of_speech_sensitivity: elements.startSpeechSensitivity.value,
    };

    // Set activity handling
    state.client.activityHandling = elements.activityHandling.value;

    // Optional local demo tools
    if (elements.enableAlertTool.checked) {
      const alertTool = new ShowAlertTool();
      state.client.addFunction(alertTool);
      console.log("✅ Alert tool enabled");
    }
    if (elements.enableCssStyleTool.checked) {
      const cssStyleTool = new AddCSSStyleTool();
      state.client.addFunction(cssStyleTool);
      console.log("✅ CSS style tool enabled");
    }

    // Register tool classes for execution routing (functionsMap).
    // Schema sent to Gemini comes from Bootstrap when available.
    const openclawTool = new OpenClawHelpTool(openclawConnection);
    state.client.addFunction(openclawTool);
    const carTool = new CarControlTool();
    state.client.addFunction(carTool);
    console.log("✅ Tools registered (openclaw_help, car_control)");

    // Use Bootstrap tool declarations as schema (single source of truth: server.ts)
    if (state.openclaw.toolDeclarations) {
      state.client.externalToolDeclarations = state.openclaw.toolDeclarations;
    }

    // Set callbacks
    state.client.onReceiveResponse = handleMessage;
    state.client.onError = handleError;
    state.client.onOpen = handleOpen;
    state.client.onClose = handleClose;

    await state.client.connect();

    // Initialize media handlers
    state.audio.streamer = new AudioStreamer(state.client);
    state.video.streamer = new VideoStreamer(state.client);
    state.screen.capture = new ScreenCapture(state.client);
    state.audio.player = new AudioPlayer();
    const savedJitter = localStorage.getItem("carher.jitterBufferMs");
    if (savedJitter) state.audio.player.setJitterBufferMs(parseInt(savedJitter, 10));
    await state.audio.player.init();
    console.log(`🔊 AudioPlayer ready (jitter buffer: ${state.audio.player.jitterBufferMs}ms)`);

    updateStatus("debugInfo", "Connected successfully");
  } catch (error) {
    console.error("Connection failed:", error);
    updateStatus("connectionStatus", "Connection failed: " + error.message);
    updateStatus("debugInfo", "Error: " + error.message);
  }
}

function disconnectAll() {
  disconnect();
  openclawConnection.disconnect();
  state.openclaw.connected = false;
  updateStatus("openclawStatus", "未连接");
}

// Single-button deterministic startup:
// OpenClaw (bootstrap capsule) → OpenClaw WS → Gemini (setup includes capsule + openclaw_help)
async function start() {
  if (elements.startBtn) elements.startBtn.disabled = true;
  try {
    disconnectAll();
    await connectOpenClaw();
    await connectGemini();
  } finally {
    if (elements.startBtn) elements.startBtn.disabled = false;
  }
}

// Disconnect
function disconnect() {
  if (state.client && state.client.webSocket) {
    state.client.webSocket.close();
    state.client = null;
  }

  // Stop all streams
  if (state.audio.streamer) state.audio.streamer.stop();
  if (state.video.streamer) state.video.streamer.stop();
  if (state.screen.capture) state.screen.capture.stop();

  // Reset states
  state.audio.isStreaming = false;
  state.video.isStreaming = false;
  state.screen.isSharing = false;

  // Update UI
  updateStatus("connectionStatus", "Disconnected");

  elements.startAudioBtn.textContent = "Start Audio";
  elements.startVideoBtn.textContent = "Start Video";
  elements.startScreenBtn.textContent = "Share Screen";

  elements.videoPreview.hidden = true;
  elements.videoPreview.srcObject = null;
}

// Handle messages
function handleMessage(message) {
  console.log("Message:", message);
  // When audio observability is enabled, keep Debug Info as an accumulating log.
  // Don't overwrite it on every incoming message.
  if (!elements.enableAudioObs?.checked) {
    updateStatus("debugInfo", `Message: ${message.type}`);
  }

  switch (message.type) {
    case MultimodalLiveResponseType.TEXT:
      console.log("Text message:");
      addMessage(message.data, "assistant");
      break;

    case MultimodalLiveResponseType.AUDIO:
      console.log("Audio message:");
      // Track audio arrival jitter (proxy/network + browser WS delivery).
      // This does NOT log per-chunk (to avoid DevTools overhead); it only updates counters.
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
      if (state.audio.player) {
        state.audio.player.play(message.data);
      }
      break;

    case MultimodalLiveResponseType.INPUT_TRANSCRIPTION:
      console.log("Input transcription:", message.data);
      if (!message.data.finished) {
        // Accumulate transcript text
        state.pendingUserTranscript += message.data.text || "";
        addMessage(message.data.text, "user-transcript", (append = true));
      } else {
        // finished=true, send accumulated transcript to OpenClaw
        if (state.openclaw.connected && state.pendingUserTranscript) {
          openclawConnection.sendTranscript("user", state.pendingUserTranscript);
          debugLog("LIVE→OPENCLAW", "TRANSCRIPT_USER", {
            text: state.pendingUserTranscript.slice(0, 50),
          });
        }
        state.pendingUserTranscript = ""; // Reset
      }
      break;

    case MultimodalLiveResponseType.OUTPUT_TRANSCRIPTION:
      console.log("Output transcription:", message.data);
      if (!message.data.finished) {
        // Accumulate transcript text
        state.pendingLiveTranscript += message.data.text || "";
        addMessage(message.data.text, "assistant", (append = true));
      } else {
        // finished=true, send accumulated transcript to OpenClaw
        if (state.openclaw.connected && state.pendingLiveTranscript) {
          openclawConnection.sendTranscript("live", state.pendingLiveTranscript);
          debugLog("LIVE→OPENCLAW", "TRANSCRIPT_LIVE", {
            text: state.pendingLiveTranscript.slice(0, 50),
          });
        }
        state.pendingLiveTranscript = ""; // Reset
      }
      break;

    case MultimodalLiveResponseType.SETUP_COMPLETE:
      console.log("Setup complete:", message.data);
      addMessage("Ready!", "system");
      state.gemini.turnComplete = true;
      tryDeliverInjects();

      // Display the setup JSON
      if (state.client && state.client.lastSetupMessage) {
        elements.setupJsonDisplay.textContent = JSON.stringify(
          state.client.lastSetupMessage,
          null,
          2,
        );
        elements.setupJsonSection.style.display = "block";
      }
      break;

    case MultimodalLiveResponseType.TOOL_CALL:
      console.log("🛠️ Tool call received: ", message.data);
      const functionCalls = message.data.functionCalls;
      for (let index = 0; index < functionCalls.length; index++) {
        const functionCall = functionCalls[index];
        const functionName = functionCall.name;
        // Generate UUID if Gemini doesn't provide id
        const functionCallId = functionCall.id || crypto.randomUUID();
        const parameters = functionCall.args;

        debugLog("GEMINI→LIVE", "TOOL_CALL", {
          geminiId: functionCall.id,
          usedId: functionCallId,
          name: functionName,
          args: parameters,
        });

        // Special handling for OpenClaw help tool (async)
        if (functionName === "openclaw_help") {
          const request = parameters.request || "";
          addMessage(`[Asking OpenClaw: ${request}]`, "system");
          // Assign numeric sequence — avoids Chinese text Gemini might re-interpret.
          const seq = ++state.helpCounter;
          state.helpRequests.set(functionCallId, { request, seq });

          if (state.client) {
            debugLog("LIVE→GEMINI", "TOOL_RESPONSE_ACK", {
              id: functionCallId,
              name: functionName,
              seq,
            });
            state.client.sendToolResponse(functionCallId, "openclaw_help", {
              result: `请求 #${seq} 已收到，后台正在处理。结果稍后会标注 #${seq} 自动出现，届时请播报给用户。在此之前不要再次调用 openclaw_help。`,
            });
          }

          const tool = state.client.functionsMap[functionName];
          if (tool) {
            tool.functionToCall(parameters, functionCallId);
          }
        } else {
          // Sync tools (e.g. car_control) — execute and send result back to Gemini
          const tool = state.client.functionsMap[functionName];
          if (tool) {
            const result = tool.functionToCall(parameters, functionCallId);
            if (state.client) {
              state.client.sendToolResponse(functionCallId, functionName, result || { ok: true });
            }
          }
        }
      }
      break;

    case MultimodalLiveResponseType.TURN_COMPLETE:
      console.log("Turn complete:", message.data);
      debugLog("GEMINI→LIVE", "TURN_COMPLETE", {});
      // Flush remaining jitter-buffered audio before finalizing turn.
      if (state.audio.player) state.audio.player.onTurnComplete();
      if (elements.enableAudioObs?.checked) {
        const avgRecvGapMs =
          state.audioObs.recvGapCount > 0
            ? state.audioObs.recvGapTotalMs / state.audioObs.recvGapCount
            : 0;
        const playerObs =
          state.audio.player && typeof state.audio.player.getObsSnapshot === "function"
            ? state.audio.player.getObsSnapshot()
            : null;

        const parts = [
          "Turn complete",
          `recvGapMax=${Math.round(state.audioObs.recvGapMaxMs)}ms`,
          `recvGapAvg=${Math.round(avgRecvGapMs)}ms`,
          `recvGap>=200ms=${state.audioObs.recvGapOver200Ms}`,
          `recvGap>=500ms=${state.audioObs.recvGapOver500Ms}`,
        ];

        if (playerObs) {
          parts.push(
            `drainGapMax=${Math.round(playerObs.drainGapMaxMs)}ms`,
            `drainGapAvg=${Math.round(playerObs.drainGapAvgMs)}ms`,
            `drainGap>=200ms=${playerObs.drainGapOver200Ms}`,
          );
        }

        appendDebugInfoLine(parts.join(" | "));
        // Make each line represent the last turn, not the entire session.
        resetAudioObsCounters();
      } else {
        updateStatus("debugInfo", "Turn complete");
      }
      state.gemini.turnComplete = true;
      tryDeliverInjects();
      // Ensure backend supervisor triggers even if OUTPUT_TRANSCRIPTION text is empty.
      if (state.openclaw.connected) {
        openclawConnection.sendTurnComplete();
        debugLog("LIVE→OPENCLAW", "TURN_COMPLETE", {});
      }
      break;

    case MultimodalLiveResponseType.INTERRUPTED:
      console.log("Interrupted");
      addMessage("[Interrupted]", "system");
      if (state.audio.player) state.audio.player.interrupt();
      break;

    case MultimodalLiveResponseType.RESPONSE_REJECTED:
      console.log("🚫 RESPONSE_REJECTED - Gemini refused to respond (proactiveAudio)");
      addMessage("[REJECTED] Gemini 拒绝响应", "system");
      // Unblock the inject gate — without this, all future injects are stuck.
      state.gemini.turnComplete = true;
      tryDeliverInjects();
      break;
  }
}

function tryDeliverInjects() {
  if (!state.client) return;
  if (!globalThis.OpenClawInjectDelivery?.deliverNextInject) {
    console.error("Inject delivery helper missing: inject-delivery.js not loaded");
    return;
  }

  globalThis.OpenClawInjectDelivery.deliverNextInject({
    client: state.client,
    audioPlayer: state.audio.player,
    state,
    onError: (err) => console.error("Inject delivery failed:", err),
  });
}

// Connection handlers
function handleOpen() {
  updateStatus("connectionStatus", "Connected");
}

function handleClose() {
  updateStatus("connectionStatus", "Disconnected");
  disconnect();
}

function handleError(error) {
  console.error("Error:", error);
  updateStatus("connectionStatus", "Error: " + error);
  updateStatus("debugInfo", "Error: " + error);
}

// Toggle audio
async function toggleAudio() {
  if (!state.audio.isStreaming) {
    try {
      // Initialize streamer if needed
      if (!state.audio.streamer && state.client) {
        state.audio.streamer = new AudioStreamer(state.client);
      }

      if (state.audio.streamer) {
        // Get selected microphone device ID
        const selectedMicId = elements.micSelect.value;
        await state.audio.streamer.start(selectedMicId);
        state.audio.isStreaming = true;
        elements.startAudioBtn.textContent = "Stop Audio";
        addMessage("[Microphone on]", "system");
      } else {
        addMessage("[Connect to Gemini first]", "system");
      }
    } catch (error) {
      addMessage("[Audio error: " + error.message + "]", "system");
    }
  } else {
    if (state.audio.streamer) state.audio.streamer.stop();
    state.audio.isStreaming = false;
    elements.startAudioBtn.textContent = "Start Audio";
    addMessage("[Microphone off]", "system");
  }
}

// Toggle video
async function toggleVideo() {
  if (!state.video.isStreaming) {
    try {
      // Initialize streamer if needed
      if (!state.video.streamer && state.client) {
        state.video.streamer = new VideoStreamer(state.client);
      }

      if (state.video.streamer) {
        // Get selected camera device ID
        const selectedCameraId = elements.cameraSelect.value;
        const video = await state.video.streamer.start({
          fps: 1,
          width: 640,
          height: 480,
          deviceId: selectedCameraId || null,
        });
        state.video.isStreaming = true;

        elements.videoPreview.srcObject = video.srcObject;
        elements.videoPreview.hidden = false;
        elements.startVideoBtn.textContent = "Stop Video";
        addMessage("[Camera on]", "system");
      } else {
        addMessage("[Connect to Gemini first]", "system");
      }
    } catch (error) {
      addMessage("[Video error: " + error.message + "]", "system");
    }
  } else {
    if (state.video.streamer) state.video.streamer.stop();
    state.video.isStreaming = false;

    elements.videoPreview.srcObject = null;
    elements.videoPreview.hidden = true;
    elements.startVideoBtn.textContent = "Start Video";
    addMessage("[Camera off]", "system");
  }
}

// Toggle screen
async function toggleScreen() {
  if (!state.screen.isSharing) {
    try {
      // Initialize capture if needed
      if (!state.screen.capture && state.client) {
        state.screen.capture = new ScreenCapture(state.client);
      }

      if (state.screen.capture) {
        const video = await state.screen.capture.start({ fps: 0.5 });
        state.screen.isSharing = true;

        // Show screen preview in the same video element
        elements.videoPreview.srcObject = video.srcObject;
        elements.videoPreview.hidden = false;
        elements.startScreenBtn.textContent = "Stop Sharing";
        addMessage("[Screen sharing on]", "system");
      } else {
        addMessage("[Connect to Gemini first]", "system");
      }
    } catch (error) {
      addMessage("[Screen share error: " + error.message + "]", "system");
    }
  } else {
    if (state.screen.capture) state.screen.capture.stop();
    state.screen.isSharing = false;

    // Hide preview if not using camera
    if (!state.video.isStreaming) {
      elements.videoPreview.srcObject = null;
      elements.videoPreview.hidden = true;
    }

    elements.startScreenBtn.textContent = "Share Screen";
    addMessage("[Screen sharing off]", "system");
  }
}

// Send message
function sendMessage() {
  const message = elements.chatInput.value.trim();
  if (!message) return;

  if (state.client) {
    addMessage(message, "user");
    state.client.sendTextMessage(message);
    elements.chatInput.value = "";
  } else {
    addMessage("[Connect to Gemini first]", "system");
  }
}

// Add message to chat
function addMessage(text, type, append = false) {
  // Get all div children (messages)
  const messages = elements.chatContainer.querySelectorAll("div");
  const lastMessage = messages[messages.length - 1];

  // Check if we should append to the last message
  if (append && lastMessage && lastMessage.className === type) {
    // Append to existing message of the same type
    lastMessage.textContent += text;
  } else {
    // Create new message
    const message = createMessage(text, type);
    elements.chatContainer.appendChild(message);
  }

  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
}

// Update volume
function updateVolume() {
  const value = elements.volume.value;
  const volume = value / 100;
  if (state.audio.player) {
    state.audio.player.setVolume(volume);
  }
  updateStatus("volumeValue", value + "%");
}

// Update temperature display
function updateTemperature() {
  const value = elements.temperature.value;
  updateStatus("temperatureValue", value);
}

// Event listeners
function initEventListeners() {
  // Single-button start: OpenClaw → capsule → Gemini (tool registered in setup)
  if (elements.startBtn) {
    elements.startBtn.addEventListener("click", start);
  }
  elements.startAudioBtn.addEventListener("click", toggleAudio);
  elements.startVideoBtn.addEventListener("click", toggleVideo);
  elements.startScreenBtn.addEventListener("click", toggleScreen);
  elements.sendBtn.addEventListener("click", sendMessage);
  elements.volume.addEventListener("input", updateVolume);
  elements.temperature.addEventListener("input", updateTemperature);

  elements.chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendMessage();
  });
}

// Initialize
window.addEventListener("DOMContentLoaded", () => {
  initDOM();
  initEventListeners();
  populateMediaDevices();
  updateStatus("debugInfo", "Application initialized");
});
