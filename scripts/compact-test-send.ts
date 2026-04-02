import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const GW_URL = process.env.GW_URL || "ws://127.0.0.1:18789";
const GW_TOKEN = process.env.GW_TOKEN || "my-local-token-12345";
const GW_ORIGIN = process.env.GW_ORIGIN || "";
const SESSION_KEY = process.argv[2] || `test-compact-${Date.now()}`;
const MESSAGE = process.argv[3];

if (!MESSAGE) {
  console.error(
    "Usage: [GW_URL=... GW_TOKEN=...] npx tsx scripts/compact-test-send.ts <sessionKey> <message>",
  );
  process.exit(1);
}

const startTime = Date.now();
let expectedRunId: string | null = null;
let done = false;

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seqNo = 0;

const headers: Record<string, string> = {};
if (GW_ORIGIN) {
  headers.origin = GW_ORIGIN;
}

const ws = new WebSocket(GW_URL, { maxPayload: 25 * 1024 * 1024, headers });

function send(obj: unknown) {
  ws.send(JSON.stringify(obj));
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = String(++seqNo);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "req", id, method, params });
  });
}

ws.on("open", async () => {
  try {
    const hello = (await request("connect", {
      client: {
        id: "openclaw-control-ui",
        version: "dev",
        platform: "web",
        mode: "webchat",
      },
      auth: { token: GW_TOKEN },
      minProtocol: 3,
      maxProtocol: 3,
      scopes: ["operator.read", "operator.write"],
    })) as Record<string, unknown>;
    if (!hello) {
      throw new Error("empty hello response");
    }
    console.log(`[connected] session=${SESSION_KEY}`);

    const r = (await request("chat.send", {
      sessionKey: SESSION_KEY,
      message: MESSAGE,
      idempotencyKey: randomUUID(),
    })) as { runId?: string };
    expectedRunId = r?.runId || null;
    console.log(`[sent] runId=${expectedRunId}`);
  } catch (e) {
    console.error(`[error] ${(e as Error).message}`);
    ws.close();
    process.exit(1);
  }
});

ws.on("message", (raw) => {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : (raw as string);
  const frame = JSON.parse(text);
  if (frame.type === "res") {
    const p = pending.get(frame.id);
    if (p) {
      pending.delete(frame.id);
      if (frame.ok) {
        p.resolve(frame.payload ?? frame.result ?? {});
      } else {
        p.reject(new Error(frame.error?.message || "unknown error"));
      }
    }
  } else if (frame.type === "event") {
    if (
      !done &&
      expectedRunId &&
      frame.event === "chat" &&
      frame.payload?.state === "final" &&
      frame.payload?.runId === expectedRunId
    ) {
      done = true;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[done] ${elapsed}s`);
      ws.close();
      process.exit(0);
    }
  }
});

ws.on("error", (err) => {
  console.error(`[ws error] ${err.message}`);
  process.exit(1);
});

ws.on("close", () => {
  if (!done) {
    console.log("[ws closed]");
    process.exit(1);
  }
});

setTimeout(() => {
  if (!done) {
    console.log(`[timeout] 600s - check JSONL manually`);
    ws.close();
    process.exit(0);
  }
}, 600_000);
