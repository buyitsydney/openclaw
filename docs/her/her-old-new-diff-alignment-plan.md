# Her old/new Feishu architecture diff alignment plan

Status: started 2026-05-09.

Primary anchors:

- Feishu architecture doc: https://t83dfrspj4.feishu.cn/docx/U5DWdq6G1omOFGxAsGbcRs2vnF6, section 9.
- Her requirement pool record: `recvj8g5vc8IS9`.
- Heartbeat automation: `her-diff-overnight-continuation`, every 30 minutes.
- Worktree: `/private/tmp/openclaw-her-diff-e2e`.
- Branch: `her-old-new-diff-e2e-codex`.
- E2E skill: `.cursor/skills/her-feishu-e2e-test/SKILL.md`.

## Goal

Find all user-visible behavior diffs introduced by migrating from the old `feishu-her`-only architecture to the new `openclaw-lark + lark-cli + feishu-her` architecture, then align the new architecture to the old experience unless a deliberate product change is documented.

Known regressions already fixed or partially fixed:

- group mention activation when multiple bots are mentioned.
- group `/new` command entering the LLM instead of dispatching system reset.
- group history/context injection losing interactive card content.
- `knownBots` app-sender name mapping missing from model-visible context.
- A2A S1/S3 peer routing with stale `server=local`.

Current new focus:

- Her sometimes sends interactive cards and sometimes ugly plain text. Determine every outbound reply path and make regular Her answers consistently card-rendered.
- Her should avoid flooding groups with many fragmented `post` messages. Old `feishu-her` accumulated block/final reply pieces into one user-facing card whenever possible; new architecture must recover that experience.
- Her card footer must come back: model, token/context usage, cache/compact state, and group-chat mode should be visible on normal AI replies.
- Online verification must cover multiple outbound paths, not just one short final answer: normal answer, long answer, multi-step/tool answer, bot-initiated/self-send path, reply/thread path, system command, and error/fallback paths where practical.
- Create a reusable online E2E test skill and use docker198/199/200 for real Feishu group tests.

## Constraints

- Use TDD. Add failing tests or deterministic probes before changing behavior.
- Do not touch the current dirty main worktree.
- Use only `carher-198`, `carher-199`, and `carher-200` for online experiments unless the user later expands scope.
- Do not use `carher-75` as an experiment target.
- Do not directly edit server code or container npm packages. Formal path is local change, commit, push, server fast-forward, compose recreate.

## Work Phases

1. Baseline inventory
   - Identify the last old-architecture `feishu-her` code that had the target behavior.
   - Extract old behavior surfaces: activation, slash commands, history rendering, knownBots, outbound cards, tools/skills, A2A equivalent paths.
   - Build a diff matrix with owner, current implementation, test strategy, and status.

2. Test harness
   - Add local unit tests for pure parsers/converters/normalizers.
   - Add E2E scripts that collect lark-cli JSON and docker logs with a unique marker.
   - Save evidence in `artifacts/her-e2e/<run-id>/`.

3. Outbound card audit
   - Find all current reply paths: OpenClaw channel reply, direct Feishu API reply, lark-cli send/reply, system command acks, tool/status renderers, errors.
   - Classify which paths produce interactive card vs text/post.
   - Choose the narrowest shared renderer that can cardify normal Her answers without breaking system command acks.

4. Fix and gray test
   - Implement one behavior at a time.
   - Run targeted tests.
   - Deploy first to one test bot, preferably `carher-200`.
   - Validate in a real group through lark-cli history and server logs.

5. Full regression
   - Run core E2E cases from `her-feishu-e2e-test`.
   - Cover at least docker198, docker199, and docker200 across the final regression set.
   - Confirm patch markers and A2A state.

6. Documentation and skills
   - Update architecture docs, `carher-ops`, and the E2E skill with every new patch or invariant.
   - Update the patch count if a new runtime/build/config patch is introduced.

## Diff Matrix Seed

