// Private helper surface for the bundled feishu plugin.
// Keep this list additive and scoped to symbols used under extensions/feishu.

export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export { logTypingFailure } from "../channels/logging.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { createActionGate, jsonResult, readStringParam } from "../agents/tools/common.js";
export { stringEnum, optionalStringEnum } from "../agents/schema/typebox.js";
// setup-wizard-helpers.js does not exist in v2026.3.12 — skipped
export { applyAccountNameToChannelSection } from "../channels/plugins/setup-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelLogSink,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
} from "../channels/plugins/types.js";
// ChannelConfiguredBinding* types don't exist in v2026.3.12 — skipped
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixContext } from "../channels/reply-prefix.js";
// channel-reply-pipeline.js does not exist in v2026.3.12 — skipped
export type { OpenClawConfig as ClawdbotConfig, OpenClawConfig } from "../config/config.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { DmPolicy, GroupToolPolicyConfig } from "../config/types.js";
// secret-input.js does not exist in v2026.3.12 — skipped
export { createDedupeCache } from "../infra/dedupe.js";
export { installRequestBodyLimitGuard, readJsonBodyWithLimit } from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeAgentId,
} from "../routing/session-key.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
// web-media.js moved to src/web/media.js in v2026.3.12
export { loadWebMedia } from "../web/media.js";
export { extractReasoningDirective, type ReasoningLevel } from "../auto-reply/reply/directives.js";
export { normalizeReasoningLevel } from "../auto-reply/thinking.js";
export { readSessionStoreJson5 } from "../infra/state-migrations.fs.js";
export { extractPdfContent } from "../media/pdf-extract.js";
export { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
export type { RuntimeEnv } from "../runtime.js";
export { formatDocsLink } from "../terminal/links.js";
export { evaluateSenderGroupAccessForPolicy } from "./group-access.js";
export type { WizardPrompter } from "../wizard/prompts.js";
// setup-api.js does not exist in v2026.3.12 — skipped
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export { readJsonFileWithFallback } from "./json-store.js";
// channel-pairing.js does not exist in v2026.3.12 — skipped
export { createPersistentDedupe } from "./persistent-dedupe.js";
export {
  buildBaseChannelStatusSummary,
  buildProbeChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export { withTempDownloadPath } from "./temp-path.js";
// extensions/feishu/api.js does not exist in v2026.3.12 — skipped
// webhook-ingress.js does not exist in v2026.3.12 — use old paths
export {
  createWebhookAnomalyTracker,
  createFixedWindowRateLimiter,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "./webhook-memory-guards.js";
export { applyBasicWebhookRequestGuards } from "./webhook-request-guards.js";
