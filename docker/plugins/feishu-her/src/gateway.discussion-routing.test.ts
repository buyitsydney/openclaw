import { describe, expect, it } from "vitest";
import {
  advanceDiscussionTurnState,
  buildDiscussionTurnQueue,
  createDiscussionRunningTurnState,
  getDiscussionTurnExpiryReason,
  prioritizeDiscussionTurnQueue,
  shouldRegisterDiscussionParticipant,
} from "./discussion-state.js";
import {
  buildDiscussionAgendaParticipantAppIds,
  normalizeFeishuReplyTargetMessageId,
  resolveDiscussionHumanRouting,
  resolveDiscussionMentionedBotAppIds,
  selectDiscussionExplicitLeaderAppId,
  selectDiscussionHumanControlTargetAppId,
  selectDiscussionHumanOwnerAppId,
  shouldAcceptDiscussionSyntheticTurn,
  shouldBypassDiscussionTurnScheduling,
  shouldProcessDiscussionMessage,
} from "./gateway.js";

describe("feishu gateway discussion routing", () => {
  const testerAccount = {
    accountId: "tester",
    appId: "cli_a92c99d102b8dbca",
    botOpenId: "ou_1a9c02079fef1f5f0f4daaaaffd2326c",
    knownBotOpenIds: {
      ou_leader: "cli_leader",
      ou_peer: "cli_peer",
    },
  };

  it("resolves mentioned bot app ids in stable order", () => {
    expect(
      resolveDiscussionMentionedBotAppIds(
        [{ id: "ou_peer" }, { id: "cli_a92c99d102b8dbca" }, { id: "ou_leader" }, { id: "ou_peer" }],
        testerAccount,
      ),
    ).toEqual(["cli_peer", "cli_a92c99d102b8dbca", "cli_leader"]);
  });

  it("selects one human owner and prefers the leader when present", () => {
    expect(
      selectDiscussionHumanOwnerAppId({
        mentionedBotAppIds: ["cli_peer", "cli_leader", "cli_other"],
        leaderAppId: "cli_leader",
      }),
    ).toBe("cli_leader");

    expect(
      selectDiscussionHumanOwnerAppId({
        mentionedBotAppIds: ["cli_peer", "cli_other"],
        leaderAppId: "cli_leader",
      }),
    ).toBe("cli_peer");
  });

  it("routes running discussion human direct commands to the first mentioned bot, otherwise the leader", () => {
    expect(
      selectDiscussionHumanControlTargetAppId({
        mentionedBotAppIds: ["cli_peer", "cli_leader"],
        leaderAppId: "cli_leader",
      }),
    ).toBe("cli_peer");

    expect(
      selectDiscussionHumanControlTargetAppId({
        mentionedBotAppIds: [],
        leaderAppId: "cli_leader",
      }),
    ).toBe("cli_leader");
  });

  it("separates bootstrap from running-discussion direct routing", () => {
    expect(
      resolveDiscussionHumanRouting({
        hasActiveTurn: false,
        mentionedBotAppIds: ["cli_peer", "cli_leader"],
        leaderAppId: null,
        explicitLeaderAppId: "cli_leader",
        isBotSender: false,
        isSyntheticMessage: false,
      }),
    ).toEqual({
      mode: "bootstrap",
      targetAppId: "cli_leader",
    });

    expect(
      resolveDiscussionHumanRouting({
        hasActiveTurn: true,
        mentionedBotAppIds: ["cli_peer", "cli_leader"],
        leaderAppId: "cli_leader",
        explicitLeaderAppId: "cli_leader",
        isBotSender: false,
        isSyntheticMessage: false,
      }),
    ).toEqual({
      mode: "direct",
      targetAppId: "cli_peer",
    });
  });

  it("builds a fresh participant list only from the new agenda mentions", () => {
    expect(
      buildDiscussionAgendaParticipantAppIds({
        mentionedBotAppIds: ["cli_a92c99d102b8dbca", "cli_peer", "cli_leader"],
        ownerAppId: "cli_a92c99d102b8dbca",
        explicitLeaderAppId: "cli_leader",
      }),
    ).toEqual(["cli_a92c99d102b8dbca", "cli_peer", "cli_leader"]);
  });

  it("parses a human-explicit leader deterministically from mention text", () => {
    expect(
      selectDiscussionExplicitLeaderAppId({
        text: "@tester2 你做leader，另外两位bot跟进。",
        mentions: [
          { key: "@tester2", id: "ou_leader", name: "tester2" },
          { key: "@tester", id: "cli_a92c99d102b8dbca", name: "tester" },
        ],
        account: testerAccount,
      }),
    ).toBe("cli_leader");

    expect(
      selectDiscussionExplicitLeaderAppId({
        text: "新讨论：@tester 你是leader，你主持。\n@tester2 你们配合。",
        mentions: [
          { key: "@tester", id: "cli_a92c99d102b8dbca", name: "tester" },
          { key: "@tester2", id: "ou_leader", name: "tester2" },
        ],
        account: testerAccount,
      }),
    ).toBe("cli_a92c99d102b8dbca");
  });

  it("never uses synthetic discussion-turn ids as reply targets", () => {
    expect(
      normalizeFeishuReplyTargetMessageId(
        "discussion-turn:oc_3795c5049992ee4d4d566be200a6a010:turn-1-1:om_xxx",
      ),
    ).toBe("");
    expect(
      normalizeFeishuReplyTargetMessageId(
        "discussion-tool:oc_3795c5049992ee4d4d566be200a6a010:reset:cli_x:1774625920002",
      ),
    ).toBe("");
    expect(normalizeFeishuReplyTargetMessageId("om_real_message_id")).toBe("om_real_message_id");
  });

  it("only processes human-selected owners or synthetic owner turns", () => {
    expect(
      shouldProcessDiscussionMessage({
        isBotSender: true,
        isSelfBot: false,
        isSyntheticMessage: false,
        isDiscussionTurn: false,
        isHumanSelectedTarget: false,
      }),
    ).toBe(false);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: false,
        isSelfBot: false,
        isSyntheticMessage: false,
        isDiscussionTurn: false,
        isHumanSelectedTarget: false,
      }),
    ).toBe(false);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: false,
        isSelfBot: false,
        isSyntheticMessage: false,
        isDiscussionTurn: false,
        isHumanSelectedTarget: true,
      }),
    ).toBe(true);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: true,
        isSelfBot: false,
        isSyntheticMessage: true,
        isDiscussionTurn: true,
        isHumanSelectedTarget: false,
      }),
    ).toBe(true);
  });

  it("bypasses deterministic turn scheduling for human group commands", () => {
    expect(
      shouldBypassDiscussionTurnScheduling({
        isCommand: true,
        isBotSender: false,
        isSyntheticMessage: false,
      }),
    ).toBe(true);

    expect(
      shouldBypassDiscussionTurnScheduling({
        isCommand: true,
        isBotSender: true,
        isSyntheticMessage: false,
      }),
    ).toBe(false);
  });

  it("rejects stale synthetic turns from older epochs", () => {
    expect(
      shouldAcceptDiscussionSyntheticTurn({
        currentTurnId: "turn-14-11",
        syntheticTurnId: "turn-14-11",
      }),
    ).toBe(true);

    expect(
      shouldAcceptDiscussionSyntheticTurn({
        currentTurnId: "turn-14-11",
        syntheticTurnId: "turn-13-7",
      }),
    ).toBe(false);
  });

  it("builds a deterministic queue with chair closing last", () => {
    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_leader", "cli_b", "cli_c"],
        chairAppId: "cli_leader",
        ownerAppId: "cli_leader",
      }),
    ).toEqual(["cli_b", "cli_c", "cli_leader"]);

    expect(
      buildDiscussionTurnQueue({
        participantOrder: ["cli_leader", "cli_b", "cli_c"],
        chairAppId: "cli_leader",
        ownerAppId: "cli_b",
      }),
    ).toEqual(["cli_c", "cli_leader"]);
  });

  it("prioritizes the explicitly handed-off owner without losing fallback order", () => {
    expect(prioritizeDiscussionTurnQueue(["cli_b", "cli_c", "cli_leader"], ["cli_c"])).toEqual([
      "cli_c",
      "cli_b",
      "cli_leader",
    ]);

    expect(prioritizeDiscussionTurnQueue(["cli_b", "cli_leader"], ["cli_c"])).toEqual([
      "cli_c",
      "cli_b",
      "cli_leader",
    ]);
  });

  it("advances turns one owner at a time and closes when exhausted", () => {
    const running = createDiscussionRunningTurnState({
      roomEpoch: 7,
      fencingToken: 3,
      chairAppId: "cli_leader",
      ownerAppId: "cli_leader",
      participantAppIds: ["cli_leader", "cli_b", "cli_c"],
      sourceMessageId: "msg-1",
      nowMs: 1_000,
    });

    const firstAdvance = advanceDiscussionTurnState(running, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_c"],
    });
    expect(firstAdvance.closed).toBe(false);
    expect(firstAdvance.nextTurn?.ownerAppId).toBe("cli_c");
    expect(firstAdvance.nextTurn?.remainingQueue).toEqual(["cli_b", "cli_leader"]);

    const secondAdvance = advanceDiscussionTurnState(firstAdvance.nextTurn!, { nowMs: 3_000 });
    expect(secondAdvance.nextTurn?.ownerAppId).toBe("cli_b");

    const thirdAdvance = advanceDiscussionTurnState(secondAdvance.nextTurn!, { nowMs: 4_000 });
    expect(thirdAdvance.nextTurn?.ownerAppId).toBe("cli_leader");

    expect(advanceDiscussionTurnState(thirdAdvance.nextTurn!, { nowMs: 5_000 })).toEqual({
      nextTurn: null,
      closed: true,
    });
  });

  it("allows explicit handoff to add a missing participant into later turns", () => {
    const running = createDiscussionRunningTurnState({
      roomEpoch: 11,
      fencingToken: 1,
      chairAppId: "cli_leader",
      ownerAppId: "cli_leader",
      participantAppIds: ["cli_leader", "cli_b"],
      sourceMessageId: "msg-extra",
      nowMs: 1_000,
    });

    const advanced = advanceDiscussionTurnState(running, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_c"],
    });

    expect(advanced.closed).toBe(false);
    expect(advanced.nextTurn?.ownerAppId).toBe("cli_c");
    expect(advanced.nextTurn?.participantOrder).toEqual(["cli_leader", "cli_b", "cli_c"]);
    expect(advanced.nextTurn?.remainingQueue).toEqual(["cli_b", "cli_leader"]);
  });

  it("never falls back to an unmentioned bot when explicit handoff targets exist", () => {
    const running = createDiscussionRunningTurnState({
      roomEpoch: 12,
      fencingToken: 4,
      chairAppId: "cli_leader",
      ownerAppId: "cli_leader",
      participantAppIds: ["cli_leader", "cli_b", "cli_c"],
      sourceMessageId: "msg-first-win",
      nowMs: 1_000,
    });

    const advanced = advanceDiscussionTurnState(running, {
      nowMs: 2_000,
      prioritizedOwnerAppIds: ["cli_c", "cli_b"],
    });

    expect(advanced.closed).toBe(false);
    expect(advanced.nextTurn?.ownerAppId).toBe("cli_c");
    expect(advanced.nextTurn?.remainingQueue).toEqual(["cli_b", "cli_leader"]);
  });

  it("distinguishes assign timeout from finish timeout", () => {
    const running = createDiscussionRunningTurnState({
      roomEpoch: 10,
      fencingToken: 2,
      chairAppId: "cli_leader",
      ownerAppId: "cli_b",
      participantAppIds: ["cli_leader", "cli_b"],
      sourceMessageId: "msg-3",
      nowMs: 10_000,
    });
    expect(getDiscussionTurnExpiryReason(running, 10_100)).toBeNull();
    // Running turns no longer have a finish deadline — bots run until they produce output.
    expect(running.finishDeadlineMs).toBe(0);
    expect(getDiscussionTurnExpiryReason(running, 999_999_999)).toBeNull();

    const assigned = advanceDiscussionTurnState(running, { nowMs: 20_000 }).nextTurn!;
    expect(getDiscussionTurnExpiryReason(assigned, assigned.assignDeadlineMs)).toBe(
      "assign-timeout",
    );
  });

  it("registers participants only in discussion mode", () => {
    expect(shouldRegisterDiscussionParticipant({ isDiscussionMode: true })).toBe(true);

    expect(shouldRegisterDiscussionParticipant({ isDiscussionMode: false })).toBe(false);
  });
});
