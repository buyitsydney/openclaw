/**
 * stop-hook-pipeline.ts — Same-turn enforcement framework (CEP rule engine)
 *
 * Hook contract: pi-agent-core agent-loop calls `config.getFollowUpMessages?.()`
 * when the model is about to stop a turn. Non-empty return injects follow-up
 * user messages and the loop continues. We route that hook (via globalThis)
 * into this CEP engine which evaluates rules loaded from stop-hook-rules.yaml.
 *
 * ARCHITECTURE — Complex Event Processing:
 *   1. Plugin emits raw events via observeAssistantEvent / markTurnBoundary /
 *      setLastUserText. Plugin owns no per-turn state.
 *   2. Pipeline owns ALL state: per-session text buffer, per-session tools,
 *      continuation counter. External code never touches it directly.
 *   3. Rules are declarative data in YAML. New rule = new YAML entry;
 *      .ts untouched.
 *
 * See docs/her/stop-hook-pipeline-architecture.md.
 */

import { readFileSync, statSync } from "node:fs";

// ─── Raw event shapes fed by the plugin via observeAssistantEvent ────────────

export interface AssistantContentBlock {
  /** Common block types: "text", "toolCall", "tool_use", "thinking". */
  type: string;
  /** For "text": the text content. */
  text?: string;
  /** For toolCall / tool_use: the tool name. */
  name?: string;
  /** Tool invocation input (Anthropic naming). */
  input?: any;
  /** Tool invocation input (OpenAI naming). */
  arguments?: any;
  /** Alternative tool args name used by some transports. */
  args?: any;
}

export interface AssistantEvent {
  sessionKey: string;
  /** Array of content blocks from one assistant message. */
  content: AssistantContentBlock[];
}

// ─── Context passed to each rule hook — computed by the pipeline ─────────────

export interface StopHookContext {
  sessionKey: string;
  /** All text the assistant emitted this turn (text blocks + extracted message-tool args.text). */
  lastAssistantText: string;
  lastAssistantHadToolCall: boolean;
  /** Every tool name the assistant called this turn (accumulated across events). */
  lastToolNames: string[];
  turnIndex: number;
  /** The most recent inbound user message. */
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

/**
 * Observable sources describe what "assistant output" means for rule evaluation.
 * It is YAML-driven so new channel tools can be declared without touching code.
 */
export interface ObservableSourcesConfig {
  /**
   * Outbound-message tool names. When any of these is called, the tool's args
   * text (args.text / args.message / args.content) is appended to the session's
   * assistant-text accumulator. This captures Her's message to the user even
   * when it lives in a tool call, not in an assistant.text block.
   *
   * Default: [] — no extraction. Rules that only scan assistant.text will miss
   * anything sent via a tool. Declare all your channel tools here.
   */
  outbound_message_tools?: string[];
  /** Field names to probe in the tool args to extract user-facing text. */
  outbound_message_text_fields?: string[];
}

export interface StopHookRuleConfig {
  id: string;
  enabled: boolean;
  priority: number;

  preconditions?: {
    min_user_message_length?: number;
    min_assistant_text_length?: number;
    user_text_matches_any?: string[];
    assistant_text_skip_if_matches_any?: string[];
  };

  fire_when: {
    no_tool_call?: boolean;
    no_substantial_tool?: boolean;
    text_matches_any?: string[];
  };

  substantial_tools?: string[];
  max_retries?: number;
  message?: string;
}

export interface StopHookRulesFile {
  enabled: boolean;
  max_continuation_turns?: number;
  /**
   * Observable sources declare how the pipeline extracts assistant output from
   * events (which tool args are considered user-facing text, etc.).
   */
  observable_sources?: ObservableSourcesConfig;
  rules: StopHookRuleConfig[];
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

const PIPELINE_KEY = Symbol.for("stop-hook-pipeline.v1");
const DEFAULT_MAX_CONTINUATION_TURNS = 3;
const DEFAULT_TEXT_FIELDS = ["text", "message", "content"];
const DEFAULT_TEXT_CAP = 8192;     // per-session text accumulator soft cap
const DEFAULT_TOOLS_CAP = 128;     // per-session tool accumulator soft cap

interface SessionTurnState {
  text: string;                    // accumulated assistant text this turn
  tools: string[];                 // accumulated tool names this turn
  lastHadToolCall: boolean;        // whether the MOST RECENT assistant message had a tool call
  lastAssistantAtMs: number;       // wall clock of last assistant event
  lastUserText: string;            // most recent user message
  turnIndex: number;
}

export class StopHookPipeline {
  private hooks: RegisteredHook[] = [];
  private continuationCount: Map<string, number> = new Map();
  private turnState: Map<string, SessionTurnState> = new Map();
  private observableSources: ObservableSourcesConfig = {};
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

