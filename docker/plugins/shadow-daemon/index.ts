/**
 * Shadow Daemon plugin
 *
 * Spawns the Python shadow daemon as a background service. The daemon mirrors
 * PDF / docx / xlsx / pptx files under the workspace into plain markdown under
 * `<workspace>/<shadowDir>`, so that `memory_search` can recall document
 * content semantically without teaching the index to parse binary formats.
 *
 * Lifecycle: start()/stop() are driven by the Gateway registerService API.
 * If the Python process exits unexpectedly it is respawned with a short
 * backoff up to `MAX_RESTARTS` times before giving up.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "shadow-daemon";
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 5_000;

type ShadowConfig = {
  enabled: boolean;
  shadowDir: string;
  extraPaths: string[];
  intervalSec: number;
  maxFileMB: number;
  extractTimeoutSec: number;
  scanBudgetSec: number;
  subprocMemoryMB: number;
  pythonBin: string;
};

const DEFAULT_CONFIG: ShadowConfig = {
  enabled: true,
  shadowDir: "memory/_shadow",
  extraPaths: [],
  intervalSec: 300,
  maxFileMB: 50,
  extractTimeoutSec: 180,
  scanBudgetSec: 240,
  subprocMemoryMB: 1024,
  pythonBin: "python3",
};

function readConfig(raw: Record<string, unknown> | undefined): ShadowConfig {
  const cfg = { ...DEFAULT_CONFIG };
  if (!raw) {return cfg;}
  if (typeof raw.enabled === "boolean") {cfg.enabled = raw.enabled;}
  if (typeof raw.shadowDir === "string" && raw.shadowDir.trim()) {
    cfg.shadowDir = raw.shadowDir.trim();
  }
  if (Array.isArray(raw.extraPaths)) {
    cfg.extraPaths = raw.extraPaths.filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
  }
  if (typeof raw.intervalSec === "number" && raw.intervalSec >= 30) {
    cfg.intervalSec = Math.floor(raw.intervalSec);
  }
  if (typeof raw.maxFileMB === "number" && raw.maxFileMB > 0) {
    cfg.maxFileMB = Math.floor(raw.maxFileMB);
  }
  if (typeof raw.extractTimeoutSec === "number" && raw.extractTimeoutSec > 0) {
    cfg.extractTimeoutSec = Math.floor(raw.extractTimeoutSec);
  }
  if (typeof raw.scanBudgetSec === "number" && raw.scanBudgetSec > 0) {
    cfg.scanBudgetSec = Math.floor(raw.scanBudgetSec);
  }
  if (typeof raw.subprocMemoryMB === "number" && raw.subprocMemoryMB > 0) {
    cfg.subprocMemoryMB = Math.floor(raw.subprocMemoryMB);
  }
  if (typeof raw.pythonBin === "string" && raw.pythonBin.trim()) {
    cfg.pythonBin = raw.pythonBin.trim();
  }
  return cfg;
}

function resolveDaemonPath(): string {
  // When Dockerfile COPYs the plugin to /app/docker/plugins/shadow-daemon the
  // daemon sits next to this file. `createRequire` helps us find it whether
  // we run from the compiled runtime or the source tree.
  const require_ = createRequire(import.meta.url);
  try {
    return require_.resolve("./daemon/shadow_daemon.py");
  } catch {
    return path.join(path.dirname(new URL(import.meta.url).pathname), "daemon", "shadow_daemon.py");
  }
}

const plugin = {
  id: PLUGIN_ID,
  name: "Shadow Daemon",
  description:
    "Mirror PDF / office documents in the workspace to markdown so memory_search can recall them.",
  version: "0.1.0",
  register(api: OpenClawPluginApi) {
    const cfg = readConfig(api.pluginConfig);
    if (!cfg.enabled) {
      api.logger.info?.("shadow-daemon: disabled via config; skipping service registration");
      return;
    }
    if (!api.registerService) {
      api.logger.warn(
        "shadow-daemon: registerService is unavailable; Python daemon will not start",
      );
      return;
    }

    let child: ChildProcessWithoutNullStreams | null = null;
    let restarts = 0;
    let stopping = false;
    let backoffTimer: NodeJS.Timeout | null = null;

    function buildEnv(workspaceDir: string): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = { ...process.env };
      env.SHADOW_WORKSPACE = workspaceDir;
      env.SHADOW_DIR = path.join(workspaceDir, cfg.shadowDir);
      env.SHADOW_INTERVAL_SEC = String(cfg.intervalSec);
      env.SHADOW_MAX_FILE_MB = String(cfg.maxFileMB);
      env.SHADOW_EXTRACT_TIMEOUT = String(cfg.extractTimeoutSec);
      env.SHADOW_SCAN_BUDGET = String(cfg.scanBudgetSec);
      env.SHADOW_SUBPROC_MEM_MB = String(cfg.subprocMemoryMB);
      if (cfg.extraPaths.length > 0) {
        env.SHADOW_EXTRA_PATHS = cfg.extraPaths.join(":");
      }
      return env;
    }

    function launch(workspaceDir: string, logger: OpenClawPluginApi["logger"]): void {
      if (stopping) {return;}
      const daemonPath = resolveDaemonPath();
      logger.info?.(
        `shadow-daemon: spawning ${cfg.pythonBin} ${daemonPath} (workspace=${workspaceDir})`,
      );
      const proc = spawn(cfg.pythonBin, [daemonPath], {
        env: buildEnv(workspaceDir),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = proc;

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) {logger.info?.(`shadow-daemon: ${trimmed}`);}
        }
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) {logger.warn(`shadow-daemon: ${trimmed}`);}
        }
      });

      proc.on("exit", (code, signal) => {
        child = null;
        if (stopping) {
          logger.info?.(`shadow-daemon: exited during shutdown (code=${code}, signal=${signal})`);
          return;
        }
        if (restarts >= MAX_RESTARTS) {
          logger.warn(
            `shadow-daemon: exited (code=${code}, signal=${signal}); giving up after ${restarts} restarts`,
          );
          return;
        }
        restarts += 1;
        logger.warn(
          `shadow-daemon: exited unexpectedly (code=${code}, signal=${signal}); restart ${restarts}/${MAX_RESTARTS} in ${RESTART_BACKOFF_MS}ms`,
        );
        backoffTimer = setTimeout(() => {
          backoffTimer = null;
          launch(workspaceDir, logger);
        }, RESTART_BACKOFF_MS);
      });

      proc.on("error", (err) => {
        logger.warn(`shadow-daemon: spawn error: ${String(err)}`);
      });
    }

    function checkMarkitdownAvailable(logger: OpenClawPluginApi["logger"]): void {
      try {
        const check = spawnSync(cfg.pythonBin, ["-c", "import markitdown"]);
        if (check.status !== 0) {
          logger.warn(
            "shadow-daemon: markitdown is not installed; conversions will fail. Install it in the Dockerfile with: pip3 install markitdown",
          );
        }
      } catch (err) {
        logger.warn(`shadow-daemon: markitdown check skipped: ${String(err)}`);
      }
    }

    api.registerService({
      id: PLUGIN_ID,
      start(ctx) {
        const workspaceDir = ctx.workspaceDir ?? process.env.OPENCLAW_WORKSPACE ?? process.cwd();
        const logger = ctx.logger ?? api.logger;
        stopping = false;
        restarts = 0;
        checkMarkitdownAvailable(logger);
        launch(workspaceDir, logger);
      },
      async stop(ctx) {
        stopping = true;
        if (backoffTimer) {
          clearTimeout(backoffTimer);
          backoffTimer = null;
        }
        const proc = child;
        child = null;
        if (!proc) {return;}
        const logger = ctx.logger ?? api.logger;
        logger.info?.("shadow-daemon: sending SIGTERM to Python daemon");
        try {
          proc.kill("SIGTERM");
        } catch (err) {
          logger.warn(`shadow-daemon: failed to send SIGTERM: ${String(err)}`);
          return;
        }
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            resolve();
          }, 5_000);
          proc.once("exit", () => {
            clearTimeout(fallback);
            resolve();
          });
        });
      },
    });
  },
};

export default plugin;
