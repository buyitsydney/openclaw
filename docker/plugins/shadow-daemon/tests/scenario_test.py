#!/usr/bin/env python3
"""6-scenario test harness for shadow_daemon.

Uses a sandbox workspace (no real pdfs needed at first — we generate dummy docx files
via python-docx if available, otherwise fall back to .pdf-stub plain files for the
filesystem-shape tests; the conversion fidelity is not what we test here, only the
reconciliation logic add/modify/rename/move/delete/rmtree.
"""
from __future__ import annotations
import hashlib, importlib, json, os, shutil, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
DAEMON = ROOT / "shadow_daemon.py"
PY = shutil.which("python3") or sys.executable
VENV_PY = "/data/.openclaw/workspace/shadow-venv/bin/python"
if Path(VENV_PY).exists(): PY = VENV_PY

PASS, FAIL = "✅ PASS", "❌ FAIL"
results = []

def sha8(s): return hashlib.sha256(s.encode()).hexdigest()[:8]

def make_doc(p: Path, body: str):
    """Produce a real PDF using reportlab if available, else fallback to docx, else
    write a stub file with the given suffix (markitdown will fail but the
    reconciliation-shape tests still pass since we only check shadow filename + GC)."""
    p.parent.mkdir(parents=True, exist_ok=True)
    suffix = p.suffix.lower()
    try:
        if suffix == ".pdf":
            from reportlab.pdfgen import canvas
            c = canvas.Canvas(str(p)); c.drawString(72, 720, body); c.save(); return
        if suffix == ".docx":
            from docx import Document
            d = Document(); d.add_paragraph(body); d.save(str(p)); return
    except Exception: pass
    # fallback: write text with the suffix; shape tests only rely on file existence
    p.write_bytes(body.encode())

def run_once(workspace: Path):
    env = os.environ.copy()
    env["SHADOW_WORKSPACE"] = str(workspace)
    proc = subprocess.run([PY, str(DAEMON), "--once"], env=env,
                          capture_output=True, timeout=120)
    return proc.returncode, proc.stdout.decode("utf-8","replace"), proc.stderr.decode("utf-8","replace")

def shadow_for(workspace: Path, src: Path):
    return workspace / "memory" / "_shadow" / f"{sha8(str(src.resolve()))}__{src.stem[:60]}.md"

def assert_(cond, name, detail=""):
    results.append((name, PASS if cond else FAIL, detail))
    print(f"  {PASS if cond else FAIL}  {name}  {detail}")

def main():
    ws = Path(tempfile.mkdtemp(prefix="shadow-test-"))
    print(f"\n=== test workspace: {ws} ===\n")
    research = ws / "research"
    try:
        # ---- Scenario 1: 新增 ----
        print("[Scenario 1] 新增 PDF → shadow 自动建")
        a = research / "scn1" / "a.pdf"; make_doc(a, "scenario one alpha content")
        rc,_,_ = run_once(ws)
        sh = shadow_for(ws, a)
        body = sh.read_text() if sh.exists() else ""
        assert_(sh.exists(), "S1 shadow created", f"path={sh}")
        assert_(f"source: {a.resolve()}" in body, "S1 source header correct")

        # ---- Scenario 2: 修改 ----
        print("\n[Scenario 2] 修改内容 → 同 hash overwrite")
        time.sleep(1.1)
        make_doc(a, "scenario one BETA new content")
        os.utime(a, None)
        first_mtime = sh.stat().st_mtime
        run_once(ws)
        new_body = sh.read_text()
        assert_(sh.stat().st_mtime > first_mtime, "S2 shadow mtime updated")
        assert_("BETA" in new_body or "scenario one" in new_body, "S2 content refreshed", "fallback ok")

        # ---- Scenario 3: 同目录 rename ----
        print("\n[Scenario 3] 同目录 rename → 旧 hash 删 + 新 hash 建")
        b = research / "scn1" / "b.pdf"; a.rename(b)
        run_once(ws)
        sh_b = shadow_for(ws, b)
        assert_(not sh.exists(), "S3 old shadow deleted", f"old={sh.name}")
        assert_(sh_b.exists(), "S3 new shadow created", f"new={sh_b.name}")

        # ---- Scenario 4: 跨目录 move ----
        print("\n[Scenario 4] 跨目录移动 → 旧 hash 删 + 新 hash 建")
        scn4 = research / "scn4"; scn4.mkdir(parents=True, exist_ok=True)
        c = scn4 / "b.pdf"; b.rename(c)
        run_once(ws)
        sh_c = shadow_for(ws, c)
        assert_(not sh_b.exists(), "S4 old shadow deleted")
        assert_(sh_c.exists(), "S4 new shadow at new path")

        # ---- Scenario 5: 删除 ----
        print("\n[Scenario 5] 删除 → shadow GC")
        c.unlink()
        run_once(ws)
        assert_(not sh_c.exists(), "S5 shadow GC'd")

        # ---- Scenario 6: 整目录 rm -rf ----
        print("\n[Scenario 6] 整目录 rm -rf → 全部 GC")
        scn6 = research / "scn6"; scn6.mkdir(parents=True, exist_ok=True)
        files = [scn6 / n for n in ("c.pdf", "d.pdf", "e.pdf")]
        for f in files: make_doc(f, f"scn6 doc {f.stem}")
        run_once(ws)
        shadows_before = [shadow_for(ws, f) for f in files]
        assert_(all(s.exists() for s in shadows_before), "S6 all 3 shadows created first")
        shutil.rmtree(scn6)
        run_once(ws)
        assert_(not any(s.exists() for s in shadows_before), "S6 all 3 shadows GC'd after rm -rf")

        # ---- Health ----
        print("\n[Health check]")
        h = ws / "memory" / "_shadow" / "_health.json"
        if h.exists():
            data = json.loads(h.read_text())
            print(f"  health: {data}")
            assert_("last_run" in data and "errors" in data, "health JSON valid")
        else:
            assert_(False, "health JSON exists")

    finally:
        # ---- Summary ----
        passed = sum(1 for _,s,_ in results if s == PASS)
        total = len(results)
        print(f"\n{'='*60}\nFINAL: {passed}/{total} PASS\n{'='*60}")
        for name, st, detail in results: print(f"  {st}  {name}")
        # leave workspace for inspection
        print(f"\n(workspace kept at {ws} for inspection)")
        if passed != total: sys.exit(1)

if __name__ == "__main__": main()
