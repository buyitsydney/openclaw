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
import hashlib, json, os, signal, subprocess, sys, threading, time, zipfile
from collections import deque
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
DEFAULT_EXTRACT_TIMEOUT_SEC = 600  # Bug S fix: 30MB PDFs need >180s
DEFAULT_MAX_OUTPUT_MB = 5          # Bug L fix: cap per-shadow md size
DEFAULT_ARCHIVE_MAX_FILES = 20     # Bug Q fix: cap zip entries
RECENT_BUFFER_SIZE = 50            # Bug R fix: rolling skips/errors

# ---- Bug O helper: filename → expects strict UTF-8 text? ----
TEXT_LIKE_EXT = {"txt", "md", "csv", "tsv", "log", "json", "xml",
                 "html", "htm", "yaml", "yml", "toml", "ini"}

# ---- Bug P helper: bidi/RTL control chars in filenames ----
_BIDI_CTRL_CODEPOINTS = set(range(0x202A, 0x202F)) | {0x200E, 0x200F, 0x061C}
def _has_bidi_ctrl(s: str) -> bool:
    return any(ord(c) in _BIDI_CTRL_CODEPOINTS for c in s)

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

# ---- v8.5 Bug C/L/N + v8.6 Bug B11: defensive config coercion ----
def _cfg_int(cfg: dict, key: str, default: int, min_value: int = 1) -> int:
    """Coerce a config value to int with graceful fallback.
    Accepts int / float / numeric string / None. Garbage → default.
    Values below min_value (default 1) clamp to default + log — prevents
    typos like maxFileMB=-1 from silently rejecting every file.
    Never raises — daemon must not die from a config typo."""
    try:
        v = (cfg or {}).get(key, default)
        if v is None: return default
        if isinstance(v, bool): return default  # bool is subclass of int, reject
        result = int(v) if not isinstance(v, str) else int(v.strip())
    except (ValueError, TypeError):
        log("config_coerce_fallback", key=key, value=repr((cfg or {}).get(key)), fallback=default)
        return default
    if result < min_value:
        log("config_coerce_clamp", key=key, value=result, min_value=min_value, fallback=default)
        return default
    return result

def _cfg_dirs(cfg: dict) -> list:
    """Validate `directories` is a list of dicts with `path` string.
    Garbage → empty list + log. Never raises."""
    raw = (cfg or {}).get("directories", [])
    if not isinstance(raw, list):
        log("config_bad_directories_type", got=type(raw).__name__)
        return []
    out = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            log("config_bad_directory_entry", index=i, got=type(entry).__name__)
            continue
        p = entry.get("path")
        if not isinstance(p, str) or not p.strip():
            log("config_bad_directory_path", index=i)
            continue
        out.append({"path": p.strip(), "recursive": bool(entry.get("recursive", True))})
    return out

# ---- shared state ----
_state_lock = threading.Lock()
_current_config: Optional[dict] = None
_current_observer = None
_executor: Optional[ThreadPoolExecutor] = None
_cumulative_converted = 0
_cumulative_skipped = 0
_cumulative_errors = 0
_last_event_at: Optional[str] = None

# Bug R fix: rolling per-event detail buffers
_recent_skips: deque = deque(maxlen=RECENT_BUFFER_SIZE)   # [{path, reason, ts}]
_recent_errors: deque = deque(maxlen=RECENT_BUFFER_SIZE)  # [{path, kind, ts}]
# v8.3 Bug 3: rolling buffer of successful convert events, so SKILL can
# check "did this file's convert_ok show up yet?" without polling shadow fs.
_recent_events: deque = deque(maxlen=RECENT_BUFFER_SIZE)  # [{path, kind, ts}]
# v8.3 Bug 1+2: latest human-readable event + last-known source file count.
_last_event: Optional[str] = None         # "convert_ok docs/foo.pdf"
_target_count: int = 0                    # # of source files daemon currently tracks
# v8.5 Bug H: track known source paths so target_count updates on every
# event, not just initial_sync. Creations add; deletions remove.
_known_sources: set = set()

# Per-path debounce timers and conversion locks
_debounce_timers: dict = {}     # path_str -> threading.Timer
_path_locks: dict = {}          # path_str -> threading.Lock
_locks_mutex = threading.Lock()  # protects _debounce_timers + _path_locks

# v8.6 Bug B3: periodic reconcile safety-net. Recreated per reinit so config
# changes to reconcileIntervalSec take effect without daemon restart.
_reconcile_stop: Optional[threading.Event] = None
_reconcile_thread: Optional[threading.Thread] = None

# Cached dep state — refreshed only by main loop (not write_health hot path).
_cached_mt_avail: bool = False
_cached_mt_ver: Optional[str] = None
_cached_wd_avail: bool = False
_cached_wd_ver: Optional[str] = None
_health_write_lock = threading.Lock()

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _rel_path(full: str) -> str:
    """Best-effort path shortening for human-readable last_event."""
    try:
        return str(Path(full).relative_to(WORKSPACE))
    except (ValueError, TypeError):
        return full

