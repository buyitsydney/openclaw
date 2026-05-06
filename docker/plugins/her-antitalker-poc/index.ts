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

// -------- Stop-Hook Pipeline (M1: same-turn enforcement) --------
import { StopHookPipeline, createProseOnlyHook, createGetFollowUpMessages } from "./stop-hook-pipeline.js";
import type { StopHookContext } from "./stop-hook-pipeline.js";
// M1 (2026-05-07): agent-followup-bridge removed. Same-turn enforcement is delivered by
// patched agent-loop.js → globalThis.__openclaw_stopHookPipeline. No bridge, no watchdog
// fallback, no wake tricks. See docs/her/stop-hook-pipeline-architecture.md.
// -------- No-Toolcall Guard (M1.1: YAML-driven, no keyword matching) --------
import { NoToolcallGuard } from "./no-toolcall-guard.js";

// -------- Constants --------
const PLUGIN_ID = "her-antitalker-poc";
const CONFIG_PATH = "/data/.openclaw/workspace/.antitalker/rules.yaml";
const NO_TOOLCALL_GUARD_YAML = "/data/.openclaw/workspace/.antitalker/no-toolcall-guard.yaml";
// v9.0 · audit-group.json 路径默认是 /data/.openclaw/workspace/.antitalker/audit-group.json
// 用 let + getter,允许测试通过 _handlers.setAuditGroupPath() 重定向
let AUDIT_GROUP_PATH = "/data/.openclaw/workspace/.antitalker/audit-group.json";
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

