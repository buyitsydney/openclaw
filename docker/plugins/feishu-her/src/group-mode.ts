/**
 * group-mode.ts — Per-bot per-group mode management.
 *
 * Primary store: Redis  `group:mode:{chatId}:{appId}` (JSON)
 * Fallback:      In-memory cache (survives transient Redis outages)
 * Migration:     On startup, legacy files are imported into Redis and removed.
 *
 * Redis key value: JSON `{ mode, context?, set_by?, set_at? }`
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSharedRedis } from "./discussion-state.js";

export type GroupModeInfo = { mode: string; context?: string };

// ── Redis key helpers ───────────────────────────────────────────────────────

const KEY_PREFIX = "group:mode";

function redisKey(chatId: string, appId: string): string {
  return `${KEY_PREFIX}:${chatId}:${appId}`;
}

/** Pattern for SCAN: all groups this bot has mode entries for. */
function redisScanPattern(appId: string): string {
  return `${KEY_PREFIX}:*:${appId}`;
}

// ── In-memory cache (fallback when Redis is unavailable) ────────────────────

const modeCache = new Map<string, GroupModeInfo>();

function cacheKey(chatId: string, appId: string): string {
  return `${chatId}:${appId}`;
}

// ── Mode normalization ──────────────────────────────────────────────────────

const MODE_ALIAS: Record<string, string> = {
  default: "owner-at",
  "auto-reply": "owner-at",
  owner: "owner-at",
  "at-reply": "group-at",
  monitor: "group-at",
  manager: "group-at",
  group: "group-at",
};

function normalizeMode(raw: string): string {
  const trimmed = raw.trim();
  return MODE_ALIAS[trimmed] ?? trimmed;
}

function parseGroupModeJson(raw: string | null): GroupModeInfo {
  if (!raw) return { mode: "owner-at" };
  try {
    const data = JSON.parse(raw);
    const mode =
      typeof data?.mode === "string" && data.mode.trim() ? normalizeMode(data.mode) : "owner-at";
    const context = typeof data?.context === "string" ? data.context.trim() : undefined;
    return { mode, context: context || undefined };
  } catch {
    return { mode: "owner-at" };
  }
}

// ── Current bot appId (set once at gateway startup) ─────────────────────────

let currentAppId: string | undefined;

