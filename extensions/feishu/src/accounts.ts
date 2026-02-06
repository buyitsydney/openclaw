import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

export type FeishuCredentialSource = "config" | "env" | "none";

/** Per-account config stored under channels.feishu.accounts.<id> or channels.feishu.* */
export type FeishuAccountConfig = {
  name?: string;
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  dm?: {
    policy?: string;
    allowFrom?: string[];
  };
  [key: string]: unknown;
};

export type ResolvedFeishuAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  credentialSource: FeishuCredentialSource;
  config: FeishuAccountConfig;
};

const ENV_APP_ID = "FEISHU_APP_ID";
const ENV_APP_SECRET = "FEISHU_APP_SECRET";

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return cfg.channels?.["feishu"] as Record<string, unknown> | undefined;
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

  return {
    accountId,
    name: merged.name?.trim() || undefined,
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
