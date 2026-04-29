/**
 * Race regression for feishu_knowledge_qa:
 * openclaw snapshots `captured.tools` immediately after a plugin's
 * `register()` returns (registry-*.js: `registry.tools.push(...captured.tools.map(...))`).
 * If knowledge-qa is registered inside an `await`ed async branch, it
 * arrives AFTER the snapshot and never reaches `registry.tools` →
 * Her's LLM never sees it.
 *
 * Pre-fix shape:
 *   await fetchBackendUserScopes(...)   // <-- takes ~23s in prod
 *   if (scope ok) registerFeishuKnowledgeQATool(api)
 *
 * Post-fix shape:
 *   registerFeishuKnowledgeQATool(api)                // sync
 *   void fetchBackendUserScopes(...).then(warn-only)  // async, non-gating
 *
 * This test locks the invariant: `feishu_knowledge_qa` must be registered
 * SYNCHRONOUSLY — i.e. present on the api before `registerAllFeishuTools`
 * yields the microtask queue.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listEnabledFeishuAccountsMock = vi.hoisted(() => vi.fn());
const fetchBackendUserScopesMock = vi.hoisted(() => vi.fn());

vi.mock("../accounts.js", () => ({
  listEnabledFeishuAccounts: listEnabledFeishuAccountsMock,
}));
vi.mock("../oauth.js", () => ({
  fetchBackendUserScopes: fetchBackendUserScopesMock,
}));

// Mock every other feishu tool register — we only care about knowledge_qa.
// Use a factory that records the tool name so the test can inspect timing.
function mkStubRegister(toolName: string) {
  return (api: { registerTool: (t: { name: string }) => void }) => {
    api.registerTool({ name: toolName });
  };
}
vi.mock("./bitable.js", () => ({ registerFeishuBitableTools: mkStubRegister("feishu_bitable") }));
vi.mock("./board.js", () => ({ registerFeishuBoardTools: mkStubRegister("feishu_board") }));
vi.mock("./bot-directory.js", () => ({ registerFeishuBotDirectoryTool: mkStubRegister("feishu_bot_directory") }));
vi.mock("./calendar.js", () => ({ registerFeishuCalendarTools: mkStubRegister("feishu_calendar") }));
vi.mock("./chat-capability.js", () => ({ registerFeishuChatCapabilityTool: mkStubRegister("feishu_chat_capability") }));
vi.mock("./chat-controls.js", () => ({ registerFeishuChatControlTools: mkStubRegister("feishu_chat_controls") }));
vi.mock("./chat-history.js", () => ({ registerFeishuChatHistoryTool: mkStubRegister("feishu_group_history") }));
vi.mock("./chat-manage.js", () => ({ registerFeishuChatManageTools: mkStubRegister("feishu_chat_manage") }));
vi.mock("./chat-members.js", () => ({ registerFeishuChatMemberTools: mkStubRegister("feishu_chat_members") }));
vi.mock("./chat-pins.js", () => ({ registerFeishuChatPinTools: mkStubRegister("feishu_chat_pins") }));
vi.mock("./chat-tabs.js", () => ({ registerFeishuChatTabTools: mkStubRegister("feishu_chat_tabs") }));
vi.mock("./chat-top-notice.js", () => ({ registerFeishuChatTopNoticeTools: mkStubRegister("feishu_chat_top_notice") }));
vi.mock("./chat.js", () => ({ registerFeishuChatTools: mkStubRegister("feishu_chat") }));
vi.mock("./deep-search.js", () => ({ registerFeishuDeepSearchTool: mkStubRegister("feishu_deep_search") }));
vi.mock("./directory.js", () => ({ registerFeishuDirectoryTools: mkStubRegister("feishu_directory") }));
vi.mock("./discussion-leader.js", () => ({ registerDiscussionLeaderTool: mkStubRegister("feishu_discussion_leader") }));
vi.mock("./discussion-lifecycle.js", () => ({ registerDiscussionLifecycleTools: mkStubRegister("feishu_discussion_lifecycle") }));
vi.mock("./doc-comments.js", () => ({ registerFeishuDocCommentsTools: mkStubRegister("feishu_doc_comments") }));
vi.mock("./docx.js", () => ({ registerFeishuDocTools: mkStubRegister("feishu_doc") }));
vi.mock("./drive.js", () => ({ registerFeishuDriveTools: mkStubRegister("feishu_drive") }));
vi.mock("./group-mode-tool.js", () => ({ registerGroupModeTool: mkStubRegister("feishu_group_mode") }));
vi.mock("./knowledge-qa.js", () => ({
  registerFeishuKnowledgeQATool: mkStubRegister("feishu_knowledge_qa"),
  KNOWLEDGE_QA_REQUIRED_SCOPE: "search:knowledge_qa:read",
}));
vi.mock("./message-search.js", () => ({ registerFeishuMessageSearchTool: mkStubRegister("feishu_message_search") }));
vi.mock("./message.js", () => ({ registerFeishuMessageTools: mkStubRegister("feishu_message") }));
vi.mock("./minutes.js", () => ({ registerFeishuMinutesTools: mkStubRegister("feishu_minutes") }));
vi.mock("./search.js", () => ({ registerFeishuSearchTool: mkStubRegister("feishu_search") }));
vi.mock("./sheet.js", () => ({ registerFeishuSheetTools: mkStubRegister("feishu_sheet") }));
vi.mock("./task.js", () => ({ registerFeishuTaskTools: mkStubRegister("feishu_task") }));
vi.mock("./wiki.js", () => ({ registerFeishuWikiTools: mkStubRegister("feishu_wiki") }));

import { registerAllFeishuTools } from "./index.js";

describe("registerAllFeishuTools — knowledge-qa race fix", () => {
  beforeEach(() => {
    listEnabledFeishuAccountsMock.mockReset();
    fetchBackendUserScopesMock.mockReset();
  });

  it("registers feishu_knowledge_qa SYNCHRONOUSLY (before fetchBackendUserScopes resolves)", () => {
    listEnabledFeishuAccountsMock.mockReturnValue([
      { accountId: "primary", appId: "cli_test", appSecret: "s" },
    ]);
    // Scope probe returns a pending promise that never resolves during this
    // test — simulates prod's ~23s feishu backend roundtrip. If registration
    // depends on this resolving, knowledge_qa won't be in `registered`.
    fetchBackendUserScopesMock.mockReturnValue(new Promise(() => {}));

    const registered: string[] = [];
    const api = {
      config: {
        channels: { feishu: { enabled: true, defaultAccount: "primary", appId: "cli_test", appSecret: "s" } },
      },
      logger: { info: () => {}, warn: () => {} },
      registerChannel: () => {},
      registerTool: (t: { name: string }) => { registered.push(t.name); },
    } as unknown as Parameters<typeof registerAllFeishuTools>[0];

    // Call — the ASYNC Promise returned here is intentionally ignored, just
    // like the plugin's `register()` does. After this line the openclaw
    // snapshot would happen (registry.ts:343). We assert the same moment.
    void registerAllFeishuTools(api);

    expect(registered).toContain("feishu_knowledge_qa");
  });

  it("also registers knowledge_qa when scope probe resolves successfully", async () => {
    listEnabledFeishuAccountsMock.mockReturnValue([
      { accountId: "primary", appId: "cli_test", appSecret: "s" },
    ]);
    fetchBackendUserScopesMock.mockResolvedValue(new Set(["search:knowledge_qa:read"]));
    const registered: string[] = [];
    const api = {
      config: {
        channels: { feishu: { enabled: true, defaultAccount: "primary", appId: "cli_test", appSecret: "s" } },
      },
      logger: { info: () => {}, warn: () => {} },
      registerChannel: () => {},
      registerTool: (t: { name: string }) => { registered.push(t.name); },
    } as unknown as Parameters<typeof registerAllFeishuTools>[0];

    await registerAllFeishuTools(api);
    expect(registered).toContain("feishu_knowledge_qa");
  });

  it("still registers knowledge_qa when scope probe rejects (network down)", async () => {
    listEnabledFeishuAccountsMock.mockReturnValue([
      { accountId: "primary", appId: "cli_test", appSecret: "s" },
    ]);
    fetchBackendUserScopesMock.mockRejectedValue(new Error("network down"));
    const registered: string[] = [];
    const api = {
      config: {
        channels: { feishu: { enabled: true, defaultAccount: "primary", appId: "cli_test", appSecret: "s" } },
      },
      logger: { info: () => {}, warn: () => {} },
      registerChannel: () => {},
      registerTool: (t: { name: string }) => { registered.push(t.name); },
    } as unknown as Parameters<typeof registerAllFeishuTools>[0];

    await registerAllFeishuTools(api);
    expect(registered).toContain("feishu_knowledge_qa");
  });
});
