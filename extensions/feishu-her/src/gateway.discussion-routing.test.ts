import { describe, expect, it } from "vitest";
import {
  normalizeDiscussionRuntimeState,
  shouldRegisterDiscussionParticipant,
} from "./discussion-state.js";
import { shouldInjectDiscussionBroadcast, shouldProcessDiscussionMessage } from "./gateway.js";

describe("feishu gateway discussion routing", () => {
  const testerAccount = {
    appId: "cli_a92c99d102b8dbca",
    botOpenId: "ou_1a9c02079fef1f5f0f4daaaaffd2326c",
  };

  it("only injects broadcasts for explicit mentions", () => {
    expect(
      shouldInjectDiscussionBroadcast(
        {
          mentions: [{ id: "ou_1a9c02079fef1f5f0f4daaaaffd2326c" }],
        },
        testerAccount,
      ),
    ).toBe(true);

    expect(
      shouldInjectDiscussionBroadcast(
        {
          mentions: [{ id: "cli_a92c99d102b8dbca" }],
        },
        testerAccount,
      ),
    ).toBe(true);

    expect(
      shouldInjectDiscussionBroadcast(
        {
          mentions: [{ id: "ou_d2dcb5a6c7ad3934861b7120c30c2b1e" }],
        },
        testerAccount,
      ),
    ).toBe(false);

    expect(
      shouldInjectDiscussionBroadcast(
        {
          mentions: [],
        },
        testerAccount,
      ),
    ).toBe(false);
  });

  it("only processes explicitly mentioned discussion turns", () => {
    expect(
      shouldProcessDiscussionMessage({
        isBotSender: true,
        isSelfBot: false,
        isSyntheticMessage: false,
        wasMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: true,
        isSelfBot: false,
        isSyntheticMessage: false,
        wasMentioned: true,
      }),
    ).toBe(true);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: true,
        isSelfBot: false,
        isSyntheticMessage: true,
        wasMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: true,
        isSelfBot: true,
        isSyntheticMessage: false,
        wasMentioned: true,
      }),
    ).toBe(false);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: false,
        isSelfBot: false,
        isSyntheticMessage: false,
        wasMentioned: false,
      }),
    ).toBe(false);

    expect(
      shouldProcessDiscussionMessage({
        isBotSender: false,
        isSelfBot: false,
        isSyntheticMessage: false,
        wasMentioned: true,
      }),
    ).toBe(true);
  });

  it("stops registering participants once discussion enters idle", () => {
    expect(normalizeDiscussionRuntimeState(null)).toBe("active");
    expect(normalizeDiscussionRuntimeState("idle")).toBe("idle");

    expect(
      shouldRegisterDiscussionParticipant({
        isDiscussionMode: true,
        runtimeState: "active",
      }),
    ).toBe(true);

    expect(
      shouldRegisterDiscussionParticipant({
        isDiscussionMode: true,
        runtimeState: "idle",
      }),
    ).toBe(false);

    expect(
      shouldRegisterDiscussionParticipant({
        isDiscussionMode: false,
        runtimeState: "active",
      }),
    ).toBe(false);
  });
});
