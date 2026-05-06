/**
 * her-antitalker-poc v8.3.1 — fix self-report production failure + red card title template
 *
 * v8.3 changes over v8.1:
 *   Problem: bot self-reports after wake quotes the violation text ("被'20分钟后回来'拦了")
 *     → M1 regex re-fires → infinite wake loop.
 *   Failed approach (reverted 5f881bc8b): content_meta_discussion_pattern keyword whitelist
 *     had unacceptable false-negative rate.
 *
 *   Fix: structural self-report detection in handleMessageSending:
 *     1. Detect "self-report context" = last inbound was an antitalker wake message
 *     2. When regex matches in self-report context, strip quoted/fenced content then re-test
 *     3. Match only in quoted text → audit-only skip (no fire/wake/push)
 *     4. Match outside quoted text → new genuine violation → fire normally
 *
 * v8.1 — per-rule tool-exempt bypass
 *
 * v7.4.1 hotfix:
 *   v7.4 原本以为 before_message_write 的 event.message.content 含
 *   text + toolCall 同一个 content 数组 · 但 Nova E2E 铁证显示
 *   **OpenClaw 把 tool_call 和 text 拆成独立 assistant message**:
 *     msg1: content=[{type:thinking}, {type:toolCall, name:exec}]
 *     msg2: content=[{type:toolCall, name:read}]
 *     msg3: content=[{type:text, text:...违规话...}]
 *   所以 text message 的 content 永远找不到 toolCall · tool_count 永 0。
 *
 *   Fix: 在 before_message_write 里做累加 (而不是覆盖):
 *     每个 assistant message 触发 · 见到 toolCall 就 push 到 turnCtx.tools ·
 *     见到 text 就什么也不做 (message_sending 后续读累积值)。
 *   两种 block type name 都收："toolCall" (OpenAI) + "tool_use" (Anthropic)。
 *
 * v7.4 changes over v7.3:
 *   Bug #1 (主人 2026-05-03 戳破): tool_count 永远 0
 *     Root cause (两层): 
 *       1) v7.3 用 before_tool_call 累积 · OpenClaw 在某些路径 message_sending 先 fire
 *       2) v7.4 原以为 message.content 同时包 toolCall + text · 实际被拆开
 *     Fix (v7.4.1): before_message_write 累加 · 覆盖 两种 block type。
 *
 *   Bug #A (Nova v7.3 压测): content_meta_discussion_keywords 太窄
 *     Fix: yaml 补元讨论关键词 (规则讨论/会命中/会匹配/拦截条件 等)
 *
 *   Bug #B (Nova v7.3 压测): content_meta_discussion_pattern 放行过宽
 *     Fix: pattern 收紧 · 必须元词前有明确指示性介词/动词
 *
 * v7.3 changes over v7.2 (保留):
 *   Bug 4 的正道修法 (100% 源码验证):
 *     OpenClaw heartbeat canRelayToUser 公式 (heartbeat-runner.js:703):
 *       canRelayToUser = (delivery.channel !== "none") AND delivery.to AND visibility.showAlerts
 *     默认 agents.defaults.heartbeat.target = "none" → canRelayToUser=false → "reply HEARTBEAT_OK only"
 *     修法 = 在 user config 设置 target="last" → feishu session 拿到 variant B "The command completion details are:"
 *     边界: A2A/cron isolated session 由于 entry.lastChannel 不匹配, 仍自动走 no-target 静默分支
 *
 *   v7.3 撤 hack:
 *     - 删除 WAKE_OVERRIDE_PREFIX 常量 + 所有引用 (hack → 不允许)
 *     - reason: "cron:antitalker-wake" → "hook:antitalker" (不再绕路)
 *     - contextKey: "cron:antitalker" → "antitalker:violation" (纯 tag 无副作用)
 *     - wake_message_template 回归朴素：纯陈述违规 + 引原话 + 请求动作
 *     - 预设: user config /Data/CarHer/deploy/carher-<N>/.env 或 base.json5 加
 *             agents.defaults.heartbeat.target = "last"
 *
 *   继承 v7.2 修复:
 *     - Bug 1 · cooldown 顺序（noteCooldownFire 在确认违规后）
 *     - Gap 1 · eta regex 中英双语
 *     - Gap 2 · 元叙述豁免
 *     - Gap 3 · yaml defaults.exclude_from_count 统一
 *     - Gap 4 · substantial 白名单扩充
 *
 * 继承 v7.1 的所有修复（state on globalThis, isOverRateLimit/noteViolation 拆分,
 *  heartbeat api probe, ReDoS guard, prompt injection fence, feishu fail-fast, LRU prune）
 */

import { readFileSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync, promises as fsp } from "node:fs";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
const _require = createRequire("/app/docker/plugins/her-antitalker-poc/index.ts");

// -------- Constants --------
const PLUGIN_ID = "her-antitalker-poc";
const CONFIG_PATH = "/data/.openclaw/workspace/.antitalker/rules.yaml";
const DIST_DIR = "/app/dist";
const MATCH_MAX_CHARS = 4096;
const STATE_KEY = Symbol.for("antitalker.state.v1");

// v7.3 · 已撤 WAKE_OVERRIDE_PREFIX (v7.2 hack)
// 修复走 user config 原生路径：agents.defaults.heartbeat.target="last"
// → canRelayToUser 翅转到 true → variant B "The command completion details are:"
// → her 不再被压制为 HEARTBEAT_OK only

// -------- Shared state on globalThis --------
interface SessionActivity {
  lastToolCallAtMs: number;      // v7.6 上一次 toolCall 时间 (累进: BMW 时更新)
  lastAssistantMsgAtMs: number;  // v7.6 上一次 assistant message 时间 (所有 type 都更新)
  lastAssistantHadToolCall: boolean;  // v7.6 上一条 assistant 是否含 toolCall
  lastAssistantHadText: boolean;      // v7.6 上一条 assistant 是否含 text block
  lastAssistantTextPreview: string;   // v7.6 上一条 text preview (给 wake 用)
  lastUserPreview: string;            // v7.6 上一条 user message preview (识别 exec completion 等)
  silenceAlertedAt: number;           // v7.6 上次 silent_too_long 触发时间 (cooldown 用)
  chatId: string;                     // v7.6 推送 feishu 卡用 (最近一次 wake 已经知道)
}

interface SharedState {
  turnCtx: Map<string, TurnContext>;
  // v7.5 · sessionKey 单维度 tool 累积 (丢 runId · 因 OpenClaw 给 before_message_write 不可靠提供 runId)
  // 语义: 当前 session 最近一轮 LLM assistant message 里所有 toolCall name · 见到最后一条 text message 时清空
  toolsBySessionKey: Map<string, string[]>;
  // v7.10 · conversationId → sessionKey 映射 (BMW 写入 · MS fallback 读)
  convToSession: Map<string, string>;
  // v7.6 · 每 session 活跃状态: 用于 silent_too_long / prose_only_ending / delivery_response_required
  sessionActivity: Map<string, SessionActivity>;
  rateLimitCounters: Map<string, { hits: number[] }>;
  cooldownTracker: Map<string, number>;
  mtimePollTimer: NodeJS.Timeout | null;
  prunerTimer: NodeJS.Timeout | null;
  silenceWatchdogTimer: NodeJS.Timeout | null;  // v7.6 · 30s 扫 silent_too_long
  lastMtime: number;
  currentConfig: AntitalkerConfig | null;
  configLoadErrors: number;
  heartbeatApi: { enqueueSystemEvent?: Function; requestHeartbeatNow?: Function };
  tokenCache: { token: string; expiresAt: number } | null;
  logger: any;
  re2Ctor: any;
  re2Probed: boolean;
}

const globalAny = globalThis as any;
if (!globalAny[STATE_KEY]) {
  globalAny[STATE_KEY] = {
    turnCtx: new Map(),
    toolsBySessionKey: new Map(),
    convToSession: new Map(),
    agentToSession: new Map(),
    sessionActivity: new Map(),
    rateLimitCounters: new Map(),
    cooldownTracker: new Map(),
    mtimePollTimer: null,
    prunerTimer: null,
    silenceWatchdogTimer: null,
    lastMtime: 0,
    currentConfig: null,
    configLoadErrors: 0,
    heartbeatApi: {},
    tokenCache: null,
    logger: console,
    re2Ctor: null,
    re2Probed: false,
  } as SharedState;
}

// v7.6 · 如果是老 state (热 reload 可能没 sessionActivity 字段) 强制初始化
if (!globalAny[STATE_KEY].sessionActivity) globalAny[STATE_KEY].sessionActivity = new Map();
if (!globalAny[STATE_KEY].convToSession) globalAny[STATE_KEY].convToSession = new Map();
if (!globalAny[STATE_KEY].agentToSession) globalAny[STATE_KEY].agentToSession = new Map();
const state: SharedState = globalAny[STATE_KEY];

const RATE_LIMIT_MAX_ENTRIES = 4096;
const COOLDOWN_MAX_ENTRIES = 8192;

// -------- Types --------
interface AntitalkerConfig {
  version: number;
  runtime: {
    mtime_poll_interval_seconds: number;
    turn_ctx_ttl_minutes: number;
    turn_ctx_max_entries: number;
    log_level: string;
  };
  defaults?: { exclude_from_count?: string[]; };
  rules: RuleDef[];
  tool_rules: ToolRuleDef[];
  exemptions: {
    content_prefixes: string[];
    session_excludes_patterns: string[];
    turn_has_any_substantial_tool: string[];
    content_meta_discussion_keywords?: string[];   // v7.2 Gap 2
    content_meta_discussion_pattern?: string;      // v7.2 Gap 2 (optional regex)
  };
  rate_limit: {
    enabled: boolean;
    window_seconds: number;
    max_violations_per_session: number;
    on_exceed: { wake_her: boolean; push_admin: boolean; };
  };
  notification: {
    feishu_card: {
      enabled: boolean;
      header_color: string;
      title: string;
      body_template: string;
    };
    target_chats: { chat_id: string; min_severity: string; }[];
  };
  prompt_injection: {
    enabled: boolean;
    section_title: string;
    include_rule_list: boolean;
    footer_template: string;
  };
  audit_log: { enabled: boolean; path: string; max_bytes: number; rotate_keep: number; };
}

