import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveCandidateHomes(): string[] {
  const homes: string[] = [];
  if (process.env.OPENCLAW_REAL_HOME) homes.push(process.env.OPENCLAW_REAL_HOME);
  const user = process.env.USER;
  if (user) homes.push(path.join("/Users", user));

  const cwd = process.cwd();
  const idx = cwd.indexOf("/Users/");
  if (idx >= 0) {
    const rest = cwd.slice(idx + "/Users/".length);
    const name = rest.split("/")[0];
    if (name) homes.push(path.join("/Users", name));
  }

  homes.push(os.homedir());
  return [...new Set(homes.filter(Boolean))];
}

function resolveAdcPath(): string | null {
  for (const home of resolveCandidateHomes()) {
    const p = path.join(home, ".config", "gcloud", "application_default_credentials.json");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function waitForPortOpen(url: string, timeoutMs: number) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        const done = (err?: Error) => {
          ws.removeAllListeners();
          try {
            ws.close();
          } catch {}
          if (err) reject(err);
          else resolve();
        };
        ws.once("open", () => done());
        ws.once("error", (e) => done(e as Error));
      });
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url} to open`);
      await sleep(150);
    }
  }
}

type ServerEvent = {
  raw: unknown;
  turnCompleteReason?: string;
  hasAudio?: boolean;
  outputText?: string | null;
  outputFinished?: boolean;
};

function extractServerEvent(obj: any): ServerEvent {
  const sc = obj?.serverContent;
  if (!sc) return { raw: obj };
  const out: ServerEvent = { raw: obj };
  if (sc.turnCompleteReason) out.turnCompleteReason = sc.turnCompleteReason;
  const parts = sc.modelTurn?.parts;
  if (Array.isArray(parts) && parts[0]?.inlineData?.mimeType === "audio/pcm") out.hasAudio = true;
  const ot = sc.outputTranscription;
  if (ot && typeof ot === "object") {
    out.outputText = typeof ot.text === "string" ? ot.text : null;
    out.outputFinished = ot.finished === true;
  }
  return out;
}

describe("Gemini proxy contract (hits Google)", () => {
  const shouldRun = process.env.OPENCLAW_GEMINI_CONTRACT === "1";
  const wsUrl = "ws://localhost:8080";
  const proxyCwd = path.join(process.cwd(), "extensions/realtime/live-frontend");

  const projectId = process.env.GEMINI_PROJECT_ID || "gen-lang-client-0519229117";
  const model = process.env.GEMINI_MODEL || "gemini-live-2.5-flash-native-audio";
  const serviceUrl =
    "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent";

  let proc: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    if (!shouldRun) return;

    const adcPath = resolveAdcPath();
    if (!adcPath) {
      throw new Error(
        `Missing ADC credentials. Expected at ~/.config/gcloud/application_default_credentials.json (real HOME). Run: gcloud auth application-default login`,
      );
    }

    const depCheck = spawn("python3", ["-c", "import websockets, aiohttp, google.auth"], {
      cwd: proxyCwd,
      stdio: "ignore",
    });
    const depOk = await new Promise<boolean>((resolve) => {
      depCheck.once("exit", (code) => resolve(code === 0));
    });
    if (!depOk) {
      const pip = spawn("pip3", ["install", "-r", "requirements.txt"], {
        cwd: proxyCwd,
        stdio: "inherit",
      });
      const pipOk = await new Promise<boolean>((resolve) => {
        pip.once("exit", (code) => resolve(code === 0));
      });
      if (!pipOk) throw new Error("Failed to install python requirements for Gemini proxy");
    }

    proc = spawn("python3", ["server.py"], {
      cwd: proxyCwd,
      stdio: "pipe",
      env: { ...process.env, LIVE_GEMINI_LOG: "0" },
    });

    await waitForPortOpen(wsUrl, 20_000);
  }, 60_000);

  afterAll(() => {
    if (proc && !proc.killed) proc.kill("SIGTERM");
  });

  async function openWs() {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(e));
    });
    return ws;
  }

  function sendSetup(ws: WebSocket, opts?: { declareTool?: boolean }) {
    ws.send(JSON.stringify({ service_url: serviceUrl }));
    ws.send(
      JSON.stringify({
        setup: {
          model: `projects/${projectId}/locations/us-central1/publishers/google/models/${model}`,
          generation_config: {
            response_modalities: ["AUDIO"],
            temperature: 0,
            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Puck" } } },
            enable_affective_dialog: false,
          },
          system_instruction: {
            parts: [
              {
                text:
                  "You are a voice assistant. Reply briefly. If you see internal control lines, do not repeat them.",
              },
            ],
          },
          ...(opts?.declareTool
            ? {
                tools: {
                  function_declarations: [
                    {
                      name: "openclaw_help",
                      description: "helper tool",
                      parameters: {
                        type: "object",
                        properties: { request: { type: "string" } },
                        required: ["request"],
                      },
                    },
                  ],
                },
              }
            : {}),
        },
      }),
    );
  }

  function extractSetupFromLiveLog(connId: string) {
    const logPath = path.join(process.cwd(), "logs", "live-gemini-input.md");
    const text = fs.readFileSync(logPath, "utf8");

    const connMarker = `- conn: ${connId}`;
    const kindMarker = `- kind: setup`;
    const idxConn = text.indexOf(connMarker);
    if (idxConn < 0) throw new Error(`conn not found in ${logPath}: ${connId}`);

    const idxKind = text.indexOf(kindMarker, idxConn);
    if (idxKind < 0) throw new Error(`setup kind not found after conn: ${connId}`);

    const fence = "```json";
    const idxFenceStart = text.indexOf(fence, idxKind);
    if (idxFenceStart < 0) throw new Error(`json fence not found for setup: ${connId}`);
    const idxJsonStart = idxFenceStart + fence.length;
    const idxFenceEnd = text.indexOf("```", idxJsonStart);
    if (idxFenceEnd < 0) throw new Error(`json fence end not found for setup: ${connId}`);

    const rawJson = text.slice(idxJsonStart, idxFenceEnd).trim();
    const parsed = JSON.parse(rawJson) as { setup?: unknown };
    if (!parsed || typeof parsed !== "object" || !("setup" in parsed)) {
      throw new Error(`invalid setup json extracted for ${connId}`);
    }
    return parsed;
  }

  async function collectOnce(params: {
    ws: WebSocket;
    events: ServerEvent[];
    timeoutMs: number;
  }) {
    const { events, timeoutMs } = params;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const reason = events.find((e) => typeof e.turnCompleteReason === "string")?.turnCompleteReason;
      const hasAudio = events.some((e) => e.hasAudio);
      const hasText = events.some((e) => typeof e.outputText === "string" && e.outputText);
      const outputFinished = events.some((e) => e.outputFinished === true);
      if (reason || hasAudio || hasText || outputFinished) break;
      await sleep(50);
    }
  }

  async function waitForAny(events: ServerEvent[], pred: (e: ServerEvent) => boolean, timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (events.some(pred)) return true;
      await sleep(50);
    }
    return false;
  }

  it.runIf(shouldRun)("baseline: proxy+Gemini reachable", async () => {
    const ws = await openWs();
    const events: ServerEvent[] = [];
    ws.on("message", (buf) => {
      try {
        events.push(extractServerEvent(JSON.parse(buf.toString())));
      } catch {}
    });
    sendSetup(ws);
    ws.send(
      JSON.stringify({
        client_content: { turns: [{ role: "user", parts: [{ text: "hello" }] }], turn_complete: true },
      }),
    );
    const ok = await waitForAny(events, (e) => e.hasAudio || typeof e.outputText === "string", 15_000);
    ws.close();
    expect(ok).toBe(true);
  }, 60_000);

  it.runIf(shouldRun)("strategy A: model-inject + user control line (current production pattern) produces some response", async () => {
    const ws = await openWs();
    const events: ServerEvent[] = [];
    ws.on("message", (buf) => {
      try {
        events.push(extractServerEvent(JSON.parse(buf.toString())));
      } catch {}
    });
    sendSetup(ws);
    ws.send(
      JSON.stringify({
        client_content: {
          turns: [{ role: "model", parts: [{ text: "Shanghai is cloudy today. 14°C." }] }],
          turn_complete: true,
        },
      }),
    );
    ws.send(
      JSON.stringify({
        client_content: {
          turns: [
            { role: "user", parts: [{ text: "以上信息来自 backend ai，请你根据实际情况回复用户信息！" }] },
          ],
          turn_complete: true,
        },
      }),
    );

    const ok = await waitForAny(events, (e) => e.hasAudio || typeof e.turnCompleteReason === "string", 20_000);
    ws.close();
    expect(ok).toBe(true);
  }, 60_000);

  it.runIf(shouldRun)(
    "strategy B: measure control-line reject rate (stats)",
    async () => {
    const candidates = [
      // Current production control line (known to sometimes trigger RESPONSE_REJECTED in prod logs).
      "以上信息来自 backend ai，请你根据实际情况回复用户信息！",
      // Variants that keep intent but reduce "command-y" / "internal system" vibes.
      "以上信息来自 backend ai。请基于以上信息回复用户。",
      "请基于以上信息回复用户。",
      "请根据以上信息回答。",
    ];

    // Try each candidate multiple times and print stats.
    // This is an automated, Google-backed check (no manual browser/e2e).
    const trialsPerCandidate = Number.parseInt(process.env.OPENCLAW_GEMINI_TRIALS ?? "5", 10);
    const outcomes: Array<{ line: string; trial: number; reason?: string; hadAudio?: boolean }> = [];

    for (const line of candidates) {
      for (let t = 1; t <= trialsPerCandidate; t++) {
        const ws = await openWs();
        const events: ServerEvent[] = [];
        ws.on("message", (buf) => {
          try {
            events.push(extractServerEvent(JSON.parse(buf.toString())));
          } catch {}
        });

        sendSetup(ws);
        ws.send(
          JSON.stringify({
            client_content: {
              turns: [{ role: "model", parts: [{ text: "Shanghai is cloudy today. 14°C." }] }],
              turn_complete: true,
            },
          }),
        );
        ws.send(
          JSON.stringify({
            client_content: { turns: [{ role: "user", parts: [{ text: line }] }], turn_complete: true },
          }),
        );

        await waitForAny(events, (e) => e.hasAudio || typeof e.turnCompleteReason === "string", 15_000);
        const reason = events.find((e) => typeof e.turnCompleteReason === "string")?.turnCompleteReason;
        const hadAudio = events.some((e) => e.hasAudio);
        outcomes.push({ line, trial: t, reason, hadAudio });

        ws.close();

      }
    }

    expect(outcomes.length).toBeGreaterThan(0);

    // Aggregate + print stats.
    const byLine = new Map<
      string,
      { trials: number; rejected: number; hadAudio: number; reasons: Record<string, number> }
    >();
    for (const o of outcomes) {
      const row =
        byLine.get(o.line) ??
        { trials: 0, rejected: 0, hadAudio: 0, reasons: Object.create(null) as Record<string, number> };
      row.trials += 1;
      if (o.reason === "RESPONSE_REJECTED") row.rejected += 1;
      if (o.hadAudio) row.hadAudio += 1;
      const key = o.reason ?? "(none)";
      row.reasons[key] = (row.reasons[key] ?? 0) + 1;
      byLine.set(o.line, row);
    }

    const summary = [...byLine.entries()].map(([line, s]) => ({
      line,
      trials: s.trials,
      rejected: s.rejected,
      rejectedRate: s.trials ? s.rejected / s.trials : 0,
      hadAudio: s.hadAudio,
      audioRate: s.trials ? s.hadAudio / s.trials : 0,
      reasons: s.reasons,
    }));

    summary.sort((a, b) => a.rejectedRate - b.rejectedRate || b.audioRate - a.audioRate);

    // eslint-disable-next-line no-console
    console.log("[contract] control_line_stats:", JSON.stringify(summary, null, 2));

    // Hard assertion: at least one candidate should NOT be rejected in all trials.
    expect(summary.some((s) => s.rejected < s.trials)).toBe(true);
    },
    240_000,
  );

  it.runIf(shouldRun)(
    "replay prod conn-1770279677030 setup + (name inject + control line) once",
    async () => {
      const connId = "conn-1770279677030";

      const ws = await openWs();
      const events: ServerEvent[] = [];
      ws.on("message", (buf) => {
        try {
          events.push(extractServerEvent(JSON.parse(buf.toString())));
        } catch {}
      });

      // Use the exact setup captured in prod logs.
      const prodSetup = extractSetupFromLiveLog(connId);
      ws.send(JSON.stringify({ service_url: serviceUrl }));
      ws.send(JSON.stringify(prodSetup));

      // Replay the exact pair that preceded RESPONSE_REJECTED in prod logs.
      const modelMaterial = "天哥，您的名字是天哥。我已经记得您了。";
      const controlLine = "以上信息来自 backend ai，请你根据实际情况回复用户信息！";
      ws.send(
        JSON.stringify({
          client_content: {
            turns: [{ role: "model", parts: [{ text: modelMaterial }] }],
            turn_complete: true,
          },
        }),
      );
      ws.send(
        JSON.stringify({
          client_content: {
            turns: [{ role: "user", parts: [{ text: controlLine }] }],
            turn_complete: true,
          },
        }),
      );

      await collectOnce({ ws, events, timeoutMs: 15_000 });

      const reason = events.find((e) => typeof e.turnCompleteReason === "string")?.turnCompleteReason;
      const hadAudio = events.some((e) => e.hasAudio);
      const outputFinished = events.some((e) => e.outputFinished === true);
      const sampleText = events.find((e) => typeof e.outputText === "string" && e.outputText)?.outputText ?? null;

      // eslint-disable-next-line no-console
      console.log(
        "[replay_once]",
        JSON.stringify(
          {
            connId,
            reason: reason ?? null,
            hadAudio,
            outputFinished,
            sampleText,
          },
          null,
          2,
        ),
      );

      ws.close();

      // We must at least see some signal (audio, output finished, or reason).
      expect(hadAudio || outputFinished || typeof reason === "string").toBe(true);
    },
    90_000,
  );

  // Generate fake 16-bit PCM audio chunk (simulating user speaking)
  // Gemini Live expects: 16kHz, 16-bit signed LE, mono
  function generateFakeAudioChunk(durationMs: number): string {
    const sampleRate = 16000;
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    const buffer = Buffer.alloc(numSamples * 2); // 16-bit = 2 bytes per sample

    // Generate low-volume noise (simulating mic background noise or speech-like signal)
    for (let i = 0; i < numSamples; i++) {
      // Random noise in range [-3000, 3000] to simulate speech-like activity
      const sample = Math.floor((Math.random() - 0.5) * 6000);
      buffer.writeInt16LE(sample, i * 2);
    }

    return buffer.toString("base64");
  }

  function sendAudioChunk(ws: WebSocket, base64Pcm: string) {
    ws.send(
      JSON.stringify({
        realtime_input: {
          media_chunks: [{ mime_type: "audio/pcm", data: base64Pcm }],
        },
      }),
    );
  }

  it.runIf(shouldRun)(
    "WITH AUDIO: inject during simulated user speech (should trigger RESPONSE_REJECTED)",
    async () => {
      const connId = "conn-1770279677030";

      const ws = await openWs();
      const events: ServerEvent[] = [];
      ws.on("message", (buf) => {
        try {
          const parsed = JSON.parse(buf.toString());
          const ev = extractServerEvent(parsed);
          events.push(ev);
          // Debug: log turnCompleteReason immediately when received
          if (ev.turnCompleteReason) {
            // eslint-disable-next-line no-console
            console.log("[DEBUG] turnCompleteReason received:", ev.turnCompleteReason);
          }
        } catch {}
      });

      // Use the exact setup captured in prod logs, but DISABLE automatic activity detection
      // so we can manually signal activity start/end
      const prodSetup = extractSetupFromLiveLog(connId) as { setup: Record<string, unknown> };
      prodSetup.setup.realtime_input_config = {
        automatic_activity_detection: { disabled: true },
        activity_handling: "START_OF_ACTIVITY_INTERRUPTS",
      };
      ws.send(JSON.stringify({ service_url: serviceUrl }));
      ws.send(JSON.stringify(prodSetup));

      // Wait for setup to be processed
      await sleep(500);

      // Manually signal: user activity START (user is speaking)
      ws.send(JSON.stringify({ realtime_input: { activity_start: {} } }));

      // Send some audio while activity is marked as started
      for (let i = 0; i < 5; i++) {
        sendAudioChunk(ws, generateFakeAudioChunk(100));
        await sleep(100);
      }

      // Test: only send role=model inject (no control line), see if proactiveAudio rejects it
      // because it's not a real user request
      const modelMaterial = "天哥，您的名字是天哥。我已经记得您了。";

      ws.send(
        JSON.stringify({
          client_content: {
            turns: [{ role: "model", parts: [{ text: modelMaterial }] }],
            turn_complete: true,
          },
        }),
      );

      // Signal: user activity END
      ws.send(JSON.stringify({ realtime_input: { activity_end: {} } }));

      // Wait for response
      await waitForAny(events, (e) => typeof e.turnCompleteReason === "string" || e.hasAudio, 30_000);

      const reason = events.find((e) => typeof e.turnCompleteReason === "string")?.turnCompleteReason;
      const hadAudio = events.some((e) => e.hasAudio);
      const outputFinished = events.some((e) => e.outputFinished === true);
      const allText = events
        .filter((e) => typeof e.outputText === "string" && e.outputText)
        .map((e) => e.outputText)
        .join("");
      const rejected = reason === "RESPONSE_REJECTED";

      // eslint-disable-next-line no-console
      console.log(
        "[WITH_AUDIO_inject]",
        JSON.stringify(
          {
            connId,
            rejected,
            reason: reason ?? null,
            hadAudio,
            outputFinished,
            allText: allText || null,
          },
          null,
          2,
        ),
      );

      ws.close();

      // Log result - we expect either rejection, audio, or at least some output
      expect(typeof reason === "string" || hadAudio || allText.length > 0).toBe(true);
    },
    90_000,
  );

  it.runIf(shouldRun)(
    "WITH AUDIO: stats - run multiple times to measure reject rate with audio",
    async () => {
      const connId = "conn-1770279677030";
      const trials = Number.parseInt(process.env.OPENCLAW_GEMINI_TRIALS ?? "10", 10);

      const results: Array<{
        trial: number;
        rejected: boolean;
        reason?: string;
        hadAudio: boolean;
      }> = [];

      for (let t = 1; t <= trials; t++) {
        const ws = await openWs();
        const events: ServerEvent[] = [];
        ws.on("message", (buf) => {
          try {
            events.push(extractServerEvent(JSON.parse(buf.toString())));
          } catch {}
        });

        // Use same config as single test: disable auto activity detection
        const prodSetup = extractSetupFromLiveLog(connId) as { setup: Record<string, unknown> };
        prodSetup.setup.realtime_input_config = {
          automatic_activity_detection: { disabled: true },
          activity_handling: "START_OF_ACTIVITY_INTERRUPTS",
        };
        ws.send(JSON.stringify({ service_url: serviceUrl }));
        ws.send(JSON.stringify(prodSetup));

        await sleep(500);

        // Manual activity start
        ws.send(JSON.stringify({ realtime_input: { activity_start: {} } }));

        // Send audio while activity is started
        for (let i = 0; i < 5; i++) {
          sendAudioChunk(ws, generateFakeAudioChunk(100));
          await sleep(100);
        }

        // Inject during activity (role=model only, no control line)
        ws.send(
          JSON.stringify({
            client_content: {
              turns: [{ role: "model", parts: [{ text: "天哥，您的名字是天哥。我已经记得您了。" }] }],
              turn_complete: true,
            },
          }),
        );

        // Manual activity end
        ws.send(JSON.stringify({ realtime_input: { activity_end: {} } }));

        // Wait for response
        await waitForAny(events, (e) => typeof e.turnCompleteReason === "string" || e.hasAudio, 30_000);

        const reason = events.find((e) => typeof e.turnCompleteReason === "string")?.turnCompleteReason;
        const hadAudio = events.some((e) => e.hasAudio);
        const allText = events
          .filter((e) => typeof e.outputText === "string" && e.outputText)
          .map((e) => e.outputText)
          .join("");

        results.push({
          trial: t,
          rejected: reason === "RESPONSE_REJECTED",
          reason: reason ?? undefined,
          hadAudio,
        });

        // eslint-disable-next-line no-console
        console.log(`[stats] ${t}/${trials}: ${reason === "RESPONSE_REJECTED" ? "REJECTED" : "ok"} audio=${hadAudio} text=${allText.slice(0, 20) || "-"}`);

        ws.close();
        await sleep(200);
      }

      const rejectedCount = results.filter((r) => r.rejected).length;
      const audioCount = results.filter((r) => r.hadAudio).length;

      // eslint-disable-next-line no-console
      console.log(
        "\n[SUMMARY]",
        JSON.stringify({
          trials,
          rejected: rejectedCount,
          rejectedRate: `${(100 * rejectedCount / trials).toFixed(1)}%`,
          hadAudio: audioCount,
        }),
      );

      expect(results.length).toBe(trials);
    },
    300_000,
  );
});

