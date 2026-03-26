/**
 * discussion-state.ts — Independent discussion mode state module.
 *
 * All discussion leader election and participant registration lives here.
 * Gateway calls the public API; no Redis or election logic leaks into gateway.ts.
 *
 * Shared state via Redis:
 *   discussion:{chatId}:participants  Sorted Set  (score=epoch-seconds, member=appId)
 *   discussion:{chatId}:leader        String      (appId)
 *
 * Bot-to-bot broadcast via Redis pub/sub:
 *   Channel: bot-msg:{chatId}  — published when a bot sends a message to a group.
 *   Subscribers receive other bots' messages in <100ms (replaces 10s API polling).
 *
 * Participant Lease: each bot ZADDs itself every tick (10s).
 * Members with score older than LEASE_TTL_S are considered dead and pruned.
 * Leader is auto-elected from active participants (smallest appId).
 * Leader is only re-elected when current leader is absent from participants.
 */

import Redis from "ioredis";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscussionTickResult {
  leader: string | null;
  isLeader: boolean;
  participants: string[];
  shouldAutoExit: boolean;
  isIdle: boolean;
}

export interface BotBroadcastMessage {
  msgId: string;
  chatId: string;
  senderAppId: string;
  senderOpenId: string;
  senderName: string;
  content: string;
  msgType: string;
  createTime: number;
  parentId?: string;
  mentions?: Array<Record<string, unknown>>;
}

interface DiscussionStateOpts {
  redisUrl?: string;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

// ── Constants ────────────────────────────────────────────────────────────────

const LEASE_TTL_S = 30; // participant considered dead after 30s without renewal
const AUTO_EXIT_MS = 5 * 60 * 1000; // 5 minutes of inactivity → auto-exit discussion
const KEY_PREFIX = "discussion";
export type DiscussionRuntimeState = "active" | "idle";

function participantsKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:participants`;
}
function leaderKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:leader`;
}
function lastActivityKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:last_activity`;
}
function runtimeStateKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:state`;
}

export function normalizeDiscussionRuntimeState(value: string | null): DiscussionRuntimeState {
  return value === "idle" ? "idle" : "active";
}

export function shouldRegisterDiscussionParticipant(params: {
  isDiscussionMode: boolean;
  runtimeState: DiscussionRuntimeState;
}): boolean {
  return params.isDiscussionMode && params.runtimeState === "active";
}

async function electDiscussionLeader(
  chatId: string,
  participants: string[],
): Promise<string | null> {
  const lKey = leaderKey(chatId);
  let currentLeader = await redis!.get(lKey);
  if (!currentLeader || !participants.includes(currentLeader)) {
    if (participants.length > 0) {
      const sorted = [...participants].sort();
      const newLeader = sorted[0]!;
      await redis!.set(lKey, newLeader);
      stateLog?.info(
        `[discussion-state] ${chatId.slice(-8)}: elected leader=${newLeader.slice(-8)} from ${participants.length} participants`,
      );
      currentLeader = newLeader;
    } else {
      await redis!.del(lKey);
      currentLeader = null;
    }
  }
  return currentLeader;
}

// ── Redis connection (singleton) ─────────────────────────────────────────────

let redis: Redis | null = null;
let redisReady = false;
let stateLog: DiscussionStateOpts["log"] | undefined;

export function initDiscussionState(opts: DiscussionStateOpts = {}): void {
  stateLog = opts.log;
  const url = opts.redisUrl ?? process.env.REDIS_URL;
  if (!url) {
    stateLog?.warn("[discussion-state] no REDIS_URL, running in fallback mode (no shared state)");
    return;
  }
  if (redis) return;
  redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  redis.on("connect", () => {
    redisReady = true;
    stateLog?.info("[discussion-state] Redis connected");
  });
  redis.on("error", (err) => {
    redisReady = false;
    stateLog?.warn(`[discussion-state] Redis error: ${String(err).slice(0, 120)}`);
  });
  redis.on("close", () => {
    redisReady = false;
  });
}

