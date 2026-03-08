import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const callFeishuApiWithUserTokenMock = vi.hoisted(() => vi.fn());
const getValidUserTokenMock = vi.hoisted(() => vi.fn());
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
  getValidUserToken: getValidUserTokenMock,
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

  it("list_history downloads missing bot-sent xlsx once and reuses archive afterwards", async () => {
    parseOfficeMock.mockResolvedValue({
      content: [{ type: "text", text: "Sheet A1" }],
      attachments: [],
    });
    downloadFeishuFileMock.mockResolvedValue({
      buffer: Buffer.from("xlsx"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
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
      messages: Array<{ text: string }>;
    };

    expect(firstDetails.messages[0].text).toContain("Sheet A1");
    expect(firstDetails.messages[0].text).toContain("[local archive:");
    expect(firstDetails.messages[0].text).toContain("saved at");
    expect(downloadFeishuFileMock).toHaveBeenCalledOnce();

    const archivePath = path.join(stateDir, "feishu-groups", "oc_hist_1", "messages.jsonl");
    await expect(fs.readFile(archivePath, "utf-8")).resolves.toContain('"msgId":"om_hist_1"');

    callFeishuApiWithUserTokenMock.mockClear();
    downloadFeishuFileMock.mockClear();
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
});