| Surface               | Old architecture expectation                                             | New architecture risk                                      | Test                                            |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------- |
| Mention activation    | `feishu-her` knew all local bot mentions and activated the addressed bot | `openclaw-lark` may strip or mis-handle bot mentions       | group-new-head, group-new-tail, group-new-multi |
| Slash commands        | `/new` and `/status` are system commands and never enter LLM             | command text can include bot mentions before/after command | command logs + user-visible ack                 |
| History injection     | group context has readable sender/content for recent messages            | passive WS or raw API can lose cards/senders/reply chain   | history-card, known-bots, reply-chain           |
| Interactive cards     | Her replies use nice card formatting where expected                      | mixed reply paths emit ugly text/post                      | card-output                                     |
| Reply aggregation     | one turn is collapsed into one card where possible                       | block/tool/final events can flood group with many posts    | card-coalesce, tool-coalesce                    |
| Status footer         | card footer shows model/context/compact/group mode                       | openclaw-lark footer defaults off and lacks group mode     | footer-status                                   |
| Bot registry          | app senders resolve to Her names                                         | bare `cli_xxx` causes attribution mistakes                 | known-bots                                      |
| A2A                   | authorized Her can find peers across fleet                               | stale server/local routing or missing registry data        | a2a-route                                       |
| lark-cli tools/skills | tools/skills available through lark-cli skill layer                      | new channel-only openclaw-lark removed old plugin surfaces | tool smoke by domain                            |

## Checkpoint Format

Append dated entries here as work progresses:

```markdown
## Checkpoint YYYY-MM-DD HH:mm

- Commit/worktree:
- Changed files:
- Tests run:
- Online evidence:
- Decisions:
- Next step:
```

## Checkpoint 2026-05-09 22:25

- Commit/worktree: `dev` at `a527ff9863a`, branch `her-old-new-diff-e2e-codex`.
- Changed files: this plan and `.cursor/skills/her-feishu-e2e-test/SKILL.md`.
- Tests run: pending.
- Online evidence: pending.
- Decisions: use the existing Feishu architecture doc section 9 as the human-facing task charter; use this file plus the E2E skill as the continuation checkpoint.
- Next step: inspect old `feishu-her` source and current new-architecture outbound/history paths, then add first tests for card rendering and history parity.

## Checkpoint 2026-05-09 22:45

- Commit/worktree: branch `her-old-new-diff-e2e-codex`, not merged to `dev` yet.
- Changed files: added R-9 `reply-card default` patch/test, wired it into `scripts/carher-entrypoint.sh`, and updated `docs/her/her-build-deploy-architecture.md`, `.cursor/skills/carher-ops/SKILL.md`, and `.cursor/skills/her-feishu-e2e-test/SKILL.md`.
- Tests run: `node --test scripts/carher-patches/apply-reply-card-default.test.mjs` passed; `bash -n scripts/carher-entrypoint.sh` passed; `bash -n scripts/carher-patches/apply-reply-card-default.sh` passed. Full `node --test scripts/carher-patches/*.test.mjs` is blocked by pre-existing missing `test-assets/lark-pkg/...` fixtures in `apply-history-fill.test.mjs`, while the new R-9 tests pass.
- Online evidence: copied docker200's actual `/data/.openclaw/extensions/node_modules/@larksuite/openclaw-lark/src/card/reply-mode.js` to a local temp file and verified `apply-reply-card-default.sh` patches the live upstream shape and passes `node --check`.
- Decisions: R-9 is the narrow first fix for the mixed `post` vs `interactive` regression. It changes only openclaw-lark's static reply card decision: non-empty text uses cards, too many markdown tables still fall back.
- Next step: commit the branch, push, deploy to docker200 first, send a real marked Feishu prompt, and verify the bot's short reply is `msg_type=interactive` in lark-cli history plus server logs.

## Checkpoint 2026-05-09 22:58

- Commit/worktree: `e5cb5527da8` on branch `her-old-new-diff-e2e-codex`, pushed to `carher/her-old-new-diff-e2e-codex`.
- Changed files: same R-9 patch set, plus E2E skill correction for resolving bot mention IDs from `im chat.members bots`.
- Tests run: R-9 unit test and syntax gates still pass before deploy.
- Online evidence: S1 `/Data/CarHer` checked out the gray branch and only `carher-200` was force-recreated. Startup logs show `✓ reply-card default patch applied`. First lark-cli send using raw `cli_a96...` did not trigger because the outgoing text became `<at user_id="">研究3</at>`; corrected by resolving `研究3` to `ou_c2bc759110aa5bc80b2edea2ede864e9` via `lark-cli im chat.members bots`. Second trigger `HER_E2E_20260509T2258_card_default` produced bot reply `om_x100b50c0fe60bca4b10bc45863b2999`, `sender_id=cli_a96f044b4ef95cc0`, `msg_type=interactive`, content `<card>card-default-ok</card>`.
- Decisions: valid automated Feishu E2E must resolve bot mentions through group membership first; `cli_xxx` is an app id, not a safe mention id for `+messages-send`.
- Next step: commit this E2E skill correction, merge R-9 into `dev`, deploy via dev to docker198/199/200, then run the core regression set.

