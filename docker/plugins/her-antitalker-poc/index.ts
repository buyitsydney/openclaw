/**
 * her-antitalker — Stop-Hook Pipeline (CEP rule engine)
 *
 * 架构: pi-agent-core agent-loop.js (patched) 在模型想停时调用
 *       globalThis.__openclaw_stopHookPipeline, 走 CEP rule 引擎决定是否
 *       同 turn 续命。规则全部在 stop-hook-rules.yaml 数据。
 *
 * Plugin 职责只有三件:
 *   1. BMW hook 监听 assistant/user messages → 转发事件到 pipeline
 *   2. 加载 stop-hook-rules.yaml + mtime watcher 热加载
 *   3. 绑定 pipeline.drain 到 globalThis.__openclaw_stopHookPipeline
 *
 * 见 docs/her/antitalker-architecture.md。
 */

import type { StopHookRulesFile } from "./stop-hook-pipeline.js";
import {
  StopHookPipeline,
  createGetFollowUpMessages,
  installRules,
  loadStopHookRules,
  watchRulesFile,
} from "./stop-hook-pipeline.js";

// -------- Constants --------

const PLUGIN_ID = "her-antitalker-poc";
const PLUGIN_LABEL = "antitalker";
const STOP_HOOK_RULES_YAML = "/data/.openclaw/workspace/.antitalker/stop-hook-rules.yaml";

// -------- Logger --------

interface Logger {
  info?: (...a: any[]) => void;
  warn?: (...a: any[]) => void;
  error?: (...a: any[]) => void;
  debug?: (...a: any[]) => void;
}
let logger: Logger = console;
const log = (level: "debug" | "info" | "warn" | "error", msg: string): void => {
  const line = `[plugins] [${PLUGIN_LABEL}] ${msg}`;
  try { (logger as any)[level]?.(line); }
  catch { (console as any)[level]?.(line); }
};

// -------- Plugin --------

const plugin = {
  id: PLUGIN_ID,
  name: "Antitalker (Stop-Hook Pipeline)",
  version: "0.0.900",
  description:
    "Same-turn stop-hook-pipeline (CEP). Plugin is a pure event bridge; all rule logic lives in stop-hook-rules.yaml.",

  // Test seam — keep minimal so nothing leaks.
  _handlers: {
    get stopHookPipeline() { return StopHookPipeline.getInstance(); },
  },

  register(api: any) {
    try {
      logger = api.logger ?? console;

      const pipeline = StopHookPipeline.getInstance();

      // -------- Register BMW + user-capture hooks --------

      if (api.on) {
        api.on(
          "before_message_write",
          (event: any, ctx: any): any => {
            try {
              const msg = event?.message;
              if (!msg) return {};
              const content = Array.isArray(msg.content) ? msg.content : [];
              const sessionKey = String(ctx?.sessionKey ?? "");
              if (!sessionKey) return {};

              if (msg.role === "assistant") {
                pipeline.observeAssistantEvent({ sessionKey, content });
              } else if (msg.role === "user") {
                let txt = "";
                if (typeof msg.content === "string") txt = msg.content;
                else if (Array.isArray(content)) {
                  txt = content
                    .map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
                    .join(" ");
                }
                pipeline.markTurnBoundary(sessionKey);
                pipeline.setLastUserText(sessionKey, txt ?? "");
              }
            } catch (e: any) {
              log("error", `BMW hook crashed (fail-open): ${String(e?.message ?? e).slice(0, 200)}`);
            }
            return {};
          },
          { name: "antitalker-m2-bmw" },
        );
        log("info", "hook registered: before_message_write");
      }

      // -------- Load stop-hook rules + mtime watcher --------

      const applyRules = (file: StopHookRulesFile, err?: Error): void => {
        if (err) {
          log(
            "error",
            `stop-hook rules reload failed — keeping previous rules: ${String(err?.message ?? err).slice(0, 200)}`,
          );
          return;
        }
        try {
          const result = installRules(pipeline, file);
          log(
            "warn",
            `stop-hook rules loaded · enabled=${file.enabled} · installed=[${result.installed.join(
              ",",
            )}] · skipped=[${result.skipped.join(",")}] · max_continuation_turns=${file.max_continuation_turns ?? "default"}`,
          );
        } catch (e: any) {
          log("error", `installRules crashed: ${String(e?.message ?? e).slice(0, 200)}`);
        }
      };

      try {
        applyRules(loadStopHookRules(STOP_HOOK_RULES_YAML));
      } catch (e: any) {
        log(
          "error",
          `initial stop-hook rules load failed (will keep empty pipeline): ${String(e?.message ?? e).slice(0, 200)} · path=${STOP_HOOK_RULES_YAML}`,
        );
      }

      try {
        watchRulesFile(STOP_HOOK_RULES_YAML, applyRules, 2000);
      } catch {
        // watcher optional; missing file is fine
      }

      // -------- Bind pipeline drain to globalThis --------
      //
      // Patched pi-agent-core agent-loop.js looks for
      //   globalThis.__openclaw_stopHookPipeline
      //   ?? global.__openclaw_stopHookPipeline
      //   ?? globalThis[Symbol.for("openclaw.stopHookPipeline.v1")]
      // so bind all three to survive any vm/jiti realm boundary.

      const drainFn = createGetFollowUpMessages(pipeline);
      let drainSeq = 0;
      const wrappedDrain = async () => {
        drainSeq++;
        const sk = pipeline.pickActiveSessionKey();
        const ctx = sk ? pipeline.buildContext(sk) : null;
        const summary = ctx
          ? `sk=...${ctx.sessionKey.slice(-20)} tools=[${ctx.lastToolNames.join(",")}] userLen=${(ctx.lastUserText ?? "").length} asstLen=${(ctx.lastAssistantText ?? "").length}`
          : "no-ctx";
        log("warn", `pipeline drain CALLED seq=${drainSeq} · ${summary}`);
        try {
          const msgs = await drainFn();
          log(
            "warn",
            `pipeline drain seq=${drainSeq} → ${msgs.length} msgs · hooks=[${pipeline.getRegisteredHooks().join(",")}]`,
          );
          return msgs;
        } catch (e: any) {
          log("error", `pipeline drain crashed (fail-open): ${String(e?.message ?? e).slice(0, 200)}`);
          return [];
        }
      };

      (globalThis as any).__openclaw_stopHookPipeline = wrappedDrain;
      try {
        (global as any).__openclaw_stopHookPipeline = wrappedDrain;
      } catch {
        // non-Node realm — globalThis alone is enough
      }
      const GLOBAL_KEY = Symbol.for("openclaw.stopHookPipeline.v1");
      (globalThis as any)[GLOBAL_KEY] = wrappedDrain;

      log(
        "warn",
        `ready · stop-hook-pipeline bound · hooks=[${pipeline.getRegisteredHooks().join(",")}] · yaml=${STOP_HOOK_RULES_YAML}`,
      );
    } catch (e: any) {
      try {
        log("error", `register() crashed: ${String(e?.message ?? e).slice(0, 200)}`);
      } catch {
        // eslint-disable-next-line no-console
        console.error(`[${PLUGIN_LABEL}] register crashed:`, e);
      }
    }
  },
};

export default plugin;
