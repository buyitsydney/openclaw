import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const downloadFeishuMessageResourceWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenForOpenIdMock = vi.hoisted(() => vi.fn());
const requireUserTokenMock = vi.hoisted(() => vi.fn());
const resolveOAuthRedirectUriMock = vi.hoisted(() => vi.fn());
const getFeishuClientMock = vi.hoisted(() => vi.fn());
const downloadFeishuFileMock = vi.hoisted(() => vi.fn());
const downloadFeishuImageMock = vi.hoisted(() => vi.fn());
const parseOfficeMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));

vi.mock("../oauth.js", () => ({
  callFeishuApiWithUserToken: callFeishuApiWithUserTokenMock,
  downloadFeishuMessageResourceWithUserToken: downloadFeishuMessageResourceWithUserTokenMock,
  getValidUserToken: getValidUserTokenMock,
  getValidUserTokenForOpenId: getValidUserTokenForOpenIdMock,
  requireUserToken: requireUserTokenMock,
  resolveOAuthRedirectUri: resolveOAuthRedirectUriMock,
}));

vi.mock("../outbound.js", () => ({
  getFeishuClient: getFeishuClientMock,
  downloadFeishuFile: downloadFeishuFileMock,
  downloadFeishuImage: downloadFeishuImageMock,
}));

vi.mock("officeparser", () => ({
  parseOffice: parseOfficeMock,
}));

import { registerFeishuChatHistoryTool } from "./chat-history.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

