# Changelog

## 0.1.0 — Initial plugin packaging

Ported the previously workspace-side shadow daemon (systemd + venv) into the
CarHer A/B-decoupled plugin architecture, alongside `feishu-her` and
`a2a-gateway`.

- `openclaw.plugin.json` with explicit `skills: ["./skills/shadow-daemon"]`
  so Her can discover the skill automatically
- `index.ts` uses `api.registerService` to manage the Python daemon lifecycle
  with automatic restart backoff
- `daemon/shadow_daemon.py` copied verbatim from the verified workspace
  implementation (33/33 scenarios + 100 PDF load pass)
- Agent-facing `skills/shadow-daemon/SKILL.md` explains when Her should
  prefer `memory_search` over manual PDF parsing
