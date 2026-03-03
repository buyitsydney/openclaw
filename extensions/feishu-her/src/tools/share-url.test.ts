import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "../accounts.js";

const callChatApiMock = vi.hoisted(() => vi.fn());

vi.mock("./chat-api.js", async () => {
  const actual = await vi.importActual<typeof import("./chat-api.js")>("./chat-api.js");
  return {
    ...actual,
    callChatApi: callChatApiMock,
  };
});

import { resolveDriveShareUrl } from "./share-url.js";

describe("resolveDriveShareUrl", () => {
  const account: ResolvedFeishuAccount = {
    accountId: "default",
    appId: "cli_test",
    appSecret: "secret_test",
    enabled: true,
    credentialSource: "config",
    config: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns canonical share url when drive meta query succeeds", async () => {
    callChatApiMock.mockResolvedValueOnce({
      ok: true,
      code: 0,
      msg: "Success",
      data: {
        metas: [
          {
            doc_token: "shtAbc",
            doc_type: "sheet",
            title: "demo",
            url: "https://tenant.feishu.cn/sheets/shtAbc",
          },
        ],
      },
      http_status: 200,
      method: "POST",
      endpoint: "/drive/v1/metas/batch_query",
    });

    const result = await resolveDriveShareUrl(account, "shtAbc", "sheet");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.share_url).toBe("https://tenant.feishu.cn/sheets/shtAbc");
    }

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/drive/v1/metas/batch_query",
        body: {
          request_docs: [{ doc_token: "shtAbc", doc_type: "sheet" }],
          with_url: true,
        },
      }),
    );
  });

  it("fails when drive meta query returns error envelope", async () => {
    callChatApiMock.mockResolvedValueOnce({
      ok: false,
      code: 999,
      msg: "denied",
      data: null,
      http_status: 403,
      method: "POST",
      endpoint: "/drive/v1/metas/batch_query",
    });

    const result = await resolveDriveShareUrl(account, "shtAbc", "sheet");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("drive_meta_batch_query_failed");
      expect(result.code).toBe(999);
      expect(result.http_status).toBe(403);
    }
  });

  it("fails when url is missing", async () => {
    callChatApiMock.mockResolvedValueOnce({
      ok: true,
      code: 0,
      msg: "ok",
      data: {
        metas: [{ doc_token: "shtAbc", doc_type: "sheet", title: "demo" }],
      },
      http_status: 200,
      method: "POST",
      endpoint: "/drive/v1/metas/batch_query",
    });

    const result = await resolveDriveShareUrl(account, "shtAbc", "sheet");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("drive_meta_batch_query_missing_url");
    }
  });

  it("fails when url host is open.feishu.cn", async () => {
    callChatApiMock.mockResolvedValueOnce({
      ok: true,
      code: 0,
      msg: "ok",
      data: {
        metas: [
          {
            doc_token: "shtAbc",
            doc_type: "sheet",
            title: "demo",
            url: "https://open.feishu.cn/wiki/abc",
          },
        ],
      },
      http_status: 200,
      method: "POST",
      endpoint: "/drive/v1/metas/batch_query",
    });

    const result = await resolveDriveShareUrl(account, "shtAbc", "sheet");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("drive_meta_batch_query_invalid_open_platform_host");
    }
  });
});