interface RuleDef {
  id: string;
  label: string;
  human_description?: string;
  enabled: boolean;
  priority: number;
  mode: "enforce" | "observe";
  severity: "high" | "medium" | "low";
  cooldown_seconds: number;
  text_pattern: string;
  ignore_turn_tool_exemption?: boolean;   // v8.1 · 穿透 tool 豁免（per-rule opt-in）
  _regex?: RegExp | any;
  _isRe2?: boolean;
  behavior?: { all_of?: BehaviorCheck[]; };
  action: {
    push_admin: boolean;
    wake_her: boolean;
    wake_message_template: string;
  };
}

interface BehaviorCheck {
  tool_count_lte?: { value: number; per_turn: boolean; exclude: string[]; };
}

interface ToolRuleDef {
  id: string;
  label: string;
  human_description?: string;
  enabled: boolean;
  tool_name: string;
  condition: { tool_count_lte: { value: number; per_turn: boolean; exclude: string[]; }; };
  action: { block: boolean; block_reason: string; };
}

interface TurnContext {
  sessionKey: string;
  runId: string;
  tools: string[];
  startedAt: number;
}

// -------- Logger --------
function log(level: "debug" | "info" | "warn" | "error", msg: string) {
  const configLevel = state.currentConfig?.runtime?.log_level ?? "info";
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levels[level] ?? 1) < (levels[configLevel as keyof typeof levels] ?? 1)) return;
  const fn = (state.logger[level] ?? state.logger.info ?? console.log).bind(state.logger);
  fn(`[antitalker-v8.3.1] ${msg}`);
}

// -------- RE2 lazy probe --------
function getRe2Ctor(): any {
  if (state.re2Probed) return state.re2Ctor;
  state.re2Probed = true;
  const paths = ["re2", "/data/.openclaw/local/lib/node_modules/re2", "/usr/lib/node_modules/re2", "/usr/local/lib/node_modules/re2"];
  for (const p of paths) {
    try {
      state.re2Ctor = require(p);
      log("info", `re2 available at ${p} · using linear-time regex`);
      return state.re2Ctor;
    } catch {}
  }
  state.re2Ctor = null;
  return null;
}

// -------- ReDoS sanity heuristic --------
function isSuspiciousRegex(pat: string): string | null {
  if (pat.length > 2048) return "pattern too long (>2048)";
  if (/\([^)]*[*+][^)]*\)\s*[*+]/.test(pat)) return "nested unbounded quantifier";
  if (/\(([^|()]+)\|\1\)\s*[*+]/.test(pat)) return "alternation of equivalent branches";
  const depth = (() => {
    let d = 0, max = 0;
    for (const c of pat) { if (c === "(") { d++; if (d > max) max = d; } else if (c === ")") d--; }
    return max;
  })();
  if (depth > 10) return `group nesting too deep (${depth})`;
  return null;
}

function compileRegex(pat: string): { rx: any; isRe2: boolean } | null {
  const suspicion = isSuspiciousRegex(pat);
  if (suspicion) {
    log("warn", `regex rejected (ReDoS risk · ${suspicion}): ${pat.slice(0, 80)}`);
    return null;
  }
  const Re2 = getRe2Ctor();
  if (Re2) {
    try { return { rx: new Re2(pat), isRe2: true }; } catch (e: any) {
      log("warn", `re2 compile failed, fallback to RegExp: ${e.message}`);
    }
  }
  try { return { rx: new RegExp(pat), isRe2: false }; } catch (e: any) {
    log("warn", `RegExp compile failed: ${e.message}`);
    return null;
  }
}

function safeTest(rx: any, _isRe2: boolean, content: string): boolean {
  const slice = content.length > MATCH_MAX_CHARS ? content.slice(0, MATCH_MAX_CHARS) : content;
  try { return rx.test(slice); } catch { return false; }
}

// -------- YAML parse --------
// v7.6 · 支持 js-yaml 和 yaml (fleet runtime 依赖里一般只有 yaml)
function parseYaml(text: string): any {
  const pkgs = ["yaml", "js-yaml"];
  const basePaths = [
    "/data/.openclaw/plugin-runtime-deps/openclaw-unknown-6ffff388d499/node_modules",
    "/data/.openclaw/plugin-runtime-deps/openclaw-2026.4.24-f53b52ad6d21/node_modules",
    "/data/.openclaw/local/lib/node_modules",
    "/usr/lib/node_modules",
    "/usr/local/lib/node_modules",
  ];
  const paths: string[] = [];
  for (const p of pkgs) {
    paths.push(p);
    for (const b of basePaths) paths.push(`${b}/${p}`);
  }
  const errors: string[] = [];
  for (const p of paths) {
    try {
      const yaml = _require(p);
      // "yaml" pkg exposes parse() · js-yaml 暴露 load()
      if (typeof yaml?.load === "function") return yaml.load(text);
      if (typeof yaml?.parse === "function") return yaml.parse(text);
      if (typeof (yaml as any)?.default?.parse === "function") return (yaml as any).default.parse(text);
      errors.push(`${p}: no load/parse method`);
    } catch (e: any) { errors.push(`${p}: ${String(e?.message ?? e).slice(0,80)}`); }
  }
  throw new Error("yaml parser not found · errors: " + errors.join(" | "));
}

// -------- Config load/validate --------
function emptyConfig(): AntitalkerConfig {
  return {
    version: 1,
    runtime: { mtime_poll_interval_seconds: 5, turn_ctx_ttl_minutes: 10, turn_ctx_max_entries: 1024, log_level: "info" },
    defaults: { exclude_from_count: [] },
    rules: [], tool_rules: [],
    exemptions: {
      content_prefixes: [],
      session_excludes_patterns: [],
      turn_has_any_substantial_tool: [],
      content_meta_discussion_keywords: [],
      content_meta_discussion_pattern: undefined,
    },
    rate_limit: { enabled: false, window_seconds: 60, max_violations_per_session: 5, on_exceed: { wake_her: false, push_admin: false } },
    notification: { feishu_card: { enabled: false, header_color: "red", title: "", body_template: "" }, target_chats: [] },
    prompt_injection: { enabled: false, section_title: "", include_rule_list: false, footer_template: "" },
    audit_log: { enabled: false, path: "", max_bytes: 0, rotate_keep: 0 },
  };
}

function validateConfig(raw: any): AntitalkerConfig {
  const cfg: AntitalkerConfig = { ...emptyConfig(), ...raw };
  cfg.runtime = { ...emptyConfig().runtime, ...(raw?.runtime ?? {}) };
  cfg.defaults = { ...emptyConfig().defaults, ...(raw?.defaults ?? {}) };

  // v7.2 Gap 3 · resolve exclude_from_count inheritance
  const defaultExclude = cfg.defaults?.exclude_from_count ?? [];

  cfg.rules = (raw?.rules ?? []).filter((r: any) => r?.enabled !== false).map((r: any) => {
    const compiled = compileRegex(r.text_pattern);
    if (!compiled) {
      log("warn", `rule "${r.id}" regex invalid/rejected · skipped`);
      return null;
    }
    r._regex = compiled.rx;
    r._isRe2 = compiled.isRe2;
    // Inherit defaults.exclude_from_count into behavior checks that have no explicit exclude
    if (r.behavior?.all_of) {
      for (const check of r.behavior.all_of) {
        if (check.tool_count_lte && !Array.isArray(check.tool_count_lte.exclude)) {
          check.tool_count_lte.exclude = [...defaultExclude];
        } else if (check.tool_count_lte && check.tool_count_lte.exclude.length === 0 && defaultExclude.length > 0) {
          check.tool_count_lte.exclude = [...defaultExclude];
        }
      }
    }
    return r;
  }).filter(Boolean);
  cfg.rules.sort((a: RuleDef, b: RuleDef) => (b.priority ?? 0) - (a.priority ?? 0));

  cfg.tool_rules = (raw?.tool_rules ?? []).filter((t: any) => t?.enabled !== false).map((t: any) => {
    if (t.condition?.tool_count_lte && (!Array.isArray(t.condition.tool_count_lte.exclude) || t.condition.tool_count_lte.exclude.length === 0) && defaultExclude.length > 0) {
      t.condition.tool_count_lte.exclude = [...defaultExclude];
    }
    return t;
  });

  cfg.exemptions = { ...emptyConfig().exemptions, ...(raw?.exemptions ?? {}) };
  cfg.rate_limit = { ...emptyConfig().rate_limit, ...(raw?.rate_limit ?? {}) };
  cfg.notification = { ...emptyConfig().notification, ...(raw?.notification ?? {}) };
  cfg.prompt_injection = { ...emptyConfig().prompt_injection, ...(raw?.prompt_injection ?? {}) };
  cfg.audit_log = { ...emptyConfig().audit_log, ...(raw?.audit_log ?? {}) };
  return cfg;
}

function loadConfig(): AntitalkerConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) {
      log("warn", `config file missing: ${CONFIG_PATH} · running empty (no rules)`);
      return emptyConfig();
    }
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = parseYaml(raw);
    return validateConfig(parsed);
  } catch (e: any) {
    state.configLoadErrors++;
    log("error", `config load failed: ${String(e?.message ?? e).slice(0, 200)}`);
    return null;
  }
}

