/**
 * Realtime WebSocket Server
 *
 * Handles connections from Gemini Live clients:
 * - Receives transcripts and help requests
 * - Returns help results and inject messages
 * - Broadcasts prompt updates
 */

import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Message types from Live
export type LiveMessage =
  | { type: "transcript"; role: "user" | "live"; text: string }
  | { type: "help"; request: string; callId: string };

// Message types to Live
export type OpenClawMessage =
  | { type: "help_result"; callId: string; reply: string }
  | { type: "inject"; reply: string }
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
}

export async function startRealtimeServer(params: {
  port: number;
  api: OpenClawPluginApi;
}): Promise<RealtimeServer> {
  const { port, api } = params;
  const clients = new Map<string, RealtimeClient>();

  // Create HTTP server
  const httpServer = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", clients: clients.size }));
      return;
    }

    // Bootstrap endpoint
    if (req.url === "/api/realtime/bootstrap" && req.method === "GET") {
      handleBootstrap(req, res, api);
      return;
    }

    // 404 for other routes
    res.writeHead(404);
    res.end("Not Found");
  });

  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    const sessionId = `realtime:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const client: RealtimeClient = {
      ws,
      sessionId,
      conversation: [],
    };
    clients.set(sessionId, client);

    api.logger.info(`[realtime] Client connected: ${sessionId}`);

    // Send connected message
    sendToClient(ws, { type: "connected", sessionId });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as LiveMessage;
        handleMessage(client, msg, api);
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
      // Record conversation
      const prefix = msg.role === "user" ? "用户" : "Live";
      client.conversation.push(`${prefix}: ${msg.text}`);
      api.logger.info(`[realtime] ${client.sessionId} | ${prefix}: ${msg.text}`);
      break;
    }

    case "help": {
      api.logger.info(`[realtime] ${client.sessionId} | Help request: ${msg.request}`);

      // TODO: Call OpenClaw agent to handle the request
      // For now, return a placeholder response
      const reply = await handleHelpRequest(client, msg.request, api);

      sendToClient(client.ws, {
        type: "help_result",
        callId: msg.callId,
        reply,
      });
      break;
    }

    default:
      api.logger.warn(`[realtime] Unknown message type: ${(msg as { type: string }).type}`);
  }
}

async function handleHelpRequest(
  client: RealtimeClient,
  request: string,
  api: OpenClawPluginApi,
): Promise<string> {
  // TODO: Implement actual agent call
  // This should:
  // 1. Create a session with sessionKey = client.sessionId
  // 2. Call the agent with backend mode
  // 3. Return the response

  // Placeholder implementation
  api.logger.info(`[realtime] Processing help request: ${request}`);

  // For now, return a simple response
  return `收到请求：${request}。这是一个占位响应，完整实现需要集成 OpenClaw Agent。`;
}

function handleBootstrap(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  api: OpenClawPluginApi,
) {
  // TODO: Read USER.md and MEMORY.md to build initial system prompt
  const response = {
    systemPrompt: `你是用户的语音助手。

## 用户画像
{待从 USER.md 加载}

## 重要记忆
{待从 MEMORY.md 加载}

## 规则
1. 日常对话直接回答
2. 复杂任务 → 说确认语，调用 openclaw_help
3. 收到后台回复后自然说出来

后台会自己处理记忆等事情，你不用管。`,
    userProfile: "",
    memorySummary: "",
  };

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(response));
}
