#!/bin/bash
# Apply runtime patches to /app/dist for upstream bugs carher hits.
#
# 对应 PR #76666 (upstream open):
#   "fix(memory, builtin backend): eagerly preload session transcript listeners at gateway startup"
#
# upstream 2026.5.3 状态:
#   patch4 (memory-core archiveMarker passthrough)          ✅ MERGED
#       upstream 通过新文件 session-transcript-hit-Qpigd-Nx.js 原生 support
#       .jsonl.reset.<iso> / .jsonl.deleted.<iso> 归档(L19/L27-31),本地 patch 已不需要
#   patch7a (shouldStartGatewayMemoryBackend 扩展)           ❌ NOT MERGED
#       upstream 重命名为 resolveGatewayMemoryStartupPolicy,仍是 qmd-only gate
#   patch7b (server-startup-memory loop gate 扩展)           ❌ NOT MERGED
#       upstream 内 loop 仍然 if (resolved.backend !== "qmd" || !resolved.qmd) continue
#
# 本 script 保留 2 个 patch (合为 P7 组):
#   P7-outer: resolveGatewayMemoryStartupPolicy 让 builtin + memorySearch.sources=[sessions] 也 arm
#   P7-inner: startGatewayMemoryBackend loop 让 builtin + sessions agent 也过 gate
#
# 策略:
#   - Idempotent: 已 patched (marker 存在) → skip
#   - 找不到 anchor → SKIP + log (upstream merge 后自动失效,安全降级)
#   - 任何 patch replace 后 verify 失败 → exit 非 0 (保护 image 不进 broken state)
set -euo pipefail

DIST=/app/dist

echo "Applying PR #76666 patches (builtin backend session transcript preload) — idempotent..."

# ============================================================
# Patch P7-outer: resolveGatewayMemoryStartupPolicy (server.impl-*.js)
# ============================================================
python3 - <<'PY'
import glob, pathlib
files = sorted(glob.glob("/app/dist/server.impl-*.js"))
if not files:
    print("p7_outer: SKIP (server.impl-*.js not found)")
    exit(0)
p = pathlib.Path(files[0])
s = p.read_text()
if "carher_P7_outer" in s:
    print(f"p7_outer {p.name}: already patched, skip")
    exit(0)
anchor = 'function resolveGatewayMemoryStartupPolicy(cfg) {\n\tif (cfg.memory?.backend !== "qmd") return { mode: "off" };'
if anchor not in s:
    if "resolveGatewayMemoryStartupPolicy" not in s:
        print(f"p7_outer {p.name}: SKIP (function removed — upstream may have merged)")
    else:
        print(f"p7_outer {p.name}: SKIP (anchor changed — upstream refactor, needs review)")
    exit(0)
replacement = (
    'function resolveGatewayMemoryStartupPolicy(cfg) {\n'
    '\t// carher_P7_outer (PR #76666): also arm when any agent has memorySearch.sources=["sessions"]\n'
    '\tconst _needSessionsPreload = (() => {\n'
    '\t\tconst defs = cfg.agents?.defaults?.memorySearch?.sources;\n'
    '\t\tif (Array.isArray(defs) && defs.includes("sessions")) return true;\n'
    '\t\tconst entries = cfg.agents?.entries ?? {};\n'
    '\t\tfor (const id in entries) {\n'
    '\t\t\tconst src = entries[id]?.memorySearch?.sources;\n'
    '\t\t\tif (Array.isArray(src) && src.includes("sessions")) return true;\n'
    '\t\t}\n'
    '\t\treturn false;\n'
    '\t})();\n'
    '\tif (cfg.memory?.backend !== "qmd") {\n'
    '\t\tif (_needSessionsPreload) return { mode: "immediate" };\n'
    '\t\treturn { mode: "off" };\n'
    '\t}'
)
s2 = s.replace(anchor, replacement, 1)
if "carher_P7_outer" not in s2:
    raise SystemExit("p7_outer: verify failed (marker not in patched text)")
p.write_text(s2)
print(f"p7_outer {p.name}: OK")
PY

# ============================================================
# Patch P7-inner: startGatewayMemoryBackend loop (server-startup-memory-*.js)
# ============================================================
python3 - <<'PY'
import glob, pathlib
files = sorted(glob.glob("/app/dist/server-startup-memory-*.js"))
if not files:
    print("p7_inner: SKIP (server-startup-memory-*.js not found)")
    exit(0)
p = pathlib.Path(files[0])
s = p.read_text()
if "carher_P7_inner" in s:
    print(f"p7_inner {p.name}: already patched, skip")
    exit(0)
anchor = 'if (!resolved) continue;\n\t\tif (resolved.backend !== "qmd" || !resolved.qmd) continue;\n\t\tif (!shouldRunQmdStartupBootSync(resolved.qmd)) continue;'
if anchor not in s:
    print(f"p7_inner {p.name}: SKIP (anchor changed — upstream refactor, needs review)")
    exit(0)
replacement = (
    'if (!resolved) continue;\n'
    '\t\t// carher_P7_inner (PR #76666): let builtin backend also preload session transcript listener\n'
    '\t\t// when agent has memorySearch.sources=["sessions"] — qmd still goes through its own\n'
    '\t\t// boot-sync path below; builtin skips qmd-specific checks, goes straight to manager\n'
    '\t\t// init so ensureSessionListener() attaches before any /reset or /new archive emit.\n'
    '\t\tconst _carherSettings = resolveMemorySearchConfig(params.cfg, agentId);\n'
    '\t\tconst _carherWantSessions = Array.isArray(_carherSettings?.sources) && _carherSettings.sources.includes("sessions");\n'
    '\t\tconst _isBuiltinSessionsPreload = resolved.backend !== "qmd" && _carherWantSessions;\n'
    '\t\tif ((resolved.backend !== "qmd" || !resolved.qmd) && !_isBuiltinSessionsPreload) continue;\n'
    '\t\tif (!_isBuiltinSessionsPreload && !shouldRunQmdStartupBootSync(resolved.qmd)) continue;'
)
s2 = s.replace(anchor, replacement, 1)
if "carher_P7_inner" not in s2:
    raise SystemExit("p7_inner: verify failed (marker not in patched text)")
p.write_text(s2)
print(f"p7_inner {p.name}: OK")
PY

echo 'PR #76666 patches applied (2026.5.3-compatible, idempotent)'

# NOTE: dist-manifest MUST be frozen AFTER this script (see Dockerfile).
# Freeze happens in Dockerfile so both patch + shim mutations are captured.
