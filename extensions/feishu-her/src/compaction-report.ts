/**
 * Compaction Report Generator
 *
 * Parses session JSONL files and produces structured visibility reports
 * for compaction events. Supports Markdown and Feishu rich-text output.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId?: string;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: {
    readFiles?: string[];
    modifiedFiles?: string[];
  };
  fromHook?: boolean;
}

export interface SessionMessage {
  type: "message";
  id: string;
  parentId?: string;
  timestamp: string;
  message: {
    role: "user" | "assistant" | "system";
    content: unknown[];
    timestamp?: number;
    api?: string;
    provider?: string;
    model?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens: number;
      cost?: Record<string, number>;
    };
    stopReason?: string;
  };
}

interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

type SessionJsonlEntry =
  | SessionHeader
  | CompactionEntry
  | SessionMessage
  | { type: string; id: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Config Panel types
// ---------------------------------------------------------------------------

interface ConfigParamInfo {
  value: number;
  source: string;
}

export interface ConfigPanel {
  contextWindow?: ConfigParamInfo;
  reserveTokens?: ConfigParamInfo;
  keepRecentTokens?: ConfigParamInfo;
  maxHistoryShare?: ConfigParamInfo;
  contextTokens?: ConfigParamInfo;
  compactionMode?: string;
  triggerThreshold?: number;
  triggerJudgment: string;
}

// ---------------------------------------------------------------------------
// Boundary types
// ---------------------------------------------------------------------------

export interface CompactionBoundary {
  summarizedMessageIds: string[];
  summarizedPreview: string[];
  keptMessageIds: string[];
  keptPreview: string[];
  isBootstrap: boolean;
  isChainedDouble: boolean;
}

// ---------------------------------------------------------------------------
// Next Turn Input types
// ---------------------------------------------------------------------------

export interface NextTurnInputComponent {
  label: string;
  estimatedTokens: number;
}

export interface NextTurnInput {
  components: NextTurnInputComponent[];
  totalEstimate: number;
  remainingCapacity?: number;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Compression Stats types
// ---------------------------------------------------------------------------

export interface CompressionStats {
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfterEstimate: number;
  compressionRatio: number;
}

// ---------------------------------------------------------------------------
// Parsed Summary types
// ---------------------------------------------------------------------------

export interface ParsedSummary {
  raw: string;
  goal?: string;
  progress?: { done: string[]; inProgress: string[]; blocked: string[] };
  keyDecisions?: string[];
  nextSteps?: string[];
  criticalContext?: string[];
  toolFailures?: string[];
  readFiles?: string[];
  modifiedFiles?: string[];
  isFallback: boolean;
  isBootstrap: boolean;
}

// ---------------------------------------------------------------------------
// Safeguard Estimate
// ---------------------------------------------------------------------------

export interface SafeguardEstimate {
  maxHistoryTokens: number;
  newContentTokensEstimate: number;
  pruningTriggered: boolean;
  explanation: string;
}

// ---------------------------------------------------------------------------
// Compaction Report
// ---------------------------------------------------------------------------

export interface CompactionReport {
  sessionId: string;
  sessionFile: string;
  compactionId: string;
  timestamp: string;
  tokensBefore: number;
  summary: string;
  firstKeptEntryId: string;
  fromHook: boolean;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  boundary: CompactionBoundary;
  safeguardEstimate?: SafeguardEstimate;
  totalCompactionsInSession: number;
  compactionIndex: number;
  configPanel?: ConfigPanel;
  nextTurnInput?: NextTurnInput;
  compression?: CompressionStats;
  parsedSummary?: ParsedSummary;
}

// ---------------------------------------------------------------------------
// Build opts
// ---------------------------------------------------------------------------

export interface BuildReportOpts {
  compactionIndex?: number;
  contextWindow?: number;
  reserveTokens?: number;
  reserveTokensFloor?: number;
  keepRecentTokens?: number;
  maxHistoryShare?: number;
  contextTokens?: number;
  compactionMode?: string;
}

// ---------------------------------------------------------------------------
// SDK defaults
// ---------------------------------------------------------------------------

const SDK_RESERVE_TOKENS = 16_384;
const SDK_KEEP_RECENT_TOKENS = 20_000;
const OPENCLAW_RESERVE_FLOOR = 20_000;
const SAFETY_MARGIN = 1.2;

// ---------------------------------------------------------------------------
// JSONL Parsing
// ---------------------------------------------------------------------------

export function parseSessionJsonl(filePath: string): SessionJsonlEntry[] {
  const raw = readFileSync(filePath, "utf-8");
  const entries: SessionJsonlEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

export function extractCompactionEntries(entries: SessionJsonlEntry[]): CompactionEntry[] {
  return entries.filter((e): e is CompactionEntry => e.type === "compaction");
}

export function extractMessages(entries: SessionJsonlEntry[]): SessionMessage[] {
  return entries.filter((e): e is SessionMessage => e.type === "message");
}

// ---------------------------------------------------------------------------
// Token estimation helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: SessionMessage): number {
  let chars = 0;
  if (Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (typeof block === "object" && block !== null && "text" in block) {
        chars += ((block as { text: string }).text ?? "").length;
      }
    }
  } else if (typeof msg.message.content === "string") {
    chars = msg.message.content.length;
  }
  return Math.ceil(chars / 4) || 50;
}

function estimateSystemPromptTokens(entries: SessionJsonlEntry[]): number {
  for (const e of entries) {
    if (e.type !== "message") continue;
    const msg = e as SessionMessage;
    if (msg.message.role === "assistant" && msg.message.usage) {
      return Math.max(0, msg.message.usage.input - 200);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Boundary Analysis (FIXED — P0)
// ---------------------------------------------------------------------------

function extractTextPreview(msg: SessionMessage, maxLen = 80): string {
  const role = msg.message.role;
  let text = "";
  if (Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (typeof block === "object" && block !== null && "text" in block) {
        text = (block as { text: string }).text;
        break;
      }
    }
  } else if (typeof msg.message.content === "string") {
    text = msg.message.content;
  }
  const oneLine = text.replace(/\n/g, " ").trim();
  const preview = oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "…" : oneLine;
  return `[${role}] ${preview}`;
}

const BOOTSTRAP_PATTERNS = [
  "No prior history",
  "conversation is empty",
  "No specific goal identified",
];

function isBootstrapSummary(summary: string): boolean {
  const lower = summary.toLowerCase();
  return BOOTSTRAP_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function isChainedDoubleCompaction(
  compaction: CompactionEntry,
  prevCompaction: CompactionEntry | undefined,
): boolean {
  if (!prevCompaction) return false;
  if (compaction.tokensBefore > 2000) return false;
  const thisTime = new Date(compaction.timestamp).getTime();
  const prevTime = new Date(prevCompaction.timestamp).getTime();
  return Math.abs(thisTime - prevTime) < 60_000;
}

function computeBoundary(
  entries: SessionJsonlEntry[],
  compaction: CompactionEntry,
  prevCompaction: CompactionEntry | undefined,
): CompactionBoundary {
  const compactionIdx = entries.findIndex((e) => e.id === compaction.id);
  const prevIdx = prevCompaction ? entries.findIndex((e) => e.id === prevCompaction.id) : -1;

  const firstKeptId = compaction.firstKeptEntryId;
  const isBootstrap = isBootstrapSummary(compaction.summary);
  const isChained = isChainedDoubleCompaction(compaction, prevCompaction);

  const summarizedIds: string[] = [];
  const summarizedPreviews: string[] = [];
  const keptIds: string[] = [];
  const keptPreviews: string[] = [];

  let foundFirstKept = false;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.type !== "message") {
      if (e.id === firstKeptId) foundFirstKept = true;
      continue;
    }
    const msg = e as SessionMessage;

    if (i <= prevIdx) continue;
    if (i >= compactionIdx) {
      if (i > compactionIdx) {
        keptIds.push(msg.id);
        keptPreviews.push(extractTextPreview(msg));
      }
      continue;
    }

    if (msg.id === firstKeptId) foundFirstKept = true;

    if (foundFirstKept) {
      keptIds.push(msg.id);
      keptPreviews.push(extractTextPreview(msg));
    } else {
      summarizedIds.push(msg.id);
      summarizedPreviews.push(extractTextPreview(msg));
    }
  }

  // When firstKeptEntryId points to a very early non-message entry
  // (like model_change) and all messages end up in "kept", but the
  // compaction actually compressed them (bootstrap scenario), re-classify.
  if (
    summarizedIds.length === 0 &&
    keptIds.length > 0 &&
    compactionIdx > 0 &&
    keptIds.every((id) => {
      const idx = entries.findIndex((e) => e.id === id);
      return idx < compactionIdx;
    })
  ) {
    // All "kept" messages actually appear before the compaction entry.
    // After compaction, they are NOT loaded into context (replaced by summary).
    summarizedIds.push(...keptIds.splice(0));
    summarizedPreviews.push(...keptPreviews.splice(0));
  }

  return {
    summarizedMessageIds: summarizedIds,
    summarizedPreview: summarizedPreviews,
    keptMessageIds: keptIds,
    keptPreview: keptPreviews,
    isBootstrap,
    isChainedDouble: isChained,
  };
}

// ---------------------------------------------------------------------------
// Config Panel builder (P0)
// ---------------------------------------------------------------------------

function buildConfigPanel(
  compaction: CompactionEntry,
  opts: BuildReportOpts,
): ConfigPanel | undefined {
  const cw = opts.contextWindow;
  if (!cw) {
    return {
      triggerJudgment: `tokensBefore=${compaction.tokensBefore.toLocaleString()} (config 未传入, 无法计算阈值)`,
    };
  }

  const configReserve = opts.reserveTokens;
  const configFloor = opts.reserveTokensFloor;

  let effectiveReserve: number;
  let reserveSource: string;
  if (configReserve != null && configFloor != null) {
    effectiveReserve = Math.max(configReserve, configFloor);
    if (configFloor > configReserve) {
      reserveSource = `floor(${configFloor}) 覆盖 config(${configReserve})`;
    } else {
      reserveSource = `config(${configReserve})`;
    }
  } else if (configReserve != null) {
    effectiveReserve = Math.max(configReserve, OPENCLAW_RESERVE_FLOOR);
    reserveSource =
      OPENCLAW_RESERVE_FLOOR > configReserve
        ? `floor(${OPENCLAW_RESERVE_FLOOR}) 覆盖 config(${configReserve})`
        : `config(${configReserve})`;
  } else if (configFloor != null) {
    effectiveReserve = Math.max(SDK_RESERVE_TOKENS, configFloor);
    reserveSource = `floor(${configFloor})`;
  } else {
    effectiveReserve = OPENCLAW_RESERVE_FLOOR;
    reserveSource = `floor 兜底 (SDK=${SDK_RESERVE_TOKENS}, OpenClaw floor=${OPENCLAW_RESERVE_FLOOR})`;
  }

  const keepRecent = opts.keepRecentTokens ?? SDK_KEEP_RECENT_TOKENS;
  const keepSource =
    opts.keepRecentTokens != null ? `config(${opts.keepRecentTokens})` : `SDK 默认`;

  const threshold = cw - effectiveReserve;
  const triggered = compaction.tokensBefore > threshold;
  const judgment = triggered
    ? `${compaction.tokensBefore.toLocaleString()} > ${threshold.toLocaleString()} → 触发`
    : `${compaction.tokensBefore.toLocaleString()} < ${threshold.toLocaleString()} (手动触发或溢出)`;

  const panel: ConfigPanel = {
    contextWindow: { value: cw, source: "config" },
    reserveTokens: { value: effectiveReserve, source: reserveSource },
    keepRecentTokens: { value: keepRecent, source: keepSource },
    compactionMode: opts.compactionMode,
    triggerThreshold: threshold,
    triggerJudgment: judgment,
  };

  if (opts.maxHistoryShare != null) {
    panel.maxHistoryShare = {
      value: opts.maxHistoryShare,
      source: opts.maxHistoryShare === 0.5 ? "safeguard 默认" : `config(${opts.maxHistoryShare})`,
    };
  }

  if (opts.contextTokens != null) {
    panel.contextTokens = {
      value: opts.contextTokens,
      source: "config (不影响 compact 触发)",
    };
  }

  return panel;
}

// ---------------------------------------------------------------------------
// Next Turn Input builder (P0)
// ---------------------------------------------------------------------------

function buildNextTurnInput(
  boundary: CompactionBoundary,
  compaction: CompactionEntry,
  entries: SessionJsonlEntry[],
  opts: BuildReportOpts,
): NextTurnInput {
  const spTokens = estimateSystemPromptTokens(entries);
  const summaryTokens = estimateTokens(compaction.summary);

  let keptTokens = 0;
  for (const kid of boundary.keptMessageIds) {
    const msg = entries.find((e) => e.type === "message" && e.id === kid) as
      | SessionMessage
      | undefined;
    if (msg) keptTokens += estimateMessageTokens(msg);
  }

  const components: NextTurnInputComponent[] = [];
  if (spTokens > 0) {
    components.push({ label: "System Prompt", estimatedTokens: spTokens });
  }
  components.push({ label: "Compaction Summary", estimatedTokens: summaryTokens });
  if (boundary.keptMessageIds.length > 0) {
    components.push({
      label: `保留的 ${boundary.keptMessageIds.length} 条消息`,
      estimatedTokens: keptTokens,
    });
  }

  const total = components.reduce((s, c) => s + c.estimatedTokens, 0);
  const cw = opts.contextWindow;
  const remaining = cw ? cw - total : undefined;

  let warning: string | undefined;
  if (boundary.isBootstrap) {
    warning = "Bootstrap compaction: summary 内容极少, AI 将丢失大部分历史上下文";
  } else if (compaction.summary.length < 50) {
    warning = "Summary 异常短, AI 可能丢失重要历史信息";
  }

  return {
    components,
    totalEstimate: total,
    remainingCapacity: remaining,
    warning,
  };
}

// ---------------------------------------------------------------------------
// Compression Stats builder (P1)
// ---------------------------------------------------------------------------

function buildCompressionStats(
  boundary: CompactionBoundary,
  nextTurn: NextTurnInput,
  tokensBefore: number,
): CompressionStats {
  const messagesBefore = boundary.summarizedMessageIds.length + boundary.keptMessageIds.length;
  const messagesAfter = boundary.keptMessageIds.length;
  const tokensAfterEstimate = nextTurn.totalEstimate;
  const ratio = tokensBefore > 0 ? 1 - tokensAfterEstimate / tokensBefore : 0;

  return {
    messagesBefore,
    messagesAfter,
    tokensBefore,
    tokensAfterEstimate,
    compressionRatio: Math.max(0, Math.min(1, ratio)),
  };
}

// ---------------------------------------------------------------------------
// Summary Parser (P1)
// ---------------------------------------------------------------------------

const FALLBACK_MARKER = "Summary unavailable due to context limits";

export function parseSummary(raw: string): ParsedSummary {
  const isFallback = raw.includes(FALLBACK_MARKER);
  const isBootstrap = isBootstrapSummary(raw);

  const result: ParsedSummary = { raw, isFallback, isBootstrap };

  const readMatch = raw.match(/<read-files>\s*([\s\S]*?)\s*<\/read-files>/);
  if (readMatch) {
    result.readFiles = readMatch[1]!
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const modMatch = raw.match(/<modified-files>\s*([\s\S]*?)\s*<\/modified-files>/);
  if (modMatch) {
    result.modifiedFiles = modMatch[1]!
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const sections = splitSections(raw);
  result.goal = sections["goal"];
  result.keyDecisions = parseBulletList(sections["key decisions"]);
  result.nextSteps = parseBulletList(sections["next steps"]);
  result.criticalContext = parseBulletList(sections["critical context"]);
  result.toolFailures = parseBulletList(sections["tool failures"]);

  const progressRaw = sections["progress"];
  if (progressRaw) {
    result.progress = {
      done: parseSubsectionBullets(progressRaw, "done"),
      inProgress: parseSubsectionBullets(progressRaw, "in progress"),
      blocked: parseSubsectionBullets(progressRaw, "blocked"),
    };
  }

  return result;
}

function splitSections(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /^##\s+(.+)$/gm;
  let lastKey: string | undefined;
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (lastKey != null) {
      result[lastKey] = text.slice(lastEnd, match.index).trim();
    }
    lastKey = match[1]!.toLowerCase().trim();
    lastEnd = match.index + match[0].length;
  }
  if (lastKey != null) {
    result[lastKey] = text.slice(lastEnd).trim();
  }
  return result;
}

function parseBulletList(section: string | undefined): string[] | undefined {
  if (!section) return undefined;
  const items = section
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*(\[.\]\s*)?/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("###"));
  return items.length > 0 ? items : undefined;
}

function parseSubsectionBullets(section: string, subsection: string): string[] {
  const re = new RegExp(`###\\s+${subsection}\\s*\n([\\s\\S]*?)(?=###|$)`, "i");
  const match = section.match(re);
  if (!match) return [];
  return (
    match[1]!
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*(\[.\]\s*)?/, "").trim())
      .filter((l) => l.length > 0) ?? []
  );
}

// ---------------------------------------------------------------------------
// Safeguard Estimation
// ---------------------------------------------------------------------------

function estimateSafeguard(
  compaction: CompactionEntry,
  entries: SessionJsonlEntry[],
  opts?: BuildReportOpts,
): SafeguardEstimate | undefined {
  const contextWindow = opts?.contextWindow;
  if (!contextWindow) return undefined;
  const maxHistoryShare = opts?.maxHistoryShare ?? 0.5;

  const maxHistoryTokens = Math.floor(contextWindow * maxHistoryShare * SAFETY_MARGIN);
  const spEstimate = estimateSystemPromptTokens(entries);

  const pruningTriggered = spEstimate > maxHistoryTokens;
  const explanation = pruningTriggered
    ? `newContentTokens(~${spEstimate.toLocaleString()}) > maxHistoryTokens(${maxHistoryTokens.toLocaleString()}) → pruning triggered`
    : `newContentTokens(~${spEstimate.toLocaleString()}) <= maxHistoryTokens(${maxHistoryTokens.toLocaleString()}) → no pruning`;

  return {
    maxHistoryTokens,
    newContentTokensEstimate: spEstimate,
    pruningTriggered,
    explanation,
  };
}

// ---------------------------------------------------------------------------
// Report Builder
// ---------------------------------------------------------------------------

export function buildReport(
  entries: SessionJsonlEntry[],
  sessionFile: string,
  opts?: BuildReportOpts,
): CompactionReport | undefined {
  const compactions = extractCompactionEntries(entries);
  if (compactions.length === 0) return undefined;

  const idx = opts?.compactionIndex ?? compactions.length - 1;
  const compaction = compactions[idx];
  if (!compaction) return undefined;

  const prevCompaction = idx > 0 ? compactions[idx - 1] : undefined;
  const header = entries.find((e): e is SessionHeader => e.type === "session");
  const boundary = computeBoundary(entries, compaction, prevCompaction);
  const safeguardEstimate = estimateSafeguard(compaction, entries, opts);
  const configPanel = opts ? buildConfigPanel(compaction, opts) : undefined;
  const nextTurnInput = buildNextTurnInput(boundary, compaction, entries, opts ?? {});
  const compression = buildCompressionStats(boundary, nextTurnInput, compaction.tokensBefore);
  const parsed = parseSummary(compaction.summary);

  return {
    sessionId: header?.id ?? "unknown",
    sessionFile,
    compactionId: compaction.id,
    timestamp: compaction.timestamp,
    tokensBefore: compaction.tokensBefore,
    summary: compaction.summary,
    firstKeptEntryId: compaction.firstKeptEntryId,
    fromHook: compaction.fromHook ?? false,
    details: {
      readFiles: compaction.details?.readFiles ?? [],
      modifiedFiles: compaction.details?.modifiedFiles ?? [],
    },
    boundary,
    safeguardEstimate,
    totalCompactionsInSession: compactions.length,
    compactionIndex: idx,
    configPanel,
    nextTurnInput,
    compression,
    parsedSummary: parsed,
  };
}

export function buildAllReports(
  entries: SessionJsonlEntry[],
  sessionFile: string,
  opts?: BuildReportOpts,
): CompactionReport[] {
  const compactions = extractCompactionEntries(entries);
  return compactions
    .map((_, i) => buildReport(entries, sessionFile, { ...opts, compactionIndex: i }))
    .filter((r): r is CompactionReport => r !== undefined);
}

// ---------------------------------------------------------------------------
// Markdown Formatter
// ---------------------------------------------------------------------------

function fmtK(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(1)}K`;
  return `~${n}`;
}

export function formatMarkdown(report: CompactionReport): string {
  const lines: string[] = [];
  const b = report.boundary;

  // ── Header ──
  const modeLabel =
    report.configPanel?.compactionMode ?? (report.fromHook ? "Safeguard" : "Default");
  let statusTag = "";
  if (b.isChainedDouble) statusTag = " [链式双重触发]";
  else if (b.isBootstrap) statusTag = " [Bootstrap]";

  lines.push(`# Compaction Report${statusTag}`);
  lines.push("");

  const time = new Date(report.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  lines.push(`- **时间**: ${time}`);
  lines.push(`- **Session**: ${report.sessionId}`);
  lines.push(
    `- **Compaction**: #${report.compactionIndex + 1} / ${report.totalCompactionsInSession}`,
  );
  lines.push(`- **模式**: ${modeLabel}  |  **Hook**: ${report.fromHook ? "Yes" : "No"}`);
  lines.push("");

  // ── Config Panel (P0) ──
  if (report.configPanel) {
    const cp = report.configPanel;
    lines.push(`## 参数面板`);
    lines.push("");
    if (cp.contextWindow) {
      lines.push(
        `  contextWindow:     ${cp.contextWindow.value.toLocaleString()}  (${cp.contextWindow.source})`,
      );
    }
    if (cp.reserveTokens) {
      lines.push(
        `  reserveTokens:     ${cp.reserveTokens.value.toLocaleString()}  (${cp.reserveTokens.source})`,
      );
    }
    if (cp.keepRecentTokens) {
      lines.push(
        `  keepRecentTokens:  ${cp.keepRecentTokens.value.toLocaleString()}  (${cp.keepRecentTokens.source})`,
      );
    }
    if (cp.maxHistoryShare) {
      lines.push(
        `  maxHistoryShare:   ${cp.maxHistoryShare.value}  (${cp.maxHistoryShare.source})`,
      );
    }
    if (cp.contextTokens) {
      lines.push(
        `  contextTokens:     ${cp.contextTokens.value.toLocaleString()}  (${cp.contextTokens.source})`,
      );
    }
    if (cp.triggerThreshold != null) {
      lines.push(
        `  触发阈值:          ${cp.triggerThreshold.toLocaleString()}  (= contextWindow - reserveTokens)`,
      );
    }
    lines.push(`  ──────────────────────────────`);
    lines.push(`  ${cp.triggerJudgment}`);
    lines.push("");
  }

  // ── Compression Stats (P1) ──
  if (report.compression) {
    const c = report.compression;
    lines.push(`## 压缩对比`);
    lines.push("");
    lines.push(`               压缩前      压缩后(估)`);
    lines.push(
      `  消息数       ${String(c.messagesBefore).padStart(5)}       ${String(c.messagesAfter).padStart(5)}`,
    );
    lines.push(
      `  Token    ${c.tokensBefore.toLocaleString().padStart(9)}   ${fmtK(c.tokensAfterEstimate).padStart(9)}`,
    );
    lines.push(`  ────────────────────────────`);
    lines.push(`  压缩率: ${Math.round(c.compressionRatio * 100)}%`);
    lines.push("");
  }

  // ── File Operations ──
  if (report.details.readFiles.length > 0 || report.details.modifiedFiles.length > 0) {
    lines.push(`## 文件操作`);
    lines.push("");
    if (report.details.readFiles.length > 0) {
      lines.push(`**读取**: ${report.details.readFiles.join(", ")}`);
    }
    if (report.details.modifiedFiles.length > 0) {
      lines.push(`**修改**: ${report.details.modifiedFiles.join(", ")}`);
    }
    lines.push("");
  }

  // ── Boundary (P0 — fixed) ──
  lines.push(`## 边界分析`);
  lines.push("");

  if (b.isChainedDouble) {
    lines.push(
      `> 链式双重 compaction (tokensBefore=${report.tokensBefore}), 紧随上次 compaction 自动触发, 可忽略。`,
    );
    lines.push("");
  } else {
    lines.push(`### 被压缩 (${b.summarizedMessageIds.length} 条消息)`);
    lines.push("");
    if (b.summarizedPreview.length > 0) {
      for (const p of b.summarizedPreview.slice(0, 10)) {
        lines.push(`- ${p}`);
      }
      if (b.summarizedPreview.length > 10) {
        lines.push(`- ... 另有 ${b.summarizedPreview.length - 10} 条`);
      }
    } else {
      lines.push("- (无)");
    }
    lines.push("");
    lines.push(`### 保留原样 (${b.keptMessageIds.length} 条消息)`);
    lines.push("");
    if (b.keptPreview.length > 0) {
      for (const p of b.keptPreview.slice(0, 10)) {
        lines.push(`- ${p}`);
      }
      if (b.keptPreview.length > 10) {
        lines.push(`- ... 另有 ${b.keptPreview.length - 10} 条`);
      }
    } else {
      lines.push("- (无 — 全部消息被压缩)");
    }
    lines.push("");
  }

  // ── Next Turn Input (P0) ──
  if (report.nextTurnInput && !b.isChainedDouble) {
    const nt = report.nextTurnInput;
    lines.push(`## 下一轮 AI 输入`);
    lines.push("");
    for (let i = 0; i < nt.components.length; i++) {
      const c = nt.components[i]!;
      lines.push(`  ${i + 1}. ${c.label.padEnd(30)} ${fmtK(c.estimatedTokens).padStart(12)}`);
    }
    lines.push(`  ────────────────────────────────────────`);
    lines.push(
      `  合计: ${fmtK(nt.totalEstimate)}${nt.remainingCapacity != null ? ` (剩余空间 ${fmtK(nt.remainingCapacity)})` : ""}`,
    );
    if (nt.warning) {
      lines.push(`  ⚠️ ${nt.warning}`);
    }
    lines.push("");
  }

  // ── Safeguard Estimate ──
  if (report.safeguardEstimate && !b.isChainedDouble) {
    const sg = report.safeguardEstimate;
    lines.push(`## Safeguard 估算`);
    lines.push("");
    lines.push(`- **maxHistoryTokens**: ${sg.maxHistoryTokens.toLocaleString()}`);
    lines.push(`- **newContentTokens (估)**: ~${sg.newContentTokensEstimate.toLocaleString()}`);
    lines.push(`- **Pruning**: ${sg.pruningTriggered ? "触发" : "未触发"}`);
    lines.push(`- ${sg.explanation}`);
    lines.push("");
  }

  // ── Parsed Summary (P1) ──
  lines.push(`## 摘要内容`);
  lines.push("");

  const ps = report.parsedSummary;
  if (ps) {
    if (ps.isBootstrap) {
      lines.push(`> **Bootstrap Compaction** — 首次 compaction 的初始化摘要, 内容极少。`);
      lines.push("");
    }
    if (ps.isFallback) {
      lines.push(`> **Fallback** — 摘要生成失败, 使用了兜底文本。`);
      lines.push("");
    }

    if (ps.goal) {
      lines.push(`**Goal**: ${ps.goal}`);
      lines.push("");
    }
    if (ps.progress) {
      if (ps.progress.done.length > 0) {
        lines.push(`**Done**:`);
        for (const d of ps.progress.done) lines.push(`- ${d}`);
        lines.push("");
      }
      if (ps.progress.inProgress.length > 0) {
        lines.push(`**In Progress**:`);
        for (const d of ps.progress.inProgress) lines.push(`- ${d}`);
        lines.push("");
      }
      if (ps.progress.blocked.length > 0) {
        lines.push(`**Blocked**:`);
        for (const d of ps.progress.blocked) lines.push(`- ${d}`);
        lines.push("");
      }
    }
    if (ps.keyDecisions && ps.keyDecisions.length > 0) {
      lines.push(`**Key Decisions**:`);
      for (const d of ps.keyDecisions) lines.push(`- ${d}`);
      lines.push("");
    }
    if (ps.nextSteps && ps.nextSteps.length > 0) {
      lines.push(`**Next Steps**:`);
      for (const d of ps.nextSteps) lines.push(`- ${d}`);
      lines.push("");
    }
    if (ps.criticalContext && ps.criticalContext.length > 0) {
      lines.push(`**Critical Context**:`);
      for (const d of ps.criticalContext) lines.push(`- ${d}`);
      lines.push("");
    }
    if (ps.toolFailures && ps.toolFailures.length > 0) {
      lines.push(`**Tool Failures**:`);
      for (const d of ps.toolFailures) lines.push(`- ${d}`);
      lines.push("");
    }

    if (!ps.goal && !ps.isFallback && !ps.isBootstrap) {
      lines.push(ps.raw);
      lines.push("");
    }
  } else {
    lines.push(report.summary);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Summary list (for /summary all) — P1 enriched
// ---------------------------------------------------------------------------

function classifyCompaction(report: CompactionReport): string {
  if (report.boundary.isChainedDouble) return "链式";
  if (report.parsedSummary?.isFallback) return "fallback";
  if (report.parsedSummary?.isBootstrap) return "bootstrap";
  if (report.fromHook) return "自动(safeguard)";
  return "自动";
}

export function formatSummaryList(reports: CompactionReport[]): string {
  if (reports.length === 0) return "暂无 compaction 记录。";

  const effective = reports.filter(
    (r) => !r.boundary.isChainedDouble && !r.boundary.isBootstrap,
  ).length;

  const lines: string[] = [];
  lines.push(`# Compaction 历史 (共 ${reports.length} 次, ${effective} 次有效)`);
  lines.push("");

  for (const r of reports) {
    const time = new Date(r.timestamp).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const msgBefore = r.boundary.summarizedMessageIds.length + r.boundary.keptMessageIds.length;
    const msgAfter = r.boundary.keptMessageIds.length;
    const tag = classifyCompaction(r);

    lines.push(
      `**#${r.compactionIndex + 1}** | ${time} | ` +
        `${r.tokensBefore.toLocaleString()} tok | ` +
        `${msgBefore}→${msgAfter} msg | ` +
        `[${tag}]`,
    );
  }

  lines.push("");
  if (reports[0]?.configPanel?.triggerThreshold != null) {
    const cp = reports[0]!.configPanel!;
    lines.push(
      `当前参数: contextWindow=${cp.contextWindow?.value?.toLocaleString() ?? "?"} | ` +
        `阈值=${cp.triggerThreshold!.toLocaleString()} | ` +
        `mode=${cp.compactionMode ?? "?"}`,
    );
  }
  lines.push("");
  lines.push("输入 `/summary` 查看最新一次详情。");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Report File I/O
// ---------------------------------------------------------------------------

const REPORTS_DIR_NAME = "compaction-reports";

export function getReportsDir(): string {
  return join(homedir(), ".openclaw", REPORTS_DIR_NAME);
}

export function saveReport(report: CompactionReport): string {
  const dir = getReportsDir();
  mkdirSync(dir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const filename = `compaction-${ts}-${report.compactionId}.md`;
  const filePath = join(dir, filename);
  writeFileSync(filePath, formatMarkdown(report), "utf-8");
  return filePath;
}

export function listReportFiles(): string[] {
  const dir = getReportsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("compaction-") && f.endsWith(".md"))
    .sort()
    .reverse();
}

export function readLatestReport(): string | undefined {
  const files = listReportFiles();
  if (files.length === 0) return undefined;
  return readFileSync(join(getReportsDir(), files[0]!), "utf-8");
}

// ---------------------------------------------------------------------------
// Build report directly from session file
// ---------------------------------------------------------------------------

export function buildReportFromSessionFile(
  sessionFile: string,
  opts?: BuildReportOpts,
): CompactionReport | undefined {
  if (!existsSync(sessionFile)) return undefined;
  const entries = parseSessionJsonl(sessionFile);
  return buildReport(entries, sessionFile, opts);
}

export function buildAllReportsFromSessionFile(
  sessionFile: string,
  opts?: BuildReportOpts,
): CompactionReport[] {
  if (!existsSync(sessionFile)) return [];
  const entries = parseSessionJsonl(sessionFile);
  return buildAllReports(entries, sessionFile, opts);
}
