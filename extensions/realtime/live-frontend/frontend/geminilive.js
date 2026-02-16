/**
 * Gemini Live API Utilities
 * Based on multimodalLiveApi.ts - converted to JavaScript
 */

// Response type constants
const MultimodalLiveResponseType = {
  TEXT: "TEXT",
  AUDIO: "AUDIO",
  SETUP_COMPLETE: "SETUP COMPLETE",
  INTERRUPTED: "INTERRUPTED",
  TURN_COMPLETE: "TURN COMPLETE",
  RESPONSE_REJECTED: "RESPONSE_REJECTED",
  TOOL_CALL: "TOOL_CALL",
  ERROR: "ERROR",
  INPUT_TRANSCRIPTION: "INPUT_TRANSCRIPTION",
  OUTPUT_TRANSCRIPTION: "OUTPUT_TRANSCRIPTION",
};

/**
 * Parses response messages from the Gemini Live API
 */
class MultimodalLiveResponseMessage {
  constructor(data) {
    this.data = "";
    this.type = "";
    this.endOfTurn = false;

    console.log("raw message data: ", data);
    this.endOfTurn = data?.serverContent?.turnComplete;

    const parts = data?.serverContent?.modelTurn?.parts;

    try {
      if (data?.setupComplete) {
        console.log("🏁 SETUP COMPLETE response", data);
        this.type = MultimodalLiveResponseType.SETUP_COMPLETE;
      } else if (data?.serverContent?.turnComplete) {
        // Check for RESPONSE_REJECTED reason
        const reason = data?.serverContent?.turnCompleteReason;
        if (reason === "RESPONSE_REJECTED") {
          console.log("🚫 RESPONSE_REJECTED - Gemini refused to respond");
          this.type = MultimodalLiveResponseType.RESPONSE_REJECTED;
        } else {
          console.log("🏁 TURN COMPLETE response");
          this.type = MultimodalLiveResponseType.TURN_COMPLETE;
        }
      } else if (data?.serverContent?.interrupted) {
        console.log("🗣️ INTERRUPTED response");
        this.type = MultimodalLiveResponseType.INTERRUPTED;
      } else if (data?.serverContent?.inputTranscription) {
        console.log("📝 INPUT TRANSCRIPTION:", data.serverContent.inputTranscription);
        this.type = MultimodalLiveResponseType.INPUT_TRANSCRIPTION;
        this.data = {
          text: data.serverContent.inputTranscription.text || "",
          finished: data.serverContent.inputTranscription.finished || false,
        };
      } else if (data?.serverContent?.outputTranscription) {
        console.log("📝 OUTPUT TRANSCRIPTION:", data.serverContent.outputTranscription);
        this.type = MultimodalLiveResponseType.OUTPUT_TRANSCRIPTION;
        this.data = {
          text: data.serverContent.outputTranscription.text || "",
          finished: data.serverContent.outputTranscription.finished || false,
        };
      } else if (data?.toolCall) {
        console.log("🎯 🛠️ TOOL CALL response", data?.toolCall);
        this.type = MultimodalLiveResponseType.TOOL_CALL;
        this.data = data?.toolCall;
      } else if (parts?.length && parts[0].text) {
        console.log("💬 TEXT response", parts[0].text);
        this.data = parts[0].text;
        this.type = MultimodalLiveResponseType.TEXT;
      } else if (parts?.length && parts[0].inlineData) {
        console.log("🔊 AUDIO response");
        this.data = parts[0].inlineData.data;
        this.type = MultimodalLiveResponseType.AUDIO;
      }
    } catch {
      console.log("⚠️ Error parsing response data: ", data);
    }
  }
}

/**
 * Function call definition for tool use
 */
class FunctionCallDefinition {
  /**
   * @param {string} name - Function name
   * @param {string} description - Function description
   * @param {object} parameters - Parameter schema
   * @param {string[]} requiredParameters - Required parameter names
   * @param {string} [behavior] - Optional: "NON_BLOCKING" for async tools
   */
  constructor(name, description, parameters, requiredParameters, behavior = null) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.requiredParameters = requiredParameters;
    this.behavior = behavior; // "NON_BLOCKING" allows async execution
  }

  functionToCall(parameters) {
    console.log("▶️Default function call");
  }

  getDefinition() {
    const definition = {
      name: this.name,
      description: this.description,
      parameters: { required: this.requiredParameters, ...this.parameters },
    };

    // Add behavior for async (NON_BLOCKING) tools
    if (this.behavior) {
      definition.behavior = this.behavior;
    }

    console.log("created FunctionDefinition: ", definition);
    return definition;
  }

  runFunction(parameters) {
    console.log(`⚡ Running ${this.name} function with parameters: ${JSON.stringify(parameters)}`);
    this.functionToCall(parameters);
  }
}