// v9.0 异步 watchdog: BMW 同步 hook 不能 await 网络调用 → 改成"标记 + 异步处理"
// PendingViolation = 一个待处理的违规事件，由 BMW 同步入队，violationWatchdog 5s 异步取出处理
interface PendingViolation {
  sessionKey: string;
  chatId: string;          // 标记时已知的 chatId（群聊有 oc_xxx，私聊空 → watchdog 时从 audit 群兜底）
  ruleId: string;
  severity: string;
  preview: string;
  cardTitle: string;
  cardBody: string;
  wakeMessage: string;
  pushAdmin: boolean;      // 是否要发红卡（cooldown 决定）
  wakeEnabled: boolean;    // 是否要 wake（rule.mode=enforce 时才 true）
  markedAtMs: number;      // 入队时间，给自愈检测用
  retries: number;
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
  // v9.0 · pendingViolations: BMW 同步入队，violationWatchdog 5s 异步取出 push+wake
  // key = sessionKey + ":" + ruleId · Map.set 幂等覆盖防同 turn flood
  pendingViolations: Map<string, PendingViolation>;
  // v9.0 · audit 群缓存: 5min 内不再 verify，避免每次 watchdog 都 GET /im/v1/chats
  auditGroupCache: { chatId: string; verifiedAtMs: number } | null;
  // v9.0 · 主人识别: BMW user-capture 抓到的最近一次 DM session 的 owner open_id (ou_xxx)
  // 用于 requestAuditSetup 时告诉 her 拉哪个用户进群 · 多用户场景每 her 容器一份
  lastDmOwnerOpenId: string;
  // v9.0 · 主人 DM 的 sessionKey · 用作 audit 群 setup 时 wake 的目标 session
  lastDmSessionKey: string;
  // v9.0 · requestAuditSetup 节流: 30min 内不重复发 setup wake (防 her 还没建好群就被反复催)
  lastSetupRequestAtMs: number;
  mtimePollTimer: NodeJS.Timeout | null;
  prunerTimer: NodeJS.Timeout | null;
  silenceWatchdogTimer: NodeJS.Timeout | null;  // v7.6 · 30s 扫 silent_too_long
  violationWatchdogTimer: NodeJS.Timeout | null;  // v9.0 · 5s 扫 pendingViolations
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
    pendingViolations: new Map(),  // v9.0
    auditGroupCache: null,         // v9.0
    lastDmOwnerOpenId: "",         // v9.0
    lastDmSessionKey: "",          // v9.0
    lastSetupRequestAtMs: 0,       // v9.0
    mtimePollTimer: null,
    prunerTimer: null,
    silenceWatchdogTimer: null,
    violationWatchdogTimer: null,  // v9.0
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
// v9.0 · 同样兼容老 state (热 reload 时旧 state 可能没这些字段)
if (!globalAny[STATE_KEY].pendingViolations) globalAny[STATE_KEY].pendingViolations = new Map();
if (globalAny[STATE_KEY].auditGroupCache === undefined) globalAny[STATE_KEY].auditGroupCache = null;
if (globalAny[STATE_KEY].violationWatchdogTimer === undefined) globalAny[STATE_KEY].violationWatchdogTimer = null;
if (globalAny[STATE_KEY].lastDmOwnerOpenId === undefined) globalAny[STATE_KEY].lastDmOwnerOpenId = "";
if (globalAny[STATE_KEY].lastDmSessionKey === undefined) globalAny[STATE_KEY].lastDmSessionKey = "";
if (globalAny[STATE_KEY].lastSetupRequestAtMs === undefined) globalAny[STATE_KEY].lastSetupRequestAtMs = 0;
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

async function pushFeishuCard(chatId: string, title: string, bodyMarkdown: string, headerColor: string): Promise<boolean> {
  const token = await getFeishuToken();
  if (!token) { log("warn", "no feishu token · skip push"); return false; }
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
    if (d?.code !== 0) { log("warn", `push card failed: code=${d?.code} msg=${d?.msg}`); return false; }
    return true;
  } catch (e: any) { log("warn", `push card error: ${String(e?.message ?? e).slice(0, 120)}`); return false; }
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
      // 0503 minified exports: enqueueSystemEvent → "a", drainSystemEvents → "i"
      // 老代码 fallback "i" 会绑到 drainSystemEvents → wake 永远清空队列而不是入队
      state.heartbeatApi.enqueueSystemEvent = pickFunction(
        mod,
        ["enqueueSystemEvent", "a"],
        /function enqueueSystemEvent/,
      );
    }
    const hwFiles = newestByMtime(all.filter(f => f.startsWith("heartbeat-wake-") && f.endsWith(".js")));
    if (hwFiles.length > 0) {
      const mod: any = await import(path.join(DIST_DIR, hwFiles[0]));
      // 0503 改名: requestHeartbeatNow → requestHeartbeat (去 Now 后缀), 别名 "o"
      // 老代码 fallback "n" 在新版是 HEARTBEAT_SKIP_LANES_BUSY 常量,不是函数
      state.heartbeatApi.requestHeartbeatNow = pickFunction(
        mod,
        ["requestHeartbeat", "requestHeartbeatNow", "o"],
        /function requestHeartbeat/,
      );
    }
    if (!state.heartbeatApi.enqueueSystemEvent || !state.heartbeatApi.requestHeartbeatNow) {
      log("error", `CRITICAL: heartbeat api not found · wake will not work · se=${!!state.heartbeatApi.enqueueSystemEvent} hb=${!!state.heartbeatApi.requestHeartbeatNow}`);
    } else {
      const seName = state.heartbeatApi.enqueueSystemEvent?.name ?? "?";
      const hbName = state.heartbeatApi.requestHeartbeatNow?.name ?? "?";
      log("info", `heartbeat api loaded · se=${seName} hb=${hbName}`);
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
// M1 (2026-05-07): wakeHer REMOVED. Legacy heartbeat-based wake is not an acceptable
// fallback for same-turn enforcement. All continuation flows through stop-hook-pipeline
// (globalThis.__openclaw_stopHookPipeline) which is delivered inside the same loop turn
// by the patched pi-agent-core agent-loop.js. If you feel tempted to add a wake path
// back, read docs/her/stop-hook-pipeline-architecture.md first — the answer is no.

// -------- v9.0 · Async violation watchdog (replaces sync MS hook side-effects) --------
//
// Architecture (see plan: 异步 violation watchdog):
//   BMW 是同步 hook → 不能在里面 await pushFeishuCard / wakeHer
//   (runtime 会丢弃返回的 Promise · 网络调用没等完就被 GC)
//
//   Fix:
//     BMW 同步: 检测违规 → markPendingViolation() = Map.set(纯同步, 0 失败)
//     5s 后 watchdog (setInterval async callback): 取出 → push 红卡 → wakeHer (await 安全)
//
//   关键不变量:
//     - BMW 路径 0 异步 / 0 网络 / 0 失败
//     - watchdog 在 setInterval async callback 里 · async/await 100% 工作
//     - state 在 globalThis · 热重载存活
//     - Map.set 幂等覆盖 (key=sessionKey:ruleId) · 防同 turn flood

/**
 * markPendingViolation · 由 BMW / MS 调用
 * 把违规事件入队，5s 内由 watchdog 处理。
 * 此函数纯同步，不涉及 I/O 或 Promise，绝不会阻塞或失败。
 */
function markPendingViolation(v: Omit<PendingViolation, "markedAtMs" | "retries">): void {
  const key = `${v.sessionKey}:${v.ruleId}`;
  state.pendingViolations.set(key, {
    ...v,
    markedAtMs: Date.now(),
    retries: 0,
  });
  // LRU 防泄漏: 极端情况 (watchdog 没起来) 也不让 Map 无限大
  if (state.pendingViolations.size > 256) {
    const oldest = state.pendingViolations.keys().next().value;
    if (oldest) state.pendingViolations.delete(oldest);
  }
  log("info", `pendingViolations.set key=${key.slice(-40)} chatId=${v.chatId || "(audit)"}`);
}

/**
 * v9.0 · readAuditGroupChatId · 纯读取 + 验证,不创建。
 *
 * 流程:
 *   1. 内存缓存 5min 内复用
 *   2. 读 audit-group.json (由 her 的 setup skill 写入) → 有 chat_id → 飞书 verify → return
 *   3. 文件不存在 / chat 已删 / token 不可用 → return null (调用方走 requestAuditSetup)
 *
 * 注意: 此函数 *不* 创建群、*不* 调主人。所有"创造性"动作交给 her (skill 路径)。
 */
async function readAuditGroupChatId(): Promise<string | null> {
  const cfg = state.currentConfig as any;
  const ag = cfg?.audit_group;
  if (!ag?.enabled) return null;

  // 内存缓存 5min — watchdog 5s 跑一次,不要每次都 GET 飞书
  if (state.auditGroupCache && Date.now() - state.auditGroupCache.verifiedAtMs < 5 * 60_000) {
    return state.auditGroupCache.chatId;
  }

  let chatId = "";
  try {
    if (existsSync(AUDIT_GROUP_PATH)) {
      const data = JSON.parse(readFileSync(AUDIT_GROUP_PATH, "utf8"));
      chatId = String(data?.chat_id || "");
    }
  } catch (e: any) {
    log("warn", `audit-group.json read failed: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (!chatId) return null;

  // 验证 chat 还活着 (主人可能手动退群 / 删群)
  const token = await getFeishuToken();
  if (!token) {
    log("warn", "readAuditGroupChatId: no feishu token · skip verify");
    return null;
  }
  try {
    const r = await fetch(`https://open.feishu.cn/open-apis/im/v1/chats/${chatId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d: any = await r.json();
    if (d?.code === 0) {
      state.auditGroupCache = { chatId, verifiedAtMs: Date.now() };
      return chatId;
    }
    log("warn", `audit group ${chatId} verify failed · code=${d?.code} msg=${d?.msg} · invalidating`);
    state.auditGroupCache = null;
    // 文件 stale → 删,让 her 下次 setup 重写
    try { unlinkSync(AUDIT_GROUP_PATH); } catch {}
    return null;
  } catch (e: any) {
    log("warn", `audit group verify error: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  }
}

/**
 * v9.0 · requestAuditSetup · 给 her 发"建 audit 群"的 wake event
 *
 * 触发条件 (在 violationWatchdog 里):
 *   - audit_group.enabled=true
 *   - readAuditGroupChatId() 返回 null (没建过 / 群没了)
 *   - state.lastDmOwnerOpenId 已识别 (BMW user-capture 抓到的 ou_xxx)
 *   - state.lastDmSessionKey 已识别 (主人 DM 的 sessionKey)
 *   - 30min 内没发过 setup 请求 (节流防 her 还没建好就被反复催)
 *
 * 实现: enqueueSystemEvent 给主人 DM session 发指令 · skill antitalker-audit-setup
 *      会被 her 触发(描述里有"audit"/"setup"等关键词) · 由 her 用 feishu_chat tool 建群
 *      + lark-cli 写文件,完全自动。
 *
 * 失败兜底: 静默 return false · 下次 watchdog 再试 (30min 节流后)。
 */
function requestAuditSetup(): boolean {
  const ownerOpenId = state.lastDmOwnerOpenId;
  const targetSk = state.lastDmSessionKey;
  if (!ownerOpenId || !targetSk) {
    return false;  // 还没识别主人 · 等下一条 DM 触发
  }
  const now = Date.now();
  if (now - state.lastSetupRequestAtMs < 30 * 60_000) {
    return false;  // 30min 节流
  }
  if (!state.heartbeatApi.enqueueSystemEvent || !state.heartbeatApi.requestHeartbeatNow) {
    log("error", "requestAuditSetup: heartbeat api missing · cannot dispatch");
    return false;
  }

  const message = [
    "⚠️ antitalker · 自动建群请求",
    "",
    "你需要立刻执行 antitalker-audit-setup skill (描述含 'antitalker' / 'audit' / 'setup'):",
    "  1. 用 feishu_chat tool 创建一个名为 'Antitalker 审计' 的私有群组",
    `  2. 把主人 (open_id=${ownerOpenId}) 拉进群`,
    "  3. 把群的 chat_id 写到 /data/.openclaw/workspace/.antitalker/audit-group.json",
    `     格式: {"chat_id": "oc_xxx", "owner_open_id": "${ownerOpenId}", "created_at": ${now}}`,
    "  4. 在群里发一条欢迎卡: '本群由 antitalker 自动建立, 用于私聊违规通知, 勿删'",
    "",
    "完成后回复 NO_REPLY 即可。建群是首要任务,不要在这步光说不练。",
  ].join("\n");

  try {
    state.heartbeatApi.enqueueSystemEvent(message, {
      sessionKey: targetSk,
      trusted: false,
      contextKey: "antitalker:audit-setup",
    });
    state.heartbeatApi.requestHeartbeatNow({
      sessionKey: targetSk,
      reason: "hook:antitalker-setup",
      coalesceMs: 0,
    });
    state.lastSetupRequestAtMs = now;
    log("warn", `requestAuditSetup → sk=${targetSk.slice(-20)} owner=${ownerOpenId.slice(-12)}`);
    return true;
  } catch (e: any) {
    log("error", `requestAuditSetup error: ${String(e?.message ?? e).slice(0, 200)}`);
    return false;
  }
}

/**
 * v9.0 · ensureAuditGroupReady · watchdog 调用此函数解析私聊违规的红卡目标
 *
 * 返回值:
 *   - chatId (string): audit 群已存在且验证通过, 直接发卡
 *   - null: 群还没建好 / 主人未识别 / 节流中, 这次违规跳过红卡 (wake 仍执行)
 *           同时尝试 requestAuditSetup() 让 her 异步去建
 */
async function ensureAuditGroupReady(): Promise<string | null> {
  const existing = await readAuditGroupChatId();
  if (existing) return existing;
  // 群还没建好 → 触发 her 去建 (异步,这次违规先 skip 红卡)
  requestAuditSetup();
  return null;
}

/**
 * violationWatchdog · 5s 跑一次 · 处理所有 pendingViolations
 *
 * 边界穷举见 plan 文档表格 (1-13)。核心逻辑:
 *   - 自愈跳过 (5s 内 bot 已经调 tool)
 *   - chatId 解析: 标记时已知 → sessionActivity 兜底 → ensureAuditGroupReady 私聊兜底
 *   - retries ≤ 3 · 超过放弃,防无限重试
 */
async function violationWatchdog(): Promise<void> {
  if (state.pendingViolations.size === 0) return;
  // 用 Array.from 快照,迭代时 Map 可能被 BMW 同步改写
  for (const [key, v] of Array.from(state.pendingViolations.entries())) {
    try {
      // 自愈检测: bot 在标记后 5s 内自己调了 tool · 跳过 wake/push
      const act = state.sessionActivity.get(v.sessionKey);
      if (act && act.lastToolCallAtMs > v.markedAtMs && act.lastAssistantHadToolCall) {
        log("info", `violation self-healed · key=${key.slice(-40)} (bot called tools after mark)`);
        auditLog({ type: "violation_self_healed", rule: v.ruleId, sessionKey: v.sessionKey.slice(-20), preview: v.preview });
        state.pendingViolations.delete(key);
        continue;
      }

      // 解析 chatId: 标记时 → activity → audit 群
      let chatId = v.chatId || act?.chatId || "";
      if (!chatId) {
        chatId = (await ensureAuditGroupReady()) || "";
      }

      // 发红卡 — pushFeishuCard 返回 false = 失败 (网络/API 错误),进入 retry 流程
      if (v.pushAdmin && chatId) {
        const ok = await pushFeishuCard(chatId, v.cardTitle, v.cardBody, "red");
        if (!ok) {
          throw new Error(`pushFeishuCard returned false for chat=${chatId}`);
        }
        log("info", `watchdog pushed card · chat=${chatId.slice(-12)} rule=${v.ruleId}`);
      } else if (v.pushAdmin && !chatId) {
        log("warn", `watchdog skip card · no chatId (audit group disabled or unavailable) · rule=${v.ruleId}`);
      }

      // M1 (2026-05-07): wake path removed from violation watchdog.
      // Same-turn continuation is now owned by stop-hook-pipeline (globalThis hook).
      // This watchdog's only remaining job is admin audit card notification (above).
      // v.wakeEnabled / v.wakeMessage kept for backwards-compat but not invoked here.

      state.pendingViolations.delete(key);
    } catch (e: any) {
      const cur = state.pendingViolations.get(key);
      if (!cur) continue;
      cur.retries++;
      log("warn", `violationWatchdog error · retry=${cur.retries}/3 · ${String(e?.message ?? e).slice(0, 200)}`);
      if (cur.retries >= 3) {
        log("error", `violation give up after 3 retries · key=${key.slice(-40)}`);
        auditLog({ type: "violation_give_up", rule: cur.ruleId, sessionKey: cur.sessionKey.slice(-20), preview: cur.preview });
        state.pendingViolations.delete(key);
      }
    }
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

      // M1 (2026-05-07): no-toolcall-guard evaluated inside stop-hook-pipeline.
      // BMW only records tools via toolsBySessionKey (done above); guard reads that
      // accumulator from the pipeline drain at loop's "want to stop" moment.
      // No BMW-time evaluation, no bridge, no markPendingViolation fallback.
    }

    return {};
  } catch (e: any) {
    log("error", `handleBeforeMessageWrite crashed (fail-open): ${e.message}`);
    return {};
  }
}

/**
 * v9.0 · Violation check — runs synchronously inside BMW (or MS).
 * Detects violations and ENQUEUES them via markPendingViolation().
 * No network/Promise side-effects → safe to call from sync hook.
 * The async violationWatchdog (5s) handles pushFeishuCard + wakeHer.
 */
function runViolationCheck(content: string, sessionKey: string, tools: string[], ctx: any): void {
  const cfg = state.currentConfig;
  if (!cfg) return;

  // Snapshot + clear tools (same as MS did)
  const sessionTools = [...tools];
  state.toolsBySessionKey.delete(sessionKey);
  const tc = { tools: sessionTools } as any;

  // 标记时已知的 chatId · 群聊从 sessionKey 提取出 oc_xxx · 私聊空 (watchdog 用 audit 群兜底)
  const targets = routeTargets(sessionKey, ctx, cfg.notification?.target_chats ?? []);
  const knownChatId = targets[0]?.chat_id ?? "";

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
    const wakeMsg = `[antitalker prose_only_ending] 你汇报完没调 tool · ${proseCheck.reason}\n原文:\n${fenceViolationText(preview)}\n\n任务未完 · 立刻继续。`;
    markPendingViolation({
      sessionKey, chatId: knownChatId, ruleId: "prose_only_ending", severity: "high",
      preview, cardTitle: "⚠️ her 光说不练 (prose 收尾)", cardBody: body,
      wakeMessage: wakeMsg, pushAdmin: true, wakeEnabled: true,
    });
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
    const wakeMsg = `[antitalker delivery_response_required] exec 完了 你只回了 "${preview.trim()}" · 没汇报结果 · ${delivCheck.reason}\n马上总结 + 下一步。`;
    markPendingViolation({
      sessionKey, chatId: knownChatId, ruleId: "delivery_response_required", severity: "high",
      preview, cardTitle: "⚠️ her 逿成 (exec 后无汇报)", cardBody: body,
      wakeMessage: wakeMsg, pushAdmin: true, wakeEnabled: true,
    });
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
    const pushAdmin = (wasOver ? cfg.rate_limit.on_exceed.push_admin : rule.action.push_admin) && cfg.notification.feishu_card.enabled;
    const wakeHerEnabled = (wasOver ? cfg.rate_limit.on_exceed.wake_her : rule.action.wake_her) && rule.mode === "enforce";

    log("warn", `VIOLATION rule=${rule.id} severity=${rule.severity} tool_count=${toolCount} mode=${rule.mode} rate_limited=${wasOver}`);
    auditLog({
      type: "text_violation", rule: rule.id, severity: rule.severity,
      sessionKey: sessionKey.slice(-20), preview, tool_count: toolCount,
      tools: tc.tools, rate_limited: wasOver, wake: wakeHerEnabled, push: pushAdmin,
    });

    const vars = {
      rule_label: rule.label, severity: rule.severity,
      violation_preview: preview, violation_text: fencedPreview,
      tool_count: toolCount, tool_names_list: tc.tools.join(", ") || "(无)",
    };
    const body = renderTemplate(cfg.notification.feishu_card.body_template, vars);
    const title = renderTemplate(cfg.notification.feishu_card.title, vars);
    const wakeMsg = renderTemplate(rule.action.wake_message_template, {
      violation_text: fencedPreview, rule_label: rule.label, severity: rule.severity, tool_count: toolCount,
    });

    // 如果 routeTargets 给出的目标过滤掉了 (severity 不达标),仍然通过 audit 群发
    // (rules 都是 high/medium · target_chats 默认 min_severity=low · 一般会通过)
    let chatId = knownChatId;
    if (chatId && targets[0] && !severityGte(rule.severity, targets[0].min_severity)) {
      chatId = "";  // severity 不达标,目标群跳过,但 audit 群仍会兜底
    }

    markPendingViolation({
      sessionKey, chatId, ruleId: rule.id, severity: rule.severity,
      preview, cardTitle: title, cardBody: body,
      wakeMessage: wakeMsg, pushAdmin, wakeEnabled: wakeHerEnabled && !!sessionKey,
    });

    break;  // only fire highest-priority rule per message
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
    if (state._msDebugCount === undefined) state._msDebugCount = 0;
    state._msDebugCount++;
    if (state._msDebugCount <= 10) {
      log("warn", `MS#${state._msDebugCount} ctxKeys=[${Object.keys(ctx ?? {}).join(",")}] sessionKey=${ctx?.sessionKey ?? "(empty)"} convId=${ctx?.conversationId ?? ctx?.channelId ?? "(none)"} agentId=${ctx?.agentId ?? "?"}`);
    }
    const content = String(event?.content ?? "");
    if (!content) return {};

    // sessionKey resolution + fallbacks (preserved from v8.x)
    let sessionKey = String(ctx?.sessionKey ?? "");
    if (!sessionKey) {
      const convId = String(ctx?.conversationId ?? ctx?.channelId ?? "");
      const mapped = convId ? state.convToSession.get(convId) : undefined;
      if (mapped) sessionKey = mapped;
    }
    if (!sessionKey) {
      const msAgentId = String(ctx?.agentId ?? "");
      const agentMapped = msAgentId ? state.agentToSession.get(msAgentId) : undefined;
      if (agentMapped) sessionKey = agentMapped;
    }
    if (!sessionKey) {
      let bestSk = "";
      let bestTs = 0;
      for (const [sk, act] of state.sessionActivity) {
        if (act.lastAssistantMsgAtMs > bestTs) { bestTs = act.lastAssistantMsgAtMs; bestSk = sk; }
      }
      if (bestSk) sessionKey = bestSk;
    }
    if (!sessionKey) return {};

    // v9.0 · MS hook delegates to runViolationCheck (same path as BMW).
    // runViolationCheck enqueues PendingViolation; violationWatchdog (5s async) handles push/wake.
    // In 0503 + openclaw-lark, MS rarely fires; this is belt-and-suspenders coverage if some
    // delivery path still routes through MS. Cooldown inside runViolationCheck dedupes BMW+MS.
    const sessionTools = state.toolsBySessionKey.get(sessionKey) ?? [];
    runViolationCheck(content, sessionKey, sessionTools, ctx);
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
      // M1 (2026-05-07): wake removed from silence_watchdog. If Her went silent for
      // 30min without any turn activity, the stop-hook-pipeline is not running for this
      // session (loop already exited). Admin card notification above is the only action.
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
  name: "Antitalker v9.0 (async violation watchdog + auto audit group)",
  version: "0.0.900",
  description: "BMW 同步标记 + 5s 异步 watchdog 处理 push/wake · 私聊违规自维护 audit 群 · 0503 + openclaw-lark 兼容",

  // v7.6 测试用 · 暴露内部 handler 给 harness
  _handlers: {
    get silenceWatchdog() { return handleSilenceWatchdog; },
    get proseCheck() { return checkProseOnlyEnding; },
    get deliveryCheck() { return checkDeliveryResponseRequired; },
    // v9.0 test seams
    get state() { return state; },
    get bmw() { return handleBeforeMessageWrite; },
    get ms() { return handleMessageSending; },
    get violationWatchdog() { return violationWatchdog; },
    get markPendingViolation() { return markPendingViolation; },
    get readAuditGroupChatId() { return readAuditGroupChatId; },
    get requestAuditSetup() { return requestAuditSetup; },
    get ensureAuditGroupReady() { return ensureAuditGroupReady; },
    get setPluginConfigRef() { return setPluginConfigRef; },
    set currentConfig(cfg: any) { state.currentConfig = cfg; },
    // v9.0 · 测试用: 重定向 audit-group.json 路径
    setAuditGroupPath(p: string) { AUDIT_GROUP_PATH = p; },
    // M1 · stop-hook-pipeline test seam
    get stopHookPipeline() { return StopHookPipeline.getInstance(); },
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
        // v9.0 · 同时从 ctx.conversationId 自动识别主人 open_id (DM = "user:ou_xxx")
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

              // v9.0 · 自动识别主人 open_id
              // 0503 conversationId 格式:
              //   群聊: "chat:oc_xxx"
              //   私聊: "user:ou_xxx"  ← 这里 ou_xxx 就是主人 open_id
              // (0424 用 "feishu:oc_xxx" / "feishu:ou_xxx" · 也兼容)
              const conv = String(ctx?.conversationId ?? ctx?.channelId ?? "");
              // 注意: feishu open_id 字符集 = [A-Za-z0-9_] (实际多为 32 hex,但官方文档不强制)
              // 用宽松字符集避免漏识别
              const m = conv.match(/^(?:user|feishu):(ou_[A-Za-z0-9_]+)$/);
              if (m) {
                const ownerOpenId = m[1];
                if (ownerOpenId !== state.lastDmOwnerOpenId || sk !== state.lastDmSessionKey) {
                  state.lastDmOwnerOpenId = ownerOpenId;
                  state.lastDmSessionKey = sk;
                  log("info", `v9.0 owner identified · open_id=${ownerOpenId.slice(-12)} sk=${sk.slice(-20)}`);
                }
              }
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

      // v9.0 violation_watchdog 每 5s 扫 pendingViolations · 异步处理 push/wake
      // (BMW 同步标记，watchdog 在 setInterval async callback 里 await 安全)
      if (state.violationWatchdogTimer) clearInterval(state.violationWatchdogTimer);
      state.violationWatchdogTimer = setInterval(violationWatchdog, 5_000);
      log("info", "violation_watchdog started (5s interval)");

      // ─── M1: Stop-Hook Pipeline · globalThis registration (same-turn enforcement) ───
      // Bind pipeline.drain() to globalThis.__openclaw_stopHookPipeline. The in-place
      // patched pi-agent-core agent-loop.js (see patch-agent-loop.sh) reads this global
      // when config.getFollowUpMessages is absent — any OpenClaw-constructed AgentLoop
      // automatically gets same-turn enforcement. No bridge. No watchdog. No fallback.
      try {
        const pipeline = StopHookPipeline.getInstance();

        // antitalker:prose-only (commitment text without tool call)
        pipeline.register("antitalker:prose-only", createProseOnlyHook(), 10);

        // no-toolcall-guard (YAML-driven substantial-tool whitelist)
        const guard = NoToolcallGuard.fromYaml(NO_TOOLCALL_GUARD_YAML);
        (state as any)._noToolcallGuard = guard;
        pipeline.register("no-toolcall-guard", (ctx: StopHookContext) => {
          const result = guard.evaluate(ctx.sessionKey, { toolNames: ctx.lastToolNames });
          if (result && result.length > 0) {
            return { shouldContinue: true, message: typeof result[0].content === "string" ? result[0].content : JSON.stringify(result[0].content), hookName: "no-toolcall-guard" };
          }
          return { shouldContinue: false };
        }, 20);

        // Session-context locator for the drain function
        const getStopHookContext = (): StopHookContext | null => {
          for (const [sk, act] of state.sessionActivity.entries()) {
            if (act.lastAssistantMsgAtMs > 0) {
              return {
                sessionKey: sk,
                lastAssistantText: act.lastAssistantTextPreview || "",
                lastAssistantHadToolCall: act.lastAssistantHadToolCall,
                lastToolNames: state.toolsBySessionKey.get(sk) ?? [],
                turnIndex: 0,
              };
            }
          }
          return null;
        };

        // globalThis registration — picked up by patched pi-agent-core agent-loop.js.
        // Bind to BOTH globalThis and Node's global to survive vm/jiti isolation.
        const drainFn = createGetFollowUpMessages(pipeline, getStopHookContext);
        let drainCallSeq = 0;
        const wrappedDrain = async () => {
          drainCallSeq++;
          log("warn", `pipeline drain CALLED seq=${drainCallSeq}`);
          try {
            const msgs = await drainFn();
            log("warn", `pipeline drain seq=${drainCallSeq} → ${msgs.length} msgs`);
            return msgs;
          } catch (e: any) {
            log("error", `pipeline drain crashed (fail-open): ${String(e?.message ?? e).slice(0, 200)}`);
            return [];
          }
        };
        (globalThis as any).__openclaw_stopHookPipeline = wrappedDrain;
        try { (global as any).__openclaw_stopHookPipeline = wrappedDrain; } catch {}
        // Also expose via a dedicated Symbol.for registry so any vm realm can resolve it.
        const GLOBAL_KEY = Symbol.for("openclaw.stopHookPipeline.v1");
        (globalThis as any)[GLOBAL_KEY] = wrappedDrain;
        log("warn", `M1 stop-hook-pipeline: bound to globalThis/global/Symbol.for · globalThis===global? ${(globalThis as any) === (global as any)} · hooks=[${pipeline.getRegisteredHooks().join(",")}] · yaml=${NO_TOOLCALL_GUARD_YAML}`);
      } catch (pipelineErr: any) {
        log("error", `M1 stop-hook-pipeline registration failed: ${String(pipelineErr?.message ?? pipelineErr).slice(0, 200)}`);
      }

      log("warn", `ready · config=${CONFIG_PATH}`);
    } catch (e: any) {
      try { log("error", `register() crashed: ${String(e?.message ?? e).slice(0, 200)}`); }
      catch { console.error("[antitalker-v7.4] register crashed:", e); }
    }
  },
};

export default plugin;