def record_skip(path: str, reason: str):
    """Bug R: append to rolling skip list + bump counter.
    v8.5: dedup consecutive same-path same-reason entries so files
    daemon can never process (symlinks, broken files) don't flood the
    buffer every reconcile cycle."""
    global _cumulative_skipped, _last_event, _last_event_at
    with _state_lock:
        # Dedup: if the most recent entry has same path+reason, just
        # bump the timestamp instead of appending a duplicate.
        if _recent_skips and _recent_skips[-1].get("path") == path \
                         and _recent_skips[-1].get("reason") == reason:
            _recent_skips[-1]["ts"] = _now_iso()
            return
        _cumulative_skipped += 1
        ts = _now_iso()
        _recent_skips.append({"path": path, "reason": reason, "ts": ts})
        _last_event = f"skip:{reason} {_rel_path(path)}"
        _last_event_at = ts  # v8.4 Bug A: keep pair in sync
    write_health_fast()

def record_error(path: str, kind: str):
    """Bug R: append to rolling error list + bump counter."""
    global _cumulative_errors, _last_event, _last_event_at
    with _state_lock:
        _cumulative_errors += 1
        ts = _now_iso()
        _recent_errors.append({"path": path, "kind": kind, "ts": ts})
        _last_event = f"error:{kind} {_rel_path(path)}"
        _last_event_at = ts  # v8.4 Bug A
    write_health_fast()

def record_ok(path: str):
    """v8.3 Bug 3: push convert_ok into recent_events so SKILL can verify
    a specific file converted without polling the shadow filesystem."""
    global _last_event, _last_event_at
    with _state_lock:
        ts = _now_iso()
        _recent_events.append({"path": path, "kind": "convert_ok", "ts": ts})
        _last_event = f"convert_ok {_rel_path(path)}"
        _last_event_at = ts  # v8.4 Bug A
    # v8.5 Bug H: mark path as known for target_count tracking
    note_source(path)
    # write_health_fast already called by convert() after increment

def prune_recent_for_path(path: str):
    """v8.3 Bug 13: when a source file is gone (delete event), remove its
    entries from recent_skips/errors/events so Her doesn't surface ghost
    errors for files that no longer exist."""
    with _state_lock:
        for buf in (_recent_skips, _recent_errors, _recent_events):
            keep = [e for e in buf if e.get("path") != path]
            buf.clear()
            buf.extend(keep)

def note_source(path: str) -> bool:
    """v8.5 Bug H: mark a path as known to the daemon; bump target_count if
    it's the first sighting. Called from convert() success + tombstone paths.
    Returns True if this was a new path."""
    global _target_count
    with _state_lock:
        if path not in _known_sources:
            _known_sources.add(path)
            _target_count = len(_known_sources)
            return True
        return False

def forget_source(path: str) -> bool:
    """v8.5 Bug H: mirror note_source on delete. Returns True if removed."""
    global _target_count
    with _state_lock:
        if path in _known_sources:
            _known_sources.discard(path)
            _target_count = len(_known_sources)
            return True
        return False

def load_persistent_counters():
    """Bug J fix: restore cumulative counters from previous _health.json on startup.
    v8.4: counters now live under `_internal:{}`; keep back-compat with the old
    top-level layout so we can upgrade without losing lifetime stats."""
    global _cumulative_converted, _cumulative_skipped, _cumulative_errors
    try:
        h = json.loads(HEALTH_FILE.read_text())
        src = h.get("_internal") or h   # new path first, fall back to flat
        _cumulative_converted = max(0, int(src.get("cumulative_converted", 0) or 0))
        _cumulative_skipped = max(0, int(src.get("cumulative_skipped", 0) or 0))
        _cumulative_errors = max(0, int(src.get("cumulative_errors", 0) or 0))
        log("counters_restored",
            converted=_cumulative_converted,
            skipped=_cumulative_skipped,
            errors=_cumulative_errors)
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        log("counters_fresh_start")

def _refresh_deps_cache():
    """Run in main loop only — spawn subprocess to verify deps; cache result."""
    global _cached_mt_avail, _cached_mt_ver, _cached_wd_avail, _cached_wd_ver
    _cached_mt_avail, _cached_mt_ver = check_markitdown()
    _cached_wd_avail, _cached_wd_ver = check_watchdog()

def write_health(status, extra=None):
    """Main-loop entry: refresh dep cache then persist health."""
    _refresh_deps_cache()
    _persist_health(status, extra)

def write_health_fast(status: Optional[str] = None):
    """Hot-path entry (record_skip/record_error): use cached deps; no subprocess fork."""
    _persist_health(status, None)

