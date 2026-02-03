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

export interface FileWatcher {
  close: () => Promise<void>;
}

export function setupFileWatcher(params: {
  server: RealtimeServer;
  api: OpenClawPluginApi;
}): FileWatcher {
  const { server, api } = params;

  // Get workspace directory from config
  const workspaceDir = resolveWorkspaceDir(api);

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
      const content = await readFile(filePath, "utf-8");
      const section = filePath.includes("USER.md") ? "user_profile" : "memory";
      const summary = summarizeContent(content);

      api.logger.info(`[realtime] Broadcasting prompt_update for ${section}`);

      server.broadcast({
        type: "prompt_update",
        section,
        content: summary,
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

function summarizeContent(content: string): string {
  // For now, just return the first 2000 characters
  // TODO: Implement smarter summarization
  const maxLength = 2000;
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + "\n\n...(内容已截断)";
}
