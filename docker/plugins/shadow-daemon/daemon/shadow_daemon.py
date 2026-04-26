#!/usr/bin/env python3
"""shadow_daemon.py v5 — Event-driven document → markdown for OpenClaw memory_search.

v5: Event-driven via watchdog (chokidar's Python equivalent).
- watchdog Observer watches configured directories
- File events (create/modify/delete) trigger markitdown conversion
- Initial sync on startup catches changes from offline period
- No more os.walk polling / SIGUSR1 / progress.json / cycle counters
- Complexity: O(changes) instead of O(total files)

Architecture:
  PDF/Office files → watchdog event → markitdown → memory/_shadow/*.md
                                                     ↓
                              builtin/QMD chokidar auto re-indexes
"""
from __future__ import annotations
import hashlib, json, os, signal, subprocess, sys, threading, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---- env / paths ----
WORKSPACE = Path(os.environ.get("SHADOW_WORKSPACE", "/data/.openclaw/workspace")).resolve()
SHADOW_DIR = Path(os.environ.get("SHADOW_DIR", str(WORKSPACE / "memory" / "_shadow"))).resolve()
CONFIG_FILE = SHADOW_DIR / "_config.json"
HEALTH_FILE = SHADOW_DIR / "_health.json"

# ---- structured log ----
def log(event, **kv):
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **kv}
    print(json.dumps(rec, default=str), file=sys.stderr, flush=True)

# ---- helpers ----
def sha8(s): return hashlib.sha256(s.encode()).hexdigest()[:8]
def shadow_path_for(src): return SHADOW_DIR / f"{sha8(str(src.resolve()))}__{src.stem[:60]}.md"

def check_markitdown():
    """Check if markitdown is importable. Returns (available, version)."""
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

# ---- shared state ----
_state_lock = threading.Lock()
_current_config: Optional[dict] = None
_current_observer = None
_cumulative_converted = 0
_last_event_at: Optional[str] = None

def write_health(status, extra=None):
    """Write _health.json with current status."""
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    available, version = check_markitdown()
    health = {
        "status": status,
        "markitdown_available": available,
        "markitdown_version": version,
        "last_run": datetime.now(timezone.utc).isoformat(),
        "cumulative_converted": _cumulative_converted,
        "last_event_at": _last_event_at,
    }
    if extra:
        health.update(extra)
    if _current_config:
        health["config_dirs"] = [d.get("path", "") for d in _current_config.get("directories", [])]
        health["watching"] = _current_observer is not None and _current_observer.is_alive()
    try:
        HEALTH_FILE.write_text(json.dumps(health, indent=2))
    except OSError:
        pass

# ---- file filtering ----
def is_indexable(p: Path, max_file_bytes: int) -> Optional[str]:
    """Returns None if indexable, else a skip reason."""
    if p.is_symlink():
        return "symlink"
    if not p.is_file():
        return "not_file"
    if p.name.startswith("."):
        return "hidden"
    # any path component starts with "." (hidden dir)
    try:
        rel = p.relative_to(WORKSPACE)
        for part in rel.parts[:-1]:
            if part.startswith("."):
                return "hidden_dir"
    except ValueError:
        return "outside_workspace"
    try:
        sz = p.stat().st_size
    except OSError:
        return "stat_error"
    if sz == 0:
        return "empty"
    if sz > max_file_bytes:
        return "size"
    return None

def write_shadow(src: Path, dst: Path, body: str, status="ok", error=""):
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

def convert(src: Path, dst: Path, timeout_sec: int) -> bool:
    global _cumulative_converted
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "markitdown", str(src)],
            capture_output=True, timeout=timeout_sec, check=False,
        )
        if proc.returncode == 0:
            write_shadow(src, dst, proc.stdout.decode("utf-8", "replace"), "ok")
            with _state_lock:
                _cumulative_converted += 1
            log("convert_ok", src=str(src), bytes=len(proc.stdout))
            return True
        err = proc.stderr.decode("utf-8", "replace")[:300]
        status = "oom" if proc.returncode in (-9, 137) else "failed"
        write_shadow(src, dst, f"<!-- conversion {status} -->", status, error=f"rc={proc.returncode}")
        log(f"convert_{status}", src=str(src), rc=proc.returncode, err=err[:200])
    except subprocess.TimeoutExpired:
        write_shadow(src, dst, "<!-- conversion timeout -->", "timeout", error="timeout")
        log("convert_timeout", src=str(src), timeout_s=timeout_sec)
    except Exception as e:
        try: write_shadow(src, dst, "<!-- conversion failed -->", "failed", error=str(e)[:200])
        except Exception: pass
        log("convert_crashed", src=str(src), err=str(e)[:200])
    return False

