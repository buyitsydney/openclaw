/**
 * stop-hook-pipeline.ts — Same-turn enforcement framework (pure rule engine)
 *
 * Implements the getFollowUpMessages pattern from pi-agent-core: when the agent
 * loop has no more tool calls and is about to exit, this pipeline evaluates
 * registered hooks. If any hook fires, the returned message forces the loop to
 * continue (within the same turn — no watchdog, no wake, no bridge).
 *
 * The only hook factory exposed is createRuleHook(rule). All rule logic is
 * YAML-driven (preconditions, fire_when, substantial_tools, regex patterns,
 * max_retries, message). No rule specifics live in this file.
 *
 * See docs/her/stop-hook-pipeline-architecture.md.
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

// ─── Context passed from the plugin to each hook ─────────────────────────────

export interface StopHookContext {
  sessionKey: string;
  lastAssistantText: string;        // Last assistant text (or empty if no text)
  lastAssistantHadToolCall: boolean;
  lastToolNames: string[];          // All tools called in this turn (accumulator)
  turnIndex: number;
  // Optional — the most recent inbound user message preview. Used by
  // preconditions like min_user_message_length.
  lastUserText?: string;
}

export interface StopHookResult {
  shouldContinue: boolean;
  message?: string;
  hookName?: string;
}

export type StopHookFn = (ctx: StopHookContext) => StopHookResult;

interface RegisteredHook {
  name: string;
  fn: StopHookFn;
  priority: number;
}

// ─── YAML rule schema ────────────────────────────────────────────────────────

export interface StopHookRuleConfig {
  id: string;
  enabled: boolean;
  priority: number;

  // Preconditions — ALL must pass for the rule to evaluate fire_when.
  // If any precondition fails, the rule immediately returns shouldContinue=false.
  preconditions?: {
    // Skip this rule when the user's most recent message is shorter than N chars.
    // Useful for suppressing short greetings ("hi", "嗨") that are not tasks.
    min_user_message_length?: number;
    // Skip when assistant text is shorter than N chars (tiny acknowledgments).
    min_assistant_text_length?: number;
    // Require user message to match at least one of these regex patterns
    // (e.g. '帮我|检查|修|写|查' to require an imperative verb).
    user_text_matches_any?: string[];
    // Skip when assistant text matches ANY of these regex (heartbeat, NO_REPLY,
    // etc.). Use to carve out system-loopback messages.
    assistant_text_skip_if_matches_any?: string[];
  };

  // Fire conditions — ANY matching triggers the hook (OR semantics).
  // If none match, the rule passes (shouldContinue=false).
  fire_when: {
    // Fire when zero tool calls occurred in this turn.
    no_tool_call?: boolean;
    // Fire when no substantial tool (from whitelist) was called.
    // Takes precedence over no_tool_call if both are set.
    no_substantial_tool?: boolean;
    // Fire when assistant text matches ANY of these regex patterns.
    // Implicitly combined with no_tool_call OR no_substantial_tool.
    text_matches_any?: string[];
  };

  // Whitelist of tool names that count as "real work". Only used when
  // fire_when.no_substantial_tool=true.
  substantial_tools?: string[];

  // Per-session max consecutive forced continuations before yielding.
  max_retries?: number;

  // Message to inject into the loop (as a user role message).
  // If empty/missing, uses a sensible default mentioning the rule id.
  message?: string;
}

export interface StopHookRulesFile {
  enabled: boolean;
  max_continuation_turns?: number;
  rules: StopHookRuleConfig[];
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

const PIPELINE_KEY = Symbol.for("stop-hook-pipeline.v1");
const DEFAULT_MAX_CONTINUATION_TURNS = 3;

export class StopHookPipeline {
  private hooks: RegisteredHook[] = [];
  private continuationCount: Map<string, number> = new Map();
  private maxContinuationTurns: number;

  constructor(maxContinuationTurns = DEFAULT_MAX_CONTINUATION_TURNS) {
    this.maxContinuationTurns = maxContinuationTurns;
  }

  static getInstance(): StopHookPipeline {
    const g = globalThis as any;
    if (!g[PIPELINE_KEY]) g[PIPELINE_KEY] = new StopHookPipeline();
    return g[PIPELINE_KEY];
  }

  static resetInstance(): void {
    const g = globalThis as any;
    delete g[PIPELINE_KEY];
  }

  setMaxContinuationTurns(n: number): void {
    this.maxContinuationTurns = Math.max(0, n | 0);
  }

  register(name: string, fn: StopHookFn, priority = 0): void {
    const existing = this.hooks.findIndex((h) => h.name === name);
    if (existing >= 0) this.hooks[existing] = { name, fn, priority };
    else this.hooks.push({ name, fn, priority });
    this.hooks.sort((a, b) => b.priority - a.priority);
  }

  unregister(name: string): boolean {
    const idx = this.hooks.findIndex((h) => h.name === name);
    if (idx >= 0) { this.hooks.splice(idx, 1); return true; }
    return false;
  }

  /** Remove every hook — used by YAML hot-reload before re-registering. */
  unregisterAll(): void {
    this.hooks = [];
  }

  resetContinuationCount(sessionKey: string): void {
    this.continuationCount.delete(sessionKey);
  }

  getContinuationCount(sessionKey: string): number {
    return this.continuationCount.get(sessionKey) ?? 0;
  }

  evaluate(ctx: StopHookContext): Array<{ role: "user"; content: string }> {
    if (this.hooks.length === 0) return [];

    const count = this.continuationCount.get(ctx.sessionKey) ?? 0;
    if (count >= this.maxContinuationTurns) {
      this.continuationCount.delete(ctx.sessionKey);
      return [];
    }

    // Loop-level: if the last turn had a tool call, many rules treat that as
    // "working". We don't short-circuit here because some rules may still want
    // to inspect — per-rule logic decides.

    for (const hook of this.hooks) {
      try {
        const result = hook.fn(ctx);
        if (result.shouldContinue && result.message) {
          this.continuationCount.set(ctx.sessionKey, count + 1);
          return [{ role: "user" as const, content: result.message }];
        }
      } catch (err) {
        try { console.error(`[stop-hook-pipeline] hook "${hook.name}" threw:`, err); } catch {}
      }
    }

    this.continuationCount.delete(ctx.sessionKey);
    return [];
  }

  getRegisteredHooks(): string[] {
    return this.hooks.map((h) => h.name);
  }

  get hookCount(): number {
    return this.hooks.length;
  }
}