  setObservableSources(cfg: ObservableSourcesConfig | undefined): void {
    this.observableSources = cfg ?? {};
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

  unregisterAll(): void { this.hooks = []; }

  resetContinuationCount(sessionKey: string): void {
    this.continuationCount.delete(sessionKey);
  }

  getContinuationCount(sessionKey: string): number {
    return this.continuationCount.get(sessionKey) ?? 0;
  }

  // ─── CEP event ingestion ──────────────────────────────────────────────────

  private getOrCreateTurnState(sessionKey: string): SessionTurnState {
    let st = this.turnState.get(sessionKey);
    if (!st) {
      st = { text: "", tools: [], lastHadToolCall: false, lastAssistantAtMs: 0, lastUserText: "", turnIndex: 0 };
      this.turnState.set(sessionKey, st);
    }
    return st;
  }

  /**
   * Feed one raw assistant message (all blocks from one BMW event).
   * Pipeline extracts:
   *   - every text block → append to per-turn text
   *   - every toolCall block → append name to per-turn tools,
   *                             if name is in observable_sources.outbound_message_tools,
   *                             also extract args text and append to per-turn text
   *   - sets lastHadToolCall based on THIS event only (not the whole turn)
   */
  observeAssistantEvent(event: AssistantEvent): void {
    if (!event || typeof event.sessionKey !== "string" || !Array.isArray(event.content)) return;
    const st = this.getOrCreateTurnState(event.sessionKey);

    const outboundTools = new Set((this.observableSources.outbound_message_tools ?? []).map((s) => s.toLowerCase()));
    const textFields = this.observableSources.outbound_message_text_fields ?? DEFAULT_TEXT_FIELDS;

    let sawToolThisEvent = false;

    for (const block of event.content) {
      if (!block || typeof block !== "object") continue;
      const t = block.type;
      if (t === "text" && typeof block.text === "string" && block.text.length > 0) {
        this.appendText(st, block.text);
      } else if ((t === "toolCall" || t === "tool_use") && typeof block.name === "string" && block.name.length > 0) {
        st.tools.push(block.name);
        sawToolThisEvent = true;
        const lname = block.name.toLowerCase();
        if (outboundTools.has(lname)) {
          const args = block.input ?? block.arguments ?? block.args;
          const extracted = this.extractFirstTextField(args, textFields);
          if (extracted) this.appendText(st, extracted);
        }
      }
    }

    if (st.tools.length > DEFAULT_TOOLS_CAP) st.tools.splice(0, st.tools.length - DEFAULT_TOOLS_CAP);
    st.lastHadToolCall = sawToolThisEvent;
    // Guarantee strict monotonic timestamps so pickActiveSessionKey is deterministic
    // even when two events land in the same millisecond.
    const now = Date.now();
    st.lastAssistantAtMs = now > this.lastObserveAtMs ? now : this.lastObserveAtMs + 1;
    this.lastObserveAtMs = st.lastAssistantAtMs;
  }

  private lastObserveAtMs = 0;

  /**
   * Record the most recent inbound user message. Used by rule preconditions
   * like min_user_message_length.
   */
  setLastUserText(sessionKey: string, text: string): void {
    const st = this.getOrCreateTurnState(sessionKey);
    st.lastUserText = (text ?? "").slice(0, 8192);
  }

  /**
   * Mark the boundary of a turn (new user message has arrived). Resets the
   * per-turn accumulators for this session and bumps turnIndex. Also resets
   * the continuation counter — a fresh turn gets a fresh retry budget.
   */
  markTurnBoundary(sessionKey: string): void {
    const st = this.turnState.get(sessionKey);
    if (st) {
      st.text = "";
      st.tools = [];
      st.lastHadToolCall = false;
      st.turnIndex = (st.turnIndex ?? 0) + 1;
    }
    this.continuationCount.delete(sessionKey);
  }

  /** Diagnostic read: peek at current turn state (do not mutate). */
  getTurnState(sessionKey: string): Readonly<SessionTurnState> | null {
    const st = this.turnState.get(sessionKey);
    return st ? { ...st, tools: st.tools.slice() } : null;
  }

  private appendText(st: SessionTurnState, chunk: string): void {
    const add = chunk.length > DEFAULT_TEXT_CAP ? chunk.slice(0, DEFAULT_TEXT_CAP) : chunk;
    st.text = st.text.length > 0 ? (st.text + "\n" + add) : add;
    if (st.text.length > DEFAULT_TEXT_CAP) st.text = st.text.slice(-DEFAULT_TEXT_CAP);
  }

  private extractFirstTextField(args: any, fields: string[]): string {
    if (typeof args === "string") return args;
    if (!args || typeof args !== "object") return "";
    for (const f of fields) {
      const v = args[f];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  }

  // ─── Drain: called by patched agent-loop.js via globalThis ────────────────

  /**
   * Resolve the "most recently active" session from the turnState map.
   * Used when the patched agent-loop has no session context of its own.
   */
  pickActiveSessionKey(): string | null {
    let latestKey: string | null = null;
    let latestAt = 0;
    for (const [sk, st] of this.turnState.entries()) {
      if (st.lastAssistantAtMs > latestAt) {
        latestAt = st.lastAssistantAtMs;
        latestKey = sk;
      }
    }
    return latestKey;
  }

  buildContext(sessionKey: string): StopHookContext | null {
    const st = this.turnState.get(sessionKey);
    if (!st) return null;
    return {
      sessionKey,
      lastAssistantText: st.text,
      lastAssistantHadToolCall: st.lastHadToolCall,
      lastToolNames: st.tools.slice(),
      turnIndex: st.turnIndex,
      lastUserText: st.lastUserText,
    };
  }

  evaluate(ctx: StopHookContext): Array<{ role: "user"; content: string }> {
    if (this.hooks.length === 0) return [];

    const count = this.continuationCount.get(ctx.sessionKey) ?? 0;
    if (count >= this.maxContinuationTurns) {
      this.continuationCount.delete(ctx.sessionKey);
      return [];
    }

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

  getRegisteredHooks(): string[] { return this.hooks.map((h) => h.name); }
  get hookCount(): number { return this.hooks.length; }
}

// ─── Rule engine ─────────────────────────────────────────────────────────────

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
    if (minUserLen > 0 && userText.length < minUserLen) return { shouldContinue: false };
    if (minAsstLen > 0 && (ctx.lastAssistantText ?? "").length < minAsstLen) return { shouldContinue: false };
    if (userMustMatch.length > 0 && !userMustMatch.some((r) => r.test(userText))) return { shouldContinue: false };
    if (asstSkipIfMatch.length > 0 && asstSkipIfMatch.some((r) => r.test(ctx.lastAssistantText ?? ""))) return { shouldContinue: false };

    // ─── Fire conditions (AND semantics: all declared clauses must match) ───
    const tests: Array<(ctx: StopHookContext) => boolean> = [];
    if (fireNoSubstantial) tests.push((c) => !hasSubstantialTool(c.lastToolNames, substantialTools));
    if (fireNoToolCall) tests.push((c) => !c.lastAssistantHadToolCall && c.lastToolNames.length === 0);
    if (fireTextMatch.length > 0) tests.push((c) => fireTextMatch.some((r) => r.test(c.lastAssistantText ?? "")));

    if (tests.length === 0) return { shouldContinue: false };
    if (!tests.every((t) => t(ctx))) return { shouldContinue: false };

    return { shouldContinue: true, message: msg, hookName: rule.id };
  };
}

// ─── YAML loader ─────────────────────────────────────────────────────────────

function parseYaml(text: string): any {
  const candidates: Array<() => any> = [];
  try {
    const req = (globalThis as any).require ?? (typeof require !== "undefined" ? require : null);
    if (req) {
      candidates.push(() => req("yaml"));
      candidates.push(() => req("js-yaml"));
    }
  } catch {}
  for (const load of candidates) {
    try {
      const y = load();
      if (y?.parse) return y.parse(text);
      if (y?.load) return y.load(text);
    } catch { /* try next */ }
  }
  return parseSimpleYaml(text);
}

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
      const out: any[] = [];
      while (pos < tokens.length && tokens[pos].indent === baseIndent && (tokens[pos].line.startsWith("- ") || tokens[pos].line === "-")) {
        const item = tokens[pos].line === "-" ? "" : tokens[pos].line.slice(2);
        pos++;
        if (item.includes(":") && !item.startsWith('"') && !item.startsWith("'")) {
          const obj: any = {};
          const [k, ...rest] = item.split(":");
          const v = rest.join(":").trim();
          if (v.length > 0) obj[k.trim()] = parseScalar(v);
          else obj[k.trim()] = parseNode(baseIndent + 2);
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
    observable_sources: normalizeObservableSources(parsed.observable_sources),
    rules: Array.isArray(parsed.rules) ? parsed.rules.map(normalizeRule).filter(Boolean) as StopHookRuleConfig[] : [],
  };
}

function normalizeObservableSources(o: any): ObservableSourcesConfig | undefined {
  if (!o || typeof o !== "object") return undefined;
  return {
    outbound_message_tools: Array.isArray(o.outbound_message_tools) ? o.outbound_message_tools.map(String) : undefined,
    outbound_message_text_fields: Array.isArray(o.outbound_message_text_fields) ? o.outbound_message_text_fields.map(String) : undefined,
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
 * Install all rules and observable_sources from the YAML into the pipeline.
 * Clears existing hooks first so the call is idempotent — safe to invoke on
 * every mtime tick.
 */
export function installRules(pipeline: StopHookPipeline, file: StopHookRulesFile): { installed: string[]; skipped: string[] } {
  pipeline.unregisterAll();
  pipeline.setObservableSources(file.observable_sources);
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

// ─── getFollowUpMessages binding ─────────────────────────────────────────────

/**
 * The drain function bound to globalThis.__openclaw_stopHookPipeline. It picks
 * the most recently active session from the pipeline's own turn state — no
 * external state dependency.
 */
export function createGetFollowUpMessages(
  pipeline: StopHookPipeline,
): () => Promise<Array<{ role: "user"; content: string }>> {
  return async () => {
    const sk = pipeline.pickActiveSessionKey();
    if (!sk) return [];
    const ctx = pipeline.buildContext(sk);
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