def maybe_convert(src: Path, config: dict) -> bool:
    """Convert if src is indexable and either shadow missing or src is newer."""
    max_file_bytes = config.get("maxFileMB", 50) * 1024 * 1024
    extract_timeout = config.get("extractTimeoutSec", 180)
    skip = is_indexable(src, max_file_bytes)
    if skip:
        log("skip", src=str(src), reason=skip)
        return False
    sp = shadow_path_for(src)
    try:
        need = (not sp.exists()) or (src.stat().st_mtime > sp.stat().st_mtime + 1)
    except OSError:
        return False
    if not need:
        return False
    return convert(src, sp, extract_timeout)

def remove_shadow_for(src: Path):
    """Remove shadow file when source disappears."""
    sp = shadow_path_for(src)
    if sp.exists():
        try:
            sp.unlink()
            log("shadow_removed", src=str(src), shadow=sp.name)
        except OSError as e:
            log("shadow_remove_error", src=str(src), err=str(e)[:100])

# ---- security ----
def resolve_watch_dirs(config: dict):
    """Return list of (raw_path, resolved_path) for valid directories."""
    out = []
    for entry in config.get("directories", []):
        raw_path = entry.get("path", "")
        if not raw_path:
            continue
        target = (WORKSPACE / raw_path).resolve()
        try:
            target.relative_to(WORKSPACE)
        except ValueError:
            log("skip_outside_workspace", path=raw_path, resolved=str(target))
            continue
        if not target.is_dir():
            log("skip_missing_dir", path=raw_path)
            continue
        out.append((raw_path, target, entry.get("recursive", True)))
    return out

# ---- initial sync (catch up offline changes) ----
def initial_sync(config: dict):
    """Walk watched dirs once on startup, convert anything stale or missing,
    then GC orphan shadow files whose sources vanished while daemon was offline.
    This is the only O(N) operation; afterwards we are purely event-driven."""
    started = time.monotonic()
    targets = resolve_watch_dirs(config)
    seen_sources = set()  # absolute paths of currently-existing sources
    converted = 0
    for raw_path, target, recursive in targets:
        if recursive:
            for root, dirs, files in os.walk(target, followlinks=False):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for fn in files:
                    if fn.startswith("."): continue
                    p = (Path(root) / fn).resolve()
                    seen_sources.add(str(p))
                    if maybe_convert(p, config):
                        converted += 1
        else:
            for p in target.iterdir():
                if p.is_dir() or p.name.startswith("."): continue
                p = p.resolve()
                seen_sources.add(str(p))
                if maybe_convert(p, config):
                    converted += 1
    # GC: remove shadow files whose sources are gone
    deleted = 0
    for sp in SHADOW_DIR.glob("*.md"):
        if sp.name.startswith("_"): continue
        src = parse_source_header(sp)
        if not src or src not in seen_sources:
            try:
                sp.unlink()
                deleted += 1
                log("gc_orphan", shadow=sp.name, source=src)
            except OSError:
                pass
    log("initial_sync_done", originals=len(seen_sources), converted=converted,
        deleted=deleted, elapsed_sec=round(time.monotonic() - started, 2))
    return converted, deleted

def parse_source_header(md: Path) -> Optional[str]:
    try:
        with md.open() as f:
            for _ in range(20):
                line = f.readline()
                if not line: break
                if line.startswith("source:"):
                    return line.split(":", 1)[1].strip()
    except OSError: pass
    return None

