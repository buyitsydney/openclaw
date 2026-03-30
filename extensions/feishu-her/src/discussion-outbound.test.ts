import { beforeEach, describe, expect, it, vi } from "vitest";

const completeDiscussionTurnWithOutputMock = vi.hoisted(() => vi.fn());
const isDiscussionTurnOutputAllowedMock = vi.hoisted(() => vi.fn());
const publishBotMessageMock = vi.hoisted(() => vi.fn());
const readGroupModeMock = vi.hoisted(() => vi.fn());

vi.mock("./discussion-state.ts", () => ({
  completeDiscussionTurnWithOutput: completeDiscussionTurnWithOutputMock,
  isDiscussionTurnOutputAllowed: isDiscussionTurnOutputAllowedMock,
  publishBotMessage: publishBotMessageMock,
}));

vi.mock("./group-mode.js", () => ({
  readGroupMode: readGroupModeMock,
}));

import {
  authorizeDiscussionOutboundMessage,
  handleDiscussionOutboundMessage,
  isDiscussionChatTarget,
  resolveDiscussionOutboundAuthorization,
} from "./discussion-outbound.js";

describe("feishu discussion outbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readGroupModeMock.mockReturnValue({ mode: "discussion" });
    completeDiscussionTurnWithOutputMock.mockResolvedValue({
      closed: false,
      nextTurn: null,
      previousOwnerAppId: "cli_owner",
      reason: "advanced",
    });
    isDiscussionTurnOutputAllowedMock.mockResolvedValue(true);
  });

  it("detects discussion chat targets deterministically", () => {
    expect(isDiscussionChatTarget("oc_group")).toBe(true);
    readGroupModeMock.mockReturnValue({ mode: "owner-at" });
    expect(isDiscussionChatTarget("oc_group")).toBe(false);
    expect(isDiscussionChatTarget("ou_private")).toBe(false);
  });

  it("authorizes outbound only for the live owner turn", async () => {
    await expect(
      authorizeDiscussionOutboundMessage({
        chatId: "oc_group",
        account: {
          appId: "cli_owner",
          botOpenId: "ou_owner",
          knownBotOpenIds: {},
          name: "owner",
          accountId: "owner",
        },
        expectedTurnId: "turn-3-2",
      }),
    ).resolves.toBe(true);
    expect(isDiscussionTurnOutputAllowedMock).toHaveBeenCalledWith({
      chatId: "oc_group",
      ownerAppId: "cli_owner",
      expectedTurnId: "turn-3-2",
    });

    readGroupModeMock.mockReturnValue({ mode: "owner-at" });
    await expect(
      authorizeDiscussionOutboundMessage({
        chatId: "oc_group",
        account: {
          appId: "cli_owner",
          botOpenId: "ou_owner",
          knownBotOpenIds: {},
          name: "owner",
          accountId: "owner",
        },
        expectedTurnId: "turn-3-2",
      }),
    ).resolves.toBe(false);
  });

  it("allows visible reply but marks turnIsCurrent false when no expectedTurnId is set", async () => {
    await expect(
      resolveDiscussionOutboundAuthorization({
        chatId: "oc_group",
        account: {
          appId: "cli_owner",
          botOpenId: "ou_owner",
          knownBotOpenIds: {},
          name: "owner",
          accountId: "owner",
        },
      }),
    ).resolves.toEqual({
      visibleAllowed: true,
      turnIsCurrent: false,
    });
    expect(isDiscussionTurnOutputAllowedMock).not.toHaveBeenCalled();
  });

  it("completes the turn and republishes extracted mentions for discussion posts", async () => {
    const result = await handleDiscussionOutboundMessage({
      messageId: "om_sent_1",
      chatId: "oc_group",
      text: '结论先说。<at user_id="ou_peer">tester</at> 接棒。\n\n---\n🧠 footer',
      expectedTurnId: "turn-3-2",
      account: {
        appId: "cli_owner",
        botOpenId: "ou_owner",
        knownBotOpenIds: { ou_peer: "cli_peer" },
        name: "owner",
        accountId: "owner",
      },
    });

    expect(result.prioritizedOwnerAppIds).toEqual(["cli_peer"]);
    expect(completeDiscussionTurnWithOutputMock).toHaveBeenCalledWith({
      chatId: "oc_group",
      ownerAppId: "cli_owner",
      prioritizedOwnerAppIds: ["cli_peer"],
    });
    expect(publishBotMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        msgId: "om_sent_1",
        chatId: "oc_group",
        senderAppId: "cli_owner",
        mentions: [{ key: '<at user_id="ou_peer">tester</at>', id: "ou_peer", name: "tester" }],
      }),
    );
    expect(result.suppressed).toBe(false);
  });

  it("can publish discussion context without advancing the turn", async () => {
    await handleDiscussionOutboundMessage({
      messageId: "om_sent_2",
      chatId: "oc_group",
      text: "只是同步上下文",
      account: {
        appId: "cli_owner",
        botOpenId: "ou_owner",
        knownBotOpenIds: {},
        name: "owner",
        accountId: "owner",
      },
      completeTurn: false,
    });

    expect(completeDiscussionTurnWithOutputMock).not.toHaveBeenCalled();
    expect(publishBotMessageMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses stale discussion output before advancing or broadcasting", async () => {
    isDiscussionTurnOutputAllowedMock.mockResolvedValue(false);

    const result = await handleDiscussionOutboundMessage({
      messageId: "om_sent_stale",
      chatId: "oc_group",
      text: "过期输出",
      expectedTurnId: "turn-9-4",
      account: {
        appId: "cli_owner",
        botOpenId: "ou_owner",
        knownBotOpenIds: {},
        name: "owner",
        accountId: "owner",
      },
    });

    expect(result.suppressed).toBe(true);
    expect(completeDiscussionTurnWithOutputMock).not.toHaveBeenCalled();
    expect(publishBotMessageMock).not.toHaveBeenCalled();
  });

  it("publishes direct human command replies without mutating discussion turn state", async () => {
    const result = await handleDiscussionOutboundMessage({
      messageId: "om_sent_human_direct",
      chatId: "oc_group",
      text: "这是对人类直接消息的回复",
      account: {
        appId: "cli_owner",
        botOpenId: "ou_owner",
        knownBotOpenIds: {},
        name: "owner",
        accountId: "owner",
      },
    });

    expect(result.suppressed).toBe(false);
    expect(completeDiscussionTurnWithOutputMock).not.toHaveBeenCalled();
    expect(publishBotMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        msgId: "om_sent_human_direct",
        chatId: "oc_group",
        content: "这是对人类直接消息的回复",
      }),
    );
  });

  it("ignores non-discussion targets", async () => {
    readGroupModeMock.mockReturnValue({ mode: "owner-at" });

    const result = await handleDiscussionOutboundMessage({
      messageId: "om_sent_3",
      chatId: "oc_group",
      text: "不会进入 discussion runtime",
      account: {
        appId: "cli_owner",
        botOpenId: "ou_owner",
        knownBotOpenIds: {},
        name: "owner",
        accountId: "owner",
      },
    });

    expect(result.prioritizedOwnerAppIds).toEqual([]);
    expect(result.suppressed).toBe(false);
    expect(completeDiscussionTurnWithOutputMock).not.toHaveBeenCalled();
    expect(publishBotMessageMock).not.toHaveBeenCalled();
  });
});
