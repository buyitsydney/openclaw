import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { feishuPlugin } from "./src/channel.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { registerAllFeishuTools } from "./src/tools/index.js";

const plugin = {
  id: "feishu-her",
  name: "Feishu Her",
  description: "Feishu (Lark) channel plugin with ecosystem tools (local Her variant)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    // Register feishu ecosystem tools (doc, wiki, drive, bitable).
    registerAllFeishuTools(api);
  },
};

export default plugin;
