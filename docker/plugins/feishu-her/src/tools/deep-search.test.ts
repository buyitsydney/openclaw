import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());
  handleFeishuTokenError: vi.fn(() => null),const resolveDriveShareUrlMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

vi.mock("./share-url.js", () => ({
  resolveDriveShareUrl: resolveDriveShareUrlMock,
}));

import { registerFeishuDeepSearchTool } from "./deep-search.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

function createApi() {
  const registerTool = vi.fn();
  return {
    registerTool,
    api: {
      config: { channels: { feishu: { enabled: true } } },
      logger: { info: vi.fn() },
      registerTool,
    } as never,
  };
}

function getTool(registerTool: ReturnType<typeof vi.fn>, name: string): ToolDef {
  const tools = registerTool.mock.calls.map((call) => call[0] as ToolDef);
  const tool = tools.find((item) => item.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("feishu_deep_search tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listEnabledFeishuAccountsMock.mockReturnValue([
      { accountId: "default", enabled: true, appId: "app_id", appSecret: "app_secret" },
    ]);
    getValidUserTokenMock.mockResolvedValue({
      access_token: "user_token",
      open_id: "ou_user",
    });
    requireUserTokenMock.mockResolvedValue({
      ok: true,
      token: { access_token: "user_token", open_id: "ou_user" },
    });
    resolveOAuthRedirectUriMock.mockReturnValue("https://example.com/callback");
    resolveDriveShareUrlMock.mockResolvedValue({
      ok: true,
      share_url: "https://example.feishu.cn/docx/xxx",
      meta: {},
    });
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "success",
      data: {},
    });
  });

  it("registers feishu_deep_search tool", () => {
    const { api, registerTool } = createApi();
    registerFeishuDeepSearchTool(api);
    const calls = registerTool.mock.calls.map((c: unknown[]) => (c[0] as ToolDef).name);
    expect(calls).toContain("feishu_deep_search");
  });

  it("returns error when keywords is empty", async () => {
    const { api, registerTool } = createApi();
    registerFeishuDeepSearchTool(api);
    const tool = getTool(registerTool, "feishu_deep_search");

    const result = await tool.execute("tc_empty", { keywords: [] });
    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("keywords");
  });

  it("searches drive and wiki for each keyword in parallel", async () => {
    callFeishuApiWithUserTokenMock
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          docs_entities: [{ docs_token: "drive_1", docs_type: "docx", title: "设计文档" }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          items: [
            {
              node_id: "wiki_1",
              obj_token: "obj_1",
              title: "Wiki 搜索架构",
              url: "https://wiki.example.com/1",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: { docs_entities: [{ docs_token: "min_1", docs_type: "22", title: "AI会议纪要" }] },
      });

    const { api, registerTool } = createApi();
    registerFeishuDeepSearchTool(api);
    const tool = getTool(registerTool, "feishu_deep_search");

    const result = await tool.execute("tc_search", {
      keywords: ["搜索架构"],
      include_group_archive: false,
    });
    const details = result.details as Record<string, unknown>;

    expect(details.keywords).toEqual(["搜索架构"]);
    expect(details.total_merged).toBeGreaterThan(0);

    const results = details.results as Array<{ source: string; title: string }>;
    const sources = results.map((r) => r.source);
    expect(sources).toContain("drive");
    expect(sources).toContain("wiki");
  });

  it("deduplicates results with same token across keywords", async () => {
    // Two keywords both return the same drive doc
    callFeishuApiWithUserTokenMock
      // keyword1: drive
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          docs_entities: [{ docs_token: "same_doc", docs_type: "docx", title: "共享文档" }],
        },
      })
      // keyword1: wiki
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { items: [] } })
      // keyword1: minutes
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { docs_entities: [] } })
      // keyword2: drive (same doc)
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          docs_entities: [{ docs_token: "same_doc", docs_type: "docx", title: "共享文档" }],
        },
      })
      // keyword2: wiki
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { items: [] } })
      // keyword2: minutes
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { docs_entities: [] } });

    const { api, registerTool } = createApi();
    registerFeishuDeepSearchTool(api);
    const tool = getTool(registerTool, "feishu_deep_search");

    const result = await tool.execute("tc_dedup", {
      keywords: ["共享", "分享"],
      include_group_archive: false,
    });
    const details = result.details as Record<string, unknown>;
    const results = details.results as Array<{ token: string }>;

    const docTokens = results.filter((r) => r.token === "same_doc");
    expect(docTokens).toHaveLength(1);
  });

  it("skips minutes when include_minutes is false", async () => {
    callFeishuApiWithUserTokenMock
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { docs_entities: [] } })
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { items: [] } });

    const { api, registerTool } = createApi();
    registerFeishuDeepSearchTool(api);
    const tool = getTool(registerTool, "feishu_deep_search");

    await tool.execute("tc_no_min", {
      keywords: ["test"],
      include_minutes: false,
      include_group_archive: false,
    });

    // Drive docs + wiki + root-folder supplement (no minutes)
    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledTimes(3);
  });

  it("supplements root folder matches for drive results", async () => {
    callFeishuApiWithUserTokenMock
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { docs_entities: [] } })
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { items: [] } })
      .mockResolvedValueOnce({ code: 0, msg: "success", data: { docs_entities: [] } })
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          files: [
            {
              token: "fld_root_1",
              name: "测试bot权限",
              type: "folder",
              url: "https://example.feishu.cn/drive/folder/fld_root_1",
            },
          ],
        },
      });

    const { api, registerTool } = createApi();
    registerFeishuDeepSearchTool(api);
    const tool = getTool(registerTool, "feishu_deep_search");

    const result = await tool.execute("tc_root_folder", {
      keywords: ["测试bot权限"],
      include_group_archive: false,
    });
    const details = result.details as { results: Array<Record<string, unknown>> };
    const folderResult = details.results.find((item) => item.token === "fld_root_1");

    expect(folderResult).toMatchObject({
      source: "drive",
      title: "测试bot权限",
      token: "fld_root_1",
      url: "https://example.feishu.cn/drive/folder/fld_root_1",
      extra: {
        object_type: "folder",
        drive_doc_token: "fld_root_1",
        keyword: "测试bot权限",
        discovered_via: "root_browse",
      },
    });
  });

  it("returns auth response when user token is not available", async () => {
    requireUserTokenMock.mockResolvedValue({
      ok: false,
      authResponse: {
        content: [{ type: "text", text: "auth required" }],
        details: { user_auth_required: true, auth_url: "https://auth.example.com" },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuDeepSearchTool(api);
    const tool = getTool(registerTool, "feishu_deep_search");

    const result = await tool.execute("tc_auth", { keywords: ["test"] });
    const details = result.details as Record<string, unknown>;
    expect(details.user_auth_required).toBe(true);
  });
});