def _persist_health(status: Optional[str], extra):
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    with _health_write_lock:
        # Carry forward last status if caller didn't supply one.
        if status is None:
            try:
                prev = json.loads(HEALTH_FILE.read_text())
                status = prev.get("status", "watching")
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                status = "watching"

        # ---- product-facing fields (Her reads these, NOT the internal ones) ----
        # ready: a single boolean answer to "can I index documents now?"
        # needs: when not ready, ONE word telling Her what to do next
        ready = (status == "watching")
        needs: Optional[str] = None
        if not ready:
            if status in ("idle_no_watchdog", "idle_no_markitdown"):
                needs = "tools"      # Her runs pip install
            elif status in ("idle_no_config", "idle_no_valid_dirs"):
                needs = "config"     # Her writes _config.json
            elif status == "reinit_error":
                needs = "recovery"   # Her may need to restart daemon
            elif status == "stopped":
                needs = "restart"    # supervisor will respawn
            else:
                needs = "unknown"

        # v8.3 Bug 12: current shadow count (excludes tombstones? no — shadow
        # files exist for both OK and failed conversions. Her's user-facing
        # "already indexed N" should use indexed_now, not cumulative.
        try:
            indexed_now = sum(
                1 for p in SHADOW_DIR.glob("*.md") if not p.name.startswith("_")
            )
        except OSError:
            indexed_now = 0

        # v8.3 Bug 2 + v8.5 Bug G: target_count = source files from last sync;
        # pct = how much of target we've PROCESSED (converted OR skipped OR
        # errored — all of those have tombstones now). Using only cumulative_
        # converted leaves pct < 100 forever when some files legitimately
        # can't be converted (too big, empty, bad encoding).
        processed = _cumulative_converted + _cumulative_skipped + _cumulative_errors
        pct = 100.0
        if _target_count > 0:
            pct = round(min(100.0, 100.0 * processed / _target_count), 1)

        progress = {
            "indexed_total": _cumulative_converted,      # cumulative (back-compat)
            "indexed_now": indexed_now,                   # live shadow count (Bug 12)
            "target_count": _target_count,                # source files last seen (Bug 2)
            "pct": pct,                                   # 0-100 (Bug 2)
            "errors_recent": len(_recent_errors),
        }

        watching_dirs: list = []
        if _current_config and _current_observer is not None:
            watching_dirs = [d["path"] for d in _cfg_dirs(_current_config)]

        # v8.3 Bug 6: expose caps under `limits:{}` so SKILL docs don't hardcode.
        # v8.5 Bug C/L: _cfg_int tolerates config typos.
        limits = {
            "max_file_mb": _cfg_int(_current_config, "maxFileMB", 50),
            "max_output_mb": _cfg_int(_current_config, "maxOutputMB", DEFAULT_MAX_OUTPUT_MB),
            "archive_max_files": _cfg_int(_current_config, "archiveMaxFiles", DEFAULT_ARCHIVE_MAX_FILES),
            "extract_timeout_sec": _cfg_int(_current_config, "extractTimeoutSec", DEFAULT_EXTRACT_TIMEOUT_SEC),
        }

        # ---- end product-facing fields ----

        # v8.4 Bug B/C: isolate non-product fields under `_internal:` so Her
        # can't accidentally surface `cumulative_converted=50231` etc. Top-
        # level stays a clean product contract (ready/needs/progress/
        # watching_dirs/last_event/recent_*/limits). Everything else (deps
        # versions, cumulative counters, runtime tuning) lives in _internal.
        internal = {
            "status": status,
            "markitdown_available": _cached_mt_avail,
            "markitdown_version": _cached_mt_ver,
            "watchdog_available": _cached_wd_avail,
            "watchdog_version": _cached_wd_ver,
            "last_run": datetime.now(timezone.utc).isoformat(),
            "cumulative_converted": _cumulative_converted,
            "cumulative_skipped": _cumulative_skipped,
            "cumulative_errors": _cumulative_errors,
        }
        if _current_config:
            internal["config_dirs"] = [d["path"] for d in _cfg_dirs(_current_config)]
            internal["watching"] = _current_observer is not None and _current_observer.is_alive()
            internal["max_workers"] = _cfg_int(_current_config, "maxWorkers", DEFAULT_MAX_WORKERS)
            internal["debounce_ms"] = _cfg_int(_current_config, "debounceMs", DEFAULT_DEBOUNCE_MS)

        health = {
            # ── product (Her reads these) ──
            "ready": ready,
            "needs": needs,
            "progress": progress,
            "watching_dirs": watching_dirs,
            "last_event": _last_event,
            "last_event_at": _last_event_at,
            "recent_events": list(_recent_events),
            "recent_skips": list(_recent_skips),
            "recent_errors": list(_recent_errors),
            "limits": limits,

            # ── internal (ops-only, Her banned from exposing) ──
            "_internal": internal,
        }
        if extra: health.update(extra)
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
    changes when mtime is reset (e.g. git checkout, rsync --times).
    Bug P fix: warn in frontmatter when filename has bidi/RTL control chars."""
    src_stat = src.stat()
    src_mtime = src_stat.st_mtime
    src_size = src_stat.st_size
    bidi_warning = ""
    if _has_bidi_ctrl(src.name):
        bidi_warning = "filename_warning: contains bidi control char\n"
    header = (
        f"---\nsource: {src.resolve()}\n"
        f"generated_at: {datetime.now(timezone.utc).isoformat()}\n"
        f"sha8: {sha8(str(src.resolve()))}\n"
        f"src_mtime: {int(src_mtime)}\nsrc_size: {src_size}\nstatus: {status}\n"
        + (f"error: {error}\n" if error else "")
        + bidi_warning
        + "---\n\n"
    )
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    tmp.write_text(header + body, encoding="utf-8")
    os.replace(tmp, dst)
    os.utime(dst, (src_mtime, src_mtime))

def convert(src: Path, dst: Path, timeout_sec: int, max_output_bytes: int, archive_max_files: int) -> bool:
    global _cumulative_converted
    path_str = str(src)
    # Bug X1: source can disappear at any point during convert (Her batch-deletes,
    # or rapid create+delete burst). Classify those as skip("source_gone") instead
    # of error("crashed") — the watchdog delete event will clean up the shadow.
    if not src.exists():
        record_skip(path_str, "source_gone")
        log("source_gone_pre", src=str(src))
        return False
    # Bug A: verify file content matches its extension before invoking markitdown.
    magic_err = verify_magic(src)
    if magic_err == "mime_mismatch":
        try:
            write_shadow(src, dst, f"<!-- file extension does not match content magic bytes -->",
                         "mime_mismatch", error="extension/magic mismatch")
        except FileNotFoundError:
            record_skip(path_str, "source_gone")
            log("source_gone_pre", src=str(src))
            return False
        record_error(path_str, "mime_mismatch")
        log("mime_mismatch", src=str(src), ext=_safe_ext(src))
        return False
    if magic_err == "unreadable":
        # Bug X1: distinguish "file disappeared" from "real read error".
        if not src.exists():
            record_skip(path_str, "source_gone")
            log("source_gone_pre", src=str(src))
            return False
        record_error(path_str, "unreadable")
        log("convert_unreadable", src=str(src))
        return False

    ext = _safe_ext(src)

    # Bug Q: cap zip entry count BEFORE invoking markitdown.
    if ext == "zip":
        try:
            with zipfile.ZipFile(str(src)) as zf:
                n_entries = len(zf.namelist())
        except FileNotFoundError:
            record_skip(path_str, "source_gone")
            log("source_gone_pre", src=str(src))
            return False
        except (zipfile.BadZipFile, OSError) as e:
            try:
                write_shadow(src, dst, f"<!-- zip read error -->", "failed", error=str(e)[:200])
            except FileNotFoundError:
                record_skip(path_str, "source_gone")
                log("source_gone_pre", src=str(src))
                return False
            record_error(path_str, "zip_read_error")
            log("zip_read_error", src=str(src), err=str(e)[:200])
            return False
        if n_entries > archive_max_files:
            try:
                write_shadow(src, dst,
                             f"<!-- zip has {n_entries} entries (> {archive_max_files} cap) -->",
                             "archive_too_many_files",
                             error=f"{n_entries} entries > {archive_max_files}")
            except FileNotFoundError:
                record_skip(path_str, "source_gone")
                log("source_gone_pre", src=str(src))
                return False
            record_error(path_str, "archive_too_many_files")
            log("archive_too_many_files", src=str(src), entries=n_entries, cap=archive_max_files)
            return False

    # Bug O: text-like extensions must be valid UTF-8.
    if ext in TEXT_LIKE_EXT:
        try:
            with src.open("rb") as f:
                head = f.read(64 * 1024)
        except FileNotFoundError:
            record_skip(path_str, "source_gone")
            log("source_gone_pre", src=str(src))
            return False
        except OSError as e:
            record_error(path_str, "unreadable")
            log("convert_unreadable", src=str(src), err=str(e)[:100])
            return False
        try:
            head.decode("utf-8", "strict")
        except UnicodeDecodeError as e:
            try:
                write_shadow(src, dst, f"<!-- non-UTF-8 bytes in text file -->",
                             "encoding_error", error=f"{e.reason} at byte {e.start}")
            except FileNotFoundError:
                record_skip(path_str, "source_gone")
                log("source_gone_pre", src=str(src))
                return False
            record_error(path_str, "encoding_error")
            log("encoding_error", src=str(src), reason=e.reason, pos=e.start)
            return False

    try:
        proc = subprocess.run(
            [sys.executable, "-m", "markitdown", str(src)],
            capture_output=True, timeout=timeout_sec, check=False,
        )
        if proc.returncode == 0:
            out_bytes = proc.stdout
            # Bug L: cap shadow md output size.
            if len(out_bytes) > max_output_bytes:
                try:
                    write_shadow(src, dst,
                                 f"<!-- output truncated: {len(out_bytes)} bytes > {max_output_bytes} cap -->",
                                 "output_too_large",
                                 error=f"{len(out_bytes)} bytes > {max_output_bytes}")
                except FileNotFoundError:
                    record_skip(path_str, "source_gone")
                    log("source_gone_post", src=str(src))
                    return False
                record_error(path_str, "output_too_large")
                log("output_too_large", src=str(src), bytes=len(out_bytes), cap=max_output_bytes)
                return False
            try:
                write_shadow(src, dst, out_bytes.decode("utf-8", "replace"), "ok")
            except FileNotFoundError:
                # Bug X1: source deleted between markitdown success and shadow stat.
                record_skip(path_str, "source_gone")
                log("source_gone_post", src=str(src))
                return False
            with _state_lock: _cumulative_converted += 1
            # v8.3 Bug 3: push convert_ok into recent_events + last_event so
            # Her can verify "this file converted" without polling the shadow fs.
            record_ok(path_str)
            # v7: every state-changing convert must flush health (no main-loop heartbeat).
            write_health_fast()
            log("convert_ok", src=str(src), bytes=len(out_bytes))
            return True
        # rc != 0: distinguish "real failure" from "source deleted mid-convert".
        if not src.exists():
            record_skip(path_str, "source_gone")
            log("source_gone_during", src=str(src), rc=proc.returncode)
            return False
        err = proc.stderr.decode("utf-8", "replace")[:300]
        status = "oom" if proc.returncode in (-9, 137) else "failed"
        try:
            write_shadow(src, dst, f"<!-- conversion {status} -->", status, error=f"rc={proc.returncode}")
        except FileNotFoundError:
            record_skip(path_str, "source_gone")
            log("source_gone_post", src=str(src))
            return False
        record_error(path_str, status)
        log(f"convert_{status}", src=str(src), rc=proc.returncode, err=err[:200])
    except subprocess.TimeoutExpired:
        if not src.exists():
            record_skip(path_str, "source_gone")
            log("source_gone_during", src=str(src))
            return False
        try: write_shadow(src, dst, "<!-- conversion timeout -->", "timeout", error="timeout")
        except FileNotFoundError:
            record_skip(path_str, "source_gone")
            log("source_gone_post", src=str(src))
            return False
        except Exception: pass
        record_error(path_str, "timeout")
        log("convert_timeout", src=str(src), timeout_s=timeout_sec)
    except FileNotFoundError as e:
        # Daemon-side raise during subprocess setup or write_shadow.
        record_skip(path_str, "source_gone")
        log("source_gone_during", src=str(src), err=str(e)[:100])
        return False
    except Exception as e:
        if not src.exists():
            record_skip(path_str, "source_gone")
            log("source_gone_during", src=str(src), err=str(e)[:100])
            return False
        try: write_shadow(src, dst, "<!-- conversion failed -->", "failed", error=str(e)[:200])
        except FileNotFoundError:
            record_skip(path_str, "source_gone")
            log("source_gone_post", src=str(src))
            return False
        except Exception: pass
        record_error(path_str, "crashed")
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
    Bug I fix: detect mtime OR size change so resetting mtime can't mask edits.
    v8.5 Bug L: all config reads via _cfg_int to tolerate type typos."""
    max_file_bytes = _cfg_int(config, "maxFileMB", 50) * 1024 * 1024
    extract_timeout = _cfg_int(config, "extractTimeoutSec", DEFAULT_EXTRACT_TIMEOUT_SEC)
    max_output_bytes = _cfg_int(config, "maxOutputMB", DEFAULT_MAX_OUTPUT_MB) * 1024 * 1024
    archive_max_files = _cfg_int(config, "archiveMaxFiles", DEFAULT_ARCHIVE_MAX_FILES)
    path_str = str(src.resolve())
    lock = _get_path_lock(path_str)
    with lock:
        skip = is_indexable(src, max_file_bytes)
        if skip:
            # v8.5 Bug F/K: write a tombstone shadow for skipped files too,
            # so next reconcile sees it as "already handled" and doesn't
            # rescan every cycle. SKILL.md promises every failure → tombstone.
            # Only reasons where src actually exists can get a tombstone;
            # not_exists/stat_error/outside_workspace/not_file → no source,
            # just log + skip record, no shadow.
            record_skip(path_str, skip)
            log("skip", src=path_str, reason=skip)
            if skip in ("empty", "size") and src.exists() and src.is_file():
                try:
                    sp = shadow_path_for(src)
                    write_shadow(src, sp,
                                 f"<!-- skipped: {skip} -->",
                                 status=f"skip:{skip}",
                                 error=skip)
                    note_source(path_str)  # v8.5 Bug H: tombstoned file counts
                except Exception as e:
                    log("tombstone_write_failed", src=path_str, err=str(e)[:100])
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
        return convert(src, sp, extract_timeout, max_output_bytes, archive_max_files)

