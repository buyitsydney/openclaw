import type { OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/channel-plugin-common";
import { normalizeAccountId } from "openclaw/plugin-sdk/core";

export type FeishuCredentialSource = "config" | "env" | "none";

/** Per-account config stored under channels.feishu.accounts.<id> or channels.feishu.* */
export type FeishuAccountConfig = {
  name?: string;
  knownBots?: Record<string, string>;
  knownBotOpenIds?: Record<string, string>;
  botOpenId?: string;
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  dm?: {
    policy?: string;
    allowFrom?: string[];
  };
  groups?: {
    /** Enable group chat support (default: false). */
    enabled?: boolean;
    /** Archive all group messages to local JSONL files (default: true when groups enabled). */
    archive?: boolean;
    /** Explicit owner open_ids for group chats. Falls back to dm.allowFrom if not set. */
    ownerIds?: string[];
  };
  /** Card stream version: "v1" (inline card + patch, default) or "v2" (CardKit streaming). */
  cardStreamVersion?: "v1" | "v2";
  [key: string]: unknown;
};

/** Resolve owner IDs for group chat gating.
 *  Priority: groups.ownerIds > dm.allowFrom. */
export function resolveGroupOwnerIds(accountConfig: FeishuAccountConfig): string[] {
  const groupOwners = accountConfig.groups?.ownerIds;
  if (groupOwners && groupOwners.length > 0) {return groupOwners;}
  return accountConfig.dm?.allowFrom ?? [];
}

export type ResolvedFeishuAccount = {
  accountId: string;
  name?: string;
  knownBots: Record<string, string>;
  knownBotOpenIds?: Record<string, string>;
  botOpenId?: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  credentialSource: FeishuCredentialSource;
  config: FeishuAccountConfig;
};

const ENV_APP_ID = "FEISHU_APP_ID";
const ENV_APP_SECRET = "FEISHU_APP_SECRET";

function trimIfString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKnownBots(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [appId, label] of Object.entries(value as Record<string, unknown>)) {
    const normalizedAppId = trimIfString(appId);
    const normalizedLabel = trimIfString(label);
    if (!normalizedAppId || !normalizedLabel) {continue;}
    normalized[normalizedAppId] = normalizedLabel;
  }
  return normalized;
}

function normalizeKnownBotOpenIds(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [openId, appId] of Object.entries(value as Record<string, unknown>)) {
    const normalizedOpenId = trimIfString(openId);
    const normalizedAppId = trimIfString(appId);
    if (!normalizedOpenId || !normalizedAppId) {continue;}
    normalized[normalizedOpenId] = normalizedAppId;
  }
  return normalized;
}

export function resolveFeishuAccountLabel(
  account: Pick<ResolvedFeishuAccount, "accountId" | "name">,
): string | undefined {
  const configuredName = trimIfString(account.name);
  if (configuredName) {
    return configuredName;
  }
  const accountId = trimIfString(account.accountId);
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
    return undefined;
  }
  return accountId;
}

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return cfg.channels?.["feishu"] as Record<string, unknown> | undefined;
}

// Three-component architecture: feishu-her-specific config lives under
// plugins.entries.feishu-her.config (not channels.feishu) because openclaw-lark
// owns the channel schema and strips unknown keys.
function getPluginConfig(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const plugins = (cfg as Record<string, unknown>).plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const herEntry = entries?.["feishu-her"] as Record<string, unknown> | undefined;
  return herEntry?.config as Record<string, unknown> | undefined;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const section = getChannelSection(cfg);
  const accounts = section?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts as Record<string, unknown>).filter(Boolean);
}

export function listFeishuAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultFeishuAccountId(cfg: OpenClawConfig): string {
  const section = getChannelSection(cfg);
  const defaultAccount = (section?.defaultAccount as string)?.trim();
  if (defaultAccount) {
    return defaultAccount;
  }
  const ids = listFeishuAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function mergeAccountConfig(cfg: OpenClawConfig, accountId: string): FeishuAccountConfig {
  const section = getChannelSection(cfg) ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = section;
  const accounts = section.accounts as Record<string, FeishuAccountConfig> | undefined;
  const account = accounts?.[accountId] ?? {};
  return { ...base, ...account } as FeishuAccountConfig;
}

export function resolveFeishuAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const accountId = normalizeAccountId(params.accountId);
  const section = getChannelSection(params.cfg);
  const baseEnabled = (section?.enabled as boolean | undefined) !== false;
  const merged = mergeAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  // Resolve credentials: config first, then env
  let appId = (merged.appId as string)?.trim() ?? "";
  let appSecret = (merged.appSecret as string)?.trim() ?? "";
  let source: FeishuCredentialSource = "none";

  if (appId && appSecret) {
    source = "config";
  } else if (accountId === DEFAULT_ACCOUNT_ID) {
    const envId = process.env[ENV_APP_ID]?.trim() ?? "";
    const envSecret = process.env[ENV_APP_SECRET]?.trim() ?? "";
    if (envId && envSecret) {
      appId = envId;
      appSecret = envSecret;
      source = "env";
    }
  }

  // Merge feishu-her plugin config (botOpenId etc. live here now,
  // because openclaw-lark strips unknown keys from channels.feishu)
  const pluginCfg = getPluginConfig(params.cfg) ?? {};

  const name = trimIfString(merged.name) || trimIfString(pluginCfg.name) || undefined;
  const knownBots = normalizeKnownBots(merged.knownBots);
  const knownBotOpenIds = normalizeKnownBotOpenIds(merged.knownBotOpenIds);
  const botOpenId = trimIfString(merged.botOpenId) || trimIfString(pluginCfg.botOpenId) || undefined;
  const label = resolveFeishuAccountLabel({ accountId, name });
  if (appId && label) {
    knownBots[appId] = label;
  }
  if (appId && botOpenId) {
    knownBotOpenIds[botOpenId] = appId;
  }

  return {
    accountId,
    name,
    knownBots,
    knownBotOpenIds,
    botOpenId,
    enabled,
    appId,
    appSecret,
    credentialSource: source,
    config: merged,
  };
}

export function listEnabledFeishuAccounts(cfg: OpenClawConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
