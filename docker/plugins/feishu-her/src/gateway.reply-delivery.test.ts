import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import type { ResolvedFeishuAccount } from "./accounts.js";

const larkState = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => unknown>,
}));

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
          body: { content: JSON.stringify({ text: "@_user_1 请做引用回复" }) },
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
const recordSessionMetaFromInboundMock = vi.hoisted(() => vi.fn(async () => {}));
const sendFeishuReplyDetailedMock = vi.hoisted(() =>
  vi.fn(async ({ messageId }: { messageId: string; text: string }) => ({
    messageId: `om_sent_for_${messageId}`,
    chatId: "oc_test_room",
    messageType: "interactive",
    parentId: messageId,
  })),
);
const sendFeishuRichTextDetailedMock = vi.hoisted(() =>
  vi.fn(async () => ({
    messageId: "om_sent_rich_text",
    chatId: "oc_test_room",
    messageType: "interactive",
  })),
);
const dispatchReplyWithBufferedBlockDispatcherMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      dispatcherOptions: {
        deliver: (
          payload: { text?: string; replyToId?: string },
          info: { kind: "final" },
        ) => Promise<void>;
      };
    }) => {
      await params.dispatcherOptions.deliver(
        {
          text: "请只引用目标消息回复",
          replyToId: "om_explicit_parent",
        },
        { kind: "final" },
      );
    },
  ),
);

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuilt: "SelfBuilt" },
  Client: vi.fn(function Client() {
    return {};
  }),
  defaultHttpInstance: {},
  Domain: { Feishu: "https://open.feishu.cn" },
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
  buildDriveFileContextFromText: vi.fn(async () => ""),
}));

vi.mock("./group-archive.js", () => ({
  archiveGroupMessage: vi.fn(),
  archiveSentFeishuBinaryMessage: vi.fn(),
  archiveSentFeishuTextMessage: vi.fn(),
  loadArchiveEntries: vi.fn(() => new Map()),
  normalizeArchiveEntry: vi.fn((entry) => entry),
}));

vi.mock("./message-text-cache.js", () => ({
  cacheMessageText: vi.fn(),
  getCachedMessageText: vi.fn(() => null),
}));

vi.mock("./sent-message-log.js", () => ({
  recordSentMessage: vi.fn(),
}));

vi.mock("./outbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbound.js")>();
  return {
    ...actual,
    getFeishuClient: getFeishuClientMock,
    getFeishuChatName: getFeishuChatNameMock,
    sendFeishuReplyDetailed: sendFeishuReplyDetailedMock,
    sendFeishuRichTextDetailed: sendFeishuRichTextDetailedMock,
    addFeishuReaction: vi.fn(async () => null),
    removeFeishuReaction: vi.fn(async () => {}),
  };
});

import { startFeishuGateway } from "./gateway.js";
import { setFeishuRuntime } from "./runtime.js";

const account: ResolvedFeishuAccount = {
  accountId: "default",
  name: "her",
  knownBots: {},
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
        resolveStorePath: vi.fn(() => "/tmp/feishu-reply-delivery-test.json"),
        readSessionUpdatedAt: vi.fn(() => undefined),
        recordSessionMetaFromInbound: recordSessionMetaFromInboundMock,
      },
      reply: {
        resolveEnvelopeFormatOptions: vi.fn(() => undefined),
        formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
        finalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
      },
      text: {
        resolveChunkMode: vi.fn(() => "line"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
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
  parentId?: string;
}) {
  return {
    message: {
      message_id: params.messageId,
      chat_id: params.chatId,
      chat_type: "group",
      message_type: "text",
      parent_id: params.parentId ?? "",
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

async function waitForReplySendCalls(expectedCount: number) {
  for (let i = 0; i < 50; i += 1) {
    if (sendFeishuReplyDetailedMock.mock.calls.length >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`sendFeishuReplyDetailed did not reach ${expectedCount} calls`);
}

describe("feishu gateway reply delivery", () => {
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
            body: { content: JSON.stringify({ text: "@_user_1 请做引用回复" }) },
            mentions: [{ key: "@_user_1", id: "cli_x", name: "her" }],
          },
        ],
      },
    }));
    setFeishuRuntime(createRuntime() as never);
  });

  afterEach(() => {
    larkState.handlers = {};
  });

  it("prefers payload.replyToId over the inbound message id for grouped replies", async () => {
    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: {} as any,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    });
    const handler = larkState.handlers["im.message.receive_v1"];
    expect(handler).toBeTypeOf("function");

    handler?.(
      createInboundEvent({
        chatId: "oc_test_room",
        senderId: "ou_owner",
        text: "@her 帮我引用另一条消息",
        messageId: "om_inbound_msg_1",
      }),
    );
    await waitForReplySendCalls(1);

    const firstCall = sendFeishuReplyDetailedMock.mock.calls[0]?.[0];
    expect(firstCall?.messageId).toBe("om_explicit_parent");
    expect(firstCall?.text).toContain("请只引用目标消息回复");
    expect(sendFeishuRichTextDetailedMock).not.toHaveBeenCalled();

    abortController.abort();
    await gatewayPromise;
  });

  it("never fetches quoted content for synthetic discussion tool ids", async () => {
    const abortController = new AbortController();
    const gatewayPromise = startFeishuGateway({
      account,
      config,
      // oxlint-disable-next-line typescript/no-explicit-any
      runtime: {} as any,
      abortSignal: abortController.signal,
      setStatus: vi.fn(),
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    });
    const handler = larkState.handlers["im.message.receive_v1"];
    expect(handler).toBeTypeOf("function");

    handler?.(
      createInboundEvent({
        chatId: "oc_test_room",
        senderId: "ou_owner",
        text: "@her 帮我继续",
        messageId: "om_inbound_msg_2",
        parentId: "discussion-tool:oc_test_room:reset:cli_x:1774625920002",
      }),
    );
    await waitForReplySendCalls(1);

    expect(
      messageGetMock.mock.calls.some(
        (call) =>
          call?.[0]?.path?.message_id === "discussion-tool:oc_test_room:reset:cli_x:1774625920002",
      ),
    ).toBe(false);

    abortController.abort();
    await gatewayPromise;
  });
});
