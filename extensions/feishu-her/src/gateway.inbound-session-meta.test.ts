import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import type { ResolvedFeishuAccount } from "./accounts.js";

const larkState = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => unknown>,
}));
const recordSessionMetaFromInboundMock = vi.hoisted(() => vi.fn(async () => {}));
const getBotOpenIdMock = vi.hoisted(() => vi.fn(async () => "ou_bot"));
const getFeishuChatNameMock = vi.hoisted(() => vi.fn(async () => "test"));
const buildDriveFileContextFromTextMock = vi.hoisted(() => vi.fn(async () => ""));

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
    getBotOpenId: getBotOpenIdMock,
    getFeishuChatName: getFeishuChatNameMock,
    addFeishuReaction: vi.fn(async () => null),
    removeFeishuReaction: vi.fn(async () => {}),
  };
});

import { startFeishuGateway } from "./gateway.js";
import { setFeishuRuntime } from "./runtime.js";

const account: ResolvedFeishuAccount = {
  accountId: "default",
  enabled: true,
  appId: "cli_x",
  appSecret: "sec_x",
  credentialSource: "config",
  config: {
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
        saveMediaBuffer: vi.fn(),
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
  beforeEach(() => {
    vi.clearAllMocks();
    larkState.handlers = {};
    getBotOpenIdMock.mockResolvedValue("ou_bot");
    getFeishuChatNameMock.mockResolvedValue("test");
    buildDriveFileContextFromTextMock.mockResolvedValue("");
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
      log: { info: vi.fn(), error: vi.fn() },
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
    getFeishuChatNameMock.mockResolvedValueOnce(null);
    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), error: vi.fn() },
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

  it("refreshes the group label on the next inbound message after a rename", async () => {
    getFeishuChatNameMock.mockReset();
    getFeishuChatNameMock.mockResolvedValueOnce("群名A").mockResolvedValueOnce("群名B");

    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), error: vi.fn() },
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
});
