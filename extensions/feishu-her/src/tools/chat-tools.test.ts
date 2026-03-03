import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const callChatApiMock = vi.hoisted(() => vi.fn());

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

import { registerFeishuChatCapabilityTool } from "./chat-capability.js";
import { registerFeishuChatControlTools } from "./chat-controls.js";
import { registerFeishuChatManageTools } from "./chat-manage.js";
import { registerFeishuChatMemberTools } from "./chat-members.js";
import { registerFeishuChatPinTools } from "./chat-pins.js";
import { registerFeishuChatTabTools } from "./chat-tabs.js";
import { registerFeishuChatTopNoticeTools } from "./chat-top-notice.js";

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

describe("feishu chat tools", () => {
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
    callChatApiMock.mockResolvedValue({
      ok: true,
      code: 0,
      msg: "ok",
      data: { id: "x" },
      http_status: 200,
      method: "POST",
      endpoint: "/im/v1/chats",
    });
  });

  it("chat_manage create routes to /im/v1/chats", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatManageTools(api);
    const tool = getTool(registerTool, "feishu_chat_manage");

    await tool.execute("tc1", { action: "create", name: "perm-test" });

    expect(callChatApiMock).toHaveBeenCalledTimes(1);
    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/im/v1/chats",
        query: { user_id_type: "open_id" },
        body: {
          name: "perm-test",
          chat_type: "private",
          chat_mode: "group",
        },
      }),
    );
  });

  it("chat_manage create rejects missing name", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatManageTools(api);
    const tool = getTool(registerTool, "feishu_chat_manage");

    const result = await tool.execute("tc2", { action: "create" });
    const details = result.details as { ok?: boolean; msg?: string };

    expect(details.ok).toBe(false);
    expect(details.msg).toContain("name is required");
    expect(callChatApiMock).not.toHaveBeenCalled();
  });

  it("chat_members add_managers routes correctly", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatMemberTools(api);
    const tool = getTool(registerTool, "feishu_chat_members");

    await tool.execute("tc3", {
      action: "add_managers",
      chat_id: "oc_123",
      ids: ["ou_1"],
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/im/v1/chats/oc_123/managers/add_managers",
        body: { manager_ids: ["ou_1"] },
      }),
    );
  });

  it("chat_controls get_menu_tree routes correctly", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatControlTools(api);
    const tool = getTool(registerTool, "feishu_chat_controls");

    await tool.execute("tc4", {
      action: "get_menu_tree",
      chat_id: "oc_456",
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/im/v1/chats/oc_456/menu_tree",
      }),
    );
  });

  it("chat_tabs add url routes correctly", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatTabTools(api);
    const tool = getTool(registerTool, "feishu_chat_tabs");

    await tool.execute("tc5", {
      action: "add",
      chat_id: "oc_789",
      tab_name: "tab1",
      tab_type: "url",
      url: "https://open.feishu.cn",
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/im/v1/chats/oc_789/chat_tabs",
      }),
    );
  });

  it("chat_pins unpin routes correctly", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatPinTools(api);
    const tool = getTool(registerTool, "feishu_chat_pins");

    await tool.execute("tc6", {
      action: "unpin",
      message_id: "om_123",
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        endpoint: "/im/v1/pins/om_123",
      }),
    );
  });

  it("chat_capability returns known pending list", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatCapabilityTool(api);
    const tool = getTool(registerTool, "feishu_chat_capability");

    const result = await tool.execute("tc7", { action: "status" });
    const details = result.details as {
      ok?: boolean;
      data?: { pending_unmapped?: string[] };
    };

    expect(details.ok).toBe(true);
    expect(details.data?.pending_unmapped).toContain("im:chat.widgets:read");
  });

  it("chat_top_notice put message routes correctly", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatTopNoticeTools(api);
    const tool = getTool(registerTool, "feishu_chat_top_notice");

    await tool.execute("tc8", {
      action: "put",
      chat_id: "oc_top_1",
      notice_type: "message",
      message_id: "om_top_1",
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/im/v1/chats/oc_top_1/top_notice/put_top_notice",
        body: {
          chat_top_notice: [{ action_type: "1", message_id: "om_top_1" }],
        },
      }),
    );
  });

  it("chat_top_notice delete routes correctly", async () => {
    const { api, registerTool } = createApi();
    registerFeishuChatTopNoticeTools(api);
    const tool = getTool(registerTool, "feishu_chat_top_notice");

    await tool.execute("tc9", {
      action: "delete",
      chat_id: "oc_top_2",
    });

    expect(callChatApiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/im/v1/chats/oc_top_2/top_notice/delete_top_notice",
      }),
    );
  });
});
