import { describe, expect, it } from "vitest";
import type { ResolvedFeishuAccount } from "./accounts.js";
import type { FeishuChatMemberNameMaps, FeishuMentionRef } from "./feishu-message.js";
import {
  buildFeishuActorFromApiSender,
  buildFeishuBotActorFromAccount,
  parseFeishuInteractiveText,
  parseFeishuMentions,
  resolveFeishuMessageActors,
} from "./feishu-message.js";

const account: ResolvedFeishuAccount = {
  accountId: "her",
  name: "her",
  knownBots: {
    cli_tester: "tester",
  },
  knownBotOpenIds: {
    ou_her_open: "cli_her",
    ou_tester_open: "cli_tester",
  },
  botOpenId: "ou_her_open",
  enabled: true,
  appId: "cli_her",
  appSecret: "sec_her",
  credentialSource: "config",
  config: {
    name: "her",
    knownBots: {
      cli_tester: "tester",
    },
    knownBotOpenIds: {
      ou_her_open: "cli_her",
      ou_tester_open: "cli_tester",
    },
    botOpenId: "ou_her_open",
  },
};

function emptyNameMaps(): FeishuChatMemberNameMaps {
  return {
    openIdToName: new Map(),
    appIdToName: new Map(),
  };
}

describe("feishu actor identity", () => {
  it("builds a deterministic bot actor from the current account", () => {
    expect(buildFeishuBotActorFromAccount(account)).toEqual({
      canonicalId: "cli_her",
      canonicalIdType: "app_id",
      senderType: "app",
      actorKind: "bot",
      displayName: "her",
      rawIds: { app_id: "cli_her", open_id: "ou_her_open" },
      resolutionSource: "config",
      resolved: true,
    });
  });

  it("pins the current bot app_id to the configured account name", async () => {
    const sender = buildFeishuActorFromApiSender({
      id: "cli_her",
      sender_type: "app",
    });
    const resolved = await resolveFeishuMessageActors({
      account,
      sender,
      chatId: "oc_test_group",
      nameMaps: emptyNameMaps(),
    });

    expect(resolved.sender.displayName).toBe("her");
    expect(resolved.sender.canonicalId).toBe("cli_her");
    expect(resolved.sender.actorKind).toBe("bot");
    expect(resolved.sender.rawIds.open_id).toBe("ou_her_open");
  });

  it("keeps human sender canonical ids while applying group display names", async () => {
    const sender = buildFeishuActorFromApiSender({
      id: "ou_user_1",
      sender_type: "user",
    });
    const resolved = await resolveFeishuMessageActors({
      account,
      sender,
      chatId: "oc_test_group",
      nameMaps: {
        openIdToName: new Map([["ou_user_1", "卜弋天"]]),
        appIdToName: new Map(),
      },
    });

    expect(resolved.sender.canonicalId).toBe("ou_user_1");
    expect(resolved.sender.displayName).toBe("卜弋天");
    expect(resolved.sender.actorKind).toBe("human");
  });

  it("normalizes mentions for the current bot to the configured account name", async () => {
    const sender = buildFeishuActorFromApiSender({
      id: "ou_user_1",
      sender_type: "user",
    });
    const mentions: FeishuMentionRef[] = [
      {
        key: "@_user_1",
        id: "cli_her",
        name: "陌生名字",
        renderedText: "@陌生名字",
        actor: buildFeishuActorFromApiSender({
          id: "cli_her",
          sender_type: "app",
        }),
      },
    ];
    const resolved = await resolveFeishuMessageActors({
      account,
      sender,
      mentions,
      chatId: "oc_test_group",
      nameMaps: emptyNameMaps(),
    });

    expect(resolved.mentions).toHaveLength(1);
    expect(resolved.mentions[0]?.actor.displayName).toBe("her");
    expect(resolved.mentions[0]?.renderedText).toBe("@her");
  });

  it("resolves peer bot app_ids only from the known-bot registry", async () => {
    const sender = buildFeishuActorFromApiSender({
      id: "cli_tester",
      sender_type: "app",
    });
    const resolved = await resolveFeishuMessageActors({
      account,
      sender,
      chatId: "oc_test_group",
      nameMaps: emptyNameMaps(),
    });

    expect(resolved.sender.displayName).toBe("tester");
    expect(resolved.sender.canonicalId).toBe("cli_tester");
    expect(resolved.sender.actorKind).toBe("bot");
    expect(resolved.sender.rawIds.open_id).toBe("ou_tester_open");
  });

  it("keeps unknown bot app_ids stable instead of inventing a display name", async () => {
    const sender = buildFeishuActorFromApiSender({
      id: "cli_unknown_bot",
      sender_type: "app",
    });
    const resolved = await resolveFeishuMessageActors({
      account,
      sender,
      chatId: "oc_test_group",
      nameMaps: emptyNameMaps(),
    });

    expect(resolved.sender.displayName).toBeUndefined();
    expect(resolved.sender.canonicalId).toBe("cli_unknown_bot");
    expect(resolved.sender.actorKind).toBe("bot");
  });

  it("does not invent peer bot identity from app-scoped open_id mentions", async () => {
    const mentions: FeishuMentionRef[] = parseFeishuMentions([
      { key: "@_user_1", id: "ou_tester_open_id", name: "tester" },
    ]);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].actor.actorKind).toBe("human"); // before resolution

    const sender = buildFeishuActorFromApiSender({ id: "ou_human_user", sender_type: "user" });
    const resolved = await resolveFeishuMessageActors({
      account,
      sender,
      mentions,
      chatId: "oc_test_group",
      nameMaps: emptyNameMaps(),
    });

    expect(resolved.mentions).toHaveLength(1);
    expect(resolved.mentions[0].actor.actorKind).toBe("human");
    expect(resolved.mentions[0].actor.canonicalId).toBe("ou_tester_open_id");
    expect(resolved.mentions[0].actor.displayName).toBe("tester");
  });

  it("upgrades peer bot mentions only when the payload already carries app_id", async () => {
    const mentions: FeishuMentionRef[] = parseFeishuMentions([
      { key: "@_user_1", id: "cli_tester", name: "tester" },
    ]);
    const sender = buildFeishuActorFromApiSender({ id: "ou_human_user", sender_type: "user" });
    const resolved = await resolveFeishuMessageActors({
      account,
      sender,
      mentions,
      chatId: "oc_test_group",
      nameMaps: emptyNameMaps(),
    });

    expect(resolved.mentions).toHaveLength(1);
    expect(resolved.mentions[0].actor.actorKind).toBe("bot");
    expect(resolved.mentions[0].actor.canonicalId).toBe("cli_tester");
    expect(resolved.mentions[0].actor.displayName).toBe("tester");
    expect(resolved.mentions[0].actor.rawIds.open_id).toBe("ou_tester_open");
  });
});

describe("feishu interactive parsing", () => {
  it("parses schema 2.0 markdown cards without degrading headings or code", () => {
    const parsed = parseFeishuInteractiveText({
      schema: "2.0",
      header: {
        title: {
          tag: "plain_text",
          content: "回归结果",
        },
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: "### T01\n\n- item\n\n`code`",
          },
        ],
      },
    });

    expect(parsed.rawText).toBe("回归结果\n\n### T01\n\n- item\n\n`code`");
    expect(parsed.coverage).toBe("full");
  });
});
