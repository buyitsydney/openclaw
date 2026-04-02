import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeInboundContext } from "../../../src/auto-reply/reply/inbound-context.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  recordSessionMetaFromInbound,
} from "../../../src/config/sessions.js";
import { buildFeishuInboundIdentity } from "./gateway.js";

function buildGroupInbound(params: { chatId: string; senderId: string; groupName?: string }) {
  const identity = buildFeishuInboundIdentity({
    senderId: params.senderId,
    chatId: params.chatId,
    isGroup: true,
    groupName: params.groupName,
  });
  const ctx = finalizeInboundContext({
    Body: "test body",
    RawBody: "test body",
    CommandBody: "test body",
    From: identity.From,
    To: identity.To,
    SessionKey: `agent:main:feishu:group:${params.chatId}`,
    AccountId: "default",
    ChatType: identity.ChatType,
    ConversationLabel: identity.ConversationLabel,
    GroupSubject: identity.GroupSubject,
    SenderId: params.senderId,
    Provider: "feishu",
    Surface: "feishu",
    MessageSid: "om_test",
    MessageSidFull: "om_test",
    OriginatingChannel: "feishu",
    OriginatingTo: identity.OriginatingTo,
    CommandAuthorized: true,
  });
  return { ctx, identity };
}

describe("feishu gateway session metadata", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-session-meta-"));
    storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf-8");
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records group metadata by chat id and verified group name", async () => {
    const { ctx, identity } = buildGroupInbound({
      chatId: "oc_test_room",
      senderId: "ou_sender_1",
      groupName: "test room",
    });

    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctx.SessionKey!,
      ctx,
      groupResolution: identity.groupResolution,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[ctx.SessionKey!];
    expect(entry?.groupId).toBe("oc_test_room");
    expect(entry?.chatType).toBe("group");
    expect(entry?.displayName).toBe("feishu:g-test-room");
    expect(entry?.origin?.label).toBe("test room");
    expect(entry?.origin?.from).toBe("feishu:ou_sender_1");
    expect(entry?.origin?.to).toBe("feishu:oc_test_room");
    expect(entry?.origin?.chatType).toBe("group");
  });

  it("uses canonical chat id when group name is unavailable", async () => {
    const { ctx, identity } = buildGroupInbound({
      chatId: "oc_missing_name",
      senderId: "ou_sender_2",
    });

    expect(ctx.ConversationLabel).toBe("oc_missing_name");
    expect(ctx.GroupSubject).toBe("oc_missing_name");

    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctx.SessionKey!,
      ctx,
      groupResolution: identity.groupResolution,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[ctx.SessionKey!];
    expect(entry?.groupId).toBe("oc_missing_name");
    expect(entry?.displayName).toBe("feishu:g-oc_missing_name");
    expect(entry?.origin?.label).toBe("oc_missing_name");
    expect(entry?.origin?.label).not.toBe("ou_sender_2");
  });
});
