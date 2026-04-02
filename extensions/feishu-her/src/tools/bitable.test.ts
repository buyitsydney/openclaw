import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
}));

import { registerFeishuBitableTools } from "./bitable.js";

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

describe("feishu bitable tool", () => {
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
      bitable: {
        appTableRecord: {
          create: vi.fn(),
          update: vi.fn(),
        },
      },
    });
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {},
    });
  });

  it("registers feishu_bitable tool", () => {
    const { api, registerTool } = createApi();
    registerFeishuBitableTools(api);
    const tool = getTool(registerTool, "feishu_bitable");
    expect(tool.name).toBe("feishu_bitable");
  });

  it("get_meta resolves wiki url via user token", async () => {
    callFeishuApiWithUserTokenMock
      .mockResolvedValueOnce({
        code: 0,
        msg: "ok",
        data: {
          node: {
            obj_type: "bitable",
            obj_token: "appToken1",
          },
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        msg: "ok",
        data: {
          app: {
            name: "Test Base",
          },
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        msg: "ok",
        data: {
          items: [{ table_id: "tbl1", name: "Main" }],
        },
      });

    const { api, registerTool } = createApi();
    registerFeishuBitableTools(api);
    const tool = getTool(registerTool, "feishu_bitable");

    const result = await tool.execute("tc_meta", {
      action: "get_meta",
      url: "https://sample.feishu.cn/wiki/wikiNode1",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "GET",
        endpoint: "/wiki/v2/spaces/get_node",
        userToken: "user_token",
        query: { token: "wikiNode1" },
      }),
    );
    expect(callFeishuApiWithUserTokenMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        endpoint: "/bitable/v1/apps/appToken1",
        userToken: "user_token",
      }),
    );

    const details = result.details as {
      app_token?: string;
      url_type?: string;
      tables?: Array<{ table_id: string; name: string }>;
    };
    expect(details.app_token).toBe("appToken1");
    expect(details.url_type).toBe("wiki");
    expect(details.tables).toEqual([{ table_id: "tbl1", name: "Main" }]);
  });

  it("list_fields uses user token endpoint", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      data: {
        items: [
          {
            field_id: "fld1",
            field_name: "Name",
            type: 1,
            is_primary: true,
          },
        ],
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBitableTools(api);
    const tool = getTool(registerTool, "feishu_bitable");

    const result = await tool.execute("tc_fields", {
      action: "list_fields",
      app_token: "appToken1",
      table_id: "tbl1",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/bitable/v1/apps/appToken1/tables/tbl1/fields",
        userToken: "user_token",
      }),
    );

    const details = result.details as {
      total?: number;
      fields?: Array<{ type_name: string }>;
    };
    expect(details.total).toBe(1);
    expect(details.fields?.[0]?.type_name).toBe("Text");
  });

  it("list_records uses user token endpoint", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      data: {
        items: [{ record_id: "rec1" }],
        has_more: false,
        total: 1,
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBitableTools(api);
    const tool = getTool(registerTool, "feishu_bitable");

    const result = await tool.execute("tc_records", {
      action: "list_records",
      app_token: "appToken1",
      table_id: "tbl1",
      page_size: 50,
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/bitable/v1/apps/appToken1/tables/tbl1/records",
        userToken: "user_token",
        query: { page_size: "50" },
      }),
    );

    const details = result.details as { total?: number; records?: Array<{ record_id: string }> };
    expect(details.total).toBe(1);
    expect(details.records?.[0]?.record_id).toBe("rec1");
  });

  it("get_record uses user token endpoint", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "ok",
      data: {
        record: { record_id: "rec1", fields: { Name: "Alice" } },
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuBitableTools(api);
    const tool = getTool(registerTool, "feishu_bitable");

    const result = await tool.execute("tc_record", {
      action: "get_record",
      app_token: "appToken1",
      table_id: "tbl1",
      record_id: "rec1",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/bitable/v1/apps/appToken1/tables/tbl1/records/rec1",
        userToken: "user_token",
      }),
    );

    const details = result.details as { record?: { record_id?: string } };
    expect(details.record?.record_id).toBe("rec1");
  });
});
