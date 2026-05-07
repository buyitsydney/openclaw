#!/usr/bin/env node
/**
 * smoke-test.mjs — plain-Node smoke for the stop-hook-pipeline rule engine.
 *
 * Runs outside OpenClaw's vitest workspace (docker/** is excluded), so this is
 * the pre-deploy confidence check. Validates:
 *   1. patch-agent-loop.sh (fresh/idempotent/skip/missing + backup)
 *   2. StopHookPipeline framework (register/evaluate/dead-loop counter)
 *   3. createRuleHook rule engine semantics
 *      - preconditions (short user msg, regex matches, skip)
 *      - fire_when (no_tool_call, no_substantial_tool, text_matches_any)
 *      - priority ordering
 *   4. loadStopHookRules + installRules (YAML → hooks)
 *   5. YAML hot-reload via watchRulesFile
 *   6. END-TO-END: apply patch to real pi-agent-core, register globalThis drain,
 *      run faux provider, verify same-turn continuation works
 *
 * Run:  node docker/plugins/her-antitalker-poc/smoke-test.mjs
 *   or: node_modules/.bin/tsx docker/plugins/her-antitalker-poc/smoke-test.mjs
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

console.log("\n=== StopHookPipeline framework ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { StopHookPipeline, createRuleHook } = mod;

  const p = new StopHookPipeline();
  p.register("test", () => ({ shouldContinue: false }));
  check("register counted", p.hookCount === 1);

  // Dead loop protection: max_continuation_turns
  const p2 = new StopHookPipeline(2);
  p2.register("always", () => ({ shouldContinue: true, message: "keep" }));
  const ctx = { sessionKey: "s", lastAssistantText: "x", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1 };
  check("counter R1", p2.evaluate(ctx).length === 1);
  check("counter R2", p2.evaluate(ctx).length === 1);
  check("counter yields R3 (saturates)", p2.evaluate(ctx).length === 0);

  // Priority ordering: higher priority rule fires first
  const p3 = new StopHookPipeline();
  let firedFirst = "";
  p3.register("low", (c) => { firedFirst = firedFirst || "low"; return { shouldContinue: true, message: "low-fires" }; }, 1);
  p3.register("high", (c) => { firedFirst = firedFirst || "high"; return { shouldContinue: true, message: "high-fires" }; }, 10);
  const resP = p3.evaluate(ctx);
  check("higher priority wins", resP[0]?.content === "high-fires" && firedFirst === "high");

  // unregisterAll for hot reload
  p3.unregisterAll();
  check("unregisterAll clears hooks", p3.hookCount === 0);
}

console.log("\n=== createRuleHook rule engine semantics ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { createRuleHook } = mod;

  // no_substantial_tool rule with min_user_message_length precondition
  const noToolRule = createRuleHook({
    id: "ntg",
    enabled: true,
    priority: 20,
    preconditions: { min_user_message_length: 10 },
    fire_when: { no_substantial_tool: true },
    substantial_tools: ["exec", "read"],
    message: "fire",
  });

  check("short user msg -> precondition blocks",
    noToolRule({ sessionKey: "s", lastAssistantText: "a", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: "hi" }).shouldContinue === false);

  check("long user + has exec -> substantial -> don't fire",
    noToolRule({ sessionKey: "s", lastAssistantText: "a", lastAssistantHadToolCall: true, lastToolNames: ["exec"], turnIndex: 1, lastUserText: "帮我修登录页的 bug" }).shouldContinue === false);

  check("long user + only message_send -> no substantial -> FIRE",
    noToolRule({ sessionKey: "s", lastAssistantText: "a", lastAssistantHadToolCall: true, lastToolNames: ["message_send"], turnIndex: 1, lastUserText: "帮我修登录页的 bug" }).shouldContinue === true);

  // text_matches_any + no_tool_call (prose rule)
  const proseRule = createRuleHook({
    id: "pr",
    enabled: true,
    priority: 10,
    preconditions: { min_assistant_text_length: 20 },
    fire_when: { no_tool_call: true, text_matches_any: ["我来", "让我", "\\bI'?ll\\b"] },
    message: "prose",
  });

  check("prose with commitment + no tool -> FIRE",
    proseRule({ sessionKey: "s", lastAssistantText: "我来帮你检查一下这个问题,让我先分析一下代码", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: "xxx" }).shouldContinue === true);

  check("prose short text (<20) -> precondition blocks",
    proseRule({ sessionKey: "s", lastAssistantText: "我来", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: "xxx" }).shouldContinue === false);

  check("prose without commitment word -> don't fire",
    proseRule({ sessionKey: "s", lastAssistantText: "今天天气很好我们出去玩吧顺便买个菜", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: "xxx" }).shouldContinue === false);

  // assistant_text_skip_if_matches_any precondition
  const heartbeatAwareRule = createRuleHook({
    id: "hb",
    enabled: true,
    priority: 5,
    preconditions: { assistant_text_skip_if_matches_any: ["^HEARTBEAT_OK", "^NO_REPLY"] },
    fire_when: { no_tool_call: true },
    message: "fire",
  });

  check("HEARTBEAT_OK skipped by assistant_text_skip_if_matches_any",
    heartbeatAwareRule({ sessionKey: "s", lastAssistantText: "HEARTBEAT_OK", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: "ping" }).shouldContinue === false);

  // enabled:false returns null (no hook at all)
  const disabledRule = createRuleHook({
    id: "disabled", enabled: false, priority: 1,
    fire_when: { no_tool_call: true }, message: "x",
  });
  check("disabled rule returns null hook", disabledRule === null);
}

console.log("\n=== loadStopHookRules + installRules ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { loadStopHookRules, installRules, StopHookPipeline } = mod;

  // Write a minimal YAML and load it (fallback parser is fine for simple YAML)
  const tmp = mkdtempSync(join(tmpdir(), "shy-"));
  const yamlPath = join(tmp, "rules.yaml");
  writeFileSync(yamlPath, `
enabled: true
max_continuation_turns: 2

rules:
  - id: rule-a
    enabled: true
    priority: 20
    fire_when:
      no_tool_call: true
    message: fire-a
  - id: rule-b
    enabled: false
    priority: 10
    fire_when:
      no_tool_call: true
    message: fire-b
`.trim());

  const loaded = loadStopHookRules(yamlPath);
  check("YAML loaded: enabled flag", loaded.enabled === true);
  check("YAML loaded: max_continuation_turns", loaded.max_continuation_turns === 2);
  check("YAML loaded: rules count", loaded.rules.length === 2);

  const p = new StopHookPipeline();
  const res = installRules(p, loaded);
  check("installRules installed enabled rules only", res.installed.length === 1 && res.installed[0] === "rule-a");
  check("installRules skipped disabled rule", res.skipped.includes("rule-b"));
  check("pipeline has 1 active hook", p.hookCount === 1);

  // enabled=false kills everything
  const killed = { ...loaded, enabled: false };
  const p2 = new StopHookPipeline();
  const res2 = installRules(p2, killed);
  check("enabled=false → zero installed hooks", res2.installed.length === 0);
  check("enabled=false → all rules marked skipped", res2.skipped.length === 2);

  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== YAML hot-reload (watchRulesFile) ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { watchRulesFile } = mod;

  const tmp = mkdtempSync(join(tmpdir(), "sww-"));
  const yamlPath = join(tmp, "rules.yaml");
  writeFileSync(yamlPath, `enabled: true\nrules: []\n`);

  let callCount = 0;
  let lastSnapshot = null;
  const stop = watchRulesFile(yamlPath, (file) => { callCount++; lastSnapshot = file; }, 100);

  // Wait for the first tick
  await new Promise(r => setTimeout(r, 200));
  check("watcher fires on initial load", callCount >= 1);

  // Modify file
  writeFileSync(yamlPath, `enabled: false\nrules: []\n`);
  await new Promise(r => setTimeout(r, 300));
  check("watcher re-fires after mtime change", callCount >= 2);
  check("watcher reflects new content (enabled=false)", lastSnapshot?.enabled === false);

  stop();
  rmSync(tmp, { recursive: true, force: true });
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

      // Wrap path: config already has getFollowUpMessages (empty) — global fallback still fires
      const faux2 = fauxMod.registerFauxProvider({ api: `wrap-${Math.random().toString(36).slice(2)}`, provider: "wrap", models: [{ id: "m1" }] });
      faux2.setResponses([
        fauxMod.fauxAssistantMessage([fauxMod.fauxText("w1")], { stopReason: "stop" }),
        fauxMod.fauxAssistantMessage([fauxMod.fauxText("w2")], { stopReason: "stop" }),
      ]);
      let calls2 = 0, origDrainCalled = 0;
      globalThis.__openclaw_stopHookPipeline = async () => {
        calls2++;
        if (calls2 === 1) return [{ role: "user", content: [{ type: "text", text: "[global-fallback] inject" }] }];
        return [];
      };
      const cfg = {
        model: faux2.getModel("m1"), tools: [], convertToLlm: (m) => m,
        getFollowUpMessages: async () => { origDrainCalled++; return []; },
      };
      const finalMsgs2 = await loopMod.runAgentLoop(
        [{ role: "user", content: [{ type: "text", text: "go" }] }],
        { model: faux2.getModel("m1"), tools: [], messages: [] },
        cfg,
        async () => {},
      );
      check("wrap: original empty drain invoked", origDrainCalled >= 1, `origDrainCalled=${origDrainCalled}`);
      check("wrap: globalThis fallback called after empty drain", calls2 >= 1, `calls2=${calls2}`);
      check("wrap: loop extended beyond first turn", faux2.state.callCount === 2, `callCount=${faux2.state.callCount}`);
      check("wrap: inject reached final context", finalMsgs2.some((m) => m.role === "user" && JSON.stringify(m.content).includes("global-fallback")));
    } finally {
      delete globalThis.__openclaw_stopHookPipeline;
      rmSync(d, { recursive: true, force: true });
    }
  }
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