// -------- Mtime polling hot reload --------
function startMtimePoller() {
  const intervalMs = (state.currentConfig?.runtime?.mtime_poll_interval_seconds ?? 5) * 1000;
  if (state.mtimePollTimer) clearInterval(state.mtimePollTimer);
  state.mtimePollTimer = setInterval(() => {
    try {
      if (!existsSync(CONFIG_PATH)) return;
      const st = statSync(CONFIG_PATH);
      if (st.mtimeMs !== state.lastMtime) {
        state.lastMtime = st.mtimeMs;
        const next = loadConfig();
        if (next) {
          state.currentConfig = next;
          log("warn", `reloaded · rules=${next.rules.length} · tool_rules=${next.tool_rules.length}`);
          const newInterval = (next.runtime?.mtime_poll_interval_seconds ?? 5) * 1000;
          if (newInterval !== intervalMs) startMtimePoller();
        }
      }
    } catch (e: any) {
      log("warn", `mtime poll error: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }, intervalMs);
}

// -------- turnCtx management --------
function turnKey(sessionKey: string, runId: string): string {
  return `${sessionKey || "?"}|${runId || "?"}`;
}

function getTurnCtx(sessionKey: string, runId: string): TurnContext {
  const k = turnKey(sessionKey, runId);
  let ctx = state.turnCtx.get(k);
  if (!ctx) {
    ctx = { sessionKey, runId, tools: [], startedAt: Date.now() };
    state.turnCtx.set(k, ctx);
    const maxEntries = state.currentConfig?.runtime?.turn_ctx_max_entries ?? 1024;
    if (state.turnCtx.size > maxEntries) {
      const oldest = state.turnCtx.keys().next().value;
      if (oldest) state.turnCtx.delete(oldest);
    }
  } else {
    state.turnCtx.delete(k);
    state.turnCtx.set(k, ctx);
  }
  return ctx;
}

function pruneStaleTurnCtx() {
  const ttlMs = (state.currentConfig?.runtime?.turn_ctx_ttl_minutes ?? 10) * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  for (const [k, ctx] of state.turnCtx) {
    if (ctx.startedAt < cutoff) state.turnCtx.delete(k);
  }
  while (state.cooldownTracker.size > COOLDOWN_MAX_ENTRIES) {
    const k = state.cooldownTracker.keys().next().value;
    if (!k) break;
    state.cooldownTracker.delete(k);
  }
  for (const [k, b] of state.rateLimitCounters) {
    const live = b.hits.filter(t => Date.now() - t < 10 * 60_000);
    if (live.length === 0) state.rateLimitCounters.delete(k);
    else b.hits = live;
  }
  while (state.rateLimitCounters.size > RATE_LIMIT_MAX_ENTRIES) {
    const k = state.rateLimitCounters.keys().next().value;
    if (!k) break;
    state.rateLimitCounters.delete(k);
  }
}

// -------- Rate limit --------
function isOverRateLimit(sessionKey: string): boolean {
  const cfg = state.currentConfig?.rate_limit;
  if (!cfg?.enabled) return false;
  const bucket = state.rateLimitCounters.get(sessionKey);
  if (!bucket) return false;
  const windowMs = cfg.window_seconds * 1000;
  const now = Date.now();
  const live = bucket.hits.filter(t => now - t < windowMs);
  return live.length >= cfg.max_violations_per_session;
}

function noteViolation(sessionKey: string): void {
  const cfg = state.currentConfig?.rate_limit;
  if (!cfg?.enabled) return;
  let bucket = state.rateLimitCounters.get(sessionKey);
  if (!bucket) {
    bucket = { hits: [] };
    state.rateLimitCounters.set(sessionKey, bucket);
  } else {
    state.rateLimitCounters.delete(sessionKey);
    state.rateLimitCounters.set(sessionKey, bucket);
  }
  const windowMs = cfg.window_seconds * 1000;
  const now = Date.now();
  bucket.hits = bucket.hits.filter(t => now - t < windowMs);
  bucket.hits.push(now);
}

// -------- Cooldown · v7.2 Bug 1 · read-only check + explicit noteCooldownFire --------
function isOnCooldown(sessionKey: string, ruleId: string, cooldownS: number): boolean {
  if (cooldownS <= 0) return false;
  const k = `${sessionKey}|${ruleId}`;
  const last = state.cooldownTracker.get(k) ?? 0;
  return (Date.now() - last) < cooldownS * 1000;
}

function noteCooldownFire(sessionKey: string, ruleId: string): void {
  const k = `${sessionKey}|${ruleId}`;
  state.cooldownTracker.set(k, Date.now());
}

// -------- Behavior checks --------
function evalBehavior(rule: RuleDef, ctx: TurnContext): { passed: boolean; toolCount: number; } {
  const checks = rule.behavior?.all_of ?? [];
  const toolsSubstantial = ctx.tools;
  let overallPassed = true;
  let toolCount = toolsSubstantial.length;
  for (const check of checks) {
    if (check.tool_count_lte) {
      const exclude = new Set(check.tool_count_lte.exclude ?? []);
      const count = toolsSubstantial.filter(t => !exclude.has(t)).length;
      toolCount = count;
      if (count > check.tool_count_lte.value) overallPassed = false;
    }
  }
  return { passed: overallPassed, toolCount };
}

// -------- v8.1: Tool exemption split out so rules can opt-in to bypass --------
function isToolExempt(ctx: TurnContext): boolean {
  const ex = state.currentConfig!.exemptions;
  const defaultExclude = new Set(state.currentConfig?.defaults?.exclude_from_count ?? []);
  const substantialTools = new Set(ex.turn_has_any_substantial_tool ?? []);
  if (substantialTools.size === 0) return false;
  return ctx.tools.some(t => !defaultExclude.has(t) && substantialTools.has(t));
}

// -------- Exemptions · v8.1 · semantic-only (no tool gating here) --------
function isExempt(content: string, ctx: TurnContext, sessionKey: string): boolean {
  const ex = state.currentConfig!.exemptions;
  for (const prefix of ex.content_prefixes ?? []) {
    if (content.startsWith(prefix)) return true;
  }
  for (const pat of ex.session_excludes_patterns ?? []) {
    try { if (new RegExp(pat).test(sessionKey)) return true; } catch {}
  }
  // v7.2 Gap 2 · meta-discussion exemption
  const trimmed = content.trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`") ||
      trimmed.startsWith("\u300c") || trimmed.startsWith("\u201c") || trimmed.startsWith("```")) {
    return true;
  }
  const keywords = ex.content_meta_discussion_keywords ?? [];
  for (const kw of keywords) {
    if (content.includes(kw)) return true;
  }
  const metaPat = ex.content_meta_discussion_pattern;
  if (metaPat) {
    try { if (new RegExp(metaPat).test(content)) return true; } catch {}
  }
  return false;
}

// -------- v8.3: Self-report detection --------
const ANTITALKER_WAKE_PREFIX = "\u26a0\ufe0f antitalker \u5f3a\u5236\u5524\u9192";
const ANTITALKER_WAKE_BRACKET = "[antitalker ";

/**
 * v8.3 · Detect whether the bot is currently responding to an antitalker wake message.
 * Uses sessionActivity.lastUserPreview which captures the last inbound system/user message.
 */
function isInSelfReportContext(sessionKey: string): boolean {
  const act = state.sessionActivity.get(sessionKey);
  if (!act) return false;
  const preview = act.lastUserPreview || "";
  return preview.includes(ANTITALKER_WAKE_PREFIX) || preview.startsWith(ANTITALKER_WAKE_BRACKET);
}

/**
 * v8.3 · Strip quoted/fenced content from text so we can re-test regex on "bare" content only.
 * Strips: code fences, inline code, CJK quotes 「」『』"", standard quotes when containing
 * 2+ chars (to avoid stripping apostrophes in English).
 */
function stripQuotedContent(text: string): string {
  // Code fences (multiline)
  let result = text.replace(/```[\s\S]*?```/g, " ");
  // Inline code
  result = result.replace(/`[^`]+`/g, " ");
  // CJK quotes
  result = result.replace(/[\u300c\u300e\u201c][^\u300d\u300f\u201d]*[\u300d\u300f\u201d]/g, " ");
  // Standard double/single quotes with 2+ chars inside (avoid breaking contractions)
  result = result.replace(/"[^"]{2,}"/g, " ");
  result = result.replace(/'[^']{2,}'/g, " ");
  // v8.5: markdown table rows (any line with 2+ pipes = table row, strip entire line)
  result = result.replace(/^.*\|.*\|.*$/gm, " ");
  // v8.4: blockquotes (> ... or ＞ ...)
  result = result.replace(/^[>＞][^\n]*/gm, " ");
  // v8.4: list item content after bullet (- ... or * ... or N. ...)
  result = result.replace(/^\s*[-*]\s+.+$/gm, (line) => " ");
  result = result.replace(/^\s*\d+\.\s+.+$/gm, (line) => " ");
  return result;
}

// -------- Template render --------
function renderTemplate(tmpl: string, vars: Record<string, any>): string {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

function fenceViolationText(text: string): string {
  const safe = text.replace(/```/g, "``\u200b`");
  return "```\n" + safe + "\n```";
}

// -------- Feishu API --------
// v7.3.1 · fleet-level fix: 优先从 OpenClaw config (api.config.channels.feishu.appId/appSecret) 读
// 回退到 env var (FEISHU_APP_ID / FEISHU_APP_SECRET)。
// 原因: fleet secrets.env 主要只有 FEISHU_APP_SECRET，appId 在 user config
// channels.feishu.appId 里。不同 her 有不同 appId，不适合用 hardcoded env var。
let _cachedPluginConfig: any = null;
function setPluginConfigRef(cfg: any) { _cachedPluginConfig = cfg; }
function getFeishuCreds(): { appId: string; appSecret: string } | null {
  const cfg = _cachedPluginConfig;
  const feishuCfg = cfg?.channels?.feishu;
  const appId = feishuCfg?.appId || process.env.FEISHU_APP_ID;
  const appSecret = feishuCfg?.appSecret || process.env.FEISHU_APP_SECRET;
  // appSecret 从 config 读会是 "${FEISHU_APP_SECRET}" 占位符 (未 resolved)，
  // 这种情况 fallback 到 env
  const resolvedSecret = (typeof appSecret === "string" && appSecret.startsWith("${"))
    ? process.env.FEISHU_APP_SECRET
    : appSecret;
  if (!appId || !resolvedSecret) return null;
  return { appId, appSecret: resolvedSecret };
}

async function getFeishuToken(): Promise<string | null> {
  const creds = getFeishuCreds();
  if (!creds) {
    log("error", "CRITICAL: feishu appId/appSecret unavailable (checked config.channels.feishu + env) · push_admin disabled");
    return null;
  }
  const { appId, appSecret } = creds;
  const now = Date.now();
  if (state.tokenCache && state.tokenCache.expiresAt > now + 30000) return state.tokenCache.token;
  try {
    const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),  // v7.3.1 from config+env
    });
    const d: any = await r.json();
    if (d?.code !== 0) return null;
    state.tokenCache = { token: d.tenant_access_token, expiresAt: now + (d.expire ?? 7200) * 1000 };
    return state.tokenCache.token;
  } catch { return null; }
}

