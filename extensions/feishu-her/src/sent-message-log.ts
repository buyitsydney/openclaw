import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatFeishuUserFacingText } from "./outbound.js";

export type SentMessageEntry = {
  messageId: string;
  sentAt: number;
  preview?: string;
};

const SENT_MSG_MAX = 200;
const SENT_MSG_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches Feishu's bot recall limit

let sentMsgDiskLoaded = false;
const sentMessageLog = new Map<string, SentMessageEntry[]>();
let sentMsgFlushTimer: ReturnType<typeof setTimeout> | undefined;

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".openclaw");
}

function resolveSentMessageLogFile(): string {
  return join(resolveStateDir(), "feishu-sent-messages.json");
}

function resolveSentMessageScopeId(): string {
  return process.env.OPENCLAW_INSTANCE_ID?.trim() || "default";
}

function buildScopeKey(chatId: string): string {
  return `${resolveSentMessageScopeId()}::${chatId}`;
}

function loadSentMessageLog(): void {
  if (sentMsgDiskLoaded) return;
  sentMsgDiskLoaded = true;
  try {
    const filePath = resolveSentMessageLogFile();
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, "utf-8");
    const entries: Array<[string, SentMessageEntry[]]> = JSON.parse(raw);
    const now = Date.now();
    for (const [scopeKey, msgs] of entries) {
      const valid = msgs.filter((message) => now - message.sentAt < SENT_MSG_TTL_MS);
      if (valid.length > 0) sentMessageLog.set(scopeKey, valid);
    }
  } catch {
    // Corrupt or missing file — start fresh.
  }
}

function flushSentMessageLog(): void {
  try {
    const now = Date.now();
    for (const [scopeKey, messages] of sentMessageLog) {
      const valid = messages.filter((message) => now - message.sentAt < SENT_MSG_TTL_MS);
      if (valid.length === 0) sentMessageLog.delete(scopeKey);
      else sentMessageLog.set(scopeKey, valid);
    }
    const filePath = resolveSentMessageLogFile();
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify([...sentMessageLog.entries()]), "utf-8");
  } catch {
    // Best-effort persistence.
  }
}

function scheduleSentMsgFlush(): void {
  if (sentMsgFlushTimer) return;
  sentMsgFlushTimer = setTimeout(() => {
    sentMsgFlushTimer = undefined;
    flushSentMessageLog();
  }, 2000);
}

export function recordSentMessage(chatId: string, messageId: string, preview?: string): void {
  loadSentMessageLog();
  const scopeKey = buildScopeKey(chatId);
  const renderedPreview = preview ? formatFeishuUserFacingText(preview) : undefined;
  let list = sentMessageLog.get(scopeKey);
  if (!list) {
    list = [];
    sentMessageLog.set(scopeKey, list);
  }
  const trimmedPreview = renderedPreview?.slice(0, 60).replace(/\n/g, " ");
  list.push({
    messageId,
    sentAt: Date.now(),
    ...(trimmedPreview ? { preview: trimmedPreview } : {}),
  });

  let total = 0;
  for (const messages of sentMessageLog.values()) total += messages.length;
  if (total > SENT_MSG_MAX) {
    const all: Array<{ scopeKey: string; idx: number; sentAt: number }> = [];
    for (const [key, messages] of sentMessageLog) {
      for (let i = 0; i < messages.length; i += 1) {
        all.push({ scopeKey: key, idx: i, sentAt: messages[i].sentAt });
      }
    }
    all.sort((a, b) => a.sentAt - b.sentAt);
    const toDrop = all.slice(0, total - SENT_MSG_MAX);
    const dropIndices = new Map<string, Set<number>>();
    for (const item of toDrop) {
      let indices = dropIndices.get(item.scopeKey);
      if (!indices) {
        indices = new Set();
        dropIndices.set(item.scopeKey, indices);
      }
      indices.add(item.idx);
    }
    for (const [key, indices] of dropIndices) {
      const messages = sentMessageLog.get(key);
      if (!messages) continue;
      const kept = messages.filter((_, index) => !indices.has(index));
      if (kept.length === 0) sentMessageLog.delete(key);
      else sentMessageLog.set(key, kept);
    }
  }

  scheduleSentMsgFlush();
}

export function getRecentSentMessages(chatId: string, count = 10): SentMessageEntry[] {
  loadSentMessageLog();
  const now = Date.now();
  const scopeKey = buildScopeKey(chatId);
  const list = (sentMessageLog.get(scopeKey) ?? []).filter(
    (message) => now - message.sentAt < SENT_MSG_TTL_MS,
  );
  return list.slice(-Math.min(count, 50)).reverse();
}

export function removeSentMessage(chatId: string | undefined, messageId: string): void {
  loadSentMessageLog();
  const scopeKeys = chatId ? [buildScopeKey(chatId)] : Array.from(sentMessageLog.keys());
  for (const scopeKey of scopeKeys) {
    const list = sentMessageLog.get(scopeKey);
    if (!list) continue;
    const idx = list.findIndex((message) => message.messageId === messageId);
    if (idx === -1) continue;
    list.splice(idx, 1);
    if (list.length === 0) sentMessageLog.delete(scopeKey);
    scheduleSentMsgFlush();
    return;
  }
}
