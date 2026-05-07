#!/usr/bin/env node
/**
 * smoke-test.mjs — plain-Node smoke for the stop-hook-pipeline CEP rule engine.
 *
 * Runs outside OpenClaw's vitest workspace (docker/** is excluded), so this is
 * the pre-deploy confidence check. Validates:
 *   1. patch-agent-loop.sh
 *   2. StopHookPipeline framework (register/evaluate/counter/priority)
 *   3. CEP event ingestion (observeAssistantEvent/markTurnBoundary/setLastUserText)
 *   4. observable_sources: message_send tool args.text → assistant-text accumulator
 *   5. createRuleHook semantics (preconditions AND, fire_when AND, text matching)
 *   6. loadStopHookRules + installRules
 *   7. YAML hot-reload
 *   8. END-TO-END: patched agent-loop → globalThis drain → continuation
 *   9. Regression: 18-exec + "30min 后回来" message-send must FIRE
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
  const { StopHookPipeline } = mod;

  const p = new StopHookPipeline();
  p.register("test", () => ({ shouldContinue: false }));
  check("register counted", p.hookCount === 1);

  const p2 = new StopHookPipeline(2);
  p2.register("always", () => ({ shouldContinue: true, message: "keep" }));
  const ctx = { sessionKey: "s", lastAssistantText: "x", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1 };
  check("counter R1", p2.evaluate(ctx).length === 1);
  check("counter R2", p2.evaluate(ctx).length === 1);
  check("counter yields R3 (saturates)", p2.evaluate(ctx).length === 0);

  const p3 = new StopHookPipeline();
  let firedFirst = "";
  p3.register("low", () => { firedFirst = firedFirst || "low"; return { shouldContinue: true, message: "low-fires" }; }, 1);
  p3.register("high", () => { firedFirst = firedFirst || "high"; return { shouldContinue: true, message: "high-fires" }; }, 10);
  const resP = p3.evaluate(ctx);
  check("higher priority wins", resP[0]?.content === "high-fires" && firedFirst === "high");

  p3.unregisterAll();
  check("unregisterAll clears hooks", p3.hookCount === 0);
}

console.log("\n=== CEP event ingestion ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { StopHookPipeline } = mod;

  const p = new StopHookPipeline();

  // Observer owns the accumulator — plugin only emits events
  p.observeAssistantEvent({
    sessionKey: "s1",
    content: [
      { type: "text", text: "第一句话。" },
      { type: "tool_use", name: "exec" },
    ],
  });
  let state = p.getTurnState("s1");
  check("CEP: event 1 captures text + tool", state.text.includes("第一句话") && state.tools.includes("exec"));
  check("CEP: event 1 lastHadToolCall=true", state.lastHadToolCall === true);

  // Second event: text-only message (NO_REPLY occupies its own BMW)
  p.observeAssistantEvent({
    sessionKey: "s1",
    content: [{ type: "text", text: "NO_REPLY" }],
  });
  state = p.getTurnState("s1");
  check("CEP: event 2 accumulates with event 1", state.text.includes("第一句话") && state.text.includes("NO_REPLY"));
  check("CEP: event 2 lastHadToolCall=false (this event had no tool)", state.lastHadToolCall === false);
  check("CEP: tools accumulator retains prior tools", state.tools.includes("exec"));

  // Turn boundary resets
  p.markTurnBoundary("s1");
  state = p.getTurnState("s1");
  check("CEP: markTurnBoundary clears text", state.text === "");
  check("CEP: markTurnBoundary clears tools", state.tools.length === 0);
  check("CEP: markTurnBoundary bumps turnIndex", state.turnIndex >= 1);

  p.setLastUserText("s1", "帮我修一下登录页的 bug");
  state = p.getTurnState("s1");
  check("CEP: setLastUserText captured", state.lastUserText === "帮我修一下登录页的 bug");

  // pickActiveSessionKey picks most recent
  p.observeAssistantEvent({ sessionKey: "s2", content: [{ type: "text", text: "later" }] });
  check("CEP: pickActiveSessionKey picks most recent", p.pickActiveSessionKey() === "s2");

  // buildContext assembles what rules see
  const ctx = p.buildContext("s2");
  check("CEP: buildContext includes assembled text", ctx && ctx.lastAssistantText === "later");
}

console.log("\n=== observable_sources: message tool args extraction ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { StopHookPipeline } = mod;

  const p = new StopHookPipeline();
  p.setObservableSources({
    outbound_message_tools: ["message", "message_send", "feishu_send"],
    outbound_message_text_fields: ["text", "message", "content"],
  });

  // assistant emits one event: calls message tool with args.text
  p.observeAssistantEvent({
    sessionKey: "s1",
    content: [{ type: "tool_use", name: "message", input: { text: "30 分钟后回来给你报告" } }],
  });
  let state = p.getTurnState("s1");
  check("obs: message args.text extracted into assistant text", state.text.includes("30 分钟后回来"));

  // Another outbound tool: feishu_send with 'message' field
  p.observeAssistantEvent({
    sessionKey: "s2",
    content: [{ type: "tool_use", name: "feishu_send", arguments: { message: "稍后回来" } }],
  });
  check("obs: feishu_send args.message extracted", p.getTurnState("s2").text.includes("稍后回来"));

  // Non-outbound tool: exec with args — must NOT leak into assistant text
  p.observeAssistantEvent({
    sessionKey: "s3",
    content: [{ type: "tool_use", name: "exec", input: { command: "ls -la /etc" } }],
  });
  check("obs: non-outbound tool args do NOT leak", p.getTurnState("s3").text === "");

  // Unknown tool: same — ignored
  p.observeAssistantEvent({
    sessionKey: "s4",
    content: [{ type: "tool_use", name: "random_tool", input: { text: "ignored" } }],
  });
  check("obs: unknown tool args ignored", p.getTurnState("s4").text === "");
}

console.log("\n=== createRuleHook semantics ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { createRuleHook } = mod;

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
  check("long user + has exec -> don't fire",
    noToolRule({ sessionKey: "s", lastAssistantText: "a", lastAssistantHadToolCall: true, lastToolNames: ["exec"], turnIndex: 1, lastUserText: "帮我修登录页的 bug" }).shouldContinue === false);
  check("long user + only message_send -> FIRE",
    noToolRule({ sessionKey: "s", lastAssistantText: "a", lastAssistantHadToolCall: true, lastToolNames: ["message_send"], turnIndex: 1, lastUserText: "帮我修登录页的 bug" }).shouldContinue === true);

  const proseRule = createRuleHook({
    id: "pr",
    enabled: true,
    priority: 30,
    preconditions: { min_assistant_text_length: 10, min_user_message_length: 10 },
    fire_when: {
      text_matches_any: [
        "我(?:来|去|先|现在|马上|立刻)",
        "让我",
        "接下来",
        "下一步",
        "稍后",
        "\\d+\\s*(?:min|分钟|小时|hour|h)\\s*(?:后|之后|later)",
        "回来(?:给你|向你|跟你).*(?:报告|汇报)",
        "\\bI'?ll\\b",
      ],
    },
    message: "prose",
  });
  const longUser = "帮我修一下登录页的 bug";

  check("prose · commitment + no tool -> FIRE",
    proseRule({ sessionKey: "s", lastAssistantText: "我来帮你检查这个问题", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: longUser }).shouldContinue === true);
  check("prose · short text (<10) -> precondition blocks",
    proseRule({ sessionKey: "s", lastAssistantText: "我来", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: longUser }).shouldContinue === false);
  check("prose · no commitment word -> don't fire",
    proseRule({ sessionKey: "s", lastAssistantText: "今天天气很好我们出去玩吧顺便买个菜", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: longUser }).shouldContinue === false);

  // ⭐ THE BIG ONE: 18x exec + "30min 后回来" by design FIRE regardless of tools
  check("prose · 18x exec + '30 分钟后回来' last sentence -> FIRE (ignores tool count)",
    proseRule({ sessionKey: "s", lastAssistantText: "我现在给你去工作,30 分钟后回来给你报告", lastAssistantHadToolCall: true, lastToolNames: Array(18).fill("exec"), turnIndex: 1, lastUserText: longUser }).shouldContinue === true);

  check("prose · '已完成修复' (无承诺词) -> don't fire",
    proseRule({ sessionKey: "s", lastAssistantText: "已完成修复,登录按钮现在能正常工作了", lastAssistantHadToolCall: true, lastToolNames: ["exec", "edit"], turnIndex: 1, lastUserText: longUser }).shouldContinue === false);

  const skipHBRule = createRuleHook({
    id: "hb",
    enabled: true,
    priority: 5,
    preconditions: { assistant_text_skip_if_matches_any: ["^HEARTBEAT_OK", "^NO_REPLY"] },
    fire_when: { no_tool_call: true },
    message: "fire",
  });
  check("HEARTBEAT_OK skipped by precondition",
    skipHBRule({ sessionKey: "s", lastAssistantText: "HEARTBEAT_OK", lastAssistantHadToolCall: false, lastToolNames: [], turnIndex: 1, lastUserText: "ping long enough" }).shouldContinue === false);

  const disabledRule = createRuleHook({ id: "d", enabled: false, priority: 1, fire_when: { no_tool_call: true }, message: "x" });
  check("disabled rule returns null", disabledRule === null);
}

console.log("\n=== loadStopHookRules + installRules ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { loadStopHookRules, installRules, StopHookPipeline } = mod;

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
  check("YAML enabled flag", loaded.enabled === true);
  check("YAML max_continuation_turns", loaded.max_continuation_turns === 2);
  check("YAML rules count", loaded.rules.length === 2);

  const p = new StopHookPipeline();
  const res = installRules(p, loaded);
  check("installRules installs enabled only", res.installed.length === 1 && res.installed[0] === "rule-a");
  check("installRules skips disabled", res.skipped.includes("rule-b"));

  const killed = { ...loaded, enabled: false };
  const p2 = new StopHookPipeline();
  const res2 = installRules(p2, killed);
  check("enabled=false → zero installed", res2.installed.length === 0);

  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== YAML hot-reload ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { watchRulesFile } = mod;

  const tmp = mkdtempSync(join(tmpdir(), "sww-"));
  const yamlPath = join(tmp, "rules.yaml");
  writeFileSync(yamlPath, `enabled: true\nrules: []\n`);

  let callCount = 0;
  let lastSnapshot = null;
  const stop = watchRulesFile(yamlPath, (file) => { callCount++; lastSnapshot = file; }, 100);

  await new Promise(r => setTimeout(r, 200));
  check("watcher fires on initial load", callCount >= 1);

  writeFileSync(yamlPath, `enabled: false\nrules: []\n`);
  await new Promise(r => setTimeout(r, 300));
  check("watcher re-fires after mtime change", callCount >= 2);
  check("watcher reflects new content", lastSnapshot?.enabled === false);

  stop();
  rmSync(tmp, { recursive: true, force: true });
}

console.log("\n=== FULL CEP LOOP: event → drain → rule fire on accumulated text ===");
{
  const mod = await import(`${__dirname}/stop-hook-pipeline.ts`);
  const { StopHookPipeline, createGetFollowUpMessages, installRules } = mod;

  const p = new StopHookPipeline();
  installRules(p, {
    enabled: true,
    max_continuation_turns: 3,
    observable_sources: {
      outbound_message_tools: ["message"],
      outbound_message_text_fields: ["text"],
    },
    rules: [{
      id: "prose",
      enabled: true,
      priority: 30,
      preconditions: { min_user_message_length: 10, min_assistant_text_length: 5 },
      fire_when: {
        text_matches_any: ["\\d+\\s*分钟\\s*后", "稍后", "回来"],
      },
      message: "DON'T DEFER",
    }],
  });

  // Simulate: user asks task → Her does 2 exec → Her emits message tool with "30 分钟后回来"
  // → Her emits NO_REPLY text → turn ends → drain
  p.setLastUserText("sid", "帮我修登录页的 bug 按钮不能点");
  p.observeAssistantEvent({ sessionKey: "sid", content: [{ type: "tool_use", name: "exec" }] });
  p.observeAssistantEvent({ sessionKey: "sid", content: [{ type: "tool_use", name: "exec" }] });
  p.observeAssistantEvent({ sessionKey: "sid", content: [{ type: "tool_use", name: "message", input: { text: "30 分钟后回来给你报告" } }] });
  p.observeAssistantEvent({ sessionKey: "sid", content: [{ type: "text", text: "NO_REPLY" }] });

  const drain = createGetFollowUpMessages(p);
  const msgs = await drain();
  check("FULL: 2 exec + message tool + NO_REPLY — prose fires on accumulated text",
    msgs.length === 1 && String(msgs[0].content).includes("DEFER"));
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
      check("wrap: original empty drain invoked", origDrainCalled >= 1);
      check("wrap: globalThis fallback called after empty drain", calls2 >= 1);
      check("wrap: loop extended beyond first turn", faux2.state.callCount === 2);
      check("wrap: inject reached final context", finalMsgs2.some((m) => m.role === "user" && JSON.stringify(m.content).includes("global-fallback")));
    } finally {
      delete globalThis.__openclaw_stopHookPipeline;
      rmSync(d, { recursive: true, force: true });
    }
  }
}

console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
