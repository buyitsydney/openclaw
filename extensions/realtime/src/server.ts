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
      res.end(JSON.stringify({ liveMemoryCapsule: cached.text }));
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

    const response = {
      // IMPORTANT: only send the capsule, never send full USER.md/MEMORY.md to the browser.
      liveMemoryCapsule: capsule.text,
    };

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(response));
  } catch (err) {
    api.logger.error(`[realtime] Bootstrap error: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}
