/**
 * Fill context with mixed content types to trigger auto-compaction.
 * Phase 1: multi-content-type compaction stress test.
 * Uses port 3460 test instance.
 *
 * Key fix vs previous version: auto-reconnect on WS drop (compaction
 * mid-stream can close the socket; we reconnect and continue).
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const GW_URL = process.env.GW_URL || "ws://127.0.0.1:3460/ws?auth=compaction-test-token";
const SESSION_KEY = `compaction-mixed-${Date.now()}`;
const TOTAL_ROUNDS = 15;
const ORIGIN = "http://localhost:3460";
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECTS = 10;

let seqNo = 0;
let completedRounds = 0;
let reconnectCount = 0;
let ws: WebSocket | null = null;
let connected = false;
let waitingForCompletion = false;
let lastCompactionCount = 0;
const compactionEvents: Array<{ round: number; data: unknown }> = [];
const tokenSnapshots: Array<{ round: number; used: number; context: number; pct: string }> = [];
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// Generate a ~10K word fake document for round 3
function generateLargeDocument(): string {
  const sections = [
    "Executive Summary\n\nThis comprehensive technical report analyzes the current state of distributed computing infrastructure across enterprise environments. The findings presented herein are based on extensive benchmarking, real-world deployment data, and theoretical analysis of system architectures spanning multiple cloud providers and on-premise installations.",
    "1. Introduction to Distributed Systems Architecture\n\nDistributed computing has evolved significantly over the past two decades, transitioning from monolithic architectures to microservices, and now toward event-driven serverless paradigms. This section explores the fundamental principles governing distributed system design, including consistency models, partition tolerance, and availability guarantees as formalized by the CAP theorem and its modern interpretations.",
    "2. Performance Analysis Methodology\n\nOur benchmarking methodology employs a multi-layered approach combining synthetic workloads with production traffic replay. We utilize custom instrumentation at the kernel level (eBPF probes), application level (OpenTelemetry), and network level (packet capture with analysis). Statistical significance is ensured through repeated trials with confidence intervals reported at the 95th percentile.",
    "3. Network Topology and Latency Characteristics\n\nThe network fabric connecting distributed nodes plays a crucial role in overall system performance. We analyze three primary topologies: fat-tree (commonly used in data centers), mesh networks (prevalent in edge computing), and hybrid architectures that combine both approaches. Latency measurements across these topologies reveal significant variance based on geographic distribution, with tail latencies (p99) often exceeding median values by 10-50x.",
    "4. Storage Systems and Data Consistency\n\nModern distributed storage systems must balance between strong consistency and performance. We examine the trade-offs inherent in various approaches: linearizable stores (etcd, ZooKeeper), eventually consistent systems (Cassandra, DynamoDB), and hybrid models (CockroachDB, Spanner). Our analysis includes write amplification factors, read latency distributions, and recovery time objectives under various failure scenarios.",
    "5. Consensus Protocols Deep Dive\n\nConsensus remains the fundamental challenge in distributed systems. We provide detailed analysis of Raft (used in etcd, TiKV), Multi-Paxos (used in Spanner), and newer protocols like EPaxos and Tempo. Performance characteristics are compared across varying cluster sizes (3, 5, 7, 9 nodes) with different network conditions including packet loss rates of 0.01% to 5%.",
    "6. Container Orchestration Performance\n\nKubernetes has become the de facto standard for container orchestration, but its performance characteristics at scale are often misunderstood. We analyze scheduler latency, etcd performance degradation with cluster size, API server throughput under load, and the impact of custom resource definitions on overall cluster stability. Our tests span clusters from 10 to 5000 nodes.",
    "7. Service Mesh Overhead Analysis\n\nService meshes (Istio, Linkerd, Cilium) add observability and security at the cost of latency and resource consumption. We quantify this overhead across different deployment configurations. Sidecar proxy (Envoy) adds 1-3ms per hop in typical configurations, while eBPF-based approaches (Cilium) reduce this to sub-millisecond overhead. Memory consumption per pod increases by 50-150MB with sidecar injection.",
    "8. Message Queue Performance Comparison\n\nAsynchronous communication via message queues is essential for decoupled architectures. We benchmark Apache Kafka, Apache Pulsar, NATS JetStream, and RabbitMQ across multiple dimensions: throughput (messages/sec), latency (p50, p95, p99), durability guarantees, and resource efficiency. Kafka achieves the highest raw throughput (2M+ msg/sec) while NATS provides the lowest latency (sub-100us p99).",
    "9. Database Query Optimization in Distributed Environments\n\nQuery planning and execution in distributed databases involves unique challenges not present in single-node systems. We examine distributed join strategies, push-down predicate optimization, and the impact of data locality on query performance. Cross-shard queries can be 10-100x slower than local queries, making partition key selection critical for application performance.",
    "10. Observability and Monitoring at Scale\n\nEffective monitoring of distributed systems requires careful balance between data granularity and system overhead. We analyze the performance impact of various monitoring approaches: metrics collection (Prometheus), distributed tracing (Jaeger, Tempo), and log aggregation (Loki, Elasticsearch). At scale (>10K services), monitoring infrastructure itself can consume 5-15% of total cluster resources.",
    "11. Security Considerations\n\nDistributed systems expand the attack surface significantly. We discuss mTLS overhead, service identity management, secret rotation strategies, and network policy enforcement. Zero-trust architectures add measurable latency but provide essential security guarantees in multi-tenant environments.",
    "12. Cost Optimization Strategies\n\nCloud resource costs in distributed systems often follow non-linear scaling curves. We present strategies for right-sizing, spot instance utilization, auto-scaling policies, and cross-region arbitrage. Our analysis shows potential cost reductions of 30-60% through informed architecture decisions without sacrificing performance or reliability.",
    "13. Future Directions\n\nEmerging technologies including WebAssembly runtimes (Spin, Wasmtime), RDMA networking, CXL memory pooling, and AI-driven autoscaling represent the next frontier in distributed computing. We assess the maturity and potential impact of each technology on future system architectures.",
    "14. Conclusions and Recommendations\n\nBased on our comprehensive analysis, we recommend a tiered approach to distributed system design: (1) Start with the simplest architecture that meets requirements, (2) Instrument thoroughly before optimizing, (3) Prefer proven technologies with active communities, (4) Design for observability from day one, (5) Accept eventual consistency where possible to unlock performance gains.",
  ];

  let doc = "";
  for (let i = 0; i < 3; i++) {
    for (const section of sections) {
      doc += section + "\n\n";
    }
  }
  return doc;
}

const LARGE_DOC = generateLargeDocument();

const PROMPTS: string[] = [
  // Round 1-2: Long text output
  "Write a detailed 5000-word essay about the complete history of space exploration from Sputnik to Mars missions, covering every major milestone, the space race, Apollo program, Space Shuttle era, ISS construction, commercial spaceflight, and future plans for lunar and Mars colonization.",

  "Write a comprehensive 4000-word analysis of climate change solutions including renewable energy technologies (solar, wind, nuclear, hydrogen), carbon capture and storage, reforestation programs, policy frameworks (carbon tax, cap-and-trade), international agreements, and emerging technologies. Include specific data points and projections.",

  // Round 3: Large document input (~10K words)
  `Analyze the following document and provide a structured summary with key findings, critical insights, and actionable recommendations. Organize your response with clear headings.\n\n${LARGE_DOC}`,

  // Round 4: Large code output
  "Generate a complete React e-commerce application with the following files: App.tsx, ProductList.tsx, Cart.tsx, Checkout.tsx, api.ts, types.ts, styles.css, useCart.ts hook, AuthContext.tsx, and ProductDetail.tsx. Include full implementations with error handling, state management using React Context, responsive design with CSS modules, form validation, API integration with error boundaries, loading states, and TypeScript types throughout. Each file should be production-ready.",

  // Round 5-8: Short messages rapid fire
  "What is 2+2?",
  "Define entropy in one sentence.",
  "Who invented TCP/IP?",
  "Explain DNS in one sentence.",

  // Round 9: Code generation
  "Write a complete Python REST API using FastAPI with SQLAlchemy ORM, JWT authentication, CRUD operations for users and posts, middleware for logging and rate limiting, and comprehensive error handling. Include all imports, type hints, Pydantic models, database models, migration setup with Alembic, Docker configuration, and unit tests. The code should be production-ready with proper security practices.",

  // Round 10: Mixed Chinese-English
  "I need you to analyze the performance issues of this code and provide specific optimization suggestions. Focus on memory leaks and the impact of garbage collection. Please answer in a mix of Chinese and English, keeping technical terms in English. Code: function processLargeArray(arr) { return arr.map(item => ({ ...item, processed: true, timestamp: Date.now() })).filter(item => item.value > 0).reduce((acc, item) => { acc[item.id] = item; return acc; }, {}); } Also analyze the time complexity and space complexity of this function when processing millions of records, and how to optimize it through streaming or batch processing.",

  // Round 11-15: Sustained deep conversation
  "Based on everything we've discussed, what are the top 3 most impactful improvements for large-scale distributed systems? Consider both theoretical foundations and practical implementation challenges.",

  "Elaborate on the first improvement with specific implementation details and code examples. Include architecture diagrams described in text, configuration samples, and deployment strategies.",

  "Now compare this approach with event-driven architecture. Which is better for real-time systems handling millions of concurrent connections? Provide benchmarks, trade-off analysis, and migration strategies.",

  "Write a technical RFC document for implementing the solution you recommended. Include: motivation, design goals, non-goals, detailed design, alternatives considered, migration plan, rollback strategy, and success metrics.",

  "Summarize all our discussions today into a concise executive briefing. Include key decisions, recommendations, risk assessment, timeline estimates, and resource requirements. Format as a professional document suitable for C-level presentation.",
];

function getPromptType(round: number): string {
  if (round <= 1) return "long-text-output";
  if (round === 2) return "large-doc-input";
  if (round === 3) return "large-code-output";
  if (round >= 4 && round <= 7) return "short-rapid";
  if (round === 8) return "code-generation";
  if (round === 9) return "mixed-zh-en";
  return "sustained-conversation";
}

function createWs(): WebSocket {
  const socket = new WebSocket(GW_URL, {
    maxPayload: 25 * 1024 * 1024,
    headers: { origin: ORIGIN },
  });

  socket.on("open", async () => {
    try {
      connected = true;
      await doConnect(socket);
      // After (re)connect, resume sending
      if (!waitingForCompletion) {
        await sendNextRound();
      } else {
        // We were waiting for a completion that got lost — re-send current round
        console.log(`[reconnect] re-sending round ${completedRounds + 1} after WS drop`);
        waitingForCompletion = false;
        await sendNextRound();
      }
    } catch (e) {
      console.error(`[connect error] ${(e as Error).message}`);
      scheduleReconnect();
    }
  });

  socket.on("message", (raw) => {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : (raw as string);
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }

    if (frame.type === "res") {
      const p = pending.get(frame.id);
      if (p) {
        pending.delete(frame.id);
        if (!frame.error) {
          p.resolve(frame.result);
        } else {
          p.reject(new Error(frame.error?.message || JSON.stringify(frame.error)));
        }
      }
    } else if (frame.type === "event") {
      // Log compaction events
      if (frame.event === "session" && frame.payload?.compaction) {
        const c = frame.payload.compaction;
        compactionEvents.push({ round: completedRounds + 1, data: c });
        console.log(`\n>>> [COMPACTION EVENT @ round ${completedRounds + 1}] ${JSON.stringify(c)}`);
      }

      // Track compaction count from session updates
      if (frame.event === "session" && frame.payload?.compactionCount != null) {
        const newCount = frame.payload.compactionCount;
        if (newCount !== lastCompactionCount) {
          console.log(`\n>>> [COMPACTION COUNT] ${lastCompactionCount} -> ${newCount}`);
          lastCompactionCount = newCount;
        }
      }

      // Log token info
      if (frame.event === "chat" && frame.payload?.tokens) {
        const t = frame.payload.tokens;
        const pct = ((t.used / t.context) * 100).toFixed(1);
        tokenSnapshots.push({ round: completedRounds + 1, used: t.used, context: t.context, pct });
        console.log(`  [tokens] used=${t.used}/${t.context} (${pct}%)`);
      }

      // Log summary snippets
      if (frame.event === "session" && frame.payload?.summary) {
        const s = frame.payload.summary;
        console.log(`\n>>> [SUMMARY] (${s.length} chars) ${s.substring(0, 200)}...`);
      }

      // Detect completion (valid states: "final", "error", "aborted")
      if (
        waitingForCompletion &&
        frame.event === "chat" &&
        (frame.payload?.state === "final" || frame.payload?.state === "error" || frame.payload?.state === "aborted")
      ) {
        if (frame.payload?.state === "error") {
          console.log(`  [chat error] ${JSON.stringify(frame.payload?.error || "unknown")}`);
        }
        waitingForCompletion = false;
        completedRounds++;
        console.log(`[round ${completedRounds} done]`);

        if (completedRounds >= TOTAL_ROUNDS + 1) {
          // Memory test done
          console.log(`\n=== FINAL REPORT ===`);
          console.log(`Total rounds: ${completedRounds - 1}`);
          console.log(`Compaction events: ${compactionEvents.length}`);
          console.log(`Last compaction count: ${lastCompactionCount}`);
          cleanup();
          return;
        }

        setTimeout(() => sendNextRound(), 1000);
      }
    }
  });

  socket.on("error", (err) => {
    console.error(`[ws error] ${err.message}`);
  });

  socket.on("close", (code, reason) => {
    connected = false;
    console.log(`[ws closed] code=${code} reason=${reason?.toString() || "none"} completed=${completedRounds} rounds`);

    // Reject all pending requests so they don't hang
    for (const [id, p] of pending) {
      p.reject(new Error(`WS closed (code=${code})`));
    }
    pending.clear();

    if (completedRounds < TOTAL_ROUNDS) {
      scheduleReconnect();
    } else {
      printFinalSummary();
      process.exit(0);
    }
  });

  return socket;
}

function scheduleReconnect() {
  reconnectCount++;
  if (reconnectCount > MAX_RECONNECTS) {
    console.error(`[fatal] exceeded ${MAX_RECONNECTS} reconnection attempts — giving up`);
    printFinalSummary();
    process.exit(1);
  }
  const delay = RECONNECT_DELAY_MS * Math.min(reconnectCount, 5);
  console.log(`[reconnect] attempt ${reconnectCount}/${MAX_RECONNECTS} in ${delay}ms...`);
  setTimeout(() => {
    ws = createWs();
  }, delay);
}

async function doConnect(socket: WebSocket): Promise<void> {
  const id = String(++seqNo);
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: () => {
        console.log(`[connected] session=${SESSION_KEY} (reconnects=${reconnectCount})`);
        resolve();
      },
      reject,
    });
    socket.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          client: {
            id: "openclaw-control-ui",
            version: "dev",
            platform: "web",
            mode: "webchat",
          },
          auth: { token: "compaction-test-token" },
          minProtocol: 3,
          maxProtocol: 3,
          scopes: ["operator.read", "operator.write"],
        },
      }),
    );
  });
}

function send(obj: unknown) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("WS not connected");
  }
  ws.send(JSON.stringify(obj));
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = String(++seqNo);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      send({ type: "req", id, method, params });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

async function sendNextRound() {
  if (completedRounds >= TOTAL_ROUNDS) {
    console.log(`\n========================================`);
    console.log(`[ALL DONE] ${completedRounds} rounds completed.`);
    console.log(`[compaction events] ${compactionEvents.length} total:`);
    for (const evt of compactionEvents) {
      console.log(`  round ${evt.round}: ${JSON.stringify(evt.data)}`);
    }
    console.log(`[token snapshots]:`);
    for (const snap of tokenSnapshots) {
      console.log(`  round ${snap.round}: ${snap.used}/${snap.context} (${snap.pct}%)`);
    }
    console.log(`========================================`);

    // Memory test
    try {
      await request("chat.send", {
        sessionKey: SESSION_KEY,
        message: "What was the very first topic I asked you about? Please recall our conversation history briefly.",
        idempotencyKey: randomUUID(),
      });
      waitingForCompletion = true;
      console.log(`[memory test sent] waiting for final response...`);
    } catch (e) {
      console.error(`[memory test send error] ${(e as Error).message}`);
      printFinalSummary();
      cleanup();
    }
    return;
  }

  const prompt = PROMPTS[completedRounds];
  const promptType = getPromptType(completedRounds);
  console.log(`\n=== Round ${completedRounds + 1}/${TOTAL_ROUNDS} [${promptType}] ===`);
  console.log(`[sending] ${prompt.substring(0, 100)}${prompt.length > 100 ? "..." : ""}`);
  console.log(`[prompt length] ${prompt.length} chars (~${Math.round(prompt.length / 5)} words)`);

  try {
    await request("chat.send", {
      sessionKey: SESSION_KEY,
      message: prompt,
      idempotencyKey: randomUUID(),
    });
    waitingForCompletion = true;
    console.log(`[sent] waiting for completion...`);
  } catch (e) {
    console.error(`[send error] ${(e as Error).message} — will retry after reconnect`);
    // Don't increment completedRounds; reconnect handler will re-send
  }
}

function printFinalSummary() {
  console.log(`\n========================================`);
  console.log(`=== FINAL SUMMARY ===`);
  console.log(`Rounds completed: ${completedRounds}/${TOTAL_ROUNDS}`);
  console.log(`Compaction events: ${compactionEvents.length}`);
  console.log(`Last compaction count: ${lastCompactionCount}`);
  console.log(`WS reconnects: ${reconnectCount}`);
  console.log(`[compaction events]:`);
  for (const evt of compactionEvents) {
    console.log(`  round ${evt.round}: ${JSON.stringify(evt.data)}`);
  }
  console.log(`[token snapshots]:`);
  for (const snap of tokenSnapshots) {
    console.log(`  round ${snap.round}: ${snap.used}/${snap.context} (${snap.pct}%)`);
  }
  console.log(`========================================`);
}

function cleanup() {
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  process.exit(0);
}

// Start
console.log(`[config] TOTAL_ROUNDS=${TOTAL_ROUNDS}, prompts=${PROMPTS.length}`);
console.log(`[large doc] ~${Math.round(LARGE_DOC.length / 5)} words (${LARGE_DOC.length} chars)`);
console.log(`[session] ${SESSION_KEY}`);
ws = createWs();

// 45 min timeout for mixed content (longer responses)
setTimeout(() => {
  console.log(`[timeout] 2700s`);
  printFinalSummary();
  cleanup();
}, 2700_000);
