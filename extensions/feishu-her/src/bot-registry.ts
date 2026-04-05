/**
 * Dynamic Bot Registry — Redis-based self-registration and peer discovery.
 *
 * Replaces the static `knownBots` config (77 entries baked per container) with
 * dynamic self-registration. Each container registers itself at startup; all
 * containers discover peers automatically within 30s, no restart needed.
 *
 * Pattern adapted from `docker/plugins/a2a-gateway/src/registry.ts`.
 *
 * Redis keys:
 *   her:bot:{appId}  = JSON { appId, name, botOpenId, registeredAt }  TTL 120s
 *   her:bot:index    = SET of registered appIds
 */

import { Redis } from "ioredis";

import type { ResolvedFeishuAccount } from "./accounts.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_PREFIX = "her:bot:";
const INDEX_KEY = "her:bot:index";
const LEASE_TTL_S = 120;
const RENEW_INTERVAL_MS = 60_000;
const DISCOVER_INTERVAL_MS = 30_000;

interface BotRegistryEntry {
  appId: string;
  name: string;
  botOpenId: string;
  registeredAt: string;
}

interface BotRegistryOpts {
  redisUrl?: string;
  account: ResolvedFeishuAccount;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

// ── Singleton state ───────────────────────────────────────────────────────────

let redis: Redis | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;
let discoverTimer: ReturnType<typeof setInterval> | null = null;
let selfAppId: string | null = null;
let selfEntry: BotRegistryEntry | null = null;
let registryLog: BotRegistryOpts["log"] | undefined;

// In-memory cache of discovered bots (used if Redis is temporarily unavailable).
let cachedBots: BotRegistryEntry[] = [];

// ── Registration ──────────────────────────────────────────────────────────────

async function registerSelf(entry: BotRegistryEntry): Promise<void> {
  if (!redis) return;
  try {
    const key = KEY_PREFIX + entry.appId;
    await redis.set(key, JSON.stringify(entry), "EX", LEASE_TTL_S);
    await redis.sadd(INDEX_KEY, entry.appId);
  } catch (err) {
    registryLog?.warn(`[bot-registry] register failed: ${String(err).slice(0, 120)}`);
  }
}

async function renewLease(appId: string): Promise<void> {
  if (!redis) return;
  try {
    const renewed = await redis.expire(KEY_PREFIX + appId, LEASE_TTL_S);
    if (renewed === 0 && selfEntry) {
      // Key expired (sleep/restart/Redis flush) — re-register
      await registerSelf(selfEntry);
      registryLog?.info(`[bot-registry] re-registered after key expiry: ${appId}`);
    }
  } catch (err) {
    registryLog?.warn(`[bot-registry] renew failed: ${String(err).slice(0, 120)}`);
  }
}

// ── Discovery ─────────────────────────────────────────────────────────────────

async function discoverAllBots(): Promise<BotRegistryEntry[]> {
  if (!redis) return cachedBots;
  try {
    const allIds = await redis.smembers(INDEX_KEY);
    if (allIds.length === 0) return [];

    const keys = allIds.map((id) => KEY_PREFIX + id);
    const values = await redis.mget(...keys);

    const bots: BotRegistryEntry[] = [];
    const staleIds: string[] = [];
    for (let i = 0; i < allIds.length; i++) {
      const raw = values[i];
      if (!raw) {
        staleIds.push(allIds[i]);
        continue;
      }
      try {
        bots.push(JSON.parse(raw) as BotRegistryEntry);
      } catch {
        staleIds.push(allIds[i]);
      }
    }

    // Clean up stale index entries (card expired but still in SET).
    if (staleIds.length > 0) {
      await redis.srem(INDEX_KEY, ...staleIds).catch(() => {});
    }

    cachedBots = bots;
    return bots;
  } catch (err) {
    registryLog?.warn(`[bot-registry] discover failed: ${String(err).slice(0, 120)}`);
    return cachedBots; // stale cache on error
  }
}

/**
 * Merge discovered bots into the live account object IN-PLACE.
 *
 * All 45+ consumers read `account.knownBots` and `account.knownBotOpenIds`
 * synchronously via the same object reference. By mutating the existing object
 * (key-by-key assignment, never replacing the reference), every consumer sees
 * the update immediately. Node.js single-threaded model guarantees no consumer
 * will observe a half-updated snapshot.
 */
function syncToAccount(account: ResolvedFeishuAccount, bots: BotRegistryEntry[]): void {
  for (const bot of bots) {
    account.knownBots[bot.appId] = bot.name;
    if (bot.botOpenId) {
      if (!account.knownBotOpenIds) account.knownBotOpenIds = {};
      account.knownBotOpenIds[bot.botOpenId] = bot.appId;
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function initBotRegistry(opts: BotRegistryOpts): void {
  registryLog = opts.log;
  const url = opts.redisUrl ?? process.env.REDIS_URL;
  if (!url) {
    registryLog?.warn("[bot-registry] no REDIS_URL, bot discovery disabled");
    return;
  }
  if (redis) return; // already initialized

  const account = opts.account;
  selfAppId = account.appId;

  redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });

  redis.on("connect", async () => {
    registryLog?.info("[bot-registry] Redis connected");

    // Self-register immediately on connect.
    selfEntry = {
      appId: account.appId,
      name: account.name ?? account.appId,
      botOpenId: account.botOpenId ?? "",
      registeredAt: new Date().toISOString(),
    };
    await registerSelf(selfEntry);
    registryLog?.info(
      `[bot-registry] registered self: ${selfEntry.appId} (${selfEntry.name})`,
    );

    // Initial discovery + sync.
    const bots = await discoverAllBots();
    syncToAccount(account, bots);
    registryLog?.info(`[bot-registry] discovered ${bots.length} bots`);
  });

  redis.on("error", (err: unknown) => {
    registryLog?.warn(`[bot-registry] Redis error: ${String(err).slice(0, 120)}`);
  });

  // Renew lease every 60s.
  renewTimer = setInterval(async () => {
    if (selfAppId) await renewLease(selfAppId);
  }, RENEW_INTERVAL_MS);

  // Discover peers every 30s + sync to account.
  discoverTimer = setInterval(async () => {
    const bots = await discoverAllBots();
    syncToAccount(account, bots);
  }, DISCOVER_INTERVAL_MS);
}

export function destroyBotRegistry(): void {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  if (discoverTimer) {
    clearInterval(discoverTimer);
    discoverTimer = null;
  }
  if (redis && selfAppId) {
    // Best-effort unregister on shutdown.
    const key = KEY_PREFIX + selfAppId;
    redis.del(key).catch(() => {});
    redis.srem(INDEX_KEY, selfAppId).catch(() => {});
  }
  if (redis) {
    redis.disconnect();
    redis = null;
  }
  selfAppId = null;
  selfEntry = null;
  cachedBots = [];
  registryLog?.info("[bot-registry] destroyed");
}
