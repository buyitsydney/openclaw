// openclaw/plugin-sdk/feishu — ESM compat shim
//
// The bundled feishu plugin is disabled (openclaw-lark replaces it as channel
// provider), but feishu-her still imports runtime values and types from this
// path. The npm-published openclaw package excludes this file, so we provide
// a thin re-export layer from standard SDK subpaths that DO ship.
//
// Runtime values:
//   emptyPluginConfigSchema, DEFAULT_ACCOUNT_ID → core.js
//   fetchWithSsrFGuard                         → ssrf-runtime.js
//
// Type-only imports (OpenClawPluginApi, OpenClawConfig, ChannelLogSink, etc.)
// are erased by the TypeScript compiler and do not need runtime resolution.

export { emptyPluginConfigSchema, DEFAULT_ACCOUNT_ID } from "./core.js";
export { fetchWithSsrFGuard } from "./ssrf-runtime.js";
