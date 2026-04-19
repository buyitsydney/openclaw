# CarHer Upgrade Log: v2026.4.14

**Date:** 2026-04-14
**Branch:** `upgrade-0414` (based on `feat/skills-two-layer`)
**Upstream tag:** `v2026.4.14`

---

## Merge Summary

- **Method:** `git merge v2026.4.14 --no-commit` then manual conflict resolution
- **Merge commit:** `b58705aa45` — `upgrade: merge OpenClaw v2026.4.14 into CarHer`
- **Post-merge fix commit:** `b81c788321` — `fix: update feishu-her + realtime imports for plugin-sdk API changes`

---

## Conflict Resolution (10 files)

### 1. `.oxlintrc.json` — Accept upstream

- **Decision:** `git checkout --theirs`
- **Reason:** Lint config, no CarHer customization needed.

### 2. `docs/providers/ollama.md` — Accept upstream

- **Decision:** `git checkout --theirs`
- **Reason:** Documentation, no CarHer-specific content.

### 3. `extensions/acpx/package.json` — Manual merge

- **Decision:** Merged both sides. Kept CarHer's `dependencies` (`acpx: 0.5.3`) and added upstream's `devDependencies` (`@openclaw/plugin-sdk: workspace:*`).

### 4. `pnpm-lock.yaml` — Regenerated

- **Decision:** Deleted conflicted lockfile, regenerated via `pnpm install`.

### 5. `src/agents/live-model-filter.ts` — Accept upstream

- **Decision:** `git checkout --theirs`
- **Reason:** Upstream completely rewrote this file with a new `HIGH_SIGNAL_LIVE_MODEL_PRIORITY` system. CarHer's old static prefix lists are superseded. No CarHer-specific model filtering needed in core.

### 6. `src/agents/models-config.providers.static.ts` — Accept upstream

- **Decision:** `git checkout --theirs`
- **Reason:** Upstream moved all provider definitions to individual extension packages (extensions/minimax, extensions/moonshot, etc.) using a bundled plugin metadata discovery system. CarHer's hardcoded Chinese providers (minimax, doubao, byteplus, xiaomi, kimi, qwen, etc.) were in core but are now superseded by the plugin architecture. These providers should be configured via plugin config, not hardcoded in core.

### 7. `src/config/sessions/group.ts` — Accept upstream

- **Decision:** `git checkout --theirs`
- **Reason:** Upstream added plugin-based group session resolution (`resolveLegacyGroupSessionKey` via channel plugins, `resolveImplicitGroupSurface`). CarHer's simpler version used direct `resolveGroupSessionKeyFromRaw` without plugin delegation. The upstream version is more extensible and feishu-her can participate via the channel plugin interface.

### 8-10. Three `modify/delete` e2e test files — Accept upstream

- `src/agents/subagent-announce.format.e2e.test.ts`
- `src/cli/program.nodes-media.e2e.test.ts`
- `src/plugins/wired-hooks-after-tool-call.e2e.test.ts`
- **Decision:** `git add` (accept upstream's modified version, CarHer had deleted these)
- **Reason:** E2E tests, no CarHer customization.

---

## Post-Merge Fixes

### Plugin SDK Import Refactoring

Upstream refactored `src/plugin-sdk/feishu.ts` — several exports were moved to new SDK subpaths:

| Function                           | Old Location                 | New Location                                |
| ---------------------------------- | ---------------------------- | ------------------------------------------- |
| `applyAccountNameToChannelSection` | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-plugin-common` |
| `deleteAccountFromConfigSection`   | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-plugin-common` |
| `formatPairingApproveHint`         | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-plugin-common` |
| `setAccountEnabledInConfigSection` | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-plugin-common` |
| `buildChannelConfigSchema`         | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-plugin-common` |
| `createActionGate`                 | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-actions`       |
| `jsonResult`                       | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-actions`       |
| `readStringParam`                  | `openclaw/plugin-sdk/feishu` | `openclaw/plugin-sdk/channel-actions`       |
| `normalizeAgentId`                 | `openclaw/plugin-sdk`        | `openclaw/plugin-sdk/feishu`                |

**Files updated:**

- `extensions/feishu-her/src/channel.ts` — Updated all imports to new SDK subpaths
- `extensions/realtime/index.ts` — Changed `normalizeAgentId` import from `openclaw/plugin-sdk` to `openclaw/plugin-sdk/feishu`; fixed unused variable lint error (`fileWatcher` → `_fileWatcher`)

---

## Verification

- `pnpm install` — PASS
- `pnpm build` — PASS (clean, no warnings or errors)
- Pre-commit hooks — PASS (lint, format, conflict markers, import cycles all clean)

## BUILD: PASS

---

## Circular Import Fix

**Problem:** madge detected a circular dependency in feishu-her:

```
feishu-message.ts → outbound.ts → message-metadata.ts → feishu-message.ts
```

Root cause: `message-metadata.ts` imported `FeishuReplyRef` (type-only) from `feishu-message.ts`, which value-imports from `outbound.ts`, which value-imports from `message-metadata.ts`.

**Fix:** Extracted shared type definitions (`FeishuReplyRef`, `FeishuActorRef`, `FeishuTextPayload`, `FeishuAttachmentRef`, and supporting types) into `extensions/feishu-her/src/feishu-types.ts`:

- `feishu-message.ts` — re-exports types from `feishu-types.ts` (no breaking change for other importers)
- `message-metadata.ts` — imports `FeishuReplyRef` from `feishu-types.ts` instead of `feishu-message.ts`

**Result:** `check-madge-import-cycles.ts` reports 0 cycles.

---

## Known Risks / Follow-up Items

1. **CarHer Chinese providers** (minimax, doubao, byteplus, xiaomi, kimi, qwen, etc.) — these were previously hardcoded in `src/agents/models-config.providers.static.ts`. Upstream moved all providers to plugin packages. Verify these providers still work via the plugin config system, or add them as CarHer-specific plugin config.

2. **Group session resolution** — upstream changed to plugin-based approach. Verify feishu-her group mode still works correctly via the channel plugin interface.

3. **feishu-her type compatibility** — while build passes, runtime behavior should be smoke-tested (飞书消息收发, docx 处理, group mode, discussion mode).

4. **Docker build** — `Dockerfile.carher` should be tested separately.