# ---- watchdog event handler ----
def make_handler(config: dict):
    from watchdog.events import FileSystemEventHandler

    class Handler(FileSystemEventHandler):
        def _touch(self, path: str):
            global _last_event_at
            with _state_lock:
                _last_event_at = datetime.now(timezone.utc).isoformat()

        def on_created(self, event):
            if event.is_directory: return
            self._touch(event.src_path)
            try:
                p = Path(event.src_path).resolve()
                p.relative_to(WORKSPACE)
            except (OSError, ValueError):
                return
            log("event_created", src=str(p))
            maybe_convert(p, config)

        def on_modified(self, event):
            if event.is_directory: return
            self._touch(event.src_path)
            try:
                p = Path(event.src_path).resolve()
                p.relative_to(WORKSPACE)
            except (OSError, ValueError):
                return
            log("event_modified", src=str(p))
            maybe_convert(p, config)

        def on_moved(self, event):
            if event.is_directory: return
            self._touch(event.dest_path)
            try:
                src_old = Path(event.src_path).resolve()
                src_new = Path(event.dest_path).resolve()
                src_new.relative_to(WORKSPACE)
            except (OSError, ValueError):
                return
            log("event_moved", src_old=str(src_old), src_new=str(src_new))
            remove_shadow_for(src_old)
            maybe_convert(src_new, config)

        def on_deleted(self, event):
            if event.is_directory: return
            self._touch(event.src_path)
            try:
                p = Path(event.src_path).resolve()
            except OSError:
                return
            log("event_deleted", src=str(p))
            remove_shadow_for(p)
    return Handler()

# ---- observer lifecycle ----
def start_observer(config: dict):
    """Build a fresh watchdog Observer for current config. Returns observer or None."""
    from watchdog.observers import Observer
    targets = resolve_watch_dirs(config)
    if not targets:
        log("no_valid_dirs")
        return None
    handler = make_handler(config)
    observer = Observer()
    for raw_path, target, recursive in targets:
        observer.schedule(handler, str(target), recursive=recursive)
        log("watching", path=raw_path, resolved=str(target), recursive=recursive)
    observer.daemon = True
    observer.start()
    return observer

def stop_observer(observer):
    if observer is None: return
    try:
        observer.stop()
        observer.join(timeout=5)
    except Exception as e:
        log("observer_stop_error", err=str(e)[:200])

# ---- config reloader ----
def config_changed(old, new) -> bool:
    """Return True if directories or filter knobs changed (requires observer rebuild)."""
    if old is None or new is None:
        return old is not new
    keys = ("directories", "maxFileMB", "extractTimeoutSec")
    return any(old.get(k) != new.get(k) for k in keys)

def main():
    global _current_config, _current_observer
    log("daemon_start", workspace=str(WORKSPACE), shadow_dir=str(SHADOW_DIR))
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)

    stop_event = threading.Event()
    def _term(*_):
        log("daemon_stopping")
        stop_event.set()
    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)

    while not stop_event.is_set():
        # 1. check markitdown
        mt_available, mt_version = check_markitdown()
        if not mt_available:
            if _current_observer:
                stop_observer(_current_observer)
                _current_observer = None
            write_health("idle_no_markitdown")
            stop_event.wait(timeout=15)
            continue

        # 2. check config
        new_config = load_config()
        if new_config is None:
            if _current_observer:
                stop_observer(_current_observer)
                _current_observer = None
            _current_config = None
            write_health("idle_no_config")
            stop_event.wait(timeout=15)
            continue

        # 3. (re)start observer if config changed
        if config_changed(_current_config, new_config):
            if _current_observer:
                log("config_changed_restart_observer")
                stop_observer(_current_observer)
                _current_observer = None
            _current_config = new_config
            # initial sync runs synchronously, catches offline changes
            initial_sync(new_config)
            _current_observer = start_observer(new_config)
            if _current_observer:
                write_health("watching")
            else:
                write_health("idle_no_valid_dirs")

        # 4. heartbeat health
        if _current_observer and _current_observer.is_alive():
            write_health("watching")
        else:
            # observer crashed somehow — restart on next loop
            _current_observer = None
            write_health("observer_dead")

        # 5. wait for SIGTERM or 15s heartbeat (config poll interval)
        stop_event.wait(timeout=15)

    if _current_observer:
        stop_observer(_current_observer)
    write_health("stopped")
    log("daemon_stopped")

if __name__ == "__main__":
    main()