def remove_shadow_for(src: Path):
    sp = shadow_path_for(src)
    if sp.exists():
        try:
            sp.unlink()
            log("shadow_removed", src=str(src), shadow=sp.name)
        except OSError as e:
            log("shadow_remove_error", src=str(src), err=str(e)[:100])
    # v8.3 Bug 13: prune stale entries so Her doesn't report ghost errors
    # for files that no longer exist.
    src_str = str(src)
    prune_recent_for_path(src_str)
    # v8.5 Bug H: forget this path so target_count drops immediately.
    forget_source(src_str)
    # v8.5 Bug J: prune per-path lock so _path_locks doesn't grow unbounded
    # under churn. Source is gone, lock is dead weight.
    with _locks_mutex:
        _path_locks.pop(str(src.resolve()), None)
    write_health_fast()

# ---- security ----
def resolve_watch_dirs(config: dict):
    # v8.5 Bug N: _cfg_dirs validates type-safety up front.
    out = []
    for entry in _cfg_dirs(config):
        raw_path = entry["path"]
        target = (WORKSPACE / raw_path).resolve()
        try:
            target.relative_to(WORKSPACE)
        except ValueError:
            log("skip_outside_workspace", path=raw_path, resolved=str(target))
            continue
        if not target.is_dir():
            log("skip_missing_dir", path=raw_path)
            continue
        out.append((raw_path, target, entry["recursive"]))
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
                    raw = Path(root) / fn
                    # Bug N: explicit skip + record for symlinks (don't follow).
                    if raw.is_symlink():
                        record_skip(str(raw), "symlink")
                        log("skip", src=str(raw), reason="symlink")
                        continue
                    p = raw.resolve()
                    seen_sources.add(str(p))
                    sp = shadow_path_for(p)
                    if sp.exists() and _is_fresh(p, sp):
                        continue
                    fut = _executor.submit(maybe_convert, p, config)
                    submitted += 1
                    if blocking: futures.append(fut)
        else:
            for raw in target.iterdir():
                if raw.is_dir() or raw.name.startswith("."): continue
                if raw.is_symlink():
                    record_skip(str(raw), "symlink")
                    log("skip", src=str(raw), reason="symlink")
                    continue
                p = raw.resolve()
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
    # v8.3 Bug 2 + v8.5 Bug H: sync the authoritative source-set with what
    # initial_sync observed. `_known_sources` is the single source of truth
    # for target_count; replace it atomically with this snapshot.
    global _target_count
    with _state_lock:
        new_target = len(seen_sources)
        should_flush = new_target != _target_count or _known_sources != seen_sources
        _known_sources.clear()
        _known_sources.update(seen_sources)
        _target_count = new_target
    log("sync_done", originals=new_target, submitted=submitted,
        converted=converted, deleted=deleted, blocking=blocking,
        elapsed_sec=round(time.monotonic() - started, 2))
    if should_flush:
        write_health_fast()
    return submitted, deleted

