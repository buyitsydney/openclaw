import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  accumulateGroupedReplyText,
  buildFeishuStatusFooter,
  finalizeGroupedReplyText,
} from "./status-footer.js";

describe("feishu status footer", () => {
  it("appends exactly one footer after merged group text", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "feishu-status-footer-"));
    const storePath = path.join(tempDir, "sessions.json");
    await writeFile(
      storePath,
      JSON.stringify(
        {
          "feishu:group:test": {
            model: "claude-opus-4-6",
            totalTokens: 120000,
            contextTokens: 200000,
            compactionCount: 3,
          },
        },
        null,
        2,
      ),
    );

    // Group chat with mode tag
    const footer = buildFeishuStatusFooter({
      storePath,
      sessionKey: "feishu:group:test",
      config: {},
      groupMode: "owner-at",
    });
    expect(footer).toContain("Opus 4.6");
    expect(footer).toContain("120k/200k");
    expect(footer).toContain("🧹3");
    expect(footer).toContain("🔒主人@");
    // No percentage, no "次压缩"
    expect(footer).not.toContain("%");
    expect(footer).not.toContain("次压缩");

    // DM: no mode tag
    const dmFooter = buildFeishuStatusFooter({
      storePath,
      sessionKey: "feishu:group:test",
      config: {},
    });
    expect(dmFooter).not.toContain("🔒");
    expect(dmFooter).not.toContain("👥");

    let merged = "";
    merged = accumulateGroupedReplyText(merged, "第一段");
    merged = accumulateGroupedReplyText(merged, "第二段");
    merged = accumulateGroupedReplyText(merged, "第三段");
    expect(merged).toBe("第一段\n\n第二段\n\n第三段");

    const finalized = finalizeGroupedReplyText(merged, footer);
    expect(finalized).toBe(`第一段\n\n第二段\n\n第三段${footer}`);

    const finalizedAgain = finalizeGroupedReplyText(finalized, footer);
    expect(finalizedAgain).toBe(finalized);
  });
});
