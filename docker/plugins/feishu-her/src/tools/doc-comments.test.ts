import { describe, expect, it, vi, beforeEach } from "vitest";

const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());
const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  handleFeishuTokenError: vi.fn((_err, _account, _uri) => null),
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

const fakeAccount = {
  accountId: "default",
  appId: "cli_test",
  appSecret: "secret",
  enabled: true,
  configured: true,
};

function createMockApi() {
  const tools: Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }> =
    new Map();
  return {
    config: { channels: { feishu: { appId: "cli_test", appSecret: "secret" } } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerTool(def: {
      name: string;
      execute: (id: string, params: unknown) => Promise<unknown>;
    }) {
      tools.set(def.name, def);
    },
    getTool(name: string) {
      return tools.get(name);
    },
  };
}

describe("feishu_doc_comments tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listEnabledFeishuAccountsMock.mockReturnValue([fakeAccount]);
    // getValidUserToken returns Promise<FeishuUserToken | null>
    getValidUserTokenMock.mockResolvedValue({ access_token: "user-token-123", open_id: "ou_test" });
    // requireUserToken wraps getValidUserToken and returns { ok, token } or { ok, authResponse }
    requireUserTokenMock.mockResolvedValue({
      ok: true,
      token: { access_token: "user-token-123", open_id: "ou_test" },
    });
    resolveOAuthRedirectUriMock.mockReturnValue("http://localhost:9999/callback");
  });

  async function setup() {
    const { registerFeishuDocCommentsTools } = await import("./doc-comments.js");
    // oxlint-disable-next-line typescript/no-explicit-any
    const api = createMockApi() as any;
    registerFeishuDocCommentsTools(api);
    const tool = api.getTool("feishu_doc_comments");
    expect(tool).toBeDefined();
    return tool!;
  }

  it("lists comments for a docx", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            comment_id: "c1",
            is_solved: false,
            reply_list: { replies: [{ reply_id: "r1", content: { elements: [] } }] },
          },
        ],
        has_more: false,
      },
    });

    const tool = await setup();
    const result = await tool.execute("call1", {
      action: "list",
      file_token: "doxcnABC123",
      file_type: "docx",
    });

    // Should have called the list endpoint
    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/drive/v1/files/doxcnABC123/comments",
      }),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].comment_id).toBe("c1");
  });

  it("creates a comment with plain text", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      data: { comment_id: "c2" },
    });

    const tool = await setup();
    const result = await tool.execute("call2", {
      action: "create",
      file_token: "doxcnABC123",
      file_type: "docx",
      content: "Please review this section.",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/drive/v1/files/doxcnABC123/comments",
        body: {
          reply_list: {
            replies: [
              {
                content: {
                  elements: [
                    { type: "text_run", text_run: { text: "Please review this section." } },
                  ],
                },
              },
            ],
          },
        },
      }),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.comment_id).toBe("c2");
  });

  it("creates a comment with @mention", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      data: { comment_id: "c3" },
    });

    const tool = await setup();
    await tool.execute("call3", {
      action: "create",
      file_token: "doxcnABC123",
      file_type: "docx",
      content: "Check this: ",
      mention_open_id: "ou_abc123",
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          reply_list: {
            replies: [
              {
                content: {
                  elements: [
                    { type: "text_run", text_run: { text: "Check this: " } },
                    { type: "person", person: { user_id: "ou_abc123" } },
                  ],
                },
              },
            ],
          },
        },
      }),
    );
  });

  it("patches (resolves) a comment", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValue({ code: 0 });

    const tool = await setup();
    const result = await tool.execute("call4", {
      action: "patch",
      file_token: "doxcnABC123",
      file_type: "docx",
      comment_id: "c1",
      is_solved_value: true,
    });

    expect(callFeishuApiWithUserTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PATCH",
        endpoint: "/drive/v1/files/doxcnABC123/comments/c1",
        body: { is_solved: true },
      }),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
  });

  it("resolves wiki token before operating", async () => {
    // First call: wiki node resolution
    // Second call: actual list
    callFeishuApiWithUserTokenMock
      .mockResolvedValueOnce({
        code: 0,
        data: { node: { obj_token: "doxcnREAL456", obj_type: "docx", title: "My Wiki Page" } },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [], has_more: false },
      });

    const tool = await setup();
    await tool.execute("call5", {
      action: "list",
      file_token: "wikcnWIKI789",
      file_type: "wiki",
    });

    // First: wiki resolution
    expect(callFeishuApiWithUserTokenMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        endpoint: "/wiki/v2/spaces/get_node",
        query: { token: "wikcnWIKI789" },
      }),
    );
    // Second: list with resolved token
    expect(callFeishuApiWithUserTokenMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        endpoint: "/drive/v1/files/doxcnREAL456/comments",
      }),
    );
  });

  it("returns auth response when no user token", async () => {
    requireUserTokenMock.mockResolvedValue({
      ok: false,
      authResponse: { content: [{ type: "text", text: "auth required" }] },
    });

    const tool = await setup();
    const result = await tool.execute("call6", {
      action: "list",
      file_token: "abc",
      file_type: "docx",
    });

    expect(result.content[0].text).toBe("auth required");
  });

  it("returns error for create without content", async () => {
    const tool = await setup();
    const result = await tool.execute("call7", {
      action: "create",
      file_token: "abc",
      file_type: "docx",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("content is required");
  });

  it("returns error for patch without comment_id", async () => {
    const tool = await setup();
    const result = await tool.execute("call8", {
      action: "patch",
      file_token: "abc",
      file_type: "docx",
      is_solved_value: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("comment_id is required");
  });

  it("skips registration when no accounts configured", async () => {
    listEnabledFeishuAccountsMock.mockReturnValue([]);
    const { registerFeishuDocCommentsTools } = await import("./doc-comments.js");
    // oxlint-disable-next-line typescript/no-explicit-any
    const api = createMockApi() as any;
    registerFeishuDocCommentsTools(api);
    expect(api.getTool("feishu_doc_comments")).toBeUndefined();
  });
});
