/**
 * discussion-dashboard.ts — Self-contained discussion mode visual dashboard.
 *
 * Pure observer: reads existing discussion state via exported APIs from
 * discussion-state.ts, never modifies turn/participant/leader state.
 * Only the leader bot creates and patches its own interactive card.
 *
 * Coupling: gateway.ts calls initDashboard() + destroyDashboard() (~5 lines).
 *           Reads from discussion-state.ts, outbound.ts, chat-api.ts, group-mode.ts.
 *           Zero modifications to any of those modules.
 */

import { Redis } from "ioredis";
import type { ResolvedFeishuAccount } from "./accounts.js";
import {
  getDiscussionTurn,
  getDiscussionParticipants,
  getDiscussionLeader,
  type DiscussionTurnState,
  type BotBroadcastMessage,
} from "./discussion-state.js";
import { readGroupMode } from "./group-mode.js";
import { getFeishuClient } from "./outbound.js";
import { callChatApi } from "./tools/chat-api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface DashboardOpts {
  redisUrl?: string;
  account: ResolvedFeishuAccount;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface DashboardMeta {
  messageId: string;
  ownerAppId: string;
  epoch: number;
  lastFingerprint: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TICK_MS = 15_000;
const BROADCAST_CHANNEL = "bot-msg";
const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

// ── Module state (singleton, mirrors discussion-state.ts pattern) ─────────────

let redis: Redis | null = null;
let sub: Redis | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let account: ResolvedFeishuAccount | null = null;
let log: DashboardOpts["log"] | undefined;

const knownChatIds = new Set<string>();
const cache = new Map<string, DashboardMeta>();
const refreshLocks = new Set<string>();

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function initDashboard(opts: DashboardOpts): void {
  const url = opts.redisUrl ?? process.env.REDIS_URL;
  log = opts.log;
  account = opts.account;

  if (!url) {
    log?.warn("[dashboard] no REDIS_URL, dashboard disabled");
    return;
  }

  redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  redis.on("error", (err: unknown) => {
    log?.warn(`[dashboard] redis error: ${String(err).slice(0, 120)}`);
  });

  // Pre-populate name cache from config so all bots are named from the start
  if (account.knownBots) {
    for (const [appId, botName] of Object.entries(account.knownBots)) {
      void registerName(appId, botName);
    }
  }

  sub = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  });
  sub.on("error", (err: unknown) => {
    log?.warn(`[dashboard] subscriber error: ${String(err).slice(0, 120)}`);
  });

  sub.psubscribe(`${BROADCAST_CHANNEL}:*`).catch((err: unknown) => {
    log?.warn(`[dashboard] psubscribe error: ${String(err).slice(0, 120)}`);
  });
  sub.on("pmessage", (_pattern: string, channel: string, data: string) => {
    try {
      const msg = JSON.parse(data) as BotBroadcastMessage;
      const chatId = channel.slice(BROADCAST_CHANNEL.length + 1);
      if (!chatId.startsWith("oc_")) return;
      knownChatIds.add(chatId);
      log?.info(`[dashboard] pmessage: chatId=${chatId.slice(-8)} from=${msg.senderAppId?.slice(-8)}`);
      if (msg.senderAppId && msg.senderName) {
        void registerName(msg.senderAppId, msg.senderName);
      }
      void safeRefresh(chatId);
    } catch {
      // ignore parse errors
    }
  });

  timer = setInterval(() => {
    for (const chatId of knownChatIds) {
      void safeRefresh(chatId);
    }
  }, TICK_MS);

  log?.info(`[dashboard] initialized (tick=${TICK_MS}ms, appId=${account.appId.slice(-8)})`);
}

export async function destroyDashboard(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (sub) {
    try {
      await sub.punsubscribe();
      sub.disconnect();
    } catch {}
    sub = null;
  }
  if (redis) {
    try {
      redis.disconnect();
    } catch {}
    redis = null;
  }
  knownChatIds.clear();
  cache.clear();
  refreshLocks.clear();
  account = null;
  log?.info("[dashboard] destroyed");
}

// ── Name cache (dashboard-internal Redis hash) ────────────────────────────────

