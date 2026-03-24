/**
 * Feishu ecosystem tools — register all tools absorbed from the community plugin.
 * Called from the plugin's register() entry point.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "../accounts.js";
import { fetchBackendUserScopes } from "../oauth.js";
import { registerFeishuBitableTools } from "./bitable.js";
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
import { registerFeishuDocTools } from "./docx.js";
import { registerFeishuDriveTools } from "./drive.js";
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
  // Gate knowledge-qa on backend scope availability (auto-detected, no config needed)
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length > 0) {
    const backendScopes = await fetchBackendUserScopes(accounts[0]);
    if (!backendScopes || backendScopes.has(KNOWLEDGE_QA_REQUIRED_SCOPE)) {
      registerFeishuKnowledgeQATool(api);
    } else {
      api.logger.info?.(
        `feishu: skipping knowledge_qa tool (scope ${KNOWLEDGE_QA_REQUIRED_SCOPE} not in app backend)`,
      );
    }
  }
}
