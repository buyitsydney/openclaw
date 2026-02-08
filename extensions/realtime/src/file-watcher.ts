/**
 * File Watcher for Memory Sync
 *
 * Watches USER.md and MEMORY.md for changes,
 * then broadcasts prompt_update to Live clients.
 */

import { watch, type FSWatcher } from "chokidar";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { RealtimeServer } from "./server.js";
import { loadCoreAgentDeps, type CoreAgentDeps, type CoreConfig } from "./core-bridge.js";
import { generateLiveMemoryCapsule } from "./live-memory-capsule-agent.js";

export interface FileWatcher {
  close: () => Promise<void>;
}

export function setupFileWatcher(params: {
  server: RealtimeServer;
  api: OpenClawPluginApi;
  defaultAgentId?: string;
}): FileWatcher {
  const { server, api } = params;
  const defaultAgentId = params.defaultAgentId ?? "main";

  // Get workspace directory from config
  const workspaceDir = resolveWorkspaceDir(api);
  let coreDeps: CoreAgentDeps | null = null;

  if (!workspaceDir) {
    api.logger.warn("[realtime] Could not resolve workspace directory, file watcher disabled");
    return { close: async () => {} };
  }

  const watchPaths = [
    join(workspaceDir, "USER.md"),
    join(workspaceDir, "MEMORY.md"),
  ];

  api.logger.info(`[realtime] Watching files: ${watchPaths.join(", ")}`);

  const watcher = watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on("change", async (filePath) => {
    api.logger.info(`[realtime] File changed: ${filePath}`);

    try {
      if (!coreDeps) {
        coreDeps = await loadCoreAgentDeps();
      }

      const cfg = api.config as CoreConfig;
      const agentId = defaultAgentId;
      const agentDir = coreDeps.resolveAgentDir(cfg, agentId);

      // Rebuild capsule from BOTH files to keep it consistent.
      const [userProfileMd, memoryMd] = await Promise.all([
        readFile(join(workspaceDir, "USER.md"), "utf-8").catch(() => ""),
        readFile(join(workspaceDir, "MEMORY.md"), "utf-8").catch(() => ""),
      ]);
      const capsule = await generateLiveMemoryCapsule({
        coreDeps,
        cfg,
        agentId,
        agentDir,
        workspaceDir,
        userProfileMd,
        memoryMd,
      });

      api.logger.info(`[realtime] Broadcasting prompt_update for live_memory_capsule`);

      server.broadcast({
        type: "prompt_update",
        section: "live_memory_capsule",
        content: capsule,
      });
    } catch (err) {
      api.logger.error(`[realtime] Failed to read file ${filePath}: ${err}`);
    }
  });

  watcher.on("error", (err) => {
    api.logger.error(`[realtime] File watcher error: ${err}`);
  });

  return {
    close: async () => {
      await watcher.close();
    },
  };
}

function resolveWorkspaceDir(api: OpenClawPluginApi): string | null {
  // Try to get workspace directory from runtime
  const runtime = api.runtime;
  if (runtime && "workspaceDir" in runtime && typeof runtime.workspaceDir === "string") {
    return runtime.workspaceDir;
  }

  // Fallback to default location
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    return join(homeDir, ".openclaw", "workspace");
  }

  return null;
}

// No summarizeContent: we always produce a deterministic allowlist capsule.