/**
 * Main Gemini Live API client
 */
class GeminiLiveAPI {
  constructor(proxyUrl, projectId, model) {
    this.proxyUrl = proxyUrl;
    this.projectId = projectId;
    this.model = model;
    this.modelUri = `projects/${this.projectId}/locations/us-central1/publishers/google/models/${this.model}`;

    this.responseModalities = ["AUDIO"];
    this.systemInstructions = "";
    this.googleGrounding = false;
    this.enableAffectiveDialog = false; // Default affective dialog
    this.voiceName = "Puck"; // Default voice
    this.temperature = 1.0; // Default temperature
    this.proactivity = { proactiveAudio: false }; // Proactivity config
    this.inputAudioTranscription = false;
    this.outputAudioTranscription = false;
    this.enableFunctionCalls = false;
    this.functions = [];
    this.functionsMap = {};
    this.externalToolDeclarations = null; // If set, use these instead of getFunctionDefinitions()
    this.previousImage = null;
    this.totalBytesSent = 0;

    // Automatic activity detection settings with defaults
    this.automaticActivityDetection = {
      disabled: false,
      silence_duration_ms: 2000,
      prefix_padding_ms: 500,
      end_of_speech_sensitivity: "END_SENSITIVITY_UNSPECIFIED",
      start_of_speech_sensitivity: "START_SENSITIVITY_UNSPECIFIED",
    };

    this.activityHandling = "ACTIVITY_HANDLING_UNSPECIFIED";

    this.apiHost = "us-central1-aiplatform.googleapis.com";
    this.serviceUrl = `wss://${this.apiHost}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`;

    this.connected = false;
    this.webSocket = null;
    this.lastSetupMessage = null; // Store the last setup message

    // Default callbacks
    this.onReceiveResponse = (message) => {
      console.log("Default message received callback", message);
    };

    this.onConnectionStarted = () => {
      console.log("Default onConnectionStarted");
    };

    this.onErrorMessage = (message) => {
      alert(message);
      this.connected = false;
    };

    console.log("Created Gemini Live API object: ", this);
  }

  setProjectId(projectId) {
    this.projectId = projectId;
    this.modelUri = `projects/${this.projectId}/locations/us-central1/publishers/google/models/${this.model}`;
  }

  setSystemInstructions(newSystemInstructions) {
    console.log("setting system instructions: ", newSystemInstructions);
    this.systemInstructions = newSystemInstructions;
  }

  setGoogleGrounding(newGoogleGrounding) {
    console.log("setting google grounding: ", newGoogleGrounding);
    this.googleGrounding = newGoogleGrounding;
  }

  setResponseModalities(modalities) {
    this.responseModalities = modalities;
  }

  setVoice(voiceName) {
    console.log("setting voice: ", voiceName);
    this.voiceName = voiceName;
  }

  setProactivity(proactivity) {
    console.log("setting proactivity: ", proactivity);
    this.proactivity = proactivity;
  }

  setInputAudioTranscription(enabled) {
    console.log("setting input audio transcription: ", enabled);
    this.inputAudioTranscription = enabled;
  }

  setOutputAudioTranscription(enabled) {
    console.log("setting output audio transcription: ", enabled);
    this.outputAudioTranscription = enabled;
  }

  setEnableFunctionCalls(enabled) {
    console.log("setting enable function calls: ", enabled);
    this.enableFunctionCalls = enabled;
  }

  addFunction(newFunction) {
    this.functions.push(newFunction);
    this.functionsMap[newFunction.name] = newFunction;
    console.log("added function: ", newFunction);
  }

  callFunction(functionName, parameters) {
    const functionToCall = this.functionsMap[functionName];
    functionToCall.runFunction(parameters);
  }

  connect() {
    this.setupWebSocketToService();
  }

  disconnect() {
    if (this.webSocket) {
      this.webSocket.close();
      this.connected = false;
    }
  }

  sendMessage(message) {
    console.log("🟩 Sending message: ", message);
    if (this.webSocket && this.webSocket.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    }
  }

  onReceiveMessage(messageEvent) {
    console.log("Message received: ", messageEvent);
    const messageData = JSON.parse(messageEvent.data);
    const message = new MultimodalLiveResponseMessage(messageData);
    this.onReceiveResponse(message);
  }

  setupWebSocketToService() {
    console.log("connecting: ", this.proxyUrl);

    this.webSocket = new WebSocket(this.proxyUrl);

    this.webSocket.onclose = (event) => {
      console.log("websocket closed: ", event);
      this.connected = false;
      this.onErrorMessage("Connection closed");
    };

    this.webSocket.onerror = (event) => {
      console.log("websocket error: ", event);
      this.connected = false;
      this.onErrorMessage("Connection error");
    };

    this.webSocket.onopen = (event) => {
      console.log("websocket open: ", event);
      this.connected = true;
      this.totalBytesSent = 0;
      this.sendInitialSetupMessages();
      this.onConnectionStarted();
    };

    this.webSocket.onmessage = this.onReceiveMessage.bind(this);
  }