type ToolContext = {
  requesterSenderId?: string;
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

function getTool(
  registerTool: ReturnType<typeof vi.fn>,
  name: string,
  context: ToolContext = {},
): ToolDef {
  const tools = registerTool.mock.calls
    .flatMap((call) => {
      const entry = call[0] as ToolDef | ((ctx: ToolContext) => ToolDef | ToolDef[] | null | undefined);
      const resolved = typeof entry === "function" ? entry(context) : entry;
      if (!resolved) return [];
      return Array.isArray(resolved) ? resolved : [resolved];
    })
    .filter(Boolean) as ToolDef[];
  const tool = tools.find((item) => item.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

function createFileMessage(params: {
  messageId: string;
  chatId: string;
  fileKey: string;
  fileName: string;
}) {
  return {
    message_id: params.messageId,
    msg_type: "file",
    chat_id: params.chatId,
    create_time: "1772930795127",
    sender: {
      id: "cli_test_bot",
      sender_type: "app",
    },
    body: {
      content: JSON.stringify({
        file_key: params.fileKey,
        file_name: params.fileName,
      }),
    },
  };
}

function createMergeForwardMessage(params: { messageId: string; chatId: string }) {
  return {
    message_id: params.messageId,
    msg_type: "merge_forward",
    chat_id: params.chatId,
    create_time: "1772930795127",
    sender: {
      id: "ou_merge_sender",
      sender_type: "user",
    },
    body: {
      content: "Merged and Forwarded Message",
    },
  };
}

describe("feishu group history archive hydration", () => {
  let stateDir: string;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  beforeEach(async () => {
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-chat-history-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    listEnabledFeishuAccountsMock.mockReturnValue([
      {
        accountId: "default",
        appId: "cli_test_bot",
        appSecret: "secret_test",
        enabled: true,
        config: {},
      },
    ]);
    getValidUserTokenMock.mockResolvedValue({
      access_token: "user_token",
      open_id: "ou_user",
    });
    getValidUserTokenForOpenIdMock.mockResolvedValue({
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
    });
    downloadFeishuImageMock.mockResolvedValue({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("list_history leaves missing bot-sent xlsx as a placeholder", async () => {
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [
          createFileMessage({
            messageId: "om_hist_1",
            chatId: "oc_hist_1",
            fileKey: "file_hist_1",
            fileName: "sheet.xlsx",
          }),
        ],
        has_more: false,
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const first = await tool.execute("tc_hist_1", {
      action: "list_history",
      chat_id: "oc_hist_1",
    });
    const firstDetails = first.details as {
      messages: Array<{ text: string; coverage: string }>;
    };

    expect(firstDetails.messages[0].text).toBe("[file: sheet.xlsx]");
    expect(firstDetails.messages[0].coverage).toBe("partial");
    expect(downloadFeishuFileMock).not.toHaveBeenCalled();

    const archivePath = path.join(stateDir, "feishu-groups", "oc_hist_1", "messages.jsonl");
    await expect(fs.readFile(archivePath, "utf-8")).rejects.toThrow();
  });

  it("list_history reuses existing xlsx archive without downloading", async () => {
    const archiveDir = path.join(stateDir, "feishu-groups", "oc_hist_1");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, "messages.jsonl"),
      `${JSON.stringify({
        ts: 1772930795,
        sender: "cli_test_bot",
        senderId: "cli_test_bot",
        text: '<file name="sheet.xlsx">\nSheet A1\n</file>\n[file: sheet.xlsx saved at /tmp/sheet.xlsx]',
        msgId: "om_hist_1",
        messageType: "file",
      })}\n`,
      "utf-8",
    );
    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [
          createFileMessage({
            messageId: "om_hist_1",
            chatId: "oc_hist_1",
            fileKey: "file_hist_1",
            fileName: "sheet.xlsx",
          }),
        ],
        has_more: false,
      },
    });

    const second = await tool.execute("tc_hist_2", {
      action: "list_history",
      chat_id: "oc_hist_1",
    });
    const secondDetails = second.details as {
      messages: Array<{ text: string }>;
    };

    expect(downloadFeishuFileMock).not.toHaveBeenCalled();
    expect(secondDetails.messages[0].text).toContain("Sheet A1");
  });

  it("list_thread hydrates generic binary files using the message chat_id", async () => {
    downloadFeishuFileMock.mockResolvedValue({
      buffer: Buffer.from("rar"),
      contentType: "application/octet-stream",
    });
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [
          createFileMessage({
            messageId: "om_thread_1",
            chatId: "oc_thread_1",
            fileKey: "file_thread_1",
            fileName: "archive.rar",
          }),
        ],
        has_more: false,
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const result = await tool.execute("tc_thread", {
      action: "list_thread",
      thread_id: "ot_thread_1",
    });
    const details = result.details as {
      messages: Array<{ text: string }>;
    };

    expect(details.messages[0].text).toContain("archive.rar");
    expect(details.messages[0].text).toContain("saved at");
    await expect(
      fs.readFile(path.join(stateDir, "feishu-groups", "oc_thread_1", "messages.jsonl"), "utf-8"),
    ).resolves.toContain('"msgId":"om_thread_1"');
  });

  it("get_message hydrates single file messages", async () => {
    downloadFeishuFileMock.mockResolvedValue({
      buffer: Buffer.from("csv"),
      contentType: "text/csv",
    });
    callFeishuApiWithUserTokenMock.mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [
          createFileMessage({
            messageId: "om_get_1",
            chatId: "oc_get_1",
            fileKey: "file_get_1",
            fileName: "report.csv",
          }),
        ],
      },
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const result = await tool.execute("tc_get", {
      action: "get_message",
      message_id: "om_get_1",
    });
    const details = result.details as {
      message: { text: string };
    };

    expect(details.message.text).toContain("report.csv");
    expect(details.message.text).toContain("saved at");
    await expect(
      fs.readFile(path.join(stateDir, "feishu-groups", "oc_get_1", "messages.jsonl"), "utf-8"),
    ).resolves.toContain('"msgId":"om_get_1"');
  });

  it("list_history keeps merge_forward disabled", async () => {
    parseOfficeMock.mockResolvedValue({
      content: [{ type: "text", text: "Deck slide body" }],
      attachments: [],
    });
    downloadFeishuMessageResourceWithUserTokenMock.mockResolvedValue({
      buffer: Buffer.from("pptx"),
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    callFeishuApiWithUserTokenMock.mockImplementation(async (params: { endpoint: string }) => {
      if (params.endpoint === "/im/v1/messages") {
        return {
          code: 0,
          msg: "ok",
          data: {
            items: [createMergeForwardMessage({ messageId: "om_merge_hist_1", chatId: "oc_merge_hist_1" })],
            has_more: false,
          },
        };
      }
      if (params.endpoint === "/im/v1/messages/om_merge_hist_1") {
        return {
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_merge_hist_1",
                msg_type: "merge_forward",
                chat_id: "oc_merge_hist_1",
                body: { content: "Merged and Forwarded Message" },
              },
              {
                message_id: "om_merge_hist_sub_1",
                upper_message_id: "om_merge_hist_1",
                msg_type: "text",
                create_time: "1000",
                body: { content: JSON.stringify({ text: "alpha" }) },
              },
              {
                message_id: "om_merge_hist_sub_2",
                upper_message_id: "om_merge_hist_1",
                msg_type: "file",
                create_time: "2000",
                body: {
                  content: JSON.stringify({
                    file_key: "file_merge_hist_nested_1",
                    file_name: "deck.pptx",
                  }),
                },
              },
            ],
          },
        };
      }
      if (params.endpoint === "/im/v1/messages/om_merge_hist_sub_2") {
        return {
          code: 0,
          msg: "ok",
          data: {
            items: [
              createFileMessage({
                messageId: "om_merge_hist_sub_2",
                chatId: "oc_source_hist_1",
                fileKey: "file_merge_hist_source_1",
                fileName: "deck.pptx",
              }),
            ],
          },
        };
      }
      throw new Error(`unexpected endpoint ${params.endpoint}`);
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const result = await tool.execute("tc_merge_hist", {
      action: "list_history",
      chat_id: "oc_merge_hist_1",
    });
    const details = result.details as {
      messages: Array<{ text: string; coverage: string }>;
    };

    expect(details.messages[0].text).toBe("[merged forward disabled]");
    expect(details.messages[0].coverage).toBe("none");
    expect(downloadFeishuMessageResourceWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("get_message keeps merge_forward disabled", async () => {
    parseOfficeMock.mockResolvedValue({
      content: [{ type: "text", text: "Board sheet body" }],
      attachments: [],
    });
    downloadFeishuMessageResourceWithUserTokenMock.mockResolvedValue({
      buffer: Buffer.from("xlsx"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    callFeishuApiWithUserTokenMock.mockImplementation(async (params: { endpoint: string }) => {
      if (params.endpoint === "/im/v1/messages/om_merge_get_1") {
        return {
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                message_id: "om_merge_get_1",
                msg_type: "merge_forward",
                chat_id: "oc_merge_get_1",
                body: { content: "Merged and Forwarded Message" },
              },
              {
                message_id: "om_merge_get_sub_1",
                upper_message_id: "om_merge_get_1",
                msg_type: "text",
                create_time: "1000",
                body: { content: JSON.stringify({ text: "beta" }) },
              },
              {
                message_id: "om_merge_get_sub_2",
                upper_message_id: "om_merge_get_1",
                msg_type: "file",
                create_time: "2000",
                body: {
                  content: JSON.stringify({
                    file_key: "file_merge_get_nested_1",
                    file_name: "board.xlsx",
                  }),
                },
              },
            ],
          },
        };
      }
      if (params.endpoint === "/im/v1/messages/om_merge_get_sub_2") {
        return {
          code: 0,
          msg: "ok",
          data: {
            items: [
              createFileMessage({
                messageId: "om_merge_get_sub_2",
                chatId: "oc_source_get_1",
                fileKey: "file_merge_get_source_1",
                fileName: "board.xlsx",
              }),
            ],
          },
        };
      }
      throw new Error(`unexpected endpoint ${params.endpoint}`);
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const result = await tool.execute("tc_merge_get", {
      action: "get_message",
      message_id: "om_merge_get_1",
    });
    const details = result.details as {
      message: { text: string; coverage: string };
    };

    expect(details.message.text).toBe("[merged forward disabled]");
    expect(details.message.coverage).toBe("none");
    expect(downloadFeishuMessageResourceWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("get_message still binds requesterSenderId while merge_forward stays disabled", async () => {
    parseOfficeMock.mockResolvedValue({
      content: [{ type: "text", text: "Requester deck body" }],
      attachments: [],
    });
    getValidUserTokenMock.mockResolvedValue({
      access_token: "wrong_token",
      open_id: "ou_wrong",
    });
    getValidUserTokenForOpenIdMock.mockImplementation(async (_account: unknown, openId: string) => {
      if (openId !== "ou_requester") return null;
      return {
        access_token: "requester_token",
        open_id: "ou_requester",
      };
    });
    requireUserTokenMock.mockImplementation(async (params: { tokenPromise: Promise<unknown> }) => {
      const token = await params.tokenPromise;
      if (!token) {
        return {
          ok: false,
          authResponse: {
            content: [{ type: "text" as const, text: "auth required" }],
            details: { error: "user_auth_required" },
          },
        };
      }
      return { ok: true, token };
    });
    callFeishuApiWithUserTokenMock.mockImplementation(
      async (params: { endpoint: string; userToken: string }) => {
        if (params.userToken !== "requester_token" && params.userToken !== "wrong_token") {
          throw new Error(`unexpected token ${params.userToken}`);
        }
        if (params.endpoint === "/im/v1/messages/om_merge_requester_1") {
          return {
            code: 0,
            msg: "ok",
            data: {
              items: [
                {
                  message_id: "om_merge_requester_1",
                  msg_type: "merge_forward",
                  chat_id: "oc_merge_requester_1",
                  body: { content: "Merged and Forwarded Message" },
                },
                {
                  message_id: "om_merge_requester_sub_1",
                  upper_message_id: "om_merge_requester_1",
                  msg_type: "text",
                  create_time: "1000",
                  body: { content: JSON.stringify({ text: "alpha" }) },
                },
                {
                  message_id: "om_merge_requester_sub_2",
                  upper_message_id: "om_merge_requester_1",
                  msg_type: "file",
                  create_time: "2000",
                  body: {
                    content: JSON.stringify({
                      file_key: "file_merge_requester_nested_1",
                      file_name: "deck.pptx",
                    }),
                  },
                },
              ],
            },
          };
        }
        if (params.endpoint === "/im/v1/messages/om_merge_requester_sub_2") {
          return {
            code: 0,
            msg: "ok",
            data: {
              items: [
                createFileMessage({
                  messageId: "om_merge_requester_sub_2",
                  chatId: "oc_source_requester_1",
                  fileKey: "file_merge_requester_source_1",
                  fileName: "deck.pptx",
                }),
              ],
            },
          };
        }
        throw new Error(`unexpected endpoint ${params.endpoint}`);
      },
    );
    downloadFeishuMessageResourceWithUserTokenMock.mockImplementation(
      async (params: { userToken: string; messageId: string; fileKey: string; type: string }) => {
        if (params.userToken !== "requester_token") {
          throw new Error(
            'feishu user resource download failed: HTTP 400 {"code":230002,"msg":"Bot/User can NOT be out of the chat."}',
          );
        }
        return {
          buffer: Buffer.from("pptx"),
          contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        };
      },
    );

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history", {
      requesterSenderId: "ou_requester",
    });

    const result = await tool.execute("tc_merge_requester", {
      action: "get_message",
      message_id: "om_merge_requester_1",
    });
    const details = result.details as {
      message: { text: string; coverage: string };
    };

    expect(details.message.text).toBe("[merged forward disabled]");
    expect(details.message.coverage).toBe("none");
    expect(getValidUserTokenForOpenIdMock).toHaveBeenCalledWith(expect.anything(), "ou_requester");
    expect(downloadFeishuMessageResourceWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("list_history does not tenant-fallback to expand merge_forward", async () => {
    parseOfficeMock.mockResolvedValue({
      content: [{ type: "text", text: "Tenant deck body" }],
      attachments: [],
    });
    downloadFeishuMessageResourceWithUserTokenMock.mockResolvedValue({
      buffer: Buffer.from("pptx"),
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const tenantGetMock = vi.fn().mockImplementation(async (params: { path: { message_id: string } }) => {
      if (params.path.message_id === "om_merge_fallback_hist_1") {
        return {
          code: 0,
          data: {
            items: [
              {
                message_id: "om_merge_fallback_hist_1",
                msg_type: "merge_forward",
                chat_id: "oc_merge_fallback_hist_1",
                body: { content: "Merged and Forwarded Message" },
              },
              {
                message_id: "om_merge_fallback_hist_sub_1",
                upper_message_id: "om_merge_fallback_hist_1",
                msg_type: "text",
                create_time: "1000",
                body: { content: JSON.stringify({ text: "alpha" }) },
              },
              {
                message_id: "om_merge_fallback_hist_sub_2",
                upper_message_id: "om_merge_fallback_hist_1",
                msg_type: "file",
                create_time: "2000",
                body: {
                  content: JSON.stringify({
                    file_key: "file_merge_fallback_hist_nested_1",
                    file_name: "deck.pptx",
                  }),
                },
              },
            ],
          },
        };
      }
      if (params.path.message_id === "om_merge_fallback_hist_sub_2") {
        return {
          code: 0,
          data: {
            items: [
              createFileMessage({
                messageId: "om_merge_fallback_hist_sub_2",
                chatId: "oc_source_fallback_hist_1",
                fileKey: "file_merge_fallback_hist_source_1",
                fileName: "deck.pptx",
              }),
            ],
          },
        };
      }
      throw new Error(`unexpected tenant message ${params.path.message_id}`);
    });
    getFeishuClientMock.mockReturnValue({
      tokenManager: {
        getTenantAccessToken: vi.fn().mockResolvedValue("tenant_token"),
      },
      im: {
        message: {
          get: tenantGetMock,
        },
      },
    });
    callFeishuApiWithUserTokenMock.mockImplementation(async (params: { endpoint: string }) => {
      if (params.endpoint === "/im/v1/messages") {
        return {
          code: 0,
          msg: "ok",
          data: {
            items: [
              createMergeForwardMessage({
                messageId: "om_merge_fallback_hist_1",
                chatId: "oc_merge_fallback_hist_1",
              }),
            ],
            has_more: false,
          },
        };
      }
      if (params.endpoint.startsWith("/im/v1/messages/om_merge_fallback_hist_")) {
        return {
          code: 230001,
          msg: "this operation to bots is currently not supported.",
        };
      }
      throw new Error(`unexpected endpoint ${params.endpoint}`);
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const result = await tool.execute("tc_merge_hist_fallback", {
      action: "list_history",
      chat_id: "oc_merge_fallback_hist_1",
    });
    const details = result.details as {
      messages: Array<{ text: string; coverage: string }>;
    };

    expect(details.messages[0].text).toBe("[merged forward disabled]");
    expect(details.messages[0].coverage).toBe("none");
    expect(tenantGetMock).not.toHaveBeenCalled();
    expect(downloadFeishuMessageResourceWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("get_message falls back to tenant token when user token message.get is unsupported", async () => {
    parseOfficeMock.mockResolvedValue({
      content: [{ type: "text", text: "Tenant board body" }],
      attachments: [],
    });
    downloadFeishuMessageResourceWithUserTokenMock.mockResolvedValue({
      buffer: Buffer.from("xlsx"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const tenantGetMock = vi.fn().mockImplementation(async (params: { path: { message_id: string } }) => {
      if (params.path.message_id === "om_merge_get_fallback_1") {
        return {
          code: 0,
          data: {
            items: [
              {
                message_id: "om_merge_get_fallback_1",
                msg_type: "merge_forward",
                chat_id: "oc_merge_get_fallback_1",
                body: { content: "Merged and Forwarded Message" },
              },
              {
                message_id: "om_merge_get_fallback_sub_1",
                upper_message_id: "om_merge_get_fallback_1",
                msg_type: "text",
                create_time: "1000",
                body: { content: JSON.stringify({ text: "beta" }) },
              },
              {
                message_id: "om_merge_get_fallback_sub_2",
                upper_message_id: "om_merge_get_fallback_1",
                msg_type: "file",
                create_time: "2000",
                body: {
                  content: JSON.stringify({
                    file_key: "file_merge_get_fallback_nested_1",
                    file_name: "board.xlsx",
                  }),
                },
              },
            ],
          },
        };
      }
      if (params.path.message_id === "om_merge_get_fallback_sub_2") {
        return {
          code: 0,
          data: {
            items: [
              createFileMessage({
                messageId: "om_merge_get_fallback_sub_2",
                chatId: "oc_source_get_fallback_1",
                fileKey: "file_merge_get_fallback_source_1",
                fileName: "board.xlsx",
              }),
            ],
          },
        };
      }
      throw new Error(`unexpected tenant message ${params.path.message_id}`);
    });
    getFeishuClientMock.mockReturnValue({
      tokenManager: {
        getTenantAccessToken: vi.fn().mockResolvedValue("tenant_token"),
      },
      im: {
        message: {
          get: tenantGetMock,
        },
      },
    });
    callFeishuApiWithUserTokenMock.mockImplementation(async (params: { endpoint: string }) => {
      if (params.endpoint.startsWith("/im/v1/messages/om_merge_get_fallback_")) {
        return {
          code: 230001,
          msg: "this operation to bots is currently not supported.",
        };
      }
      throw new Error(`unexpected endpoint ${params.endpoint}`);
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const result = await tool.execute("tc_merge_get_fallback", {
      action: "get_message",
      message_id: "om_merge_get_fallback_1",
    });
    const details = result.details as {
      message: { text: string; coverage: string };
    };

    expect(details.message.text).toBe("[merged forward disabled]");
    expect(details.message.coverage).toBe("none");
    expect(tenantGetMock).toHaveBeenCalledWith({
      path: { message_id: "om_merge_get_fallback_1" },
    });
    expect(tenantGetMock).not.toHaveBeenCalledWith({
      path: { message_id: "om_merge_get_fallback_sub_2" },
    });
    expect(downloadFeishuMessageResourceWithUserTokenMock).not.toHaveBeenCalled();
  });

  it("list_history does not resurrect stale merge_forward archive text", async () => {
    const archiveDir = path.join(stateDir, "feishu-groups", "oc_merge_archive_refresh_1");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(
      path.join(archiveDir, "messages.jsonl"),
      `${JSON.stringify({
        ts: 1772930795,
        sender: "ou_merge_sender",
        senderId: "ou_merge_sender",
        text: "Merged and Forwarded Message",
        msgId: "om_merge_archive_refresh_1",
      })}\n`,
      "utf-8",
    );

    const tenantGetMock = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_merge_archive_refresh_1",
            msg_type: "merge_forward",
            chat_id: "oc_merge_archive_refresh_1",
            body: { content: "Merged and Forwarded Message" },
          },
          {
            message_id: "om_merge_archive_refresh_sub_1",
            upper_message_id: "om_merge_archive_refresh_1",
            msg_type: "text",
            create_time: "1000",
            body: { content: JSON.stringify({ text: "alpha" }) },
          },
        ],
      },
    });
    getFeishuClientMock.mockReturnValue({
      tokenManager: {
        getTenantAccessToken: vi.fn().mockResolvedValue("tenant_token"),
      },
      im: {
        message: {
          get: tenantGetMock,
        },
      },
    });
    callFeishuApiWithUserTokenMock.mockImplementation(async (params: { endpoint: string }) => {
      if (params.endpoint === "/im/v1/messages") {
        return {
          code: 0,
          msg: "ok",
          data: {
            items: [
              createMergeForwardMessage({
                messageId: "om_merge_archive_refresh_1",
                chatId: "oc_merge_archive_refresh_1",
              }),
            ],
            has_more: false,
          },
        };
      }
      if (params.endpoint === "/im/v1/messages/om_merge_archive_refresh_1") {
        return {
          code: 230001,
          msg: "this operation to bots is currently not supported.",
        };
      }
      throw new Error(`unexpected endpoint ${params.endpoint}`);
    });

    const { api, registerTool } = createApi();
    registerFeishuChatHistoryTool(api);
    const tool = getTool(registerTool, "feishu_group_history");

    const result = await tool.execute("tc_merge_archive_refresh", {
      action: "list_history",
      chat_id: "oc_merge_archive_refresh_1",
    });
    const details = result.details as {
      messages: Array<{ text: string; coverage: string }>;
    };

    expect(details.messages[0].text).toBe("[merged forward disabled]");
    expect(details.messages[0].coverage).toBe("none");
    await expect(
      fs.readFile(path.join(archiveDir, "messages.jsonl"), "utf-8"),
    ).resolves.not.toContain("[merged forward disabled]");
  });
});
