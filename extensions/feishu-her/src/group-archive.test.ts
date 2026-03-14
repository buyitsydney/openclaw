import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSentFeishuBinaryMessage } from "./group-archive.js";

const parseOfficeMock = vi.hoisted(() => vi.fn());

vi.mock("officeparser", () => ({
  parseOffice: parseOfficeMock,
}));

describe("feishu group archive", () => {
  let stateDir: string;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  beforeEach(async () => {
    parseOfficeMock.mockReset();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-group-archive-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("archives sent office files with deterministic saved path text", async () => {
    await archiveSentFeishuBinaryMessage({
      chatId: "oc_group_1",
      messageId: "om_sent_1",
      senderId: "cli_bot",
      buffer: Buffer.from("xlsx"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: "sheet.xlsx",
      defaultBaseName: "sent-file",
    });

    const archivePath = path.join(stateDir, "feishu-groups", "oc_group_1", "messages.jsonl");
    const archive = await fs.readFile(archivePath, "utf-8");
    const [entry] = archive
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { msgId: string; text: string });
    expect(entry.msgId).toBe("om_sent_1");
    expect(entry.text).toContain("[file: sheet.xlsx saved at ");
    expect(entry.text).not.toContain("<file name=");

    const mediaDir = path.join(stateDir, "media", "inbound");
    const files = await fs.readdir(mediaDir);
    expect(files.some((file) => file.startsWith("sheet---") && file.endsWith(".xlsx"))).toBe(true);
  });

  it("archives generic binary files with deterministic saved path text", async () => {
    await archiveSentFeishuBinaryMessage({
      chatId: "oc_group_2",
      messageId: "om_sent_2",
      senderId: "cli_bot",
      buffer: Buffer.from("rar"),
      contentType: "application/octet-stream",
      fileName: "archive.rar",
      defaultBaseName: "sent-file",
    });

    const archivePath = path.join(stateDir, "feishu-groups", "oc_group_2", "messages.jsonl");
    const archive = await fs.readFile(archivePath, "utf-8");
    expect(archive).toContain('"msgId":"om_sent_2"');
    expect(archive).toContain("[file: archive.rar saved at ");
    expect(archive).not.toContain("<file name=");
  });
});