  getFunctionDefinitions() {
    console.log("🛠️ getFunctionDefinitions called");
    const tools = [];

    for (let index = 0; index < this.functions.length; index++) {
      const func = this.functions[index];
      tools.push(func.getDefinition());
    }
    return tools;
  }

  sendInitialSetupMessages() {
    const serviceSetupMessage = {
      service_url: this.serviceUrl,
    };
    this.sendMessage(serviceSetupMessage);

    // Prefer external tool declarations (from Bootstrap) over locally-built ones.
    // Local classes are still registered via addFunction() for execution (functionsMap).
    const tools = this.externalToolDeclarations || this.getFunctionDefinitions();
    if (this.externalToolDeclarations) {
      console.log("🛠️ Using Bootstrap tool declarations:", tools.length, "tools");
    }

    const sessionSetupMessage = {
      setup: {
        model: this.modelUri,
        generation_config: {
          response_modalities: this.responseModalities,
          temperature: this.temperature,
          speech_config: {
            voice_config: {
              prebuilt_voice_config: {
                voice_name: this.voiceName,
              },
            },
          },
        },
        system_instruction: { parts: [{ text: this.systemInstructions }] },
        tools: { function_declarations: tools },
        proactivity: this.proactivity,

        realtime_input_config: {
          automatic_activity_detection: this.automaticActivityDetection,
          activity_handling: this.activityHandling,
        },
      },
    };

    // Add transcription config if enabled
    if (this.inputAudioTranscription) {
      sessionSetupMessage.setup.input_audio_transcription = {};
    }
    if (this.outputAudioTranscription) {
      sessionSetupMessage.setup.output_audio_transcription = {};
    }

    if (this.googleGrounding) {
      sessionSetupMessage.setup.tools.google_search = {};
      // Currently can't have both Google Search with custom tools.
      console.log("Google Grounding enabled, removing custom function calls if any.");
      delete sessionSetupMessage.setup.tools.function_declarations;
    }

    // Add affective dialog if enabled
    if (this.enableAffectiveDialog) {
      sessionSetupMessage.setup.generation_config.enable_affective_dialog = true;
    }

    // Store the setup message for later access
    this.lastSetupMessage = sessionSetupMessage;

    console.log("sessionSetupMessage: ", sessionSetupMessage);
    this.sendMessage(sessionSetupMessage);
  }

  /**
   * Send a single text turn into conversation history.
   * IMPORTANT: role controls how the model interprets the turn.
   * - role="user": real user input
   * - role="model": non-user injected context (e.g. "大哥提醒") or restored model turns
   */
  sendTextMessage(text, opts = {}) {
    const role = opts.role || "user";
    const turnComplete = typeof opts.turnComplete === "boolean" ? opts.turnComplete : true;
    const textMessage = {
      client_content: {
        turns: [
          {
            role,
            parts: [{ text }],
          },
        ],
        turn_complete: turnComplete,
      },
    };
    this.sendMessage(textMessage);
  }

  /**
   * Send tool response back to Gemini
   * Format verified from Python SDK source: google/genai/live.py line 400-420
   * @param {string} toolCallId - The function call ID (required!)
   * @param {string} functionName - The function name
   * @param {object} response - The response object
   */
  sendToolResponse(toolCallId, functionName, response) {
    const message = {
      tool_response: {
        // snake_case (from SDK source)
        functionResponses: [
          // camelCase (from SDK source: convert_keys=True)
          {
            id: toolCallId, // Required per SDK validation
            name: functionName,
            response: response,
          },
        ],
      },
    };
    console.log("🔧 Sending tool response:", JSON.stringify(message, null, 2));
    this.sendMessage(message);
  }

  sendRealtimeInputMessage(data, mime_type) {
    const message = {
      realtime_input: {
        media_chunks: [
          {
            mime_type: mime_type,
            data: data,
          },
        ],
      },
    };
    this.sendMessage(message);
    this.addToBytesSent(data);
  }

  addToBytesSent(data) {
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);
    this.totalBytesSent += encodedData.length;
  }

  getBytesSent() {
    return this.totalBytesSent;
  }

  sendAudioMessage(base64PCM) {
    this.sendRealtimeInputMessage(base64PCM, "audio/pcm");
  }

  async sendImageMessage(base64Image, mime_type = "image/jpeg") {
    this.sendRealtimeInputMessage(base64Image, mime_type);
  }
}

console.log("loaded geminiLiveApi.js");
