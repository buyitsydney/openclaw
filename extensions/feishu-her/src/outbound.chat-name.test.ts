import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "./accounts.js";

const account: ResolvedFeishuAccount = {
  accountId: "default",
  knownBots: {},
  enabled: true,
  appId: "cli_test",
  appSecret: "sec_test",
  credentialSource: "config",
  config: {},
};

describe("feishu chat name refresh", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@larksuiteoapi/node-sdk");
  });

  it("re-fetches the current name for the same chat after a rename", async () => {
    const getChatMock = vi
      .fn()
      .mockResolvedValueOnce({ data: { name: "群名A" } })
      .mockResolvedValueOnce({ data: { name: "群名B" } });

    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      AppType: { SelfBuild: "SelfBuild" },
      Domain: { Feishu: "Feishu" },
      Client: vi.fn(function Client() {
        return {
          im: {
            chat: {
              get: getChatMock,
            },
          },
        };
      }),
    }));

    const { getFeishuChatName } = await import("./outbound.js");

    await expect(getFeishuChatName(account, "oc_test_room")).resolves.toBe("群名A");
    await expect(getFeishuChatName(account, "oc_test_room")).resolves.toBe("群名B");
    expect(getChatMock).toHaveBeenCalledTimes(2);
    expect(getChatMock).toHaveBeenNthCalledWith(1, { path: { chat_id: "oc_test_room" } });
    expect(getChatMock).toHaveBeenNthCalledWith(2, { path: { chat_id: "oc_test_room" } });
  });
});
