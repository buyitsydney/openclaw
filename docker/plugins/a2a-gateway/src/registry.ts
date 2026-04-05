/**
 * A2A Redis Registry — self-registration and peer discovery.
 *
 * Keys:
 *   a2a:card:{botId}  = Agent Card JSON (TTL 120s)
 *   a2a:index          = SET of registered botIds
 */

import type Redis from "ioredis";

const KEY_PREFIX = "a2a:card:";
const INDEX_KEY = "a2a:index";
const LEASE_TTL_SECONDS = 120;
const RENEW_INTERVAL_MS = 60_000;
const DISCOVER_CACHE_MS = 30_000;

export interface A2AAgentCard {
  id: string;
  name: string;
  server: string;
  endpoints: {
    docker: string;
    lan?: string;
  };
  ownerAccountId?: string;
  skills: Array<{ id: string; name: string }>;
  registeredAt: string;
}

export interface PeerFromRegistry {
  name: string;
  agentCardUrl: string;
  card: A2AAgentCard;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerSelf(redis: Redis, card: A2AAgentCard): Promise<void> {
  const key = KEY_PREFIX + card.id;
  const json = JSON.stringify(card);
  await redis.set(key, json, "EX", LEASE_TTL_SECONDS);
  await redis.sadd(INDEX_KEY, card.id);
}

export async function renewLease(redis: Redis, botId: string, card?: A2AAgentCard): Promise<void> {
  const key = KEY_PREFIX + botId;
  const renewed = await redis.expire(key, LEASE_TTL_SECONDS);
  if (renewed === 0 && card) {
    // Key expired (sleep/restart/Redis flush) — re-register
    await registerSelf(redis, card);
  }
}

export async function unregisterSelf(redis: Redis, botId: string): Promise<void> {
  const key = KEY_PREFIX + botId;
  await redis.del(key);
  await redis.srem(INDEX_KEY, botId);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function discoverPeers(
  redis: Redis,
  selfId: string,
  selfServer: string,
): Promise<PeerFromRegistry[]> {
  const allIds = await redis.smembers(INDEX_KEY);
  const peerIds = allIds.filter((id) => id !== selfId);
  if (peerIds.length === 0) {
    return [];
  }

  const keys = peerIds.map((id) => KEY_PREFIX + id);
  const values = await redis.mget(...keys);

  const peers: PeerFromRegistry[] = [];
  for (let i = 0; i < peerIds.length; i++) {
    const raw = values[i];
    if (!raw) {
      continue;
    } // TTL expired, stale index entry
    try {
      const card = JSON.parse(raw) as A2AAgentCard;
      // Same server → Docker DNS; cross server → LAN IP
      const sameServer = card.server === selfServer;
      const endpoint = sameServer
        ? card.endpoints.docker
        : card.endpoints.lan || card.endpoints.docker;
      peers.push({
        name: card.name || card.id,
        agentCardUrl: endpoint.replace("/a2a/jsonrpc", "/.well-known/agent-card.json"),
        card,
      });
    } catch {
      // Corrupted entry, skip
    }
  }

  // Clean up stale index entries (card expired but still in SET)
  const staleIds = peerIds.filter((_, i) => !values[i]);
  if (staleIds.length > 0) {
    await redis.srem(INDEX_KEY, ...staleIds).catch(() => {});
  }

  return peers;
}

// ---------------------------------------------------------------------------
// Lifecycle manager — handles renew timer and cached discovery
// ---------------------------------------------------------------------------

export class RegistryManager {
  private redis: Redis;
  private card: A2AAgentCard;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private cachedPeers: PeerFromRegistry[] = [];
  private cacheExpiry = 0;
  private log: (msg: string) => void;
  public readonly server: string;

  constructor(redis: Redis, card: A2AAgentCard, log?: (msg: string) => void) {
    this.redis = redis;
    this.card = card;
    this.server = card.server;
    this.log = log || (() => {});
  }

  async start(): Promise<void> {
    await registerSelf(this.redis, this.card);
    this.log(`a2a-registry: registered ${this.card.id} (${this.card.name})`);

    this.renewTimer = setInterval(async () => {
      try {
        await renewLease(this.redis, this.card.id, this.card);
      } catch (err) {
        this.log(`a2a-registry: renew failed: ${err}`);
      }
    }, RENEW_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    try {
      await unregisterSelf(this.redis, this.card.id);
      this.log(`a2a-registry: unregistered ${this.card.id}`);
    } catch {
      // Best-effort on shutdown
    }
  }

  async getPeers(): Promise<PeerFromRegistry[]> {
    const now = Date.now();
    if (now < this.cacheExpiry) {
      return this.cachedPeers;
    }

    try {
      this.cachedPeers = await discoverPeers(this.redis, this.card.id, this.server);
      this.cacheExpiry = now + DISCOVER_CACHE_MS;
    } catch (err) {
      this.log(`a2a-registry: discover failed: ${err}`);
      // Return stale cache on error
    }
    return this.cachedPeers;
  }

  findPeerByName(name: string, peers: PeerFromRegistry[]): PeerFromRegistry | undefined {
    const lower = name.toLowerCase();
    return peers.find((p) => p.name.toLowerCase() === lower || p.card.id.toLowerCase() === lower);
  }

  getCard(): A2AAgentCard {
    return this.card;
  }
}

// ---------------------------------------------------------------------------
// Owner account discovery — scan feishu-user-tokens/ directory
// ---------------------------------------------------------------------------

export function discoverOwnerAccountId(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  const tokenDir = path.join(
    process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"),
    "feishu-user-tokens",
  );

  try {
    const files = fs.readdirSync(tokenDir).filter((f: string) => f.endsWith(".json"));
    if (files.length === 0) {
      return undefined;
    }

    // Find the most recently updated token file
    let newest = { file: "", mtime: 0 };
    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(tokenDir, f));
        if (stat.mtimeMs > newest.mtime) {
          newest = { file: f, mtime: stat.mtimeMs };
        }
      } catch {
        continue;
      }
    }

    // Filename = "{open_id}.json" → extract open_id
    return newest.file.replace(/\.json$/, "") || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Bot identity discovery — resolve container hostname as bot ID
// ---------------------------------------------------------------------------

export function discoverBotId(): string {
  const os = require("node:os") as typeof import("node:os");
  // In Docker, hostname = container name (e.g., "carher-101")
  // OPENCLAW_INSTANCE_ID is also available: "carher-101-20260329..."
  const instanceId = process.env.OPENCLAW_INSTANCE_ID || "";
  const match = instanceId.match(/^(carher-\d+)/);
  if (match) {
    return match[1];
  }
  return os.hostname();
}

export function discoverBotName(): string {
  // Try to read from identity file or config
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  const identityPath = path.join(
    process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"),
    "IDENTITY.md",
  );
  try {
    const content = fs.readFileSync(identityPath, "utf-8");
    // Look for "name:" or first heading
    const nameMatch = content.match(/^#\s+(.+)/m) || content.match(/name:\s*(.+)/im);
    if (nameMatch) {
      return nameMatch[1].trim();
    }
  } catch {
    // Fall through
  }
  return discoverBotId();
}
