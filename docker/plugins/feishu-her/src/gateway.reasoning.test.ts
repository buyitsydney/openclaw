import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import type { ResolvedFeishuAccount } from "./accounts.js";

const larkState = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => unknown>,
}));

const recordSessionMetaFromInboundMock = vi.hoisted(() => vi.fn(async () => {}));
const getBotOpenIdMock = vi.hoisted(() => vi.fn(async () => "ou_bot"));
const getFeishuChatNameMock = vi.hoisted(() => vi.fn(async () => "direct-chat"));
const buildDriveFileContextFromTextMock = vi.hoisted(() => vi.fn(async () => ""));
const createFeishuCardStreamMock = vi.hoisted(() => vi.fn());
const sendFeishuRichTextMock = vi.hoisted(() => vi.fn(async () => "om_sent_text"));
const sendFeishuRichTextDetailedMock = vi.hoisted(() =>
  // oxlint-disable-next-line typescript/no-explicit-any
  vi.fn(async (..._args: any[]) => ({ messageId: "om_sent_text_d" })),
);
const sendFeishuTextMock = vi.hoisted(() => vi.fn(async () => "om_sent_fallback"));
const sendFeishuReplyMock = vi.hoisted(() => vi.fn(async () => "om_sent_reply"));
const sendFeishuReplyDetailedMock = vi.hoisted(() =>
  // oxlint-disable-next-line typescript/no-explicit-any
  vi.fn(async (..._args: any[]) => ({ messageId: "om_sent_reply_d" })),
);
const cacheMessageTextMock = vi.hoisted(() => vi.fn());
const buildFeishuStatusFooterMock = vi.hoisted(() => vi.fn(() => ""));
// oxlint-disable-next-line typescript/no-explicit-any
const dispatchReplyWithBufferedBlockDispatcherMock = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => {}),
);
const readSessionStoreJson5Mock = vi.hoisted(() => vi.fn(() => ({ store: {}, ok: true })));

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

vi.mock("./message-text-cache.js", () => ({
  cacheMessageText: cacheMessageTextMock,
}));

vi.mock("./status-footer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./status-footer.js")>();
  return {
    ...actual,
    buildFeishuStatusFooter: buildFeishuStatusFooterMock,
  };
});

vi.mock("../../../src/infra/state-migrations.fs.js", () => ({
  readSessionStoreJson5: readSessionStoreJson5Mock,
}));

vi.mock("./outbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbound.js")>();
  return {
    ...actual,
    getBotOpenId: getBotOpenIdMock,
    getFeishuChatName: getFeishuChatNameMock,
    createFeishuCardStream: createFeishuCardStreamMock,
    sendFeishuRichText: sendFeishuRichTextMock,
    sendFeishuRichTextDetailed: sendFeishuRichTextDetailedMock,
    sendFeishuText: sendFeishuTextMock,
    sendFeishuReply: sendFeishuReplyMock,
    sendFeishuReplyDetailed: sendFeishuReplyDetailedMock,
    addFeishuReaction: vi.fn(async () => null),
    removeFeishuReaction: vi.fn(async () => {}),
  };
});

import { startFeishuGateway } from "./gateway.js";
import { setFeishuRuntime } from "./runtime.js";

const account: ResolvedFeishuAccount = {
  accountId: "default",
  knownBots: {},
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
            sessionKey: `agent:main:feishu:dm:${peer.id}`,
          }),
        ),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/feishu-reasoning-test.json"),
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
    },
    sender: {
      sender_id: { open_id: params.senderId },
      sender_type: "user",
    },
  };
}

function createCardStream() {
  const visibleTexts: string[] = [];
  let pendingText = "";
  return {
    started: true,
    messageId: "om_stream_card",
    update: vi.fn((text: string) => {
      pendingText = text;
    }),
    flush: vi.fn(async () => {
      if (pendingText) {
        visibleTexts.push(pendingText);
        pendingText = "";
      }
    }),
    stop: vi.fn(),
    sendFinal: vi.fn(async (text: string) => {
      visibleTexts.push(text);
    }),
    finalize: vi.fn(async () => {}),
    getVisibleTexts: () => [...visibleTexts],
    getPendingText: () => pendingText,
  };
}

async function waitForCondition(check: () => boolean, errorMessage: string) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(errorMessage);
}