function normalizeFeishuChatId(raw: any): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  for (const prefix of ["feishu:", "chat:", "user:", "channel:"]) {
    if (s.startsWith(prefix)) return s.slice(prefix.length);
  }
  return s;
}

function extractFeishuChatIdFromText(text: string): string {
  const m = String(text ?? "").match(/"chat_id"\s*:\s*"feishu:(oc_[^"]+|ou_[^"]+)"/);
  return m ? m[1] : "";
}

function resolveSourceChatId(sessionKey: string, ctx: any): string {
  const candidates = [
    ctx?.chatId, ctx?.chat_id, ctx?.conversationId, ctx?.channelId, ctx?.channel_id,
    ctx?.message?.chatId, ctx?.message?.chat_id,
    ctx?.metadata?.chatId, ctx?.metadata?.chat_id,
    ctx?.channel?.id, ctx?.channel?.chatId,
    ctx?.lastChannel?.id, ctx?.lastChannel,
  ];
  for (const c of candidates) {
    const v = normalizeFeishuChatId(c);
    if (v.startsWith("oc_") || v.startsWith("ou_")) return v;
  }
  // fallback: extract oc_/ou_ from sessionKey (0503 format: agent:main:feishu:group:oc_xxx)
  const skMatch = String(sessionKey ?? "").match(/(oc_[a-f0-9]+|ou_[a-f0-9]+)/);
  if (skMatch) return skMatch[1];
  const act = state.sessionActivity.get(sessionKey);
  if (act?.chatId) return act.chatId;
  return "";
}

function routeTargets(sessionKey: string, ctx: any, _fallbackTargets: any[]): { chat_id: string; min_severity: string; source: string }[] {
  const source = resolveSourceChatId(sessionKey, ctx);
  if (source) return [{ chat_id: source, min_severity: "low", source: "source" }];
  // No source chat => audit only. This prevents cross-chat/private leakage to a hardcoded global group.
  return [];
}

async function pushFeishuCard(chatId: string, title: string, bodyMarkdown: string, headerColor: string) {
  const token = await getFeishuToken();
  if (!token) { log("warn", "no feishu token · skip push"); return; }
  const card = {
    schema: "2.0",
    header: { template: headerColor, title: { content: title, tag: "plain_text" } },
    body: { elements: [{ tag: "markdown", content: bodyMarkdown }] },
  };
  try {
    const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }),
    });
    const d: any = await r.json();
    if (d?.code !== 0) log("warn", `push card failed: code=${d?.code} msg=${d?.msg}`);
  } catch (e: any) { log("warn", `push card error: ${String(e?.message ?? e).slice(0, 120)}`); }
}

function severityGte(a: string, b: string): boolean {
  const r = { low: 0, medium: 1, high: 2 };
  return (r[a as keyof typeof r] ?? 0) >= (r[b as keyof typeof r] ?? 0);
}

// -------- Heartbeat API load --------
function pickFunction(mod: any, preferredKeys: string[], probeHints: RegExp): Function | undefined {
  if (!mod) return undefined;
  for (const k of preferredKeys) {
    if (typeof mod[k] === "function") return mod[k];
  }
  for (const k of Object.keys(mod)) {
    const v = mod[k];
    if (typeof v !== "function") continue;
    try {
      const src = Function.prototype.toString.call(v);
      if (probeHints.test(src)) return v;
    } catch {}
  }
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === "function") return mod[k];
  }
  return undefined;
}

