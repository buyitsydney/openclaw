#!/usr/bin/env python3
"""Extra v3.1 cases for failure isolation + retry semantics.

Run after scenario_test.py — uses a fresh tempdir.
"""
from __future__ import annotations
import hashlib, json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
DAEMON = ROOT / "shadow_daemon.py"
PY = "/data/.openclaw/workspace/shadow-venv/bin/python"

def sha8(s): return hashlib.sha256(s.encode()).hexdigest()[:8]
def shadow_for(workspace, src):
    return workspace / "memory" / "_shadow" / f"{sha8(str(src.resolve()))}__{src.stem[:60]}.md"

def run_once(workspace, log_path=None):
    env = os.environ.copy()
    env["SHADOW_WORKSPACE"] = str(workspace)
    proc = subprocess.run([PY, str(DAEMON), "--once"], env=env,
                          capture_output=True, timeout=180)
    if log_path: log_path.write_bytes(proc.stderr)
    return proc

results = []
def assert_(cond, name, detail=""):
    mark = "✅ PASS" if cond else "❌ FAIL"
    results.append((name, mark, detail))
    print(f"  {mark}  {name}  {detail}")

def main():
    ws = Path(tempfile.mkdtemp(prefix="shadow-v31-"))
    print(f"\n=== v3.1 extra workspace: {ws} ===\n")
    research = ws / "research"; research.mkdir(parents=True, exist_ok=True)

    # ---- Case A: 故意坏 PDF (0 字节) ----
    print("[Case A] 0-byte broken PDF → placeholder + don't infinite retry")
    bad = research / "broken.pdf"; bad.write_bytes(b"")
    log_a1 = Path("/tmp/shadow-v31-a1.log")
    run_once(ws, log_a1)
    sh = shadow_for(ws, bad)
    body = sh.read_text() if sh.exists() else ""
    assert_(sh.exists(), "A1 placeholder shadow created")
    assert_("status: failed" in body or "status: crashed" in body or "status: timeout" in body or "extract" in body,
            "A1 placeholder marks failure status")
    # save first mtime
    first_mtime = sh.stat().st_mtime
    log_a2 = Path("/tmp/shadow-v31-a2.log")
    run_once(ws, log_a2)
    assert_(sh.stat().st_mtime == first_mtime, "A2 same broken file → not re-converted (mtime stable)")

    # ---- Case B: 大文件 60MB → 跳过 ----
    print("\n[Case B] 60MB PDF → MAX_FILE_BYTES skip, no shadow")
    big = research / "huge.pdf"
    big.write_bytes(b"%PDF-1.4\n" + (b"X" * (60 * 1024 * 1024)))
    log_b = Path("/tmp/shadow-v31-b.log")
    run_once(ws, log_b)
    sh_big = shadow_for(ws, big)
    assert_(not sh_big.exists(), "B big PDF skipped (no shadow created)")
    log_text = log_b.read_text(errors="replace")
    assert_("skip_size" in log_text, "B skip_size event logged",
            f"log_lines={len([l for l in log_text.splitlines() if 'skip_size' in l])}")

    # ---- Case C: mtime 更新 → 失败 shadow 重试 ----
    print("\n[Case C] touch broken PDF → next cycle retries (mtime advances)")
    time.sleep(1.1)
    # rewrite slightly different broken content + bump mtime
    bad.write_bytes(b"%PDF-1.4 still broken")
    os.utime(bad, None)
    pre_mtime = sh.stat().st_mtime
    pre_body = sh.read_text()
    log_c = Path("/tmp/shadow-v31-c.log")
    run_once(ws, log_c)
    post_mtime = sh.stat().st_mtime
    post_body = sh.read_text()
    assert_(post_mtime > pre_mtime or post_body != pre_body, "C mtime advance → retry happened")

    # ---- Case D: health.json 含 mem_available_mb ----
    print("\n[Case D] _health.json reports mem_available_mb")
    health_path = ws / "memory" / "_shadow" / "_health.json"
    health = json.loads(health_path.read_text())
    print(f"  health: {health}")
    assert_("mem_available_mb_start" in health, "D mem_available_mb_start present")
    assert_("mem_available_mb_end" in health, "D mem_available_mb_end present")
    assert_(isinstance(health.get("mem_available_mb_start"), (int, float)) and health["mem_available_mb_start"] > 0,
            "D mem value sane", f"={health.get('mem_available_mb_start')}")

    # ---- Summary ----
    passed = sum(1 for _,s,_ in results if "PASS" in s)
    print(f"\n{'='*60}\nv3.1 EXTRA: {passed}/{len(results)} PASS\n{'='*60}")
    for name, st, detail in results: print(f"  {st}  {name}")
    print(f"\n(workspace kept: {ws})")
    if passed != len(results): sys.exit(1)

if __name__ == "__main__": main()
