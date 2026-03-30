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

import { Redis } from "ioredis";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscussionTickResult {
  leader: string | null;
  isLeader: boolean;
  participants: string[];
}

export type DiscussionTurnPhase = "assigned" | "running";

export interface DiscussionTurnState {
  roomEpoch: number;
  turnId: string;
  chairAppId: string;
  ownerAppId: string;
  phase: DiscussionTurnPhase;
  participantOrder: string[];
  remainingQueue: string[];
  sourceMessageId: string;
  assignDeadlineMs: number;
  finishDeadlineMs: number;
  fencingToken: number;
}

export interface DiscussionTurnAdvanceResult {
  nextTurn: DiscussionTurnState | null;
  closed: boolean;
}

export interface DiscussionTurnTransitionResult {
  reason: "advanced" | "expired";
  previousOwnerAppId: string;
  nextTurn: DiscussionTurnState | null;
  closed: boolean;
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
const DISCUSSION_TURN_ASSIGN_MS = 30_000;
const KEY_PREFIX = "discussion";

function participantsKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:participants`;
}
function leaderKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:leader`;
}
function lastActivityKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:last_activity`;
}
function turnKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:turn`;
}
function epochKey(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:epoch`;
}

function normalizePositiveMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizePositiveInt(value: unknown): number {
  return Math.max(0, normalizePositiveMs(value));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dedupeNonEmptyStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return dedupeNonEmptyStrings(value.filter((item): item is string => typeof item === "string"));
}

function parseDiscussionTurnState(value: string | null): DiscussionTurnState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DiscussionTurnState>;
    const turnId = normalizeString(parsed.turnId);
    const chairAppId = normalizeString(parsed.chairAppId);
    const ownerAppId = normalizeString(parsed.ownerAppId);
    const sourceMessageId = normalizeString(parsed.sourceMessageId);
    const phase = parsed.phase === "assigned" || parsed.phase === "running" ? parsed.phase : null;
    if (!turnId || !chairAppId || !ownerAppId || !sourceMessageId || !phase) {
      return null;
    }
    return {
      roomEpoch: Math.max(1, normalizePositiveInt(parsed.roomEpoch)),
      turnId,
      chairAppId,
      ownerAppId,
      phase,
      participantOrder: normalizeStringArray(parsed.participantOrder),
      remainingQueue: normalizeStringArray(parsed.remainingQueue),
      sourceMessageId,
      assignDeadlineMs: normalizePositiveMs(parsed.assignDeadlineMs),
      finishDeadlineMs: normalizePositiveMs(parsed.finishDeadlineMs),
      fencingToken: Math.max(1, normalizePositiveInt(parsed.fencingToken)),
    };
  } catch {
    return null;
  }
}

function buildDiscussionTurnId(roomEpoch: number, fencingToken: number): string {
  return `turn-${roomEpoch}-${fencingToken}`;
}

function rotateAfterOwner(participantOrder: string[], ownerAppId: string): string[] {
  const index = participantOrder.indexOf(ownerAppId);
  if (index < 0) {
    return [...participantOrder];
  }
  return [...participantOrder.slice(index + 1), ...participantOrder.slice(0, index + 1)];
}

function normalizeDiscussionParticipantOrder(params: {
  participantAppIds: string[];
  chairAppId: string;
  ownerAppId: string;
}): string[] {
  return dedupeNonEmptyStrings([params.ownerAppId, ...params.participantAppIds, params.chairAppId]);
}

function extendDiscussionParticipantOrder(
  participantOrder: string[],
  additionalParticipantAppIds: string[],
): string[] {
  return dedupeNonEmptyStrings([...participantOrder, ...additionalParticipantAppIds]);
}

export function buildDiscussionTurnQueue(params: {
  participantOrder: string[];
  chairAppId: string;
  ownerAppId: string;
}): string[] {
  const participantOrder = dedupeNonEmptyStrings(params.participantOrder);
  const chairAppId = params.chairAppId.trim();
  const ownerAppId = params.ownerAppId.trim();
  const rotated = rotateAfterOwner(participantOrder, ownerAppId);
  const nonChairPeers = rotated.filter((appId) => appId !== ownerAppId && appId !== chairAppId);
  const shouldCloseWithChair =
    Boolean(chairAppId) &&
    participantOrder.includes(chairAppId) &&
    (chairAppId !== ownerAppId ? true : nonChairPeers.length > 0);
  return shouldCloseWithChair ? [...nonChairPeers, chairAppId] : nonChairPeers;
}

export function prioritizeDiscussionTurnQueue(
  queue: string[],
  prioritizedOwnerAppIds: string[],
): string[] {
  const normalizedQueue = dedupeNonEmptyStrings(queue);
  const prioritized = dedupeNonEmptyStrings(prioritizedOwnerAppIds);
  const prioritizedSet = new Set(prioritized);
  return [...prioritized, ...normalizedQueue.filter((appId) => !prioritizedSet.has(appId))];
}

export function createDiscussionRunningTurnState(params: {
  roomEpoch: number;
  fencingToken: number;
  chairAppId: string;
  ownerAppId: string;
  participantAppIds: string[];
  sourceMessageId: string;
  nowMs: number;
}): DiscussionTurnState {
  const participantOrder = normalizeDiscussionParticipantOrder({
    participantAppIds: params.participantAppIds,
    chairAppId: params.chairAppId,
    ownerAppId: params.ownerAppId,
  });
  return {
    roomEpoch: params.roomEpoch,
    turnId: buildDiscussionTurnId(params.roomEpoch, params.fencingToken),
    chairAppId: params.chairAppId,
    ownerAppId: params.ownerAppId,
    phase: "running",
    participantOrder,
    remainingQueue: buildDiscussionTurnQueue({
      participantOrder,
      chairAppId: params.chairAppId,
      ownerAppId: params.ownerAppId,
    }),
    sourceMessageId: params.sourceMessageId,
    assignDeadlineMs: params.nowMs,
    finishDeadlineMs: 0,
    fencingToken: params.fencingToken,
  };
}

export function createDiscussionAssignedTurnState(params: {
  roomEpoch: number;
  fencingToken: number;
  chairAppId: string;
  ownerAppId: string;
  participantAppIds: string[];
  sourceMessageId: string;
  nowMs: number;
  assignTimeoutMs?: number;
}): DiscussionTurnState {
  const participantOrder = normalizeDiscussionParticipantOrder({
    participantAppIds: params.participantAppIds,
    chairAppId: params.chairAppId,
    ownerAppId: params.ownerAppId,
  });
  return {
    roomEpoch: params.roomEpoch,
    turnId: buildDiscussionTurnId(params.roomEpoch, params.fencingToken),
    chairAppId: params.chairAppId,
    ownerAppId: params.ownerAppId,
    phase: "assigned",
    participantOrder,
    remainingQueue: buildDiscussionTurnQueue({
      participantOrder,
      chairAppId: params.chairAppId,
      ownerAppId: params.ownerAppId,
    }),
    sourceMessageId: params.sourceMessageId,
    assignDeadlineMs: params.nowMs + (params.assignTimeoutMs ?? DISCUSSION_TURN_ASSIGN_MS),
    finishDeadlineMs: 0,
    fencingToken: params.fencingToken,
  };
}

export function markDiscussionTurnRunningState(
  state: DiscussionTurnState,
  params: { nowMs: number },
): DiscussionTurnState {
  // No finish deadline — once claimed, the bot runs until it produces output.
  // Assign timeout (30s) catches dead bots; running bots should never be killed by a timer.
  return {
    ...state,
    phase: "running",
    assignDeadlineMs: params.nowMs,
    finishDeadlineMs: 0,
  };
}

export function advanceDiscussionTurnState(
  state: DiscussionTurnState,
  params: { nowMs: number; prioritizedOwnerAppIds?: string[]; assignTimeoutMs?: number },
): DiscussionTurnAdvanceResult {
  // A stale participant snapshot must not block an explicit baton handoff to a known bot.
  const explicitOwnerOverrides = dedupeNonEmptyStrings(params.prioritizedOwnerAppIds ?? []).filter(
    (appId) => appId !== state.ownerAppId,
  );
  const participantOrder =
    explicitOwnerOverrides.length > 0
      ? extendDiscussionParticipantOrder(state.participantOrder, explicitOwnerOverrides)
      : state.participantOrder;
  const explicitNextOwnerAppId = explicitOwnerOverrides[0] ?? null;
  const nextOwnerAppId =
    explicitNextOwnerAppId ?? dedupeNonEmptyStrings(state.remainingQueue)[0] ?? null;
  if (!nextOwnerAppId) {
    return { nextTurn: null, closed: true };
  }
  // When explicit handoff adds new participants, rebuild the queue from updated
  // participantOrder so all mentioned bots (and chair) get their turn.
  // Without this, the old empty queue would stay empty.
  const restQueue =
    explicitOwnerOverrides.length > 0
      ? buildDiscussionTurnQueue({
          participantOrder,
          chairAppId: state.chairAppId,
          ownerAppId: nextOwnerAppId,
        })
      : dedupeNonEmptyStrings(state.remainingQueue.filter((appId) => appId !== nextOwnerAppId));
  return {
    closed: false,
    nextTurn: {
      ...state,
      turnId: buildDiscussionTurnId(state.roomEpoch, state.fencingToken + 1),
      ownerAppId: nextOwnerAppId,
      phase: "assigned",
      participantOrder,
      remainingQueue: restQueue,
      assignDeadlineMs: params.nowMs + (params.assignTimeoutMs ?? DISCUSSION_TURN_ASSIGN_MS),
      finishDeadlineMs: 0,
      fencingToken: state.fencingToken + 1,
    },
  };
}

export function getDiscussionTurnExpiryReason(
  state: DiscussionTurnState,
  nowMs: number,
): "assign-timeout" | "finish-timeout" | null {
  if (state.phase === "assigned" && state.assignDeadlineMs > 0 && state.assignDeadlineMs <= nowMs) {
    return "assign-timeout";
  }
  if (state.phase === "running" && state.finishDeadlineMs > 0 && state.finishDeadlineMs <= nowMs) {
    return "finish-timeout";
  }
  return null;
}

export function shouldRegisterDiscussionParticipant(params: {
  isDiscussionMode: boolean;
}): boolean {
  return params.isDiscussionMode;
}

async function withDiscussionTurnCas<T>(
  chatId: string,
  mutator: (turn: DiscussionTurnState | null) => {
    turn: DiscussionTurnState | null;
    result: T;
  } | null,
): Promise<T | null> {
  if (!isRedisAvailable()) return null;
  const tKey = turnKey(chatId);
  for (let attempt = 0; attempt < 3; attempt++) {
    await redis!.watch(tKey);
    try {
      const turnRaw = await redis!.get(tKey);
      const next = mutator(parseDiscussionTurnState(turnRaw));
      if (!next) {
        await redis!.unwatch();
        return null;
      }
      const tx = redis!.multi();
      if (next.turn) {
        tx.set(tKey, JSON.stringify(next.turn));
      } else {
        tx.del(tKey);
      }
      const execResult = await tx.exec();
      if (execResult) {
        return next.result;
      }
    } catch (err) {
      await redis!.unwatch().catch(() => {});
      stateLog?.warn(`[discussion-state] CAS error: ${String(err).slice(0, 200)}`);
      return null;
    }
  }
  stateLog?.warn(`[discussion-state] ${chatId.slice(-8)}: turn CAS conflict`);
  return null;
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
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  redis.on("connect", () => {
    redisReady = true;
    stateLog?.info("[discussion-state] Redis connected");
  });
  redis.on("error", (err: unknown) => {
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

    if (shouldRegisterDiscussionParticipant({ isDiscussionMode })) {
      await redis!.zadd(pKey, now, myAppId);
    } else {
      await redis!.zrem(pKey, myAppId);
    }

    await redis!.zremrangebyscore(pKey, "-inf", now - LEASE_TTL_S);
    const participants = await redis!.zrangebyscore(pKey, now - LEASE_TTL_S, "+inf");
    const currentLeader = await electDiscussionLeader(chatId, participants);

    return {
      leader: currentLeader,
      isLeader: currentLeader === myAppId,
      participants,
    };
  } catch (err) {
    stateLog?.warn(`[discussion-state] tick error: ${String(err).slice(0, 200)}`);
    return fallbackResult(myAppId, isDiscussionMode);
  }
}

export async function seedDiscussionParticipants(
  chatId: string,
  participantAppIds: string[],
): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    const pKey = participantsKey(chatId);
    const seedParticipants = dedupeNonEmptyStrings(participantAppIds);
    if (seedParticipants.length === 0) return;
    const tx = redis!.multi();
    for (const participantAppId of seedParticipants) {
      tx.zadd(pKey, now, participantAppId);
    }
    await tx.exec();
    stateLog?.info(
      `[discussion-state] ${chatId.slice(-8)}: seeded ${seedParticipants.length} participants`,
    );
  } catch (err) {
    stateLog?.warn(`[discussion-state] seed error: ${String(err).slice(0, 200)}`);
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

export async function openDiscussionAgendaTurn(params: {
  chatId: string;
  ownerAppId: string;
  chairAppId: string;
  participantAppIds: string[];
  sourceMessageId: string;
  nowMs?: number;
  startAssigned?: boolean;
}): Promise<DiscussionTurnState | null> {
  if (!isRedisAvailable()) return null;
  const chatId = params.chatId.trim();
  const ownerAppId = params.ownerAppId.trim();
  const chairAppId = (params.chairAppId || params.ownerAppId).trim();
  const sourceMessageId = params.sourceMessageId.trim();
  if (!chatId || !ownerAppId || !chairAppId || !sourceMessageId) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  const epoch = await nextDiscussionEpoch(chatId);
  return withDiscussionTurnCas(chatId, (previousTurn) => {
    const fencingToken = Math.max(1, (previousTurn?.fencingToken ?? 0) + 1);
    const nextTurn = params.startAssigned
      ? createDiscussionAssignedTurnState({
          roomEpoch: epoch,
          fencingToken,
          chairAppId,
          ownerAppId,
          participantAppIds: params.participantAppIds,
          sourceMessageId,
          nowMs,
        })
      : createDiscussionRunningTurnState({
          roomEpoch: epoch,
          fencingToken,
          chairAppId,
          ownerAppId,
          participantAppIds: params.participantAppIds,
          sourceMessageId,
          nowMs,
        });
    return {
      turn: nextTurn,
      result: nextTurn,
    };
  });
}

async function nextDiscussionEpoch(chatId: string): Promise<number> {
  if (!isRedisAvailable()) return 1;
  try {
    return await redis!.incr(epochKey(chatId));
  } catch {
    return 1;
  }
}

export async function getDiscussionTurn(chatId: string): Promise<DiscussionTurnState | null> {
  if (!isRedisAvailable()) return null;
  try {
    return parseDiscussionTurnState(await redis!.get(turnKey(chatId)));
  } catch {
    return null;
  }
}

export async function claimDiscussionAssignedTurn(params: {
  chatId: string;
  myAppId: string;
  nowMs?: number;
}): Promise<DiscussionTurnState | null> {
  if (!isRedisAvailable()) return null;
  const chatId = params.chatId.trim();
  const myAppId = params.myAppId.trim();
  if (!chatId || !myAppId) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  return withDiscussionTurnCas(chatId, (turn) => {
    if (!turn || turn.ownerAppId !== myAppId || turn.phase !== "assigned") {
      return null;
    }
    const claimed = markDiscussionTurnRunningState(turn, { nowMs });
    return {
      turn: claimed,
      result: claimed,
    };
  });
}

async function transitionDiscussionTurn(params: {
  chatId: string;
  ownerAppId?: string;
  prioritizedOwnerAppIds?: string[];
  nextSourceMessageId?: string;
  nowMs?: number;
  reason: "advanced" | "expired";
}): Promise<DiscussionTurnTransitionResult | null> {
  if (!isRedisAvailable()) return null;
  const chatId = params.chatId.trim();
  if (!chatId) {
    return null;
  }
  const ownerAppId = params.ownerAppId?.trim();
  const nowMs = params.nowMs ?? Date.now();
  return withDiscussionTurnCas<DiscussionTurnTransitionResult>(chatId, (turn) => {
    if (!turn) {
      return null;
    }
    if (ownerAppId && turn.ownerAppId !== ownerAppId) {
      return null;
    }
    const advanced = advanceDiscussionTurnState(turn, {
      nowMs,
      prioritizedOwnerAppIds: params.prioritizedOwnerAppIds,
    });
    const nextTurn = advanced.closed ? null : advanced.nextTurn;
    if (nextTurn && params.nextSourceMessageId) {
      nextTurn.sourceMessageId = params.nextSourceMessageId;
    }
    return {
      turn: nextTurn,
      result: {
        reason: params.reason,
        previousOwnerAppId: turn.ownerAppId,
        nextTurn,
        closed: advanced.closed,
      },
    };
  });
}

export async function completeDiscussionTurnWithOutput(params: {
  chatId: string;
  ownerAppId: string;
  prioritizedOwnerAppIds?: string[];
  nextSourceMessageId?: string;
  nowMs?: number;
}): Promise<DiscussionTurnTransitionResult | null> {
  return transitionDiscussionTurn({
    chatId: params.chatId,
    ownerAppId: params.ownerAppId,
    prioritizedOwnerAppIds: params.prioritizedOwnerAppIds,
    nextSourceMessageId: params.nextSourceMessageId,
    nowMs: params.nowMs,
    reason: "advanced",
  });
}

export async function maybeExpireDiscussionTurn(params: {
  chatId: string;
  nowMs?: number;
}): Promise<DiscussionTurnTransitionResult | null> {
  if (!isRedisAvailable()) return null;
  const chatId = params.chatId.trim();
  if (!chatId) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  return withDiscussionTurnCas<DiscussionTurnTransitionResult>(chatId, (turn) => {
    if (!turn) {
      return null;
    }
    const expiryReason = getDiscussionTurnExpiryReason(turn, nowMs);
    if (!expiryReason) {
      return null;
    }
    const advanced = advanceDiscussionTurnState(turn, { nowMs });
    return {
      turn: advanced.closed ? null : advanced.nextTurn,
      result: {
        reason: "expired",
        previousOwnerAppId: turn.ownerAppId,
        nextTurn: advanced.closed ? null : advanced.nextTurn,
        closed: advanced.closed,
      },
    };
  });
}

export async function isDiscussionTurnOutputAllowed(params: {
  chatId: string;
  ownerAppId: string;
  expectedTurnId?: string;
}): Promise<boolean> {
  if (!isRedisAvailable()) return false;
  const chatId = params.chatId.trim();
  const ownerAppId = params.ownerAppId.trim();
  const expectedTurnId = params.expectedTurnId?.trim();
  if (!chatId || !ownerAppId) {
    return false;
  }
  try {
    const turn = parseDiscussionTurnState(await redis!.get(turnKey(chatId)));
    if (!turn || turn.phase !== "running" || turn.ownerAppId !== ownerAppId) {
      return false;
    }
    if (expectedTurnId && turn.turnId !== expectedTurnId) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function isDiscussionTurnCurrent(params: {
  chatId: string;
  expectedTurnId: string;
}): Promise<boolean> {
  if (!isRedisAvailable()) return false;
  const chatId = params.chatId.trim();
  const expectedTurnId = params.expectedTurnId.trim();
  if (!chatId || !expectedTurnId) {
    return false;
  }
  try {
    const turn = parseDiscussionTurnState(await redis!.get(turnKey(chatId)));
    return turn?.turnId === expectedTurnId;
  } catch {
    return false;
  }
}

/**
 * Clear the active turn without destroying participants/leader state.
 * The discussion stays "ready" — next human message can bootstrap a new round.
 */
export async function clearDiscussionTurn(chatId: string): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis!.del(turnKey(chatId));
    stateLog?.info(`[discussion-state] ${chatId.slice(-8)}: turn cleared`);
  } catch {}
}

/**
 * Set leader explicitly (called by Her via set_discussion_leader tool).
 * Writes to Redis so all containers see the change immediately.
 */
export async function setDiscussionLeader(
  chatId: string,
  appId: string,
  expectedTurnId?: string,
): Promise<boolean> {
  if (!isRedisAvailable()) {
    stateLog?.warn("[discussion-state] setDiscussionLeader: Redis unavailable");
    return false;
  }
  if (expectedTurnId && !(await isDiscussionTurnCurrent({ chatId, expectedTurnId }))) {
    stateLog?.info(
      `[discussion-state] ${chatId.slice(-8)}: rejected stale setDiscussionLeader for turn=${expectedTurnId}`,
    );
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

function buildSyntheticDiscussionSourceMessageId(params: {
  chatId: string;
  ownerAppId: string;
  kind: string;
  nowMs: number;
}): string {
  return `discussion-tool:${params.chatId}:${params.kind}:${params.ownerAppId}:${params.nowMs}`;
}

export async function endDiscussion(chatId: string, expectedTurnId?: string): Promise<boolean> {
  const normalizedChatId = chatId.trim();
  if (!normalizedChatId || !isRedisAvailable()) {
    return false;
  }
  // Empty remainingQueue so no successor is assigned after the current owner's reply.
  // The turn stays valid so the owner can still deliver text output without suppression.
  const result = await withDiscussionTurnCas(normalizedChatId, (turn) => {
    if (!turn) return null;
    if (expectedTurnId && turn.turnId !== expectedTurnId) return null;
    return {
      turn: { ...turn, remainingQueue: [] },
      result: true as const,
    };
  });
  if (result) {
    stateLog?.info(
      `[discussion-state] ${normalizedChatId.slice(-8)}: discussion ended (queue cleared)`,
    );
  } else {
    stateLog?.info(
      `[discussion-state] ${normalizedChatId.slice(-8)}: endDiscussion skipped (stale or no turn)`,
    );
  }
  return result ?? false;
}

export async function resetDiscussionRoom(params: {
  chatId: string;
  ownerAppId: string;
  chairAppId?: string;
  participantAppIds?: string[];
  sourceMessageId?: string;
  nowMs?: number;
  expectedTurnId?: string;
}): Promise<DiscussionTurnState | null> {
  if (!isRedisAvailable()) return null;
  const chatId = params.chatId.trim();
  const ownerAppId = params.ownerAppId.trim();
  const chairAppId = (params.chairAppId || params.ownerAppId).trim();
  if (!chatId || !ownerAppId || !chairAppId) {
    return null;
  }
  if (
    params.expectedTurnId &&
    !(await isDiscussionTurnCurrent({ chatId, expectedTurnId: params.expectedTurnId }))
  ) {
    stateLog?.info(
      `[discussion-state] ${chatId.slice(-8)}: rejected stale resetDiscussion for turn=${params.expectedTurnId}`,
    );
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  const previousParticipants =
    params.participantAppIds && params.participantAppIds.length > 0
      ? params.participantAppIds
      : await getDiscussionParticipants(chatId);
  const participantAppIds = dedupeNonEmptyStrings([
    ownerAppId,
    ...previousParticipants,
    chairAppId,
  ]);
  const explicitSource = normalizeString(params.sourceMessageId);
  let inheritedRealSource: string | null = null;
  if (!explicitSource) {
    const currentTurn = await getDiscussionTurn(chatId);
    const cur = currentTurn?.sourceMessageId;
    if (cur && !cur.startsWith("discussion-tool:") && !cur.startsWith("discussion-turn:")) {
      inheritedRealSource = cur;
    }
  }
  const sourceMessageId =
    explicitSource ||
    inheritedRealSource ||
    buildSyntheticDiscussionSourceMessageId({
      chatId,
      ownerAppId,
      kind: "reset",
      nowMs,
    });
  await seedDiscussionParticipants(chatId, participantAppIds);
  await setDiscussionLeader(chatId, chairAppId);
  stateLog?.info(
    `[discussion-state] ${chatId.slice(-8)}: discussion reset by ${ownerAppId.slice(-8)}`,
  );
  return openDiscussionAgendaTurn({
    chatId,
    ownerAppId,
    chairAppId,
    participantAppIds,
    sourceMessageId,
    nowMs,
    startAssigned: true,
  });
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
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  subscriber.on("connect", () => {
    subscriberReady = true;
    stateLog?.info("[discussion-broadcast] subscriber Redis connected");
  });
  subscriber.on("error", (err: unknown) => {
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
  subscriber.psubscribe(`${BROADCAST_CHANNEL}:*`).catch((err: unknown) => {
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
    return { leader: null, isLeader: false, participants: [] };
  }
  return { leader: myAppId, isLeader: true, participants: [myAppId] };
}
