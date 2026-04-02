/**
 * Feishu Message tool — recall (delete) bot-sent messages and list recent sent IDs.
 * AI calls this to undo its own replies when asked, or to inspect what it recently sent.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { stringEnum } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts, type ResolvedFeishuAccount } from "../accounts.js";
import { deleteFeishuMessage } from "../outbound.js";
import { getRecentSentMessages, removeSentMessage } from "../sent-message-log.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Schema ──

const MESSAGE_ACTIONS = ["delete", "list_sent"] as const;

const FeishuMessageSchema = Type.Object({
  action: stringEnum(MESSAGE_ACTIONS, {
    description:
      "delete: recall a bot-sent message by message_id (within 24h). " +
      "list_sent: list recent bot-sent message IDs for a chat.",
  }),
  message_id: Type.Optional(
    Type.String({ description: "Message ID (om_xxx) to delete. Required for delete action." }),
  ),
  chat_id: Type.Optional(
    Type.String({
      description: "Chat ID (oc_xxx or ou_xxx) for list_sent. Required for list_sent action.",
    }),
  ),
  count: Type.Optional(
    Type.Number({
      description: "Number of recent messages to return for list_sent (default 10, max 50).",
    }),
  ),
});

// ── Registration ──

export function registerFeishuMessageTools(api: OpenClawPluginApi) {
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) return;
  const firstAccount: ResolvedFeishuAccount = accounts[0];

  api.registerTool(
    {
      name: "feishu_message",
      label: "Feishu Message Recall",
      description:
        "Recall (delete/unsend) bot-sent Feishu messages or list recent sent message IDs. " +
        "Bot can only recall its own messages sent within the last 24 hours. " +
        "When the user quotes a message and asks to recall, the quoted message's message_id " +
        "is included in the context as (message_id=om_xxx) — use it directly with delete. " +
        "Otherwise, use list_sent first to find the message_id (returns preview text), then delete.",
      parameters: FeishuMessageSchema,
      // oxlint-disable-next-line typescript/no-explicit-any
      async execute(_toolCallId: string, params: any) {
        try {
          switch (params.action) {
            case "delete": {
              if (!params.message_id) {
                return json({ error: "message_id is required for delete action" });
              }
              const result = await deleteFeishuMessage({
                account: firstAccount,
                messageId: params.message_id,
              });
              if (result.ok) {
                removeSentMessage(params.chat_id, params.message_id);
                return json({ ok: true, recalled: params.message_id });
              }
              return json({
                ok: false,
                error: `Failed to recall: code=${result.code} msg=${result.msg || "(no details from Feishu)"}`,
                hint:
                  result.code === 230001
                    ? "Message may be older than 24 hours or not sent by the bot."
                    : undefined,
              });
            }
            case "list_sent": {
              if (!params.chat_id) {
                return json({ error: "chat_id is required for list_sent action" });
              }
              const count = Math.min(Math.max(params.count ?? 10, 1), 50);
              const messages = getRecentSentMessages(params.chat_id, count);
              return json({
                chat_id: params.chat_id,
                messages: messages.map((m) => ({
                  message_id: m.messageId,
                  sent_at: new Date(m.sentAt).toISOString(),
                  age_minutes: Math.round((Date.now() - m.sentAt) / 60000),
                  ...(m.preview ? { preview: m.preview } : {}),
                })),
                total: messages.length,
              });
            }
            default:
              return json({ error: `Unknown action: ${params.action}` });
          }
        } catch (err) {
          let msg = err instanceof Error ? err.message : String(err);
          if (!msg || msg === "undefined") {
            // Feishu SDK sometimes throws AggregateError with empty message
            const code =
              (err as Record<string, unknown>)?.code ?? (err as Record<string, unknown>)?.status;
            msg = code ? `Feishu API error (code=${code})` : "Unknown Feishu API error";
          }
          return json({ error: msg });
        }
      },
    },
    { name: "feishu_message" },
  );
  api.logger.info?.("feishu: registered feishu_message tool");
}
