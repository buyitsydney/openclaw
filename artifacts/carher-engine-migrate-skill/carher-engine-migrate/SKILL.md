---
name: carher-engine-migrate
description: Use when the owner asks to migrate or sync OpenClaw memory, persona, user profile, skills, or setup into Hermes after a CarHer OpenClaw/Hermes hot switch. Handles Chinese phrases like "迁移记忆", "迁移我的记忆", "同步记忆", "导入记忆", "同意迁移", "同意覆盖迁移", plus English phrases like "migrate OpenClaw memory to Hermes" or "sync SOUL/USER/MEMORY.md into Hermes".
---

# CarHer Engine Migration

Use this skill only for owner-directed OpenClaw -> Hermes migration.

The official Hermes path is `hermes claw migrate`: first run a dry-run preview,
then execute only after the owner confirms. The safe default is `--preset
user-data`, which does not migrate API keys or secrets.

## Product Interaction

The runtime does not intercept natural-language migration requests. If the
owner says "迁移记忆", "迁移我的记忆", "同步记忆", "导入记忆", "同意迁移", or
"同意覆盖迁移", you must use this skill and drive the migration yourself.

Speak to the owner like a product, not like an implementation log:

- Do not mention this skill name unless the owner asks how it works.
- Do not explain cron/secrets/skill internals in the ready card or ordinary
  reply. Put those details only in the migration result card when relevant.
- Keep the user-facing prompt short. The preferred copy is:
  `需要迁移 OpenClaw 记忆？回复「迁移记忆」。`
- Use the one-card UI runner for apply so the owner sees start, progress,
  success, or refusal in a single Feishu card.

Treat an owner DM saying `迁移记忆` or `同意迁移` as explicit confirmation for
the normal safe apply path. Treat `同意覆盖迁移` as explicit confirmation for
`--overwrite`.

## Hard Rules

1. Do not execute an apply from a group chat. Tell the owner to run it in DM.
2. `plan` may run while OpenClaw is active, but `apply` must run only after
   switching to Hermes, so the OpenClaw process is stopped. If OpenClaw is
   active or still running, stop after `plan` and tell the owner to switch with
   `/hermes`, wait for the ready card, then rerun `apply`.
3. Do not execute an apply for anyone except the owner. If sender identity is
   unavailable, stop after `plan`.
4. Never migrate secrets unless the owner explicitly asks for secrets and you
   explain that `--migrate-secrets` is required. The default is no secrets.
5. Always do `plan` before `apply`.
6. Apply requires the owner to clearly confirm. In the post-switch migration
   flow, `迁移记忆`, `同意迁移`, or `confirm OpenClaw to Hermes memory migration`
   are clear confirmations for the safe apply path.
7. If apply output says no files were modified, preview only, or run without
   `--dry-run` and does not also say `Migration complete!`, treat it as
   failed. Hermes normally prints a preview before a real apply; do not
   misclassify a completed apply as failed.
8. After every apply, run `review`. The user-visible report must separate
   verified migrated data from follow-up choices. Never say cron jobs are
   running unless `hermes cron list` shows them.

## Commands

From this skill directory:

```bash
bash scripts/carher-migrate.sh status
bash scripts/carher-migrate.sh plan
bash scripts/carher-migrate.sh apply --confirm
bash scripts/carher-migrate.sh apply --confirm --overwrite
bash scripts/carher-migrate.sh reset-hermes-memory --confirm
bash scripts/carher-migrate.sh reset-migration-targets --confirm
bash scripts/carher-migrate.sh verify
bash scripts/carher-migrate.sh review
node scripts/carher-migrate-ui.mjs run --chat-id <oc_xxx> --confirm
node scripts/carher-migrate-ui.mjs run --chat-id <oc_xxx> --confirm --overwrite
```

Use `scripts/carher-migrate.sh`, not the legacy
`scripts/openclaw-to-hermes-migrate.sh` name, for `plan` and `apply`. Hermes'
process detector is broad enough to mistake command names or parent shell
arguments containing `openclaw` for a live OpenClaw process. The neutral entry
also passes Hermes `/tmp/carher-claw-source` instead of `/data/.openclaw` for
the same reason.

## Publish And Server Verification

The canonical shared-skill publish path is repo-local, not ad hoc container
editing:

```bash
rsync -a artifacts/carher-engine-migrate-skill/carher-engine-migrate/ ~/.openclaw/skills/carher-engine-migrate/
./scripts/publish-shared-skills.sh diff-one carher-engine-migrate
./scripts/publish-shared-skills.sh push-one carher-engine-migrate
```

`./scripts/publish-shared-skills.sh` reads `docker/servers.txt`, uses
`sshpass`, and syncs the selected skill to every CarHer server
`~/.openclaw/skills/<skill>/` with `rsync --delete`. Use `push-one` for
single-skill releases so unrelated server skills are not touched. No image
rebuild or container restart is required for shared skills; ask the bot to
`/new` before testing the newly published skill behavior.

For S1/hermestest-200 verification after publish:

```bash
docker exec hermestest-200 sh -lc 'ln -sfn /data/.openclaw/skills/carher-engine-migrate /tmp/carher-engine-migrate && cd /tmp/carher-engine-migrate && bash -n scripts/carher-migrate.sh scripts/openclaw-to-hermes-migrate.sh && node --test scripts/openclaw-to-hermes-migrate.test.mjs'
docker exec hermestest-200 sh -lc 'cd /tmp/carher-engine-migrate && node --test scripts/carher-migrate-ui.test.mjs'
docker exec hermestest-200 sh -lc 'cd /tmp/carher-engine-migrate && bash scripts/carher-migrate.sh status && bash scripts/carher-migrate.sh review'
```

