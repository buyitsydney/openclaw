import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const callChatApiMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());
  handleFeishuTokenError: vi.fn(() => null),
vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("./chat-api.js", async () => {
  const actual = await vi.importActual<typeof import("./chat-api.js")>("./chat-api.js");
  return {
    ...actual,
    callChatApi: callChatApiMock,
  };
});

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

import { registerFeishuSheetTools } from "./sheet.js";

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

describe("feishu sheet tool", () => {
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
    callChatApiMock.mockResolvedValue({
      ok: true,
      code: 0,
      msg: "ok",
      data: { id: "x" },
      http_status: 200,
      method: "GET",
      endpoint: "/x",
    });
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: { id: "x" },
    });
  });

  it("registers feishu_sheet tool", () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);

    const tool = getTool(registerTool, "feishu_sheet");
    expect(tool.name).toBe("feishu_sheet");
  });

  it("get_share_url resolves canonical share URL via drive meta batch query", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValueOnce({
      code: 0,
      msg: "Success",
      data: {
        metas: [
          {
            doc_token: "shtShare1",
            doc_type: "sheet",
            url: "https://tenant.feishu.cn/sheets/shtShare1",
          },
        ],
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    const result = await tool.execute("tc_share", {
      action: "get_share_url",
      spreadsheet_token: "shtShare1",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/drive/v1/metas/batch_query",
        userToken: "user_token",
        body: {
          request_docs: [{ doc_token: "shtShare1", doc_type: "sheet" }],
          with_url: true,
        },
      }),
    );

    const details = result.details as {
      ok?: boolean;
      data?: { share_url?: string; spreadsheetToken?: string };
    };
    expect(details.ok).toBe(true);
    expect(details.data?.spreadsheetToken).toBe("shtShare1");
    expect(details.data?.share_url).toBe("https://tenant.feishu.cn/sheets/shtShare1");
  });

  it("get_meta accepts URL and routes to metainfo endpoint", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    await tool.execute("tc1", {
      action: "get_meta",
      url: "https://sample.feishu.cn/sheets/shtAbc123?sheet=0b12",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/sheets/v2/spreadsheets/shtAbc123/metainfo",
        userToken: "user_token",
      }),
    );
  });

  it("read_range encodes range path and passes render query", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    await tool.execute("tc2", {
      action: "read_range",
      spreadsheet_token: "shtRead1",
      range: "5e859b!A1:B2",
      value_render_option: "Formula",
      date_time_render_option: "FormattedString",
      user_id_type: "open_id",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/sheets/v2/spreadsheets/shtRead1/values/5e859b%21A1%3AB2",
        userToken: "user_token",
        query: {
          valueRenderOption: "Formula",
          dateTimeRenderOption: "FormattedString",
          user_id_type: "open_id",
        },
      }),
    );
  });

  it("read_ranges joins ranges as comma-separated query", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    await tool.execute("tc3", {
      action: "read_ranges",
      spreadsheet_token: "shtRead2",
      ranges: ["5e859b!A1:B1", "5e859b!A2:B2"],
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/sheets/v2/spreadsheets/shtRead2/values_batch_get",
        userToken: "user_token",
        query: {
          ranges: "5e859b!A1:B1,5e859b!A2:B2",
        },
      }),
    );
  });

  it("write_range routes to values endpoint", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    await tool.execute("tc4", {
      action: "write_range",
      spreadsheet_token: "shtWrite1",
      range: "5e859b!A1:B2",
      values: [["k1", "v1"]],
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        endpoint: "/sheets/v2/spreadsheets/shtWrite1/values",
        body: {
          valueRange: {
            range: "5e859b!A1:B2",
            values: [["k1", "v1"]],
          },
        },
      }),
    );
  });

  it("write_ranges routes to values_batch_update endpoint", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    await tool.execute("tc5", {
      action: "write_ranges",
      spreadsheet_token: "shtWrite2",
      value_ranges: [
        { range: "5e859b!A1:B1", values: [["k1", "v1"]] },
        { range: "5e859b!A2:B2", values: [["k2", "v2"]] },
      ],
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/sheets/v2/spreadsheets/shtWrite2/values_batch_update",
        body: {
          valueRanges: [
            { range: "5e859b!A1:B1", values: [["k1", "v1"]] },
            { range: "5e859b!A2:B2", values: [["k2", "v2"]] },
          ],
        },
      }),
    );
  });

  it("append routes to values_append endpoint with insertDataOption", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    await tool.execute("tc6", {
      action: "append",
      spreadsheet_token: "shtAppend1",
      range: "5e859b!A:A",
      values: [["row1"]],
      insert_data_option: "INSERT_ROWS",
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/sheets/v2/spreadsheets/shtAppend1/values_append",
        query: {
          insertDataOption: "INSERT_ROWS",
        },
        body: {
          valueRange: {
            range: "5e859b!A:A",
            values: [["row1"]],
          },
        },
      }),
    );
  });

  it("append rejects non-column range before API call", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    const result = await tool.execute("tc_append_bad_range", {
      action: "append",
      spreadsheet_token: "shtAppendBad1",
      range: "5e859b!A1",
      values: [["row1"]],
    });

    const details = result.details as { ok?: boolean; msg?: string };
    expect(details.ok).toBe(false);
    expect(details.msg).toContain("append range must be column range");
    expect(callChatApiMock).not.toHaveBeenCalled();
  });

  it("returns local error for invalid write_range params", async () => {
    const { api, registerTool } = createApi();
    registerFeishuSheetTools(api);
    const tool = getTool(registerTool, "feishu_sheet");

    const result = await tool.execute("tc7", {
      action: "write_range",
      spreadsheet_token: "shtBad1",
      values: [["x"]],
    });
    const details = result.details as { ok?: boolean; msg?: string };

    expect(details.ok).toBe(false);
    expect(details.msg).toContain("range is required");
    expect(callChatApiMock).not.toHaveBeenCalled();
  });

  it("does not register tool when no enabled account", () => {
    listEnabledFeishuAccountsMock.mockReturnValue([]);
    const { api, registerTool } = createApi();

    registerFeishuSheetTools(api);

    expect(registerTool).not.toHaveBeenCalled();
  });
});