// ─── Rule engine: compile a YAML rule into a StopHookFn ──────────────────────

function compileRegexList(patterns?: string[]): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    try { out.push(new RegExp(p)); }
    catch (e: any) { try { console.error(`[stop-hook-pipeline] invalid regex skipped: ${p} — ${e?.message}`); } catch {} }
  }
  return out;
}

function hasSubstantialTool(toolNames: string[], whitelist: Set<string>): boolean {
  for (const t of toolNames) if (whitelist.has(t)) return true;
  return false;
}

export function createRuleHook(rule: StopHookRuleConfig): StopHookFn | null {
  if (!rule.enabled) return null;

  const minUserLen = rule.preconditions?.min_user_message_length ?? 0;
  const minAsstLen = rule.preconditions?.min_assistant_text_length ?? 0;
  const userMustMatch = compileRegexList(rule.preconditions?.user_text_matches_any);
  const asstSkipIfMatch = compileRegexList(rule.preconditions?.assistant_text_skip_if_matches_any);

  const fireNoToolCall = rule.fire_when.no_tool_call === true;
  const fireNoSubstantial = rule.fire_when.no_substantial_tool === true;
  const fireTextMatch = compileRegexList(rule.fire_when.text_matches_any);

  const substantialTools = new Set(rule.substantial_tools ?? []);
  const msg = rule.message && rule.message.length > 0
    ? rule.message
    : `⚠️ [${rule.id}] 同 turn 强制续命 — 检测到无实质进展,请立刻调 tool 执行。`;

  return (ctx: StopHookContext): StopHookResult => {
    // ─── Preconditions (ALL must pass) ───
    const userText = ctx.lastUserText ?? "";
    if (minUserLen > 0 && userText.length < minUserLen) {
      return { shouldContinue: false };
    }
    if (minAsstLen > 0 && (ctx.lastAssistantText ?? "").length < minAsstLen) {
      return { shouldContinue: false };
    }
    if (userMustMatch.length > 0 && !userMustMatch.some((r) => r.test(userText))) {
      return { shouldContinue: false };
    }
    if (asstSkipIfMatch.length > 0 && asstSkipIfMatch.some((r) => r.test(ctx.lastAssistantText ?? ""))) {
      return { shouldContinue: false };
    }

    // ─── Fire conditions (ANY triggers) ───
    let toolCondTriggered = false;

    if (fireNoSubstantial) {
      // Fire when no substantial tool was called this turn.
      toolCondTriggered = !hasSubstantialTool(ctx.lastToolNames, substantialTools);
    } else if (fireNoToolCall) {
      // Fire when no tool at all was called (and the last turn was pure text).
      toolCondTriggered = !ctx.lastAssistantHadToolCall && ctx.lastToolNames.length === 0;
    }

    let textCondTriggered = false;
    if (fireTextMatch.length > 0) {
      textCondTriggered = fireTextMatch.some((r) => r.test(ctx.lastAssistantText ?? ""));
    }

    const shouldFire = toolCondTriggered || textCondTriggered;
    if (!shouldFire) return { shouldContinue: false };

    return { shouldContinue: true, message: msg, hookName: rule.id };
  };
}