async function registerName(appId: string, name: string): Promise<void> {
  if (!redis || !appId || !name) return;
  try {
    await redis.hset("discussion:name_cache", appId, name);
  } catch {}
}

async function getNameMap(appIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!redis || appIds.length === 0) return map;
  try {
    const values = await redis.hmget("discussion:name_cache", ...appIds);
    for (let i = 0; i < appIds.length; i++) {
      if (values[i]) map.set(appIds[i]!, values[i]!);
    }
  } catch {}
  return map;
}

// ── State fingerprint (avoids redundant PATCH when nothing changed) ───────────

function fingerprint(
  turn: DiscussionTurnState,
  participants: string[],
  leader: string | null,
): string {
  return [
    turn.turnId,
    turn.phase,
    turn.ownerAppId,
    turn.fencingToken,
    turn.remainingQueue.join(","),
    [...participants].sort().join(","),
    leader ?? "",
  ].join("|");
}

// ── Core refresh logic ────────────────────────────────────────────────────────

async function safeRefresh(chatId: string): Promise<void> {
  if (refreshLocks.has(chatId)) return;
  refreshLocks.add(chatId);
  try {
    await refreshDashboard(chatId);
  } catch (err) {
    log?.warn(`[dashboard] ${chatId.slice(-8)}: refresh error: ${String(err).slice(0, 200)}`);
  } finally {
    refreshLocks.delete(chatId);
  }
}

async function refreshDashboard(chatId: string): Promise<void> {
  if (!redis || !account) return;
  const myAppId = account.appId;

  const [turn, participants, leader] = await Promise.all([
    getDiscussionTurn(chatId),
    getDiscussionParticipants(chatId),
    getDiscussionLeader(chatId),
  ]);

  if (!turn) {
    const existing = cache.get(chatId) ?? (await loadMetaFromRedis(chatId));
    if (existing && existing.ownerAppId === myAppId) {
      await closeDashboard(chatId, existing);
    }
    return;
  }

  if (leader !== myAppId) {
    log?.info(`[dashboard] ${chatId.slice(-8)}: skip refresh (leader=${leader?.slice(-8)} != me=${myAppId.slice(-8)})`);
    return;
  }

  const fp = fingerprint(turn, participants, leader);
  const meta = cache.get(chatId) ?? (await loadMetaFromRedis(chatId));

  if (!meta) {
    await createCard(chatId, turn, participants, leader, fp);
    return;
  }

  if (meta.epoch !== turn.roomEpoch || meta.ownerAppId !== myAppId) {
    await createCard(chatId, turn, participants, leader, fp);
    return;
  }

  if (meta.lastFingerprint !== fp) {
    log?.info(`[dashboard] ${chatId.slice(-8)}: patching (owner=${turn.ownerAppId.slice(-8)} phase=${turn.phase})`);
    await patchCard(chatId, meta.messageId, turn, participants, leader, fp);
  } else {
    log?.info(`[dashboard] ${chatId.slice(-8)}: no change (fp match)`);
  }
}

async function loadMetaFromRedis(chatId: string): Promise<DashboardMeta | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(`discussion:${chatId}:dashboard`);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { messageId?: string; ownerAppId?: string; epoch?: number };
    if (!stored.messageId || !stored.ownerAppId) return null;
    const meta: DashboardMeta = {
      messageId: stored.messageId,
      ownerAppId: stored.ownerAppId,
      epoch: stored.epoch ?? 0,
      lastFingerprint: "",
    };
    cache.set(chatId, meta);
    return meta;
  } catch {
    return null;
  }
}

// ── Card rendering ────────────────────────────────────────────────────────────

function stripTopicPrefix(text: string): string {
  return text.replace(/^话题[：:]\s*/i, "").trim();
}

