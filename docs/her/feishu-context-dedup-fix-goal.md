# Feishu Context Dedup Fix Goal

Date: 2026-05-11

## Goal

Fix Feishu context injection so Her keeps the useful group history behavior without
polluting long-lived sessions or prompts.

The target behavior is:

- DM never injects Feishu history by default.
- Group chat injects Feishu history only as current-turn transient context.
- Persisted sessions never store `[Recent group history ...]` inside user text.
- Prompt assembly never replays old injected history blocks from previous turns.
- Runtime hot-switch is allowed to lose DM continuity. That is acceptable and
  preferable to repeated DM preamble pollution.
- Pure Hermes must not expose or execute `/openclaw` or `/hermes` engine-switch
  commands. Engine-switch commands are runtime-only.

## Test Targets

Use these online bots for real E2E validation:

| Bot | Container        | Product line   | Purpose                   |
| --- | ---------------- | -------------- | ------------------------- |
| 198 | `carher-198`     | pure OpenClaw  | OpenClaw control          |
| 199 | `hermestest-199` | pure Hermes    | Hermes fix target         |
| 200 | `hermestest-200` | carher-runtime | Runtime hot-switch target |

Use 12 and 13 only for read-only forensics unless explicitly requested:

| Bot | Container       | Product line        | Purpose                    |
| --- | --------------- | ------------------- | -------------------------- |
| 12  | `carher-12`     | pure OpenClaw fleet | extra OpenClaw evidence    |
| 13  | `hermestest-13` | legacy dual         | extra dual/Hermes evidence |

## Bug Definitions

### Session Pollution

A persisted session is polluted if any old user message stores a Feishu history
preamble, for example:

```text
[Recent group history (last 49 messages, oldest first; cards/posts decoded)]
```

Hermes currently persists this text into `state.db.messages.content`.

OpenClaw stores structured `openclaw.runtime-context` entries in jsonl. This is
not the same as Hermes inline preamble pollution, but old runtime-context blocks
must not be replayed into future model prompts.

### Prompt Pollution

A model prompt is polluted if previous turns contribute old injected history
blocks to the current request.

Allowed prompt shape:

```text
system
normal long-lived user/assistant session history, with old injected blocks stripped
current transient group history, exactly one block for group chat only
current user message
```

Forbidden prompt shape:

```text
old user message with [Recent group history ...]
old user message with [Recent group history ...]
current user message with [Recent group history ...]
```

For DM, even the current transient group history block is forbidden.

## Current Confirmed Failures To Reproduce

### F1: Pure Hermes Group Session Pollution

Target: `hermestest-199`.

Observed current behavior:

- Group sessions contain multiple user messages.
- Each user message can contain `[Recent group history ...]`.
- `agent.log` shows `history=N` increasing across turns.

Failing assertion before fix:

- Send two or more group prompts to 199.
- Query `/opt/data/state.db`.
- Assert at least one persisted user message contains `[Recent group history`.
- Assert prompt history includes old user messages that still contain the preamble.

Expected after fix:

- Persisted user messages contain zero `[Recent group history`.
- Prompt history contains zero old `[Recent group history`.
- Current group turn may receive exactly one transient history block.

### F2: Pure Hermes DM Injection

Target: `hermestest-199`.

Observed current behavior:

- DM logs show `Inbound dm message received`.
- The text begins with `[Recent group history ...]`.

Failing assertion before fix:

- Send two DM prompts to 199.
- Query `/opt/data/state.db` and logs.
- Assert DM user messages contain `[Recent group history`.

Expected after fix:

- DM user messages contain zero `[Recent group history`.
- DM logs do not show `history via lark-cli` for normal text DM.
- DM prompt uses native session history only.

### F3: Runtime Hermes Group/DM Pollution

Target: `hermestest-200` in Hermes mode.

Observed current behavior:

- Group and DM both receive `[Recent group history ...]`.
- Group session `20260511_112415_1c3e39a2` showed multiple persisted user
  messages with preamble.
- DM session `20260511_115730_78e4e961` showed persisted DM user messages with
  preamble.

Failing assertion before fix:

- Switch 200 to Hermes.
- Run group and DM prompts.
- Assert persisted user messages contain `[Recent group history`.

Expected after fix:

- Hermes group persisted user messages contain zero preamble.
- Hermes DM persisted user messages contain zero preamble.
- Group current turn can still use one transient group-history block.
- DM current turn uses no injected Feishu history.

### F4: Runtime OpenClaw DM History-Fill

Target: `hermestest-200` in OpenClaw mode.

Observed current behavior:

- Runtime OpenClaw DM can include `Chat history since last reply`.
- This came from dual-mode `CARHER_DUAL_ENGINE_HISTORY_FILL=1`.

Failing assertion before fix:

- Switch 200 to OpenClaw.
- Send two DM prompts.
- Inspect `/data/.openclaw/agents/main/sessions/*.trajectory.jsonl`.
- Assert DM prompt snapshots contain `Chat history since last reply`.

Expected after fix:

- Normal OpenClaw DM has zero Feishu history-fill.
- Runtime hot-switch may lose DM continuity; that is accepted.

### F5: OpenClaw Group Runtime-Context Replay

Targets: `carher-198`, `hermestest-200` in OpenClaw mode.

Observed current behavior:

- OpenClaw group prompts can accumulate multiple `openclaw.runtime-context`
  blocks across turns.

Failing assertion before fix:

- Send repeated group prompts.
- Inspect latest `messagesSnapshot`.
- Assert more than one old `openclaw.runtime-context` block is visible.

Expected after fix:

- Latest prompt contains at most one current inbound `openclaw.runtime-context`.
- Old runtime-context blocks are not replayed into model input.

### F6: Pure Hermes Engine-Switch Leak

Target: `hermestest-199`.

Observed current behavior:

- 199 is pure Hermes but accepted `/openclaw`, wrote `active=openclaw`, and then
  still executed Hermes.

Failing assertion before fix:

- Send `/openclaw` to 199.
- Assert the marker changes or an engine-swap log appears.

Expected after fix:

- Pure Hermes ignores or rejects `/openclaw` and `/hermes` as runtime-only.
- `/data/.engine/active` is not written by pure Hermes.
- No `[engine-swap] marker written` appears in 199 logs.

## Required Implementation Direction

### Hermes

Implement all three protections:

1. Disable Feishu history preamble for DM.
2. Strip `[Recent group history ...]` on persist before writing user messages to
   `state.db`.
3. Strip old `[Recent group history ...]` on read before previous user messages
   are assembled into prompt history.

Current group prompt may still receive one transient preamble, but that preamble
must not be stored or replayed later.

### OpenClaw

Filter model input so only the current inbound `openclaw.runtime-context` can be
included. Older runtime-context messages from previous turns must be skipped
when assembling the model request.

### Runtime

Remove normal DM history-fill from runtime. Do not export a global setting that
makes every DM turn pull Feishu history.

Engine switch may break DM continuity. This is accepted.

### Engine-Swap

Gate `/openclaw` and `/hermes` behind a runtime-only environment flag. Pure
Hermes must not enable the switch plugin/patch.

## TDD Workflow

Follow this exact order:

1. Baseline: collect current failing evidence from 198/199/200.
2. Add deterministic tests/scripts that fail on current code:
   - Hermes strip-on-read/write unit or integration tests.
   - Hermes DM no-preamble test.
   - Runtime switch-command gating test.
   - OpenClaw runtime-context prompt filtering test.
3. Run new tests and confirm they fail before any production fix.
4. Fix code.
5. Run all relevant local tests and new tests until green.
6. Build and deploy only after tests are green.
7. Run real Feishu E2E on 198/199/200.
8. Ask bots to self-check context after fix.
9. Independently inspect storage and prompt logs after bot self-check.

## Real Feishu E2E Matrix

Use unique marker:

```text
HER_CONTEXT_DEDUP_<yyyymmddHHMMSS>_<case>
```

### 198 Pure OpenClaw

- DM normal conversation: no Feishu history-fill.
- Group repeated prompts: only current runtime-context visible in prompt.
- `/new`, `/status`, multi-bot mention matrix still work.

### 199 Pure Hermes

- DM repeated prompts: no `[Recent group history ...]` in storage or prompt.
- Group repeated prompts: exactly one current transient history block; no old
  preamble in storage or prompt history.
- `/openclaw` and `/hermes`: runtime-only rejection/no-op, no marker write.

### 200 Runtime

OpenClaw mode:

- DM repeated prompts: no Feishu history-fill.
- Group repeated prompts: only current runtime-context visible.

Hermes mode:

- DM repeated prompts: no Feishu history preamble.
- Group repeated prompts: one transient group-history block only.

Hot-switch:

- `/hermes` and `/openclaw` still work.
- DM continuity loss after switch is acceptable.
- Group continuity after switch should still be preserved by current group
  transient history.

## Success Criteria

The fix is not complete until all criteria are true:

- `hermestest-199` DM storage: zero `[Recent group history`.
- `hermestest-199` group storage: zero `[Recent group history`.
- `hermestest-200` Hermes DM storage: zero `[Recent group history`.
- `hermestest-200` Hermes group storage: zero `[Recent group history`.
- OpenClaw prompt snapshots contain at most one current runtime-context.
- Normal DM on OpenClaw and Hermes has no Feishu history-fill.
- 199 cannot write `/data/.engine/active` through `/openclaw` or `/hermes`.
- Bot self-check reports match independent log/storage inspection.
- Existing Feishu features still pass: `/new`, `/status`, multi-bot mention,
  knownBots, card rendering, KQA, A2A, and model switch where applicable.

## Non-Goals

- Do not preserve DM continuity across hot-switch at the cost of history
  injection.
- Do not silently summarize or delete real group messages from the current
  transient group history.
- Do not change 12/13/14/75 during this fix unless explicitly requested.
- Do not deploy before failing tests prove the bugs and green tests prove the
  fix.
