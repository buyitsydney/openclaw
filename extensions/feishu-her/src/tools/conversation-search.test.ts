import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConversationSearchTool } from "./conversation-search.js";

type ToolDef = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details: unknown }>;
};

let testDir: string;

function createApi() {
  const registerTool = vi.fn();
  return {
    registerTool,
    api: {
      config: {},
      logger: { info: vi.fn() },
      registerTool,
    } as never,
  };
}

function getTool(registerTool: ReturnType<typeof vi.fn>): ToolDef {
  const tool = registerTool.mock.calls[0]?.[0] as ToolDef | undefined;
  expect(tool).toBeDefined();
  return tool!;
}

beforeEach(() => {
  testDir = join(tmpdir(), `conv-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, "feishu-groups"), { recursive: true });
  mkdirSync(join(testDir, "agents", "main", "sessions"), { recursive: true });
  vi.stubEnv("OPENCLAW_STATE_DIR", testDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

describe("feishu_conversation_search tool", () => {
  it("registers the tool", () => {
    const { api, registerTool } = createApi();
    registerConversationSearchTool(api);
    expect(registerTool).toHaveBeenCalled();
    const tool = getTool(registerTool);
    expect(tool.name).toBe("feishu_conversation_search");
  });

  it("searches group archives by keyword", async () => {
    const chatId = "oc_test_123";
    const chatDir = join(testDir, "feishu-groups", chatId);
    mkdirSync(chatDir, { recursive: true });

    writeFileSync(
      join(testDir, "feishu-groups", "index.json"),
      JSON.stringify({ [chatId]: { name: "AI讨论群" } }),
    );

    const messages = [
      { ts: 1700000000, sender: "张三", senderId: "ou_1", text: "AI采购方案讨论", msgId: "m1" },
      { ts: 1700000060, sender: "李四", senderId: "ou_2", text: "同意预算分配", msgId: "m2" },
      { ts: 1700000120, sender: "张三", senderId: "ou_1", text: "AI模型选型建议", msgId: "m3" },
    ];
    writeFileSync(
      join(chatDir, "messages.jsonl"),
      messages.map((m) => JSON.stringify(m)).join("\n"),
    );

    const { api, registerTool } = createApi();
    registerConversationSearchTool(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("tc_group", { keyword: "AI" });
    const details = result.details as Record<string, unknown>;

    expect(details.total).toBeGreaterThan(0);
    const results = details.results as Array<{ source: string; snippet: string; sender: string }>;
    expect(results.every((r) => r.source === "group_archive")).toBe(true);
    expect(results.some((r) => r.snippet.includes("AI"))).toBe(true);
  });

  it("searches session history by keyword", async () => {
    const sessionFile = join(testDir, "agents", "main", "sessions", "2026-03-09.jsonl");
    const entries = [
      {
        type: "message",
        timestamp: "2026-03-09T14:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "帮我搜索一下飞书文档" }] },
      },
      {
        type: "message",
        timestamp: "2026-03-09T14:00:05Z",
        message: { role: "assistant", content: [{ type: "text", text: "我来帮你搜索飞书文档。" }] },
      },
      {
        type: "message",
        timestamp: "2026-03-09T14:00:10Z",
        message: { role: "tool", content: [{ type: "text", text: '{"results": []}' }] },
      },
      {
        type: "message",
        timestamp: "2026-03-09T14:00:15Z",
        message: { role: "user", content: [{ type: "text", text: "看一下预算表" }] },
      },
    ];
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n"));

    const { api, registerTool } = createApi();
    registerConversationSearchTool(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("tc_session", { keyword: "飞书", scope: "sessions" });
    const details = result.details as Record<string, unknown>;

    expect(details.total).toBeGreaterThan(0);
    const results = details.results as Array<{ source: string; sender: string }>;
    // Tool results should be filtered out
    expect(results.every((r) => r.source === "session")).toBe(true);
    expect(results.some((r) => r.sender === "用户")).toBe(true);
    expect(results.some((r) => r.sender === "Her")).toBe(true);
  });

  it("returns error when keyword is empty", async () => {
    const { api, registerTool } = createApi();
    registerConversationSearchTool(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("tc_empty", { keyword: "" });
    const details = result.details as Record<string, unknown>;
    expect(details.error).toContain("keyword");
  });

  it("respects scope=groups to skip sessions", async () => {
    const sessionFile = join(testDir, "agents", "main", "sessions", "2026-03-09.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-09T14:00:00Z",
        message: { role: "user", content: [{ type: "text", text: "test keyword" }] },
      }),
    );

    const { api, registerTool } = createApi();
    registerConversationSearchTool(api);
    const tool = getTool(registerTool);

    const result = await tool.execute("tc_groups_only", { keyword: "test", scope: "groups" });
    const details = result.details as Record<string, unknown>;
    const stats = details.stats as { session: number };
    expect(stats.session).toBe(0);
  });
});
