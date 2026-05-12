---
name: carher-engine-migrate
description: Use when the owner asks to migrate or sync OpenClaw memory, persona, user profile, skills, or setup into Hermes after a CarHer OpenClaw/Hermes hot switch. Handles phrases like "sync openclaw memory to hermes", "migrate OpenClaw memory to Hermes", "one-click memory migration", or "sync SOUL/USER/MEMORY.md into Hermes".
---

# CarHer Engine Migration

Use this skill only for owner-directed OpenClaw -> Hermes migration.

The official Hermes path is `hermes claw migrate`: first run a dry-run preview,
then execute only after the owner confirms. The safe default is `--preset
user-data`, which does not migrate API keys or secrets.

## Hard Rules

1. Do not execute an apply from a group chat. Tell the owner to run it in DM.
2. Do not execute an apply unless the current active engine is OpenClaw.
3. Do not execute an apply for anyone except the owner. If sender identity is
   unavailable, stop after `plan`.
4. Never migrate secrets unless the owner explicitly asks for secrets and you
   explain that `--migrate-secrets` is required. The default is no secrets.
5. Always do `plan` before `apply`.
6. Apply requires the owner to clearly confirm, for example:
   `confirm OpenClaw to Hermes memory migration`.

## Commands

From this skill directory:

```bash
bash scripts/openclaw-to-hermes-migrate.sh status
bash scripts/openclaw-to-hermes-migrate.sh plan
bash scripts/openclaw-to-hermes-migrate.sh apply --confirm
bash scripts/openclaw-to-hermes-migrate.sh apply --confirm --overwrite
bash scripts/openclaw-to-hermes-migrate.sh verify
```

## Workflow

1. Run `status` and summarize before-state:
   - active engine
   - source OpenClaw files found
   - destination Hermes files found
   - SHA/size for SOUL, USER, MEMORY
2. Run `plan`.
3. Summarize what Hermes says it will migrate, conflicts, and skipped items.
4. Ask for explicit confirmation. Do not proceed from vague agreement.
5. If the plan has any conflicts, say plainly: normal `apply --confirm` can
   refuse to write because Hermes protects existing targets. Do not describe
   this as "maybe" or "probably". Use `apply --confirm --overwrite` only after
   the owner explicitly confirms overwriting existing Hermes migration targets.
6. On confirmation, run `apply --confirm` or the explicit overwrite form.
7. Run `verify`.
8. Report before vs after:
   - `SOUL.md` source and destination SHA match or differ
   - `USER.md` and `MEMORY.md` migrated into Hermes memory files
   - key phrases present or absent
   - backup/report paths from Hermes output

## Expected Destinations

Hermes usually writes:

- `SOUL.md` into Hermes home.
- `MEMORY.md` into Hermes memories.
- `USER.md` into Hermes memories.
- OpenClaw skills into Hermes imported skills.

If a destination differs, trust `hermes claw migrate --dry-run` and the apply
report over this summary.
