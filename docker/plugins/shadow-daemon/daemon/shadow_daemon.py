#!/usr/bin/env python3
"""shadow_daemon.py v4 — Config-driven office → markdown for OpenClaw memory_search.

v4: Fully dynamic, AI-driven architecture.
- Reads _config.json to decide which directories to scan (no hardcoded lists)
- No _config.json → idle (Her creates it)
- No markitdown → idle (Her installs it)
- Her controls everything through the SKILL
"""
from __future__ import annotations
import hashlib, json, os, signal, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

# ---- config ----
WORKSPACE = Path(os.environ.get("SHADOW_WORKSPACE", "/data/.openclaw/workspace")).resolve()
SHADOW_DIR = Path(os.environ.get("SHADOW_DIR", str(WORKSPACE / "memory" / "_shadow"))).resolve()
CONFIG_FILE = SHADOW_DIR / "_config.json"
PROGRESS_FILE = SHADOW_DIR / "_progress.json"
HEALTH_FILE = SHADOW_DIR / "_health.json"
FALLBACK_INTERVAL_SEC = int(os.environ.get("SHADOW_INTERVAL_SEC", "300"))

# ---- structured log ----
def log(event, **kv):
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **kv}
    print(json.dumps(rec, default=str), file=sys.stderr, flush=True)

# ---- helpers ----
def sha8(s): return hashlib.sha256(s.encode()).hexdigest()[:8]
def shadow_path_for(src): return SHADOW_DIR / f"{sha8(str(src.resolve()))}__{src.stem[:60]}.md"

def check_markitdown():
    """Check if markitdown is importable and return version."""
    try:
        proc = subprocess.run(
            [sys.executable, "-c", "import markitdown; print(markitdown.__version__)"],
            capture_output=True, timeout=10, check=False,
        )
        if proc.returncode == 0:
            return True, proc.stdout.decode().strip()
    except Exception:
        pass
    return False, None

