"""shadow-daemon v8.2 test suite — colocated with the daemon, no /tmp copies.

Run from repo root:
  PYTHONPATH=docker/plugins/shadow-daemon/tests/pypath \
      pytest docker/plugins/shadow-daemon/tests/test_shadow_daemon.py -v

Or cd into tests/:
  cd docker/plugins/shadow-daemon/tests && PYTHONPATH=pypath pytest test_shadow_daemon.py -v

The daemon under test is the SAME file that gets shipped in the docker image:
  docker/plugins/shadow-daemon/daemon/shadow_daemon.py

No duplicate copies, ever.
"""
from __future__ import annotations
import json, os, shutil, signal, subprocess, sys, tempfile, time
from pathlib import Path
from typing import Optional
import pytest

TESTS_DIR = Path(__file__).parent.resolve()
PLUGIN_DIR = TESTS_DIR.parent
DAEMON_PATH = str(PLUGIN_DIR / "daemon" / "shadow_daemon.py")
MOCK_MARKITDOWN_PATH = str(TESTS_DIR / "pypath")


# ---------------------------------------------------------------- fixtures
@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    ws = tmp_path / "workspace"
    docs = ws / "docs"
    shadow = ws / "memory" / "_shadow"
    docs.mkdir(parents=True)
    shadow.mkdir(parents=True)
    monkeypatch.setenv("SHADOW_WORKSPACE", str(ws))
    monkeypatch.setenv("SHADOW_DIR", str(shadow))
    return {"workspace": ws, "docs": docs, "shadow": shadow}


# ---------------------------------------------------------------- helpers
def write_config(shadow: Path, directories=None, **kwargs):
    cfg = {
        "version": 1,
        "directories": directories or [{"path": "docs", "recursive": True}],
        "maxFileMB": 50,
        "extractTimeoutSec": 30,
        "debounceMs": 200,
        "maxWorkers": 8,
        "reconcileIntervalSec": 5,
        **kwargs,
    }
    (shadow / "_config.json").write_text(json.dumps(cfg))


def start_daemon(env_extra=None, log_file=None):
    env = os.environ.copy()
    env["PYTHONPATH"] = MOCK_MARKITDOWN_PATH
    env["PYTHONUNBUFFERED"] = "1"
    if env_extra:
        env.update(env_extra)
    if log_file is None:
        log_file = tempfile.NamedTemporaryFile(mode="w+b", prefix="shadow-stderr-", delete=False)
    p = subprocess.Popen(
        [sys.executable, DAEMON_PATH],
        env=env, stdout=subprocess.DEVNULL, stderr=log_file,
    )
    p._stderr_file = log_file
    return p


def stop_daemon(proc, timeout=5):
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try: proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait()
    err = ""
    lf = getattr(proc, "_stderr_file", None)
    if lf is not None:
        try:
            lf.flush(); lf.seek(0)
            err = lf.read().decode("utf-8", "replace")
            lf.close()
        except Exception: pass
    return "", err


def _internal(h: dict) -> dict:
    """Get `_internal` sub-object (v8.4) with flat-layout fallback."""
    return (h.get("_internal") or h) if h else {}


def wait_for_health_status(shadow: Path, status: str, timeout=15):
    deadline = time.monotonic() + timeout
    last = None
    hf = shadow / "_health.json"
    while time.monotonic() < deadline:
        if hf.exists():
            try:
                last = json.loads(hf.read_text())
                if _internal(last).get("status") == status:
                    return last
            except json.JSONDecodeError: pass
        time.sleep(0.1)
    raise TimeoutError(f"status never reached {status!r}; last={last}")


def wait_for_ready(shadow: Path, timeout=15):
    deadline = time.monotonic() + timeout
    last = None
    hf = shadow / "_health.json"
    while time.monotonic() < deadline:
        if hf.exists():
            try:
                last = json.loads(hf.read_text())
                if last.get("ready") is True:
                    return last
            except json.JSONDecodeError: pass
        time.sleep(0.1)
    raise TimeoutError(f"ready never turned true; last={last}")


