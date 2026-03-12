import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { initSessionState } from "./session.js";

vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => []),
}));

describe("initSessionState group metadata", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("keeps groupId anchored to OriginatingTo instead of sender id", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-group-meta-"));
    const storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf-8");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      ctx: {
        Body: "@her 你在哪个群",
        SessionKey: "agent:main:feishu:group:oc_test_room",
        Provider: "feishu",
        Surface: "feishu",
        ChatType: "group",
        From: "feishu:ou_sender_1",
        To: "feishu:oc_test_room",
        OriginatingChannel: "feishu",
        OriginatingTo: "feishu:oc_test_room",
        ConversationLabel: "test room",
        GroupSubject: "test room",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.groupResolution).toEqual({
      key: "feishu:group:oc_test_room",
      channel: "feishu",
      id: "oc_test_room",
      chatType: "group",
    });
    expect(result.sessionEntry.groupId).toBe("oc_test_room");
    expect(result.sessionEntry.chatType).toBe("group");
    expect(result.sessionEntry.displayName).toBe("feishu:g-test-room");
    expect(result.sessionEntry.origin?.label).toBe("test room");
    expect(result.sessionEntry.origin?.to).toBe("feishu:oc_test_room");
  });
});