/** Must be called once at gateway startup so readGroupMode knows which bot we are. */
export function setGroupModeAppId(appId: string): void {
  currentAppId = appId;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Read per-group mode for the current bot.
 * Priority: Redis → in-memory cache → "owner-at" default.
 */
export function readGroupMode(chatId: string): GroupModeInfo {
  const appId = currentAppId;
  if (!appId) return { mode: "owner-at" };

  // Synchronous read from cache. Cache is kept warm by:
  // 1. warmGroupModeCache() at startup
  // 2. tick timer every 10s (calls readGroupModeAsync)
  // 3. writeGroupMode() updates cache immediately on write
  // No fire-and-forget refresh here — avoids race where async read
  // overwrites a just-written value with stale Redis data.
  const ck = cacheKey(chatId, appId);
  return modeCache.get(ck) ?? { mode: "owner-at" };
}

/**
 * Read per-group mode synchronously from cache or Redis.
 * This is an async version that guarantees fresh data from Redis.
 */
export async function readGroupModeAsync(chatId: string): Promise<GroupModeInfo> {
  const appId = currentAppId;
  if (!appId) return { mode: "owner-at" };

  const redis = getSharedRedis();
  if (redis) {
    try {
      const raw = await redis.get(redisKey(chatId, appId));
      const info = parseGroupModeJson(raw);
      modeCache.set(cacheKey(chatId, appId), info);
      return info;
    } catch {
      // Fall through to cache
    }
  }

  return modeCache.get(cacheKey(chatId, appId)) ?? { mode: "owner-at" };
}

/**
 * Write per-group mode for the current bot to Redis.
 * Returns true on success, false if Redis is unavailable.
 */
export async function writeGroupMode(params: {
  chatId: string;
  appId?: string;
  mode: string;
  context?: string;
  setBy?: string;
}): Promise<boolean> {
  const appId = params.appId ?? currentAppId;
  if (!appId) return false;

  const normalized = normalizeMode(params.mode);
  const data = {
    mode: normalized,
    ...(params.context?.trim() ? { context: params.context.trim() } : {}),
    ...(params.setBy ? { set_by: params.setBy } : {}),
    set_at: new Date().toISOString(),
  };

  const ck = cacheKey(params.chatId, appId);
  const info: GroupModeInfo = { mode: normalized, context: data.context };
  modeCache.set(ck, info);

  const redis = getSharedRedis();
  if (!redis) return false;

  try {
    await redis.set(redisKey(params.chatId, appId), JSON.stringify(data));
    // Also maintain a tracking set so tick timer can discover groups.
    await redis.sadd(`group:tracked:${appId}`, params.chatId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update only the `context` field of an existing group mode entry.
 * No-op if no mode is set for this group.
 */
export async function updateGroupModeContext(chatId: string, context: string): Promise<boolean> {
  const appId = currentAppId;
  if (!appId) return false;

  const redis = getSharedRedis();
  if (!redis) return false;

  try {
    const raw = await redis.get(redisKey(chatId, appId));
    if (!raw) return false;
    const data = JSON.parse(raw);
    data.context = context.trim();
    data.set_at = new Date().toISOString();
    await redis.set(redisKey(chatId, appId), JSON.stringify(data));
    modeCache.set(cacheKey(chatId, appId), {
      mode: normalizeMode(data.mode ?? "owner-at"),
      context: data.context || undefined,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all chatIds that this bot has mode entries for.
 * Used by tick timer to discover which groups to check.
 */
export async function listTrackedGroups(): Promise<string[]> {
  const appId = currentAppId;
  if (!appId) return [];

  const redis = getSharedRedis();
  if (!redis) {
    // Fallback: return groups from in-memory cache.
    const groups: string[] = [];
    const suffix = `:${appId}`;
    for (const key of modeCache.keys()) {
      if (key.endsWith(suffix)) {
        groups.push(key.slice(0, -suffix.length));
      }
    }
    return groups;
  }

  try {
    return await redis.smembers(`group:tracked:${appId}`);
  } catch {
    return [];
  }
}

// ── Legacy file migration ───────────────────────────────────────────────────

export function resolveGroupModesDir(): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    join(homedir(), ".openclaw");
  return join(stateDir, "workspace", "group-modes");
}

/**
 * Migrate legacy group-mode files into Redis.
 * Called once at gateway startup. Files are deleted after successful import.
 */
export async function migrateGroupModeFiles(
  appId: string,
  log?: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  const redis = getSharedRedis();
  if (!redis) return;

  const dir = resolveGroupModesDir();
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return;

  let migrated = 0;
  for (const file of files) {
    const chatId = file.replace(/\.json$/, "").replace(/^feishu:/, "");
    if (!chatId.startsWith("oc_")) continue;

    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const data = JSON.parse(content);
      const mode = typeof data?.mode === "string" ? data.mode.trim() : "";
      if (!mode) continue;

      // Only migrate if Redis doesn't already have an entry (don't overwrite).
      const existing = await redis.get(redisKey(chatId, appId));
      if (existing) {
        // Redis already has data — delete the stale file.
        try {
          unlinkSync(filePath);
        } catch {}
        continue;
      }

      await redis.set(redisKey(chatId, appId), content);
      await redis.sadd(`group:tracked:${appId}`, chatId);
      modeCache.set(cacheKey(chatId, appId), parseGroupModeJson(content));
      migrated++;

      // Delete migrated file.
      try {
        unlinkSync(filePath);
      } catch {}
    } catch (err) {
      log?.warn(`[group-mode] migration failed for ${file}: ${String(err).slice(0, 120)}`);
    }
  }

  if (migrated > 0) {
    log?.info(`[group-mode] migrated ${migrated} legacy mode files to Redis`);
  }
}

/**
 * Pre-warm the in-memory cache from Redis at startup.
 * Ensures the first message after restart gets the correct mode
 * (no 10s cold-start window).
 */
export async function warmGroupModeCache(
  appId: string,
  log?: { info: (msg: string) => void },
): Promise<void> {
  const redis = getSharedRedis();
  if (!redis) return;

  try {
    const chatIds = await redis.smembers(`group:tracked:${appId}`);
    if (chatIds.length === 0) return;

    let warmed = 0;
    for (const chatId of chatIds) {
      const raw = await redis.get(redisKey(chatId, appId));
      if (raw) {
        modeCache.set(cacheKey(chatId, appId), parseGroupModeJson(raw));
        warmed++;
      }
    }
    if (warmed > 0) {
      log?.info(`[group-mode] pre-warmed cache for ${warmed} groups from Redis`);
    }
  } catch {
    // Best-effort; tick timer will warm cache within 10s.
  }
}
