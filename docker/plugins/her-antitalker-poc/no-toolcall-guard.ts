/**
 * no-toolcall-guard.ts — Lightweight YAML-configurable no-toolcall guard
 *
 * Dead simple rule: if assistant turn has no "substantial" tool call → inject
 * continuation message via getFollowUpMessages.
 *
 * "Substantial" = tool name in the whitelist. Tools like message send, cron,
 * sessions_yield, memory_search etc. do NOT count as real work.
 *
 * YAML format (no-toolcall-guard.yaml):
 *   max_retries: 1                    # how many wake-ups before yielding (default: 1)
 *   message: "自定义提示"              # optional custom enforcement message
 *   enabled: true                      # kill switch (default: true)
 *   substantial_tools:                 # whitelist of "real work" tools
 *     - exec
 *     - read
 *     - write
 *     - edit
 *     - feishu_doc
 *     - feishu_sheet
 *     - feishu_bitable
 */

import { readFileSync, statSync, existsSync } from "node:fs";

// Re-use the existing yaml parser from the plugin runtime
let parseYamlFn: ((text: string) => any) | null = null;

function getYamlParser(): (text: string) => any {
  if (parseYamlFn) return parseYamlFn;
  try {
    const yaml = require("yaml");
    if (typeof yaml?.parse === "function") { parseYamlFn = yaml.parse; return parseYamlFn!; }
    if (typeof yaml?.default?.parse === "function") { parseYamlFn = yaml.default.parse; return parseYamlFn!; }
  } catch {}
  try {
    const jsYaml = require("js-yaml");
    if (typeof jsYaml?.load === "function") { parseYamlFn = jsYaml.load; return parseYamlFn!; }
  } catch {}
  // Minimal fallback for simple key: value yaml (handles lists too)
  parseYamlFn = (text: string) => {
    const result: Record<string, any> = {};
    let currentArr: string[] | null = null;
    let currentKey: string | null = null;
    for (const line of text.split("\n")) {
      const listItem = line.match(/^\s+-\s+(.+?)\s*$/);
      if (listItem && currentKey) {
        currentArr!.push(listItem[1].replace(/^['"]|['"]$/g, ""));
        continue;
      }
      if (currentKey && currentArr) {
        result[currentKey] = currentArr;
        currentArr = null;
        currentKey = null;
      }
      const kv = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
      if (kv) {
        const val = kv[2].replace(/^['"]|['"]$/g, "");
        result[kv[1]] = /^\d+$/.test(val) ? Number(val) : val === "true" ? true : val === "false" ? false : val;
        continue;
      }
      const arrStart = line.match(/^\s*(\w+)\s*:\s*$/);
      if (arrStart) {
        currentKey = arrStart[1];
        currentArr = [];
      }
    }
    if (currentKey && currentArr) result[currentKey] = currentArr;
    return result;
  };
  return parseYamlFn!;
}

const DEFAULT_SUBSTANTIAL_TOOLS = [
  "exec", "read", "write", "edit",
  "feishu_doc", "feishu_sheet", "feishu_bitable",
];

export interface NoToolcallGuardConfig {
  maxRetries?: number;
  message?: string;
  enabled?: boolean;
  substantialTools?: string[];
}

interface TurnContext {
  toolNames: string[];
}

const DEFAULT_MESSAGE =
  "⚠️ 你上一轮没有调用任何实质性 tool（exec/read/write/edit 等）。禁止光说不练。\n" +
  "现在立刻用 tool 执行实际动作，不要再输出纯文字或只调 message/cron 等非干活工具。";

export class NoToolcallGuard {
  private config: {
    maxRetries: number;
    message: string;
    enabled: boolean;
    substantialTools: Set<string>;
  };
  private retryCount: Map<string, number> = new Map();
  private lastTurnCtx: Map<string, TurnContext> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private yamlPath: string | null = null;
  private lastMtime: number = 0;

  constructor(config?: NoToolcallGuardConfig) {
    this.config = {
      maxRetries: config?.maxRetries ?? 1,
      message: config?.message ?? DEFAULT_MESSAGE,
      enabled: config?.enabled ?? true,
      substantialTools: new Set(config?.substantialTools ?? DEFAULT_SUBSTANTIAL_TOOLS),
    };
  }

  static fromYaml(yamlPath: string, opts?: { pollIntervalMs?: number }): NoToolcallGuard {
    const guard = new NoToolcallGuard();
    guard.yamlPath = yamlPath;
    guard.loadFromYaml();
    const interval = opts?.pollIntervalMs ?? 2000;
    guard.pollTimer = setInterval(() => guard.checkReload(), interval);
    return guard;
  }

  private loadFromYaml(): boolean {
    if (!this.yamlPath) return false;
    try {
      if (!existsSync(this.yamlPath)) return false;
      const raw = readFileSync(this.yamlPath, "utf-8");
      const parsed = getYamlParser()(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.max_retries === "number") this.config.maxRetries = parsed.max_retries;
        if (typeof parsed.message === "string") this.config.message = parsed.message;
        if (typeof parsed.enabled === "boolean") this.config.enabled = parsed.enabled;
        if (Array.isArray(parsed.substantial_tools)) {
          this.config.substantialTools = new Set(parsed.substantial_tools);
        }
        this.lastMtime = statSync(this.yamlPath).mtimeMs;
        return true;
      }
    } catch {
      // Keep last good config on parse failure
    }
    return false;
  }

  private checkReload(): void {
    if (!this.yamlPath) return;
    try {
      if (!existsSync(this.yamlPath)) return;
      const mtime = statSync(this.yamlPath).mtimeMs;
      if (mtime !== this.lastMtime) {
        this.loadFromYaml();
      }
    } catch {}
  }

  private hasSubstantialTool(toolNames: string[]): boolean {
    return toolNames.some(t => this.config.substantialTools.has(t));
  }

  /**
   * Core evaluation. Returns continuation messages or null (pass).
   */
  evaluate(
    sessionKey: string,
    ctx: { toolNames: string[] },
  ): Array<{ role: "user"; content: string }> | null {
    if (!this.config.enabled || this.config.maxRetries <= 0) return null;

    // Has substantial tool call → pass, reset counter
    if (this.hasSubstantialTool(ctx.toolNames)) {
      this.retryCount.delete(sessionKey);
      return null;
    }

    // No substantial tool → check retry budget
    const count = this.retryCount.get(sessionKey) ?? 0;
    if (count >= this.config.maxRetries) {
      this.retryCount.delete(sessionKey);
      return null;
    }

    this.retryCount.set(sessionKey, count + 1);
    return [{ role: "user" as const, content: this.config.message }];
  }

  setLastTurnContext(sessionKey: string, ctx: TurnContext): void {
    this.lastTurnCtx.set(sessionKey, ctx);
  }

  createGetFollowUpMessages(): (sessionKey: string) => Promise<Array<{ role: "user"; content: string }>> {
    return async (sessionKey: string) => {
      const ctx = this.lastTurnCtx.get(sessionKey);
      if (!ctx) return [];
      const result = this.evaluate(sessionKey, ctx);
      return result ?? [];
    };
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get currentConfig() {
    return {
      maxRetries: this.config.maxRetries,
      message: this.config.message,
      enabled: this.config.enabled,
      substantialTools: [...this.config.substantialTools],
    };
  }
}
