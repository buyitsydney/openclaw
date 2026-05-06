// Standalone integration test for antitalker v9.0
// Run: node --experimental-strip-types --no-warnings v9-test.ts
//
// We import the plugin module, expose its _handlers test seams, fake the API
// surface (api.on, api.logger, api.config), stub fetch + heartbeat APIs,
// and exercise every code path enumerated in the v9.0 plan.

import { mkdirSync, rmSync, existsSync, writeFileSync, unlinkSync } from "node:fs";

// ===== Setup test workspace + redirect audit path =====
const TEST_ROOT = "/tmp/antitalker-test";
const AUDIT_PATH = `${TEST_ROOT}/audit-group.json`;
try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
mkdirSync(TEST_ROOT, { recursive: true });

// ===== Stub fetch BEFORE importing the plugin (it captures fetch via fetch global) =====
let fetchHandlers: Array<(url: string, init: any) => Promise<any> | undefined> = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  for (const h of fetchHandlers) {
    const r = await h(u, init);
    if (r !== undefined) return r;
  }
  throw new Error(`Unhandled fetch: ${u}`);
}) as any;

function pushFetchHandler(h: (url: string, init: any) => Promise<any> | undefined) {
  fetchHandlers.push(h);
}
function clearFetchHandlers() { fetchHandlers = []; }

function jsonResponse(body: any, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any);
}

// ===== Import plugin =====
// @ts-ignore — runtime path
import plugin from "./index.ts";
const h = (plugin as any)._handlers;

// Redirect audit-group.json to test root
h.setAuditGroupPath(AUDIT_PATH);

// ===== Test framework =====
let passed = 0;
let failed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${(e?.stack ?? String(e)).split("\n").slice(0, 4).join("\n    ")}`);
    failed++;
    failures.push(name);
  }
}
function group(name: string, fn: () => Promise<void> | void) {
  console.log(`\n${name}`);
  return fn();
}
function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function assertEq(a: any, b: any, msg = "") {
  if (a !== b) throw new Error(`assertEq fail (${msg}): expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ===== State helpers =====
const enqueueCalls: any[] = [];
const hbCalls: any[] = [];

function freshState() {
  const s = h.state;
  s.turnCtx.clear();
  s.toolsBySessionKey.clear();
  s.convToSession.clear();
  s.sessionActivity.clear();
  s.rateLimitCounters.clear();
  s.cooldownTracker.clear();
  s.pendingViolations.clear();
  s.auditGroupCache = null;
  s.lastDmOwnerOpenId = "";
  s.lastDmSessionKey = "";
  s.lastSetupRequestAtMs = 0;
  s.tokenCache = null;
  enqueueCalls.length = 0;
  hbCalls.length = 0;
  clearFetchHandlers();
  try { unlinkSync(AUDIT_PATH); } catch {}
}

function setupHeartbeatStub() {
  h.state.heartbeatApi = {
    enqueueSystemEvent: (msg: string, opts: any) => { enqueueCalls.push({ msg, opts }); },
    requestHeartbeatNow: (opts: any) => { hbCalls.push(opts); },
  };
}

function setupFeishuTokenStub() {
  h.setPluginConfigRef({
    channels: { feishu: { appId: "cli_test", appSecret: "sec_test" } },
  });
  pushFetchHandler((url) => {
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
    }
    return undefined;
  });
}