export function buildDashboardCard(params: {
  turn: DiscussionTurnState;
  participants: string[];
  leader: string | null;
  nameMap: Map<string, string>;
  topic?: string;
}): object {
  const { turn, participants, leader, nameMap, topic } = params;
  const n = (appId: string) => nameMap.get(appId) || appId.slice(-8);
  const online = new Set(participants);

  const topicText = topic ? stripTopicPrefix(topic) : "";
  const speakerName = n(turn.ownerAppId);
  const isSpeaking = turn.phase === "running";

  // Dynamic header: current speaker status as title, topic as subtitle
  const headerTitle = isSpeaking ? `🎙️ ${speakerName} 发言中` : `⏳ ${speakerName} 准备中`;

  // Tag list: round, online count, next in queue (max 3 tags)
  const textTags: object[] = [
    {
      tag: "text_tag",
      text: { tag: "plain_text", content: `第${turn.roomEpoch}轮` },
      color: "blue",
    },
    {
      tag: "text_tag",
      text: { tag: "plain_text", content: `${participants.length}人在线` },
      color: "green",
    },
  ];
  const nextInQueue = turn.remainingQueue.find((id) => id !== turn.ownerAppId);
  if (nextInQueue) {
    textTags.push({
      tag: "text_tag",
      text: { tag: "plain_text", content: `下一位: ${n(nextInQueue)}` },
      color: "purple",
    });
  }

  // Participants section
  const allAppIds = dedup([...turn.participantOrder, ...participants]);
  const pLines: string[] = [];
  pLines.push(`**参与者**（${participants.length} 在线 / ${allAppIds.length} 总计）`);
  for (const id of allAppIds) {
    const tags: string[] = [];
    if (id === leader) tags.push("👑leader");
    if (id === turn.ownerAppId) {
      tags.push(isSpeaking ? "🎙️发言中" : "⏳已分配");
    } else if (turn.remainingQueue.includes(id)) {
      tags.push("🔜排队中");
    } else {
      tags.push("💤等待中");
    }
    if (!online.has(id)) tags.push("⚫离线");
    pLines.push(`　${n(id)}　${tags.join(" ")}`);
  }

  // Turn + queue section
  const turnLines: string[] = [];
  if (turn.remainingQueue.length > 0) {
    turnLines.push(`**发言顺序**　${[speakerName, ...turn.remainingQueue.map(n)].join(" → ")}`);
  } else {
    turnLines.push("**队列**　空（本轮后讨论关闭）");
  }

  // Timestamp
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return {
    header: {
      title: { tag: "plain_text", content: headerTitle },
      subtitle: topicText ? { tag: "plain_text", content: topicText } : undefined,
      text_tag_list: textTags,
      template: isSpeaking ? "blue" : "wathet",
    },
    config: { update_multi: true, wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: pLines.join("\n") },
      { tag: "hr" },
      { tag: "markdown", content: turnLines.join("\n") },
      { tag: "hr" },
      { tag: "markdown", content: `更新　${hh}:${mm}:${ss}` },
    ],
  };
}

function buildCloseCard(): object {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return {
    header: {
      title: { tag: "plain_text", content: "讨论面板 · 已结束" },
      template: "grey",
    },
    config: { update_multi: true, wide_screen_mode: true },
    elements: [{ tag: "markdown", content: `讨论已结束　${hh}:${mm}:${ss}` }],
  };
}