describe("feishu gateway reasoning delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Also clear any leftover mockImplementationOnce queue from prior tests
    // (vi.clearAllMocks only clears calls/instances, not once-queues).
    dispatchReplyWithBufferedBlockDispatcherMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(async () => {});
    larkState.handlers = {};
    getBotOpenIdMock.mockResolvedValue("ou_bot");
    getFeishuChatNameMock.mockResolvedValue("direct-chat");
    buildDriveFileContextFromTextMock.mockResolvedValue("");
    buildFeishuStatusFooterMock.mockReturnValue("");
    readSessionStoreJson5Mock.mockReturnValue({ store: {}, ok: true });
    setFeishuRuntime(createRuntime() as never);
  });

  afterEach(() => {
    larkState.handlers = {};
  });

  it("keeps reasoning-on delivery in final-message order without answer typewriter", async () => {
    readSessionStoreJson5Mock.mockReturnValue({
      store: {
        "agent:main:feishu:dm:oc_dm_room": {
          reasoningLevel: "on",
        },
      },
      ok: true,
    });
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async ({
        dispatcherOptions,
        replyOptions,
      }: {
        dispatcherOptions: {
          onReplyStart?: () => Promise<void> | void;
          deliver: (
            payload: { text?: string; isReasoning?: boolean },
            info: { kind: "final" | "tool" | "block" },
          ) => Promise<void>;
        };
        replyOptions?: {
          onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
        };
      }) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions?.onPartialReply?.({ text: "答案草稿" });
        await dispatcherOptions.deliver(
          { text: "Reasoning:\n_first block_", isReasoning: true },
          { kind: "final" },
        );
        await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
      },
    );

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
      createDirectInboundEvent({
        chatId: "oc_dm_room",
        senderId: "ou_owner",
        text: "请先想一想再回答",
        messageId: "om_dm_msg_1",
      }),
    );

    const deliveredTexts = () => [
      ...sendFeishuRichTextDetailedMock.mock.calls.map((c) => c[0]?.text),
      ...sendFeishuReplyDetailedMock.mock.calls.map((c) => c[0]?.text),
    ];
    await waitForCondition(
      () => deliveredTexts().filter(Boolean).length >= 2,
      "reasoning-on final messages were not delivered",
    );

    expect(createFeishuCardStreamMock).not.toHaveBeenCalled();
    expect(deliveredTexts().filter(Boolean)).toEqual(["Reasoning:\n_first block_", "最终答案"]);

    abortController.abort();
    await gatewayPromise;
  });

  it("flushes reasoning preview before a same-window answer partial can overwrite it", async () => {
    const cardStream = createCardStream();
    createFeishuCardStreamMock.mockResolvedValue(cardStream);
    readSessionStoreJson5Mock.mockReturnValue({
      store: {
        "agent:main:feishu:dm:oc_dm_room": {
          reasoningLevel: "stream",
        },
      },
      ok: true,
    });
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async ({
        dispatcherOptions,
        replyOptions,
      }: {
        dispatcherOptions: {
          onReplyStart?: () => Promise<void> | void;
          deliver: (
            payload: { text?: string; isReasoning?: boolean },
            info: { kind: "final" | "tool" | "block" },
          ) => Promise<void>;
        };
        replyOptions?: {
          onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
          onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
          onReasoningEnd?: () => Promise<void> | void;
        };
      }) => {
        await dispatcherOptions.onReplyStart?.();
        const reasoningPromise = replyOptions?.onReasoningStream?.({
          text: "Reasoning:\n_先分析_",
        });
        await replyOptions?.onPartialReply?.({ text: "答案草稿" });
        await reasoningPromise;
        await replyOptions?.onReasoningEnd?.();
        await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
      },
    );

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
      createDirectInboundEvent({
        chatId: "oc_dm_room",
        senderId: "ou_owner",
        text: "请先分析再回答",
        messageId: "om_dm_msg_2",
      }),
    );

    await waitForCondition(
      () => cardStream.sendFinal.mock.calls.length >= 1,
      "card stream did not finalize after reasoning stream",
    );

    expect(cardStream.flush).toHaveBeenCalledTimes(1);
    expect(cardStream.getVisibleTexts()[0]).toBe("Reasoning:\n_先分析_");
    expect(cardStream.update.mock.calls.map((call) => call[0])).toEqual([
      "Reasoning:\n_先分析_",
      "答案草稿",
    ]);
    expect(cardStream.sendFinal).toHaveBeenCalledWith("最终答案");
    expect(sendFeishuRichTextMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Reasoning:\n_先分析_",
      }),
    );

    abortController.abort();
    await gatewayPromise;
  });
});

