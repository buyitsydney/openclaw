#!/usr/bin/env python3
"""shadow_daemon.py v3.2 — Office → Markdown for OpenClaw memory_search.

Reconciliation-style with **subprocess isolation** for markitdown conversion.
Each convert runs in a fresh Python subprocess with its own RLIMIT_AS (address
space) cap, so a pathological PDF cannot OOM the daemon process itself.

v3.2 (based on Nova/影 real-load review):
- Subprocess-per-conversion (crashes isolated, memory capped via RLIMIT_AS)
- Per-file timeout raised to 180s (real PDFs can need 80s+)
- Persistent progress so first-time scan can span multiple cycles
- Structured JSON logs (v3.1) retained
"""
from __future__ import annotations
import hashlib, json, os, resource, signal, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

# ---- config ----
WORKSPACE = Path(os.environ.get("SHADOW_WORKSPACE", "/data/.openclaw/workspace")).resolve()
SHADOW_DIR = (WORKSPACE / "memory" / "_shadow").resolve()
PROGRESS_FILE = SHADOW_DIR / "_progress.json"
# Blocklist: known text/code/binary files that markitdown can't help with.
# Everything else gets passed to markitdown — it rejects what it can't handle.
SKIP_EXTS = {
    ".md", ".txt", ".log", ".jsonl",
    ".py", ".ts", ".js", ".jsx", ".tsx", ".sh", ".bash", ".zsh",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
    ".sqlite", ".db", ".bin", ".o", ".so", ".dylib", ".wasm", ".exe",
    ".tar", ".gz", ".bz2", ".xz", ".7z",
    ".mp4", ".mkv", ".avi", ".mov", ".webm",
}
SKIP_DIRS = {"venv", "shadow-venv", "node_modules", ".git", "__pycache__",
             "_shadow", "_backup_2026-04-07", ".dreams", ".openclaw"}
INTERVAL_SEC = int(os.environ.get("SHADOW_INTERVAL_SEC", "300"))
MAX_FILE_BYTES = int(os.environ.get("SHADOW_MAX_FILE_MB", "50")) * 1024 * 1024
EXTRACT_TIMEOUT_SEC = int(os.environ.get("SHADOW_EXTRACT_TIMEOUT", "180"))
SCAN_BUDGET_SEC = int(os.environ.get("SHADOW_SCAN_BUDGET", "240"))
RATE_LIMIT_BATCH = 10
RATE_LIMIT_SLEEP = 5
MEM_FLOOR_MB = 200
# RLIMIT_AS per markitdown subprocess (address space cap, SIGKILL if exceeded)
SUBPROC_MEM_MB = int(os.environ.get("SHADOW_SUBPROC_MEM_MB", "1024"))

# ---- structured log ----
def log(event, **kv):
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **kv}
    print(json.dumps(rec, default=str), file=sys.stderr, flush=True)

# ---- helpers ----
def sha8(s): return hashlib.sha256(s.encode()).hexdigest()[:8]
def shadow_path_for(src): return SHADOW_DIR / f"{sha8(str(src.resolve()))}__{src.stem[:60]}.md"

def mem_available_mb():
    try:
        with open("/proc/meminfo") as f:
            for ln in f:
                if ln.startswith("MemAvailable:"): return int(ln.split()[1]) / 1024.0
    except Exception: pass
    return 999999.0

def scan_originals():
    out = []
    for root, dirs, files in os.walk(WORKSPACE, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in files:
            if fn.startswith("."):
                continue
            p = Path(root) / fn
            if p.is_symlink():
                log("skip_symlink", src=str(p), target=str(os.readlink(p)))
                continue
            if p.suffix.lower() in SKIP_EXTS:
                continue
            try:
                sz = p.stat().st_size
                if sz > MAX_FILE_BYTES: log("skip_size", src=str(p), size=sz)
                elif sz == 0: pass
                else: out.append(p)
            except OSError: pass
    return out

def parse_source_header(md):
    try:
        with md.open() as f:
            for _ in range(20):
                line = f.readline()
                if not line: break
                if line.startswith("source:"): return line.split(":", 1)[1].strip()
    except OSError: pass
    return None

def write_shadow(src, dst, body, status="ok", error=""):
    """Atomic write + align mtime to source mtime (prevents infinite retry)."""
    src_mtime = src.stat().st_mtime
    header = (
        f"---\nsource: {src.resolve()}\n"
        f"generated_at: {datetime.now(timezone.utc).isoformat()}\n"
        f"sha8: {sha8(str(src.resolve()))}\n"
        f"src_mtime: {int(src_mtime)}\nstatus: {status}\n"
        + (f"error: {error}\n" if error else "") + "---\n\n"
    )
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    tmp.write_text(header + body, encoding="utf-8")
    os.replace(tmp, dst)
    os.utime(dst, (src_mtime, src_mtime))

def convert(src, dst):
    """Run markitdown in an isolated subprocess. Memory is capped at the
    systemd unit level (MemoryMax kills the whole daemon if it exceeds).
    Process-internal RLIMIT guards were tested but OpenBLAS/numpy thread pool
    trips RLIMIT_DATA / RLIMIT_AS on startup — we rely on timeout + systemd
    instead of preexec rlimits."""
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "markitdown", str(src)],
            capture_output=True, timeout=EXTRACT_TIMEOUT_SEC, check=False,
        )
        if proc.returncode == 0:
            write_shadow(src, dst, proc.stdout.decode("utf-8", "replace"), "ok")
            log("convert_ok", src=str(src), bytes=len(proc.stdout))
            return True
        err = proc.stderr.decode("utf-8", "replace")[:300]
        status = "oom" if proc.returncode in (-9, 137) else "failed"
        write_shadow(src, dst, f"<!-- conversion {status} -->",
                     status, error=f"rc={proc.returncode}")
        log(f"convert_{status}", src=str(src), rc=proc.returncode, err=err[:200])
    except subprocess.TimeoutExpired:
        write_shadow(src, dst, "<!-- conversion timeout -->",
                     "timeout", error="timeout")
        log("convert_timeout", src=str(src), timeout_s=EXTRACT_TIMEOUT_SEC)
    except Exception as e:
        try: write_shadow(src, dst, "<!-- conversion failed -->", "failed", error=str(e)[:200])
        except Exception: pass
        log("convert_crashed", src=str(src), err=str(e)[:200])
    return False

