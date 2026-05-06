#!/usr/bin/env node
/**
 * smoke-test.mjs — plain-Node smoke test for the stop-hook-pipeline chain.
 *
 * Runs outside the OpenClaw vitest workspace (which excludes docker/**), so it's
 * the pre-deploy confidence check. Validates:
 *   1. patch-agent-loop.sh behavior (fresh/idempotent/skip/missing)
 *   2. StopHookPipeline module (register/evaluate/dead-loop counter)
 *   3. NoToolcallGuard module
 *   4. END-TO-END: apply patch to a real pi-agent-core copy, run faux provider
 *      through runAgentLoop, verify globalThis.__openclaw_stopHookPipeline drains
 *      and loop continues
 *
 * Run from repo root:   node docker/plugins/her-antitalker-poc/smoke-test.mjs
 * Or via tsx:           node_modules/.bin/tsx docker/plugins/her-antitalker-poc/smoke-test.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, symlinkSync, mkdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "../../..");
const PATCH = join(__dirname, "patch-agent-loop.sh");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
};

console.log("=== patch-agent-loop.sh ===");
{
  const d = mkdtempSync(join(tmpdir(), "plt-"));
  const f = join(d, "agent-loop.js");

  writeFileSync(f, `const followUpMessages = (await config.getFollowUpMessages?.()) || [];\n`);
  execSync(`bash ${PATCH}`, { env: { ...process.env, OPENCLAW_AGENT_LOOP_PATH: f } });
  check("fresh patch", readFileSync(f, "utf-8").includes("globalThis.__openclaw_stopHookPipeline"));

  const out2 = execSync(`bash ${PATCH} 2>&1`, { env: { ...process.env, OPENCLAW_AGENT_LOOP_PATH: f } }).toString();
  check("idempotent on re-run", out2.includes("already patched"));

  const f2 = join(d, "v2.js");
  const v2src = `const followUpMessages = (await config.someOtherName?.()) || [];\n`;
  writeFileSync(f2, v2src);
  const out3 = execSync(`bash ${PATCH} 2>&1`, { env: { ...process.env, OPENCLAW_AGENT_LOOP_PATH: f2 } }).toString();
  check("pattern mismatch skipped", out3.includes("expected pattern not found"));
  check("mismatch file unchanged", readFileSync(f2, "utf-8") === v2src);

  const out4 = execSync(`bash ${PATCH} 2>&1`, { env: { ...process.env, OPENCLAW_AGENT_LOOP_PATH: join(d, "none.js") } }).toString();
  check("missing target exits 0 clean", out4.includes("does not exist"));
  rmSync(d, { recursive: true, force: true });
}

console.log("\n=== StopHookPipeline ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { StopHookPipeline, createProseOnlyHook, createGetFollowUpMessages } = mod;

  const p = new StopHookPipeline();
  p.register("test", () => ({ shouldContinue: false }));
  check("register counted", p.hookCount === 1);

  p.register("prose", createProseOnlyHook(), 10);
  const proseRes = p.evaluate({
    sessionKey: "sk1",
    lastAssistantText: "我来帮你检查一下这个问题，让我先分析代码结构",
    lastAssistantHadToolCall: false,
    lastToolNames: [],
    turnIndex: 1,
  });
  check("prose-only fires on commitment text", proseRes.length === 1 && String(proseRes[0].content).includes("光说不练"));

  const p2 = new StopHookPipeline(2);
  p2.register("always", () => ({ shouldContinue: true, message: "keep" }));
  const ctx = { sessionKey: "s", lastAssistantText: "x", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1 };
  check("counter R1", p2.evaluate(ctx).length === 1);
  check("counter R2", p2.evaluate(ctx).length === 1);
  check("counter yields R3", p2.evaluate(ctx).length === 0);

  const drain = createGetFollowUpMessages(p, () => ({
    sessionKey: "sk2",
    lastAssistantText: "我来帮你检查一下这个问题，让我先分析代码结构",
    lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1,
  }));
  check("drain emits on violation", (await drain()).length === 1);
}

console.log("\n=== NoToolcallGuard ===");
{
  const mod = await import(`${__dirname}/no-toolcall-guard.ts`);
  const { NoToolcallGuard } = mod;
  const g = new NoToolcallGuard({ enabled: true, maxRetries: 2, message: "retry", substantialTools: new Set(["exec", "read"]) });
  check("blocks without substantial tool", (g.evaluate("s1", { toolNames: ["message"] }) ?? []).length === 1);
  check("passes with substantial tool", g.evaluate("s2", { toolNames: ["exec"] }) === null);
  g.evaluate("s3", { toolNames: ["message"] });
  g.evaluate("s3", { toolNames: ["message"] });
  check("yields after max retries", g.evaluate("s3", { toolNames: ["message"] }) === null);
}

console.log("\n=== E2E: patched agent-loop + globalThis pipeline ===");
{
  const PI = `${REPO}/node_modules/@mariozechner/pi-agent-core`;
  if (!existsSync(PI)) {
    console.log("  SKIP — pi-agent-core not in this checkout");
  } else {
    const d = mkdtempSync(join(tmpdir(), "pac-"));
    try {
      mkdirSync(join(d, "dist"), { recursive: true });
      execSync(`cp -r ${PI}/dist/. ${d}/dist/`);
      copyFileSync(`${PI}/package.json`, `${d}/package.json`);
      symlinkSync(`${REPO}/node_modules`, `${d}/node_modules`);
      const loopPath = join(d, "dist/agent-loop.js");
      execSync(`bash ${PATCH}`, { env: { ...process.env, OPENCLAW_AGENT_LOOP_PATH: loopPath } });
      check("e2e patch marker present", readFileSync(loopPath, "utf-8").includes("globalThis.__openclaw_stopHookPipeline"));

      const fauxMod = await import(`${REPO}/node_modules/@mariozechner/pi-ai/dist/providers/faux.js`);
      const loopMod = await import(loopPath);
      const faux = fauxMod.registerFauxProvider({ api: `e2e-${Math.random().toString(36).slice(2)}`, provider: "e2e", models: [{ id: "m1" }] });
      faux.setResponses([
        fauxMod.fauxAssistantMessage([fauxMod.fauxText("t1")], { stopReason: "stop" }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText("t2")], { stopReason: "stop" }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText("t3")], { stopReason: "stop" }),
      ]);

      let calls = 0;
      globalThis.__openclaw_stopHookPipeline = async () => {
        calls++;
        if (calls === 1) return [{ role: "user", content: [{ type: "text", text: "[pipeline] inject-1" }] }];
        if (calls === 2) return [{ role: "user", content: [{ type: "text", text: "[pipeline] inject-2" }] }];
        return [];
      };

      const finalMsgs = await loopMod.runAgentLoop(
        [{ role: "user", content: [{ type: "text", text: "go" }] }],
        { model: faux.getModel("m1"), tools: [], messages: [] },
        { model: faux.getModel("m1"), tools: [], convertToLlm: (m) => m },
        async () => {},
      );

      check("pipeline drain called 3 times", calls === 3, `calls=${calls}`);
      check("faux model called 3 times", faux.state.callCount === 3, `callCount=${faux.state.callCount}`);
      check("inject-1 reached final context", finalMsgs.some((m) => m.role === "user" && JSON.stringify(m.content).includes("inject-1")));

      // ---- Stricter case: config HAS getFollowUpMessages that returns empty. Our
      // patch wraps the original and falls through to globalThis when empty. This
      // simulates OpenClaw's Agent class (ships a followUpQueue.drain that's
      // always-empty for feishu sessions).
      const faux2 = fauxMod.registerFauxProvider({ api: `wrap-${Math.random().toString(36).slice(2)}`, provider: "wrap", models: [{ id: "m1" }] });
      faux2.setResponses([
        fauxMod.fauxAssistantMessage([fauxMod.fauxText("w1")], { stopReason: "stop" }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText("w2")], { stopReason: "stop" }),
      ]);
      let calls2 = 0;
      let origDrainCalled = 0;
      globalThis.__openclaw_stopHookPipeline = async () => {
        calls2++;
        if (calls2 === 1) return [{ role: "user", content: [{ type: "text", text: "[global-fallback] inject" }] }];
        return [];
      };
      const cfgWithEmptyDrain = {
        model: faux2.getModel("m1"),
        tools: [],
        convertToLlm: (m) => m,
        // This mimics Agent.createLoopConfig() — always-empty getFollowUpMessages
        getFollowUpMessages: async () => { origDrainCalled++; return []; },
      };
      const finalMsgs2 = await loopMod.runAgentLoop(
        [{ role: "user", content: [{ type: "text", text: "go" }] }],
        { model: faux2.getModel("m1"), tools: [], messages: [] },
        cfgWithEmptyDrain,
        async () => {},
      );
      check("wrap: original empty drain still invoked", origDrainCalled >= 1, `origDrainCalled=${origDrainCalled}`);
      check("wrap: globalThis fallback called after empty drain", calls2 >= 1, `calls2=${calls2}`);
      check("wrap: loop extended beyond first turn", faux2.state.callCount === 2, `callCount=${faux2.state.callCount}`);
      check("wrap: inject message reached final context", finalMsgs2.some((m) => m.role === "user" && JSON.stringify(m.content).includes("global-fallback")));
    } finally {
      delete globalThis.__openclaw_stopHookPipeline;
      rmSync(d, { recursive: true, force: true });
    }
  }
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
