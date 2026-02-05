/**
 * Main application script for Gemini Live API Demo
 * Handles UI interactions, media streaming, and communication with Gemini API
 */

// Global state
const state = {
  client: null,
  audio: { streamer: null, player: null, isStreaming: false },
  video: { streamer: null, isStreaming: false },
  screen: { capture: null, isSharing: false },
  openclaw: { connected: false, liveMemoryCapsule: "" },
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
  pendingInjects: [],
};

// Debug logger for tracking message flow
function debugLog(direction, eventType, data = {}) {
  const ts = new Date().toISOString().slice(11, 23);
  const dataStr = Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' | ');
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
    "enableGrounding",
    "enableAffectiveDialog",
    "enableAlertTool",
    "enableCssStyleTool",
    "enableOpenClawTool",
    "openclawUrl",
    "openclawStatus",
    "connectOpenClawBtn",
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
    "connectBtn",
    "disconnectBtn",
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
  ];

  ids.forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

// Populate media device selectors
async function populateMediaDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    // Clear existing options
    elements.micSelect.innerHTML =
      '<option value="">Default Microphone</option>';
    elements.cameraSelect.innerHTML =
      '<option value="">Default Camera</option>';

    // Add audio input devices
    devices
      .filter((device) => device.kind === "audioinput")
      .forEach((device) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent =
          device.label || `Microphone ${device.deviceId.substr(0, 8)}`;
        elements.micSelect.appendChild(option);
      });

    // Add video input devices
    devices
      .filter((device) => device.kind === "videoinput")
      .forEach((device) => {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent =
          device.label || `Camera ${device.deviceId.substr(0, 8)}`;
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
  const httpUrl = url.replace("ws://", "http://").replace("/ws", "");
  
  try {
    updateStatus("openclawStatus", "Connecting...");
    
    // First, fetch bootstrap data (Live memory capsule)
    try {
      const bootstrapResp = await fetch(`${httpUrl}/api/realtime/bootstrap`);
      if (bootstrapResp.ok) {
        const bootstrap = await bootstrapResp.json();
        state.openclaw.liveMemoryCapsule = bootstrap.liveMemoryCapsule || "";
        console.log("🦞 Bootstrap loaded:", { 
          liveMemoryCapsule: state.openclaw.liveMemoryCapsule.slice(0, 120) + "..."
        });
      }
    } catch (e) {
      console.warn("Failed to fetch bootstrap:", e);
    }
    
    // Connect WebSocket
    await openclawConnection.connect(url);
    state.openclaw.connected = true;
    updateStatus("openclawStatus", "Connected ✓");
    
    // Set up callbacks
    openclawConnection.onHelpResult = (callId, reply) => {
      console.log(`🦞 Help result for ${callId}:`, reply);
      debugLog("OPENCLAW→LIVE", "HELP_RESULT", { callId: callId, reply: reply.slice(0, 50) + "..." });
      // Send tool response back to Gemini with official format
      // See: https://ai.google.dev/api/live#BidiGenerateContentToolResponse
      if (state.client) {
        debugLog("LIVE→GEMINI", "TOOL_RESPONSE", {
          id: callId,
          name: "openclaw_help",
          response: reply.slice(0, 50) + "...",
        });
        state.client.sendToolResponse(
          callId,
          "openclaw_help", // Function name is required per API docs
          { result: reply },
        );
        addMessage(`[OpenClaw] ${reply}`, "system");
      }
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
  }
}

// Build system instructions with OpenClaw context
function buildSystemInstructions() {
  let instructions = elements.systemInstructions.value || "";
  
  // If OpenClaw is connected and we have a capsule, enhance instructions safely.
  // IMPORTANT: never embed full USER.md / MEMORY.md here — it causes Live prompt pollution.
  if (state.openclaw.connected && state.openclaw.liveMemoryCapsule) {
    instructions += `

${state.openclaw.liveMemoryCapsule}
`;
  }
  
  return instructions;
}

// Connect to Gemini
async function connect() {
  const proxyUrl = elements.proxyUrl.value || null;
  const projectId = elements.projectId.value;
  const model = elements.model.value;

  if (!proxyUrl && !projectId) {
    alert("Please provide either a Proxy URL and Project ID");
    return;
  }

  try {
    updateStatus("connectionStatus", "Connecting...");

    // Create GeminiLiveAPI instance directly
    state.client = new GeminiLiveAPI(proxyUrl, projectId, model);

    // Configure settings - use enhanced instructions if OpenClaw connected
    state.client.systemInstructions = buildSystemInstructions();
    state.client.inputAudioTranscription =
      elements.enableInputTranscription.checked;
    state.client.outputAudioTranscription =
      elements.enableOutputTranscription.checked;
    state.client.googleGrounding = elements.enableGrounding.checked;
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

    // Add custom tools only if Google grounding is disabled
    const isGroundingEnabled = elements.enableGrounding.checked;

    if (!isGroundingEnabled) {
      // Add alert tool if enabled
      if (elements.enableAlertTool.checked) {
        const alertTool = new ShowAlertTool();
        state.client.addFunction(alertTool);
        console.log("✅ Alert tool enabled");
      }

      // Add CSS style tool if enabled
      if (elements.enableCssStyleTool.checked) {
        const cssStyleTool = new AddCSSStyleTool();
        state.client.addFunction(cssStyleTool);
        console.log("✅ CSS style tool enabled");
      }
      
      // Add OpenClaw help tool if enabled and connected
      if (elements.enableOpenClawTool?.checked && state.openclaw.connected) {
        const openclawTool = new OpenClawHelpTool(openclawConnection);
        state.client.addFunction(openclawTool);
        console.log("✅ OpenClaw help tool enabled");
      }
    } else {
      console.log(
        "⚠️ Custom tools disabled due to Google grounding being enabled"
      );
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
    await state.audio.player.init();

    updateStatus("debugInfo", "Connected successfully");
  } catch (error) {
    console.error("Connection failed:", error);
    updateStatus("connectionStatus", "Connection failed: " + error.message);
    updateStatus("debugInfo", "Error: " + error.message);
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
          debugLog("LIVE→OPENCLAW", "TRANSCRIPT_USER", { text: state.pendingUserTranscript.slice(0, 50) });
        }
        state.pendingUserTranscript = "";  // Reset
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
          debugLog("LIVE→OPENCLAW", "TRANSCRIPT_LIVE", { text: state.pendingLiveTranscript.slice(0, 50) });
        }
        state.pendingLiveTranscript = "";  // Reset
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
          2
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
        
        debugLog("GEMINI→LIVE", "TOOL_CALL", { geminiId: functionCall.id, usedId: functionCallId, name: functionName, args: parameters });
        
        // Special handling for OpenClaw help tool (async)
        if (functionName === "openclaw_help") {
          addMessage(`[Asking OpenClaw: ${parameters.request}]`, "system");
          const tool = state.client.functionsMap[functionName];
          if (tool) {
            tool.functionToCall(parameters, functionCallId);
            // Response will be sent via openclawConnection.onHelpResult callback
          }
        } else {
          // Sync tools - call immediately
          state.client.callFunction(functionName, parameters);
        }
      }
      break;

    case MultimodalLiveResponseType.TURN_COMPLETE:
      console.log("Turn complete:", message.data);
      debugLog("GEMINI→LIVE", "TURN_COMPLETE", {});
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
            `drainGap>=200ms=${playerObs.drainGapOver200Ms}`
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
  }
}

function tryDeliverInjects() {
  if (!state.client) return;
  if (!state.gemini.turnComplete) return;
  if (!state.pendingInjects.length) return;

  // Deliver at most one inject per TURN_COMPLETE to avoid spamming Gemini.
  const reply = state.pendingInjects.shift();
  state.injectChain = state.injectChain
    .then(async () => {
      if (!state.client) return;
      // Gemini finished its turn; still wait for local playback to fully drain.
      if (state.audio.player && typeof state.audio.player.waitForIdle === "function") {
        await state.audio.player.waitForIdle();
      }
      // Mark as in-progress until the next TURN_COMPLETE arrives.
      state.gemini.turnComplete = false;
      // IMPORTANT: inject is NOT user input. Send as role=model with a stable tag.
      state.client.sendTextMessage(`【大哥提醒】 ${reply}`, { role: "model" });
    })
    .catch((err) => {
      console.error("Inject delivery failed:", err);
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
  elements.connectBtn.addEventListener("click", connect);
  elements.disconnectBtn.addEventListener("click", disconnect);
  
  // OpenClaw connection
  if (elements.connectOpenClawBtn) {
    elements.connectOpenClawBtn.addEventListener("click", connectOpenClaw);
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