# ---- debounced event submission ----
def _schedule_convert(src: Path, config: dict):
    """Per-path debounce: cancel pending timer, start new one. Last burst wins."""
    global _last_event_at
    path_str = str(src)
    debounce_sec = _cfg_int(config, "debounceMs", DEFAULT_DEBOUNCE_MS) / 1000.0
    with _locks_mutex:
        old = _debounce_timers.pop(path_str, None)
        if old:
            old.cancel()
        def _fire():
            with _locks_mutex:
                _debounce_timers.pop(path_str, None)
            raw = Path(path_str)
            # Bug N: detect symlink BEFORE resolve() (which would silently follow it).
            try:
                if raw.is_symlink():
                    record_skip(str(raw), "symlink")
                    log("skip", src=str(raw), reason="symlink")
                    return
            except OSError:
                return
            try:
                p = raw.resolve()
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
            "reconcileIntervalSec", "maxOutputMB", "archiveMaxFiles")
    return any(old.get(k) != new.get(k) for k in keys)

# ---- main loop ----
# v7 (2026-04-27): pure event-driven, Her-triggered. No 5s polling, no per-cycle
# subprocess fork. Daemon idle CPU = 0%.
#
# Trigger sources:
#   - SIGUSR1 → re-init (Her sends after pip install/uninstall, or 'reload now')
#   - SIGTERM/SIGINT → graceful shutdown
#   - meta-watchdog event on _config.json (create/modify/delete) → re-init
#   - meta-watchdog event on PYTHONUSERBASE/site-packages (markitdown/watchdog
#     dirs appear/disappear) → re-init
#
# Boot-time fork cost: 2 subprocess imports (markitdown + watchdog) ONCE.
# Steady-state fork cost: 0 (until next trigger).