function newestByMtime(files: string[]): string[] {
  try {
    return files
      .map(f => ({ f, m: statSync(path.join(DIST_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map(x => x.f);
  } catch { return files; }
}

async function loadHeartbeatApi() {
  try {
    const all = readdirSync(DIST_DIR);
    const seFiles = newestByMtime(all.filter(f => f.startsWith("system-events-") && f.endsWith(".js")));
    if (seFiles.length > 0) {
      const mod: any = await import(path.join(DIST_DIR, seFiles[0]));
      state.heartbeatApi.enqueueSystemEvent = pickFunction(
        mod,
        ["enqueueSystemEvent", "i"],
        /enqueueSystemEvent|systemEvent|sessionKey|trusted/,
      );
    }
    const hwFiles = newestByMtime(all.filter(f => f.startsWith("heartbeat-wake-") && f.endsWith(".js")));
    if (hwFiles.length > 0) {
      const mod: any = await import(path.join(DIST_DIR, hwFiles[0]));
      state.heartbeatApi.requestHeartbeatNow = pickFunction(
        mod,
        ["requestHeartbeatNow", "n"],
        /requestHeartbeatNow|coalesceMs|heartbeat/,
      );
    }
    if (!state.heartbeatApi.enqueueSystemEvent || !state.heartbeatApi.requestHeartbeatNow) {
      log("error", `CRITICAL: heartbeat api not found · wake will not work · se=${!!state.heartbeatApi.enqueueSystemEvent} hb=${!!state.heartbeatApi.requestHeartbeatNow}`);
    } else {
      log("info", `heartbeat api loaded · se=true hb=true`);
    }
  } catch (e: any) {
    log("error", `CRITICAL: heartbeat api load failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

/**
 * v7.3 · wakeHer — 朴素版本，无 hack
 *   - reason = "hook:antitalker" (不绕路走 cron)
 *   - contextKey = "antitalker:violation" (纯 observability tag、无副作用)
 *   - wake_message 朴素传入，不加任何“无视上文”类前缀
 *
 *   修复 Bug 4 的倾正路径 = user config agents.defaults.heartbeat.target="last"
 *   (不是在 plugin 端动 prompt)
 */
async function wakeHer(sessionKey: string, message: string) {
  try {
    // v7.8 anti-heartbeat-swallow prefix: 防止 LLM 看到 heartbeat prompt 后直接 HEARTBEAT_OK 吞掉 wake
    const antiSwallow = "⚠️ antitalker 强制唤醒 · 禁止回 HEARTBEAT_OK/NO_REPLY · 必须针对下面的违规继续实际工作（调 tool / 发消息 / 修 bug）· 否则会再次拦截。\n\n";
    const wrapped = antiSwallow + message;

    // v8.3.1 fix: pre-set lastUserPreview so isInSelfReportContext() works when bot responds.
    // enqueueSystemEvent doesn't flow through before_message_write user-capture hook,
    // so without this the self-report context is never detected in production.
    let act = state.sessionActivity.get(sessionKey);
    if (!act) {
      act = { lastToolCallAtMs: 0, lastAssistantMsgAtMs: 0, lastAssistantHadToolCall: false, lastAssistantHadText: false, lastAssistantTextPreview: "", lastUserPreview: "", silenceAlertedAt: 0, chatId: "" };
      state.sessionActivity.set(sessionKey, act);
    }
    act.lastUserPreview = wrapped.slice(0, 800);

    if (state.heartbeatApi.enqueueSystemEvent) {
      state.heartbeatApi.enqueueSystemEvent(wrapped, {
        sessionKey,
        trusted: false,
        contextKey: "antitalker:violation",  // v7.3 纯 tag
      });
    } else {
      log("error", "wakeHer: enqueueSystemEvent missing · skipped");
    }
    if (state.heartbeatApi.requestHeartbeatNow) {
      state.heartbeatApi.requestHeartbeatNow({
        sessionKey,
        reason: "hook:antitalker",  // v7.3 回归朴素
        coalesceMs: 0,
      });
    } else {
      log("error", "wakeHer: requestHeartbeatNow missing · skipped");
    }
    log("info", `wakeHer → sessionKey=${sessionKey.slice(-20)} reason=hook:antitalker`);
  } catch (e: any) {
    log("warn", `wakeHer error: ${String(e?.message ?? e).slice(0, 120)}`);
  }
}

// -------- Audit log --------
function auditLog(entry: any) {
  try {
    const cfg = state.currentConfig?.audit_log;
    if (!cfg?.enabled || !cfg.path) return;
    const dir = path.dirname(cfg.path);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    try {
      const st = statSync(cfg.path);
      if (cfg.max_bytes > 0 && st.size > cfg.max_bytes) {
        const stamp = Date.now();
        renameSync(cfg.path, `${cfg.path}.${stamp}`);
        if (cfg.rotate_keep && cfg.rotate_keep > 0) {
          const base = path.basename(cfg.path);
          const bdir = path.dirname(cfg.path);
          const rotated = readdirSync(bdir)
            .filter(f => f.startsWith(base + "."))
            .map(f => ({ f, full: path.join(bdir, f), m: (() => { try { return statSync(path.join(bdir, f)).mtimeMs; } catch { return 0; } })() }))
            .sort((a, b) => b.m - a.m);
          const extras = rotated.slice(cfg.rotate_keep);
          for (const old of extras) {
            try { unlinkSync(old.full); } catch {}
          }
        }
      }
    } catch {}
    const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n";
    fsp.appendFile(cfg.path, line).catch(() => {});
  } catch {}
}

// -------- Prompt supplement --------
function buildPromptSupplement(): (params: any) => string[] {
  return (_params: any): string[] => {
    try {
      const cfg = state.currentConfig;
      if (!cfg?.prompt_injection?.enabled) return [];
      const lines: string[] = [cfg.prompt_injection.section_title];
      if (cfg.prompt_injection.include_rule_list) {
        for (const rule of cfg.rules) {
          const desc = rule.human_description ?? rule.label;
          lines.push(`- **${rule.label}** (${rule.severity}): ${desc}`);
        }
        for (const tr of cfg.tool_rules) {
          const desc = tr.human_description ?? tr.label;
          lines.push(`- **[tool] ${tr.label}**: ${desc}`);
        }
      }
      lines.push(cfg.prompt_injection.footer_template);
      return lines;
    } catch (e: any) {
      log("warn", `prompt supplement error: ${e.message}`);
      return [];
    }
  };
}

// -------- Hooks --------
async function handleBeforeToolCall(event: any, ctx: any): Promise<any> {
  try {
    const cfg = state.currentConfig;
    if (!cfg) return {};
    const toolName = String(event?.toolName ?? "");
    const runId = String(event?.runId ?? ctx?.runId ?? "");
    const sessionKey = String(ctx?.sessionKey ?? "");
    if (!toolName) return {};

    const tc = getTurnCtx(sessionKey, runId);
    // v7.4: 不再在 before_tool_call 里累积 tc.tools (由 before_message_write 负责)
    // 这里只用 local count 做 bare_yield 判断

    for (const rule of cfg.tool_rules) {
      if (rule.tool_name !== toolName) continue;
      const cond = rule.condition?.tool_count_lte;
      if (!cond) continue;
      const exclude = new Set(cond.exclude ?? []);
      // v7.4: before_tool_call 是流式·tc.tools 这时可能由 before_message_write 写了上一 turn 的 ·
      // 但 bare_yield 每个 tool 前检查是判断"即将调这个 tool 时之前的 tool_count"·
      // 不用 tc.tools · 改用一个独立的流式计数属性
      const toolsStream = (tc as any)._toolsStream ?? [];
      const count = toolsStream.filter((t: string) => !exclude.has(t)).length;
      if (count <= cond.value) {
        const reason = renderTemplate(rule.action.block_reason, { tool_count: count, tool_name: toolName });
        log("warn", `VIOLATION rule=${rule.id} tool_block tool=${toolName} tool_count=${count}`);
        auditLog({ type: "tool_block", rule: rule.id, sessionKey: sessionKey.slice(-20), tool: toolName, count });
        return { block: true, blockReason: reason };
      }
    }
    // v7.4: 检查完后再 append (这样 bare_yield 判断 "调这个 tool 前累计" 的语义保留)
    (tc as any)._toolsStream = [...((tc as any)._toolsStream ?? []), toolName];
    return {};
  } catch (e: any) {
    log("error", `handleBeforeToolCall crashed (fail-open): ${e.message}`);
    return {};
  }
}

async function handleAfterToolCall(_event: any, _ctx: any): Promise<any> {
  return {};
}

/**
 * v7.4 · handleBeforeMessageWrite — 修 Bug #1 (tool_count 时序)
 *
 * Root cause (主人 2026-05-03 戳破):
 *   v7.3 用 before_tool_call 累积 tools 到 turnCtx · message_sending 时读。
 *   但 OpenClaw runtime 的 hook 调用顺序是
 *     message_sending (LLM 生成完 text) → before_tool_call (tool 逐个跑)
 *   所以 message_sending 时 turnCtx.tools 还是 · tool_count=0 误认狯收。
 *
 * Fix:
 *   改用 before_message_write hook · event.message 是完整 assistant message
 *   (含所有 tool_use blocks) · 一次数对。
 *   这个 hook 在 message 写 jsonl 之前触发 · 比 message_sending 更早 ·
 *   能看到完整 content array · 包含 {type:"text"} + {type:"tool_use", name:...}。
 *
 *   在这个 hook 里：
 *   1. 提取所有 tool_use.name → turnCtx.tools (替代 before_tool_call 累积)
 *   2. 提取所有 text content 拼接 → 早期违规检查(可选 · 但这里不拦截 ·
 *      message_sending 才拦 · 保证和 v7.3 同样的用户体验)
 *
 *   before_tool_call hook 仍保留 · 只用于 bare_yield tool 拦截 · 不再累积 turnCtx.tools。
 */
// v7.4.3 · MUST be sync — before_message_write 是同步 hook。
// v7.4/v7.4.1/v7.4.2 写成 async → OpenClaw log:
//   [hooks] before_message_write handler from her-antitalker-poc
//   returned a Promise; this hook is synchronous and the result was ignored.
// → 整个 handler 被丢弃 · tc.tools 永远空 · Bug #1 真元凶是这个。
let _bmwCallCount = 0;
function handleBeforeMessageWrite(event: any, ctx: any): any {
  try {
    const msg = event?.message;
    if (!msg || msg.role !== "assistant") return {};
    const content = msg.content;
    if (!Array.isArray(content)) return {};

    // v7.4.2 debug: 一次性 dump 前 5 次触发 + 任何包含 toolCall 的 · 诊断 shape
    _bmwCallCount++;
    const hasToolCall = content.some((b: any) => b?.type === "toolCall" || b?.type === "tool_use");
    if (_bmwCallCount <= 5 || hasToolCall) {
      try {
        const types = content.map((b: any) => b?.type).filter(Boolean);
        const names = content.filter((b: any) => b?.type === "toolCall" || b?.type === "tool_use").map((b: any) => b?.name);
        log("warn", `BMW#${_bmwCallCount} types=[${types.join(",")}] names=[${names.join(",")}] msgKeys=[${Object.keys(msg).join(",")}] ctxKeys=[${Object.keys(ctx ?? {}).join(",")}] runId=${ctx?.runId ?? "?"}`);
      } catch {}
    }

    const sessionKey = String(ctx?.sessionKey ?? "");
    if (!sessionKey) return {};

    // v7.5 铁铟cycle修：抛弃 runId key · 用 sessionKey 单一维度 state (toolsBySessionKey Map)
    //   Root cause: BMW ctx 没 runId · 如果 fallback 到 msg.responseId ·
    //     然而 message_sending 的 ctx 也没 runId 而且 fallback 到 "" → key mismatch →
    //     MS 永远读不到 BMW push 的 tools。
    //   Fix: 两边都以 sessionKey 为唯一 key。语义："当前 session 最近一个 LLM turn 的 tools list"。
    //   MS 完成违规判定后清空·下个 turn 从 0 开始。
    let tools = state.toolsBySessionKey.get(sessionKey);
    if (!tools) {
      tools = [];
      state.toolsBySessionKey.set(sessionKey, tools);
    }

    // 两种 block type 都要检查 (OpenAI api 用 "toolCall", Anthropic 用 "tool_use")
    let pushed = 0;
    let hadText = false;
    let textPreview = "";
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const t = block.type;
      if ((t === "toolCall" || t === "tool_use") && typeof block.name === "string") {
        tools.push(block.name);
        pushed++;
      } else if (t === "text" && typeof block.text === "string" && block.text.length > 0) {
        hadText = true;
        if (!textPreview) textPreview = block.text.slice(0, 200);
      }
    }

    // LRU 限制：toolsBySessionKey 单条最多 128 个 (常规 session 多行 1-10 个 tool)
    if (tools.length > 128) tools.splice(0, tools.length - 128);

    if (pushed > 0) {
      log("info", `BMW push sessionKey=${sessionKey.slice(-20)} +${pushed} tools · total=${tools.length}`);
    }

    // v7.6 · 更新 session activity · 给 silence_watchdog / prose_only_ending 用
    const now = Date.now();
    let act = state.sessionActivity.get(sessionKey);
    if (!act) {
      act = { lastToolCallAtMs: 0, lastAssistantMsgAtMs: 0, lastAssistantHadToolCall: false, lastAssistantHadText: false, lastAssistantTextPreview: "", lastUserPreview: "", silenceAlertedAt: 0, chatId: "" };
      state.sessionActivity.set(sessionKey, act);
    }
    const sourceChatId = resolveSourceChatId(sessionKey, ctx);
    if (sourceChatId) act.chatId = sourceChatId;
    act.lastAssistantMsgAtMs = now;
    act.lastAssistantHadToolCall = pushed > 0;
    act.lastAssistantHadText = hadText;
    if (pushed > 0) act.lastToolCallAtMs = now;
    if (hadText) act.lastAssistantTextPreview = textPreview;
    // LRU prune sessionActivity
    if (state.sessionActivity.size > 4096) {
      const oldestKey = state.sessionActivity.keys().next().value;
      if (oldestKey) state.sessionActivity.delete(oldestKey);
    }

    // v7.10 · 记录 conversationId/channelId → sessionKey 映射
    // message_sending hook 的 ctx 不含 sessionKey 但含 conversationId/channelId
    // 此处建立反查表供 MS fallback 使用
    const convId = String(ctx?.conversationId ?? ctx?.channelId ?? "");
    if (convId && sessionKey) {
      state.convToSession.set(convId, sessionKey);
      if (state.convToSession.size > 4096) {
        const oldest = state.convToSession.keys().next().value;
        if (oldest) state.convToSession.delete(oldest);
      }
    }
    // v8.5 fix: BMW has sessionKey, MS has conversationId. Bridge them.
    // BMW sessionKey format: "agent:main:feishu:group:oc_xxx" or just "oc_xxx" suffix
    // MS conversationId format: "oc_xxx" or "feishu:oc_xxx"
    // Extract oc_ pattern from sessionKey and map both forms.
    const ocMatch = sessionKey.match(/(oc_[a-f0-9]+)/);
    if (ocMatch) {
      const ocId = ocMatch[1];
      state.convToSession.set(ocId, sessionKey);
      state.convToSession.set("feishu:" + ocId, sessionKey);
      if (state.convToSession.size > 8192) {
        const it = state.convToSession.keys();
        for (let i = 0; i < 100; i++) { const k = it.next().value; if (k) state.convToSession.delete(k); }
      }
    }

    // v9.0 · BMW-based violation detection (replaces MS dependency)
    // openclaw 0503 + openclaw-lark: message_sending hook is NOT called for normal replies
    // (only called from legacy bundled feishu path). Detect violations here instead.
    // Trigger: assistant message with text but NO toolCall in this message = "final reply".
    if (hadText && pushed === 0 && textPreview.length > 0) {
      try { runViolationCheck(textPreview, sessionKey, tools, ctx); } catch (e: any) {
        log("error", `BMW violation check crashed (fail-open): ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }

    return {};
  } catch (e: any) {
    log("error", `handleBeforeMessageWrite crashed (fail-open): ${e.message}`);
    return {};
  }
}

/**
 * v9.0 · Violation check extracted from handleMessageSending.
 * Called from BMW when assistant message has text but no toolCall (= final reply).
 */
function runViolationCheck(content: string, sessionKey: string, tools: string[], ctx: any): void {
  const cfg = state.currentConfig;
  if (!cfg) return;

  // Snapshot + clear tools (same as MS did)
  const sessionTools = [...tools];
  state.toolsBySessionKey.delete(sessionKey);
  const tc = { tools: sessionTools } as any;

  // prose_only_ending check
  const proseCheck = checkProseOnlyEnding(content, sessionKey, tc.tools);
  if (proseCheck.fire && isInSelfReportContext(sessionKey)) {
    log("info", `prose_only_ending self_report_skip: sessionKey=${sessionKey.slice(-12)}`);
    auditLog({ type: "self_report_skip", rule: "prose_only_ending", sessionKey: sessionKey.slice(-20), preview: content.slice(0, 120) });
  } else if (proseCheck.fire && !isOnCooldown(sessionKey, "prose_only_ending", 30)) {
    noteCooldownFire(sessionKey, "prose_only_ending");
    const preview = content.slice(0, 200).replace(/\n/g, " ");
    log("warn", `VIOLATION rule=prose_only_ending tc=${tc.tools.length} reason=${proseCheck.reason}`);
    auditLog({ type: "text_violation", rule: "prose_only_ending", severity: "high", sessionKey: sessionKey.slice(-20), preview, tool_count: tc.tools.length, tools: tc.tools, wake: true });
    const body = `**汇报尾 prose · 0 toolCall · ${proseCheck.reason}**\n\n${fenceViolationText(preview)}`;
    for (const target of routeTargets(sessionKey, ctx, cfg.notification?.target_chats ?? [])) {
      pushFeishuCard(target.chat_id, "⚠️ her 光说不练 (prose 收尾)", body, "red");
    }
    const wakeMsg = `[antitalker prose_only_ending] 你汇报完没调 tool · ${proseCheck.reason}\n原文:\n${fenceViolationText(preview)}\n\n任务未完 · 立刻继续。`;
    wakeHer(sessionKey, wakeMsg);
    return;
  }

  // delivery_response_required check
  const delivCheck = checkDeliveryResponseRequired(content, sessionKey);
  if (delivCheck.fire && !isOnCooldown(sessionKey, "delivery_response_required", 60)) {
    noteCooldownFire(sessionKey, "delivery_response_required");
    const preview = content.slice(0, 200);
    log("warn", `VIOLATION rule=delivery_response_required reason=${delivCheck.reason}`);
    auditLog({ type: "text_violation", rule: "delivery_response_required", severity: "high", sessionKey: sessionKey.slice(-20), preview, wake: true });
    const body = `**exec 完后只回 HEARTBEAT_OK/NO_REPLY · 无汇报**\n\n${delivCheck.reason}`;
    for (const target of routeTargets(sessionKey, ctx, cfg.notification?.target_chats ?? [])) {
      pushFeishuCard(target.chat_id, "⚠️ her 逿成 (exec 后无汇报)", body, "red");
    }
    const wakeMsg = `[antitalker delivery_response_required] exec 完了 你只回了 "${preview.trim()}" · 没汇报结果 · ${delivCheck.reason}\n马上总结 + 下一步。`;
    wakeHer(sessionKey, wakeMsg);
    return;
  }

  // isExempt check
  const exemptVerdict = isExempt(content, tc, sessionKey);
  if (exemptVerdict) { log("info", `BMW-check isExempt=true for sessionKey=${sessionKey.slice(-12)} content=${content.slice(0,60)}`); return; }

  // Rule matching
  for (const rule of cfg.rules) {
    if (!rule._regex) continue;
    if (!safeTest(rule._regex, !!rule._isRe2, content)) continue;

    if (isInSelfReportContext(sessionKey)) {
      const stripped = stripQuotedContent(content);
      if (!safeTest(rule._regex, !!rule._isRe2, stripped)) {
        log("info", `v8.3 self-report skip: rule=${rule.id} sessionKey=${sessionKey.slice(-12)}`);
        auditLog({ type: "self_report_skip", rule: rule.id, sessionKey: sessionKey.slice(-20), preview: content.slice(0, 120) });
        continue;
      }
    }

    if (!rule.ignore_turn_tool_exemption) {
      if (isToolExempt(tc)) { log("info", `BMW-check tool-exempt rule=${rule.id} sessionKey=${sessionKey.slice(-12)}`); continue; }
    }

    if (isOnCooldown(sessionKey, rule.id, rule.cooldown_seconds)) continue;

    const { passed, toolCount } = evalBehavior(rule, tc);
    if (!passed) continue;

    noteCooldownFire(sessionKey, rule.id);
    const wasOver = isOverRateLimit(sessionKey);
    noteViolation(sessionKey);

    const preview = content.slice(0, 120).replace(/\n/g, " ");
    const fencedPreview = fenceViolationText(preview);
    const pushAdmin = (wasOver ? cfg.rate_limit.on_exceed.push_admin : rule.action.push_admin);
    const wakeHerEnabled = (wasOver ? cfg.rate_limit.on_exceed.wake_her : rule.action.wake_her) && rule.mode === "enforce";

    log("warn", `VIOLATION rule=${rule.id} severity=${rule.severity} tool_count=${toolCount} mode=${rule.mode} rate_limited=${wasOver}`);
    auditLog({
      type: "text_violation", rule: rule.id, severity: rule.severity,
      sessionKey: sessionKey.slice(-20), preview, tool_count: toolCount,
      tools: tc.tools, rate_limited: wasOver, wake: wakeHerEnabled, push: pushAdmin,
    });

    if (pushAdmin && cfg.notification.feishu_card.enabled) {
      const vars = {
        rule_label: rule.label, severity: rule.severity,
        violation_preview: preview, violation_text: fencedPreview,
        tool_count: toolCount, tool_names_list: tc.tools.join(", ") || "(无)",
      };
      const body = renderTemplate(cfg.notification.feishu_card.body_template, vars);
      const title = renderTemplate(cfg.notification.feishu_card.title, vars);
      for (const target of routeTargets(sessionKey, ctx, cfg.notification.target_chats)) {
        if (!severityGte(rule.severity, target.min_severity)) continue;
        pushFeishuCard(target.chat_id, title, body, cfg.notification.feishu_card.header_color);
      }
    }

    if (wakeHerEnabled && sessionKey) {
      const wakeMsg = renderTemplate(rule.action.wake_message_template, {
        violation_text: fencedPreview, rule_label: rule.label, severity: rule.severity, tool_count: toolCount,
      });
      wakeHer(sessionKey, wakeMsg);
    }

    break;
  }
}

/**
 * v7.2 Bug 1 · cooldown 顺序修复
 *   v7.1 bug: isOnCooldown() 读取 last 后 **立即 set(now)** → 即使 behavior 未通过
 *            也落盘冷却 → 下一轮真违规被跳过
 *   v7.2 fix: isOnCooldown() 现在是纯读取。只在确认违规(behavior 通过)之后
 *            才调 noteCooldownFire() 落盘。
 */
async function handleMessageSending(event: any, ctx: any): Promise<any> {
  try {
    const cfg = state.currentConfig;
    if (!cfg) return {};
    // v8.5 debug: dump MS ctx keys + sessionKey to diagnose wake routing
    if (state._msDebugCount === undefined) state._msDebugCount = 0;
    state._msDebugCount++;
    if (state._msDebugCount <= 10) {
      log("warn", `MS#${state._msDebugCount} ctxKeys=[${Object.keys(ctx ?? {}).join(",")}] sessionKey=${ctx?.sessionKey ?? "(empty)"} convId=${ctx?.conversationId ?? ctx?.channelId ?? "(none)"} agentId=${ctx?.agentId ?? "?"} eventKeys=[${Object.keys(event ?? {}).join(",")}] event.chatId=${event?.chatId ?? "(none)"} event.channelId=${event?.channelId ?? "(none)"} event.sessionKey=${event?.sessionKey ?? "(none)"} event.target=${event?.target ?? "(none)"}`);
    }
    const content = String(event?.content ?? "");
    let sessionKey = String(ctx?.sessionKey ?? "");
    const runId = String(ctx?.runId ?? "");
    // v7.7 · sessionKey empty fallback: pick most-recent-active session
    // Fixes prose_only_ending wakeHer fail when ctx.sessionKey is empty string.
    // Without fallback, enqueueSystemEvent rejects (requires sessionKey) so wake is a no-op.
    if (!sessionKey) {
      // v7.10 · 优先: 从 conversationId/channelId 反查 BMW 记录的 sessionKey
      const convId = String(ctx?.conversationId ?? ctx?.channelId ?? "");
      const mapped = convId ? state.convToSession.get(convId) : undefined;
      if (mapped) {
        sessionKey = mapped;
        log("warn", `v7.10 sessionKey fallback via convToSession convId=${convId.slice(-20)} → sk=${sessionKey.slice(-20)}`);
      }
    }
    // v8.5 fix: use agentId→sessionKey mapping from BMW (most reliable)
    if (!sessionKey) {
      const msAgentId = String(ctx?.agentId ?? "");
      const agentMapped = msAgentId ? state.agentToSession.get(msAgentId) : undefined;
      if (agentMapped) {
        sessionKey = agentMapped;
        log("info", `v8.5 sessionKey via agentToSession agentId=${msAgentId.slice(-20)} → sk=${sessionKey.slice(-20)}`);
      }
    }
    // v7.7 原有 fallback: 仍保留作兜底 (万一 BMW 还没跑过该 conversation)
    if (!sessionKey) {
      let bestSk = "";
      let bestTs = 0;
      for (const [sk, act] of state.sessionActivity) {
        if (act.lastAssistantMsgAtMs > bestTs) { bestTs = act.lastAssistantMsgAtMs; bestSk = sk; }
      }
      if (bestSk) {
        sessionKey = bestSk;
        log("warn", `v7.10 sessionKey fallback via lastActivity → ${sessionKey.slice(-20)} (convToSession miss)`);
      }
    }
    if (!content) return {};

    // v7.6 Bug #C1 根治: MS 入口立即 snapshot + delete sessionKey state
    //   Nova 压测铁证: v7.6 的 clearToolsOnExit() 放在 isExempt 路径后仍有漏点·
    //   任何 MS 分支（cooldown skip / behavior passed / rule not match / error catch）都会漏清
    //   解决: 入口一性 snapshot + delete · 后续所有分支读 local 变量 tc.tools
    //   下一 turn 介 BMW push 的都是干净数据。
    const sessionTools = state.toolsBySessionKey.get(sessionKey) ?? [];
    state.toolsBySessionKey.delete(sessionKey);  // v7.6 立即清·不是以前的 clearToolsOnExit
    const tc = getTurnCtx(sessionKey, runId);
    tc.tools = [...sessionTools];  // local copy · 和 state 解耦

    // v7.6 · 新规则优先最高: prose_only_ending + delivery_response_required
    // 这两条必须先于 isExempt 检查 · 因为:
    //   - prose 收尾一般会包含工具/规则文本 (如 antitalker) · meta_discussion 会误途
    //   - delivery 规则的 NO_REPLY / HEARTBEAT_OK 是 exempt content_prefix
    //     (它们合法 · 但在 exec completion 下不合法)

    // v7.6 · 新规则: prose_only_ending (包括无 content match 也能 fire)
    // v8.4 fix: self_report_skip — wake 后首条纯文字汇报不二次拦
    const proseCheck = checkProseOnlyEnding(content, sessionKey, tc.tools);
    if (proseCheck.fire && isInSelfReportContext(sessionKey)) {
      log("info", `prose_only_ending self_report_skip: sessionKey=${sessionKey.slice(-12)}`);
      auditLog({ type: "self_report_skip", rule: "prose_only_ending", sessionKey: sessionKey.slice(-20), preview: content.slice(0, 120) });
    } else if (proseCheck.fire && !isOnCooldown(sessionKey, "prose_only_ending", 30)) {
      noteCooldownFire(sessionKey, "prose_only_ending");
      const preview = content.slice(0, 200).replace(/\n/g, " ");
      log("warn", `VIOLATION rule=prose_only_ending tc=${tc.tools.length} reason=${proseCheck.reason}`);
      auditLog({ type: "text_violation", rule: "prose_only_ending", severity: "high", sessionKey: sessionKey.slice(-20), preview, tool_count: tc.tools.length, tools: tc.tools, wake: true });
      const body = `**汇报尾 prose · 0 toolCall · ${proseCheck.reason}**\n\n${fenceViolationText(preview)}`;
      for (const target of routeTargets(sessionKey, ctx, cfg.notification?.target_chats ?? [])) {
        pushFeishuCard(target.chat_id, "\u26a0\ufe0f her 光说不练 (prose 收尾)", body, "red");
      }
      const wakeMsg = `[antitalker prose_only_ending] 你汇报完没调 tool · ${proseCheck.reason}\n原文:\n${fenceViolationText(preview)}\n\n任务未完 · 立刻继续。`;
      wakeHer(sessionKey, wakeMsg);
      return {};
    }

    // v7.6 · 新规则: delivery_response_required · 优先于 isExempt
    const delivCheck = checkDeliveryResponseRequired(content, sessionKey);
    log("info", `delivCheck fire=${delivCheck.fire} reason=${delivCheck.reason}`);
    if (delivCheck.fire && !isOnCooldown(sessionKey, "delivery_response_required", 60)) {
      noteCooldownFire(sessionKey, "delivery_response_required");
      const preview = content.slice(0, 200);
      log("warn", `VIOLATION rule=delivery_response_required reason=${delivCheck.reason}`);
      auditLog({ type: "text_violation", rule: "delivery_response_required", severity: "high", sessionKey: sessionKey.slice(-20), preview, wake: true });
      const body = `**exec 完后只回 HEARTBEAT_OK/NO_REPLY · 无汇报**\n\n${delivCheck.reason}`;
      for (const target of routeTargets(sessionKey, ctx, cfg.notification?.target_chats ?? [])) {
        pushFeishuCard(target.chat_id, "\u26a0\ufe0f her 逿成 (exec 后无汇报)", body, "red");
      }
      const wakeMsg = `[antitalker delivery_response_required] exec 完了 你只回了 "${preview.trim()}" · 没汇报结果 · ${delivCheck.reason}\n马上总结 + 下一步。`;
      wakeHer(sessionKey, wakeMsg);
      return {};
    }

    // v8.1 · 经典规则评估：默认 tool-exempt；带 ignore_turn_tool_exemption 的规则穿透
    const exemptVerdict = isExempt(content, tc, sessionKey);
    if (exemptVerdict) { log("info", `MS isExempt=true for sessionKey=${sessionKey.slice(-12)} content=${content.slice(0,60)}`); return {}; }

    for (const rule of cfg.rules) {
      if (!rule._regex) continue;
      if (!safeTest(rule._regex, !!rule._isRe2, content)) continue;

      // v8.3: self-report detection — if bot is responding to an antitalker wake,
      // and the regex only matches within quoted/fenced text, it's a self-report.
      if (isInSelfReportContext(sessionKey)) {
        const stripped = stripQuotedContent(content);
        if (!safeTest(rule._regex, !!rule._isRe2, stripped)) {
          log("info", `v8.3 self-report skip: rule=${rule.id} sessionKey=${sessionKey.slice(-12)} (match only in quoted text)`);
          auditLog({ type: "self_report_skip", rule: rule.id, sessionKey: sessionKey.slice(-20), preview: content.slice(0, 120) });
          continue;
        }
      }

      // v8.1: per-rule tool exemption. Default = skip on substantial tools.
      // Rules with ignore_turn_tool_exemption:true bypass this (e.g. M2/M3).
      if (!rule.ignore_turn_tool_exemption) {
        if (isToolExempt(tc)) { log("info", `MS tool-exempt rule=${rule.id} sessionKey=${sessionKey.slice(-12)}`); continue; }
      }

      // v7.2 Bug 1 · cooldown 是纯读取 · 不落盘
      if (isOnCooldown(sessionKey, rule.id, rule.cooldown_seconds)) continue;

      const { passed, toolCount } = evalBehavior(rule, tc);
      if (!passed) continue;  // 有实质 tool call · 不是光说不练

      // 到这里才算真违规：既命中 regex，也过了 behavior。
      // v7.2 Bug 1 · 现在才落 cooldown，避免下一轮真违规被冤枉跳过
      noteCooldownFire(sessionKey, rule.id);

      const wasOver = isOverRateLimit(sessionKey);
      noteViolation(sessionKey);

      const preview = content.slice(0, 120).replace(/\n/g, " ");
      const fencedPreview = fenceViolationText(preview);
      const pushAdmin = (wasOver ? cfg.rate_limit.on_exceed.push_admin : rule.action.push_admin);
      const wakeHerEnabled = (wasOver ? cfg.rate_limit.on_exceed.wake_her : rule.action.wake_her) && rule.mode === "enforce";

      log("warn", `VIOLATION rule=${rule.id} severity=${rule.severity} tool_count=${toolCount} mode=${rule.mode} rate_limited=${wasOver}`);
      auditLog({
        type: "text_violation", rule: rule.id, severity: rule.severity,
        sessionKey: sessionKey.slice(-20), preview, tool_count: toolCount,
        tools: tc.tools, rate_limited: wasOver, wake: wakeHerEnabled, push: pushAdmin,
      });

      if (pushAdmin && cfg.notification.feishu_card.enabled) {
        const vars = {
          rule_label: rule.label, severity: rule.severity,
          violation_preview: preview, violation_text: fencedPreview,
          tool_count: toolCount, tool_names_list: tc.tools.join(", ") || "(无)",
        };
        const body = renderTemplate(cfg.notification.feishu_card.body_template, vars);
        // v8.3.1 fix: title 也过 renderTemplate，支持 {rule_label} 等占位符
        const title = renderTemplate(cfg.notification.feishu_card.title, vars);
        for (const target of routeTargets(sessionKey, ctx, cfg.notification.target_chats)) {
          if (!severityGte(rule.severity, target.min_severity)) continue;
          pushFeishuCard(target.chat_id, title, body, cfg.notification.feishu_card.header_color);
        }
      }

      if (wakeHerEnabled && sessionKey) {
        const wakeMsg = renderTemplate(rule.action.wake_message_template, {
          violation_text: fencedPreview, rule_label: rule.label, severity: rule.severity, tool_count: toolCount,
        });
        wakeHer(sessionKey, wakeMsg);
      }

      break;  // only fire highest-priority rule per message
    }

    // v7.6 · state 已在入口处清空 · 这里无需重复 delete
    return {};
  } catch (e: any) {
    log("error", `handleMessageSending crashed (fail-open): ${e.message}`);
    return {};
  }
}

// -------- v7.6 silence_watchdog + prose_only_ending + delivery_response_required --------

/**
 * v7.6 · silence_watchdog
 * 每 30s 扫所有 sessionActivity · 如果:
 *   - 最后一条 assistant 有 text 且没 toolCall (prose 收尾)
 *   - 距离最后 toolCall > silence_gap_ms 
 *   - 距离上次 silence_alert > silence_cooldown_ms
 * 则 wake her + push feishu 卡。
 */
function handleSilenceWatchdog() {
  try {
    const cfg = state.currentConfig;
    if (!cfg) return;
    const silenceGapMs = (cfg as any)?.silence?.gap_ms ?? 10 * 60 * 1000;  // default 10min
    const silenceCooldownMs = (cfg as any)?.silence?.cooldown_ms ?? 30 * 60 * 1000;  // wake 限速 30min
    const enabled = (cfg as any)?.silence?.enabled ?? false;
    if (!enabled) return;
    const now = Date.now();
    for (const [sessionKey, act] of state.sessionActivity.entries()) {
      if (!act.lastAssistantHadText) continue;
      if (act.lastAssistantHadToolCall) continue;
      const lastMs = act.lastToolCallAtMs || act.lastAssistantMsgAtMs;
      if (now - lastMs < silenceGapMs) continue;
      const rawPreview = (act.lastAssistantTextPreview || "").trim();
      // v7.9.1: do not wake on silent/status replies or already-answered/ended sessions.
      if (/^(HEARTBEAT_OK|NO_REPLY|Memory flushed|Current thinking level:|Model set to|🦞 OpenClaw)/i.test(rawPreview)) continue;
      const lastInboundAtMs = Number((act as any).lastInboundAtMs || 0);
      if (lastInboundAtMs > 0 && lastInboundAtMs <= act.lastAssistantMsgAtMs) continue;
      if (now - act.silenceAlertedAt < silenceCooldownMs) continue;
      // fire
      act.silenceAlertedAt = now;
      const gapMin = Math.round((now - lastMs) / 60000);
      const preview = rawPreview.replace(/\n/g, " ").slice(0, 120);
      log("warn", `VIOLATION rule=silent_too_long severity=high tool_count=0 sessionKey=${sessionKey.slice(-20)} gap=${gapMin}min lastText="${preview}"`);
      auditLog({
        type: "silent_too_long",
        rule: "silent_too_long",
        severity: "high",
        sessionKey: sessionKey.slice(-20),
        gap_minutes: gapMin,
        last_text_preview: preview,
        wake: true,
      });
      // push feishu + wake her
      const title = (cfg as any)?.silence?.title ?? "\ud83d\udea8 Her 沉默超时";
      const body = `距上次调 tool 已经 **${gapMin}min** 没动\n\n最后一条 text:\n${fenceViolationText(preview)}\n\n**rule=silent_too_long · 却停不干 = 睡**`;
      for (const target of routeTargets(sessionKey, null, cfg.notification?.target_chats ?? [])) {
        pushFeishuCard(target.chat_id, title, body, "red");
      }
      const wakeMsg = `[antitalker silent_too_long] 你 ${gapMin}min 没调任何 tool · 上次说:\n${fenceViolationText(preview)}\n\n任务未完·继续执行。`;
      wakeHer(sessionKey, wakeMsg);
    }
  } catch (e: any) {
    log("error", `silence_watchdog crashed: ${e.message}`);
  }
}

/**
 * v7.6 · 检查 prose_only_ending
 * 在 message_sending 里调 · 如果当前 turn = only text + text_len >= 50 · 且上次也没 toolCall · 则 VIOLATION
 */
function checkProseOnlyEnding(content: string, sessionKey: string, tools: string[]): { fire: boolean; reason: string } {
  const cfg = state.currentConfig;
  const rule = (cfg as any)?.prose_only_ending;
  if (!rule?.enabled) return { fire: false, reason: "" };
  const minLen = rule.min_text_len ?? 50;
  // tools.length == 0 means this turn no toolCall was recorded
  if (tools.length > 0) return { fire: false, reason: "has tool" };
  if (!content || content.length < minLen) return { fire: false, reason: "too short" };
  // skip heartbeat/noreply exemption - 不在 prose_only 范畴
  if (/^(HEARTBEAT_OK|NO_REPLY|Memory flushed)/i.test(content.trim())) return { fire: false, reason: "system reply" };
  return { fire: true, reason: `text_len=${content.length} no_tool` };
}

/**
 * v7.6 · delivery_response_required
 * 如果上次 user prompt 包含 "Exec completed" / "async command completion" · 而 her 回复只有 HEARTBEAT_OK / NO_REPLY · 则失责。
 * (用 state.sessionActivity.lastUserPreview 识别)
 */
function checkDeliveryResponseRequired(content: string, sessionKey: string): { fire: boolean; reason: string } {
  const cfg = state.currentConfig;
  const rule = (cfg as any)?.delivery_response_required;
  if (!rule?.enabled) return { fire: false, reason: "" };
  const act = state.sessionActivity.get(sessionKey);
  if (!act) return { fire: false, reason: "no activity" };
  const userPrev = (act.lastUserPreview || "").toLowerCase();
  const triggers = rule.user_trigger_keywords ?? ["exec completed", "async command completion", "command completion details"];
  const matched = triggers.some((k: string) => userPrev.includes(String(k).toLowerCase()));
  if (!matched) return { fire: false, reason: "no trigger" };
  const trimmed = content.trim();
  if (!/^(HEARTBEAT_OK|NO_REPLY)\s*\.?$/i.test(trimmed)) return { fire: false, reason: "replied substantively" };
  return { fire: true, reason: `user_had="${userPrev.slice(0,60)}" her_only="${trimmed}"` };
}

// -------- Plugin entry --------
const plugin = {
  id: PLUGIN_ID,
  name: "Antitalker v8.3.1 (self-report fix + title template)",
  version: "0.0.831",
  description: "事前教 + 拦 + 通知 + main session 唤醒 · 全 yaml 配置 · 热加载 · v8.3.1 · self-report production fix + red card title renderTemplate",

  // v7.6 测试用 · 暴露内部 handler 给 harness
  _handlers: {
    get silenceWatchdog() { return handleSilenceWatchdog; },
    get proseCheck() { return checkProseOnlyEnding; },
    get deliveryCheck() { return checkDeliveryResponseRequired; },
  },

  register(api: any) {
    try {
      state.logger = api.logger ?? console;

      // v7.3.1 · 缓存 OpenClaw 的 resolved config 以便读 feishu appId/appSecret (fleet-level fix)
      setPluginConfigRef(api.config ?? null);

      if (state.mtimePollTimer) { clearInterval(state.mtimePollTimer); state.mtimePollTimer = null; }
      if (state.prunerTimer) { clearInterval(state.prunerTimer); state.prunerTimer = null; }

      state.currentConfig = loadConfig() ?? emptyConfig();
      if (existsSync(CONFIG_PATH)) state.lastMtime = statSync(CONFIG_PATH).mtimeMs;
      log("warn", `v7.6 loaded · rules=${state.currentConfig.rules.length} tool_rules=${state.currentConfig.tool_rules.length}`);

      loadHeartbeatApi();

      startMtimePoller();

      state.prunerTimer = setInterval(pruneStaleTurnCtx, 60_000);

      if (typeof api.registerMemoryPromptSupplement === "function") {
        api.registerMemoryPromptSupplement(buildPromptSupplement());
        log("info", "prompt supplement registered");
      }

      if (api.on) {
        api.on("before_tool_call", handleBeforeToolCall, { name: "antitalker-v7_6-tool" });
        api.on("after_tool_call", handleAfterToolCall, { name: "antitalker-v7_6-after" });
        api.on("before_message_write", handleBeforeMessageWrite, { name: "antitalker-v7_6-msgwrite" });
        api.on("message_sending", handleMessageSending, { name: "antitalker-v7_6-msg" });
        // v7.6 · capture user prompt 导出 将 lastUserPreview 写入 sessionActivity 给 delivery_response_required 用
        try {
          api.on("before_message_write", (event: any, ctx: any): any => {
            try {
              const msg = event?.message;
              if (!msg || msg.role !== "user") return {};
              const c = msg.content;
              let txt = "";
              if (typeof c === "string") txt = c;
              else if (Array.isArray(c)) txt = c.map((b: any) => (b?.type === "text" && typeof b.text === "string") ? b.text : "").join(" ");
              const sk = String(ctx?.sessionKey ?? "");
              if (!sk) return {};
              let act = state.sessionActivity.get(sk);
              if (!act) {
                act = { lastToolCallAtMs: 0, lastAssistantMsgAtMs: 0, lastAssistantHadToolCall: false, lastAssistantHadText: false, lastAssistantTextPreview: "", lastUserPreview: "", silenceAlertedAt: 0, chatId: "" };
                state.sessionActivity.set(sk, act);
              }
              const sourceChatId = extractFeishuChatIdFromText(txt);
              if (sourceChatId) act.chatId = sourceChatId;
              (act as any).lastInboundAtMs = Date.now();
              act.lastUserPreview = (txt || "").slice(0, 800);
            } catch {}
            return {};
          }, { name: "antitalker-v7_6-userprompt" });
        } catch {}
        log("info", "hooks registered: before_tool_call, after_tool_call, before_message_write, message_sending");
      }

      // v7.6 silence_watchdog 每 30s 扫
      if (state.silenceWatchdogTimer) clearInterval(state.silenceWatchdogTimer);
      state.silenceWatchdogTimer = setInterval(handleSilenceWatchdog, 30_000);
      log("info", "silence_watchdog started (30s interval)");

      log("warn", `ready · config=${CONFIG_PATH}`);
    } catch (e: any) {
      try { log("error", `register() crashed: ${String(e?.message ?? e).slice(0, 200)}`); }
      catch { console.error("[antitalker-v7.4] register crashed:", e); }
    }
  },
};

export default plugin;
