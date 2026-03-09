import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "./accounts.js";

const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const createArchiveTextForBufferMock = vi.hoisted(() => vi.fn());

vi.mock("./oauth.js", () => ({
  getValidUserToken: getValidUserTokenMock,
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
}));

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("./group-archive.js", () => ({
  createArchiveTextForBuffer: createArchiveTextForBufferMock,
}));

import { buildDriveFileContextFromText, extractDriveFileLinks } from "./drive-file-read.js";

describe("drive file read", () => {
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

  it("extracts unique feishu drive file links from text", () => {
    expect(
      extractDriveFileLinks(
        [
          "请读这个：https://tenant.feishu.cn/file/ABC123?from=share。",
          "重复一次 https://tenant.feishu.cn/file/ABC123",
          "还有另一个 https://tenant.feishu.cn/file/XYZ789)",
        ].join(" "),
      ),
    ).toEqual([
      {
        token: "ABC123",
        url: "https://tenant.feishu.cn/file/ABC123?from=share",
      },
      {
        token: "XYZ789",
        url: "https://tenant.feishu.cn/file/XYZ789",
      },
    ]);
  });

  it("builds a file block for a pdf drive link", async () => {
    getValidUserTokenMock.mockResolvedValueOnce({ access_token: "user_token" });
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      data: {
        metas: [{ title: "CL-31-07 任职资格管理办法 A1.pdf" }],
      },
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(Buffer.from("%PDF-1.7 mock"), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
      release: vi.fn().mockResolvedValue(undefined),
    });
    createArchiveTextForBufferMock.mockResolvedValueOnce(
      '<file name="CL-31-07 任职资格管理办法 A1.pdf">\n任职资格管理办法 CL-31-07\n</file>',
    );

    const context = await buildDriveFileContextFromText({
      account,
      text: "请阅读 https://tenant.feishu.cn/file/SDu7bCSpIo2SaIxdDZmcZT07nOc",
    });

    expect(context).toContain('<file name="CL-31-07 任职资格管理办法 A1.pdf">');
    expect(context).toContain("任职资格管理办法 CL-31-07");
    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/drive/v1/metas/batch_query",
      userToken: "user_token",
      body: {
        request_docs: [{ doc_token: "SDu7bCSpIo2SaIxdDZmcZT07nOc", doc_type: "file" }],
        with_url: true,
      },
    });
    expect(createArchiveTextForBufferMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      contentType: "application/pdf",
      fileName: "CL-31-07 任职资格管理办法 A1.pdf",
      defaultBaseName: "feishu-drive-file",
      includePathLine: false,
    });
  });

  it("returns a deterministic error block when user auth is missing", async () => {
    getValidUserTokenMock.mockResolvedValueOnce(null);

    const context = await buildDriveFileContextFromText({
      account,
      text: "请阅读 https://tenant.feishu.cn/file/NoAuth123",
    });

    expect(context).toContain("drive file read failed");
    expect(context).toContain("missing Feishu user authorization");
  });
});
