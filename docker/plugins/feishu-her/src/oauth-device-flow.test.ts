/**
 * v7 Device Flow tests — real unit tests that import & exercise actual
 * oauth.ts functions, not tautology.
 *
 * Superseded v6c tests which were all `expect(200).toBe(200)` self-proving.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  __deviceFlowInternals,
  initiateDeviceFlow,
  pollDeviceToken,
  __clearScopeCacheForTests,
  type DeviceFlowInit,
} from "./oauth";

const { selectDeviceFlowScopes, DROP_DOMAINS_V6F, DEVICE_FLOW_MAX_SCOPES } =
  __deviceFlowInternals;

const mockAccount = () =>
  ({
    accountId: "test",
    appId: "cli_test",
    appSecret: "secret_test",
    providerKey: "feishu",
    providerLabel: "feishu",
  }) as any;

const mockInit = (overrides: Partial<DeviceFlowInit> = {}): DeviceFlowInit => ({
  deviceCode: "dc_test",
  userCode: "XXXX-YYYY",
  verificationUri: "https://passport.feishu.cn/oauth/v1/device/verify",
  verificationUriComplete: "https://passport.feishu.cn/oauth/v1/device/verify?user_code=XXXX-YYYY",
  expiresIn: 60,
  interval: 1,
  scopeCount: 199,
  ...overrides,
});

describe("v7 selectDeviceFlowScopes", () => {
  it("drops all mail domain scopes", () => {
    const backend = new Set([
      "mail:user_mailbox.message:readonly",
      "mail:user_mailbox.folder:read",
      "wiki:space:retrieve",
      "calendar:calendar:read",
    ]);
    const picked = selectDeviceFlowScopes(backend);
    expect(picked).not.toContain("mail:user_mailbox.message:readonly");
    expect(picked).not.toContain("mail:user_mailbox.folder:read");
    expect(picked).toContain("wiki:space:retrieve");
    expect(picked).toContain("calendar:calendar:read");
  });

  it("drops all aily domain scopes", () => {
    const backend = new Set([
      "aily:data_asset:read",
      "aily:file:write",
      "aily:session:read",
      "im:message:send_as_bot",
    ]);
    const picked = selectDeviceFlowScopes(backend);
    expect(picked.filter((s) => s.startsWith("aily:"))).toEqual([]);
    expect(picked).toContain("im:message:send_as_bot");
  });

  it("keeps all non-{mail,aily} scopes when input <= 200", () => {
    const backend = new Set<string>();
    for (let i = 0; i < 150; i++) backend.add(`calendar:scope_${i}:read`);
    backend.add("mail:drop_me:read");
    backend.add("aily:drop_me:read");
    const picked = selectDeviceFlowScopes(backend);
    expect(picked.length).toBe(150);
    expect(picked.every((s) => s.startsWith("calendar:"))).toBe(true);
  });

  it("alphabetical-truncates when > 200 scopes remain after drop", () => {
    const backend = new Set<string>();
    for (let i = 0; i < 250; i++) {
      backend.add(`z_domain_${String(i).padStart(4, "0")}:scope:read`);
    }
    backend.add("aaa_priority:scope:read");
    const picked = selectDeviceFlowScopes(backend);
    expect(picked.length).toBe(200);
    expect(picked[0]).toBe("aaa_priority:scope:read");
  });

  it("returns empty array on empty input", () => {
    expect(selectDeviceFlowScopes(new Set())).toEqual([]);
  });

  it("returns empty array when ALL scopes are in DROP_DOMAINS_V6F", () => {
    const backend = new Set([
      "mail:foo:read",
      "mail:bar:write",
      "aily:baz:read",
    ]);
    expect(selectDeviceFlowScopes(backend)).toEqual([]);
  });

  it("DROP_DOMAINS_V6F contains exactly mail+aily", () => {
    expect(Array.from(DROP_DOMAINS_V6F).sort()).toEqual(["aily", "mail"]);
  });

  it("DEVICE_FLOW_MAX_SCOPES matches Feishu hard cap 200", () => {
    expect(DEVICE_FLOW_MAX_SCOPES).toBe(200);
  });
});

describe("v7 pollDeviceToken RFC 8628 behaviors", () => {
  beforeEach(() => {
    __clearScopeCacheForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("authorization_pending then success: fetches user_info and returns token", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string) => {
      call++;
      if (url.includes("/oauth/token")) {
        if (call === 1) {
          return {
            ok: true,
            json: async () => ({ error: "authorization_pending" }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            access_token: "t1",
            refresh_token: "rt1",
            token_type: "Bearer",
            expires_in: 7200,
            refresh_expires_in: 86400,
          }),
        } as Response;
      }
      if (url.includes("/authen/v1/user_info")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: { open_id: "ou_test", name: "tester" },
          }),
        } as Response;
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollDeviceToken(mockAccount(), mockInit());
    await vi.runAllTimersAsync();
    const tok = await promise;
    expect(tok).not.toBeNull();
    expect(tok?.open_id).toBe("ou_test");
    expect(tok?.access_token).toBe("t1");
  });

  it("expired_token → returns null (terminal)", async () => {
    vi.stubGlobal("fetch", async () =>
      ({
        ok: true,
        json: async () => ({ error: "expired_token" }),
      }) as Response,
    );
    const promise = pollDeviceToken(mockAccount(), mockInit());
    await vi.runAllTimersAsync();
    const tok = await promise;
    expect(tok).toBeNull();
  });

  it("access_denied → returns null (terminal)", async () => {
    vi.stubGlobal("fetch", async () =>
      ({
        ok: true,
        json: async () => ({ error: "access_denied" }),
      }) as Response,
    );
    const promise = pollDeviceToken(mockAccount(), mockInit());
    await vi.runAllTimersAsync();
    const tok = await promise;
    expect(tok).toBeNull();
  });

  it("refuse-to-save when user_info has no open_id", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/oauth/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "t1",
            refresh_token: "rt1",
            token_type: "Bearer",
            expires_in: 7200,
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ code: 0, data: {} }),
      } as Response;
    });
    const promise = pollDeviceToken(mockAccount(), mockInit());
    await vi.runAllTimersAsync();
    const tok = await promise;
    expect(tok).toBeNull();
  });
});

describe("v7 initiateDeviceFlow scope POST body", () => {
  beforeEach(() => {
    __clearScopeCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs scope in body with space-separated values, mail dropped", async () => {
    let capturedScope = "";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("/tenant_access_token")) {
        return {
          ok: true,
          json: async () => ({ code: 0, tenant_access_token: "tat_x", expire: 7200 }),
        } as Response;
      }
      if (url.includes("/application/scope/list")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              scopes: {
                user: [
                  { scope: "wiki:space:retrieve" },
                  { scope: "mail:user_mailbox.message:readonly" },
                  { scope: "calendar:calendar:read" },
                ],
                tenant: [],
              },
            },
          }),
        } as Response;
      }
      if (url.includes("/oauth/v1/device_authorization")) {
        const body = init?.body;
        if (body instanceof URLSearchParams) capturedScope = body.get("scope") ?? "";
        else if (typeof body === "string") capturedScope = new URLSearchParams(body).get("scope") ?? "";
        return {
          ok: true,
          json: async () => ({
            device_code: "dc_x",
            user_code: "XXXX-YYYY",
            verification_uri: "https://passport.feishu.cn/oauth/v1/device/verify",
            verification_uri_complete: "https://passport.feishu.cn/oauth/v1/device/verify?user_code=XXXX-YYYY",
            expires_in: 600,
            interval: 5,
          }),
        } as Response;
      }
      throw new Error(`unexpected ${url}`);
    });

    const res = await initiateDeviceFlow(mockAccount());
    expect(res).toBeTruthy();
    expect(res.userCode).toBe("XXXX-YYYY");
    expect(res.deviceCode).toBe("dc_x");
    expect(capturedScope).toContain("wiki:space:retrieve");
    expect(capturedScope).toContain("calendar:calendar:read");
    expect(capturedScope).not.toContain("mail:");
  });
});
