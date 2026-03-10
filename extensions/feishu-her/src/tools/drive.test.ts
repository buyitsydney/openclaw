import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());
const callChatApiMock = vi.hoisted(() => vi.fn());
const resolveDriveShareUrlMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
}));

vi.mock("./chat-api.js", () => ({
  callChatApi: callChatApiMock,
}));

vi.mock("./share-url.js", () => ({
  resolveDriveShareUrl: resolveDriveShareUrlMock,
}));

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

import { registerFeishuDriveTools } from "./drive.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

type JsonResult = {
  ok: boolean;
  code: number;
  msg: string;
  data: unknown;
  http_status: number;
  method: string;
  endpoint: string;
};

describe("feishu-her feishu_drive visibility guard", () => {
  const listMock = vi.hoisted(() => vi.fn());
  const createFolderMock = vi.hoisted(() => vi.fn());
  const moveMock = vi.hoisted(() => vi.fn());
  const deleteMock = vi.hoisted(() => vi.fn());
  const docxCreateMock = vi.hoisted(() => vi.fn());
  let tempDir: string | null = null;

  function registerAndGetTool() {
    const registerTool = vi.fn();
    registerFeishuDriveTools({
      config: { channels: { feishu: { enabled: true } } },
      logger: { info: vi.fn() },
      registerTool,
    } as never);

    const tool = registerTool.mock.calls
      .map((call) => call[0] as ToolDef)
      .find((t) => t.name === "feishu_drive");
    expect(tool).toBeDefined();
    return tool!;
  }

  function makeApiResult(data: unknown): JsonResult {
    return {
      ok: true,
      code: 0,
      msg: "success",
      data,
      http_status: 200,
      method: "POST",
      endpoint: "/x",
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    listEnabledFeishuAccountsMock.mockReturnValue([
      {
        accountId: "default",
        enabled: true,
        appId: "app_id",
        appSecret: "app_secret",
      },
    ]);
    getValidUserTokenMock.mockResolvedValue({
      access_token: "user_token",
      open_id: "ou_user",
    });
    requireUserTokenMock.mockResolvedValue({
      ok: true,
      token: {
        access_token: "user_token",
        open_id: "ou_user",
      },
    });
    resolveOAuthRedirectUriMock.mockReturnValue("https://example.com/callback");
    getFeishuClientMock.mockReturnValue({
      tokenManager: {
        getTenantAccessToken: vi.fn().mockResolvedValue("tenant_token"),
      },
      docx: {
        document: {
          create: docxCreateMock,
        },
      },
      drive: {
        file: {
          list: listMock,
          createFolder: createFolderMock,
          move: moveMock,
          delete: deleteMock,
        },
      },
    });
    listMock.mockResolvedValue({ code: 0, data: { files: [] } });
    createFolderMock.mockResolvedValue({ code: 0, data: { token: "fld_new", url: "u" } });
    moveMock.mockResolvedValue({ code: 0, data: { task_id: "t1" } });
    deleteMock.mockResolvedValue({ code: 0, data: { task_id: "t2" } });
    docxCreateMock.mockResolvedValue({
      code: 0,
      data: { document: { document_id: "doxcn1", revision_id: 3 } },
    });
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: {
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ code: 0, msg: "success", data: {} })),
      },
      release: vi.fn().mockResolvedValue(undefined),
    }));
    callChatApiMock.mockResolvedValue(makeApiResult({}));
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { files: [] },
    });
    resolveDriveShareUrlMock.mockResolvedValue({
      ok: true,
      share_url: "https://example.feishu.cn/file/box_1",
      meta: {},
    });
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("lists user root with deterministic folders/files split", async () => {
    const tool = registerAndGetTool();
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      data: {
        files: [
          {
            token: "fld_root_1",
            name: "测试云盘bot权限",
            type: "folder",
            owner_id: "ou_user",
            url: "https://example.feishu.cn/drive/folder/fld_root_1",
          },
          {
            token: "file_root_1",
            name: "客户工程院-罗开杰-HMI负责人.pdf",
            type: "file",
            owner_id: "ou_user",
            url: "https://example.feishu.cn/file/file_root_1",
          },
        ],
      },
    });
    const result = await tool.execute("tc1", { action: "list_root" });
    const details = result.details as {
      scope?: string;
      folder_count?: number;
      file_count?: number;
      folders?: unknown[];
      files?: unknown[];
    };

    expect(details.scope).toBe("root");
    expect(details.folder_count).toBe(1);
    expect(details.file_count).toBe(1);
    expect(details.folders).toEqual([
      {
        token: "fld_root_1",
        name: "测试云盘bot权限",
        type: "folder",
        owner_id: "ou_user",
        url: "https://example.feishu.cn/drive/folder/fld_root_1",
      },
    ]);
    expect(details.files).toEqual([
      {
        token: "file_root_1",
        name: "客户工程院-罗开杰-HMI负责人.pdf",
        type: "file",
        owner_id: "ou_user",
        url: "https://example.feishu.cn/file/file_root_1",
      },
    ]);
    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/drive/v1/files",
      userToken: "user_token",
    });
  });

  it("rejects list_root when folder_token is provided", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tc_root_bad", {
      action: "list_root",
      folder_token: "fld_shared",
    });
    const details = result.details as { error?: string };

    expect(details.error).toContain("list_root does not accept folder_token");
    expect(callFeishuApiWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("rejects create_folder with folder_token=0", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tc2", {
      action: "create_folder",
      name: "x",
      folder_token: "0",
    });
    const details = result.details as { error?: string };

    expect(details.error).toContain("requires a real folder token");
    expect(createFolderMock).not.toHaveBeenCalled();
  });

  it("lists a specific folder with deterministic folders/files split", async () => {
    const tool = registerAndGetTool();
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      data: {
        files: [
          {
            token: "fld_child_1",
            name: "技术资料",
            type: "folder",
            parent_token: "fld_shared",
          },
          {
            token: "docx_1",
            name: "方案文档",
            type: "docx",
            parent_token: "fld_shared",
          },
        ],
      },
    });
    const result = await tool.execute("tc3", { action: "list_folder", folder_token: "fld_shared" });
    const details = result.details as {
      scope?: string;
      folder_token?: string;
      folder_count?: number;
      file_count?: number;
      folders?: unknown[];
      files?: unknown[];
    };

    expect(details.scope).toBe("folder");
    expect(details.folder_token).toBe("fld_shared");
    expect(details.folder_count).toBe(1);
    expect(details.file_count).toBe(1);
    expect(details.folders).toEqual([
      {
        token: "fld_child_1",
        name: "技术资料",
        type: "folder",
        parent_token: "fld_shared",
      },
    ]);
    expect(details.files).toEqual([
      {
        token: "docx_1",
        name: "方案文档",
        type: "docx",
        parent_token: "fld_shared",
      },
    ]);
    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/drive/v1/files",
      userToken: "user_token",
      query: { folder_token: "fld_shared" },
    });
  });

  it("rejects list_folder with folder_token=root", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tc_root", { action: "list_folder", folder_token: "root" });
    const details = result.details as { error?: string };

    expect(details.error).toContain("list_folder requires a real folder token");
    expect(callFeishuApiWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("creates online sheet in shared folder", async () => {
    const tool = registerAndGetTool();
    callChatApiMock.mockResolvedValueOnce(
      makeApiResult({
        token: "shtcn1",
        url: "https://example.feishu.cn/sheets/shtcn1",
        revision: 1,
      }),
    );

    const result = await tool.execute("tc4", {
      action: "create_online",
      folder_token: "fld_shared",
      title: "预算表",
      online_type: "sheet",
    });
    const details = result.details as { token?: string; online_type?: string; url?: string };

    expect(details.token).toBe("shtcn1");
    expect(details.online_type).toBe("sheet");
    expect(details.url).toBe("https://example.feishu.cn/file/box_1");
    expect(callChatApiMock).toHaveBeenCalledWith({
      account: expect.objectContaining({ accountId: "default" }),
      method: "POST",
      endpoint: "/drive/explorer/v2/file/fld_shared",
      body: { title: "预算表", type: "sheet" },
    });
    expect(resolveDriveShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default" }),
      "shtcn1",
      "sheet",
    );
  });

  it("creates online docx in shared folder via docx API", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tc_docx", {
      action: "create_online",
      folder_token: "fld_shared",
      title: "方案文档",
      online_type: "docx",
    });
    const details = result.details as { token?: string; online_type?: string; url?: string };

    expect(details.token).toBe("doxcn1");
    expect(details.online_type).toBe("docx");
    expect(details.url).toBe("https://example.feishu.cn/file/box_1");
    expect(docxCreateMock).toHaveBeenCalledWith({
      data: { title: "方案文档", folder_token: "fld_shared" },
    });
    expect(resolveDriveShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default" }),
      "doxcn1",
      "docx",
    );
  });

  it("rejects create_online with unsupported type", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tc5", {
      action: "create_online",
      folder_token: "fld_shared",
      title: "x",
      online_type: "doc",
    });
    const details = result.details as { error?: string };

    expect(details.error).toContain("online_type must be one of");
    expect(callChatApiMock).not.toHaveBeenCalled();
  });

  it("uploads file by multipart and returns share_url", async () => {
    const tool = registerAndGetTool();
    tempDir = mkdtempSync(join(tmpdir(), "feishu-drive-test-"));
    const filePath = join(tempDir, "demo.bin");
    writeFileSync(filePath, Buffer.from("abcdefghij"));

    callChatApiMock
      .mockResolvedValueOnce(makeApiResult({ upload_id: "upload_1", block_size: 4, block_num: 3 }))
      .mockResolvedValueOnce(makeApiResult({ file_token: "box_1" }));
    resolveDriveShareUrlMock.mockResolvedValueOnce({
      ok: true,
      share_url: "https://example.feishu.cn/file/box_1",
      meta: {},
    });

    const result = await tool.execute("tc6", {
      action: "upload_file",
      folder_token: "fld_shared",
      file_path: filePath,
    });
    const details = result.details as { file_token?: string; share_url?: string };

    expect(details.file_token).toBe("box_1");
    expect(details.share_url).toBe("https://example.feishu.cn/file/box_1");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);

    const firstForm = (fetchWithSsrFGuardMock.mock.calls[0]?.[0] as { init: { body: FormData } })
      .init.body;
    expect(firstForm.get("upload_id")).toBe("upload_1");
    expect(firstForm.get("seq")).toBe("0");
    expect(firstForm.get("size")).toBe("4");

    const thirdForm = (fetchWithSsrFGuardMock.mock.calls[2]?.[0] as { init: { body: FormData } })
      .init.body;
    expect(thirdForm.get("seq")).toBe("2");
    expect(thirdForm.get("size")).toBe("2");
  });

  it("rejects upload_file with relative path", async () => {
    const tool = registerAndGetTool();
    const result = await tool.execute("tc7", {
      action: "upload_file",
      folder_token: "fld_shared",
      file_path: "demo.bin",
    });
    const details = result.details as { error?: string };

    expect(details.error).toContain("absolute path");
    expect(callChatApiMock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
