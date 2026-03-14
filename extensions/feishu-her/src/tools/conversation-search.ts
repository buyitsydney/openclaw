/**
 * feishu_conversation_search — keyword search across local group chat archives
 * and Her's own conversation sessions. Fills the gap where Feishu's open API
 * provides no message-level search.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  getArchiveEntryDisplaySender,
  getArchiveEntryDisplayText,
  normalizeArchiveEntry,
  type GroupArchiveEntry,
} from "../group-archive.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const ConversationSearchSchema = Type.Object({
  keyword: Type.String({
    description: "Keyword to search for across group archives and session history.",
  }),
  scope: Type.Optional(
    Type.String({
      description:
        'Search scope: "all" (default), "groups" (only group archives), "sessions" (only Her sessions).',
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description: "Max results to return. Default 20, max 50.",
    }),
  ),
});

// ── Types ──

type ConversationMatch = {
  source: "group_archive" | "session";
  context: string;
  snippet: string;
  timestamp?: string;
  sender?: string;
  chat_name?: string;
  chat_id?: string;
};

// ── State dir helpers ──

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  return override || join(homedir(), ".openclaw");
}

function resolveGroupArchiveDir(): string {
  return join(resolveStateDir(), "feishu-groups");
}

function resolveSessionsDir(): string {
  const agentsDir = join(resolveStateDir(), "agents");
  if (!existsSync(agentsDir)) return "";
  try {
    const agents = readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (agents.length === 0) return "";
    // Use the first (typically "main") agent's sessions
    return join(agentsDir, agents[0].name, "sessions");
  } catch {
    return "";
  }
}

// ── Search implementations ──

const SNIPPET_RADIUS = 100;

function extractSnippet(text: string, keyword: string): string {
  const lowerText = text.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  const idx = lowerText.indexOf(lowerKw);
  if (idx < 0) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + keyword.length + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function searchGroupArchives(keyword: string, maxResults: number): ConversationMatch[] {
  const archiveDir = resolveGroupArchiveDir();
  if (!existsSync(archiveDir)) return [];

  let index: Record<string, { name: string }> = {};
  try {
    const indexPath = join(archiveDir, "index.json");
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }
  } catch {}

  const lowerKeyword = keyword.toLowerCase();
  const results: ConversationMatch[] = [];

  let chatDirs: string[];
  try {
    chatDirs = readdirSync(archiveDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const chatId of chatDirs) {
    if (results.length >= maxResults) break;

    const messagesPath = join(archiveDir, chatId, "messages.jsonl");
    if (!existsSync(messagesPath)) continue;

    let content: string;
    try {
      content = readFileSync(messagesPath, "utf-8");
    } catch {
      continue;
    }

    const chatName = index[chatId]?.name ?? chatId;

    // Search from newest to oldest
    const lines = content.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0 && results.length < maxResults; i--) {
      try {
        const entry = normalizeArchiveEntry(JSON.parse(lines[i]) as GroupArchiveEntry);
        const text = getArchiveEntryDisplayText(entry);
        if (!text?.toLowerCase().includes(lowerKeyword)) continue;

        results.push({
          source: "group_archive",
          context: `群「${chatName}」`,
          snippet: extractSnippet(text, keyword),
          timestamp: new Date(entry.ts * 1000).toISOString(),
          sender: getArchiveEntryDisplaySender(entry),
          chat_name: chatName,
          chat_id: chatId,
        });
      } catch {}
    }
  }

  return results;
}

function extractSessionText(entry: Record<string, unknown>): string | null {
  // Session JSONL v3 format: { type: "message", message: { role, content: [{type: "text", text}] } }
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) {
    // Fallback: top-level content string (legacy format)
    const c = entry.content;
    return typeof c === "string" ? c : null;
  }
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block && (block as Record<string, unknown>).type === "text") {
      const t = (block as Record<string, unknown>).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function searchSessions(keyword: string, maxResults: number): ConversationMatch[] {
  const sessionsDir = resolveSessionsDir();
  if (!sessionsDir || !existsSync(sessionsDir)) return [];

  const results: ConversationMatch[] = [];
  const lowerKeyword = keyword.toLowerCase();

  let sessionFiles: string[];
  try {
    sessionFiles = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }

  for (const file of sessionFiles) {
    if (results.length >= maxResults) break;

    let content: string;
    try {
      content = readFileSync(join(sessionsDir, file), "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (results.length >= maxResults) break;
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== "message") continue;

        const msg = (entry.message as Record<string, unknown>) ?? entry;
        const role = msg.role as string | undefined;
        if (role === "tool") continue;

        const text = extractSessionText(entry);
        if (!text || !text.toLowerCase().includes(lowerKeyword)) continue;

        const sessionId = file.replace(".jsonl", "");
        results.push({
          source: "session",
          context: `会话 ${sessionId.slice(0, 8)}`,
          snippet: extractSnippet(text, keyword),
          sender: role === "user" ? "用户" : role === "assistant" ? "Her" : (role ?? "unknown"),
          timestamp: (entry.timestamp as string) ?? undefined,
        });
      } catch {}
    }
  }

  return results;
}

// ── Registration ──

export function registerConversationSearchTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "feishu_conversation_search",
      label: "Conversation Search",
      description:
        "Search across local group chat archives and Her's own conversation history " +
        "using keyword matching. Fills the gap where Feishu API provides no message-level " +
        "search. Returns matched messages with context snippets, timestamps, and senders. " +
        "For semantic search over conversations, use memory_search after syncing archives " +
        "(feishu_deep_search with sync_archives_to_memory=true).",
      parameters: ConversationSearchSchema,
      async execute(_toolCallId, params) {
        try {
          const raw = params as Record<string, unknown>;
          const keyword = (raw.keyword as string)?.trim();
          if (!keyword) {
            return json({ error: "keyword is required." });
          }

          const scope = (raw.scope as string) ?? "all";
          const maxResults = Math.min(Math.max((raw.max_results as number) ?? 20, 1), 50);

          const groupResults = scope === "sessions" ? [] : searchGroupArchives(keyword, maxResults);
          const sessionResults =
            scope === "groups" ? [] : searchSessions(keyword, maxResults - groupResults.length);

          const merged = [...groupResults, ...sessionResults].slice(0, maxResults);

          return json({
            keyword,
            scope,
            total: merged.length,
            stats: {
              group_archive: groupResults.length,
              session: sessionResults.length,
            },
            results: merged,
            hint:
              "Results are keyword-matched from local archives. For full semantic search, " +
              "use memory_search after syncing with feishu_deep_search(sync_archives_to_memory=true).",
          });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_conversation_search" },
  );
  api.logger.info?.("feishu: registered feishu_conversation_search tool");
}