function makeConfig(overrides: any = {}) {
  return {
    version: 1,
    runtime: { mtime_poll_interval_seconds: 5, turn_ctx_ttl_minutes: 10, turn_ctx_max_entries: 1024, log_level: "warn" },
    defaults: { exclude_from_count: [] },
    rules: [
      {
        id: "eta_empty_promise",
        label: "ETA 空头承诺",
        enabled: true,
        priority: 100,
        mode: "enforce",
        severity: "high",
        cooldown_seconds: 10,
        text_pattern: "(\\d+\\s*(min|分钟|小时)\\s*(后|内|later))",
        ignore_turn_tool_exemption: true,
        action: {
          push_admin: true,
          wake_her: true,
          wake_message_template: "你刚说了 {violation_text} · 命中 {rule_label}",
        },
      },
    ],
    tool_rules: [],
    exemptions: {
      content_prefixes: ["NO_REPLY", "HEARTBEAT_OK"],
      session_excludes_patterns: [],
      turn_has_any_substantial_tool: ["exec", "read", "write"],
      content_meta_discussion_keywords: [],
      content_meta_discussion_pattern: undefined,
    },
    rate_limit: { enabled: false, window_seconds: 60, max_violations_per_session: 5, on_exceed: { wake_her: false, push_admin: false } },
    notification: {
      feishu_card: { enabled: true, header_color: "red", title: "⚠️ {rule_label}", body_template: "rule={rule_label}" },
      target_chats: [],
    },
    prompt_injection: { enabled: false, section_title: "", include_rule_list: false, footer_template: "" },
    audit_log: { enabled: false, path: "", max_bytes: 0, rotate_keep: 0 },
    audit_group: { enabled: true },
    prose_only_ending: { enabled: false },
    delivery_response_required: { enabled: false },
    silence: { enabled: false },
    ...overrides,
  };
}

function compileRules(cfg: any) {
  for (const r of cfg.rules) {
    if (r.text_pattern) {
      r._regex = new RegExp(r.text_pattern, "i");
      r._isRe2 = false;
    }
  }
  return cfg;
}

function driveBmwAssistant(sessionKey: string, content: any[], extraCtx: any = {}) {
  const event = { message: { role: "assistant", content } };
  const ctx = { sessionKey, ...extraCtx };
  return h.bmw(event, ctx);
}
function makeText(t: string) { return { type: "text", text: t }; }
function makeToolCall(name: string) { return { type: "toolCall", name }; }

// ===== TESTS =====
(async () => {

await group("1. BMW marks pending (sync, no async side-effects)", async () => {
  await test("hadText + 0 toolCall + violation match → pendingViolations.set", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    const sk = "agent:main:feishu:group:oc_aaa";
    driveBmwAssistant(sk, [makeText("5分钟后我去看一下")]);
    const s = h.state;
    assertEq(s.pendingViolations.size, 1, "should mark exactly 1 violation");
    const v = s.pendingViolations.get(`${sk}:eta_empty_promise`);
    assert(v, "key should exist");
    assertEq(v!.sessionKey, sk, "sessionKey");
    assertEq(enqueueCalls.length, 0, "BMW must NOT call enqueueSystemEvent");
  });

  await test("hadText + 1 toolCall (mixed message) → no mark", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    driveBmwAssistant("sk1", [makeText("5分钟后回来"), makeToolCall("exec")]);
    assertEq(h.state.pendingViolations.size, 0, "tool present → no violation marked");
  });

  await test("multiple BMW for same session+rule → idempotent overwrite", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    const sk = "agent:main:feishu:group:oc_bbb";
    driveBmwAssistant(sk, [makeText("3分钟后我看")]);
    driveBmwAssistant(sk, [makeText("5分钟后我看")]);
    assertEq(h.state.pendingViolations.size, 1, "Map.set idempotent for same key");
  });

  await test("non-violation text → no mark", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    driveBmwAssistant("sk2", [makeText("好的我已经把文档建立好了")]);
    assertEq(h.state.pendingViolations.size, 0, "no regex match → no mark");
  });
});