// ─── YAML loader (minimal, no external deps) ─────────────────────────────────

/**
 * Minimal YAML loader to avoid adding a runtime dep. Uses js-yaml if available,
 * otherwise falls back to a hand-rolled parser that handles the exact subset
 * we need (scalars, nested objects, list of objects, regex strings).
 */
function parseYaml(text: string): any {
  // Prefer the real YAML packages. In ESM we need createRequire to reach them.
  const candidates: Array<() => any> = [];
  try {
    const req = (globalThis as any).require ?? (typeof require !== "undefined" ? require : null);
    if (req) {
      candidates.push(() => req("yaml"));
      candidates.push(() => req("js-yaml"));
    }
  } catch {}
  try {
    const req2 = createRequire(import.meta?.url ?? ("file:///app/" as any));
    candidates.push(() => req2("yaml"));
    candidates.push(() => req2("js-yaml"));
  } catch {}
  for (const load of candidates) {
    try {
      const y = load();
      if (y?.parse) return y.parse(text);   // 'yaml' package
      if (y?.load) return y.load(text);      // 'js-yaml'
    } catch { /* try next */ }
  }
  // Hand-rolled fallback for environments without real YAML (smoke-test on host).
  return parseSimpleYaml(text);
}

/**
 * Very small YAML subset parser:
 *   key: value                    → string/number/bool
 *   key:                          → nested object or list
 *   - value                       → list item
 *   - key: value                  → list of objects
 *   # comment                     → ignored
 * Strings support single-quoted and double-quoted forms.
 * NOT supported: anchors, flow style [a,b], multi-line folded.
 */
export function parseSimpleYaml(text: string): any {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const tokens: Array<{ indent: number; line: string }> = [];
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.replace(/^\s+/, "").length;
    tokens.push({ indent, line: raw.trim() });
  }
  let pos = 0;

  function parseScalar(v: string): any {
    const t = v.trim();
    if (t === "") return "";
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null" || t === "~") return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    }
    return t;
  }

  function parseNode(baseIndent: number): any {
    if (pos >= tokens.length) return null;
    const first = tokens[pos];
    if (first.indent < baseIndent) return null;
    if (first.line.startsWith("- ") || first.line === "-") {
      // List
      const out: any[] = [];
      while (pos < tokens.length && tokens[pos].indent === baseIndent && (tokens[pos].line.startsWith("- ") || tokens[pos].line === "-")) {
        const item = tokens[pos].line === "-" ? "" : tokens[pos].line.slice(2);
        pos++;
        if (item.includes(":") && !item.startsWith('"') && !item.startsWith("'")) {
          // list of objects — current line contains "key: val" pair, and nested keys follow
          const obj: any = {};
          const [k, ...rest] = item.split(":");
          const v = rest.join(":").trim();
          if (v.length > 0) obj[k.trim()] = parseScalar(v);
          else obj[k.trim()] = parseNode(baseIndent + 2);
          // Subsequent sibling keys (same indent as baseIndent+2)
          while (pos < tokens.length && tokens[pos].indent > baseIndent && !tokens[pos].line.startsWith("- ")) {
            const t = tokens[pos];
            const colonAt = t.line.indexOf(":");
            if (colonAt < 0) break;
            const sk = t.line.slice(0, colonAt).trim();
            const sv = t.line.slice(colonAt + 1).trim();
            pos++;
            if (sv.length > 0) obj[sk] = parseScalar(sv);
            else obj[sk] = parseNode(t.indent + 2);
          }
          out.push(obj);
        } else {
          out.push(parseScalar(item));
        }
      }
      return out;
    }
    // Object
    const obj: any = {};
    while (pos < tokens.length && tokens[pos].indent === baseIndent && !tokens[pos].line.startsWith("- ")) {
      const t = tokens[pos];
      const colonAt = t.line.indexOf(":");
      if (colonAt < 0) { pos++; continue; }
      const k = t.line.slice(0, colonAt).trim();
      const v = t.line.slice(colonAt + 1).trim();
      pos++;
      if (v.length > 0) obj[k] = parseScalar(v);
      else obj[k] = parseNode(t.indent + 2);
    }
    return obj;
  }

  return parseNode(0);
}

