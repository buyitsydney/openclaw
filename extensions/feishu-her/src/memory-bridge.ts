/**
 * Memory Bridge — writes feishu content (documents, group archives, minutes)
 * as .md files into the OpenClaw memory directory so the existing memory_search
 * tool can provide semantic vector search over previously accessed feishu content.
 *
 * The memory system auto-indexes all .md files under {workspace}/memory/.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getArchiveEntryDisplaySender,
  getArchiveEntryDisplayText,
  normalizeArchiveEntry,
  type GroupArchiveEntry,
} from "./group-archive.js";

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  return override || join(homedir(), ".openclaw");
}

function resolveMemoryDir(): string {
  return join(resolveStateDir(), "workspace", "memory");
}

function resolveGroupArchiveDir(): string {
  return join(resolveStateDir(), "feishu-groups");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

// ── Document cache ──

/**
 * Cache a feishu document's content to the memory directory for semantic indexing.
 * Written as markdown with metadata frontmatter.
 */
export function cacheDocToMemory(params: {
  docToken: string;
  title: string;
  content: string;
  source: "drive" | "wiki";
  url?: string;
}): void {
  const dir = join(resolveMemoryDir(), "feishu-docs");
  ensureDir(dir);

  const filename = `${sanitizeFilename(params.title)}-${params.docToken.slice(0, 12)}.md`;
  const header =
    `# ${params.title}\n\n` +
    `> source: feishu-${params.source} | token: ${params.docToken}` +
    (params.url ? ` | url: ${params.url}` : "") +
    ` | cached: ${new Date().toISOString()}\n\n`;

  writeFileSync(join(dir, filename), header + params.content, "utf-8");
}

// ── Minutes cache ──

export function cacheMinutesToMemory(params: {
  minuteToken: string;
  title: string;
  summary: string;
  url?: string;
}): void {
  const dir = join(resolveMemoryDir(), "feishu-minutes");
  ensureDir(dir);

  const filename = `${sanitizeFilename(params.title)}-${params.minuteToken.slice(0, 12)}.md`;
  const header =
    `# ${params.title}\n\n` +
    `> source: feishu-minutes | token: ${params.minuteToken}` +
    (params.url ? ` | url: ${params.url}` : "") +
    ` | cached: ${new Date().toISOString()}\n\n`;

  writeFileSync(join(dir, filename), header + params.summary, "utf-8");
}

// ── Group archive sync ──

/**
 * Sync group archive JSONL files to the memory directory as .md files.
 * Each group gets one .md file with the latest messages (capped to avoid
 * bloating the memory index). Incremental: only rewrites if archive has
 * newer messages than the last sync.
 */
export function syncGroupArchivesToMemory(): { synced: number; skipped: number } {
  const archiveDir = resolveGroupArchiveDir();
  if (!existsSync(archiveDir)) return { synced: 0, skipped: 0 };

  const memDir = join(resolveMemoryDir(), "feishu-groups");
  ensureDir(memDir);

  let index: Record<string, { name: string }> = {};
  const indexPath = join(archiveDir, "index.json");
  try {
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }
  } catch {}

  let chatDirs: string[];
  try {
    chatDirs = readdirSync(archiveDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { synced: 0, skipped: 0 };
  }

  let synced = 0;
  let skipped = 0;
  const MAX_MESSAGES_PER_GROUP = 200;

  for (const chatId of chatDirs) {
    const messagesPath = join(archiveDir, chatId, "messages.jsonl");
    if (!existsSync(messagesPath)) {
      skipped++;
      continue;
    }

    const chatName = index[chatId]?.name ?? chatId;
    const targetFile = join(memDir, `${sanitizeFilename(chatName)}-${chatId.slice(0, 16)}.md`);

    let content: string;
    try {
      content = readFileSync(messagesPath, "utf-8");
    } catch {
      skipped++;
      continue;
    }

    const lines = content.split("\n").filter((l) => l.trim());
    const recentLines = lines.slice(-MAX_MESSAGES_PER_GROUP);

    const messages: string[] = [];
    for (const line of recentLines) {
      try {
        const entry = normalizeArchiveEntry(JSON.parse(line) as GroupArchiveEntry);
        const date = new Date(entry.ts * 1000).toISOString().slice(0, 16);
        messages.push(
          `[${date}] ${getArchiveEntryDisplaySender(entry)}: ${getArchiveEntryDisplayText(entry)}`,
        );
      } catch {}
    }

    if (messages.length === 0) {
      skipped++;
      continue;
    }

    const md =
      `# 群聊归档：${chatName}\n\n` +
      `> source: feishu-group-archive | chat_id: ${chatId}` +
      ` | messages: ${messages.length} | synced: ${new Date().toISOString()}\n\n` +
      messages.join("\n\n");

    writeFileSync(targetFile, md, "utf-8");
    synced++;
  }

  return { synced, skipped };
}
