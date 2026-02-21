---
name: openclaw-gateway
description: OpenClaw gateway startup conventions and scripts. Use when the user mentions start.sh, gateway startup, restart-mac.sh, or asks about launching the OpenClaw gateway.
---

# OpenClaw Gateway Startup

## Scripts

| Script                        | Purpose                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `start.sh` (repo root)        | **Primary dev launcher.** Rebuild + start gateway + Live Frontend Proxy. Use this.        |
| `scripts/restart-mac.sh`      | macOS App full rebuild (kill, swift build, package, relaunch). Different from `start.sh`. |
| `start-mobile.sh` (repo root) | Mobile dev launcher.                                                                      |

## start.sh Details

`start.sh` does the following in order:

1. **`pnpm build` + `pnpm ui:build` (deterministic rebuild from src/)**
2. Kill old gateway/openclaw processes
3. Check and free ports 18789, 18790, 8000, 8080
4. Start gateway: `pnpm openclaw gateway run --port 18789 --force &`
5. Start Live Frontend Proxy: `python3 extensions/realtime/live-frontend/server.py &`
6. Auto-open browser pages (webchat + live frontend)

## ABSOLUTE FACT: Code is Always Latest After start.sh / start-user.sh

**NEVER question whether the running code is up to date after these scripts run:**

- **`start.sh`** — always runs `pnpm build` before launching gateway. After `start.sh`, the gateway is guaranteed to run the latest `src/` code. Period.
- **`start-user.sh`** — always rebuilds the Docker image if `src/` files are dirty (via `git diff`). After `start-user.sh`, Docker containers are guaranteed to run the latest `src/` code. Period.

Do NOT:

- Suggest "the gateway might not have the latest code" after a restart via start.sh
- Suggest "Docker might not have the fix" after a rebuild via start-user.sh
- Run redundant `pnpm build` to "make sure" — the scripts already handle this
- Waste time verifying dist/ contents when the user just restarted via these scripts

## Critical: No --verbose

The gateway command must **not** use `--verbose`. Reason:

- `--verbose` enables full WebSocket logging (`logWsCompact` / `logWsFull`), which floods the terminal with heartbeat/ping-pong messages from Webchat connections.
- Without `--verbose`, WS logs use `logWsOptimized` path: only failures and slow requests (>50ms) are printed.
- **All business logs** (channel events, heartbeat triggers, cron execution, agent replies) are printed in both modes. Nothing is lost.

## Gateway Log Style Options

| Flag                      | WS Log Behavior                                               |
| ------------------------- | ------------------------------------------------------------- |
| (none)                    | `logWsOptimized`: silent except errors/slow (recommended)     |
| `--verbose`               | `logWsCompact` (auto): every req/res pair on one line (noisy) |
| `--verbose --ws-log full` | `logWsFull`: every req and res on separate lines (very noisy) |
| `--compact`               | Alias for `--ws-log compact` (only with --verbose)            |

## Log Files

Full structured logs (JSON, one line per entry) are written to:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

- Rolling by date, auto-prunes files older than 24h.
- Contains **all** log events regardless of `--verbose` flag. Terminal output is a subset; the file is the complete record.
- To view realtime: `tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log`
- To search: `rg feishu /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log`

When investigating issues, **always check the log file first**, not terminal output.

## Ports

| Port  | Service                     |
| ----- | --------------------------- |
| 18789 | Gateway (HTTP + WebSocket)  |
| 18790 | Realtime plugin (WebSocket) |
| 8000  | Live Frontend UI (HTTP)     |
| 8080  | Live Frontend WS proxy      |