export function loadStopHookRules(yamlPath: string): StopHookRulesFile {
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw) ?? {};
  return {
    enabled: parsed.enabled !== false,
    max_continuation_turns: typeof parsed.max_continuation_turns === "number" ? parsed.max_continuation_turns : DEFAULT_MAX_CONTINUATION_TURNS,
    rules: Array.isArray(parsed.rules) ? parsed.rules.map(normalizeRule).filter(Boolean) as StopHookRuleConfig[] : [],
  };
}

function normalizeRule(r: any): StopHookRuleConfig | null {
  if (!r || typeof r !== "object" || !r.id || !r.fire_when) return null;
  return {
    id: String(r.id),
    enabled: r.enabled !== false,
    priority: typeof r.priority === "number" ? r.priority : 0,
    preconditions: r.preconditions ?? undefined,
    fire_when: r.fire_when,
    substantial_tools: Array.isArray(r.substantial_tools) ? r.substantial_tools.map(String) : undefined,
    max_retries: typeof r.max_retries === "number" ? r.max_retries : undefined,
    message: typeof r.message === "string" && r.message.length > 0 ? r.message : undefined,
  };
}

/**
 * Install all rules from the YAML into the pipeline. Clears existing hooks
 * first so the call is idempotent — safe to invoke on every mtime tick.
 */
export function installRules(pipeline: StopHookPipeline, file: StopHookRulesFile): { installed: string[]; skipped: string[] } {
  pipeline.unregisterAll();
  if (typeof file.max_continuation_turns === "number") {
    pipeline.setMaxContinuationTurns(file.max_continuation_turns);
  }
  if (!file.enabled) return { installed: [], skipped: file.rules.map((r) => r.id) };

  const installed: string[] = [];
  const skipped: string[] = [];
  for (const rule of file.rules) {
    const hook = createRuleHook(rule);
    if (!hook) { skipped.push(rule.id); continue; }
    pipeline.register(rule.id, hook, rule.priority);
    installed.push(rule.id);
  }
  return { installed, skipped };
}

// ─── getFollowUpMessages integration ─────────────────────────────────────────

export function createGetFollowUpMessages(
  pipeline: StopHookPipeline,
  getContext: () => StopHookContext | null,
): () => Promise<Array<{ role: "user"; content: string }>> {
  return async () => {
    const ctx = getContext();
    if (!ctx) return [];
    return pipeline.evaluate(ctx);
  };
}

// ─── mtime watcher for hot-reload ────────────────────────────────────────────

export function watchRulesFile(
  yamlPath: string,
  onChange: (file: StopHookRulesFile, err?: Error) => void,
  intervalMs = 2000,
): () => void {
  let lastMtime = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const st = statSync(yamlPath);
      if (st.mtimeMs !== lastMtime) {
        lastMtime = st.mtimeMs;
        try { onChange(loadStopHookRules(yamlPath)); }
        catch (e: any) { onChange({ enabled: false, rules: [] }, e); }
      }
    } catch { /* file missing — ignore */ }
    setTimeout(tick, intervalMs).unref?.();
  };
  tick();
  return () => { stopped = true; };
}
