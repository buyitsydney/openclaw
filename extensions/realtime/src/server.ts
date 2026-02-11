/**
 * Realtime WebSocket Server
 *
 * Handles connections from Gemini Live clients:
 * - Receives transcripts and help requests
 * - Returns help results and inject messages
 * - Broadcasts prompt updates
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { loadCoreAgentDeps, type CoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import { buildBackendModePrompt } from "./prompt.js";
// TurnAssembler removed - Supervisor architecture replaced by Help-only model
import { generateLiveMemoryCapsule } from "./live-memory-capsule-agent.js";

// Message types from Live
export type LiveMessage =
  | { type: "transcript"; role: "user" | "live"; text: string }
  | { type: "help"; request: string; callId: string }
  | { type: "turn_complete" }
  | { type: "gemini_event"; event: string; data: unknown; timestamp: number };

// Message types to Live
export type OpenClawMessage =
  | { type: "help_result"; callId: string; reply: string }
  | { type: "prompt_update"; section: string; content: string }
  | { type: "connected"; sessionId: string };

export interface RealtimeServer {
  port: number;
  broadcast: (msg: OpenClawMessage) => void;
  getConversation: (sessionId: string) => string;
  close: () => Promise<void>;
}

interface RealtimeClient {
  ws: WebSocket;
  sessionId: string;
  conversation: string[];
  agentSessionId?: string; // UUID for agent session
  agentId: string; // Agent ID for multi-agent routing
}

// Session entry type (matches OpenClaw's session store)
interface SessionEntry {
  sessionId: string;
  updatedAt: number;
}

// Cached core dependencies
let coreDeps: CoreAgentDeps | null = null;

// Per-agent capsule cache to prevent memory leakage between agents
const cachedCapsules = new Map<string, { text: string; hash: string; updatedAt: number }>();
const capsulesInFlight = new Map<string, Promise<{ text: string; hash: string }>>();

const LIVE_MEMORY_CAPSULE_PROMPT_VERSION = "v3.1";

// ---------------------------------------------------------------------------
// Gemini Live config for native app Bootstrap
// ---------------------------------------------------------------------------
const GEMINI_PROJECT_ID = "gen-lang-client-0519229117";
const GEMINI_MODEL = "gemini-live-2.5-flash-native-audio";
const GEMINI_SERVICE_URL =
  "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent";

/** Her system prompt for Gemini Live (canonical source; mobile-script.js mirrors this). */
const HER_SYSTEM_PROMPT = `你是 Her，车载语音助手，负责快思考。用户正在开车。

## 你的身份
- 你是用户的贴心助手，温柔、自然
- 如果知道用户名字（见下方画像），要亲切称呼
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
- 导航：start_navigation（destination: 地点名, address: 可选详细地址）— 只有用户明确要求"去/导航到"某地时才调用

严格规则：
- 任何涉及空调、座椅、车窗、导航的操作，必须调用 car_control 工具，不能只用嘴说"已打开"
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

/** Tool declarations for Gemini Live (vendor's native app sends these as-is). */
const TOOL_DECLARATIONS = [
  {
    name: "openclaw_help",
    description:
      "当需要执行复杂任务时调用此工具，如：搜索信息、查询天气、执行计算、访问用户记忆等。OpenClaw 后台会处理这些请求并返回结果。",
    parameters: {
      required: ["request"],
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "需要后台处理的请求描述，用自然语言说明你需要什么帮助",
        },
      },
    },
  },
  {
    name: "car_control",
    description:
      "控制车辆功能。用户说'开空调'、'调到25度'、'打开座椅加热'、'关窗户'等车控指令时调用此工具。",
    parameters: {
      required: ["action"],
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "操作类型: set_ac_temperature | set_ac_power | set_ac_mode | set_seat_heat | set_window | start_navigation",
        },
        params: {
          type: "object",
          description:
            "操作参数，如 {temperature: 25}、{on: true}、{mode: 'cool'}、{seat: 'driver', level: 2}、{position: 'driver', open: true}、{destination: '锦里老灶火锅', address: '人民路123号'}",
        },
      },
    },
  },
];

/** Build the complete Bootstrap response including Gemini proxy config for native apps. */
function buildBootstrapResponse(capsuleText: string) {
  const modelUri = `projects/${GEMINI_PROJECT_ID}/locations/us-central1/publishers/google/models/${GEMINI_MODEL}`;

  // Bake capsule into system prompt so native app gets a ready-to-send blob
  const fullSystemPrompt = capsuleText
    ? HER_SYSTEM_PROMPT.replace(
        "（由系统自动注入 liveMemoryCapsule）",
        capsuleText,
      )
    : HER_SYSTEM_PROMPT;

  return {
    // Backward compat: existing web frontend reads this field directly
    liveMemoryCapsule: capsuleText,
    // Native app config: vendor sends these JSON blobs as-is to the Gemini proxy
    geminiProxy: {
      serviceSetup: {
        service_url: GEMINI_SERVICE_URL,
      },
      sessionSetup: {
        setup: {
          model: modelUri,
          generation_config: {
            response_modalities: ["AUDIO"],
            temperature: 1,
            speech_config: {
              voice_config: {
                prebuilt_voice_config: { voice_name: "Puck" },
              },
            },
            enable_affective_dialog: true,
          },
          system_instruction: {
            parts: [{ text: fullSystemPrompt }],
          },
          tools: {
            function_declarations: TOOL_DECLARATIONS,
          },
          realtime_input_config: {
            automatic_activity_detection: {
              disabled: false,
              silence_duration_ms: 500,
              prefix_padding_ms: 500,
            },
          },
          input_audio_transcription: {},
          output_audio_transcription: {},
        },
      },
    },
  };
}

/** Extract agentId from a URL query string, falling back to the default agent. */
function resolveAgentIdFromUrl(
  urlStr: string | undefined,
  defaultAgentId: string,
): string {
  if (!urlStr) return defaultAgentId;
  try {
    const parsed = new URL(urlStr, "http://localhost");
    return parsed.searchParams.get("agentId")?.trim() || defaultAgentId;
  } catch {
    return defaultAgentId;
  }
}

export async function startRealtimeServer(params: {
  port: number;
  api: OpenClawPluginApi;
  defaultAgentId?: string;
}): Promise<RealtimeServer> {
  const { port, api } = params;
  const defaultAgentId = params.defaultAgentId ?? "main";
  const clients = new Map<string, RealtimeClient>();

  // Create HTTP server
  const httpServer = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", clients: clients.size }));
      return;
    }

    // CORS preflight for cross-origin requests (e.g. vendor-fe → vendor API)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Bootstrap endpoint (support query params like ?agentId=xxx)
    if (req.url?.startsWith("/api/realtime/bootstrap") && req.method === "GET") {
      handleBootstrap(req, res, api, defaultAgentId);
      return;
    }

    // 404 for other routes
    res.writeHead(404);
    res.end("Not Found");
  });

  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const agentId = resolveAgentIdFromUrl(req.url, defaultAgentId);
    const sessionId = `realtime:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const client: RealtimeClient = {
      ws,
      sessionId,
      conversation: [],
      agentId,
    };
    clients.set(sessionId, client);

    api.logger.info(`[realtime] Client connected: ${sessionId} (agent=${agentId})`);

    // Send connected message
    sendToClient(ws, { type: "connected", sessionId });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as LiveMessage;
        void handleMessage(client, msg, api).catch((err) => {
          api.logger.error(`[realtime] handleMessage failed: ${String(err)}`);
        });
      } catch (err) {
        api.logger.error(`[realtime] Failed to parse message: ${err}`);
      }
    });

    ws.on("close", () => {
      clients.delete(sessionId);
      api.logger.info(`[realtime] Client disconnected: ${sessionId}`);
    });

    ws.on("error", (err) => {
      api.logger.error(`[realtime] WebSocket error: ${err}`);
    });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, () => {
      api.logger.info(`[realtime] Server listening on port ${port}`);
      resolve();
    });
  });

  return {
    port,
    broadcast: (msg: OpenClawMessage) => {
      const frame = JSON.stringify(msg);
      for (const client of clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(frame);
        }
      }
    },
    getConversation: (sessionId: string) => {
      const client = clients.get(sessionId);
      return client?.conversation.join("\n") ?? "";
    },
    close: async () => {
      // Close all WebSocket connections
      for (const client of clients.values()) {
        client.ws.close(1000, "Server shutting down");
      }
      clients.clear();

      // Close HTTP server
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

function sendToClient(ws: WebSocket, msg: OpenClawMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function handleMessage(
  client: RealtimeClient,
  msg: LiveMessage,
  api: OpenClawPluginApi,
) {
  switch (msg.type) {
    case "transcript": {
      // Record conversation for Help context
      const prefix = msg.role === "user" ? "用户" : "Live";
      client.conversation.push(`${prefix}: ${msg.text}`);
      api.logger.info(`[realtime] ${client.sessionId} | ${prefix}: ${msg.text}`);
      break;
    }

    case "turn_complete": {
      // Log turn complete for debugging; no Supervisor in new architecture
      api.logger.info(`[realtime] ${client.sessionId} | Turn complete`);
      break;
    }

    case "help": {
      api.logger.info(`[realtime] ${client.sessionId} | Help request: ${msg.request}`);

      // Record help request to conversation for context
      client.conversation.push(`[Her→OpenClaw]: ${msg.request}`);

      const reply = await handleHelpRequest(client, msg.request, api);

      // Record help result to conversation
      client.conversation.push(`[OpenClaw→Her]: ${reply}`);

      sendToClient(client.ws, {
        type: "help_result",
        callId: msg.callId,
        reply,
      });
      break;
    }

    case "gemini_event": {
      // Log all Gemini events to file for debugging
      const logLine = JSON.stringify({
        sessionId: client.sessionId,
        timestamp: msg.timestamp,
        event: msg.event,
        data: msg.data,
      });
      api.logger.info(`[realtime] ${client.sessionId} | Gemini: ${msg.event}`);
      
      // Append to session log file
      const logFile = `/tmp/realtime-${client.sessionId}.jsonl`;
      await fs.appendFile(logFile, logLine + "\n");
      break;
    }

    default:
      api.logger.warn(`[realtime] Unknown message type: ${(msg as { type: string }).type}`);
  }
}

function tailConversationLines(lines: string[], maxChars: number): string {
  if (lines.length === 0) {
    return "";
  }
  let acc = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const next = acc ? `${line}\n${acc}` : line;
    if (next.length > maxChars) {
      break;
    }
    acc = next;
  }
  return acc;
}

async function handleHelpRequest(
  client: RealtimeClient,
  request: string,
  api: OpenClawPluginApi,
): Promise<string> {
  api.logger.info(`[realtime] Processing help request: ${request}`);

  try {
    // Load core dependencies (cached after first call)
    if (!coreDeps) {
      api.logger.info("[realtime] Loading core dependencies...");
      coreDeps = await loadCoreAgentDeps();
    }

    const cfg = api.config as CoreConfig;
    const agentId = client.agentId;

    // Resolve paths
    const storePath = coreDeps.resolveStorePath(cfg.session?.store, { agentId });
    const agentDir = coreDeps.resolveAgentDir(cfg, agentId);
    const workspaceDir = coreDeps.resolveAgentWorkspaceDir(cfg, agentId);

    // Ensure workspace exists
    await coreDeps.ensureAgentWorkspace({ dir: workspaceDir });

    // Load or create session
    const sessionStore = coreDeps.loadSessionStore(storePath);
    const sessionKey = client.sessionId; // Use realtime session ID as key

    let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;
    if (!sessionEntry) {
      // Create new session
      const agentSessionId = crypto.randomUUID();
      sessionEntry = {
        sessionId: agentSessionId,
        updatedAt: Date.now(),
      };
      sessionStore[sessionKey] = sessionEntry;
      await coreDeps.saveSessionStore(storePath, sessionStore);
      client.agentSessionId = agentSessionId;
      api.logger.info(`[realtime] Created new agent session: ${agentSessionId}`);
    } else {
      client.agentSessionId = sessionEntry.sessionId;
    }

    // Resolve session file path
    const sessionFile = coreDeps.resolveSessionFilePath(
      sessionEntry.sessionId,
      sessionEntry,
      { agentId },
    );

    // Build prompt with conversation context
    const conversationContext = client.conversation.join("\n");
    const prompt = `用户通过语音助手请求帮助：

## 对话上下文
${conversationContext || "（暂无之前的对话）"}

## 当前请求
${request}

请处理这个请求，返回给语音助手说的内容。`;

    // Build extra system prompt for backend mode
    const extraSystemPrompt = buildBackendModePrompt(conversationContext);

    // Resolve model configuration from config
    // Format: "provider/model" or "provider/vendor/model"
    const agentDefaults = (cfg as Record<string, unknown>).agents as
      | { defaults?: { model?: { primary?: string } } }
      | undefined;
    const modelRef = agentDefaults?.defaults?.model?.primary
      || `${coreDeps.DEFAULT_PROVIDER}/${coreDeps.DEFAULT_MODEL}`;

    // Parse provider/model (handle both "provider/model" and "provider/vendor/model")
    const parts = modelRef.split("/");
    const provider = parts[0] || coreDeps.DEFAULT_PROVIDER;
    const model = parts.slice(1).join("/") || coreDeps.DEFAULT_MODEL;

    const thinkLevel = coreDeps.resolveThinkingDefault({ cfg, provider, model });
    const timeoutMs = coreDeps.resolveAgentTimeoutMs({ cfg });

    api.logger.info(`[realtime] Calling agent with session ${sessionEntry.sessionId}, model: ${provider}/${model}`);

    // Call the agent
    const result = await coreDeps.runEmbeddedPiAgent({
      sessionId: sessionEntry.sessionId,
      sessionKey,
      messageProvider: "realtime",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt,
      provider,
      model,
      thinkLevel,
      verboseLevel: "off",
      timeoutMs,
      runId: `realtime:${client.sessionId}:${Date.now()}`,
      lane: "realtime",
      extraSystemPrompt,
      agentDir,
    });

    // Extract text reply
    const texts = (result.payloads ?? [])
      .filter((p) => p.text && !p.isError)
      .map((p) => p.text?.trim())
      .filter(Boolean);

    const replyText = texts.join(" ") || "抱歉，我暂时无法处理这个请求。";

    api.logger.info(`[realtime] Agent reply: ${replyText.slice(0, 100)}...`);

    return replyText;
  } catch (err) {
    api.logger.error(`[realtime] Failed to call agent: ${err}`);
    return `抱歉，处理请求时出错了：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleBootstrap(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  api: OpenClawPluginApi,
  defaultAgentId: string,
) {
  try {
    // Load core dependencies if not already loaded
    if (!coreDeps) {
      coreDeps = await loadCoreAgentDeps();
    }

    const cfg = api.config as CoreConfig;
    const agentId = resolveAgentIdFromUrl(req.url, defaultAgentId);
    const agentDir = coreDeps.resolveAgentDir(cfg, agentId);
    const workspaceDir = coreDeps.resolveAgentWorkspaceDir(cfg, agentId);

    // Read USER.md and MEMORY.md
    let userProfileMd = "";
    let memoryMd = "";

    try {
      userProfileMd = await fs.readFile(path.join(workspaceDir, "USER.md"), "utf-8");
    } catch {
      userProfileMd = "";
    }

    try {
      memoryMd = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
    } catch {
      memoryMd = "";
    }

    const sourceHash = crypto
      .createHash("sha256")
      .update(LIVE_MEMORY_CAPSULE_PROMPT_VERSION)
      .update("\n")
      .update(userProfileMd)
      .update("\n---\n")
      .update(memoryMd)
      .digest("hex");

    // Per-agent capsule cache: prevents memory leakage between agents
    const cached = cachedCapsules.get(agentId);
    if (cached && cached.hash === sourceHash) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(buildBootstrapResponse(cached.text)));
      return;
    }

    if (!capsulesInFlight.has(agentId)) {
      const flight = (async () => {
        const text = await generateLiveMemoryCapsule({
          coreDeps,
          cfg,
          agentId,
          agentDir,
          workspaceDir,
          userProfileMd,
          memoryMd,
        });
        return { text, hash: sourceHash };
      })().finally(() => {
        capsulesInFlight.delete(agentId);
      });
      capsulesInFlight.set(agentId, flight);
    }

    const capsule = await capsulesInFlight.get(agentId)!;
    cachedCapsules.set(agentId, { ...capsule, updatedAt: Date.now() });

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    // buildBootstrapResponse includes liveMemoryCapsule (backward compat)
    // plus geminiProxy.serviceSetup/sessionSetup for native apps.
    res.end(JSON.stringify(buildBootstrapResponse(capsule.text)));
  } catch (err) {
    api.logger.error(`[realtime] Bootstrap error: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}
