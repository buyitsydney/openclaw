import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { feishuPlugin } from "./src/channel.js";
import {
  buildReportFromSessionFile,
  saveReport,
  type BuildReportOpts,
} from "./src/compaction-report.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerAllFeishuTools } from "./src/tools/index.js";

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
