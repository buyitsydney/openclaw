import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./outbound.js", () => ({
  formatFeishuUserFacingText: (text: string) => text,
}));

describe("feishu sent message log", () => {
  let stateDir: string;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalInstanceId = process.env.OPENCLAW_INSTANCE_ID;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-sent-log-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_INSTANCE_ID;
  });

  afterEach(async () => {
    vi.resetModules();
    vi.useRealTimers();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalInstanceId === undefined) {
      delete process.env.OPENCLAW_INSTANCE_ID;
    } else {
      process.env.OPENCLAW_INSTANCE_ID = originalInstanceId;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("isolates list_sent history by OPENCLAW_INSTANCE_ID", async () => {
    process.env.OPENCLAW_INSTANCE_ID = "session-a";
    let sentLog = await import("./sent-message-log.js");
    sentLog.recordSentMessage("oc_test_room", "om_session_a", "from session a");
    expect(
      sentLog.getRecentSentMessages("oc_test_room").map((message) => message.messageId),
    ).toEqual(["om_session_a"]);
    await vi.advanceTimersByTimeAsync(2100);

    vi.resetModules();
    process.env.OPENCLAW_INSTANCE_ID = "session-b";
    sentLog = await import("./sent-message-log.js");
    expect(sentLog.getRecentSentMessages("oc_test_room")).toEqual([]);
    sentLog.recordSentMessage("oc_test_room", "om_session_b", "from session b");
    expect(
      sentLog.getRecentSentMessages("oc_test_room").map((message) => message.messageId),
    ).toEqual(["om_session_b"]);
    await vi.advanceTimersByTimeAsync(2100);

    vi.resetModules();
    process.env.OPENCLAW_INSTANCE_ID = "session-a";
    sentLog = await import("./sent-message-log.js");
    expect(
      sentLog.getRecentSentMessages("oc_test_room").map((message) => message.messageId),
    ).toEqual(["om_session_a"]);
  });
});