function isRedisAvailable(): boolean {
  return redis !== null && redisReady;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called every poll cycle (~10s) by gateway bot-poll.
 * Handles: register/unregister self, prune expired, elect leader.
 */
export async function discussionTick(params: {
  chatId: string;
  myAppId: string;
  isDiscussionMode: boolean;
}): Promise<DiscussionTickResult> {
  const { chatId, myAppId, isDiscussionMode } = params;

  if (!isRedisAvailable()) {
    return fallbackResult(myAppId, isDiscussionMode);
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const pKey = participantsKey(chatId);
    const runtimeState = isDiscussionMode
      ? normalizeDiscussionRuntimeState(await redis!.get(runtimeStateKey(chatId)))
      : "active";

    if (!isDiscussionMode) {
      await redis!.del(runtimeStateKey(chatId));
    }

    // 1. Register or unregister self
    if (shouldRegisterDiscussionParticipant({ isDiscussionMode, runtimeState })) {
      await redis!.zadd(pKey, now, myAppId);
    } else {
      await redis!.zrem(pKey, myAppId);
    }

    if (runtimeState === "idle") {
      return {
        leader: null,
        isLeader: false,
        participants: [],
        shouldAutoExit: false,
        isIdle: true,
      };
    }

    // 2. Prune expired participants (score < now - LEASE_TTL_S)
    await redis!.zremrangebyscore(pKey, "-inf", now - LEASE_TTL_S);

    // 3. Get active participants
    const participants = await redis!.zrangebyscore(pKey, now - LEASE_TTL_S, "+inf");

    // 4. Elect leader if needed
    const currentLeader = await electDiscussionLeader(chatId, participants);

    // 5. Check auto-exit: if no activity for 5 minutes
    let shouldAutoExit = false;
    if (isDiscussionMode) {
      const aKey = lastActivityKey(chatId);
      const lastAct = await redis!.get(aKey);
      if (lastAct) {
        const elapsed = now - parseInt(lastAct);
        if (elapsed > AUTO_EXIT_MS / 1000) {
          shouldAutoExit = true;
          stateLog?.info(
            `[discussion-state] ${chatId.slice(-8)}: auto-exit triggered (${elapsed}s idle, threshold=${AUTO_EXIT_MS / 1000}s)`,
          );
        }
      } else {
        // No activity recorded yet → set initial activity time
        await redis!.set(aKey, String(now));
      }
    }

    return {
      leader: currentLeader,
      isLeader: currentLeader === myAppId,
      participants,
      shouldAutoExit,
      isIdle: false,
    };
  } catch (err) {
    stateLog?.warn(`[discussion-state] tick error: ${String(err).slice(0, 200)}`);
    return fallbackResult(myAppId, isDiscussionMode);
  }
}

export async function activateDiscussionGroup(
  chatId: string,
  myAppId: string,
): Promise<DiscussionTickResult | null> {
  if (!isRedisAvailable() || !myAppId.trim()) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const pKey = participantsKey(chatId);
    await redis!.set(runtimeStateKey(chatId), "active");
    await redis!.zadd(pKey, now, myAppId);
    await redis!.zremrangebyscore(pKey, "-inf", now - LEASE_TTL_S);
    const participants = await redis!.zrangebyscore(pKey, now - LEASE_TTL_S, "+inf");
    const leader = await electDiscussionLeader(chatId, participants);
    await redis!.set(lastActivityKey(chatId), String(now));
    stateLog?.info(
      `[discussion-state] ${chatId.slice(-8)}: activated by ${myAppId.slice(-8)} (leader=${leader?.slice(-8) ?? "none"}, participants=${participants.length})`,
    );
    return {
      leader,
      isLeader: leader === myAppId,
      participants,
      shouldAutoExit: false,
      isIdle: false,
    };
  } catch (err) {
    stateLog?.warn(`[discussion-state] activate error: ${String(err).slice(0, 200)}`);
    return null;
  }
}

/**
 * Record discussion activity after an explicitly routed discussion turn is accepted.
 * Resets the auto-exit timer.
 */
export async function recordDiscussionActivity(chatId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis!.set(lastActivityKey(chatId), String(Math.floor(Date.now() / 1000)));
  } catch {}
}

/**
 * Transition a discussion room into idle without changing the persisted group mode.
 */
export async function markDiscussionIdle(chatId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis!
      .multi()
      .set(runtimeStateKey(chatId), "idle")
      .del(participantsKey(chatId), leaderKey(chatId), lastActivityKey(chatId))
      .exec();
    stateLog?.info(`[discussion-state] ${chatId.slice(-8)}: entered idle`);
  } catch {}
}

/**
 * Backward-compatible alias used by older call sites and tests.
 */
export async function cleanupDiscussionGroup(chatId: string): Promise<void> {
  await markDiscussionIdle(chatId);
}

/**
 * Set leader explicitly (called by Her via set_discussion_leader tool).
 * Writes to Redis so all containers see the change immediately.
 */
