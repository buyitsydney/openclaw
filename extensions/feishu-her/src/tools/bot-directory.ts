/**
 * Feishu Bot Directory tool — search, list, and refresh known bots.
 * Provides on-demand access to the bot registry without bloating prompt context.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { stringEnum } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { getTenantAccessToken, fetchChatHistory } from "./chat-history.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

type BotEntry = { name: string; appId: string; openId?: string };

function listAllBots(account: ResolvedFeishuAccount): BotEntry[] {
  const bots: BotEntry[] = [];
  const knownBots = account.knownBots ?? {};
  const knownOpenIds = account.knownBotOpenIds ?? {};
  // Build reverse map: app_id → open_id
  const appIdToOpenId = new Map<string, string>();
  for (const [openId, appId] of Object.entries(knownOpenIds)) {
    appIdToOpenId.set(appId.trim(), openId.trim());
  }
  for (const [appId, name] of Object.entries(knownBots)) {
    bots.push({ name, appId, openId: appIdToOpenId.get(appId) });
  }
  return bots;
}

/** Detect bots active in a group by scanning recent message history.
 * Feishu's member API excludes bots, so history is the only reliable source. */
async function listGroupBots(
  account: ResolvedFeishuAccount,
  chatId: string,
): Promise<BotEntry[]> {
  const token = await getTenantAccessToken(account);
  const now = Date.now();
  const result = await fetchChatHistory({
    account, token, chatId,
    startMs: now - 24 * 60 * 60 * 1000, // 24h window for broader coverage
    endMs: now,
    limit: 50,
  });

  const knownBots = account.knownBots ?? {};
  const knownOpenIds = account.knownBotOpenIds ?? {};
  const appIdToOpenId = new Map<string, string>();
  for (const [openId, appId] of Object.entries(knownOpenIds)) {
    appIdToOpenId.set(appId.trim(), openId.trim());
  }

  const seen = new Set<string>();
  const bots: BotEntry[] = [];
  for (const m of result.messages) {
    const isBot = m.sender_actor_kind === "bot" || m.sender_type === "app" || m.sender_type === "bot";
    if (!isBot) continue;
    const senderId = m.sender_id?.trim();
    if (!senderId || seen.has(senderId)) continue;

    let appId: string | undefined;
    let openId: string | undefined;
    if (senderId.startsWith("cli_") && senderId in knownBots) {
      appId = senderId;
      openId = appIdToOpenId.get(senderId);
    } else if (senderId.startsWith("ou_") && senderId in knownOpenIds) {
      openId = senderId;
      appId = knownOpenIds[senderId];
    }
    if (appId && !seen.has(appId)) {
      seen.add(appId);
      seen.add(senderId);
      bots.push({ name: knownBots[appId] ?? appId, appId, openId });
    }
  }
  return bots;
}

const BOT_DIR_ACTIONS = ["search", "list", "group_bots"] as const;

const BotDirectorySchema = Type.Object({
  action: stringEnum(BOT_DIR_ACTIONS, {
    description: "search=fuzzy name search, list=paginated full list, group_bots=list bots in current group (force refresh)",
  }),
  query: Type.Optional(Type.String({ description: "Search query (name or app_id substring, for search action)" })),
  chat_id: Type.Optional(Type.String({ description: "Group chat ID (for group_bots action)" })),
  page: Type.Optional(Type.Number({ description: "Page number for list (default 1, 20 per page)" })),
});

export function registerFeishuBotDirectoryTool(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount = accounts[0];

  api.registerTool(
    {
      name: "feishu_bot_directory",
      label: "Feishu Bot Directory",
      description:
        "Look up known bots. Actions: search (by name), list (paginated), group_bots (bots in a specific group, force refresh)",
      parameters: BotDirectorySchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          switch (params.action) {
            case "search": {
              const q = (params.query ?? "").toLowerCase().trim();
              if (!q) return json({ error: "query is required for search" });
              const all = listAllBots(firstAccount);
              const matches = all.filter(
                (b) =>
                  b.name.toLowerCase().includes(q) ||
                  b.appId.toLowerCase().includes(q) ||
                  (b.openId && b.openId.toLowerCase().includes(q)),
              );
              return json({ matches, total: matches.length });
            }
            case "list": {
              const all = listAllBots(firstAccount);
              const page = Math.max(1, params.page ?? 1);
              const pageSize = 20;
              const start = (page - 1) * pageSize;
              const slice = all.slice(start, start + pageSize);
              return json({
                bots: slice,
                page,
                total: all.length,
                total_pages: Math.ceil(all.length / pageSize),
              });
            }
            case "group_bots": {
              if (!params.chat_id) return json({ error: "chat_id is required for group_bots" });
              const bots = await listGroupBots(firstAccount, params.chat_id);
              return json({ bots, total: bots.length, chat_id: params.chat_id });
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_bot_directory" },
  );
  api.logger.info?.("feishu: registered feishu_bot_directory tool");
}