def load_config():
    """Read _config.json. Returns dict or None."""
    try:
        return json.loads(CONFIG_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None

def write_health(status, extra=None):
    """Write _health.json with current status."""
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    available, version = check_markitdown()
    health = {
        "status": status,
        "markitdown_available": available,
        "markitdown_version": version,
        "last_run": datetime.now(timezone.utc).isoformat(),
    }
    if extra:
        health.update(extra)
    try:
        HEALTH_FILE.write_text(json.dumps(health, indent=2))
    except OSError:
        pass

def mem_available_mb():
    try:
        with open("/proc/meminfo") as f:
            for ln in f:
                if ln.startswith("MemAvailable:"): return int(ln.split()[1]) / 1024.0
    except Exception: pass
    return 999999.0

def scan_configured_dirs(config):
    """Scan only directories listed in config."""
    dirs = config.get("directories", [])
    max_file_bytes = config.get("maxFileMB", 50) * 1024 * 1024
    out = []
    for entry in dirs:
        raw_path = entry.get("path", "")
        if not raw_path:
            continue
        target = (WORKSPACE / raw_path).resolve()
        if not target.is_dir():
            log("skip_missing_dir", path=raw_path)
            continue
        # security: must be under workspace
        try:
            target.relative_to(WORKSPACE)
        except ValueError:
            log("skip_outside_workspace", path=raw_path, resolved=str(target))
            continue
        recursive = entry.get("recursive", True)
        if recursive:
            for root, dirs_list, files in os.walk(target, followlinks=False):
                dirs_list[:] = [d for d in dirs_list if not d.startswith(".")]
                for fn in files:
                    if fn.startswith("."):
                        continue
                    p = Path(root) / fn
                    if p.is_symlink():
                        log("skip_symlink", src=str(p))
                        continue
                    try:
                        sz = p.stat().st_size
                        if sz > max_file_bytes:
                            log("skip_size", src=str(p), size=sz)
                        elif sz == 0:
                            pass
                        else:
                            out.append(p)
                    except OSError:
                        pass
        else:
            for p in target.iterdir():
                if p.is_dir() or p.name.startswith(".") or p.is_symlink():
                    continue
                try:
                    sz = p.stat().st_size
                    if sz > max_file_bytes:
                        log("skip_size", src=str(p), size=sz)
                    elif sz == 0:
                        pass
                    else:
                        out.append(p)
                except OSError:
                    pass
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

def convert(src, dst, timeout_sec):
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "markitdown", str(src)],
            capture_output=True, timeout=timeout_sec, check=False,
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
        log("convert_timeout", src=str(src), timeout_s=timeout_sec)
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

    # check markitdown
    mt_available, mt_version = check_markitdown()
    if not mt_available:
        write_health("idle_no_markitdown")
        log("idle_no_markitdown")
        return 0, 0, 0

    # load config
    config = load_config()
    if config is None:
        write_health("idle_no_config")
        log("idle_no_config")
        return 0, 0, 0

    started = time.monotonic()
    scan_budget = config.get("scanBudgetSec", 240)
    extract_timeout = config.get("extractTimeoutSec", 180)
    rate_limit_batch = 10
    rate_limit_sleep = 5

    originals = scan_configured_dirs(config)
    src_by_shadow = {shadow_path_for(p): p for p in originals}
    progress = load_progress()
    last = progress.get("last_processed")
    items = sorted(src_by_shadow.items(), key=lambda kv: str(kv[1]))
    if last:
        start_idx = next((i for i, (_, s) in enumerate(items) if str(s) > last), 0)
        items = items[start_idx:] + items[:start_idx]

    converted = errors = 0
    last_processed = None
    for sp, src in items:
        if time.monotonic() - started > scan_budget:
            log("budget_exhausted", processed=converted + errors); break
        try:
            need = (not sp.exists()) or (src.stat().st_mtime > sp.stat().st_mtime + 1)
            if need:
                ok = convert(src, sp, extract_timeout)
                converted += 1 if ok else 0
                errors += 0 if ok else 1
                if converted % rate_limit_batch == 0 and converted > 0:
                    time.sleep(rate_limit_sleep)
            last_processed = str(src)
        except Exception as e:
            errors += 1; log("loop_error", src=str(src), err=str(e)[:200])

    if last_processed:
        progress["last_processed"] = last_processed
        progress["cumulative_converted"] = progress.get("cumulative_converted", 0) + converted
        save_progress(progress)

    # gc orphans
    deleted = 0
    for sp in SHADOW_DIR.glob("*.md"):
        if sp.name.startswith("_"): continue
        src = parse_source_header(sp)
        if not src or not Path(src).exists():
            sp.unlink(missing_ok=True); deleted += 1
            log("gc_orphan", shadow=sp.name, source=src)

    config_dirs = [d.get("path", "") for d in config.get("directories", [])]
    write_health("cycle_complete", {
        "config_dirs": config_dirs,
        "originals": len(originals),
        "converted": converted,
        "deleted": deleted,
        "errors": errors,
        "elapsed_sec": round(time.monotonic() - started, 2),
        "cumulative_converted": progress.get("cumulative_converted", 0),
    })
    log("cycle_done", originals=len(originals), converted=converted, deleted=deleted,
        errors=errors, elapsed_sec=round(time.monotonic() - started, 2))
    return converted, deleted, errors

def get_interval():
    config = load_config()
    if config and "intervalSec" in config:
        return max(30, int(config["intervalSec"]))
    return FALLBACK_INTERVAL_SEC

def main():
    if "--once" in sys.argv: reconcile_once(); return
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    log("daemon_start", workspace=str(WORKSPACE))
    while True:
        try: reconcile_once()
        except Exception as e: log("cycle_crashed", err=str(e)[:300])
        time.sleep(get_interval())

if __name__ == "__main__": main()