export async function setDiscussionLeader(chatId: string, appId: string): Promise<boolean> {
  if (!isRedisAvailable()) {
    stateLog?.warn("[discussion-state] setDiscussionLeader: Redis unavailable");
    return false;
  }
  try {
    await redis!.set(leaderKey(chatId), appId);
    stateLog?.info(
      `[discussion-state] ${chatId.slice(-8)}: leader set to ${appId.slice(-8)} (by tool)`,
    );
    return true;
  } catch (err) {
    stateLog?.warn(`[discussion-state] setDiscussionLeader error: ${String(err).slice(0, 200)}`);
    return false;
  }
}

/**
 * Read current leader (used by context injection).
 */
export async function getDiscussionLeader(chatId: string): Promise<string | null> {
  if (!isRedisAvailable()) return null;
  try {
    return await redis!.get(leaderKey(chatId));
  } catch {
    return null;
  }
}

/**
 * Read active participants (used by context injection).
 */
export async function getDiscussionParticipants(chatId: string): Promise<string[]> {
  if (!isRedisAvailable()) return [];
  try {
    const now = Math.floor(Date.now() / 1000);
    return await redis!.zrangebyscore(participantsKey(chatId), now - LEASE_TTL_S, "+inf");
  } catch {
    return [];
  }
}

/**
 * Cleanup on shutdown: unregister self from all groups.
 */
export async function shutdownDiscussionState(myAppId: string, chatIds: string[]): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    for (const chatId of chatIds) {
      await redis!.zrem(participantsKey(chatId), myAppId);
    }
    stateLog?.info(`[discussion-state] shutdown: unregistered from ${chatIds.length} group(s)`);
  } catch {
    // best-effort cleanup
  }
}

// ── Redis broadcast (pub/sub for bot-to-bot messaging) ──────────────────────
// Pub/sub needs a dedicated connection (subscriber can't run regular commands).
// PUBLISH uses the existing `redis` connection; SUBSCRIBE uses `subscriber`.

const BROADCAST_CHANNEL = "bot-msg";

let subscriber: Redis | null = null;
let subscriberReady = false;

export function initBroadcast(opts: { redisUrl?: string } = {}): void {
  const url = opts.redisUrl ?? process.env.REDIS_URL;
  if (!url || subscriber) return;
  subscriber = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  subscriber.on("connect", () => {
    subscriberReady = true;
    stateLog?.info("[discussion-broadcast] subscriber Redis connected");
  });
  subscriber.on("error", (err) => {
    subscriberReady = false;
    stateLog?.warn(`[discussion-broadcast] subscriber error: ${String(err).slice(0, 120)}`);
  });
  subscriber.on("close", () => {
    subscriberReady = false;
  });
}

/** Publish a bot message so other bots in the same group discover it instantly. */
export async function publishBotMessage(msg: BotBroadcastMessage): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    const channel = `${BROADCAST_CHANNEL}:${msg.chatId}`;
    await redis!.publish(channel, JSON.stringify(msg));
    stateLog?.info(
      `[discussion-broadcast] published msgId=${msg.msgId.slice(-12)} to ${msg.chatId.slice(-8)}`,
    );
  } catch (err) {
    stateLog?.warn(`[discussion-broadcast] publish error: ${String(err).slice(0, 120)}`);
  }
}

/**
 * Subscribe to bot messages from all groups.
 * `callback` fires for every message NOT sent by `myAppId`.
 */
export function subscribeBotMessages(
  myAppId: string,
  callback: (msg: BotBroadcastMessage) => void,
): void {
  if (!subscriber) return;
  subscriber.psubscribe(`${BROADCAST_CHANNEL}:*`).catch((err) => {
    stateLog?.warn(`[discussion-broadcast] psubscribe error: ${String(err).slice(0, 120)}`);
  });
  subscriber.on("pmessage", (_pattern: string, _channel: string, data: string) => {
    try {
      const msg = JSON.parse(data) as BotBroadcastMessage;
      if (msg.senderAppId === myAppId) return;
      callback(msg);
    } catch (err) {
      stateLog?.warn(`[discussion-broadcast] message parse error: ${String(err).slice(0, 120)}`);
    }
  });
}

export async function shutdownBroadcast(): Promise<void> {
  if (subscriber) {
    try {
      await subscriber.punsubscribe();
      subscriber.disconnect();
    } catch {}
    subscriber = null;
    subscriberReady = false;
  }
}

// ── Fallback (no Redis) ─────────────────────────────────────────────────────

function fallbackResult(myAppId: string, isDiscussionMode: boolean): DiscussionTickResult {
  if (!isDiscussionMode) {
    return {
      leader: null,
      isLeader: false,
      participants: [],
      shouldAutoExit: false,
      isIdle: false,
    };
  }
  return {
    leader: myAppId,
    isLeader: true,
    participants: [myAppId],
    shouldAutoExit: false,
    isIdle: false,
  };
}
