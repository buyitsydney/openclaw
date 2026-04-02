import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "../accounts.js";

const getFeishuClientMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
}));
vi.mock("openclaw/plugin-sdk/feishu", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { callChatApi } from "./chat-api.js";

const MOCK_ACCOUNT: ResolvedFeishuAccount = {
  accountId: "default",
  knownBots: {},
  enabled: true,
  appId: "cli_x",
  appSecret: "sec_x",
  credentialSource: "config",
  config: {},
};

describe("chat-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFeishuClientMock.mockReturnValue({
      tokenManager: {
        getTenantAccessToken: vi.fn().mockResolvedValue("token_x"),
      },
    });
  });

  it("normalizes success response", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: {
        status: 200,
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: { chat_id: "oc_1" },
          }),
        ),
      },
      release,
    });

    const result = await callChatApi({
      account: MOCK_ACCOUNT,
      method: "GET",
      endpoint: "/im/v1/chats/oc_1",
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.msg).toBe("ok");
    expect(result.data).toEqual({ chat_id: "oc_1" });
    expect(result.http_status).toBe(200);
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns deterministic non_json_response for invalid payload", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: {
        status: 502,
        text: vi.fn().mockResolvedValue("<html>bad gateway</html>"),
      },
      release,
    });

    const result = await callChatApi({
      account: MOCK_ACCOUNT,
      method: "GET",
      endpoint: "/im/v1/chats",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.msg).toBe("non_json_response");
    expect(result.data).toBeNull();
    expect(result.http_status).toBe(502);
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns deterministic request_failed when token missing", async () => {
    getFeishuClientMock.mockReturnValue({
      tokenManager: {
        getTenantAccessToken: vi.fn().mockResolvedValue(undefined),
      },
    });

    const result = await callChatApi({
      account: MOCK_ACCOUNT,
      method: "POST",
      endpoint: "/im/v1/chats",
      body: { name: "x", chat_type: "private", chat_mode: "group" },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(-1);
    expect(result.msg).toContain("request_failed:failed_to_get_tenant_access_token");
    expect(result.http_status).toBe(0);
  });
});