_reinit_event = threading.Event()
_shutdown_event = threading.Event()
_meta_observer = None

def _request_reinit(reason: str):
    log("reinit_requested", reason=reason)
    _reinit_event.set()

def _meta_handler_factory():
    """Watchdog handler for the daemon's own meta-events: _config.json and
    PYTHONUSERBASE site-packages changes. Any event => request re-init."""
    from watchdog.events import FileSystemEventHandler
    config_name = CONFIG_FILE.name
    site_pkgs_marker = "site-packages"

    class MetaHandler(FileSystemEventHandler):
        def _maybe(self, evt, why):
            path = getattr(evt, "src_path", "") or ""
            if config_name in os.path.basename(path):
                _request_reinit(f"config_{why}")
                return
            if site_pkgs_marker in path:
                _request_reinit(f"site_packages_{why}")

        def on_created(self, e):  self._maybe(e, "created")
        def on_modified(self, e): self._maybe(e, "modified")
        def on_deleted(self, e):  self._maybe(e, "deleted")
        def on_moved(self, e):    self._maybe(e, "moved")
    return MetaHandler()

def _find_watchable_ancestor(target: Path) -> Path:
    """Walk up from `target` until we find a directory that currently exists.
    Guaranteed to return SOMETHING (worst case: /). Used so meta-watchdog can
    attach to a stable parent that won't disappear under rm -rf of the target
    itself, and will still catch child-creation events (pip install creating
    user_lib for the first time)."""
    p = target
    while not p.exists() and p != p.parent:
        p = p.parent
    return p

