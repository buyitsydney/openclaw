/**
 * Feishu ecosystem tools — register all tools absorbed from the community plugin.
 * Called from the plugin's register() entry point.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerFeishuBitableTools } from "./bitable.js";
import { registerFeishuCalendarTools } from "./calendar.js";
import { registerFeishuChatTools } from "./chat.js";
import { registerFeishuDirectoryTools } from "./directory.js";
import { registerFeishuDocTools } from "./docx.js";
import { registerFeishuDriveTools } from "./drive.js";
import { registerFeishuTaskTools } from "./task.js";
import { registerFeishuWikiTools } from "./wiki.js";

/** Register all feishu ecosystem tools (doc, wiki, drive, bitable, chat, directory, calendar, task). */
export function registerAllFeishuTools(api: OpenClawPluginApi): void {
  registerFeishuDocTools(api);
  registerFeishuWikiTools(api);
  registerFeishuDriveTools(api);
  registerFeishuBitableTools(api);
  registerFeishuChatTools(api);
  registerFeishuDirectoryTools(api);
  registerFeishuCalendarTools(api);
  registerFeishuTaskTools(api);
}