await group("2. requestAuditSetup", async () => {
  await test("with owner identified → enqueues system event + heartbeat", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    h.state.lastDmOwnerOpenId = "ou_test_owner";
    h.state.lastDmSessionKey = "agent:main:main";
    const ok = h.requestAuditSetup();
    assertEq(ok, true, "should succeed");
    assertEq(enqueueCalls.length, 1, "1 enqueue call");
    assertEq(hbCalls.length, 1, "1 heartbeat call");
    const msg = enqueueCalls[0].msg;
    assert(msg.includes("ou_test_owner"), "owner in msg");
    assert(msg.includes("antitalker-audit-setup"), "skill name in msg");
    assert(msg.includes("audit-group.json"), "state file path in msg");
    assertEq(enqueueCalls[0].opts.contextKey, "antitalker:audit-setup", "contextKey");
    assertEq(enqueueCalls[0].opts.sessionKey, "agent:main:main", "DM session targeted");
  });

  await test("without owner → returns false, no enqueue", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    const ok = h.requestAuditSetup();
    assertEq(ok, false, "no owner → fail");
    assertEq(enqueueCalls.length, 0, "no enqueue");
  });

  await test("30min throttle: second call within window blocked", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    h.state.lastDmOwnerOpenId = "ou_t";
    h.state.lastDmSessionKey = "sk1";
    assertEq(h.requestAuditSetup(), true, "first ok");
    assertEq(h.requestAuditSetup(), false, "second throttled");
    assertEq(enqueueCalls.length, 1, "only 1 enqueue");
  });

  await test("after 30min → second call goes through", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    h.state.lastDmOwnerOpenId = "ou_t";
    h.state.lastDmSessionKey = "sk1";
    assertEq(h.requestAuditSetup(), true, "first ok");
    h.state.lastSetupRequestAtMs = Date.now() - 31 * 60_000;
    assertEq(h.requestAuditSetup(), true, "after expiry ok");
    assertEq(enqueueCalls.length, 2, "2 enqueues");
  });

  await test("missing heartbeat API → return false", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    h.state.heartbeatApi = {};
    h.state.lastDmOwnerOpenId = "ou_t";
    h.state.lastDmSessionKey = "sk1";
    assertEq(h.requestAuditSetup(), false, "no API → false");
  });
});

await group("3. readAuditGroupChatId", async () => {
  await test("audit_group.enabled=false → null", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig({ audit_group: { enabled: false } }));
    setupFeishuTokenStub();
    const r = await h.readAuditGroupChatId();
    assertEq(r, null, "disabled → null");
  });

  await test("file not exists → null", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupFeishuTokenStub();
    const r = await h.readAuditGroupChatId();
    assertEq(r, null, "no file → null");
  });

  await test("file has chat_id + verify ok → returns chat_id", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupFeishuTokenStub();
    writeFileSync(AUDIT_PATH, JSON.stringify({ chat_id: "oc_existing" }));
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/chats/oc_existing")) {
        return jsonResponse({ code: 0, data: { chat_id: "oc_existing" } });
      }
      return undefined;
    });
    const r = await h.readAuditGroupChatId();
    assertEq(r, "oc_existing", "returns chat_id");
    assertEq(h.state.auditGroupCache?.chatId, "oc_existing", "cached");
  });

  await test("verify FAILS → null + audit-group.json deleted", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupFeishuTokenStub();
    writeFileSync(AUDIT_PATH, JSON.stringify({ chat_id: "oc_dead" }));
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/chats/oc_dead")) {
        return jsonResponse({ code: 230002, msg: "not found" });
      }
      return undefined;
    });
    const r = await h.readAuditGroupChatId();
    assertEq(r, null, "verify failed → null");
    assertEq(existsSync(AUDIT_PATH), false, "stale file deleted");
  });

  await test("memory cache fresh → no fetch", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupFeishuTokenStub();
    h.state.auditGroupCache = { chatId: "oc_cached", verifiedAtMs: Date.now() };
    let fetched = 0;
    pushFetchHandler(() => { fetched++; return undefined; });
    const r = await h.readAuditGroupChatId();
    assertEq(r, "oc_cached", "from cache");
    assertEq(fetched, 0, "no fetch");
  });

  await test("no feishu token → null", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    h.setPluginConfigRef(null);
    delete (process.env as any).FEISHU_APP_ID;
    delete (process.env as any).FEISHU_APP_SECRET;
    writeFileSync(AUDIT_PATH, JSON.stringify({ chat_id: "oc_x" }));
    const r = await h.readAuditGroupChatId();
    assertEq(r, null, "no token → null");
  });
});