def _start_meta_observer() -> Optional[object]:
    """Watch SHADOW_DIR (for _config.json events) and the deepest existing
    ancestor of user-site (~/.local by default, or PYTHONUSERBASE if set).
    Watching the ancestor — NOT the target — is critical: if the target is
    the watch root and gets rm -rf'd, inotify removes the watch and we go
    blind to future mkdir. By pinning on a stable ancestor with recursive=
    True, we see all create/delete events underneath, including the target
    being (re)created from scratch.

    The handler filters events via path substring so we only react to:
    - SHADOW_DIR/_config.json events
    - <anything>/site-packages/** events (pip install/uninstall)
    Unrelated events under the ancestor are ignored.

    Returns the observer or None if watchdog not importable."""
    try:
        from watchdog.observers import Observer
    except ImportError:
        return None
    obs = Observer()
    handler = _meta_handler_factory()
    # _config.json lives in SHADOW_DIR, watch the dir non-recursively.
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    obs.schedule(handler, str(SHADOW_DIR), recursive=False)
    log("meta_observer_watching", path=str(SHADOW_DIR))
    # User-site root resolution: same rules as Python's site.py:
    #   USER_BASE = PYTHONUSERBASE env or platform default (~/.local).
    user_base_env = os.environ.get("PYTHONUSERBASE", "").strip()
    if user_base_env:
        user_base = Path(user_base_env)
    else:
        user_base = Path.home() / ".local"
    # Watch the deepest existing ancestor, not the (possibly-absent or
    # about-to-be-deleted) target. If user_base exists we watch it; if it
    # doesn't exist yet, we walk up to find the first dir that does.
    watch_root = _find_watchable_ancestor(user_base)
    try:
        obs.schedule(handler, str(watch_root), recursive=True)
        log("meta_observer_watching",
            path=str(watch_root), user_base=str(user_base))
    except OSError as e:
        log("meta_observer_userlib_skipped", err=str(e)[:100])
    obs.daemon = True
    obs.start()
    return obs

def _reconcile_loop(stop_event: threading.Event, interval: int):
    """v8.6 Bug B3: periodic safety-net rescan to catch lost watchdog events
    (burst overflow, macOS fsevents coalescing, rm -rf races). Runs in a
    daemon thread. initial_sync() is idempotent — fresh shadows are skipped
    by mtime/size check, so repeated calls are cheap under steady state."""
    while not stop_event.wait(timeout=interval):
        if _shutdown_event.is_set(): return
        cfg = _current_config
        if cfg is None: continue  # config dropped; wait for next reinit
        try:
            initial_sync(cfg)
        except Exception as e:
            log("reconcile_crashed", err=str(e)[:200])


def _stop_reconcile_thread():
    """Stop and join the periodic reconcile thread if running. Called from
    reinit (teardown) and main shutdown."""
    global _reconcile_stop, _reconcile_thread
    if _reconcile_stop:
        _reconcile_stop.set()
    if _reconcile_thread and _reconcile_thread.is_alive():
        _reconcile_thread.join(timeout=3)
    _reconcile_stop = None
    _reconcile_thread = None


def _do_reinit():
    """Tear down current observer/executor and rebuild from current state.
    Pure side-effect function, called only from main thread."""
    global _current_config, _current_observer, _executor
    global _reconcile_stop, _reconcile_thread
    # 1. tear down work observer + executor (meta observer stays up).
    if _current_observer:
        stop_observer(_current_observer); _current_observer = None
    # v8.6 Bug B6: don't block on in-flight converts. A 600s PDF mid-flight
    # would stall SIGUSR1 reinit for 10 minutes. Drop queued futures, let
    # running threads finish in background — new executor's workers can't
    # trample them because maybe_convert() serializes per-path via _path_locks.
    if _executor:
        _executor.shutdown(wait=False, cancel_futures=True); _executor = None
    # v8.6 Bug B3: stop old reconcile thread before rebuilding so a config
    # change to reconcileIntervalSec takes effect on the new thread.
    _stop_reconcile_thread()
    _current_config = None

    # v7.1: refresh sys.path with USER_SITE in case it was missing at startup.
    # Python's site.py only adds USER_SITE to sys.path if the dir EXISTS at
    # interpreter start. If markitdown/watchdog get installed AFTER daemon
    # started (Her does pip install --user post-boot), sys.path doesn't pick
    # them up and `import watchdog` fails inside the daemon process despite
    # the subprocess fork seeing them. Manually injecting USER_SITE here
    # makes SIGUSR1 enough — no need to restart the daemon process.
    try:
        import site as _site
        user_site = _site.getusersitepackages()
        if user_site and os.path.isdir(user_site) and user_site not in sys.path:
            sys.path.insert(0, user_site)
            log("sys_path_refreshed", added=user_site)
    except Exception as e:
        log("sys_path_refresh_failed", err=str(e)[:200])

    # 2. probe deps (this is the only place we fork; once per reinit, not 5s).
    _refresh_deps_cache()
    if not _cached_wd_avail:
        write_health_fast("idle_no_watchdog")
        return
    if not _cached_mt_avail:
        write_health_fast("idle_no_markitdown")
        return

    # 3. probe config.
    new_config = load_config()
    if new_config is None:
        write_health_fast("idle_no_config")
        return

    # 4. spin up executor + observer for actual work.
    _current_config = new_config
    max_workers = max(1, _cfg_int(new_config, "maxWorkers", DEFAULT_MAX_WORKERS))
    _executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="shadow-worker")
    log("executor_started", max_workers=max_workers)
    initial_sync(new_config)  # blocking catch-up
    _current_observer = start_observer(new_config)
    if _current_observer is None:
        write_health_fast("idle_no_valid_dirs")
        return
    # v8.6 Bug B3: start periodic reconcile safety-net. min=1s so a tiny
    # reconcileIntervalSec doesn't spin-loop; 60s is the default.
    interval = _cfg_int(new_config, "reconcileIntervalSec", DEFAULT_RECONCILE_SEC)
    _reconcile_stop = threading.Event()
    _reconcile_thread = threading.Thread(
        target=_reconcile_loop, args=(_reconcile_stop, interval),
        daemon=True, name="shadow-reconcile")
    _reconcile_thread.start()
    log("reconcile_thread_started", interval_sec=interval)
    write_health_fast("watching")

