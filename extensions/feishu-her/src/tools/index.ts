/**
 * Feishu ecosystem tools — register all tools absorbed from the community plugin.
 * Called from the plugin's register() entry point.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuCalendarTools } from "./calendar.js";
import { registerFeishuChatCapabilityTool } from "./chat-capability.js";
import { registerFeishuChatControlTools } from "./chat-controls.js";
import { registerFeishuChatManageTools } from "./chat-manage.js";
import { registerFeishuChatMemberTools } from "./chat-members.js";
import { registerFeishuChatPinTools } from "./chat-pins.js";
import { registerFeishuChatTabTools } from "./chat-tabs.js";
import { registerFeishuChatTools } from "./chat.js";
import { registerFeishuDirectoryTools } from "./directory.js";
import { registerFeishuDocTools } from "./docx.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerFeishuMessageTools } from "./message.js";
import { registerFeishuTaskTools } from "./task.js";
import { registerFeishuWikiTools } from "./wiki.js";

/** Register all feishu ecosystem tools (doc, wiki, drive, bitable, chat, directory, calendar, task, message). */
export function registerAllFeishuTools(api: OpenClawPluginApi): void {
  registerFeishuDocTools(api);
  registerFeishuWikiTools(api);
  registerFeishuDriveTools(api);
  registerFeishuBitableTools(api);
  registerFeishuChatTools(api);
  registerFeishuChatManageTools(api);
  registerFeishuChatMemberTools(api);
  registerFeishuChatControlTools(api);
  registerFeishuChatTabTools(api);
  registerFeishuChatPinTools(api);
  registerFeishuChatCapabilityTool(api);
  registerFeishuDirectoryTools(api);
  registerFeishuCalendarTools(api);
  registerFeishuTaskTools(api);
  registerFeishuMessageTools(api);
}
