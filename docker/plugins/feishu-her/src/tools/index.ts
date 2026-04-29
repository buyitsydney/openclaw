/**
 * Feishu ecosystem tools — register all tools absorbed from the community plugin.
 * Called from the plugin's register() entry point.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "../accounts.js";
import { fetchBackendUserScopes } from "../oauth.js";
import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuBoardTools } from "./board.js";
import { registerFeishuBotDirectoryTool } from "./bot-directory.js";
import { registerFeishuCalendarTools } from "./calendar.js";
import { registerFeishuChatCapabilityTool } from "./chat-capability.js";
import { registerFeishuChatControlTools } from "./chat-controls.js";
import { registerFeishuChatHistoryTool } from "./chat-history.js";
import { registerFeishuChatManageTools } from "./chat-manage.js";
import { registerFeishuChatMemberTools } from "./chat-members.js";
import { registerFeishuChatPinTools } from "./chat-pins.js";
import { registerFeishuChatTabTools } from "./chat-tabs.js";
import { registerFeishuChatTopNoticeTools } from "./chat-top-notice.js";
import { registerFeishuChatTools } from "./chat.js";
import { registerFeishuDeepSearchTool } from "./deep-search.js";
import { registerFeishuDirectoryTools } from "./directory.js";
import { registerDiscussionLeaderTool } from "./discussion-leader.js";
import { registerDiscussionLifecycleTools } from "./discussion-lifecycle.js";
import { registerFeishuDocCommentsTools } from "./doc-comments.js";
import { registerFeishuDocTools } from "./docx.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerGroupModeTool } from "./group-mode-tool.js";
import { registerFeishuKnowledgeQATool, KNOWLEDGE_QA_REQUIRED_SCOPE } from "./knowledge-qa.js";
import { registerFeishuMessageSearchTool } from "./message-search.js";
import { registerFeishuMessageTools } from "./message.js";
import { registerFeishuMinutesTools } from "./minutes.js";
import { registerFeishuSearchTool } from "./search.js";
import { registerFeishuSheetTools } from "./sheet.js";
import { registerFeishuTaskTools } from "./task.js";
import { registerFeishuWikiTools } from "./wiki.js";

/** Register all feishu ecosystem tools (doc, wiki, drive, bitable, chat, directory, calendar, task, message, minutes). */
export async function registerAllFeishuTools(api: OpenClawPluginApi): Promise<void> {
  registerFeishuDocTools(api);
  registerFeishuSearchTool(api);
  registerFeishuDeepSearchTool(api);
  registerFeishuWikiTools(api);
  registerFeishuDriveTools(api);
  registerFeishuDocCommentsTools(api);
  registerFeishuBitableTools(api);
  registerFeishuSheetTools(api);
  registerFeishuChatTools(api);
  registerFeishuChatManageTools(api);
  registerFeishuChatMemberTools(api);
  registerFeishuChatControlTools(api);
  registerFeishuChatTabTools(api);
  registerFeishuChatPinTools(api);
  registerFeishuChatTopNoticeTools(api);
  registerFeishuChatCapabilityTool(api);
  registerFeishuChatHistoryTool(api);
  registerFeishuDirectoryTools(api);
  registerFeishuCalendarTools(api);
  registerFeishuTaskTools(api);
  registerFeishuMessageTools(api);
  registerFeishuMessageSearchTool(api);
  registerFeishuMinutesTools(api);
  registerDiscussionLeaderTool(api);
  registerDiscussionLifecycleTools(api);
  registerGroupModeTool(api);
  registerFeishuBotDirectoryTool(api);
  registerFeishuBoardTools(api);
  // knowledge-qa: register synchronously so it makes the plugin capture
  // window. openclaw snapshots `captured.tools` immediately after this
  // `register()` returns (registry-*.js line 343:
  //   `registry.tools.push(...captured.tools.map(...))`), so any tool
  // pushed AFTER the snapshot (e.g. via `await fetchBackendUserScopes`)
  // never reaches `registry.tools` → Her's LLM never sees it. We register
  // sync unconditionally; the tool's own execute() already calls
  // `requireUserToken` which returns an auth_url to prompt re-authorization
  // if the scope is actually missing at invocation time. Backend scope is
  // only probed as a warning, not as a gate.
  registerFeishuKnowledgeQATool(api);
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length > 0) {
    void fetchBackendUserScopes(accounts[0])
      .then((scopes) => {
        if (scopes && !scopes.has(KNOWLEDGE_QA_REQUIRED_SCOPE)) {
          api.logger.warn?.(
            `feishu: knowledge_qa tool registered but backend lacks ${KNOWLEDGE_QA_REQUIRED_SCOPE}; invocations will return auth_url until scope is granted`,
          );
        }
      })
      .catch(() => {
        // Probe failure is non-fatal; tool's execute() handles scope misses
      });
  }
}
