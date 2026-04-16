/**
 * Fill context to trigger auto-compaction on test instance (port 3460).
 * Uses the compact-test-send protocol but sends many rounds automatically.
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const GW_URL = process.env.GW_URL || "ws://127.0.0.1:3460/ws?auth=compaction-test-token";
const SESSION_KEY = `compaction-e2e-${Date.now()}`;
const TOTAL_ROUNDS = Number(process.env.TOTAL_ROUNDS || "10");
const ORIGIN = "http://localhost:3460";

let seqNo = 0;
let completedRounds = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const ws = new WebSocket(GW_URL, {
  maxPayload: 25 * 1024 * 1024,
  headers: { origin: ORIGIN },
});

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

// Long prompts to fill context fast
const PROMPTS = [
  "Write a detailed 3000-word essay about the history of artificial intelligence from 1950 to 2026, covering key milestones, breakthroughs, and setbacks.",
  "Explain quantum computing in extreme detail: qubits, superposition, entanglement, error correction, Shor's algorithm, Grover's algorithm, and current hardware approaches (superconducting, trapped ion, photonic, topological). Include mathematical formulations.",
  "Write a comprehensive technical analysis of modern CPU architectures covering x86, ARM, RISC-V, pipeline stages, branch prediction, out-of-order execution, cache hierarchy, memory controllers, and SIMD extensions. 3000 words minimum.",
  "Describe the complete history of programming languages from FORTRAN to Rust, covering paradigm shifts, type systems, memory management approaches, concurrency models, and the evolution of compilers. Very detailed, 3000 words.",
  "Write about machine learning optimization: SGD, Adam, RMSProp, learning rate schedules, batch normalization, dropout, weight decay, gradient clipping, mixed precision training. Include the mathematical derivations for each optimizer.",
  "Explain distributed systems: CAP theorem, Paxos, Raft, vector clocks, CRDTs, consistent hashing, gossip protocols, two-phase commit, saga pattern. Include pseudocode for each algorithm.",
  "Write about the history of the internet: ARPANET, TCP/IP, DNS, HTTP, HTML, CSS, JavaScript, REST, GraphQL, WebSocket, HTTP/3, QUIC. Technical details for each protocol.",
  "Explain operating system internals: process scheduling, virtual memory, page tables, TLB, file systems (ext4, btrfs, ZFS), I/O schedulers, system calls, interrupt handling, device drivers.",
  "Write about cryptography: symmetric (AES, ChaCha20), asymmetric (RSA, ECC, Ed25519), hash functions (SHA-256, BLAKE3), key exchange (DH, ECDH), TLS 1.3 handshake, post-quantum cryptography.",
  "Explain database internals: B-trees, LSM trees, WAL, MVCC, query optimization, cost-based planning, index types, join algorithms (nested loop, hash, merge), transaction isolation levels, deadlock detection.",
  "Write about neural network architectures in extreme detail: perceptrons, CNNs, RNNs, LSTMs, Transformers, attention mechanisms, positional encoding, layer normalization, residual connections, mixture of experts.",
  "Explain container orchestration: Docker internals (namespaces, cgroups, overlayfs), Kubernetes architecture (etcd, API server, scheduler, kubelet), service mesh (Istio, Linkerd), Helm charts, operators.",
  "Write about compiler design: lexical analysis, parsing (LL, LR, LALR), AST, semantic analysis, type checking, intermediate representation (SSA), optimization passes, register allocation, code generation.",
  "Explain the physics of semiconductors: band theory, PN junctions, MOSFETs, CMOS logic, Moore's law, lithography (EUV), 3D NAND, FinFET, GAA transistors, chiplet architecture.",
  "Write about signal processing: Fourier transform, FFT, convolution theorem, sampling theory, Nyquist, filters (FIR, IIR), wavelets, spectrograms, codec design (MP3, AAC, Opus).",
  "Explain modern web architecture: SPAs, SSR, SSG, ISR, edge computing, CDNs, service workers, Web Workers, WebAssembly, SharedArrayBuffer, Atomics, Streams API.",
  "Write about robotics: kinematics, dynamics, PID control, path planning (A*, RRT, D*), SLAM, sensor fusion, computer vision, force control, manipulation, locomotion.",
  "Explain network security: firewalls, IDS/IPS, VPN (IPSec, WireGuard), PKI, certificate authorities, OCSP, zero trust architecture, OAuth 2.0, OpenID Connect, SAML.",
  "Write about the mathematics of machine learning: linear algebra (eigenvalues, SVD, PCA), probability theory, information theory (entropy, KL divergence, mutual information), optimization theory (convexity, Lagrange multipliers, KKT conditions).",
  "Explain software architecture patterns: microservices, event-driven, CQRS, event sourcing, hexagonal architecture, clean architecture, domain-driven design, bounded contexts, aggregate roots, sagas.",
];

let waitingForCompletion = false;

ws.on("open", async () => {
  try {
    // Connect with control-ui client to get scopes
    const hello = await request("connect", {
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
    });
    console.log(`[connected] session=${SESSION_KEY}`);

    // Send first message
    await sendNextRound();
  } catch (e) {
    console.error(`[connect error] ${(e as Error).message}`);
    ws.close();
    process.exit(1);
  }
});

async function sendNextRound() {
  if (completedRounds >= TOTAL_ROUNDS) {
    console.log(`\n[ALL DONE] ${completedRounds} rounds completed. Check /status for compaction count.`);
    // Send a final test message to check memory
    await request("chat.send", {
      sessionKey: SESSION_KEY,
      message: "What was the first topic I asked you about? Please recall our conversation history.",
      idempotencyKey: randomUUID(),
    });
    waitingForCompletion = true;
    console.log(`[memory test sent] waiting...`);
    return;
  }

  const prompt = PROMPTS[completedRounds % PROMPTS.length];
  console.log(`\n=== Round ${completedRounds + 1}/${TOTAL_ROUNDS} ===`);
  console.log(`[sending] ${prompt.substring(0, 80)}...`);

  try {
    await request("chat.send", {
      sessionKey: SESSION_KEY,
      message: prompt,
      idempotencyKey: randomUUID(),
    });
    waitingForCompletion = true;
    console.log(`[sent] waiting for completion...`);
  } catch (e) {
    console.error(`[send error] ${(e as Error).message}`);
    // Try next round anyway
    completedRounds++;
    setTimeout(() => sendNextRound(), 2000);
  }
}

ws.on("message", (raw) => {
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
      console.log(`\n🎯 [COMPACTION EVENT] ${JSON.stringify(frame.payload.compaction)}`);
    }

    // Log status updates with token info
    if (frame.event === "chat" && frame.payload?.tokens) {
      const t = frame.payload.tokens;
      console.log(`  [tokens] used=${t.used}/${t.context} (${((t.used/t.context)*100).toFixed(1)}%)`);
    }

    // Wait for run completion — match by session state=final (no runId tracking)
    if (
      waitingForCompletion &&
      frame.event === "chat" &&
      (frame.payload?.state === "final" || frame.payload?.state === "done")
    ) {
      waitingForCompletion = false;
      completedRounds++;
      console.log(`[round ${completedRounds} done]`);

      if (completedRounds >= TOTAL_ROUNDS + 1) {
        // Memory test done
        console.log(`\n✅ All done including memory test.`);
        ws.close();
        process.exit(0);
      }

      // Small delay then send next
      setTimeout(() => sendNextRound(), 1000);
    }
  }
});

ws.on("error", (err) => {
  console.error(`[ws error] ${err.message}`);
  process.exit(1);
});

ws.on("close", () => {
  console.log(`[ws closed] completed ${completedRounds} rounds`);
  process.exit(0);
});

// 30 min timeout
setTimeout(() => {
  console.log(`[timeout] 1800s — completed ${completedRounds} rounds`);
  ws.close();
  process.exit(0);
}, 1800_000);
