import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverPeers, type A2AAgentCard } from "../src/registry.js";

const cardKey = (id: string) => `a2a:card:${id}`;

class FakeRedis {
  constructor(
    private readonly ids: string[],
    private readonly cards: Map<string, string>,
  ) {}

  async smembers(): Promise<string[]> {
    return this.ids;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.cards.get(key) ?? null);
  }

  async srem(): Promise<number> {
    return 0;
  }
}

function makeCard(overrides: Partial<A2AAgentCard> = {}): A2AAgentCard {
  return {
    id: "peer",
    name: "Peer",
    server: "S1",
    endpoints: {
      docker: "http://carher-75:18800/a2a/jsonrpc",
      lan: "http://10.68.13.188:29746/a2a/jsonrpc",
    },
    skills: [],
    registeredAt: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}

async function discover(card: A2AAgentCard, selfServer: string) {
  const redis = new FakeRedis(
    ["self", card.id],
    new Map([[cardKey(card.id), JSON.stringify(card)]]),
  );
  const peers = await discoverPeers(redis as any, "self", selfServer);
  assert.equal(peers.length, 1);
  return peers[0]!;
}

describe("A2A Redis registry endpoint selection", () => {
  it("uses Docker DNS for peers on the same concrete server", async () => {
    const peer = await discover(makeCard({ server: "S1" }), "S1");
    assert.equal(peer.agentCardUrl, "http://carher-75:18800/.well-known/agent-card.json");
  });

  it("uses LAN for peers on a different concrete server", async () => {
    const peer = await discover(makeCard({ server: "S3" }), "S1");
    assert.equal(peer.agentCardUrl, "http://10.68.13.188:29746/.well-known/agent-card.json");
  });

  it("treats server=local as non-routing metadata and prefers LAN", async () => {
    const peer = await discover(makeCard({ server: "local" }), "local");
    assert.equal(peer.agentCardUrl, "http://10.68.13.188:29746/.well-known/agent-card.json");
  });

  it("keeps Docker DNS for local dev when LAN is loopback", async () => {
    const peer = await discover(
      makeCard({
        server: "local",
        endpoints: {
          docker: "http://carher-102:18800/a2a/jsonrpc",
          lan: "http://127.0.0.1:30016/a2a/jsonrpc",
        },
      }),
      "local",
    );
    assert.equal(peer.agentCardUrl, "http://carher-102:18800/.well-known/agent-card.json");
  });
});
