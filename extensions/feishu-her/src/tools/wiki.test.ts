import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveDriveShareUrlMock = vi.hoisted(() => vi.fn());
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

vi.mock("./share-url.js", () => ({
  resolveDriveShareUrl: resolveDriveShareUrlMock,
}));

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

import { registerFeishuWikiTools } from "./wiki.js";

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

describe("feishu wiki tool", () => {
  const mockClient = {
    wiki: {
      space: {
        list: vi.fn(),
        getNode: vi.fn(),
      },
      spaceNode: {
        list: vi.fn(),
        create: vi.fn(),
        move: vi.fn(),
        updateTitle: vi.fn(),
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listEnabledFeishuAccountsMock.mockReturnValue([
      {
        accountId: "default",
        appId: "cli_test",
        appSecret: "secret_test",
        enabled: true,
        config: {},
      },
    ]);
    getFeishuClientMock.mockReturnValue(mockClient);
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
      share_url: "https://tenant.feishu.cn/wiki/token",
      meta: {},
    });
    callFeishuApiWithUserTokenMock.mockImplementation(async (request: { endpoint: string }) => {
      if (request.endpoint === "/wiki/v2/spaces/get_node") {
        return {
          code: 0,
          msg: "ok",
          data: {
            node: {
              node_token: "wikiNode1",
              obj_token: "docxToken1",
              obj_type: "docx",
              title: "Wiki Node",
            },
          },
        };
      }
      return {
        code: 0,
        msg: "ok",
        data: {
          items: [],
        },
      };
    });
    mockClient.wiki.space.getNode.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        node: {
          node_token: "wikiNode1",
          obj_token: "docxToken1",
          obj_type: "docx",
          title: "Wiki Node",
        },
      },
    });
    mockClient.wiki.spaceNode.create.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        node: {
          node_token: "wikiNode2",
          obj_token: "docxToken2",
          obj_type: "docx",
          title: "New Wiki Node",
        },
      },
    });
    mockClient.wiki.spaceNode.updateTitle.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {},
    });
  });

  it("get returns node data without resolving share url", async () => {
    const { api, registerTool } = createApi();
    registerFeishuWikiTools(api);
    const tool = getTool(registerTool, "feishu_wiki");

    const result = await tool.execute("tc_get", {
      action: "get",
      token: "wikiNode1",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/wiki/v2/spaces/get_node",
      userToken: "user_token",
      query: { token: "wikiNode1" },
    });
    expect(resolveDriveShareUrlMock).not.toHaveBeenCalled();

    const details = result.details as { obj_token?: string; share_url?: string };
    expect(details.obj_token).toBe("docxToken1");
    expect(details.share_url).toBeUndefined();
  });

  it("create returns node data without resolving share url", async () => {
    const { api, registerTool } = createApi();
    registerFeishuWikiTools(api);
    const tool = getTool(registerTool, "feishu_wiki");

    const result = await tool.execute("tc_create", {
      action: "create",
      space_id: "space123",
      title: "New Wiki Node",
      obj_type: "docx",
      parent_node_token: "parentNode123",
    });

    expect(mockClient.wiki.spaceNode.create).toHaveBeenCalledWith({
      path: { space_id: "space123" },
      data: {
        obj_type: "docx",
        node_type: "origin",
        title: "New Wiki Node",
        parent_node_token: "parentNode123",
      },
    });
    expect(resolveDriveShareUrlMock).not.toHaveBeenCalled();

    const details = result.details as { node_token?: string; share_url?: string };
    expect(details.node_token).toBe("wikiNode2");
    expect(details.share_url).toBeUndefined();
  });

  it("resolve_url calls drive meta query and returns share_url", async () => {
    const { api, registerTool } = createApi();
    registerFeishuWikiTools(api);
    const tool = getTool(registerTool, "feishu_wiki");

    const result = await tool.execute("tc_resolve_url", {
      action: "resolve_url",
      token: "wikiNode3",
    });

    expect(resolveDriveShareUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default" }),
      "wikiNode3",
      "wiki",
      { userToken: "user_token" },
    );

    const details = result.details as { share_url?: string };
    expect(details.share_url).toBe("https://tenant.feishu.cn/wiki/token");
  });

  it("rename rejects missing required fields deterministically", async () => {
    const { api, registerTool } = createApi();
    registerFeishuWikiTools(api);
    const tool = getTool(registerTool, "feishu_wiki");

    const missingSpace = await tool.execute("tc_rename_1", {
      action: "rename",
      node_token: "node_1",
      title: "new title",
    });
    expect((missingSpace.details as { error?: string }).error).toContain("space_id is required");

    const missingNode = await tool.execute("tc_rename_2", {
      action: "rename",
      space_id: "space_1",
      title: "new title",
    });
    expect((missingNode.details as { error?: string }).error).toContain("node_token is required");

    const missingTitle = await tool.execute("tc_rename_3", {
      action: "rename",
      space_id: "space_1",
      node_token: "node_1",
    });
    expect((missingTitle.details as { error?: string }).error).toContain("title is required");
    expect(mockClient.wiki.spaceNode.updateTitle).not.toHaveBeenCalled();
  });

  it("rename succeeds with required space_id, node_token and title", async () => {
    const { api, registerTool } = createApi();
    registerFeishuWikiTools(api);
    const tool = getTool(registerTool, "feishu_wiki");

    const result = await tool.execute("tc_rename_ok", {
      action: "rename",
      space_id: "space_1",
      node_token: "node_1",
      title: "renamed",
    });

    expect(mockClient.wiki.spaceNode.updateTitle).toHaveBeenCalledWith({
      path: { space_id: "space_1", node_token: "node_1" },
      data: { title: "renamed" },
    });
    expect((result.details as { success?: boolean }).success).toBe(true);
  });
});
