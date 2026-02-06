import {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  type ResolvedFeishuAccount,
} from "./accounts.js";
import { sendFeishuText } from "./outbound.js";
import { startFeishuGateway } from "./gateway.js";
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
  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, cfg }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      await sendFeishuText({ account, chatId: to, text });
      return { channel: "feishu" };
    },
    // Media delivery: send caption text (media files not yet supported by the Feishu plugin).
    sendMedia: async ({ to, text, accountId, cfg }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      if (text) {
        await sendFeishuText({ account, chatId: to, text });
      }
      return { channel: "feishu" };
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