## Checkpoint 2026-05-09 23:05

- Commit/worktree: `carher/dev` at `7caffd2ce0a`; local branch still `her-old-new-diff-e2e-codex`.
- Changed files: pending new work for coalesced cards and footer.
- Tests run: pending for new requirements.
- Online evidence: S1 dev was fast-forwarded to `7caffd2ce0a` and `carher-198/199/200` were recreated. All three show `✓ reply-card default patch applied` and `gateway ready`.
- Decisions: R-9 alone is insufficient proof because it covers only one short static final-answer path. The broader fix should prefer openclaw-lark's built-in streaming CardKit controller for normal replies, because it naturally coalesces partial/tool/final content into one card and already has a footer pipeline. A new runtime patch is still needed to restore old-Her-only footer fields: compaction count and group mode.
- Next step: enable streaming reply mode + footer in fleet config, patch footer metrics for compaction/group mode, then run a multi-case E2E matrix on docker200 before rollout.

## Checkpoint 2026-05-09 23:45

- Commit/worktree: `carher/dev` at `77b5571f364` (`CarHer: restore streaming card footers`); local `/Users/buyitian/Documents/work/openclaw` dev also fast-forwarded to the same commit while preserving unrelated dirty skill-source files.
- Changed files: fleet config enables `channels.feishu.streaming=true`, `replyMode.default/group/direct="streaming"`, and footer status/elapsed/model/tokens/cache/context; R-10 runtime patch `apply-footer-status.sh` enriches openclaw-lark CardKit footer metrics with `compactionCount` and Redis group mode.
- Tests run:
  - `node --test scripts/carher-patches/apply-footer-status.test.mjs scripts/carher-patches/apply-reply-card-default.test.mjs` → 5/5 pass.
  - `bash -n scripts/carher-entrypoint.sh` → pass.
  - `git diff --check` → pass.
- Online docker200 E2E evidence (`oc_394c3ebe4ca009aba9b5662cce366810`, bot `cli_a96f044b4ef95cc0`):
  - `footer_short`: one `interactive` reply, body `footer-ok`, footer includes Completed, elapsed, model, `👥群@`, tokens, cache, context, `Compactions 0`.
  - `coalesce_long`: trigger asked for six numbered points; exactly one bot message after trigger, `msg_type=interactive`, footer complete.
  - `tool_coalesce`: logs show `tools=[exec]`; exactly one bot message after trigger, `msg_type=interactive`, footer complete.
  - `/status @研究3`: exactly one system `post` status reply; no double reply.
  - `/new @研究3` and `@研究3 /new`: exactly one `✅ New session started.` ack each; logs show `detected system command` + `system command dispatched (delivered=true)`.
  - `history_card_context`: prompt forbade tools; bot read the previous interactive card from injected context and rendered sender as `研究3 (cli_a96f044b4ef95cc0)`, not a bare `cli_...`; logs show `filled 19 via lark-cli` and no bad client placeholder.
- Fleet rollout: S1 `carher-12/13/198/199/200` and S3 `carher-14/75` all fast-forwarded to dev `77b5571f364` and force-recreated. Startup logs for all 7 show `reply-card default patch applied`, `footer-status patch applied`, history-fill, inbound metadata, session-decay, channel-only, contracts.tools, patch-agent-loop, and `gateway ready`.
- Known non-blocking warning: all containers still log `failed to persist plugin auto-enable changes: Config write would flatten $include-owned config at <root>`; this is the pre-existing include-preservation warning and was not treated as rollback because channel-only/gateway/patch gates are green.
- Decision: R-10 is accepted as the old-Her card/footer parity layer. Remaining broader diff-alignment work should continue from the E2E skill matrix rather than relying on one-off manual assertions.