def wait_for_shadow(shadow: Path, src_path: Path, timeout=10):
    import hashlib
    sha = hashlib.sha256(str(src_path.resolve()).encode()).hexdigest()[:8]
    prefix = f"{sha}__"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for sp in shadow.glob(f"{prefix}*.md"):
            if sp.name.startswith("_"): continue
            return sp
        time.sleep(0.05)
    raise TimeoutError(f"shadow for {src_path} never created (expected prefix {prefix})")


def read_health(shadow: Path) -> dict:
    try:
        return json.loads((shadow / "_health.json").read_text())
    except Exception:
        return {}


def count_shadow(shadow: Path) -> int:
    """Count live shadow .md files (excluding _ prefixed like _health/_config)."""
    return len([p for p in shadow.glob("*.md") if not p.name.startswith("_")])


def read_last_run(shadow: Path):
    return _internal(read_health(shadow)).get("last_run")


def wait_last_run_advances(shadow: Path, prior, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        cur = read_last_run(shadow)
        if cur and cur != prior:
            return cur
        time.sleep(0.1)
    return None


def setup_fake_userbase(user_base: Path) -> Path:
    """Build a fake PYTHONUSERBASE that contains a real importable `watchdog`
    (symlinked from host), so daemon's subprocess-based `check_watchdog` sees
    it when PYTHONUSERBASE=user_base. Returns user_base/lib."""
    import watchdog as _wd
    real_wd = Path(_wd.__file__).parent
    # Ask the exact interpreter we spawn daemon with where user-site is,
    # given our fake PYTHONUSERBASE. Authoritative across macOS/Linux.
    out = subprocess.check_output(
        [sys.executable, "-c", "import site;print(site.getusersitepackages())"],
        env={**os.environ, "PYTHONUSERBASE": str(user_base)},
        text=True,
    ).strip()
    site_pkgs = Path(out)
    site_pkgs.mkdir(parents=True, exist_ok=True)
    link = site_pkgs / "watchdog"
    if not link.exists():
        link.symlink_to(real_wd)
    return user_base / "lib"


# ==================================================================
# Basic: daemon can actually convert files
# ==================================================================

def test_basic_create_and_convert(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        f = sandbox["docs"] / "hello.txt"
        f.write_text("hello world")
        sp = wait_for_shadow(sandbox["shadow"], f, timeout=10)
        assert "hello world" in sp.read_text()
    finally:
        stop_daemon(proc)


def test_basic_delete_cleans_shadow(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        f = sandbox["docs"] / "tmp.txt"
        f.write_text("x")
        wait_for_shadow(sandbox["shadow"], f, timeout=10)
        f.unlink()
        import hashlib
        sha = hashlib.sha256(str(f.resolve()).encode()).hexdigest()[:8]
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if not list(sandbox["shadow"].glob(f"{sha}__*")):
                return
            time.sleep(0.1)
        pytest.fail("shadow not GC'd after source delete")
    finally:
        stop_daemon(proc)


# ==================================================================
# Product API contract (health.json fields)
# ==================================================================

def test_product_health_shape(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        h = wait_for_ready(sandbox["shadow"], timeout=15)
        for k in ("ready", "needs", "progress", "watching_dirs", "last_event_at"):
            assert k in h, f"missing product field: {k}. health={h}"
        assert isinstance(h["ready"], bool)
        assert h["needs"] is None or isinstance(h["needs"], str)
        assert isinstance(h["progress"], dict)
        assert "indexed_total" in h["progress"]
        assert "errors_recent" in h["progress"]
        assert isinstance(h["watching_dirs"], list)
    finally:
        stop_daemon(proc)


def test_no_config_ready_false_needs_config(sandbox):
    proc = start_daemon()
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            h = read_health(sandbox["shadow"])
            if h.get("ready") is False and h.get("needs") == "config":
                return
            time.sleep(0.2)
        pytest.fail(f"no-config not reported correctly; last={read_health(sandbox['shadow'])}")
    finally:
        stop_daemon(proc)


def test_config_appears_then_ready(sandbox):
    proc = start_daemon()
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if read_health(sandbox["shadow"]).get("needs") == "config":
                break
            time.sleep(0.2)
        write_config(sandbox["shadow"])
        wait_for_ready(sandbox["shadow"], timeout=15)
    finally:
        stop_daemon(proc)


# ==================================================================
# Fix 1 — meta-watchdog watches ancestor, not user_lib itself.
# These tests enumerate the full lifecycle of the user-site dir:
# absent-at-boot / delete-mid-life / recreate-after-delete.
# ==================================================================

def test_userlib_delete_triggers_reinit(sandbox, tmp_path, monkeypatch):
    """rm -rf user_lib MUST fire a reinit (daemon must see deps vanished)."""
    user_base = tmp_path / "ub_delete"
    user_lib = setup_fake_userbase(user_base)
    monkeypatch.setenv("PYTHONUSERBASE", str(user_base))
    write_config(sandbox["shadow"])
    proc = start_daemon(env_extra={"PYTHONUSERBASE": str(user_base)})
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        t0 = read_last_run(sandbox["shadow"])
        shutil.rmtree(user_lib)
        t1 = wait_last_run_advances(sandbox["shadow"], t0, timeout=12)
        assert t1 is not None, (
            f"Fix 1 broken: user_lib rm did not trigger reinit. last_run stuck at {t0}. "
            f"meta-watchdog must watch a stable ANCESTOR, not user_lib itself."
        )
    finally:
        stop_daemon(proc)


def test_userlib_recreate_after_delete_triggers_reinit(sandbox, tmp_path, monkeypatch):
    """After delete → re-create, daemon must see the re-creation."""
    user_base = tmp_path / "ub_recreate"
    user_lib = setup_fake_userbase(user_base)
    monkeypatch.setenv("PYTHONUSERBASE", str(user_base))
    write_config(sandbox["shadow"])
    proc = start_daemon(env_extra={"PYTHONUSERBASE": str(user_base)})
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        shutil.rmtree(user_lib)
        time.sleep(2)
        t_before = read_last_run(sandbox["shadow"])
        setup_fake_userbase(user_base)
        t_after = wait_last_run_advances(sandbox["shadow"], t_before, timeout=15)
        assert t_after is not None, (
            f"Fix 1 broken: user_lib re-creation not detected. last_run stuck at {t_before}. "
            f"The watch was permanently lost because it was attached to user_lib itself."
        )
    finally:
        stop_daemon(proc)


# ==================================================================
# Fix 2 — bootstrap polling when watchdog itself isn't installed yet.
# ==================================================================

def test_userlib_absent_at_boot_then_created(sandbox, tmp_path, monkeypatch):
    """watchdog not installed → meta-observer can't start → bootstrap poller
    must detect the first install and trigger reinit."""
    user_base = tmp_path / "ub_fresh"
    # user_base intentionally DOESN'T exist before daemon starts.
    monkeypatch.setenv("PYTHONUSERBASE", str(user_base))
    write_config(sandbox["shadow"])
    proc = start_daemon(env_extra={"PYTHONUSERBASE": str(user_base)})
    try:
        # Wait for daemon to be up (will be idle_no_watchdog since deps absent).
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if (sandbox["shadow"] / "_health.json").exists():
                break
            time.sleep(0.1)
        t0 = read_last_run(sandbox["shadow"])
        assert t0 is not None, "daemon never wrote _health.json"

        setup_fake_userbase(user_base)
        # Bootstrap poller ticks every 10s; allow 25s.
        t1 = wait_last_run_advances(sandbox["shadow"], t0, timeout=25)
        assert t1 is not None, (
            f"Fix 2 broken: bootstrap poller did not detect first deps install. "
            f"last_run stuck at {t0}."
        )

        # And after reinit, daemon should now see watchdog and watch files.
        h = read_health(sandbox["shadow"])
        assert _internal(h).get("watchdog_available") is True, (
            f"After deps install, watchdog still not detected: {h}"
        )
    finally:
        stop_daemon(proc)


# ==================================================================
# Robustness: signals, config churn
# ==================================================================

def test_sigusr1_forces_reinit(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        t0 = read_last_run(sandbox["shadow"])
        time.sleep(0.5)
        proc.send_signal(signal.SIGUSR1)
        t1 = wait_last_run_advances(sandbox["shadow"], t0, timeout=10)
        assert t1 is not None, "SIGUSR1 did not trigger reinit"
    finally:
        stop_daemon(proc)


def test_sigusr1_burst_no_crash(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        for _ in range(50):
            proc.send_signal(signal.SIGUSR1)
        time.sleep(3)
        assert proc.poll() is None, "daemon crashed under SIGUSR1 burst"
        assert _internal(read_health(sandbox["shadow"])).get("status") == "watching"
    finally:
        stop_daemon(proc)


def test_config_deletion_drops_to_idle(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        (sandbox["shadow"] / "_config.json").unlink()
        wait_for_health_status(sandbox["shadow"], "idle_no_config", timeout=15)
    finally:
        stop_daemon(proc)


def test_sigterm_clean_shutdown(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        proc.send_signal(signal.SIGTERM)
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if proc.poll() is not None: break
            time.sleep(0.1)
        assert proc.poll() is not None, "daemon didn't exit after SIGTERM"
        h = read_health(sandbox["shadow"])
        assert _internal(h).get("status") == "stopped"
    finally:
        if proc.poll() is None:
            proc.kill()


# ==================================================================
# Stress: 200-file burst, ready stays true
# ==================================================================

def test_stress_200_files_ready_stable(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        for i in range(200):
            (sandbox["docs"] / f"s_{i:03}.txt").write_text(f"n={i}")
        start = time.monotonic()
        # Ready must not flip false while daemon crunches the burst.
        while time.monotonic() - start < 15:
            h = read_health(sandbox["shadow"])
            if h:  # health was written
                assert h.get("ready") is True, f"ready flipped false mid-burst: {h}"
            time.sleep(0.3)
    finally:
        stop_daemon(proc)


# ==================================================================
# No-polling proof: in steady state without events, last_run shouldn't
# advance (event-driven, not timer-driven).
# ==================================================================

def test_no_polling_in_steady_state(sandbox):
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        h0 = wait_for_health_status(sandbox["shadow"], "watching", timeout=15)
        baseline_last_run = h0.get("last_run")
        time.sleep(8)
        h1 = read_health(sandbox["shadow"])
        assert h1.get("last_run") == baseline_last_run, (
            f"event-driven promise broken: last_run advanced without any event "
            f"({baseline_last_run!r} → {h1.get('last_run')!r})"
        )
    finally:
        stop_daemon(proc)


# ============================================================
# v8.3 — SKILL schema alignment (Her 压测 2026-04-28 发现 14 bug)
# ============================================================

def test_health_has_last_event_field(sandbox):
    """Bug 1: SKILL 承诺 `last_event` 字段(人话格式如 'convert_ok docs/foo.pdf'),
    daemon 必须 emit。不是 last_event_at(那是时间戳)。"""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        f = sandbox["docs"] / "evt.txt"
        f.write_text("hello")
        wait_for_shadow(sandbox["shadow"], f, timeout=10)
        time.sleep(0.8)  # let daemon persist last_event
        h = read_health(sandbox["shadow"])
        assert "last_event" in h, f"Bug 1: `last_event` missing from health.json: keys={list(h.keys())}"
        assert isinstance(h["last_event"], (str, type(None))), (
            f"Bug 1: `last_event` must be str or None, got {type(h['last_event'])}"
        )
        if h["last_event"]:
            assert "convert_ok" in h["last_event"] or "convert" in h["last_event"], (
                f"Bug 1: `last_event` should be human-readable event summary, got {h['last_event']!r}"
            )
    finally:
        stop_daemon(proc)


def test_progress_has_target_count_and_pct(sandbox):
    """Bug 2: SKILL 需要 `progress.target_count` 和 `progress.pct` 给用户报
    '已转 5/17 (29%)'。 daemon 必须提供。"""
    write_config(sandbox["shadow"])
    # Drop 10 files BEFORE daemon boots so initial_sync sees them
    for i in range(10):
        (sandbox["docs"] / f"p_{i:02}.txt").write_text(f"p={i}")
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=20)
        time.sleep(2)  # let initial_sync finish
        h = read_health(sandbox["shadow"])
        p = h.get("progress") or {}
        assert "target_count" in p, f"Bug 2: progress missing `target_count`: {p}"
        assert "pct" in p, f"Bug 2: progress missing `pct`: {p}"
        assert p["target_count"] >= 10, (
            f"Bug 2: target_count must count source files, got {p.get('target_count')} < 10"
        )
        assert isinstance(p["pct"], (int, float)), (
            f"Bug 2: pct must be number, got {type(p['pct'])}"
        )
        assert 0 <= p["pct"] <= 100, f"Bug 2: pct must be 0-100, got {p['pct']}"
    finally:
        stop_daemon(proc)


def test_progress_has_indexed_now(sandbox):
    """Bug 12: `indexed_total` is cumulative, misleads when files deleted.
    Daemon must add `indexed_now` = count of LIVE shadow .md files right now."""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        for i in range(5):
            (sandbox["docs"] / f"n_{i}.txt").write_text("x")
        # Wait for all 5 to convert
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if count_shadow(sandbox["shadow"]) >= 5: break
            time.sleep(0.2)
        time.sleep(0.5)
        h = read_health(sandbox["shadow"])
        p = h["progress"]
        assert "indexed_now" in p, f"Bug 12: progress missing `indexed_now`: {p}"
        assert p["indexed_now"] >= 5, f"Bug 12: indexed_now should be ~5, got {p['indexed_now']}"
        # Now delete 3 and assert indexed_now drops
        for i in range(3):
            (sandbox["docs"] / f"n_{i}.txt").unlink()
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if count_shadow(sandbox["shadow"]) <= 2: break
            time.sleep(0.2)
        time.sleep(0.5)
        h = read_health(sandbox["shadow"])
        p = h["progress"]
        assert p["indexed_now"] <= 2, (
            f"Bug 12: after 3 deletes, indexed_now should drop, got {p['indexed_now']}. "
            f"This is the key diff vs cumulative indexed_total."
        )
        # cumulative MUST stay non-decreasing (that's its job)
        cum = _internal(h).get("cumulative_converted", 0)
        assert cum >= 5, f"cumulative_converted regressed to {cum}"
    finally:
        stop_daemon(proc)


def test_recent_events_contains_convert_ok(sandbox):
    """Bug 3: SKILL's index-document.md reads `recent_events` to check if a
    specific file got convert_ok. Daemon must emit this buffer."""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        f = sandbox["docs"] / "evt-sample.txt"
        f.write_text("body")
        wait_for_shadow(sandbox["shadow"], f, timeout=10)
        time.sleep(0.8)
        h = read_health(sandbox["shadow"])
        assert "recent_events" in h, f"Bug 3: `recent_events` missing. keys={list(h.keys())}"
        events = h["recent_events"]
        assert isinstance(events, list), f"Bug 3: recent_events must be list, got {type(events)}"
        hit = [e for e in events if "evt-sample" in str(e.get("path", ""))]
        assert hit, (
            f"Bug 3: recent_events should contain convert_ok for the file just converted. "
            f"events={events[:5]}"
        )
        assert hit[0].get("kind") == "convert_ok", (
            f"Bug 3: event kind should be 'convert_ok' for happy path, got {hit[0]}"
        )
    finally:
        stop_daemon(proc)


def test_recent_errors_prunes_on_source_delete(sandbox):
    """Bug 13: when a source file that had an error is deleted, its entry in
    recent_errors should be pruned — otherwise Her reports non-existent errors."""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        # Create a file that will produce an error: .txt with non-utf8 bytes
        # (triggers encoding_error, which is a real `record_error` path).
        f = sandbox["docs"] / "bad.txt"
        f.write_bytes(b"hello \xff\xfe\x80 invalid utf-8")
        # Wait until daemon records it in errors.
        deadline = time.monotonic() + 10
        matched = False
        while time.monotonic() < deadline:
            h = read_health(sandbox["shadow"])
            if any("bad.txt" in str(e.get("path", "")) for e in h.get("recent_errors", [])):
                matched = True
                break
            time.sleep(0.2)
        assert matched, "recent_errors should contain bad.txt entry first"
        # Now delete the file.
        f.unlink()
        time.sleep(2)
        h = read_health(sandbox["shadow"])
        residual = [e for e in h.get("recent_errors", []) if "bad.txt" in str(e.get("path", ""))]
        assert not residual, (
            f"Bug 13: after source delete, recent_errors should be pruned. "
            f"still contains: {residual}"
        )
    finally:
        stop_daemon(proc)


def test_limits_field_exposes_caps(sandbox):
    """Bug 6: supported-formats.md hard-codes 20 files / 5MB output. Daemon
    must expose these under `limits:{}` so SKILL can read, not hardcode."""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        h = read_health(sandbox["shadow"])
        lim = h.get("limits") or {}
        assert "archive_max_files" in lim, (
            f"Bug 6: limits.archive_max_files missing. keys={list(lim.keys())}"
        )
        assert "max_output_mb" in lim, (
            f"Bug 6: limits.max_output_mb missing. keys={list(lim.keys())}"
        )
        assert "max_file_mb" in lim, (
            f"Bug 6: limits.max_file_mb missing. keys={list(lim.keys())}"
        )
        assert lim["archive_max_files"] > 0
        assert lim["max_output_mb"] > 0
    finally:
        stop_daemon(proc)


# ============================================================
# v8.4 — Her-found follow-up: last_event_at, cumulative isolation, field cleanup
# ============================================================

def test_last_event_at_updates_with_last_event(sandbox):
    """Bug A: `last_event_at` was null even after events fired. Must be set
    whenever `last_event` is set, so Her can compute 'N minutes ago'."""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        f = sandbox["docs"] / "when.txt"
        f.write_text("x")
        wait_for_shadow(sandbox["shadow"], f, timeout=10)
        time.sleep(0.8)
        h = read_health(sandbox["shadow"])
        assert h.get("last_event"), f"precondition: last_event not set. h={h}"
        assert h.get("last_event_at") is not None, (
            f"Bug A: last_event is {h['last_event']!r} but last_event_at is null. "
            f"Her needs the timestamp to say 'N minutes ago'."
        )
        # And it must be a valid ISO timestamp.
        from datetime import datetime
        datetime.fromisoformat(h["last_event_at"].replace("Z", "+00:00"))
    finally:
        stop_daemon(proc)


def test_cumulative_fields_not_in_top_level(sandbox):
    """Bug B: `cumulative_converted/skipped/errors` at top level is too easy
    for Her to accidentally surface. They must live under `_internal:` so
    they're structurally hidden per SKILL contract."""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        h = read_health(sandbox["shadow"])
        for forbidden in ("cumulative_converted", "cumulative_skipped", "cumulative_errors"):
            assert forbidden not in h, (
                f"Bug B: `{forbidden}` still at top-level; must be inside `_internal:`. "
                f"SKILL bans Her from exposing it — structural isolation prevents accidents."
            )
        internal = h.get("_internal") or {}
        for needed in ("cumulative_converted", "cumulative_skipped", "cumulative_errors"):
            assert needed in internal, (
                f"Bug B: `_internal.{needed}` missing. Ops needs these for debug. "
                f"Hidden from Her but still written for observability."
            )
    finally:
        stop_daemon(proc)


def test_no_duplicate_limit_fields_top_level(sandbox):
    """Bug C: `extract_timeout_sec` / `max_output_mb` / `archive_max_files`
    appear in both top-level AND `limits:{}`. Top-level copies are drift-
    bait; delete them. Other runtime info (config_dirs / watching /
    max_workers / debounce_ms) moves to `_internal` so top-level stays a
    clean product contract."""
    write_config(sandbox["shadow"])
    proc = start_daemon()
    try:
        wait_for_ready(sandbox["shadow"], timeout=15)
        h = read_health(sandbox["shadow"])
        duplicate_with_limits = ("extract_timeout_sec", "max_output_mb", "archive_max_files")
        for k in duplicate_with_limits:
            assert k not in h, (
                f"Bug C: `{k}` at top-level is a duplicate of `limits.{k}`. "
                f"Delete top-level; SKILL should read `limits.{k}`."
            )
        # And runtime info fields move under _internal.
        runtime_info_keys = ("config_dirs", "watching", "max_workers", "debounce_ms")
        for k in runtime_info_keys:
            assert k not in h, (
                f"Bug C: `{k}` at top-level should be in `_internal` "
                f"(runtime/debug info, not product contract)."
            )
        internal = h.get("_internal") or {}
        for k in runtime_info_keys:
            assert k in internal, f"Bug C: `_internal.{k}` missing, debug needs it"
    finally:
        stop_daemon(proc)
