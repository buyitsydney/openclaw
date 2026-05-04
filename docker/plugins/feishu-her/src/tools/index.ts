/**
 * Feishu-her unique tools — only business logic that has no replacement in
 * openclaw-lark or lark-cli. All commodity Feishu API tools (doc, wiki, drive,
 * bitable, chat, calendar, task, message, search, etc.) are now provided by
 * openclaw-lark (channel + 40 tools) and lark-cli (24 skills, 17 domains).
 *
 * Three-component architecture:
 *   openclaw-lark  = channel + commodity tools
 *   lark-cli       = 24 AI skills (mail, slides, approval, OKR, etc.)
 *   feishu-her     = unique business logic only (this plugin)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { registerFeishuBotDirectoryTool } from "./bot-directory.js";
import { registerDiscussionLeaderTool } from "./discussion-leader.js";
import { registerDiscussionLifecycleTools } from "./discussion-lifecycle.js";
import { registerGroupModeTool } from "./group-mode-tool.js";
import { registerFeishuKnowledgeQATool } from "./knowledge-qa.js";

/** Register feishu-her unique tools (discussion, knowledge_qa, group mode, bot directory). */
export async function registerAllFeishuTools(api: OpenClawPluginApi): Promise<void> {
  registerDiscussionLeaderTool(api);
  registerDiscussionLifecycleTools(api);
  registerGroupModeTool(api);
  registerFeishuBotDirectoryTool(api);
  registerFeishuKnowledgeQATool(api);
}
