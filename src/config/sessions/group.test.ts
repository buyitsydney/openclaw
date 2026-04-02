import { describe, expect, it } from "vitest";
import { resolveGroupSessionKey } from "./group.js";

describe("resolveGroupSessionKey", () => {
  it("prefers the recipient chat id for Feishu group messages", () => {
    const result = resolveGroupSessionKey({
      Provider: "feishu",
      ChatType: "group",
      From: "feishu:ou_sender_1",
      To: "feishu:oc_test_room",
      OriginatingTo: "feishu:oc_test_room",
    });

    expect(result).toEqual({
      key: "feishu:group:oc_test_room",
      channel: "feishu",
      id: "oc_test_room",
      chatType: "group",
    });
  });

  it("keeps explicit group ids from From when no recipient hint exists", () => {
    const result = resolveGroupSessionKey({
      Provider: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
    });

    expect(result).toEqual({
      key: "telegram:group:-100123",
      channel: "telegram",
      id: "-100123",
      chatType: "group",
    });
  });

  it("does not treat direct chats as groups", () => {
    const result = resolveGroupSessionKey({
      Provider: "feishu",
      ChatType: "direct",
      From: "feishu:ou_sender_1",
      To: "feishu:oc_dm_chat",
      OriginatingTo: "feishu:oc_dm_chat",
    });

    expect(result).toBeNull();
  });
});
