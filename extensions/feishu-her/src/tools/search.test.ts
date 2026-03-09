import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());
const resolveDriveShareUrlMock = vi.hoisted(() => vi.fn());

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

import { registerFeishuSearchTool } from "./search.js";

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

describe("feishu_search tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    resolveDriveShareUrlMock.mockResolvedValue({
      ok: true,
      share_url: "https://example.feishu.cn/docx/doc_drive_1",
      meta: {},
    });
  });

  it("returns auth response when user oauth is missing", async () => {
    requireUserTokenMock.mockResolvedValueOnce({
      ok: false,
      authResponse: {
        content: [{ type: "text", text: "auth" }],
        details: { error: "user_auth_required", auth_url: "https://example.com/auth" },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuSearchTool(api);
    const tool = getTool(registerTool, "feishu_search");

    const result = await tool.execute("tc_auth", { query: "test" });

    expect(result.details).toEqual({
      error: "user_auth_required",
      auth_url: "https://example.com/auth",
    });
    expect(callFeishuApiWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("merges drive and wiki results with source tags", async () => {
    callFeishuApiWithUserTokenMock
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          docs_entities: [
            {
              docs_token: "doc_drive_1",
              docs_type: "docx",
              owner_id: "ou_owner",
              title: "企业知识在her之间共享",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          items: [
            {
              node_id: "wiki_node_1",
              obj_token: "wiki_obj_1",
              obj_type: 8,
              space_id: "space_1",
              title: "飞书搜索架构",
              url: "https://example.feishu.cn/wiki/wiki_node_1",
            },
          ],
        },
      });

    const { api, registerTool } = createApi();
    registerFeishuSearchTool(api);
    const tool = getTool(registerTool, "feishu_search");

    const result = await tool.execute("tc_merge", { query: "搜索", limit: 10 });
    const details = result.details as {
      query: string;
      source_limits: { drive: number; wiki: number };
      counts: { drive: number; wiki: number; merged: number };
      results: Array<Record<string, unknown>>;
    };

    expect(details.query).toBe("搜索");
    expect(details.source_limits).toEqual({ drive: 5, wiki: 5 });
    expect(details.counts).toEqual({ drive: 1, wiki: 1, merged: 2 });
    expect(details.results).toEqual([
      {
        source: "drive",
        title: "企业知识在her之间共享",
        object_type: "docx",
        drive_doc_token: "doc_drive_1",
        owner_id: "ou_owner",
        url: "https://example.feishu.cn/docx/doc_drive_1",
      },
      {
        source: "wiki",
        title: "飞书搜索架构",
        object_type: "wiki_node",
        wiki_node_id: "wiki_node_1",
        wiki_space_id: "space_1",
        wiki_obj_token: "wiki_obj_1",
        wiki_obj_type_raw: 8,
        url: "https://example.feishu.cn/wiki/wiki_node_1",
      },
    ]);
    expect(callFeishuApiWithUserTokenMock).toHaveBeenNthCalledWith(1, {
      method: "POST",
      endpoint: "/suite/docs-api/search/object",
      userToken: "user_token",
      body: {
        search_key: "搜索",
        count: 5,
        offset: 0,
        owner_ids: [],
        docs_types: ["doc", "docx", "sheet", "slides", "mindnote", "file"],
      },
    });
    expect(resolveDriveShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default" }),
      "doc_drive_1",
      "docx",
    );
    expect(callFeishuApiWithUserTokenMock).toHaveBeenNthCalledWith(2, {
      method: "POST",
      endpoint: "/wiki/v2/nodes/search",
      userToken: "user_token",
      body: {
        query: "搜索",
      },
      query: {
        page_size: "5",
      },
    });
  });

  it("supports drive-only scope", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "success",
      data: {
        docs_entities: [
          {
            docs_token: "doc_drive_1",
            docs_type: "docx",
            title: "企业知识在her之间共享",
          },
        ],
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuSearchTool(api);
    const tool = getTool(registerTool, "feishu_search");

    const result = await tool.execute("tc_drive_only", { query: "企业知识", scope: "drive" });
    const details = result.details as { counts: { drive: number; wiki: number; merged: number } };

    expect(details.counts).toEqual({ drive: 1, wiki: 0, merged: 1 });
    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledOnce();
    expect(resolveDriveShareUrlMock).toHaveBeenCalledOnce();
  });

  it("passes optional wiki space_id to wiki search", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "success",
      data: {
        items: [
          {
            node_id: "wiki_node_1",
            title: "飞书搜索架构",
          },
        ],
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuSearchTool(api);
    const tool = getTool(registerTool, "feishu_search");

    await tool.execute("tc_wiki_space", {
      query: "飞书搜索架构",
      scope: "wiki",
      space_id: "space_1",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/wiki/v2/nodes/search",
      userToken: "user_token",
      body: {
        query: "飞书搜索架构",
        space_id: "space_1",
      },
      query: {
        page_size: "10",
      },
    });
  });

  it("keeps drive result and surfaces resolve error when url resolution fails", async () => {
    resolveDriveShareUrlMock.mockResolvedValueOnce({
      ok: false,
      error: "drive_meta_batch_query_missing_url",
    });
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "success",
      data: {
        docs_entities: [
          {
            docs_token: "doc_drive_1",
            docs_type: "docx",
            title: "企业知识在her之间共享",
          },
        ],
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuSearchTool(api);
    const tool = getTool(registerTool, "feishu_search");

    const result = await tool.execute("tc_drive_url_err", { query: "企业知识", scope: "drive" });
    const details = result.details as { results: Array<Record<string, unknown>> };

    expect(details.results).toEqual([
      {
        source: "drive",
        title: "企业知识在her之间共享",
        object_type: "docx",
        drive_doc_token: "doc_drive_1",
        url_resolve_error: "drive_meta_batch_query_missing_url",
      },
    ]);
  });

  it("includes bitable when include_bitable is true", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "success",
      data: {
        docs_entities: [
          {
            docs_token: "bitable_1",
            docs_type: "bitable",
            title: "项目管理表",
          },
        ],
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuSearchTool(api);
    const tool = getTool(registerTool, "feishu_search");

    await tool.execute("tc_bitable", {
      query: "项目管理",
      scope: "drive",
      include_bitable: true,
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/suite/docs-api/search/object",
      userToken: "user_token",
      body: {
        search_key: "项目管理",
        count: 10,
        offset: 0,
        owner_ids: [],
        docs_types: [],
      },
    });
  });

  it("keeps wiki results visible under all-scope 5+5 quota", async () => {
    resolveDriveShareUrlMock.mockImplementation(async (_account, token) => ({
      ok: true,
      share_url: `https://example.feishu.cn/docx/${token}`,
      meta: {},
    }));
    callFeishuApiWithUserTokenMock
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          docs_entities: Array.from({ length: 8 }, (_, index) => ({
            docs_token: `doc_drive_${index + 1}`,
            docs_type: "docx",
            title: `Drive ${index + 1}`,
          })),
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        msg: "success",
        data: {
          items: [
            {
              node_id: "wiki_node_1",
              title: "飞书搜索架构",
              url: "https://example.feishu.cn/wiki/wiki_node_1",
            },
          ],
        },
      });

    const { api, registerTool } = createApi();
    registerFeishuSearchTool(api);
    const tool = getTool(registerTool, "feishu_search");

    const result = await tool.execute("tc_quota", { query: "search api", scope: "all", limit: 10 });
    const details = result.details as {
      source_limits: { drive: number; wiki: number };
      counts: { drive: number; wiki: number; merged: number };
      results: Array<Record<string, unknown>>;
    };

    expect(details.source_limits).toEqual({ drive: 5, wiki: 5 });
    expect(details.counts).toEqual({ drive: 8, wiki: 1, merged: 6 });
    expect(details.results).toHaveLength(6);
    expect(details.results[5]).toEqual({
      source: "wiki",
      title: "飞书搜索架构",
      object_type: "wiki_node",
      wiki_node_id: "wiki_node_1",
      url: "https://example.feishu.cn/wiki/wiki_node_1",
    });
  });
});
