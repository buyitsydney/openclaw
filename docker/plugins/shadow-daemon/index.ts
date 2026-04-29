/**
 * Shadow Daemon plugin — v2 config-driven architecture
 *
 * Spawns the Python shadow daemon as a background service. The daemon reads
 * _config.json to decide which directories to scan. No _config.json = idle.
 * No markitdown installed = idle. Her controls everything through the SKILL.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "shadow-daemon";
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 5_000;
const RESTART_COOLDOWN_MS = 5 * 60 * 1000;

type ShadowConfig = {
  enabled: boolean;
  shadowDir: string;
  pythonBin: string;
};

const DEFAULT_CONFIG: ShadowConfig = {
  enabled: true,
  shadowDir: "memory/_shadow",
  pythonBin: "python3",
};

function readConfig(raw: Record<string, unknown> | undefined): ShadowConfig {
  const cfg = { ...DEFAULT_CONFIG };
  if (!raw) {return cfg;}
  if (typeof raw.enabled === "boolean") {cfg.enabled = raw.enabled;}
  if (typeof raw.shadowDir === "string" && raw.shadowDir.trim()) {
    cfg.shadowDir = raw.shadowDir.trim();
  }
  if (typeof raw.pythonBin === "string" && raw.pythonBin.trim()) {
    cfg.pythonBin = raw.pythonBin.trim();
  }
  return cfg;
}

function resolveDaemonPath(): string {
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
    "Config-driven document→markdown mirror for memory_search semantic recall.",
  version: "0.2.0",
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
    let cooldownTimer: NodeJS.Timeout | null = null;

    function buildEnv(workspaceDir: string): NodeJS.ProcessEnv {
      // Inherit container env as-is. We deliberately do NOT set PYTHONUSERBASE
      // here. Per-shell consistency matters: when Her runs `pip install --user`
      // via docker exec / Claude Code Bash, her shell may not see the env.
      // If we override here daemon and her shell would diverge. By leaving
      // PYTHONUSERBASE unset, both default to ~/.local (HOME=/data → /data/.local,
      // which is on the /data docker volume → persistent across container rebuild).
      return {
        ...process.env,
        SHADOW_WORKSPACE: workspaceDir,
        SHADOW_DIR: path.join(workspaceDir, cfg.shadowDir),
      };
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

      // Reset restart counter after sustained healthy operation
      if (cooldownTimer) {clearTimeout(cooldownTimer);}
      cooldownTimer = setTimeout(() => {
        if (restarts > 0) {
          logger.info?.(`shadow-daemon: healthy for ${RESTART_COOLDOWN_MS / 1000}s, resetting restart counter`);
          restarts = 0;
        }
        cooldownTimer = null;
      }, RESTART_COOLDOWN_MS);

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
        if (cooldownTimer) {clearTimeout(cooldownTimer); cooldownTimer = null;}
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

    api.registerService({
      id: PLUGIN_ID,
      start(ctx) {
        const workspaceDir = ctx.workspaceDir ?? process.env.OPENCLAW_WORKSPACE ?? process.cwd();
        const logger = ctx.logger ?? api.logger;
        stopping = false;
        restarts = 0;
        launch(workspaceDir, logger);
      },
      async stop(ctx) {
        stopping = true;
        if (backoffTimer) {
          clearTimeout(backoffTimer);
          backoffTimer = null;
        }
        if (cooldownTimer) {
          clearTimeout(cooldownTimer);
          cooldownTimer = null;
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
