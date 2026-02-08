/**
 * Append a query param to a URL (works for both http(s) and ws(s) URLs).
 * If the param already exists, it will be replaced.
 */
function appendQueryParam(url, key, value) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

/**
 * Read the agentId from the current page URL query params.
 * Returns null if not present.
 */
function getAgentIdFromPageUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("agentId") || null;
  } catch {
    return null;
  }
}

/**
 * OpenClaw Help Tool
 * Forwards complex requests to OpenClaw backend for processing
 * This is an async tool - results come back via WebSocket
 */
class OpenClawHelpTool extends FunctionCallDefinition {
  constructor(openclawConnection) {
    super(
      "openclaw_help",
      "当需要执行复杂任务时调用此工具，如：搜索信息、查询天气、执行计算、访问用户记忆等。OpenClaw 后台会处理这些请求并返回结果。",
      {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "需要后台处理的请求描述，用自然语言说明你需要什么帮助"
          }
        }
      },
      ["request"]
      // Note: NON_BLOCKING behavior removed - may not be supported by current model
    );
    this.openclawConnection = openclawConnection;
    this.isAsync = true; // Mark as async tool
  }

  functionToCall(parameters, functionCallId) {
    const request = parameters.request || "";
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] LIVE→OPENCLAW     | HELP_REQUEST       | callId=${functionCallId} | request=${request}`);
    
    if (this.openclawConnection && this.openclawConnection.isConnected()) {
      // Send help request to OpenClaw
      this.openclawConnection.sendHelp(request, functionCallId);
      // Result will come back via WebSocket callback
      return { pending: true, callId: functionCallId };
    } else {
      console.error("❌ OpenClaw not connected");
      return { error: "OpenClaw 后台未连接，请先连接后台服务" };
    }
  }
}

/**
 * OpenClaw WebSocket Connection Manager
 * Handles connection to OpenClaw Realtime WebSocket server
 */
class OpenClawConnection {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.pendingCalls = new Map(); // callId -> { resolve, reject }
    this.onPromptUpdate = null; // Callback for prompt updates
    this.onTranscript = null; // Callback for transcript updates
  }

  connect(url = "ws://localhost:18790/ws", agentId = null) {
    return new Promise((resolve, reject) => {
      // Append agentId as query param if provided
      const wsUrl = agentId ? appendQueryParam(url, "agentId", agentId) : url;
      console.log(`🦞 Connecting to OpenClaw: ${wsUrl}`);
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        console.log("✅ OpenClaw connected");
        resolve();
      };
      
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          console.error("Failed to parse OpenClaw message:", e);
        }
      };
      
      this.ws.onerror = (err) => {
        console.error("❌ OpenClaw error:", err);
        reject(err);
      };
      
      this.ws.onclose = () => {
        console.log("🔌 OpenClaw disconnected");
        this.sessionId = null;
      };
    });
  }

  handleMessage(msg) {
    console.log("🦞 OpenClaw message:", msg.type);
    
    switch (msg.type) {
      case "connected":
        this.sessionId = msg.sessionId;
        console.log(`🦞 Session: ${this.sessionId}`);
        break;
        
      case "help_result":
        // Resolve pending call
        const pending = this.pendingCalls.get(msg.callId);
        if (pending) {
          pending.resolve(msg.reply);
          this.pendingCalls.delete(msg.callId);
        }
        // Also notify the callback if set
        if (this.onHelpResult) {
          this.onHelpResult(msg.callId, msg.reply);
        }
        break;
        
      case "inject":
        // OpenClaw wants to inject a message
        if (this.onInject) {
          this.onInject(msg.reply);
        }
        break;
        
      case "prompt_update":
        // System prompt section updated
        if (this.onPromptUpdate) {
          this.onPromptUpdate(msg.section, msg.content);
        }
        break;
    }
  }

  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  sendTranscript(role, text) {
    if (!this.isConnected()) return;
    this.ws.send(JSON.stringify({
      type: "transcript",
      role: role,
      text: text
    }));
  }

  sendTurnComplete() {
    if (!this.isConnected()) return;
    this.ws.send(JSON.stringify({
      type: "turn_complete"
    }));
  }

  sendHelp(request, callId) {
    if (!this.isConnected()) return;
    
    // Create a promise for this call
    const promise = new Promise((resolve, reject) => {
      this.pendingCalls.set(callId, { resolve, reject });
      
      // Timeout after 2 minutes
      setTimeout(() => {
        if (this.pendingCalls.has(callId)) {
          this.pendingCalls.delete(callId);
          reject(new Error("Timeout waiting for OpenClaw response"));
        }
      }, 120000);
    });
    
    this.ws.send(JSON.stringify({
      type: "help",
      request: request,
      callId: callId
    }));
    
    return promise;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Global OpenClaw connection instance
const openclawConnection = new OpenClawConnection();

/**
 * Show Alert Box Tool
 * Displays a browser alert dialog with a custom message
 */
class ShowAlertTool extends FunctionCallDefinition {
  constructor() {
    super(
      "show_alert",
      "Displays an alert dialog box with a message to the user",
      {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to display in the alert box"
          },
          title: {
            type: "string",
            description: "Optional title prefix for the alert message"
          }
        }
      },
      ["message"]
    );
  }

  functionToCall(parameters) {
    const message = parameters.message || "Alert!";
    const title = parameters.title;

    // Construct the full alert message
    const fullMessage = title ? `${title}: ${message}` : message;

    // Show the alert
    alert(fullMessage);

    console.log(` Alert shown: ${fullMessage}`);
  }
}
/**
 * Add CSS Style Tool
 * Injects CSS styles into the current page with !important flag
 */
class AddCSSStyleTool extends FunctionCallDefinition {
  constructor() {
    super(
      "add_css_style",
      "Injects CSS styles into the current page with !important flag",
      {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to target elements (e.g., 'body', '.class', '#id')"
          },
          property: {
            type: "string",
            description: "CSS property to set (e.g., 'background-color', 'font-size', 'display')"
          },
          value: {
            type: "string",
            description: "Value for the CSS property (e.g., 'red', '20px', 'none')"
          },
          styleId: {
            type: "string",
            description: "Optional ID for the style element (for updating existing styles)"
          }
        }
      },
      ["selector", "property", "value"]
    );
  }

  functionToCall(parameters) {
    const { selector, property, value, styleId } = parameters;

    // Create or find the style element
    let styleElement;
    if (styleId) {
      styleElement = document.getElementById(styleId);
      if (!styleElement) {
        styleElement = document.createElement('style');
        styleElement.id = styleId;
        document.head.appendChild(styleElement);
      }
    } else {
      styleElement = document.createElement('style');
      document.head.appendChild(styleElement);
    }

    // Create the CSS rule with !important
    const cssRule = `${selector} { ${property}: ${value} !important; }`;

    // Add the CSS rule to the style element
    if (styleId) {
      // If using an ID, replace the content
      styleElement.textContent = cssRule;
    } else {
      // Otherwise append to any existing content
      styleElement.textContent += cssRule;
    }

    console.log(`🎨 CSS style injected: ${cssRule}`);
    console.log(`   Applied to ${document.querySelectorAll(selector).length} element(s)`);
  }
}
