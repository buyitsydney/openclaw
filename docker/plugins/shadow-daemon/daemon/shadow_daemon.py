#!/usr/bin/env python3
"""shadow_daemon.py v6 — Event-driven, debounced, parallel document → markdown.

Architecture:
  PDF/Office files → watchdog event → debounce 500ms → ThreadPool(8) → markitdown → memory/_shadow/*.md

Improvements over v5:
- Lazy-import watchdog (Her-controlled installation, idle_no_watchdog status)
- ThreadPoolExecutor for parallel conversion (subprocess releases GIL)
- Per-path debounce (500ms) — coalesce burst writes on the same file
- Per-path lock — prevent concurrent conversion of the same source
- Queue overflow detection — fall back to initial_sync if events get lost

Improvements over v2 polling:
- O(changes) instead of O(N+M+D) per cycle
- millisecond response instead of intervalSec sleep
- no rate_limit_batch sleep — true parallelism
"""
from __future__ import annotations
import hashlib, json, os, signal, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---- env / paths ----
WORKSPACE = Path(os.environ.get("SHADOW_WORKSPACE", "/data/.openclaw/workspace")).resolve()
SHADOW_DIR = Path(os.environ.get("SHADOW_DIR", str(WORKSPACE / "memory" / "_shadow"))).resolve()
CONFIG_FILE = SHADOW_DIR / "_config.json"
HEALTH_FILE = SHADOW_DIR / "_health.json"

# ---- tunables (config-overridable) ----
DEFAULT_DEBOUNCE_MS = 500
DEFAULT_MAX_WORKERS = 8
DEFAULT_RECONCILE_SEC = 60  # safety-net rescan to catch lost watchdog events

# ---- structured log ----
def log(event, **kv):
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **kv}
    print(json.dumps(rec, default=str), file=sys.stderr, flush=True)

def sha8(s): return hashlib.sha256(s.encode()).hexdigest()[:8]

def _safe_ext(p: Path) -> str:
    """Sanitize extension for use in filename. Empty when no/unsafe ext."""
    ext = p.suffix.lstrip(".").lower()
    # Only [a-z0-9] up to 6 chars; keeps shadow filenames clean and shell-safe
    if ext and 1 <= len(ext) <= 6 and ext.isalnum():
        return ext
    return ""

def shadow_path_for(src):
    """Bug B fix: include source extension in shadow filename."""
    h = sha8(str(src.resolve()))
    stem = src.stem[:60]
    ext = _safe_ext(src)
    if ext:
        return SHADOW_DIR / f"{h}__{stem}.{ext}.md"
    return SHADOW_DIR / f"{h}__{stem}.md"

