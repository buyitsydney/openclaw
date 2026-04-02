/**
 * Realtime Plugin - Gemini Live + OpenClaw Integration
 *
 * Provides real-time voice interaction through Gemini Live API,
 * with OpenClaw as the intelligent backend for complex tasks.
 */

import os from "node:os";
import path from "node:path";
import { normalizeAgentId, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { loadCoreAgentDeps, type CoreConfig } from "./src/core-bridge.js";
import { setupFileWatcher, type FileWatcher } from "./src/file-watcher.js";
import { buildBackendModePrompt } from "./src/prompt.js";
import { startRealtimeServer, type RealtimeServer } from "./src/server.js";

export interface RealtimeConfig {
  enabled?: boolean;
  port?: number;
  gemini?: {
    projectId?: string;
    model?: string;
    location?: string;
  };
}

// Singleton state - persists across plugin loads
let server: RealtimeServer | null = null;
let fileWatcher: FileWatcher | null = null;
let serverStarting = false;

type RealtimeAgentListEntry = {
  id?: string;
  default?: boolean;
};

type RealtimeRootConfig = CoreConfig & {
  agents?: {
    list?: RealtimeAgentListEntry[];
  };
};

function resolveDefaultAgentIdFromConfig(cfg: CoreConfig): string {
  const agentList = (cfg as RealtimeRootConfig).agents?.list;
  if (!Array.isArray(agentList) || agentList.length === 0) {
    return "main";
  }

  const defaultEntry = agentList.find((entry) => entry?.default) ?? agentList[0];
  return normalizeAgentId(defaultEntry?.id ?? "main");
}

const realtimePlugin = {
  id: "realtime",
  name: "Realtime Voice",
  description: "Gemini Live + OpenClaw realtime voice integration",
  version: "0.1.0",

  async activate(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as RealtimeConfig;

    // Check if enabled (default: true if config exists)
    if (config.enabled === false) {
      api.logger.info("[realtime] Plugin disabled by config");
      return;
    }

    const port = config.port ?? 18790;

    // Skip server startup if already running or starting
    // This prevents port conflicts when embedded agent loads plugins
    if (server !== null) {
      api.logger.info("[realtime] Server already running, skipping startup");
      return;
    }

    if (serverStarting) {
      api.logger.info("[realtime] Server is starting, skipping duplicate startup");
      return;
    }

    serverStarting = true;

    try {
      api.logger.info("[realtime] Starting Realtime plugin...");

      // Realtime only needs the same default-agent resolution semantics as core.
      await loadCoreAgentDeps();
      const defaultAgentId = resolveDefaultAgentIdFromConfig(api.config as CoreConfig);
      api.logger.info(`[realtime] Default agent ID: ${defaultAgentId}`);

      // Voice token file path (Layer 2 auth — same mechanism for local and Docker)
      const tokenFile = path.join(process.env.HOME || os.homedir(), ".openclaw", ".voice-token");

      // Start WebSocket server
      server = await startRealtimeServer({
        port,
        api,
        defaultAgentId,
        tokenFile,
      });

      // Setup file watcher for USER.md and MEMORY.md
      fileWatcher = setupFileWatcher({
        server,
        api,
        defaultAgentId,
      });

      // Register before_agent_start hook for backend mode
      api.on(
        "before_agent_start",
        async (event: { prompt: string; messages?: unknown[] }, ctx: { sessionKey?: string }) => {
          // Check if this request is from realtime
          // We'll use sessionKey to identify realtime sessions
          if (!ctx.sessionKey?.startsWith("realtime:")) {
            return {}; // Not a realtime request, don't modify
          }

          api.logger.info("[realtime] Injecting backend mode system prompt");

          // Get current conversation from server
          const conversation = server?.getConversation(ctx.sessionKey) ?? "";

          return {
            systemPrompt: buildBackendModePrompt(conversation),
          };
        },
      );

      api.logger.info(`[realtime] Realtime plugin activated on port ${port}`);
      api.logger.info(`[realtime] WebSocket: ws://localhost:${port}/ws`);
      api.logger.info(`[realtime] Bootstrap: http://localhost:${port}/api/realtime/bootstrap`);
    } finally {
      serverStarting = false;
    }
  },
};

export default realtimePlugin;
