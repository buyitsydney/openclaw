---
name: carher-engine-migrate
description: Cursor-side CarHer runbook for one-click OpenClaw -> Hermes memory/persona/skill migration, shared-skill publishing, server verification, and repeatable online tests.
---

# CarHer Engine Migration

Use this skill when implementing, publishing, or testing the
`carher-engine-migrate` shared skill.

## Source Of Truth

- Artifact skill: `artifacts/carher-engine-migrate-skill/carher-engine-migrate/`
- Local shared skill: `~/.openclaw/skills/carher-engine-migrate/`
- Server shared skill mount: `/data/.openclaw/skills/carher-engine-migrate/`
- Publish script: `./scripts/publish-shared-skills.sh`
- Server credentials: `docker/servers.txt`

Do not edit the server-mounted copy by hand. Change the artifact skill, sync it
to the local shared-skill directory, publish it with the shared-skill script,
then verify inside the target container.

## Publish Flow

From the repo root:

```bash
rsync -a artifacts/carher-engine-migrate-skill/carher-engine-migrate/ ~/.openclaw/skills/carher-engine-migrate/
./scripts/publish-shared-skills.sh diff-one carher-engine-migrate
./scripts/publish-shared-skills.sh push-one carher-engine-migrate
```

`push-one` uses `sshpass` plus `rsync --delete` for only this skill against
every server in `docker/servers.txt`. It does not require rebuilding images or
restarting containers. The user or bot must run `/new` before relying on the
refreshed skill instructions.

If a single-host verification is needed, derive credentials from
`docker/servers.txt` instead of hardcoding:

```bash
S1_PW=$(awk '/^10\.68\.13\.186[[:space:]]/ {print $3; exit}' docker/servers.txt)
sshpass -p "$S1_PW" ssh -o StrictHostKeyChecking=no cltx@10.68.13.186 'docker ps --format "{{.Names}}" | grep hermestest-200'
```

## Container Verification

For S1/hermestest-200:

```bash
docker exec hermestest-200 sh -lc 'ln -sfn /data/.openclaw/skills/carher-engine-migrate /tmp/carher-engine-migrate && cd /tmp/carher-engine-migrate && bash -n scripts/carher-migrate.sh scripts/openclaw-to-hermes-migrate.sh && node --test scripts/openclaw-to-hermes-migrate.test.mjs'
docker exec hermestest-200 sh -lc 'cd /tmp/carher-engine-migrate && node --test scripts/carher-migrate-ui.test.mjs'
docker exec hermestest-200 sh -lc 'cd /tmp/carher-engine-migrate && bash scripts/carher-migrate.sh status && bash scripts/carher-migrate.sh review'
```

The publish is not accepted until the container-mounted copy passes the script
syntax check and the node test suite.

## Runtime Commands

Run from the skill directory inside the bot/container:

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

Use `scripts/carher-migrate.sh` for plan/apply. The legacy
`scripts/openclaw-to-hermes-migrate.sh` entry refuses plan/apply because Hermes
can mistake command names containing `openclaw` for a live OpenClaw process.

## Product Contract

- `plan` may run while OpenClaw is active.
- `apply` must run only when the runtime is in Hermes mode and no OpenClaw
  process is running.
- Always run `plan` before `apply`.
- Apply needs explicit owner confirmation.
- Default preset does not migrate secrets.
- Existing Hermes targets are protected. If a second/third migration reports
  conflicts, normal `apply --confirm` must refuse; only use
  `apply --confirm --overwrite` after explicit overwrite approval.
- After every apply, run `verify` and `review`.

## Repeatable Test Reset

For owner-approved tests:

- `reset-hermes-memory --confirm` backs up and clears Hermes memory files.
- `reset-migration-targets --confirm` backs up and clears memory files,
  `skills/openclaw-imports`, and `migration/openclaw`.
- Always capture `reset_backup_dir=...`, then run `status`, `plan`, `apply`,
  `verify`, and `review`.

## UI Contract

Conversation-triggered migration uses one Feishu card:

- Warm gold while running.
- Green on success.
- Red on failure/refusal.
- Same card edited through frames: 0% scan, 20% snapshot, 40% plan, 60% apply,
  80% verify/review, 100% complete.
- Final success text lists exact migrated files, imported skills, archived cron
  jobs, skipped items, conflicts, and secret-exclusion status.
- If cron jobs were archived, ask whether to enable `cron 1`, `cron 1,3`, or
  `cron all`; do not enable them automatically.

The implemented runner is `node scripts/carher-migrate-ui.mjs run --chat-id
<current_chat_id> --confirm`. It sends one interactive card with
`config.update_multi=true` and updates the same `message_id` via Feishu
`PATCH /im/v1/messages/:message_id`.

## User-Facing Review Rules

Report what `review` proves:

- `SOUL.md` source/destination SHA match or mismatch.
- `USER.md` and `MEMORY.md` destination existence, sizes, and key phrase checks.
- Imported OpenClaw skills under `openclaw-imports`.
- Missing shared skills, if any.
- Archived cron jobs and the fact that they are not enabled yet.
- Secrets were skipped unless the owner explicitly requested secret migration.
