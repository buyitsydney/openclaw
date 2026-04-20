import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./src/accounts.js";
import { feishuPlugin } from "./src/channel.js";
import {
  buildReportFromSessionFile,
  saveReport,
  type BuildReportOpts,
} from "./src/compaction-report.js";
import { syncGroupArchivesToMemory } from "./src/memory-bridge.js";
import { initOAuthCallback, startOAuthServer } from "./src/oauth.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerAllFeishuTools } from "./src/tools/index.js";

let initialArchiveSyncScheduled = false;

function extractConfigOpts(config: Record<string, unknown> | undefined): BuildReportOpts {
  if (!config) return {};
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const compaction = defaults?.compaction as Record<string, unknown> | undefined;
  return {
    contextWindow: undefined,
    reserveTokens: compaction?.reserveTokens as number | undefined,
    reserveTokensFloor: compaction?.reserveTokensFloor as number | undefined,
    keepRecentTokens: compaction?.keepRecentTokens as number | undefined,
    maxHistoryShare: compaction?.maxHistoryShare as number | undefined,
    contextTokens: defaults?.contextTokens as number | undefined,
    compactionMode: compaction?.mode as string | undefined,
  };
}

const plugin = {
  id: "feishu-her",
  name: "Feishu Her",
  description: "Feishu (Lark) channel plugin with ecosystem tools (local Her variant)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    registerAllFeishuTools(api);

    // OAuth callback for user_access_token (minutes/calendar/drive)
    const accounts = listEnabledFeishuAccounts(api.config);
    if (accounts.length > 0) {
      const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
      const logOAuth = (msg: string) => api.logger.info?.(`feishu-oauth: ${msg}`);
      const warnOAuth = (msg: string) => api.logger.warn(`feishu-oauth: ${msg}`);
      initOAuthCallback({
        resolveAccount: (id) => accountMap.get(id) ?? accounts[0],
        log: logOAuth,
        warn: warnOAuth,
      });
      const feishuConfig = (api.config.channels?.["feishu"] ?? {}) as Record<string, unknown>;
      const minutesConfig = (feishuConfig.minutes ?? {}) as Record<string, unknown>;
      const oauthPort = (minutesConfig.oauthPort as number) ?? undefined;
      startOAuthServer({ port: oauthPort, log: logOAuth, warn: warnOAuth });
    }

    // Background sync: write group archives to memory dir for semantic indexing
    if (!initialArchiveSyncScheduled) {
      initialArchiveSyncScheduled = true;
      setTimeout(() => {
        try {
          const result = syncGroupArchivesToMemory();
          if (result.synced > 0) {
            api.logger.info?.(`memory-bridge: synced ${result.synced} group archives to memory`);
          }
        } catch (e) {
          api.logger.info?.(`memory-bridge: initial archive sync failed: ${String(e)}`);
        }
      }, 5_000);
    }

    api.on("after_compaction", (event, ctx) => {
      const sessionFile = event.sessionFile;
      if (!sessionFile) return;
      try {
        const opts = extractConfigOpts(api.config as Record<string, unknown> | undefined);
        const report = buildReportFromSessionFile(sessionFile, opts);
        if (report) {
          const filePath = saveReport(report);
          api.logger.info(`Compaction report saved: ${filePath}`);
        }
      } catch (err) {
        api.logger.error(`Failed to generate compaction report: ${String(err)}`);
      }
    });
  },
};

export default plugin;
