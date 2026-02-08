/**
 * Realtime Plugin - Gemini Live + OpenClaw Integration
 *
 * Provides real-time voice interaction through Gemini Live API,
 * with OpenClaw as the intelligent backend for complex tasks.
 */

import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginHookBeforeAgentStartEvent,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk";
import { startRealtimeServer, type RealtimeServer } from "./src/server.js";
import { setupFileWatcher, type FileWatcher } from "./src/file-watcher.js";
import { loadCoreAgentDeps, type CoreConfig } from "./src/core-bridge.js";
import { buildBackendModePrompt } from "./src/prompt.js";

export interface RealtimeConfig {
  enabled?: boolean;
  port?: number;
  gemini?: {
    projectId?: string;
    location?: string;
  };
}

// Singleton state - persists across plugin loads
let server: RealtimeServer | null = null;
let fileWatcher: FileWatcher | null = null;
let serverStarting = false;

const realtimePlugin: OpenClawPluginDefinition = {
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

      // Resolve the default agent ID from config (falls back to "main")
      const coreDeps = await loadCoreAgentDeps();
      const defaultAgentId = coreDeps.resolveDefaultAgentId(api.config as CoreConfig);
      api.logger.info(`[realtime] Default agent ID: ${defaultAgentId}`);

      // Start WebSocket server
      server = await startRealtimeServer({
        port,
        api,
        defaultAgentId,
      });

      // Setup file watcher for USER.md and MEMORY.md
      fileWatcher = setupFileWatcher({
        server,
        api,
        defaultAgentId,
      });

      // Register before_agent_start hook for backend mode
      api.on("before_agent_start", async (
        event: PluginHookBeforeAgentStartEvent,
        ctx: PluginHookAgentContext,
      ) => {
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
      });

      api.logger.info(`[realtime] Realtime plugin activated on port ${port}`);
      api.logger.info(`[realtime] WebSocket: ws://localhost:${port}/ws`);
      api.logger.info(`[realtime] Bootstrap: http://localhost:${port}/api/realtime/bootstrap`);
    } finally {
      serverStarting = false;
    }
  },
};

export default realtimePlugin;