await group("4. ensureAuditGroupReady", async () => {
  await test("group exists → returns chat_id, no setup", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    h.state.lastDmOwnerOpenId = "ou_x";
    h.state.lastDmSessionKey = "sk1";
    writeFileSync(AUDIT_PATH, JSON.stringify({ chat_id: "oc_ready" }));
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/chats/oc_ready")) return jsonResponse({ code: 0, data: { chat_id: "oc_ready" } });
      return undefined;
    });
    const r = await h.ensureAuditGroupReady();
    assertEq(r, "oc_ready", "returns chat_id");
    assertEq(enqueueCalls.length, 0, "no setup request");
  });

  await test("missing + owner identified → null + setup triggered", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    h.state.lastDmOwnerOpenId = "ou_owner";
    h.state.lastDmSessionKey = "agent:main:main";
    const r = await h.ensureAuditGroupReady();
    assertEq(r, null, "no group");
    assertEq(enqueueCalls.length, 1, "setup requested");
  });

  await test("missing + no owner → null + no setup (silent)", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    const r = await h.ensureAuditGroupReady();
    assertEq(r, null, "no group");
    assertEq(enqueueCalls.length, 0, "no setup (no owner)");
  });
});

await group("5. violationWatchdog", async () => {
  await test("group: chatId set → push card + wake", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    h.markPendingViolation({
      sessionKey: "agent:main:feishu:group:oc_g", chatId: "oc_g",
      ruleId: "eta_empty_promise", severity: "high",
      preview: "5分钟", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: true, wakeEnabled: true,
    });
    let cardSent: any = null;
    pushFetchHandler((url, init) => {
      if (url.includes("/im/v1/messages")) {
        cardSent = JSON.parse(init.body);
        return jsonResponse({ code: 0 });
      }
      return undefined;
    });
    await h.violationWatchdog();
    assert(cardSent, "card sent");
    assertEq(cardSent.receive_id, "oc_g", "to group");
    assertEq(enqueueCalls.length, 1, "1 wake");
    assertEq(h.state.pendingViolations.size, 0, "queue cleared");
  });

  await test("private no-chatId no-audit → wake only, setup requested, no card", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    h.state.lastDmOwnerOpenId = "ou_dm";
    h.state.lastDmSessionKey = "agent:main:main";
    h.markPendingViolation({
      sessionKey: "agent:main:main", chatId: "",
      ruleId: "r", severity: "high",
      preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: true, wakeEnabled: true,
    });
    let cardSent = false;
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/messages")) { cardSent = true; return jsonResponse({ code: 0 }); }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(cardSent, false, "no card");
    assertEq(enqueueCalls.length, 2, "setup + wake = 2");
    const ck = enqueueCalls.map((c) => c.opts.contextKey);
    assert(ck.includes("antitalker:audit-setup"), "setup contextKey");
    assert(ck.includes("antitalker:violation"), "wake contextKey");
    assertEq(h.state.pendingViolations.size, 0, "cleared");
  });

  await test("private + audit group exists → card to audit + wake", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    writeFileSync(AUDIT_PATH, JSON.stringify({ chat_id: "oc_audit" }));
    h.markPendingViolation({
      sessionKey: "agent:main:main", chatId: "",
      ruleId: "r", severity: "high",
      preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: true, wakeEnabled: true,
    });
    let cardTo: string | null = null;
    pushFetchHandler((url, init) => {
      if (url.includes("/im/v1/chats/oc_audit") && (!init || !init.method || init.method === "GET")) {
        return jsonResponse({ code: 0, data: { chat_id: "oc_audit" } });
      }
      if (url.includes("/im/v1/messages")) {
        cardTo = JSON.parse(init.body).receive_id;
        return jsonResponse({ code: 0 });
      }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(cardTo, "oc_audit", "card to audit");
    assertEq(enqueueCalls.length, 1, "1 wake (no setup)");
  });

  await test("self-heal: lastToolCall after mark → skip everything", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    const sk = "agent:main:feishu:group:oc_x";
    const markedAt = Date.now() - 1000;
    h.state.pendingViolations.set(`${sk}:r1`, {
      sessionKey: sk, chatId: "oc_x", ruleId: "r1", severity: "high",
      preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: true, wakeEnabled: true,
      markedAtMs: markedAt, retries: 0,
    });
    h.state.sessionActivity.set(sk, {
      lastToolCallAtMs: Date.now(),
      lastAssistantMsgAtMs: Date.now(),
      lastAssistantHadToolCall: true,
      lastAssistantHadText: false,
      lastAssistantTextPreview: "", lastUserPreview: "",
      silenceAlertedAt: 0, chatId: "oc_x",
    });
    let cardSent = false;
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/messages")) { cardSent = true; return jsonResponse({ code: 0 }); }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(cardSent, false, "self-heal → no card");
    assertEq(enqueueCalls.length, 0, "no wake");
    assertEq(h.state.pendingViolations.size, 0, "cleared");
  });

  await test("retry: 3 fetch fails → drop after 3rd", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    h.markPendingViolation({
      sessionKey: "agent:main:feishu:group:oc_x", chatId: "oc_x",
      ruleId: "r", severity: "high",
      preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: true, wakeEnabled: true,
    });
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/messages")) {
        return Promise.reject(new Error("network"));
      }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(h.state.pendingViolations.size, 1, "still queued (retry 1)");
    await h.violationWatchdog();
    assertEq(h.state.pendingViolations.size, 1, "still queued (retry 2)");
    await h.violationWatchdog();
    assertEq(h.state.pendingViolations.size, 0, "given up (retry 3)");
  });

  await test("empty Map → fast return", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    let fetched = 0;
    pushFetchHandler(() => { fetched++; return undefined; });
    await h.violationWatchdog();
    assertEq(fetched, 0, "no fetch");
  });

  await test("wakeEnabled=false → no wake", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    h.markPendingViolation({
      sessionKey: "sk1", chatId: "oc_x", ruleId: "r", severity: "low",
      preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: true, wakeEnabled: false,
    });
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/messages")) return jsonResponse({ code: 0 });
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(enqueueCalls.length, 0, "no enqueue");
  });

  await test("pushAdmin=false → no card but wake", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    h.markPendingViolation({
      sessionKey: "sk1", chatId: "oc_x", ruleId: "r", severity: "high",
      preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: false, wakeEnabled: true,
    });
    let card = false;
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/messages")) { card = true; return jsonResponse({ code: 0 }); }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(card, false, "no card");
    assertEq(enqueueCalls.length, 1, "wake fired");
  });
});