function dedup(arr: string[]): string[] {
  const seen = new Set<string>();
  return arr.filter((v) => {
    if (!v || seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

// ── Card CRUD (self-contained Feishu API calls) ───────────────────────────────

async function createCard(
  chatId: string,
  turn: DiscussionTurnState,
  participants: string[],
  leader: string | null,
  fp: string,
): Promise<void> {
  if (!account) return;

  const allAppIds = dedup([...turn.participantOrder, ...participants, turn.ownerAppId]);
  const nameMap = await getNameMap(allAppIds);
  const modeInfo = readGroupMode(chatId);
  const card = buildDashboardCard({
    turn,
    participants,
    leader,
    nameMap,
    topic: modeInfo.context || undefined,
  });

  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const resp = (await client.im.message.create({
      params: { receive_id_type: "chat_id" as const },
      data: { receive_id: chatId, content: JSON.stringify(card), msg_type: "interactive" },
    })) as { data?: { message_id?: string } };

    const messageId = resp?.data?.message_id;
    if (!messageId) {
      log?.warn(`[dashboard] ${chatId.slice(-8)}: create returned no message_id`);
      return;
    }

    const meta: DashboardMeta = {
      messageId,
      ownerAppId: account.appId,
      epoch: turn.roomEpoch,
      lastFingerprint: fp,
    };
    cache.set(chatId, meta);
    await redis?.set(
      `discussion:${chatId}:dashboard`,
      JSON.stringify({ messageId, ownerAppId: meta.ownerAppId, epoch: meta.epoch }),
    );

    await setTopNotice(chatId, messageId);
    log?.info(
      `[dashboard] ${chatId.slice(-8)}: created card=${messageId.slice(-12)} epoch=${turn.roomEpoch}`,
    );
  } catch (err) {
    log?.warn(`[dashboard] ${chatId.slice(-8)}: create error: ${String(err).slice(0, 200)}`);
  }
}

async function patchCard(
  chatId: string,
  messageId: string,
  turn: DiscussionTurnState,
  participants: string[],
  leader: string | null,
  fp: string,
): Promise<void> {
  if (!account) return;

  const allAppIds = dedup([...turn.participantOrder, ...participants, turn.ownerAppId]);
  const nameMap = await getNameMap(allAppIds);
  const modeInfo = readGroupMode(chatId);
  const card = buildDashboardCard({
    turn,
    participants,
    leader,
    nameMap,
    topic: modeInfo.context || undefined,
  });

  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const token = await (client as any).tokenManager.getTenantAccessToken({});
    if (!token) return;

    const res = await fetch(`${FEISHU_API_BASE}/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    });
    const data = (await res.json()) as { code: number; msg: string };
    if (data.code !== 0) {
      log?.warn(`[dashboard] ${chatId.slice(-8)}: patch FAILED: ${data.code} ${data.msg}`);
      if (data.code === 230001 || data.code === 230003) {
        cache.delete(chatId);
      }
      return;
    }
    log?.info(`[dashboard] ${chatId.slice(-8)}: patch OK (owner=${turn.ownerAppId.slice(-8)} next=${turn.remainingQueue.find((id) => id !== turn.ownerAppId)?.slice(-8) ?? "none"})`);

    // Re-pin to force Feishu to refresh the pinned preview
    await setTopNotice(chatId, messageId);

    const meta = cache.get(chatId);
    if (meta) meta.lastFingerprint = fp;
  } catch (err) {
    log?.warn(`[dashboard] ${chatId.slice(-8)}: patch error: ${String(err).slice(0, 200)}`);
  }
}

async function closeDashboard(chatId: string, meta: DashboardMeta): Promise<void> {
  if (!account) return;

  try {
    const client = getFeishuClient(account);
    // oxlint-disable-next-line typescript/no-explicit-any
    const token = await (client as any).tokenManager.getTenantAccessToken({});
    if (token) {
      const card = buildCloseCard();
      await fetch(`${FEISHU_API_BASE}/im/v1/messages/${meta.messageId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: JSON.stringify(card) }),
      });
    }
  } catch (err) {
    log?.warn(`[dashboard] ${chatId.slice(-8)}: close patch error: ${String(err).slice(0, 120)}`);
  }

  await removeTopNotice(chatId);
  cache.delete(chatId);
  knownChatIds.delete(chatId);
  try {
    await redis?.del(`discussion:${chatId}:dashboard`);
  } catch {}
  log?.info(`[dashboard] ${chatId.slice(-8)}: closed`);
}

// ── Top notice helpers ────────────────────────────────────────────────────────

async function setTopNotice(chatId: string, messageId: string): Promise<void> {
  if (!account) return;
  try {
    await callChatApi({
      account,
      method: "POST",
      endpoint: `/im/v1/chats/${chatId}/top_notice/put_top_notice`,
      body: { chat_top_notice: [{ action_type: "1", message_id: messageId }] },
    });
  } catch (err) {
    log?.warn(`[dashboard] ${chatId.slice(-8)}: top notice error: ${String(err).slice(0, 120)}`);
  }
}

async function removeTopNotice(chatId: string): Promise<void> {
  if (!account) return;
  try {
    await callChatApi({
      account,
      method: "POST",
      endpoint: `/im/v1/chats/${chatId}/top_notice/delete_top_notice`,
    });
  } catch (err) {
    log?.warn(
      `[dashboard] ${chatId.slice(-8)}: remove top notice error: ${String(err).slice(0, 120)}`,
    );
  }
}
