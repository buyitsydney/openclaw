import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `memory-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(testDir, "workspace", "memory"), { recursive: true });
  mkdirSync(join(testDir, "feishu-groups"), { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", testDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

describe("cacheDocToMemory", () => {
  it("writes document content as .md to feishu-docs dir", async () => {
    const { cacheDocToMemory } = await import("./memory-bridge.js");
    cacheDocToMemory({
      docToken: "abc123def456",
      title: "飞书搜索架构",
      content: "这是文档正文内容。\n\n## 第二章\n\n详细描述。",
      source: "wiki",
      url: "https://example.feishu.cn/wiki/abc123",
    });

    const docsDir = join(testDir, "workspace", "memory", "feishu-docs");
    expect(existsSync(docsDir)).toBe(true);

    const files = require("node:fs").readdirSync(docsDir) as string[];
    expect(files.length).toBe(1);
    expect(files[0]).toContain("飞书搜索架构");
    expect(files[0].endsWith(".md")).toBe(true);

    const content = readFileSync(join(docsDir, files[0]), "utf-8");
    expect(content).toContain("# 飞书搜索架构");
    expect(content).toContain("source: feishu-wiki");
    expect(content).toContain("token: abc123def456");
    expect(content).toContain("这是文档正文内容。");
  });
});

describe("cacheMinutesToMemory", () => {
  it("writes minutes summary as .md to feishu-minutes dir", async () => {
    const { cacheMinutesToMemory } = await import("./memory-bridge.js");
    cacheMinutesToMemory({
      minuteToken: "obcn_meeting_1",
      title: "AI采购讨论会",
      summary: "会议讨论了AI采购预算和供应商选择。",
    });

    const minDir = join(testDir, "workspace", "memory", "feishu-minutes");
    expect(existsSync(minDir)).toBe(true);

    const files = require("node:fs").readdirSync(minDir) as string[];
    expect(files.length).toBe(1);
    expect(files[0]).toContain("AI采购讨论会");

    const content = readFileSync(join(minDir, files[0]), "utf-8");
    expect(content).toContain("source: feishu-minutes");
    expect(content).toContain("会议讨论了AI采购预算");
  });
});

describe("syncGroupArchivesToMemory", () => {
  it("converts group archive JSONL to memory .md files", async () => {
    const chatId = "oc_test_group_123";
    const chatDir = join(testDir, "feishu-groups", chatId);
    mkdirSync(chatDir, { recursive: true });

    writeFileSync(
      join(testDir, "feishu-groups", "index.json"),
      JSON.stringify({ [chatId]: { name: "测试群" } }),
    );

    const messages = [
      { ts: 1700000000, sender: "张三", senderId: "ou_1", text: "讨论搜索方案", msgId: "m1" },
      { ts: 1700000060, sender: "李四", senderId: "ou_2", text: "同意方案A", msgId: "m2" },
    ];
    writeFileSync(
      join(chatDir, "messages.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n"),
    );

    const { syncGroupArchivesToMemory } = await import("./memory-bridge.js");
    const result = syncGroupArchivesToMemory();

    expect(result.synced).toBe(1);

    const memGroupDir = join(testDir, "workspace", "memory", "feishu-groups");
    expect(existsSync(memGroupDir)).toBe(true);

    const files = require("node:fs").readdirSync(memGroupDir) as string[];
    expect(files.length).toBe(1);

    const content = readFileSync(join(memGroupDir, files[0]), "utf-8");
    expect(content).toContain("# 群聊归档：测试群");
    expect(content).toContain("讨论搜索方案");
    expect(content).toContain("同意方案A");
    expect(content).toContain("张三");
  });

  it("skips groups without messages", async () => {
    const chatDir = join(testDir, "feishu-groups", "oc_empty");
    mkdirSync(chatDir, { recursive: true });

    const { syncGroupArchivesToMemory } = await import("./memory-bridge.js");
    const result = syncGroupArchivesToMemory();

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