await group("6. cooldown", async () => {
  await test("BMW twice within cooldown → only first marks", () => {
    freshState();
    const cfg = compileRules(makeConfig());
    cfg.rules[0].cooldown_seconds = 10;
    h.currentConfig = cfg;
    setupHeartbeatStub();
    const sk = "agent:main:feishu:group:oc_z";
    driveBmwAssistant(sk, [makeText("5分钟后回来")]);
    assertEq(h.state.pendingViolations.size, 1, "1st marked");
    h.state.pendingViolations.clear();  // simulate watchdog drain
    driveBmwAssistant(sk, [makeText("3分钟后回来")]);
    assertEq(h.state.pendingViolations.size, 0, "cooldown blocks 2nd");
  });
});

await group("7. multiple violations in one tick", async () => {
  await test("3 sessions → 3 cards + 3 wakes", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    for (let i = 0; i < 3; i++) {
      h.markPendingViolation({
        sessionKey: `agent:main:feishu:group:oc_${i}`, chatId: `oc_${i}`,
        ruleId: "r", severity: "high",
        preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: `W${i}`,
        pushAdmin: true, wakeEnabled: true,
      });
    }
    let cards = 0;
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/messages")) { cards++; return jsonResponse({ code: 0 }); }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(cards, 3, "3 cards");
    assertEq(enqueueCalls.length, 3, "3 wakes");
    assertEq(h.state.pendingViolations.size, 0, "all drained");
  });
});

await group("8. LRU cap", async () => {
  await test("260 entries → capped ≤256", () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    for (let i = 0; i < 260; i++) {
      h.markPendingViolation({
        sessionKey: `sk${i}`, chatId: "", ruleId: "r", severity: "high",
        preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
        pushAdmin: true, wakeEnabled: true,
      });
    }
    assert(h.state.pendingViolations.size <= 256, `size capped (got ${h.state.pendingViolations.size})`);
  });
});

