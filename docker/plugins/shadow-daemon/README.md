# shadow-daemon

CarHer plugin: mirrors workspace PDF / Word / Excel / PowerPoint files into
markdown so `memory_search` can recall their contents semantically.

## Layout

| Path | Purpose |
|---|---|
| `openclaw.plugin.json` | Plugin manifest (id, configSchema, skills list) |
| `package.json` | Npm package metadata; declares OpenClaw extension entry |
| `index.ts` | TypeScript plugin entry; registers a background `OpenClawPluginService` that spawns the Python daemon |
| `daemon/shadow_daemon.py` | 200-line Python daemon (inotify-less reconcile + markitdown extraction) |
| `skills/shadow-daemon/SKILL.md` | Agent-facing skill: tells Her how to use `memory_search` over mirrored docs |
| `tests/e2e_exhaustive.py` | 33-scenario end-to-end harness |
| `tests/scenario_test*.py` | Focused reconcile/failure isolation harnesses |

## Runtime

1. Gateway starts → plugin discovery scans `docker/plugins/*` → reads
   `openclaw.plugin.json` → loads `index.ts` via the OpenClaw plugin loader.
2. `register(api)` is called. If `plugins.entries.shadow-daemon.enabled` is
   true (default) the plugin registers a background service.
3. When the Gateway `start`s the service, we `spawn('python3', [daemon.py])`
   with env vars derived from the plugin config (`SHADOW_*`).
4. Daemon runs a reconcile loop: scan workspace (+ `extraPaths`) → for every
   supported source file write / refresh `memory/_shadow/<hash>__<stem>.md`.
5. On Gateway shutdown the service `stop`s, we `SIGTERM` the Python process
   (fallback `SIGKILL` after 5s).

## System dependency

The daemon uses `markitdown` (PyPI). **The plugin bootstraps it itself** on
service start — `index.ts` runs `python3 -m pip install --user markitdown`
(idempotent, exits fast when already present) before spawning the daemon. No
base-image change required, which keeps the plugin honestly decoupled from the
image layer.

## Config (JSON Schema reference)

```json5
{
  plugins: {
    entries: {
      "shadow-daemon": {
        enabled: true,
        config: {
          shadowDir: "memory/_shadow",
          extraPaths: [],
          intervalSec: 300,
          maxFileMB: 50,
          extractTimeoutSec: 180,
          scanBudgetSec: 240,
          subprocMemoryMB: 1024,
          pythonBin: "python3",
        },
      },
    },
  },
}
```

## Install (the real 1000-Her path)

A/B-decoupled architecture: we do **not** bake the plugin into the base image.
Each Her container installs it at runtime via the CLI:

```bash
# From a tarball (easiest for now):
openclaw plugins install ./shadow-daemon.tgz --pin

# Or from a local path:
openclaw plugins install ./docker/plugins/shadow-daemon

# Or, once published, from ClawHub / npm:
openclaw plugins install clawhub:shadow-daemon --pin
```

The install persists under `/data/.openclaw/` (plugin home + `plugins.installs`
entry), survives container restarts, and is independent of OpenClaw upstream
image upgrades.

## Local verification

```bash
cd docker/plugins/shadow-daemon
python3 -m json.tool openclaw.plugin.json >/dev/null && echo "manifest ok"
python3 daemon/shadow_daemon.py --once   # one reconcile pass, exits
```

## Status

- Source Python + tests were battle-tested in workspace-side deployment
  (33/33 scenarios + 100 PDF load + 5/5 semantic recall).
- Plugin packaging is **new** in this branch and needs the full shadow
  container end-to-end run before it is trusted in production.
