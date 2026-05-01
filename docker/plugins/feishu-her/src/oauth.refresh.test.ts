/**
 * OAuth refresh hardening tests — 100 cases.
 *
 * Goal: pin the behavior of `refreshUserToken()` under every realistic
 * failure mode. Production log showed N "dedup: joining inflight refresh"
 * entries with ZERO `token refreshed for ...` success entries and ZERO
 * failure logs — i.e. silent failure via `catch { return null }` and
 * silent `res.code !== 0 return null`. These tests drive each failure
 * mode and assert that (a) the outer API returns null and (b) a
 * diagnostic line is written to console.warn/error describing what
 * broke.
 *
 * Indirection: we test `refreshUserToken` via `getValidUserTokenForOpenId`
 * / `getValidUserToken` (the public surface that internal callers use).
 * Token storage is isolated per-test via `OPENCLAW_HOME=<tmpdir>`.
 * The Feishu SDK client is mocked by intercepting `./outbound.js`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock outbound BEFORE importing oauth so getFeishuClient is replaced
// in the module graph that oauth.ts sees.
type MockRefreshResponse =
  | { code: number; data?: Record<string, unknown>; msg?: string }
  | Error
  | Promise<unknown>;

type MockClientShape = {
  authen: { refreshAccessToken: { create: (args: unknown) => Promise<unknown> } };
  application: { scope: { list: (args: unknown) => Promise<unknown> } };
};

let mockRefreshImpl: (args: unknown) => Promise<unknown> = async () => ({ code: 0 });
let mockScopeListImpl: (args: unknown) => Promise<unknown> = async () => ({
  code: 0,
  data: { scopes: [] },
});

vi.mock("./outbound.js", () => ({
  getFeishuClient: vi.fn(
    () =>
      ({
        authen: { refreshAccessToken: { create: (args: unknown) => mockRefreshImpl(args) } },
        application: { scope: { list: (args: unknown) => mockScopeListImpl(args) } },
      }) as MockClientShape,
  ),
  sendFeishuRichText: vi.fn(async () => undefined),
}));

import type { ResolvedFeishuAccount } from "./accounts.js";
import {
  __clearScopeCacheForTests,
  findAnyUserToken,
  getValidUserToken,
  getValidUserTokenForOpenId,
  loadUserToken,
  type FeishuUserToken,
} from "./oauth.js";

// ── Test fixture helpers ───────────────────────────────────────────

const ACCOUNT: ResolvedFeishuAccount = {
  accountId: "test-acct",
  knownBots: {},
  appId: "cli_test",
  appSecret: "secret_test",
} as unknown as ResolvedFeishuAccount;

function setRefresh(impl: MockRefreshResponse | ((args: unknown) => Promise<unknown>)): void {
  if (typeof impl === "function") {
    mockRefreshImpl = impl as (args: unknown) => Promise<unknown>;
    return;
  }
  if (impl instanceof Error) {
    mockRefreshImpl = async () => {
      throw impl;
    };
    return;
  }
  mockRefreshImpl = async () => impl;
}

function setScopeList(
  impl: (args: unknown) => Promise<unknown> | unknown | { code: number; data: unknown },
): void {
  mockScopeListImpl = async (args: unknown) => {
    const r = typeof impl === "function" ? (impl as (a: unknown) => unknown)(args) : impl;
    return r instanceof Promise ? await r : r;
  };
}

let tokenDir = "";
function mkTmpTokenRoot(label: string): string {
  const root = join(tmpdir(), `oauth-refresh-test-${label}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  process.env.OPENCLAW_HOME = root;
  tokenDir = join(root, "feishu-user-tokens");
  mkdirSync(tokenDir, { recursive: true });
  return tokenDir;
}

function writeToken(partial: Partial<FeishuUserToken> & { open_id: string }): FeishuUserToken {
  const now = Date.now();
  const tok: FeishuUserToken = {
    open_id: partial.open_id,
    name: partial.name ?? "tester",
    access_token: partial.access_token ?? "at_old",
    refresh_token: partial.refresh_token ?? "rt_old",
    access_token_expires_at: partial.access_token_expires_at ?? now - 60_000, // expired
    refresh_token_expires_at: partial.refresh_token_expires_at ?? now + 86_400_000,
    scopes: partial.scopes ?? [],
    created_at: partial.created_at ?? now - 3600_000,
    updated_at: partial.updated_at ?? now - 3600_000,
  };
  writeFileSync(join(tokenDir, `${tok.open_id}.json`), JSON.stringify(tok), "utf-8");
  return tok;
}

let spyWarn: ReturnType<typeof vi.spyOn>;
let spyError: ReturnType<typeof vi.spyOn>;
let spyLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearScopeCacheForTests();
  mockRefreshImpl = async () => ({
    code: 0,
    data: {
      access_token: "at_new",
      refresh_token: "rt_new",
      expires_in: 7200,
      refresh_expires_in: 86400,
    },
  });
  mockScopeListImpl = async () => ({ code: 0, data: { scopes: [] } });
  spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  spyError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  spyLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  const root = process.env.OPENCLAW_HOME;
  if (root && existsSync(root)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  delete process.env.OPENCLAW_HOME;
  vi.restoreAllMocks();
});

function refreshDiagnosticLogged(): boolean {
  const all = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
  return /refresh/i.test(all) || /\[feishu-oauth\]/.test(all);
}

function successLogged(openId: string): boolean {
  return spyLog.mock.calls
    .flat()
    .map(String)
    .some((s) => s.includes("token refreshed") && s.includes(openId));
}

// ─────────────────────────────────────────────────────────────────
// Section 1: Bug-repro — silent failures MUST now log diagnostics
// ─────────────────────────────────────────────────────────────────

describe("bug-repro: silent failure is forbidden", () => {
  it("repro-1: refresh code!=0 logs a diagnostic", async () => {
    mkTmpTokenRoot("repro1");
    writeToken({ open_id: "ou_repro1" });
    setRefresh({ code: 99991671, msg: "invalid_grant (token revoked)" });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_repro1");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("repro-2: SDK throws logs a diagnostic", async () => {
    mkTmpTokenRoot("repro2");
    writeToken({ open_id: "ou_repro2" });
    setRefresh(new Error("ECONNRESET"));
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_repro2");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("repro-3: concurrent refresh with same open_id → only 1 SDK call (mutex)", async () => {
    mkTmpTokenRoot("repro3");
    writeToken({ open_id: "ou_repro3" });
    let sdkCalls = 0;
    setRefresh(async () => {
      sdkCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        code: 0,
        data: { access_token: "at_new3", refresh_token: "rt_new3", expires_in: 7200 },
      };
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getValidUserTokenForOpenId(ACCOUNT, "ou_repro3")),
    );
    expect(sdkCalls).toBe(1);
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r!.access_token).toBe("at_new3");
    }
  });

  it("repro-4: refresh code!=0 includes code in log", async () => {
    mkTmpTokenRoot("repro4");
    writeToken({ open_id: "ou_repro4" });
    setRefresh({ code: 99991671, msg: "invalid" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_repro4");
    const logs = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
    expect(logs).toMatch(/99991671|invalid/);
  });

  it("repro-5: SDK throws, error.message appears in log", async () => {
    mkTmpTokenRoot("repro5");
    writeToken({ open_id: "ou_repro5" });
    setRefresh(new Error("ETIMEDOUT signal"));
    await getValidUserTokenForOpenId(ACCOUNT, "ou_repro5");
    const logs = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
    expect(logs).toMatch(/ETIMEDOUT/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 2: Happy-path refresh
// ─────────────────────────────────────────────────────────────────

describe("refresh happy-path", () => {
  it("code=0 + access_token returns refreshed token and persists", async () => {
    const dir = mkTmpTokenRoot("happy-1");
    writeToken({ open_id: "ou_h1", access_token: "at_old" });
    setRefresh({
      code: 0,
      data: { access_token: "at_new", refresh_token: "rt_new", expires_in: 7200 },
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h1");
    expect(res?.access_token).toBe("at_new");
    expect(res?.refresh_token).toBe("rt_new");
    // persisted to disk
    const saved = JSON.parse(readFileSync(join(dir, "ou_h1.json"), "utf-8")) as FeishuUserToken;
    expect(saved.access_token).toBe("at_new");
  });

  it("logs success with open_id", async () => {
    mkTmpTokenRoot("happy-2");
    writeToken({ open_id: "ou_h2" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_h2");
    expect(successLogged("ou_h2")).toBe(true);
  });

  it("new refresh_token replaces old one", async () => {
    mkTmpTokenRoot("happy-3");
    writeToken({ open_id: "ou_h3", refresh_token: "rt_v1" });
    setRefresh({
      code: 0,
      data: { access_token: "at", refresh_token: "rt_v2", expires_in: 7200 },
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h3");
    expect(res?.refresh_token).toBe("rt_v2");
  });

  it("absent refresh_token response preserves old refresh_token", async () => {
    mkTmpTokenRoot("happy-4");
    writeToken({ open_id: "ou_h4", refresh_token: "rt_keep" });
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 7200 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h4");
    expect(res?.refresh_token).toBe("rt_keep");
  });

  it("scope string in response updates stored scopes", async () => {
    mkTmpTokenRoot("happy-5");
    writeToken({ open_id: "ou_h5", scopes: ["a", "b"] });
    setRefresh({
      code: 0,
      data: { access_token: "at", expires_in: 7200, scope: "x y z" },
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h5");
    expect(res?.scopes).toEqual(["x", "y", "z"]);
  });

  it("no scope field preserves existing scopes", async () => {
    mkTmpTokenRoot("happy-6");
    writeToken({ open_id: "ou_h6", scopes: ["a", "b"] });
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 7200 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h6");
    expect(res?.scopes).toEqual(["a", "b"]);
  });

  it("comma-separated scope string is parsed", async () => {
    mkTmpTokenRoot("happy-7");
    writeToken({ open_id: "ou_h7", scopes: [] });
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 7200, scope: "a,b,c" } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h7");
    expect(res?.scopes).toEqual(["a", "b", "c"]);
  });

  it("expires_in=7200 sets expiry ≈ now+7200s", async () => {
    mkTmpTokenRoot("happy-8");
    writeToken({ open_id: "ou_h8" });
    const before = Date.now();
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 7200 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h8");
    expect(res!.access_token_expires_at).toBeGreaterThanOrEqual(before + 7200 * 1000 - 500);
    expect(res!.access_token_expires_at).toBeLessThanOrEqual(before + 7200 * 1000 + 5000);
  });

  it("missing expires_in defaults to 7200s", async () => {
    mkTmpTokenRoot("happy-9");
    writeToken({ open_id: "ou_h9" });
    const before = Date.now();
    setRefresh({ code: 0, data: { access_token: "at" } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h9");
    expect(res!.access_token_expires_at).toBeGreaterThanOrEqual(before + 7200 * 1000 - 500);
  });

  it("refresh_expires_in updates refresh_token_expires_at", async () => {
    mkTmpTokenRoot("happy-10");
    writeToken({ open_id: "ou_h10", refresh_token_expires_at: Date.now() + 1_000_000 });
    const before = Date.now();
    setRefresh({
      code: 0,
      data: { access_token: "at", expires_in: 7200, refresh_expires_in: 86400 },
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h10");
    expect(res!.refresh_token_expires_at).toBeGreaterThanOrEqual(before + 86400 * 1000 - 500);
  });

  it("missing refresh_expires_in preserves existing refresh_token_expires_at", async () => {
    mkTmpTokenRoot("happy-11");
    const preserve = Date.now() + 5_000_000;
    writeToken({ open_id: "ou_h11", refresh_token_expires_at: preserve });
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 7200 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h11");
    expect(res!.refresh_token_expires_at).toBe(preserve);
  });

  it("updated_at advances after refresh", async () => {
    mkTmpTokenRoot("happy-12");
    writeToken({ open_id: "ou_h12", updated_at: 1 });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h12");
    expect(res!.updated_at).toBeGreaterThan(1);
  });

  it("token within refresh margin triggers refresh", async () => {
    mkTmpTokenRoot("happy-13");
    writeToken({
      open_id: "ou_h13",
      access_token_expires_at: Date.now() + 5 * 60_000, // inside 10min margin
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h13");
    expect(res?.access_token).toBe("at_new");
  });

  it("token comfortably valid (>10min to expiry) skips refresh", async () => {
    mkTmpTokenRoot("happy-14");
    writeToken({
      open_id: "ou_h14",
      access_token: "at_current",
      access_token_expires_at: Date.now() + 30 * 60_000,
    });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      return { code: 0, data: { access_token: "at_should_not_be_used", expires_in: 7200 } };
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_h14");
    expect(calls).toBe(0);
    expect(res?.access_token).toBe("at_current");
  });

  it("newly acquired token is immediately valid on re-check", async () => {
    mkTmpTokenRoot("happy-15");
    writeToken({ open_id: "ou_h15" });
    const first = await getValidUserTokenForOpenId(ACCOUNT, "ou_h15");
    let calls = 0;
    setRefresh(async () => {
      calls++;
      return { code: 0, data: { access_token: "should_not", expires_in: 7200 } };
    });
    const second = await getValidUserTokenForOpenId(ACCOUNT, "ou_h15");
    expect(calls).toBe(0);
    expect(second?.access_token).toBe(first?.access_token);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 3: Failure-path refresh
// ─────────────────────────────────────────────────────────────────

const FEISHU_ERROR_CODES: Array<[number, string]> = [
  [1, "rate_limited"],
  [99991668, "access_token_invalid"],
  [99991671, "refresh_token_invalid"],
  [99991677, "access_token_expired"],
  [99991679, "unauthorized"],
  [20003, "code_already_used"],
  [20079, "oauth_misc"],
  [20084, "too_many_scopes"],
  [40001, "generic_bad_request"],
  [50001, "internal_server"],
];

describe("refresh failure paths", () => {
  for (const [code, label] of FEISHU_ERROR_CODES) {
    it(`code=${code} (${label}) returns null and logs`, async () => {
      mkTmpTokenRoot(`fail-code-${code}`);
      writeToken({ open_id: `ou_c${code}` });
      setRefresh({ code, msg: label });
      const res = await getValidUserTokenForOpenId(ACCOUNT, `ou_c${code}`);
      expect(res).toBeNull();
      expect(refreshDiagnosticLogged()).toBe(true);
    });
  }

  const THROWN_ERRORS: Array<[string, unknown]> = [
    ["plain Error", new Error("plain failure")],
    ["TypeError", new TypeError("bad access")],
    ["string throw", "string-error"],
    ["number throw", 42],
    ["object with code", { code: 500, msg: "server" }],
    ["Error with stack", Object.assign(new Error("stacky"), { stack: "fake" })],
    ["ENOTFOUND", Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })],
    ["ECONNREFUSED", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["ETIMEDOUT", Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" })],
    ["aborted", new DOMException("aborted", "AbortError")],
  ];

  for (const [label, err] of THROWN_ERRORS) {
    it(`throws (${label}) → null + log`, async () => {
      mkTmpTokenRoot(`throw-${label}`);
      writeToken({ open_id: `ou_t_${label.replace(/\W+/g, "_")}` });
      setRefresh(() => {
        throw err as Error;
      });
      const res = await getValidUserTokenForOpenId(
        ACCOUNT,
        `ou_t_${label.replace(/\W+/g, "_")}`,
      );
      expect(res).toBeNull();
      expect(refreshDiagnosticLogged()).toBe(true);
    });
  }

  it("res=null returns null + log", async () => {
    mkTmpTokenRoot("null-res");
    writeToken({ open_id: "ou_nr" });
    setRefresh(async () => null);
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_nr");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("res=undefined returns null + log", async () => {
    mkTmpTokenRoot("undef-res");
    writeToken({ open_id: "ou_ur" });
    setRefresh(async () => undefined);
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_ur");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("code=0 but data missing returns null + log", async () => {
    mkTmpTokenRoot("missing-data");
    writeToken({ open_id: "ou_md" });
    setRefresh({ code: 0 });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_md");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("code=0 + data.access_token empty returns null + log", async () => {
    mkTmpTokenRoot("empty-at");
    writeToken({ open_id: "ou_ea" });
    setRefresh({ code: 0, data: { access_token: "" } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_ea");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("code=0 + data.access_token null returns null + log", async () => {
    mkTmpTokenRoot("null-at");
    writeToken({ open_id: "ou_na" });
    setRefresh({ code: 0, data: { access_token: null } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_na");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("success log does NOT fire on failure", async () => {
    mkTmpTokenRoot("no-success-log");
    writeToken({ open_id: "ou_nsl" });
    setRefresh({ code: 99991671, msg: "invalid" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_nsl");
    expect(successLogged("ou_nsl")).toBe(false);
  });

  it("logs include appId or open_id context for triage", async () => {
    mkTmpTokenRoot("context-log");
    writeToken({ open_id: "ou_ctx" });
    setRefresh({ code: 99991671, msg: "invalid" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_ctx");
    const logs = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
    expect(logs).toMatch(/ou_ctx|cli_test/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 4: Refresh token lifecycle
// ─────────────────────────────────────────────────────────────────

describe("refresh_token lifecycle", () => {
  it("refresh_token expired → returns null without calling SDK", async () => {
    mkTmpTokenRoot("rt-expired-1");
    writeToken({
      open_id: "ou_rt1",
      refresh_token_expires_at: Date.now() - 60_000,
      access_token_expires_at: Date.now() - 60_000,
    });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      return { code: 0 };
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_rt1");
    expect(res).toBeNull();
    expect(calls).toBe(0);
  });

  it("refresh_token valid, access expired → refresh called", async () => {
    mkTmpTokenRoot("rt-valid");
    writeToken({ open_id: "ou_rt2" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      return {
        code: 0,
        data: { access_token: "at", refresh_token: "rt", expires_in: 7200 },
      };
    });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_rt2");
    expect(calls).toBe(1);
  });

  it("refresh_token expiring right at now → considered expired", async () => {
    mkTmpTokenRoot("rt-now");
    writeToken({
      open_id: "ou_rt3",
      refresh_token_expires_at: Date.now() - 1,
      access_token_expires_at: Date.now() - 60_000,
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_rt3");
    expect(res).toBeNull();
  });

  it("server-side revoke (99991668) returns null", async () => {
    mkTmpTokenRoot("revoke");
    writeToken({ open_id: "ou_rev" });
    setRefresh({ code: 99991668, msg: "revoked" });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_rev");
    expect(res).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 5: Concurrency / mutex
// ─────────────────────────────────────────────────────────────────

describe("concurrent refresh dedup", () => {
  for (const N of [2, 3, 5, 10, 20]) {
    it(`${N} concurrent same-openId calls → 1 SDK call`, async () => {
      mkTmpTokenRoot(`conc-${N}`);
      writeToken({ open_id: `ou_conc${N}` });
      let calls = 0;
      setRefresh(async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 15));
        return {
          code: 0,
          data: { access_token: `at_${N}`, refresh_token: "rt", expires_in: 7200 },
        };
      });
      const results = await Promise.all(
        Array.from({ length: N }, () => getValidUserTokenForOpenId(ACCOUNT, `ou_conc${N}`)),
      );
      expect(calls).toBe(1);
      for (const r of results) expect(r?.access_token).toBe(`at_${N}`);
    });
  }

  it("2 concurrent different open_ids → 2 SDK calls", async () => {
    mkTmpTokenRoot("conc-diff");
    writeToken({ open_id: "ou_A" });
    writeToken({ open_id: "ou_B" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { code: 0, data: { access_token: "at", refresh_token: "rt", expires_in: 7200 } };
    });
    await Promise.all([
      getValidUserTokenForOpenId(ACCOUNT, "ou_A"),
      getValidUserTokenForOpenId(ACCOUNT, "ou_B"),
    ]);
    expect(calls).toBe(2);
  });

  it("dedup map entry clears after promise resolves — next call refreshes again", async () => {
    mkTmpTokenRoot("dedup-clear");
    writeToken({ open_id: "ou_dc" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      return {
        code: 0,
        data: { access_token: `at${calls}`, expires_in: 0 }, // expires immediately
      };
    });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_dc");
    await getValidUserTokenForOpenId(ACCOUNT, "ou_dc");
    expect(calls).toBe(2);
  });

  it("dedup map entry clears even when refresh throws", async () => {
    mkTmpTokenRoot("dedup-clear-throw");
    writeToken({ open_id: "ou_dct" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      if (calls === 1) throw new Error("first fail");
      return { code: 0, data: { access_token: "at2", expires_in: 7200 } };
    });
    const first = await getValidUserTokenForOpenId(ACCOUNT, "ou_dct");
    expect(first).toBeNull();
    const second = await getValidUserTokenForOpenId(ACCOUNT, "ou_dct");
    expect(second?.access_token).toBe("at2");
    expect(calls).toBe(2);
  });

  it("dedup with concurrent failures: all joiners get null, logs fire", async () => {
    mkTmpTokenRoot("conc-fail");
    writeToken({ open_id: "ou_cf" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      throw new Error("boom");
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getValidUserTokenForOpenId(ACCOUNT, "ou_cf")),
    );
    expect(calls).toBe(1);
    for (const r of results) expect(r).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("dedup with concurrent code!=0: all joiners get null", async () => {
    mkTmpTokenRoot("conc-code");
    writeToken({ open_id: "ou_cc" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { code: 99991671, msg: "revoked" };
    });
    const results = await Promise.all(
      Array.from({ length: 7 }, () => getValidUserTokenForOpenId(ACCOUNT, "ou_cc")),
    );
    expect(calls).toBe(1);
    for (const r of results) expect(r).toBeNull();
  });

  it("interleaved fire-and-settle — 2 batches of 3", async () => {
    mkTmpTokenRoot("interleave");
    writeToken({ open_id: "ou_il" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return {
        code: 0,
        data: { access_token: `at${calls}`, expires_in: 0 },
      };
    });
    await Promise.all(
      Array.from({ length: 3 }, () => getValidUserTokenForOpenId(ACCOUNT, "ou_il")),
    );
    await Promise.all(
      Array.from({ length: 3 }, () => getValidUserTokenForOpenId(ACCOUNT, "ou_il")),
    );
    expect(calls).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 6: findAnyUserToken / loadUserToken
// ─────────────────────────────────────────────────────────────────

describe("token directory reads", () => {
  it("findAnyUserToken: no dir → null", () => {
    const root = join(tmpdir(), `no-dir-${Date.now()}`);
    process.env.OPENCLAW_HOME = root;
    expect(findAnyUserToken()).toBeNull();
    delete process.env.OPENCLAW_HOME;
  });

  it("findAnyUserToken: empty dir → null", () => {
    mkTmpTokenRoot("empty-dir");
    expect(findAnyUserToken()).toBeNull();
  });

  it("findAnyUserToken: picks newest by updated_at", () => {
    mkTmpTokenRoot("newest");
    writeToken({ open_id: "ou_old", updated_at: 1000 });
    writeToken({ open_id: "ou_new", updated_at: 5000 });
    const t = findAnyUserToken();
    expect(t?.open_id).toBe("ou_new");
  });

  it("findAnyUserToken: skips files without open_id", () => {
    const dir = mkTmpTokenRoot("skip-noopen");
    writeFileSync(join(dir, "a.json"), JSON.stringify({ refresh_token: "x" }));
    writeToken({ open_id: "ou_ok" });
    const t = findAnyUserToken();
    expect(t?.open_id).toBe("ou_ok");
  });

  it("findAnyUserToken: skips files without refresh_token", () => {
    const dir = mkTmpTokenRoot("skip-nort");
    writeFileSync(
      join(dir, "x.json"),
      JSON.stringify({ open_id: "ou_norft" /* no refresh_token */ }),
    );
    writeToken({ open_id: "ou_ok2" });
    const t = findAnyUserToken();
    expect(t?.open_id).toBe("ou_ok2");
  });

  it("findAnyUserToken: malformed JSON file is skipped", () => {
    const dir = mkTmpTokenRoot("malformed");
    writeFileSync(join(dir, "bad.json"), "{not json");
    writeToken({ open_id: "ou_good" });
    const t = findAnyUserToken();
    expect(t?.open_id).toBe("ou_good");
  });

  it("findAnyUserToken: only non-json files present → null", () => {
    const dir = mkTmpTokenRoot("nonjson-only");
    writeFileSync(join(dir, "a.txt"), "hi");
    writeFileSync(join(dir, "b.log"), "hi");
    expect(findAnyUserToken()).toBeNull();
  });

  it("loadUserToken: missing → null", () => {
    mkTmpTokenRoot("load-miss");
    expect(loadUserToken("ou_missing")).toBeNull();
  });

  it("loadUserToken: malformed → null", () => {
    const dir = mkTmpTokenRoot("load-bad");
    writeFileSync(join(dir, "ou_bad.json"), "{not json");
    expect(loadUserToken("ou_bad")).toBeNull();
  });

  it("loadUserToken: valid → returns token", () => {
    mkTmpTokenRoot("load-ok");
    writeToken({ open_id: "ou_ok_l" });
    const t = loadUserToken("ou_ok_l");
    expect(t?.open_id).toBe("ou_ok_l");
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 7: getValidUserToken (auto-pick newest token)
// ─────────────────────────────────────────────────────────────────

describe("getValidUserToken (auto-pick)", () => {
  it("no tokens → null", async () => {
    mkTmpTokenRoot("auto-empty");
    const t = await getValidUserToken(ACCOUNT);
    expect(t).toBeNull();
  });

  it("one valid token → returned as-is", async () => {
    mkTmpTokenRoot("auto-valid");
    writeToken({
      open_id: "ou_av",
      access_token: "at_live",
      access_token_expires_at: Date.now() + 30 * 60_000,
    });
    const t = await getValidUserToken(ACCOUNT);
    expect(t?.access_token).toBe("at_live");
  });

  it("one expired token → auto-refreshed", async () => {
    mkTmpTokenRoot("auto-refresh");
    writeToken({ open_id: "ou_ar" });
    const t = await getValidUserToken(ACCOUNT);
    expect(t?.access_token).toBe("at_new");
  });

  it("one token with expired refresh → returns null", async () => {
    mkTmpTokenRoot("auto-expire-rt");
    writeToken({
      open_id: "ou_rtexp",
      refresh_token_expires_at: Date.now() - 60_000,
    });
    const t = await getValidUserToken(ACCOUNT);
    expect(t).toBeNull();
  });

  it("multiple tokens → newest wins, refreshed if expired", async () => {
    mkTmpTokenRoot("auto-multi");
    writeToken({ open_id: "ou_m_old", updated_at: 1, access_token: "at_old" });
    writeToken({ open_id: "ou_m_new", updated_at: 9999, access_token: "at_old_new" });
    const t = await getValidUserToken(ACCOUNT);
    expect(t?.open_id).toBe("ou_m_new");
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 8: Scope-drift fire-and-forget
// ─────────────────────────────────────────────────────────────────

describe("scope drift detection", () => {
  it("empty stored scopes → drift check skipped", async () => {
    mkTmpTokenRoot("drift-empty");
    writeToken({
      open_id: "ou_de",
      access_token_expires_at: Date.now() + 30 * 60_000,
      scopes: [],
    });
    let probed = 0;
    setScopeList(async () => {
      probed++;
      return { code: 0, data: { scopes: [] } };
    });
    const t = await getValidUserToken(ACCOUNT);
    // fire-and-forget runs via setImmediate; allow one tick
    await new Promise((r) => setImmediate(r));
    expect(t?.access_token).toBeTruthy();
    expect(probed).toBe(0);
  });

  it("non-empty stored scopes → drift check fires", async () => {
    mkTmpTokenRoot("drift-fire");
    writeToken({
      open_id: "ou_df",
      access_token_expires_at: Date.now() + 30 * 60_000,
      scopes: ["a"],
    });
    let probed = 0;
    setScopeList(async () => {
      probed++;
      return {
        code: 0,
        data: {
          scopes: [{ scope_name: "a", scope_type: "user", grant_status: 1 }],
        },
      };
    });
    await getValidUserToken(ACCOUNT);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 15));
    expect(probed).toBe(1);
  });

  it("drift check failure does NOT prevent token return", async () => {
    mkTmpTokenRoot("drift-fail");
    writeToken({
      open_id: "ou_dff",
      access_token_expires_at: Date.now() + 30 * 60_000,
      scopes: ["a"],
    });
    setScopeList(async () => {
      throw new Error("scope probe fail");
    });
    const t = await getValidUserToken(ACCOUNT);
    expect(t?.access_token).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 9: Boundary / edge-value refresh payloads
// ─────────────────────────────────────────────────────────────────

describe("boundary payload handling", () => {
  it("expires_in=0 → access_token expires_at = now", async () => {
    mkTmpTokenRoot("edge-exp0");
    writeToken({ open_id: "ou_ex0" });
    const before = Date.now();
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 0 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_ex0");
    expect(res!.access_token_expires_at).toBeGreaterThanOrEqual(before);
    expect(res!.access_token_expires_at).toBeLessThanOrEqual(before + 2000);
  });

  it("expires_in=-1 → access_token expires_at in the past", async () => {
    mkTmpTokenRoot("edge-expneg");
    writeToken({ open_id: "ou_exn" });
    const before = Date.now();
    setRefresh({ code: 0, data: { access_token: "at", expires_in: -1 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_exn");
    expect(res!.access_token_expires_at).toBeLessThan(before + 500);
  });

  it("very large expires_in = 86400 accepted", async () => {
    mkTmpTokenRoot("edge-expbig");
    writeToken({ open_id: "ou_exb" });
    const before = Date.now();
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 86400 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_exb");
    expect(res!.access_token_expires_at).toBeGreaterThanOrEqual(before + 86400 * 1000 - 500);
  });

  it("refresh_token in token is empty string → refresh still attempts (Feishu rejects)", async () => {
    mkTmpTokenRoot("edge-empty-rt");
    writeToken({ open_id: "ou_ert", refresh_token: "" });
    setRefresh({ code: 99991671, msg: "bad refresh_token" });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_ert");
    expect(res).toBeNull();
    expect(refreshDiagnosticLogged()).toBe(true);
  });

  it("access_token empty but not expired → passthrough (never touches refresh)", async () => {
    mkTmpTokenRoot("edge-empty-at");
    writeToken({
      open_id: "ou_eat",
      access_token: "",
      access_token_expires_at: Date.now() + 30 * 60_000,
    });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      return { code: 0 };
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_eat");
    expect(calls).toBe(0);
    expect(res?.access_token).toBe("");
  });

  it("token with access_token_expires_at = now → inside refresh margin, triggers refresh", async () => {
    mkTmpTokenRoot("edge-now");
    writeToken({
      open_id: "ou_now",
      access_token_expires_at: Date.now(),
    });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      return {
        code: 0,
        data: { access_token: "at_fresh", expires_in: 7200 },
      };
    });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_now");
    expect(calls).toBe(1);
  });

  it("refresh_expires_in = 0 → refresh_token expires immediately", async () => {
    mkTmpTokenRoot("edge-refexp0");
    writeToken({ open_id: "ou_re0" });
    const before = Date.now();
    setRefresh({
      code: 0,
      data: { access_token: "at", expires_in: 7200, refresh_expires_in: 0 },
    });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_re0");
    expect(res!.refresh_token_expires_at).toBeGreaterThanOrEqual(before);
    expect(res!.refresh_token_expires_at).toBeLessThanOrEqual(before + 2000);
  });

  it("extremely long access_token string persists correctly", async () => {
    const dir = mkTmpTokenRoot("edge-long");
    writeToken({ open_id: "ou_long" });
    const long = "a".repeat(4096);
    setRefresh({ code: 0, data: { access_token: long, expires_in: 7200 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_long");
    expect(res?.access_token).toBe(long);
    const saved = JSON.parse(readFileSync(join(dir, "ou_long.json"), "utf-8")) as FeishuUserToken;
    expect(saved.access_token).toBe(long);
  });

  it("unicode in name survives refresh", async () => {
    mkTmpTokenRoot("edge-unicode");
    writeToken({ open_id: "ou_uni", name: "卜弋天🚀" });
    setRefresh({ code: 0, data: { access_token: "at", expires_in: 7200 } });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_uni");
    expect(res?.name).toBe("卜弋天🚀");
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 10: Persistence correctness
// ─────────────────────────────────────────────────────────────────

describe("persistence after refresh", () => {
  it("refresh success writes file to token dir", async () => {
    const dir = mkTmpTokenRoot("persist-1");
    writeToken({ open_id: "ou_p1" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_p1");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toContain("ou_p1.json");
  });

  it("refresh failure does NOT overwrite existing token", async () => {
    const dir = mkTmpTokenRoot("persist-2");
    writeToken({ open_id: "ou_p2", access_token: "at_preserved" });
    setRefresh({ code: 99991671, msg: "no" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_p2");
    const saved = JSON.parse(readFileSync(join(dir, "ou_p2.json"), "utf-8")) as FeishuUserToken;
    expect(saved.access_token).toBe("at_preserved");
  });

  it("refresh throw does NOT overwrite existing token", async () => {
    const dir = mkTmpTokenRoot("persist-3");
    writeToken({ open_id: "ou_p3", access_token: "at_keep" });
    setRefresh(new Error("network"));
    await getValidUserTokenForOpenId(ACCOUNT, "ou_p3");
    const saved = JSON.parse(readFileSync(join(dir, "ou_p3.json"), "utf-8")) as FeishuUserToken;
    expect(saved.access_token).toBe("at_keep");
  });

  it("refresh success overwrites with new token fields", async () => {
    const dir = mkTmpTokenRoot("persist-4");
    writeToken({ open_id: "ou_p4", access_token: "at_old_p4" });
    setRefresh({
      code: 0,
      data: { access_token: "at_fresh_p4", refresh_token: "rt_fresh", expires_in: 7200 },
    });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_p4");
    const saved = JSON.parse(readFileSync(join(dir, "ou_p4.json"), "utf-8")) as FeishuUserToken;
    expect(saved.access_token).toBe("at_fresh_p4");
    expect(saved.refresh_token).toBe("rt_fresh");
  });

  it("multiple users each write their own file", async () => {
    const dir = mkTmpTokenRoot("persist-5");
    writeToken({ open_id: "ou_p5a" });
    writeToken({ open_id: "ou_p5b" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_p5a");
    await getValidUserTokenForOpenId(ACCOUNT, "ou_p5b");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files).toContain("ou_p5a.json");
    expect(files).toContain("ou_p5b.json");
  });

  it("open_id preserved after refresh", async () => {
    mkTmpTokenRoot("persist-6");
    writeToken({ open_id: "ou_p6_stable" });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_p6_stable");
    expect(res?.open_id).toBe("ou_p6_stable");
  });

  it("name preserved across refresh", async () => {
    mkTmpTokenRoot("persist-7");
    writeToken({ open_id: "ou_p7", name: "alice" });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_p7");
    expect(res?.name).toBe("alice");
  });

  it("created_at preserved across refresh", async () => {
    mkTmpTokenRoot("persist-8");
    writeToken({ open_id: "ou_p8", created_at: 12345 });
    const res = await getValidUserTokenForOpenId(ACCOUNT, "ou_p8");
    expect(res?.created_at).toBe(12345);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 11: Diverse error-shape handling in logs
// ─────────────────────────────────────────────────────────────────

describe("log message content", () => {
  it("Error.message appears verbatim", async () => {
    mkTmpTokenRoot("msg-1");
    writeToken({ open_id: "ou_msg1" });
    setRefresh(new Error("UNIQUE_MSG_MARKER_12345"));
    await getValidUserTokenForOpenId(ACCOUNT, "ou_msg1");
    const logs = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
    expect(logs).toMatch(/UNIQUE_MSG_MARKER_12345/);
  });

  it("response msg string appears on code!=0", async () => {
    mkTmpTokenRoot("msg-2");
    writeToken({ open_id: "ou_msg2" });
    setRefresh({ code: 40001, msg: "UNIQUE_RESPONSE_MSG_54321" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_msg2");
    const logs = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
    expect(logs).toMatch(/UNIQUE_RESPONSE_MSG_54321/);
  });

  it("non-Error thrown string is stringified for log", async () => {
    mkTmpTokenRoot("msg-3");
    writeToken({ open_id: "ou_msg3" });
    setRefresh(() => {
      throw "plain-string-throw-UNIQUE";
    });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_msg3");
    const logs = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
    expect(logs).toMatch(/plain-string-throw-UNIQUE/);
  });

  it("log mentions feishu-oauth tag", async () => {
    mkTmpTokenRoot("msg-4");
    writeToken({ open_id: "ou_msg4" });
    setRefresh({ code: 99991671, msg: "bad" });
    await getValidUserTokenForOpenId(ACCOUNT, "ou_msg4");
    const logs = [...spyWarn.mock.calls, ...spyError.mock.calls].flat().map(String).join("\n");
    expect(logs).toMatch(/feishu-oauth/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Section 12: Dedup behavior under fast retry
// ─────────────────────────────────────────────────────────────────

describe("dedup retry patterns", () => {
  it("first call fails → second call retries (dedup map cleared)", async () => {
    mkTmpTokenRoot("retry-1");
    writeToken({ open_id: "ou_r1" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return { code: 0, data: { access_token: `at_retry_${calls}`, expires_in: 7200 } };
    });
    const a = await getValidUserTokenForOpenId(ACCOUNT, "ou_r1");
    expect(a).toBeNull();
    const b = await getValidUserTokenForOpenId(ACCOUNT, "ou_r1");
    expect(b?.access_token).toBe("at_retry_2");
  });

  it("concurrent first batch fails → subsequent batch retries", async () => {
    mkTmpTokenRoot("retry-2");
    writeToken({ open_id: "ou_r2" });
    let calls = 0;
    setRefresh(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      if (calls === 1) return { code: 99991671, msg: "fail" };
      return { code: 0, data: { access_token: "at_ok", expires_in: 7200 } };
    });
    const batch1 = await Promise.all([
      getValidUserTokenForOpenId(ACCOUNT, "ou_r2"),
      getValidUserTokenForOpenId(ACCOUNT, "ou_r2"),
    ]);
    expect(batch1.every((x) => x === null)).toBe(true);
    const b = await getValidUserTokenForOpenId(ACCOUNT, "ou_r2");
    expect(b?.access_token).toBe("at_ok");
    expect(calls).toBe(2);
  });

  it("dedup doesn't deadlock on sync throw in client call", async () => {
    mkTmpTokenRoot("sync-throw");
    writeToken({ open_id: "ou_st" });
    setRefresh(() => {
      throw new Error("sync boom");
    });
    const a = await getValidUserTokenForOpenId(ACCOUNT, "ou_st");
    expect(a).toBeNull();
    // Should be able to call again without hanging
    const b = await getValidUserTokenForOpenId(ACCOUNT, "ou_st");
    expect(b).toBeNull();
  });
});