# ---- Bug A: magic-byte mime check ----
# Map ext → list of acceptable header byte prefixes (None = text/anything ok).
# Source: file(1) magic + Wikipedia file signatures.
_MAGIC_RULES: dict = {
    "pdf":  [b"%PDF-"],
    "docx": [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"],
    "xlsx": [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"],
    "pptx": [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"],
    "epub": [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"],
    "zip":  [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"],
    "doc":  [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],  # OLE Compound File
    "xls":  [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],
    "ppt":  [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],
    "rtf":  [b"{\\rtf"],
    "png":  [b"\x89PNG\r\n\x1a\n"],
    "jpg":  [b"\xff\xd8\xff"],
    "jpeg": [b"\xff\xd8\xff"],
    "gif":  [b"GIF87a", b"GIF89a"],
    "bmp":  [b"BM"],
    "webp": [b"RIFF"],  # also has WEBP at offset 8 but RIFF is enough
    "mp3":  [b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"],
    "wav":  [b"RIFF"],
    "mobi": [b"BOOKMOBI", b"TPZ", b"\xea\x05"],  # palmDOC variants too
    # Text-ish formats: skip magic check (any bytes are valid)
    "txt": None, "md": None, "csv": None, "tsv": None,
    "json": None, "xml": None, "html": None, "htm": None,
    "log": None, "yaml": None, "yml": None, "toml": None, "ini": None,
}

def verify_magic(src: Path) -> Optional[str]:
    """Bug A fix: check first 8 bytes match the extension's magic bytes.
    Returns None if OK or unknown ext (skip magic check).
    Returns a reason string ('mime_mismatch' / 'unreadable') on failure."""
    ext = _safe_ext(src)
    if not ext:
        return None  # No ext: don't enforce; treat as opaque blob.
    rules = _MAGIC_RULES.get(ext)
    if rules is None:
        return None  # Either unlisted ext (don't block) or text-like.
    try:
        with src.open("rb") as f:
            head = f.read(16)
    except OSError:
        return "unreadable"
    if any(head.startswith(prefix) for prefix in rules):
        return None
    return "mime_mismatch"

# ---- dep checks ----
def check_markitdown():
    try:
        proc = subprocess.run(
            [sys.executable, "-c", "import markitdown; print(markitdown.__version__)"],
            capture_output=True, timeout=10, check=False,
        )
        if proc.returncode == 0:
            return True, proc.stdout.decode().strip()
    except Exception: pass
    return False, None

def check_watchdog():
    """Verify watchdog is importable in a *fresh* subprocess (avoids stale
    sys.modules cache after Her uninstalls/reinstalls the package)."""
    try:
        proc = subprocess.run(
            [sys.executable, "-c",
             "import watchdog; "
             "from watchdog.version import VERSION_STRING; "
             "print(VERSION_STRING)"],
            capture_output=True, timeout=10, check=False,
        )
        if proc.returncode == 0:
            return True, proc.stdout.decode().strip() or "installed"
    except Exception: pass
    return False, None

def load_config():
    try:
        return json.loads(CONFIG_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None

# ---- shared state ----
_state_lock = threading.Lock()
_current_config: Optional[dict] = None
_current_observer = None
_executor: Optional[ThreadPoolExecutor] = None
_cumulative_converted = 0
_cumulative_skipped = 0
_cumulative_errors = 0
_last_event_at: Optional[str] = None

# Per-path debounce timers and conversion locks
_debounce_timers: dict = {}     # path_str -> threading.Timer
_path_locks: dict = {}          # path_str -> threading.Lock
_locks_mutex = threading.Lock()  # protects _debounce_timers + _path_locks

def load_persistent_counters():
    """Bug J fix: restore cumulative counters from previous _health.json on startup."""
    global _cumulative_converted, _cumulative_skipped, _cumulative_errors
    try:
        h = json.loads(HEALTH_FILE.read_text())
        _cumulative_converted = max(0, int(h.get("cumulative_converted", 0) or 0))
        _cumulative_skipped = max(0, int(h.get("cumulative_skipped", 0) or 0))
        _cumulative_errors = max(0, int(h.get("cumulative_errors", 0) or 0))
        log("counters_restored",
            converted=_cumulative_converted,
            skipped=_cumulative_skipped,
            errors=_cumulative_errors)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        log("counters_fresh_start")

def write_health(status, extra=None):
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    mt_avail, mt_ver = check_markitdown()
    wd_avail, wd_ver = check_watchdog()
    health = {
        "status": status,
        "markitdown_available": mt_avail,
        "markitdown_version": mt_ver,
        "watchdog_available": wd_avail,
        "watchdog_version": wd_ver,
        "last_run": datetime.now(timezone.utc).isoformat(),
        "cumulative_converted": _cumulative_converted,
        "cumulative_skipped": _cumulative_skipped,
        "cumulative_errors": _cumulative_errors,
        "last_event_at": _last_event_at,
    }
    if extra: health.update(extra)
    if _current_config:
        health["config_dirs"] = [d.get("path", "") for d in _current_config.get("directories", [])]
        health["watching"] = _current_observer is not None and _current_observer.is_alive()
        health["max_workers"] = _current_config.get("maxWorkers", DEFAULT_MAX_WORKERS)
        health["debounce_ms"] = _current_config.get("debounceMs", DEFAULT_DEBOUNCE_MS)
    try:
        HEALTH_FILE.write_text(json.dumps(health, indent=2, ensure_ascii=False))
    except OSError: pass

# ---- file filtering ----
def is_indexable(p: Path, max_file_bytes: int) -> Optional[str]:
    if p.is_symlink(): return "symlink"
    if not p.exists(): return "not_exists"
    if not p.is_file(): return "not_file"
    if p.name.startswith("."): return "hidden"
    try:
        rel = p.relative_to(WORKSPACE)
        for part in rel.parts[:-1]:
            if part.startswith("."): return "hidden_dir"
    except ValueError:
        return "outside_workspace"
    try:
        sz = p.stat().st_size
    except OSError:
        return "stat_error"
    if sz == 0: return "empty"
    if sz > max_file_bytes: return "size"
    return None

def write_shadow(src: Path, dst: Path, body: str, status="ok", error=""):
    """Bug I fix: also persist src_size in frontmatter so we can detect content
    changes when mtime is reset (e.g. git checkout, rsync --times)."""
    src_stat = src.stat()
    src_mtime = src_stat.st_mtime
    src_size = src_stat.st_size
    header = (
        f"---\nsource: {src.resolve()}\n"
        f"generated_at: {datetime.now(timezone.utc).isoformat()}\n"
        f"sha8: {sha8(str(src.resolve()))}\n"
        f"src_mtime: {int(src_mtime)}\nsrc_size: {src_size}\nstatus: {status}\n"
        + (f"error: {error}\n" if error else "") + "---\n\n"
    )
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    tmp.write_text(header + body, encoding="utf-8")
    os.replace(tmp, dst)
    os.utime(dst, (src_mtime, src_mtime))

def convert(src: Path, dst: Path, timeout_sec: int) -> bool:
    global _cumulative_converted, _cumulative_errors
    # Bug A: verify file content matches its extension before invoking markitdown.
    magic_err = verify_magic(src)
    if magic_err == "mime_mismatch":
        write_shadow(src, dst, f"<!-- file extension does not match content magic bytes -->",
                     "mime_mismatch", error="extension/magic mismatch")
        with _state_lock: _cumulative_errors += 1
        log("mime_mismatch", src=str(src), ext=_safe_ext(src))
        return False
    if magic_err == "unreadable":
        with _state_lock: _cumulative_errors += 1
        log("convert_unreadable", src=str(src))
        return False
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "markitdown", str(src)],
            capture_output=True, timeout=timeout_sec, check=False,
        )
        if proc.returncode == 0:
            write_shadow(src, dst, proc.stdout.decode("utf-8", "replace"), "ok")
            with _state_lock: _cumulative_converted += 1
            log("convert_ok", src=str(src), bytes=len(proc.stdout))
            return True
        err = proc.stderr.decode("utf-8", "replace")[:300]
        status = "oom" if proc.returncode in (-9, 137) else "failed"
        write_shadow(src, dst, f"<!-- conversion {status} -->", status, error=f"rc={proc.returncode}")
        with _state_lock: _cumulative_errors += 1
        log(f"convert_{status}", src=str(src), rc=proc.returncode, err=err[:200])
    except subprocess.TimeoutExpired:
        try: write_shadow(src, dst, "<!-- conversion timeout -->", "timeout", error="timeout")
        except Exception: pass
        with _state_lock: _cumulative_errors += 1
        log("convert_timeout", src=str(src), timeout_s=timeout_sec)
    except Exception as e:
        try: write_shadow(src, dst, "<!-- conversion failed -->", "failed", error=str(e)[:200])
        except Exception: pass
        with _state_lock: _cumulative_errors += 1
        log("convert_crashed", src=str(src), err=str(e)[:200])
    return False

def _get_path_lock(path_str: str) -> threading.Lock:
    with _locks_mutex:
        lock = _path_locks.get(path_str)
        if lock is None:
            lock = threading.Lock()
            _path_locks[path_str] = lock
        return lock

def _read_shadow_size(sp: Path) -> Optional[int]:
    """Bug I helper: parse src_size from shadow frontmatter (None if missing/legacy)."""
    try:
        with sp.open() as f:
            for _ in range(20):
                line = f.readline()
                if not line: break
                if line.startswith("src_size:"):
                    try: return int(line.split(":", 1)[1].strip())
                    except ValueError: return None
    except OSError: pass
    return None

def maybe_convert(src: Path, config: dict) -> bool:
    """Acquire per-path lock, check size/staleness, run markitdown if needed.
    Bug I fix: detect mtime OR size change so resetting mtime can't mask edits."""
    global _cumulative_skipped
    max_file_bytes = config.get("maxFileMB", 50) * 1024 * 1024
    extract_timeout = config.get("extractTimeoutSec", 180)
    path_str = str(src.resolve())
    lock = _get_path_lock(path_str)
    with lock:
        skip = is_indexable(src, max_file_bytes)
        if skip:
            with _state_lock: _cumulative_skipped += 1
            log("skip", src=path_str, reason=skip)
            return False
        sp = shadow_path_for(src)
        try:
            src_stat = src.stat()
        except OSError:
            return False
        if not sp.exists():
            need = True
        else:
            try:
                sp_mtime = sp.stat().st_mtime
            except OSError:
                return False
            saved_size = _read_shadow_size(sp)
            mtime_newer = src_stat.st_mtime > sp_mtime + 1
            size_changed = saved_size is not None and saved_size != src_stat.st_size
            need = mtime_newer or size_changed
        if not need:
            return False
        return convert(src, sp, extract_timeout)

def remove_shadow_for(src: Path):
    sp = shadow_path_for(src)
    if sp.exists():
        try:
            sp.unlink()
            log("shadow_removed", src=str(src), shadow=sp.name)
        except OSError as e:
            log("shadow_remove_error", src=str(src), err=str(e)[:100])

# ---- security ----
def resolve_watch_dirs(config: dict):
    out = []
    for entry in config.get("directories", []):
        raw_path = entry.get("path", "")
        if not raw_path: continue
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

# ---- initial sync (catches up offline period changes) ----
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

def initial_sync(config: dict, blocking: bool = True):
    """Walk watched dirs, submit conversion tasks for stale/missing files.
    Periodic reconcile uses blocking=False to avoid main-loop stalls.
    GC orphan shadow files (sources gone)."""
    started = time.monotonic()
    targets = resolve_watch_dirs(config)
    seen_sources = set()
    submitted = 0
    futures = []

    def _is_fresh(p: Path, sp: Path) -> bool:
        """Bug I: shadow is fresh ONLY if src mtime not newer AND src size unchanged."""
        try:
            sp_stat = sp.stat()
            p_stat = p.stat()
        except OSError:
            return False
        if p_stat.st_mtime > sp_stat.st_mtime + 1:
            return False
        saved_size = _read_shadow_size(sp)
        if saved_size is not None and saved_size != p_stat.st_size:
            return False
        return True

    for raw_path, target, recursive in targets:
        if recursive:
            for root, dirs, files in os.walk(target, followlinks=False):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for fn in files:
                    if fn.startswith("."): continue
                    p = (Path(root) / fn).resolve()
                    seen_sources.add(str(p))
                    sp = shadow_path_for(p)
                    if sp.exists() and _is_fresh(p, sp):
                        continue
                    fut = _executor.submit(maybe_convert, p, config)
                    submitted += 1
                    if blocking: futures.append(fut)
        else:
            for p in target.iterdir():
                if p.is_dir() or p.name.startswith("."): continue
                p = p.resolve()
                seen_sources.add(str(p))
                sp = shadow_path_for(p)
                if sp.exists() and _is_fresh(p, sp):
                    continue
                fut = _executor.submit(maybe_convert, p, config)
                submitted += 1
                if blocking: futures.append(fut)
    converted = sum(1 for f in futures if f.result()) if blocking else -1
    deleted = 0
    for sp in SHADOW_DIR.glob("*.md"):
        if sp.name.startswith("_"): continue
        src = parse_source_header(sp)
        if not src or src not in seen_sources:
            try:
                sp.unlink()
                deleted += 1
                log("gc_orphan", shadow=sp.name, source=src)
            except OSError: pass
    log("sync_done", originals=len(seen_sources), submitted=submitted,
        converted=converted, deleted=deleted, blocking=blocking,
        elapsed_sec=round(time.monotonic() - started, 2))
    return submitted, deleted

# ---- debounced event submission ----
def _schedule_convert(src: Path, config: dict):
    """Per-path debounce: cancel pending timer, start new one. Last burst wins."""
    global _last_event_at
    path_str = str(src)
    debounce_sec = config.get("debounceMs", DEFAULT_DEBOUNCE_MS) / 1000.0
    with _locks_mutex:
        old = _debounce_timers.pop(path_str, None)
        if old:
            old.cancel()
        def _fire():
            with _locks_mutex:
                _debounce_timers.pop(path_str, None)
            try:
                p = Path(path_str).resolve()
                p.relative_to(WORKSPACE)
            except (OSError, ValueError):
                return
            _executor.submit(maybe_convert, p, config)
        timer = threading.Timer(debounce_sec, _fire)
        timer.daemon = True
        _debounce_timers[path_str] = timer
        timer.start()
    with _state_lock:
        _last_event_at = datetime.now(timezone.utc).isoformat()

def _schedule_delete(src: Path):
    global _last_event_at
    try:
        p = Path(str(src)).resolve()
    except OSError: return
    _executor.submit(remove_shadow_for, p)
    with _state_lock:
        _last_event_at = datetime.now(timezone.utc).isoformat()

# ---- watchdog handler factory ----
def make_handler(config: dict):
    from watchdog.events import FileSystemEventHandler

    class Handler(FileSystemEventHandler):
        def on_created(self, event):
            if event.is_directory: return
            log("event_created", src=event.src_path)
            _schedule_convert(Path(event.src_path), config)
        def on_modified(self, event):
            if event.is_directory: return
            log("event_modified", src=event.src_path)
            _schedule_convert(Path(event.src_path), config)
        def on_moved(self, event):
            if event.is_directory: return
            log("event_moved", src_old=event.src_path, src_new=event.dest_path)
            _schedule_delete(Path(event.src_path))
            _schedule_convert(Path(event.dest_path), config)
        def on_deleted(self, event):
            if event.is_directory: return
            log("event_deleted", src=event.src_path)
            # cancel any pending debounce for this path
            with _locks_mutex:
                t = _debounce_timers.pop(str(event.src_path), None)
                if t: t.cancel()
            _schedule_delete(Path(event.src_path))
    return Handler()

# ---- observer lifecycle ----
def start_observer(config: dict):
    from watchdog.observers import Observer
    targets = resolve_watch_dirs(config)
    if not targets:
        log("no_valid_dirs"); return None
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

def config_changed(old, new) -> bool:
    if old is None or new is None: return old is not new
    keys = ("directories", "maxFileMB", "extractTimeoutSec", "debounceMs", "maxWorkers",
            "reconcileIntervalSec")
    return any(old.get(k) != new.get(k) for k in keys)

# ---- main loop ----
def main():
    global _current_config, _current_observer, _executor
    log("daemon_start", workspace=str(WORKSPACE), shadow_dir=str(SHADOW_DIR))
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    load_persistent_counters()  # Bug J: carry cumulative across restarts

    stop_event = threading.Event()
    def _term(*_):
        log("daemon_stopping"); stop_event.set()
    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)

    last_reconcile_at = 0.0
    have_valid_dirs = False

    while not stop_event.is_set():
        # 1. dep checks (Her installs both via SKILL)
        mt_avail, _ = check_markitdown()
        wd_avail, _ = check_watchdog()
        if not wd_avail:
            if _current_observer:
                stop_observer(_current_observer); _current_observer = None
            write_health("idle_no_watchdog")
            stop_event.wait(timeout=15); continue
        if not mt_avail:
            if _current_observer:
                stop_observer(_current_observer); _current_observer = None
            write_health("idle_no_markitdown")
            stop_event.wait(timeout=15); continue

        # 2. config check
        new_config = load_config()
        if new_config is None:
            if _current_observer:
                stop_observer(_current_observer); _current_observer = None
            _current_config = None
            have_valid_dirs = False
            write_health("idle_no_config")
            stop_event.wait(timeout=15); continue

        # 3. (re)start observer + executor on config change
        if config_changed(_current_config, new_config):
            if _current_observer:
                log("config_changed_restart_observer")
                stop_observer(_current_observer); _current_observer = None
            if _executor:
                _executor.shutdown(wait=True, cancel_futures=False); _executor = None
            _current_config = new_config
            max_workers = max(1, int(new_config.get("maxWorkers", DEFAULT_MAX_WORKERS)))
            _executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="shadow-worker")
            log("executor_started", max_workers=max_workers)
            initial_sync(new_config)
            last_reconcile_at = time.monotonic()
            _current_observer = start_observer(new_config)
            have_valid_dirs = _current_observer is not None

        # 4. periodic reconcile — non-blocking safety net for lost watchdog events
        reconcile_sec = int(new_config.get("reconcileIntervalSec", DEFAULT_RECONCILE_SEC))
        if have_valid_dirs and time.monotonic() - last_reconcile_at >= reconcile_sec:
            log("periodic_reconcile_start")
            initial_sync(new_config, blocking=False)  # non-blocking submit
            last_reconcile_at = time.monotonic()

        # 5. status
        if not have_valid_dirs:
            write_health("idle_no_valid_dirs")
        elif _current_observer and _current_observer.is_alive():
            write_health("watching")
        else:
            _current_observer = None
            have_valid_dirs = False
            write_health("observer_dead")
        stop_event.wait(timeout=5)  # tighter heartbeat for faster reconcile

    if _current_observer: stop_observer(_current_observer)
    if _executor: _executor.shutdown(wait=False, cancel_futures=True)
    write_health("stopped")
    log("daemon_stopped")

if __name__ == "__main__":
    main()
