import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";

/** Shorten model ID to a display name (e.g., "claude-sonnet-4-20250514" → "Sonnet 4"). */
function shortenModelName(model?: string): string {
  if (!model) return "unknown";
  const claude = model.match(/claude-(\w+)-([\d][\d.-]*)/);
  if (claude) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    const version = claude[2].replace(/-/g, ".");
    return `${family} ${version}`;
  }
  if (model.startsWith("gpt-")) return model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (model.startsWith("gemini-")) return model.replace(/-\d{4,}$/, "");
  return model.length > 24 ? model.slice(0, 24) + "…" : model;
}

/** Format token count for compact display (e.g., 42000 → "42k"). */
function formatTokenCompact(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/** Mode label map for group chat footer display. */
const MODE_LABELS: Record<string, string> = {
  "owner-at": "🔒主人@",
  owner: "🔒主人",
  "group-at": "👥群@",
  discussion: "🗣️讨论",
};

/** Build a concise 3-part status footer from the session store.
 * Format: 🧠 Model · 📊 used/total [🧹N] [· modeTag[👑]]
 * Mode tag only appears when groupMode is provided (i.e., in group chats). */
export function buildFeishuStatusFooter(params: {
  storePath: string;
  sessionKey: string;
  config: OpenClawConfig;
  groupMode?: string;
  isDiscussionLeader?: boolean;
}): string {
  try {
    const raw = readFileSync(params.storePath, "utf-8");
    const store = JSON.parse(raw);
    const entry = store?.[params.sessionKey];
    if (!entry) return "";

    const model = entry.modelOverride ?? entry.model;
    const totalTokens = entry.totalTokens ?? (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);
    const contextTokens =
      entry.contextTokens ?? params.config?.agents?.defaults?.contextTokens ?? null;

    const modelLabel = shortenModelName(model);
    const totalLabel = formatTokenCompact(totalTokens);
    const ctxLabel = contextTokens ? formatTokenCompact(contextTokens) : "?";
    const compactions = entry.compactionCount ?? 0;

    // Token usage: used/total + optional compaction count (hidden when 0)
    const compactSuffix = compactions > 0 ? ` 🧹${compactions}` : "";
    const usageText = `${totalLabel}/${ctxLabel}${compactSuffix}`;

    // Mode tag: only in group chats; crown icon for discussion leader
    const modeTag = params.groupMode ? MODE_LABELS[params.groupMode] : undefined;
    const leaderBadge = params.groupMode === "discussion" && params.isDiscussionLeader ? "👑" : "";
    const modeSuffix = modeTag ? ` · ${modeTag}${leaderBadge}` : "";

    const warn = contextTokens && totalTokens && totalTokens / contextTokens >= 0.7;
    const icon = warn ? "⚠️" : "🧠";
    return `\n\n---\n${icon} ${modelLabel} · 📊 ${usageText}${modeSuffix}`;
  } catch {
    return "";
  }
}

export function accumulateGroupedReplyText(current: string, next?: string): string {
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

export function finalizeGroupedReplyText(text: string, footer: string): string {
  if (!text || !footer) return text;
  return text.endsWith(footer) ? text : `${text}${footer}`;
}