await group("9. integration: BMW → watchdog (group)", async () => {
  await test("group violation full path", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    const sk = "agent:main:feishu:group:oc_int";
    h.state.sessionActivity.set(sk, {
      lastToolCallAtMs: 0, lastAssistantMsgAtMs: 0,
      lastAssistantHadToolCall: false, lastAssistantHadText: false,
      lastAssistantTextPreview: "", lastUserPreview: "",
      silenceAlertedAt: 0, chatId: "oc_int",
    });
    driveBmwAssistant(sk, [makeText("5分钟后回来")]);
    assertEq(h.state.pendingViolations.size, 1, "BMW marked");
    let cardTo: string | null = null;
    pushFetchHandler((url, init) => {
      if (url.includes("/im/v1/messages")) {
        cardTo = JSON.parse(init.body).receive_id;
        return jsonResponse({ code: 0 });
      }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(cardTo, "oc_int", "card to oc_int");
    assertEq(enqueueCalls.length, 1, "wake fired");
    assertEq(h.state.pendingViolations.size, 0, "drained");
  });
});

await group("10. integration: BMW → watchdog (private, full setup flow)", async () => {
  await test("private violation triggers setup, no card; later watchdog uses created group", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    setupFeishuTokenStub();
    const sk = "agent:main:main";
    // Owner identified earlier (simulated)
    h.state.lastDmOwnerOpenId = "ou_dm_owner";
    h.state.lastDmSessionKey = sk;
    h.state.sessionActivity.set(sk, {
      lastToolCallAtMs: 0, lastAssistantMsgAtMs: 0,
      lastAssistantHadToolCall: false, lastAssistantHadText: false,
      lastAssistantTextPreview: "", lastUserPreview: "",
      silenceAlertedAt: 0, chatId: "",
    });

    driveBmwAssistant(sk, [makeText("3分钟后回来")]);
    assertEq(h.state.pendingViolations.size, 1, "BMW marked");

    // First watchdog: no audit group → setup requested + wake (no card)
    let card1Sent = false;
    pushFetchHandler((url) => {
      if (url.includes("/im/v1/messages")) { card1Sent = true; return jsonResponse({ code: 0 }); }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(card1Sent, false, "no card on 1st watchdog");
    assertEq(enqueueCalls.length, 2, "setup + wake = 2");

    // Now simulate her completing setup: she writes audit-group.json
    writeFileSync(AUDIT_PATH, JSON.stringify({ chat_id: "oc_built_by_her" }));
    // Cooldown for the rule is now in effect, so we use markPendingViolation directly
    enqueueCalls.length = 0;
    clearFetchHandlers();
    setupFeishuTokenStub();

    h.markPendingViolation({
      sessionKey: sk, chatId: "",
      ruleId: "r-second", severity: "high",
      preview: "p", cardTitle: "T", cardBody: "B", wakeMessage: "W",
      pushAdmin: true, wakeEnabled: true,
    });

    let cardTo: string | null = null;
    pushFetchHandler((url, init) => {
      if (url.includes("/im/v1/chats/oc_built_by_her") && (!init || !init.method || init.method === "GET")) {
        return jsonResponse({ code: 0, data: { chat_id: "oc_built_by_her" } });
      }
      if (url.includes("/im/v1/messages")) {
        cardTo = JSON.parse(init.body).receive_id;
        return jsonResponse({ code: 0 });
      }
      return undefined;
    });
    await h.violationWatchdog();
    assertEq(cardTo, "oc_built_by_her", "card to her-built audit group");
    assertEq(enqueueCalls.length, 1, "1 wake (no extra setup)");
  });
});

await group("11. owner auto-detect via register() + user-capture hook", async () => {
  await test("DM user message with conversationId='user:ou_xxx' → state.lastDmOwnerOpenId set", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();

    // Simulate api.on registration; capture all "before_message_write" handlers
    const bmwHandlers: Array<(e: any, c: any) => any> = [];
    const fakeApi = {
      logger: console,
      config: { channels: { feishu: { appId: "x", appSecret: "y" } } },
      on: (event: string, handler: (e: any, c: any) => any) => {
        if (event === "before_message_write") bmwHandlers.push(handler);
      },
    };
    // Run register — it will fail loadConfig + loadHeartbeatApi gracefully but still wire api.on
    try { plugin.register(fakeApi); } catch {}

    // Restore our test config (register() overwrote with emptyConfig from failed loadConfig)
    h.currentConfig = compileRules(makeConfig());

    // The 2nd BMW handler is the user-capture one (1st = handleBeforeMessageWrite for assistant)
    assert(bmwHandlers.length >= 2, `should register ≥2 BMW handlers, got ${bmwHandlers.length}`);
    const userCapture = bmwHandlers[1];

    // Drive a user message with DM conversationId
    userCapture(
      { message: { role: "user", content: "我的需求是..." } },
      { sessionKey: "agent:main:main", conversationId: "user:ou_a1b2c3d4e5f60718293a4b5c6d7e8f90" },
    );
    assertEq(h.state.lastDmOwnerOpenId, "ou_a1b2c3d4e5f60718293a4b5c6d7e8f90", "owner detected from user:ou_xxx");
    assertEq(h.state.lastDmSessionKey, "agent:main:main", "DM sessionKey captured");

    // Real-world ID containing underscores/non-hex letters
    userCapture(
      { message: { role: "user", content: "another DM" } },
      { sessionKey: "agent:main:main", conversationId: "user:ou_Buy1tian_Test_XYZ" },
    );
    assertEq(h.state.lastDmOwnerOpenId, "ou_Buy1tian_Test_XYZ", "permissive ID chars also matched");
  });

  await test("group conversationId='chat:oc_xxx' → owner NOT detected (group, not DM)", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    const bmwHandlers: Array<(e: any, c: any) => any> = [];
    const fakeApi = {
      logger: console, config: {},
      on: (event: string, handler: (e: any, c: any) => any) => {
        if (event === "before_message_write") bmwHandlers.push(handler);
      },
    };
    try { plugin.register(fakeApi); } catch {}
    h.currentConfig = compileRules(makeConfig());

    const userCapture = bmwHandlers[1];
    userCapture(
      { message: { role: "user", content: "群里的话" } },
      { sessionKey: "agent:main:feishu:group:oc_xxx", conversationId: "chat:oc_xxx" },
    );
    assertEq(h.state.lastDmOwnerOpenId, "", "no DM → owner not set");
  });

  await test("0424 format conversationId='feishu:ou_xxx' → also detected", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    const bmwHandlers: Array<(e: any, c: any) => any> = [];
    const fakeApi = {
      logger: console, config: {},
      on: (event: string, handler: (e: any, c: any) => any) => {
        if (event === "before_message_write") bmwHandlers.push(handler);
      },
    };
    try { plugin.register(fakeApi); } catch {}
    h.currentConfig = compileRules(makeConfig());

    const userCapture = bmwHandlers[1];
    userCapture(
      { message: { role: "user", content: "0424 DM" } },
      { sessionKey: "agent:main:main", conversationId: "feishu:ou_deadbeefcafe1234567890abcdef0011" },
    );
    assertEq(h.state.lastDmOwnerOpenId, "ou_deadbeefcafe1234567890abcdef0011", "0424 'feishu:ou_xxx' also matches");
  });

  await test("assistant message → user-capture hook is no-op (does not touch owner state)", async () => {
    freshState();
    h.currentConfig = compileRules(makeConfig());
    setupHeartbeatStub();
    const bmwHandlers: Array<(e: any, c: any) => any> = [];
    const fakeApi = {
      logger: console, config: {},
      on: (event: string, handler: (e: any, c: any) => any) => {
        if (event === "before_message_write") bmwHandlers.push(handler);
      },
    };
    try { plugin.register(fakeApi); } catch {}
    h.currentConfig = compileRules(makeConfig());
    h.state.lastDmOwnerOpenId = "ou_existing";

    const userCapture = bmwHandlers[1];
    userCapture(
      { message: { role: "assistant", content: [makeText("hi")] } },
      { sessionKey: "sk1", conversationId: "user:ou_other" },
    );
    assertEq(h.state.lastDmOwnerOpenId, "ou_existing", "assistant message → no overwrite");
  });
});

// ===== Final report =====
console.log(`\n${"=".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);

})().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exit(2);
});