def main():
    global _meta_observer
    log("daemon_start", workspace=str(WORKSPACE), shadow_dir=str(SHADOW_DIR), version="v8.5")
    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    # v8.5 Bug M: sweep any stale *.tmp files left over from a crash
    # between write_text and os.replace in a previous daemon lifetime.
    try:
        stale_tmps = list(SHADOW_DIR.glob("*.tmp"))
        for p in stale_tmps:
            try: p.unlink()
            except OSError: pass
        if stale_tmps:
            log("stale_tmp_cleaned", count=len(stale_tmps))
    except OSError as e:
        log("stale_tmp_scan_error", err=str(e)[:100])
    load_persistent_counters()  # Bug J: carry cumulative across restarts

    def _term(signum, _frame):
        log("daemon_stopping", signal=signum); _shutdown_event.set(); _reinit_event.set()
    def _usr1(_signum, _frame):
        log("sigusr1_received"); _request_reinit("sigusr1")
    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)
    signal.signal(signal.SIGUSR1, _usr1)

    # Meta observer: needs watchdog itself. If watchdog is not yet installed
    # (chicken-and-egg), we fall back to a slow bootstrap poller that fires
    # a subprocess `import watchdog` check every 10s. Once watchdog is there,
    # the poller asks main for reinit and main promotes to the meta-observer.
    _meta_observer = _start_meta_observer()
    _bootstrap_stop = threading.Event()
    _bootstrap_thread = None
    if _meta_observer is None:
        log("meta_observer_unavailable",
            note="watchdog not installed; bootstrap polling every 10s until it is")
        def _bootstrap_poll():
            # Slow poll (10s) while watchdog can't be imported. Each tick
            # forks one subprocess; negligible cost. Stops as soon as we
            # can import watchdog, which promotes to the real event loop.
            while not _bootstrap_stop.is_set() and not _shutdown_event.is_set():
                if _bootstrap_stop.wait(timeout=10):
                    return
                try:
                    subprocess.run([sys.executable, "-c", "import watchdog"],
                                   check=True, capture_output=True, timeout=10)
                    log("bootstrap_poll_saw_watchdog",
                        note="requesting main-loop reinit")
                    _request_reinit("bootstrap_deps_appeared")
                    return
                except (subprocess.CalledProcessError,
                        subprocess.TimeoutExpired, OSError):
                    continue
        _bootstrap_thread = threading.Thread(target=_bootstrap_poll, daemon=True)
        _bootstrap_thread.start()

    # First reinit: get into desired state immediately (don't wait for trigger).
    _request_reinit("startup")

    while not _shutdown_event.is_set():
        # Block until something asks for re-init or shutdown. No polling.
        _reinit_event.wait()
        if _shutdown_event.is_set(): break
        _reinit_event.clear()
        # Coalesce: if more events arrived during reinit, the next loop picks them up.
        try:
            _do_reinit()
        except Exception as e:
            log("reinit_crashed", err=str(e)[:200])
            # Don't loop tight on a recurring crash — drop into idle.
            try: write_health_fast("reinit_error")
            except Exception: pass

        # If watchdog became importable (first install), promote to real
        # meta-observer and stop the bootstrap poller.
        if _meta_observer is None and _cached_wd_avail:
            _meta_observer = _start_meta_observer()
            if _meta_observer is not None:
                _bootstrap_stop.set()  # poller will exit next tick
                log("meta_observer_promoted",
                    note="watchdog became available")

    # Shutdown.
    _bootstrap_stop.set()
    if _bootstrap_thread and _bootstrap_thread.is_alive():
        _bootstrap_thread.join(timeout=2)
    _stop_reconcile_thread()  # v8.6 Bug B3
    if _current_observer: stop_observer(_current_observer)
    if _meta_observer: stop_observer(_meta_observer)
    if _executor: _executor.shutdown(wait=False, cancel_futures=True)
    write_health_fast("stopped")
    log("daemon_stopped")

if __name__ == "__main__":
    main()
