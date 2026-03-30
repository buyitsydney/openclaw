import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type CachedMessageTextEntry = {
  text: string;
  ts: number;
};

const MESSAGE_TEXT_CACHE_MAX = 500;
const MESSAGE_TEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_TEXT_MAX_CHARS = 120_000;

const messageTextCache = new Map<string, CachedMessageTextEntry>();
let cacheLoaded = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  const homeOverride = process.env.OPENCLAW_HOME?.trim();
  if (homeOverride) return homeOverride;
  return join(homedir(), ".openclaw");
}

function resolveMessageTextCacheFile(): string {
  return join(resolveStateDir(), "feishu-message-text-cache.json");
}

function pruneMessageTextCache(now = Date.now()): void {
  for (const [messageId, entry] of messageTextCache) {
    if (now - entry.ts > MESSAGE_TEXT_CACHE_TTL_MS) {
      messageTextCache.delete(messageId);
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    try {
      pruneMessageTextCache();
      const path = resolveMessageTextCacheFile();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(Object.fromEntries(messageTextCache), null, 2));
    } catch {
      // Ignore cache persistence failures.
    }
  }, 200);
  flushTimer.unref?.();
}

function ensureMessageTextCacheLoaded(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const path = resolveMessageTextCacheFile();
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, CachedMessageTextEntry>;
    for (const [messageId, entry] of Object.entries(raw)) {
      if (!messageId || !entry?.text) continue;
      if (typeof entry.ts !== "number") continue;
      messageTextCache.set(messageId, {
        text: entry.text,
        ts: entry.ts,
      });
    }
    pruneMessageTextCache();
  } catch {
    // Ignore malformed cache files.
  }
}

export function cacheMessageText(messageId: string, text: string): void {
  const normalizedMessageId = messageId.trim();
  const normalizedText = text.trim();
  if (!normalizedMessageId || !normalizedText) return;

  ensureMessageTextCacheLoaded();
  pruneMessageTextCache();

  const cappedText =
    normalizedText.length > MESSAGE_TEXT_MAX_CHARS
      ? normalizedText.slice(0, MESSAGE_TEXT_MAX_CHARS)
      : normalizedText;
  messageTextCache.set(normalizedMessageId, {
    text: cappedText,
    ts: Date.now(),
  });

  if (messageTextCache.size > MESSAGE_TEXT_CACHE_MAX) {
    const oldestEntries = [...messageTextCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [staleMessageId] of oldestEntries.slice(
      0,
      messageTextCache.size - MESSAGE_TEXT_CACHE_MAX,
    )) {
      messageTextCache.delete(staleMessageId);
    }
  }

  scheduleFlush();
}

export function getCachedMessageText(messageId: string): string | null {
  const normalizedMessageId = messageId.trim();
  if (!normalizedMessageId) return null;
  ensureMessageTextCacheLoaded();
  pruneMessageTextCache();
  return messageTextCache.get(normalizedMessageId)?.text ?? null;
}
