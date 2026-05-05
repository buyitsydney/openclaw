import type { OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import type { ResolvedFeishuAccount } from "./accounts.js";

const larkState = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => unknown>,
}));
// oxlint-disable-next-line typescript/no-explicit-any
const recordSessionMetaFromInboundMock = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const contactUserGetMock = vi.hoisted(() =>
  vi.fn(async () => ({ data: { user: { name: "owner" } } })),
);
const messageGetMock = vi.hoisted(() =>
  vi.fn(async ({ path }: { path: { message_id: string } }) => ({
    code: 0,
    data: {
      items: [
        {
          message_id: path.message_id,
          chat_id: "oc_test_room",
          msg_type: "text",
          create_time: "1772930795127",
          sender: { id: "ou_owner", sender_type: "user" },
          body: { content: JSON.stringify({ text: "@_user_1 你在哪个群" }) },
          mentions: [{ key: "@_user_1", id: "cli_x", name: "her" }],
        },
      ],
    },
  })),
);
const getFeishuClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    contact: { user: { get: contactUserGetMock } },
    im: { message: { get: messageGetMock } },
  })),
);
const getFeishuChatNameMock = vi.hoisted(() => vi.fn(async () => "test"));
const buildDriveFileContextFromTextMock = vi.hoisted(() => vi.fn(async () => ""));
const downloadFeishuFileMock = vi.hoisted(() => vi.fn());
const saveMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("@larksuiteoapi/node-sdk", () => ({
  LoggerLevel: { info: "info" },
  EventDispatcher: vi.fn(function EventDispatcher() {
    return {
      register(map: Record<string, (data: unknown) => unknown>) {
        Object.assign(larkState.handlers, map);
        return this;
      },
    };
  }),
  WSClient: vi.fn(function WSClient() {
    return {
      start: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("./drive-file-read.js", () => ({
  buildDriveFileContextFromText: buildDriveFileContextFromTextMock,
}));

vi.mock("./group-archive.js", () => ({
  archiveGroupMessage: vi.fn(),
  archiveSentFeishuBinaryMessage: vi.fn(),
}));

vi.mock("./outbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbound.js")>();
  return {
    ...actual,
    getFeishuClient: getFeishuClientMock,
    getFeishuChatName: getFeishuChatNameMock,
    addFeishuReaction: vi.fn(async () => null),
    removeFeishuReaction: vi.fn(async () => {}),
    downloadFeishuFile: downloadFeishuFileMock,
  };
});

import {
  buildCurrentGroupReplyRuleText,
  buildFeishuBotIdentityBlock,
  startFeishuGateway,
} from "./gateway.js";
import { setFeishuRuntime } from "./runtime.js";

const account: ResolvedFeishuAccount = {
  accountId: "default",
  name: "her",
  knownBots: {
    cli_helper: "helper",
    cli_tester: "tester",
  },
  knownBotOpenIds: {
    ou_helper_open: "cli_helper",
    ou_her_open: "cli_x",
    ou_tester_open: "cli_tester",
  },
  botOpenId: "ou_her_open",
  enabled: true,
  appId: "cli_x",
  appSecret: "sec_x",
  credentialSource: "config",
  config: {
    name: "her",
    dm: { allowFrom: ["ou_owner"] },
    groups: { enabled: true, archive: false, ownerIds: ["ou_owner"] },
  },
};

const config = {} as OpenClawConfig;

function createRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(
          ({ accountId, peer }: { accountId: string; peer: { id: string } }) => ({
            agentId: "main",
            accountId,
            sessionKey: `agent:main:feishu:group:${peer.id}`,
          }),
        ),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-meta-test.json"),
        readSessionUpdatedAt: vi.fn(() => undefined),
        recordSessionMetaFromInbound: recordSessionMetaFromInboundMock,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => undefined),
        formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
      },
      media: {
        saveMediaBuffer: saveMediaBufferMock,
        fetchRemoteMedia: vi.fn(),
      },
    },
  };
}

function createInboundEvent(params: {
  chatId: string;
  senderId: string;
  text: string;
  messageId: string;
}) {
  return {
    message: {
      message_id: params.messageId,
      chat_id: params.chatId,
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "her",
        },
      ],
    },
    sender: {
      sender_id: { open_id: params.senderId },
      sender_type: "user",
    },
  };
}

function createDirectInboundEvent(params: {
  chatId: string;
  senderId: string;
  text: string;
  messageId: string;
}) {
  return {
    message: {
      message_id: params.messageId,
      chat_id: params.chatId,
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: params.text }),
      mentions: [],
    },
    sender: {
      sender_id: { open_id: params.senderId },
      sender_type: "user",
    },
  };
}