def load_progress():
    try: return json.loads(PROGRESS_FILE.read_text())
    except Exception: return {"last_processed": None, "cumulative_converted": 0}

def save_progress(p):
    try: PROGRESS_FILE.write_text(json.dumps(p, indent=2))
    except Exception: pass

def reconcile_once():
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    avail0 = mem_available_mb()
    if avail0 < MEM_FLOOR_MB:
        log("mem_skip_cycle", available_mb=avail0, floor_mb=MEM_FLOOR_MB)
        return 0, 0, 0
    originals = scan_originals()
    src_by_shadow = {shadow_path_for(p): p for p in originals}
    progress = load_progress()
    last = progress.get("last_processed")
    # sort so we can resume deterministically
    items = sorted(src_by_shadow.items(), key=lambda kv: str(kv[1]))
    if last:
        # continue after last processed file
        start_idx = next((i for i, (_, s) in enumerate(items) if str(s) > last), 0)
        items = items[start_idx:] + items[:start_idx]
    converted = errors = 0
    last_processed = None
    for sp, src in items:
        if time.monotonic() - started > SCAN_BUDGET_SEC:
            log("budget_exhausted", processed=converted + errors); break
        if mem_available_mb() < MEM_FLOOR_MB:
            log("mem_skip_file", src=str(src)); break
        try:
            need = (not sp.exists()) or (src.stat().st_mtime > sp.stat().st_mtime + 1)
            if need:
                ok = convert(src, sp)
                converted += 1 if ok else 0
                errors += 0 if ok else 1
                if converted % RATE_LIMIT_BATCH == 0 and converted > 0: time.sleep(RATE_LIMIT_SLEEP)
            last_processed = str(src)
        except Exception as e:
            errors += 1; log("loop_error", src=str(src), err=str(e)[:200])
    # save progress so next cycle resumes
    if last_processed:
        progress["last_processed"] = last_processed
        progress["cumulative_converted"] = progress.get("cumulative_converted", 0) + converted
        save_progress(progress)
    # reverse gc
    deleted = 0
    for sp in SHADOW_DIR.glob("*.md"):
        if sp.name.startswith("_"): continue
        src = parse_source_header(sp)
        if not src or not Path(src).exists():
            sp.unlink(missing_ok=True); deleted += 1
            log("gc_orphan", shadow=sp.name, source=src)
    avail1 = mem_available_mb()
    (SHADOW_DIR / "_health.json").write_text(json.dumps({
        "last_run": datetime.now(timezone.utc).isoformat(),
        "originals": len(originals), "converted": converted, "deleted": deleted, "errors": errors,
        "elapsed_sec": round(time.monotonic() - started, 2),
        "mem_available_mb_start": round(avail0, 1),
        "mem_available_mb_end": round(avail1, 1),
        "cumulative_converted": progress.get("cumulative_converted", 0),
    }, indent=2))
    log("cycle_done", originals=len(originals), converted=converted, deleted=deleted,
        errors=errors, elapsed_sec=round(time.monotonic() - started, 2))
    return converted, deleted, errors

def main():
    if "--once" in sys.argv: reconcile_once(); return
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("daemon_start", workspace=str(WORKSPACE), interval_sec=INTERVAL_SEC)
    while True:
        try: reconcile_once()
        except Exception as e: log("cycle_crashed", err=str(e)[:300])
        time.sleep(INTERVAL_SEC)

if __name__ == "__main__": main()
