import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSentFeishuBinaryMessage, archiveSentFeishuTextMessage } from "./group-archive.js";

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

  it("archives sent office files with extracted text and saved path", async () => {
    parseOfficeMock.mockResolvedValue({
      content: [{ type: "text", text: "A1\tRevenue" }],
      attachments: [],
    });

    await archiveSentFeishuBinaryMessage({
      chatId: "oc_group_1",
      messageId: "om_sent_1",
      senderId: "cli_bot",
      senderName: "her",
      actor: {
        canonicalId: "cli_bot",
        canonicalIdType: "app_id",
        senderType: "app",
        actorKind: "bot",
        displayName: "her",
        rawIds: { app_id: "cli_bot" },
        resolutionSource: "config",
        resolved: true,
      },
      messageType: "file",
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
    expect(entry.text).toContain('<file name="sheet.xlsx">');
    expect(entry.text).toContain("A1\tRevenue");
    expect(entry.text).toContain("[file: sheet.xlsx saved at ");
    expect(archive).toContain('"displayName":"her"');
    expect(archive).toContain('"messageType":"file"');

    const mediaDir = path.join(stateDir, "media", "inbound");
    const files = await fs.readdir(mediaDir);
    expect(files.some((file) => file.startsWith("sheet---") && file.endsWith(".xlsx"))).toBe(true);
  });

  it("archives generic binary files with deterministic saved path text", async () => {
    await archiveSentFeishuBinaryMessage({
      chatId: "oc_group_2",
      messageId: "om_sent_2",
      senderId: "cli_bot",
      senderName: "her",
      actor: {
        canonicalId: "cli_bot",
        canonicalIdType: "app_id",
        senderType: "app",
        actorKind: "bot",
        displayName: "her",
        rawIds: { app_id: "cli_bot" },
        resolutionSource: "config",
        resolved: true,
      },
      messageType: "file",
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
    expect(archive).toContain('"displayName":"her"');
  });

  it("archives sent text messages with reply metadata and extracted mentions", async () => {
    archiveSentFeishuTextMessage({
      chatId: "oc_group_3",
      message: {
        messageId: "om_sent_3",
        messageType: "interactive",
        parentId: "om_parent_3",
        rootId: "om_root_3",
      },
      senderId: "cli_bot",
      senderName: "her",
      actor: {
        canonicalId: "cli_bot",
        canonicalIdType: "app_id",
        senderType: "app",
        actorKind: "bot",
        displayName: "her",
        rawIds: { app_id: "cli_bot" },
        resolutionSource: "config",
        resolved: true,
      },
      text: '请看 <at user_id="ou_tester">tester</at> 的回复',
    });

    const archivePath = path.join(stateDir, "feishu-groups", "oc_group_3", "messages.jsonl");
    const archive = await fs.readFile(archivePath, "utf-8");
    const [entry] = archive
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            msgId: string;
            reply?: { parentId?: string; rootId?: string };
            mentions?: Array<{ id?: string; name?: string }>;
          },
      );

    expect(entry.msgId).toBe("om_sent_3");
    expect(entry.reply).toEqual({
      parentId: "om_parent_3",
      rootId: "om_root_3",
    });
    expect(entry.mentions).toEqual([
      expect.objectContaining({
        id: "ou_tester",
        name: "tester",
        renderedText: "@tester",
      }),
    ]);
  });

  it("archives sent binary messages with reply metadata from the sent message ref", async () => {
    await archiveSentFeishuBinaryMessage({
      chatId: "oc_group_4",
      message: {
        messageId: "om_sent_4",
        messageType: "image",
        parentId: "om_parent_4",
      },
      senderId: "cli_bot",
      senderName: "her",
      actor: {
        canonicalId: "cli_bot",
        canonicalIdType: "app_id",
        senderType: "app",
        actorKind: "bot",
        displayName: "her",
        rawIds: { app_id: "cli_bot" },
        resolutionSource: "config",
        resolved: true,
      },
      buffer: Buffer.from("png"),
      contentType: "image/png",
      fileName: "reply-image.png",
      defaultBaseName: "sent-image",
    });

    const archivePath = path.join(stateDir, "feishu-groups", "oc_group_4", "messages.jsonl");
    const archive = await fs.readFile(archivePath, "utf-8");
    const [entry] = archive
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { msgId: string; reply?: { parentId?: string } });

    expect(entry.msgId).toBe("om_sent_4");
    expect(entry.reply).toEqual({
      parentId: "om_parent_4",
    });
  });
});