function createInboundFileEvent(params: {
  chatId: string;
  senderId: string;
  fileKey: string;
  fileName: string;
  messageId: string;
}) {
  return {
    message: {
      message_id: params.messageId,
      chat_id: params.chatId,
      chat_type: "group",
      message_type: "file",
      content: JSON.stringify({
        file_key: params.fileKey,
        file_name: params.fileName,
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "her",
        },
      ],
    },
    sender: {
      sender_id: { open_id: params.senderId },
      sender_type: "user",
    },
  };
}

async function waitForRecordCalls(expectedCount: number) {
  for (let i = 0; i < 50; i += 1) {
    if (recordSessionMetaFromInboundMock.mock.calls.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`recordSessionMetaFromInbound did not reach ${expectedCount} calls`);
}

describe("feishu gateway inbound session metadata", () => {
  it("builds bot identity prompt with only focused peer bots", () => {
    const block = buildFeishuBotIdentityBlock(account, {
      focusText: "请提醒 tester 去 test 群找 her",
    });

    expect(block).toContain("你是: her (app_id=cli_x, bot_open_id=ou_her_open)");
    expect(block).toContain("- tester (app_id=cli_tester, bot_open_id=ou_tester_open)");
    expect(block).not.toContain("- helper (app_id=cli_helper");
    expect(block).toContain("app_id 只用于稳定识别 bot 身份");
    expect(block).toContain("真正艾特某个 bot，必须使用它的 bot_open_id");
  });

  it("builds current group reply rules for sender plus focused peer bot mentions", () => {
    const rules = buildCurrentGroupReplyRuleText({
      account,
      senderId: "ou_owner",
      senderDisplayName: "owner",
      focusText: "请提醒 tester 去 test 群找 her",
    });

    expect(rules).toContain("你当前正在回复的人：owner（open_id=ou_owner）。");
    expect(rules).toContain('<at user_id="ou_owner">owner</at>');
    expect(rules).toContain('<at user_id="ou_tester_open">tester</at>');
    expect(rules).not.toContain('<at user_id="ou_helper_open">helper</at>');
    expect(rules).toContain("绝对不要把 app_id 填进 <at user_id");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    larkState.handlers = {};
    contactUserGetMock.mockResolvedValue({ data: { user: { name: "owner" } } });
    messageGetMock.mockImplementation(async ({ path }: { path: { message_id: string } }) => ({
      code: 0,
      data: {
        items: [
          {
            message_id: path.message_id,
            chat_id: "oc_test_room",
            msg_type: "text",
            create_time: "1772930795127",
            sender: { id: "ou_owner", sender_type: "user" },
            body: { content: JSON.stringify({ text: "@_user_1 你在哪个群" }) },
            mentions: [{ key: "@_user_1", id: "cli_x", name: "her" }],
          },
        ],
      },
    }));
    getFeishuChatNameMock.mockResolvedValue("test");
    buildDriveFileContextFromTextMock.mockResolvedValue("");
    downloadFeishuFileMock.mockResolvedValue({
      buffer: Buffer.from("xlsx"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    saveMediaBufferMock.mockResolvedValue({
      path: "/tmp/inbound/sheet.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    setFeishuRuntime(createRuntime() as never);
  });

  afterEach(() => {
    larkState.handlers = {};
  });

  it("records group session metadata with group chat identity", async () => {
    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: {} as any,
    });
    const handler = larkState.handlers["im.message.receive_v1"];
    expect(handler).toBeTypeOf("function");

    handler?.(
      createInboundEvent({
        chatId: "oc_test_room",
        senderId: "ou_owner",
        text: "@her 你在哪个群",
        messageId: "om_group_msg_1",
      }),
    );
    await waitForRecordCalls(1);

    const [call] = recordSessionMetaFromInboundMock.mock.calls;
    const params = call?.[0];
    expect(params?.sessionKey).toBe("agent:main:feishu:group:oc_test_room");
    expect(params?.ctx?.ChatType).toBe("group");
    expect(params?.ctx?.ConversationLabel).toBe("test");
    expect(params?.ctx?.GroupSubject).toBe("test");
    expect(params?.ctx?.OriginatingTo).toBe("feishu:oc_test_room");
    expect(params?.groupResolution).toEqual({
      key: "feishu:group:oc_test_room",
      channel: "feishu",
      id: "oc_test_room",
      chatType: "group",
    });

    abortController.abort();
    await gatewayPromise;
  });

  it("falls back to chat id when the group name cannot be resolved", async () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    getFeishuChatNameMock.mockResolvedValueOnce(null as any);
    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: {} as any,
    });
    const handler = larkState.handlers["im.message.receive_v1"];
    expect(handler).toBeTypeOf("function");

    handler?.(
      createInboundEvent({
        chatId: "oc_fallback_room",
        senderId: "ou_owner",
        text: "@her 再确认一次",
        messageId: "om_group_msg_2",
      }),
    );
    await waitForRecordCalls(1);

    const [call] = recordSessionMetaFromInboundMock.mock.calls;
    const params = call?.[0];
    expect(params?.ctx?.ChatType).toBe("group");
    expect(params?.ctx?.ConversationLabel).toBe("oc_fallback_room");
    expect(params?.ctx?.GroupSubject).toBe("oc_fallback_room");
    expect(params?.groupResolution?.id).toBe("oc_fallback_room");

    abortController.abort();
    await gatewayPromise;
  });

  it("injects focused bot identity in direct messages for cross-group actions", async () => {
    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: {} as any,
    });
    const handler = larkState.handlers["im.message.receive_v1"];
    expect(handler).toBeTypeOf("function");

    handler?.(
      createDirectInboundEvent({
        chatId: "oc_direct_room",
        senderId: "ou_owner",
        text: "请你去 test 群艾特 tester 和 her",
        messageId: "om_direct_msg_1",
      }),
    );
    await waitForRecordCalls(1);

    const [call] = recordSessionMetaFromInboundMock.mock.calls;
    const params = call?.[0];
    expect(params?.ctx?.BodyForAgent).toContain("[Bot Identity]");
    expect(params?.ctx?.BodyForAgent).toContain(
      "你是: her (app_id=cli_x, bot_open_id=ou_her_open)",
    );
    expect(params?.ctx?.BodyForAgent).toContain(
      "- tester (app_id=cli_tester, bot_open_id=ou_tester_open)",
    );
    expect(params?.ctx?.BodyForAgent).not.toContain("- helper (app_id=cli_helper");

    abortController.abort();
    await gatewayPromise;
  });

  it("refreshes the group label on the next inbound message after a rename", async () => {
    getFeishuChatNameMock.mockReset();
    getFeishuChatNameMock.mockResolvedValueOnce("群名A").mockResolvedValueOnce("群名B");

    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: {} as any,
    });
    const handler = larkState.handlers["im.message.receive_v1"];
    expect(handler).toBeTypeOf("function");

    handler?.(
      createInboundEvent({
        chatId: "oc_rename_room",
        senderId: "ou_owner",
        text: "@her 第一次确认",
        messageId: "om_group_msg_rename_1",
      }),
    );
    await waitForRecordCalls(1);

    handler?.(
      createInboundEvent({
        chatId: "oc_rename_room",
        senderId: "ou_owner",
        text: "@her 第二次确认",
        messageId: "om_group_msg_rename_2",
      }),
    );
    await waitForRecordCalls(2);

    const firstParams = recordSessionMetaFromInboundMock.mock.calls[0]?.[0];
    const secondParams = recordSessionMetaFromInboundMock.mock.calls[1]?.[0];
    expect(firstParams?.ctx?.ConversationLabel).toBe("群名A");
    expect(firstParams?.ctx?.GroupSubject).toBe("群名A");
    expect(secondParams?.ctx?.ConversationLabel).toBe("群名B");
    expect(secondParams?.ctx?.GroupSubject).toBe("群名B");

    abortController.abort();
    await gatewayPromise;
  });

  it("records office files as saved-path placeholders instead of inline extracted text", async () => {
    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: {} as any,
    });
    const handler = larkState.handlers["im.message.receive_v1"];
    expect(handler).toBeTypeOf("function");

    handler?.(
      createInboundFileEvent({
        chatId: "oc_file_room",
        senderId: "ou_owner",
        fileKey: "file_sheet_1",
        fileName: "sheet.xlsx",
        messageId: "om_group_file_1",
      }),
    );
    await waitForRecordCalls(1);

    const [call] = recordSessionMetaFromInboundMock.mock.calls;
    const params = call?.[0];
    expect(params?.ctx?.RawBody).toContain("[file: sheet.xlsx saved at /tmp/inbound/sheet.xlsx]");
    expect(params?.ctx?.RawBody).not.toContain('<file name="sheet.xlsx">');
    expect(downloadFeishuFileMock).toHaveBeenCalledWith({
      account,
      messageId: "om_group_file_1",
      fileKey: "file_sheet_1",
    });
    expect(saveMediaBufferMock).toHaveBeenCalled();

    abortController.abort();
    await gatewayPromise;
  });
});