describe("feishu gateway reasoning: enqueue-followup reproducer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    larkState.handlers = {};
    getBotOpenIdMock.mockResolvedValue("ou_bot");
    getFeishuChatNameMock.mockResolvedValue("direct-chat");
    buildDriveFileContextFromTextMock.mockResolvedValue("");
    buildFeishuStatusFooterMock.mockReturnValue("");
    readSessionStoreJson5Mock.mockReturnValue({ store: {}, ok: true });
    setFeishuRuntime(createRuntime() as never);
  });

  afterEach(() => {
    larkState.handlers = {};
  });

  it("deliver never fires on enqueue-followup handler; card stream sits idle", async () => {
    const cardStream1 = createCardStream();
    const cardStream2 = createCardStream();
    createFeishuCardStreamMock
      .mockResolvedValueOnce(cardStream1)
      .mockResolvedValueOnce(cardStream2);
    readSessionStoreJson5Mock.mockReturnValue({
      store: {
        "agent:main:feishu:dm:oc_dm_room": {
          reasoningLevel: "stream",
        },
      },
      ok: true,
    });

    let secondDispatchStarted = false;

    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async ({
        dispatcherOptions,
        replyOptions,
      }: {
        dispatcherOptions: {
          onReplyStart?: () => Promise<void> | void;
          deliver: (
            payload: { text?: string; isReasoning?: boolean },
            info: { kind: "final" | "tool" | "block" },
          ) => Promise<void>;
        };
        replyOptions?: {
          onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
          onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
          onReasoningEnd?: () => Promise<void> | void;
        };
      }) => {
        await dispatcherOptions.onReplyStart?.();
        await replyOptions?.onReasoningStream?.({ text: "Reasoning:\n_思考中_" });
        await replyOptions?.onReasoningEnd?.();
        await replyOptions?.onPartialReply?.({ text: "第一个答案" });
        await dispatcherOptions.deliver({ text: "第一个答案" }, { kind: "final" });
      },
    );

    // Simulates enqueue-followup: onReplyStart fires, then returns immediately.
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: {
          onReplyStart?: () => Promise<void> | void;
        };
      }) => {
        await dispatcherOptions.onReplyStart?.();
        secondDispatchStarted = true;
      },
    );

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

    const logSpy = vi.fn();
    const errorSpy = vi.fn();
    const h1Promise = handler?.(
      createDirectInboundEvent({
        chatId: "oc_dm_room",
        senderId: "ou_owner",
        text: "问题1",
        messageId: "om_msg_1",
      }),
    );

    // Wait for handler to finish (it resolves when dispatch + cleanup complete).
    try {
      await h1Promise;
    } catch {
      // Handler caught its own errors; swallow.
    }
    await new Promise((r) => setTimeout(r, 50));

    // Verify dispatch was called.
    expect(dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.length).toBeGreaterThanOrEqual(
      1,
    );

    expect(cardStream1.sendFinal).toHaveBeenCalled();

    const h2 = handler?.(
      createDirectInboundEvent({
        chatId: "oc_dm_room",
        senderId: "ou_owner",
        text: "问题2",
        messageId: "om_msg_2",
      }),
    );
    await waitForCondition(() => secondDispatchStarted, "second dispatch did not start");
    await h2;

    expect(createFeishuCardStreamMock).toHaveBeenCalledTimes(2);

    // Second card stream was created but NEVER received any content —
    // core's enqueue-followup path never calls deliver/onReasoningStream.
    expect(cardStream2.update).not.toHaveBeenCalled();
    expect(cardStream2.flush).not.toHaveBeenCalled();
    expect(cardStream2.sendFinal).not.toHaveBeenCalled();

    abortController.abort();
    await gatewayPromise;
  });
});

describe("resolveEffectiveReasoningMode: fleet-wide config kill switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readSessionStoreJson5Mock.mockReturnValue({ store: {}, ok: true });
  });

  it("returns 'off' even when persisted is 'stream' if config.channels.feishu.reasoning.defaultLevel='off'", async () => {
    const { resolveEffectiveReasoningMode } = await import("./gateway.js");
    readSessionStoreJson5Mock.mockReturnValue({
      store: {
        "agent:main:feishu:dm:oc_dm_room": { reasoningLevel: "stream" },
      },
      ok: true,
    });
    const cfg = {
      channels: { feishu: { reasoning: { defaultLevel: "off" } } },
    } as unknown as OpenClawConfig;
    const result = resolveEffectiveReasoningMode({
      cleanText: "hello",
      storePath: "/tmp/feishu-killswitch.json",
      sessionKey: "agent:main:feishu:dm:oc_dm_room",
      config: cfg,
    });
    expect(result).toBe("off");
  });

  it("inline /reasoning:stream still overrides fleet 'off' kill switch", async () => {
    const { resolveEffectiveReasoningMode } = await import("./gateway.js");
    const cfg = {
      channels: { feishu: { reasoning: { defaultLevel: "off" } } },
    } as unknown as OpenClawConfig;
    const result = resolveEffectiveReasoningMode({
      cleanText: "hi /reasoning:stream",
      storePath: "/tmp/feishu-killswitch.json",
      sessionKey: "agent:main:feishu:dm:oc_dm_room",
      config: cfg,
    });
    expect(result).toBe("stream");
  });

  it("falls back to her historical 'stream' default when no fleet config + no persisted", async () => {
    const { resolveEffectiveReasoningMode } = await import("./gateway.js");
    const result = resolveEffectiveReasoningMode({
      cleanText: "hello",
      storePath: "/tmp/feishu-no-config.json",
      sessionKey: "agent:main:feishu:dm:oc_dm_room",
      config: {} as OpenClawConfig,
    });
    expect(result).toBe("stream");
  });

  it("returns 'off' when fleet defaultLevel='off' and no persisted state", async () => {
    const { resolveEffectiveReasoningMode } = await import("./gateway.js");
    const cfg = {
      channels: { feishu: { reasoning: { defaultLevel: "off" } } },
    } as unknown as OpenClawConfig;
    const result = resolveEffectiveReasoningMode({
      cleanText: "hello",
      storePath: "/tmp/feishu-killswitch-empty.json",
      sessionKey: "agent:main:feishu:dm:oc_dm_room",
      config: cfg,
    });
    expect(result).toBe("off");
  });
});
