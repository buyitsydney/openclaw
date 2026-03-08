import {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  createActionGate,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  jsonResult,
  normalizeAccountId,
  readStringParam,
  setAccountEnabledInConfigSection,
  type ChannelMessageActionName,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  type ResolvedFeishuAccount,
} from "./accounts.js";
import { startFeishuGateway, recordSentMessage } from "./gateway.js";
import { archiveSentFeishuBinaryMessage } from "./group-archive.js";
import {
  sendFeishuText,
  sendFeishuRichText,
  uploadFeishuImage,
  sendFeishuImage,
  uploadFeishuAudio,
  sendFeishuAudio,
  uploadFeishuFile,
  sendFeishuFile,
  sendFeishuVideo,
  addFeishuReaction,
  removeFeishuReaction,
  deleteFeishuMessage,
} from "./outbound.js";
import { getFeishuRuntime } from "./runtime.js";

const meta = {
  id: "feishu" as const,
  label: "Feishu",
  selectionLabel: "Feishu (Lark Bot)",
  detailLabel: "Feishu Bot",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "Feishu/Lark bot via WebSocket long connection.",
  aliases: ["lark", "fs"],
  order: 60,
};

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.feishu"] },
  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "feishu",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "feishu",
        accountId,
        clearBaseFields: ["appId", "appSecret", "name"],
      }),
    isConfigured: (account) => Boolean(account.appId && account.appSecret),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId && account.appSecret),
      credentialSource: account.credentialSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveFeishuAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map(String),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(feishu|lark|fs):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const section = cfg.channels?.["feishu"] as Record<string, unknown> | undefined;
      const accounts = section?.accounts as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.feishu.accounts.${resolvedAccountId}.`
        : "channels.feishu.";
      return {
        policy: account.config.dm?.policy ?? "open",
        allowFrom: account.config.dm?.allowFrom ?? [],
        policyPath: `${basePath}dm.policy`,
        allowFromPath: `${basePath}dm.`,
        approveHint: formatPairingApproveHint("feishu"),
      };
    },
  },
  pairing: {
    idLabel: "feishuUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(feishu|lark|fs):/i, ""),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "feishu",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.useEnv && !input.appToken && !input.token) {
        return "Feishu requires appId and appSecret (or --use-env for FEISHU_APP_ID/FEISHU_APP_SECRET).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "feishu",
        accountId,
        name: input.name,
      });
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            feishu: {
              ...(namedConfig.channels?.["feishu"] as Record<string, unknown>),
              enabled: true,
            },
          },
        };
      }
      const section = namedConfig.channels?.["feishu"] as Record<string, unknown> | undefined;
      const accounts = (section?.accounts ?? {}) as Record<string, unknown>;
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          feishu: {
            ...section,
            enabled: true,
            accounts: {
              ...accounts,
              [accountId]: {
                ...(accounts[accountId] as Record<string, unknown>),
                enabled: true,
              },
            },
          },
        },
      };
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => raw.replace(/^(feishu|lark|fs):/i, "").trim(),
    targetResolver: {
      looksLikeId: (raw: string) => {
        const trimmed = raw.replace(/^(feishu|lark|fs):/i, "").trim();
        // Feishu IDs: oc_ (chat), ou_ (open_id), on_ (union_id)
        return /^(oc_|ou_|on_)/.test(trimmed);
      },
      hint: "<chat_id (oc_...) | open_id (ou_...) | union_id (on_...)>",
    },
  },
  actions: {
    listActions: ({ cfg }) => {
      if (!cfg.channels?.["feishu"]) return [];
      const section = cfg.channels["feishu"] as Record<string, unknown> | undefined;
      const gate = createActionGate(section?.actions as Record<string, boolean> | undefined);
      const actions = new Set<ChannelMessageActionName>();
      if (gate("reactions")) {
        actions.add("react");
      }
      if (gate("deleteMessage")) {
        actions.add("delete");
      }
      return Array.from(actions);
    },
    supportsAction: ({ action }) => action === "react" || action === "delete",
    handleAction: async ({ action, params, cfg, accountId }) => {
      if (action === "delete") {
        const account = resolveFeishuAccount({ cfg, accountId });
        const messageId = readStringParam(params, "messageId", { required: true });
        const result = await deleteFeishuMessage({ account, messageId });
        return jsonResult({
          ok: result.ok,
          deleted: messageId,
          code: result.code,
          msg: result.msg,
        });
      }
      if (action !== "react") {
        throw new Error(`Action "${action}" is not supported for Feishu.`);
      }
      const account = resolveFeishuAccount({ cfg, accountId });
      const messageIdParam = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;

      if (remove) {
        // Remove requires a reaction_id. The caller must pass it as messageId (reaction_id).
        // Feishu's remove API needs both message_id and reaction_id.
        // Convention: params.messageId = the message, params.groupId = the reaction_id to remove.
        const reactionId = readStringParam(params, "groupId");
        if (!reactionId) {
          throw new Error(
            "Feishu reaction removal requires a reaction_id (pass via groupId param).",
          );
        }
        const ok = await removeFeishuReaction({ account, messageId: messageIdParam, reactionId });
        return jsonResult({ ok, removed: true });
      }

      if (!emoji) {
        throw new Error("Emoji is required to add a Feishu reaction.");
      }
      const reactionId = await addFeishuReaction({ account, messageId: messageIdParam, emoji });
      return jsonResult({ ok: !!reactionId, added: emoji, reactionId });
    },
  },
  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = (to ?? "").replace(/^(feishu|lark|fs):/i, "").trim();
      if (!trimmed) {
        return { ok: false as const, error: new Error("Feishu target is required") };
      }
      // Accept oc_ (chat), ou_ (open_id), on_ (union_id) prefixes.
      if (/^(oc_|ou_|on_)/.test(trimmed)) {
        return { ok: true as const, to: trimmed };
      }
      return {
        ok: false as const,
        error: new Error(
          `Invalid Feishu target "${trimmed}". Use chat_id (oc_...), open_id (ou_...), or union_id (on_...).`,
        ),
      };
    },
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      const mid = await sendFeishuRichText({ account, chatId: to, text });
      if (mid) recordSentMessage(to, mid, text);
      return { channel: "feishu", messageId: mid ?? "" };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      const log = getFeishuRuntime().logging.getChildLogger({
        subsystem: "gateway/channels/feishu",
      });
      let lastMid: string | undefined;
      if (mediaUrl) {
        try {
          const { loadWebMedia } = await import("openclaw/plugin-sdk");
          const { readFile } = await import("node:fs/promises");
          const FEISHU_MAX_BYTES = 30 * 1024 * 1024;
          const media = await loadWebMedia(mediaUrl, {
            maxBytes: FEISHU_MAX_BYTES,
            sandboxValidated: true,
            readFile: (f: string) => readFile(f),
            optimizeImages: false,
          });
          if (media?.buffer) {
            if (media.contentType?.startsWith("audio/")) {
              const fileName =
                mediaUrl.split("/").pop()?.split("?")[0] ?? `audio-${Date.now()}.ogg`;
              const fileKey = await uploadFeishuAudio({ account, buffer: media.buffer });
              lastMid = await sendFeishuAudio({ account, chatId: to, fileKey });
              if (lastMid) {
                recordSentMessage(to, lastMid, "[audio]");
                try {
                  await archiveSentFeishuBinaryMessage({
                    chatId: to,
                    messageId: lastMid,
                    senderId: account.appId,
                    buffer: media.buffer,
                    contentType: media.contentType,
                    fileName,
                    defaultBaseName: "sent-audio",
                  });
                } catch (err) {
                  log.error(`[${account.accountId}] sent audio archive failed: ${String(err)}`);
                }
              }
            } else if (media.contentType?.startsWith("video/")) {
              const fileName =
                mediaUrl.split("/").pop()?.split("?")[0] ?? `video-${Date.now()}.mp4`;
              const fileKey = await uploadFeishuFile({ account, buffer: media.buffer, fileName });
              lastMid = await sendFeishuVideo({ account, chatId: to, fileKey });
              if (lastMid) {
                recordSentMessage(to, lastMid, "[video]");
                try {
                  await archiveSentFeishuBinaryMessage({
                    chatId: to,
                    messageId: lastMid,
                    senderId: account.appId,
                    buffer: media.buffer,
                    contentType: media.contentType,
                    fileName,
                    defaultBaseName: "sent-video",
                  });
                } catch (err) {
                  log.error(`[${account.accountId}] sent video archive failed: ${String(err)}`);
                }
              }
            } else if (media.contentType?.startsWith("image/")) {
              const fileName =
                mediaUrl.split("/").pop()?.split("?")[0] ?? `image-${Date.now()}.png`;
              const imageKey = await uploadFeishuImage({ account, buffer: media.buffer });
              lastMid = await sendFeishuImage({ account, chatId: to, imageKey });
              if (lastMid) {
                recordSentMessage(to, lastMid, "[image]");
                try {
                  await archiveSentFeishuBinaryMessage({
                    chatId: to,
                    messageId: lastMid,
                    senderId: account.appId,
                    buffer: media.buffer,
                    contentType: media.contentType,
                    fileName,
                    defaultBaseName: "sent-image",
                  });
                } catch (err) {
                  log.error(`[${account.accountId}] sent image archive failed: ${String(err)}`);
                }
              }
            } else {
              const fileName = mediaUrl.split("/").pop()?.split("?")[0] ?? `file-${Date.now()}`;
              const fileKey = await uploadFeishuFile({
                account,
                buffer: media.buffer,
                fileName,
              });
              lastMid = await sendFeishuFile({ account, chatId: to, fileKey });
              if (lastMid) {
                recordSentMessage(to, lastMid, `[file] ${fileName}`);
                try {
                  await archiveSentFeishuBinaryMessage({
                    chatId: to,
                    messageId: lastMid,
                    senderId: account.appId,
                    buffer: media.buffer,
                    contentType: media.contentType,
                    fileName,
                    defaultBaseName: "sent-file",
                  });
                } catch (err) {
                  log.error(`[${account.accountId}] sent file archive failed: ${String(err)}`);
                }
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("文件太大") ||
            msg.includes("飞书文件上传失败") ||
            msg.includes("exceeds") ||
            msg.includes("limit") ||
            msg.includes("upload failed") ||
            msg.includes("230055")
          ) {
            throw new Error(msg);
          }
          const mid = await sendFeishuText({ account, chatId: to, text: `[media] ${mediaUrl}` });
          if (mid) {
            lastMid = mid;
            recordSentMessage(to, mid, `[media] ${mediaUrl}`);
          }
        }
      }
      if (text) {
        const mid = await sendFeishuRichText({ account, chatId: to, text });
        if (mid) {
          lastMid = mid;
          recordSentMessage(to, mid, text);
        }
      }
      return { channel: "feishu", messageId: lastMid ?? "" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId && account.appSecret),
      credentialSource: account.credentialSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.appId || !account.appSecret) {
        throw new Error("Feishu appId and appSecret are required");
      }
      ctx.log?.info(`[${account.accountId}] starting Feishu bot`);
      ctx.setStatus({
        ...ctx.getStatus(),
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });
      return startFeishuGateway({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        setStatus: (patch) => ctx.setStatus({ ...ctx.getStatus(), ...patch }),
      });
    },
  },
};