If a direct server check is needed, use the fleet server file as the source of
truth for credentials. Example shape, with the password read from
`docker/servers.txt`:

```bash
S1_PW=$(awk '/^10\.68\.13\.186[[:space:]]/ {print $3; exit}' docker/servers.txt)
sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 'docker ps --format "{{.Names}}" | grep hermestest-200'
```

Do not claim the skill is online until the published copy in
`/data/.openclaw/skills/carher-engine-migrate/` passes the unit test inside the
target container.

## Workflow

1. Run `status` and summarize before-state:
   - active engine
   - source OpenClaw files found
   - destination Hermes files found
   - SHA/size for SOUL, USER, MEMORY
2. Run `plan`. If it warns that OpenClaw is running, this is acceptable for
   preview only.
3. Summarize what Hermes says it will migrate, conflicts, and skipped items.
4. Ask for explicit confirmation unless the current owner DM itself is already
   `迁移记忆`, `同意迁移`, or an equivalent explicit request.
5. If the plan has any conflicts, say plainly: normal `apply --confirm` can
   refuse to write because Hermes protects existing targets. Do not describe
   this as "maybe" or "probably". Use `apply --confirm --overwrite` only after
   the owner explicitly confirms overwriting existing Hermes migration targets.
6. Before applying, ensure the runtime is in Hermes mode and `status` reports
   `openclaw_process_running=no`.
7. On confirmation, run `apply --confirm` or the explicit overwrite form.
   If the script exits non-zero, report it as failed and include the refusal
   reason. Never summarize a forced dry-run as a successful migration.
8. Run `verify`.
9. Run `review`.
10. Report before vs after:
   - `SOUL.md` source and destination SHA match or differ
   - `USER.md` and `MEMORY.md` migrated into Hermes memory files
   - key phrases present or absent
   - backup/report paths from Hermes output
   - skills imported into `openclaw-imports` versus source skills still missing
   - cron jobs archived for manual recreation

## Repeatable Test Reset

For owner-approved testing only, `reset-hermes-memory --confirm` backs up and
clears only Hermes target memory files so the same memory migration can be
rerun:

- `$HERMES_HOME/SOUL.md`
- `$HERMES_HOME/USER.md`
- `$HERMES_HOME/MEMORY.md`
- `$HERMES_HOME/memories/USER.md`
- `$HERMES_HOME/memories/MEMORY.md`

For a true clean migration rehearsal, use
`reset-migration-targets --confirm`. It backs up and moves all OpenClaw
migration targets:

- the memory files above
- `$HERMES_HOME/skills/openclaw-imports`
- `$HERMES_HOME/migration/openclaw`

Always run `status` before and after reset, then run `plan`, `apply`, `verify`,
and `review`. The reset command prints `reset_backup_dir=...`; preserve that
path in the report.

## Post-Migration User Choices

`review` is the source of truth for what the bot should say next.

- Memory/persona files are complete only when `verify`/`review` show the
  destination files exist and key phrases are present.
- Skills copied to `$HERMES_HOME/skills/openclaw-imports` are file-level
  imports. Tell the owner to run `/new`, then verify the needed skill by name.
  If `review.skills.missing_shared_count` is non-zero, list the missing names.
- Cron jobs are not enabled by migration. The official report archives them in
  `archive/cron-store`. Tell the owner: `这些 cron 只归档了，没有启动。回复
  cron 1、cron 1,3 或 cron all，我再重建。` Do not recreate cron jobs unless
  the owner explicitly chooses.
- Secrets/API keys are not migrated under the default preset. State that plainly
  and only run secrets migration after explicit owner approval.

For second or third migrations:

- If `plan` reports conflicts, explain that existing Hermes targets are present.
- Without explicit overwrite approval, do not run `--overwrite`.
- If `apply --confirm` exits with conflict refusal, say it did not apply because
  Hermes already has migration targets. Ask whether to overwrite; do not call
  it a generic dry-run failure.
- With overwrite approval, use `apply --confirm --overwrite`, then `review`.
- The final card/report must say which items were migrated, which were skipped
  due to conflicts, and which require follow-up choices.

## User UI Contract

When this migration is initiated from a bot conversation, show one Feishu card
from start to finish:

- Warm gold while running.
- Green on success.
- Red on failure or refusal.
- Edit the same card for each progress frame; do not send a stack of status
  cards.
- Progress frames: 0% scan, 20% source/destination snapshot, 40% plan, 60%
  apply, 80% verify/review, 100% complete.
- Final success text must include the exact migrated files, imported skill
  count/names, archived cron count/names, skipped items, conflicts, and whether
  secrets were excluded.
- Final failure text must include the refusal reason and the exact next user
  choice, for example overwrite approval or switching to Hermes before apply.

Cron and skill follow-up choices are part of the completion card, not hidden in
logs. If cron archives exist, ask the owner whether to enable `cron 1`,
`cron 1,3`, or `cron all`; never enable archived cron jobs automatically.

Implementation command:

```bash
node scripts/carher-migrate-ui.mjs run --chat-id <current_chat_id> --confirm
```

Use `--overwrite` only after the owner explicitly approves overwriting existing
Hermes migration targets. The UI runner sends one card with lark-cli, then
updates the same `message_id` through status, plan, apply, verify/review, and
final summary frames.

## Expected Destinations

Hermes usually writes:

- `SOUL.md` into Hermes home.
- `MEMORY.md` into Hermes memories.
- `USER.md` into Hermes memories.
- OpenClaw skills into Hermes imported skills.

If a destination differs, trust `hermes claw migrate --dry-run` and the apply
report over this summary.
