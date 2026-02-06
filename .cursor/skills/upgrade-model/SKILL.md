---
name: upgrade-model
description: Upgrade the LLM model used by OpenClaw. Use when the user asks to change, upgrade, or switch the AI model, or mentions a new model version like opus 4.6, gpt-5, gemini-3, etc.
---

# Upgrade OpenClaw LLM Model

## Why It's Not Just a String Change

OpenClaw has a **model registry** (`@mariozechner/pi-ai` → `models.generated.js`) that maps model IDs to metadata (api protocol, contextWindow, cost, etc). If the model isn't in the registry, you get `Unknown model` error.

## Upgrade Path

1. **Check if upstream `@mariozechner/pi-ai` latest version already has the model** — inspect `models.generated.js` in the latest npm tarball.

2. **If yes** → upgrade all four `@mariozechner/pi-*` packages (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) to the same version. They must stay in sync.

3. **If no** → add a temporary inline model definition in `openclaw.json` under `models.providers`. Copy metadata from the closest known model, update `id`/`contextWindow` from OpenRouter API. Remove this hack once upstream catches up.

4. **Set the model** in `openclaw.json` → `agents.defaults.model.primary`.

5. **Verify** — gateway log should show the new model name without `Unknown model` errors. Config changes hot-reload; dependency upgrades need `start.sh` restart.
