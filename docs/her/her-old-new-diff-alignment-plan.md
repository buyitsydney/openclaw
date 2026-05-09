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

| Surface | Old architecture expectation | New architecture risk | Test |
| --- | --- | --- | --- |
| Mention activation | `feishu-her` knew all local bot mentions and activated the addressed bot | `openclaw-lark` may strip or mis-handle bot mentions | group-new-head, group-new-tail, group-new-multi |
| Slash commands | `/new` and `/status` are system commands and never enter LLM | command text can include bot mentions before/after command | command logs + user-visible ack |
| History injection | group context has readable sender/content for recent messages | passive WS or raw API can lose cards/senders/reply chain | history-card, known-bots, reply-chain |
| Interactive cards | Her replies use nice card formatting where expected | mixed reply paths emit ugly text/post | card-output |
| Bot registry | app senders resolve to Her names | bare `cli_xxx` causes attribution mistakes | known-bots |
| A2A | authorized Her can find peers across fleet | stale server/local routing or missing registry data | a2a-route |
| lark-cli tools/skills | tools/skills available through lark-cli skill layer | new channel-only openclaw-lark removed old plugin surfaces | tool smoke by domain |

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
