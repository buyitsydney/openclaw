/**
 * Tests for Realtime Server multi-agent support.
 *
 * Verifies that:
 * 1. No agentId param -> default "main" (backward-compatible)
 * 2. ?agentId=main -> same as default
 * 3. ?agentId=alice -> uses "alice" agent
 * 4. Existing personal Her is unaffected (no agentId = same behavior as before)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import WebSocket from "ws";

/**
 * Inline mirror of the server's resolveAgentIdFromUrl for unit-level testing.
 * The real function is not exported, so we duplicate the logic here to
 * verify the parsing independently.
 */
function resolveAgentIdFromUrl(
  urlStr: string | undefined,
  defaultAgentId: string,
): string {
  if (!urlStr) return defaultAgentId;
  try {
    const parsed = new URL(urlStr, "http://localhost");
    return parsed.searchParams.get("agentId")?.trim() || defaultAgentId;
  } catch {
    return defaultAgentId;
  }
}

describe("resolveAgentIdFromUrl", () => {
  it("returns default when url is undefined", () => {
    expect(resolveAgentIdFromUrl(undefined, "main")).toBe("main");
  });

  it("returns default when url has no agentId param", () => {
    expect(resolveAgentIdFromUrl("/ws", "main")).toBe("main");
  });

  it("returns default when agentId param is empty", () => {
    expect(resolveAgentIdFromUrl("/ws?agentId=", "main")).toBe("main");
  });

  it("returns default when agentId param is whitespace", () => {
    expect(resolveAgentIdFromUrl("/ws?agentId=%20", "main")).toBe("main");
  });

  it("extracts agentId from query param", () => {
    expect(resolveAgentIdFromUrl("/ws?agentId=alice", "main")).toBe("alice");
  });

  it("preserves agentId=main as explicit value", () => {
    expect(resolveAgentIdFromUrl("/ws?agentId=main", "main")).toBe("main");
  });

  it("extracts agentId alongside other params", () => {
    expect(resolveAgentIdFromUrl("/ws?foo=bar&agentId=test&baz=1", "main")).toBe("test");
  });

  it("trims agentId whitespace", () => {
    expect(resolveAgentIdFromUrl("/ws?agentId=%20alice%20", "main")).toBe("alice");
  });

  it("handles bootstrap URL", () => {
    expect(resolveAgentIdFromUrl("/api/realtime/bootstrap?agentId=vendor", "main")).toBe("vendor");
  });

  it("handles invalid URL gracefully", () => {
    expect(resolveAgentIdFromUrl("::not-a-url", "main")).toBe("main");
  });
});

describe("appendQueryParam (frontend helper)", () => {
  // Mirrors the frontend appendQueryParam function
  function appendQueryParam(url: string, key: string, value: string): string {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }

  it("appends to URL without existing params", () => {
    expect(appendQueryParam("ws://localhost:18790/ws", "agentId", "alice"))
      .toBe("ws://localhost:18790/ws?agentId=alice");
  });

  it("appends to URL with existing params", () => {
    expect(appendQueryParam("ws://localhost:18790/ws?foo=bar", "agentId", "alice"))
      .toBe("ws://localhost:18790/ws?foo=bar&agentId=alice");
  });
});

describe("Realtime Server WebSocket agentId routing", () => {
  let httpServer: http.Server;
  let wss: import("ws").WebSocketServer;
  const port = 19999; // Use high port to avoid conflicts
  const clients: Array<{ agentId: string; sessionId: string }> = [];

  beforeAll(async () => {
    // Minimal server that mimics the real server's agentId extraction
    httpServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    const { WebSocketServer } = await import("ws");
    wss = new WebSocketServer({ server: httpServer, path: "/ws" });

    wss.on("connection", (ws, req) => {
      const agentId = resolveAgentIdFromUrl(req.url, "main");
      const sessionId = `test:${Date.now()}`;
      clients.push({ agentId, sessionId });

      ws.send(JSON.stringify({ type: "connected", sessionId, agentId }));
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(port, resolve);
    });
  });

  afterAll(async () => {
    wss.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("connects without agentId and gets default 'main'", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const msg = await new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });
    ws.close();
    const parsed = JSON.parse(msg);
    expect(parsed.agentId).toBe("main");
  });

  it("connects with ?agentId=main and gets 'main'", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?agentId=main`);
    const msg = await new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });
    ws.close();
    const parsed = JSON.parse(msg);
    expect(parsed.agentId).toBe("main");
  });

  it("connects with ?agentId=alice and gets 'alice'", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?agentId=alice`);
    const msg = await new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });
    ws.close();
    const parsed = JSON.parse(msg);
    expect(parsed.agentId).toBe("alice");
  });

  it("backward-compat: no agentId param = same as before (main)", async () => {
    // This verifies existing personal Her connections are unaffected
    const clientsBefore = clients.filter((c) => c.agentId === "main").length;
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const msg = await new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });
    ws.close();
    const parsed = JSON.parse(msg);
    expect(parsed.agentId).toBe("main");
    const clientsAfter = clients.filter((c) => c.agentId === "main").length;
    expect(clientsAfter).toBe(clientsBefore + 1);
  });
});
