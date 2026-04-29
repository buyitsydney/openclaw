"""Mock markitdown for tests. Returns file contents verbatim as 'markdown'.
Default ~50ms; override via MOCK_MARKITDOWN_DELAY_SEC env for slow-convert tests
(B6 reinit blocking regression). MOCK_MARKITDOWN_OOM=1 simulates the OOM path
used by v8.7 budget test — allocates past RLIMIT_AS and aborts rc=-9."""
import sys, time, os

__version__ = "0.0.1-mock"


def _delay() -> float:
    try:
        return float(os.environ.get("MOCK_MARKITDOWN_DELAY_SEC", "0.05"))
    except ValueError:
        return 0.05


def _maybe_oom():
    """v8.7: simulate cgroup OOM-kill for convert() memory-budget test.
    Portable across platforms (macOS overcommit means real 2 GiB allocs
    don't always fail), so just exit 137 — daemon sees the same rc it
    would see if the kernel OOM-killer had SIGKILLed us."""
    if os.environ.get("MOCK_MARKITDOWN_OOM") == "1":
        sys.exit(137)


def _maybe_check_rlimit():
    """v8.7: verify daemon set RLIMIT_AS (address-space budget) on this
    subprocess. Write detected limit to MOCK_MARKITDOWN_RLIMIT_PROBE_FILE
    so the test can read it back."""
    probe = os.environ.get("MOCK_MARKITDOWN_RLIMIT_PROBE_FILE")
    if not probe:
        return
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    except Exception as e:
        with open(probe, "w") as pf:
            pf.write(f"err:{e}")
        return
    with open(probe, "w") as pf:
        pf.write(f"{soft},{hard}")


class MarkItDown:
    def convert(self, path):
        _maybe_check_rlimit()
        _maybe_oom()
        time.sleep(_delay())
        class R:
            def __init__(self, text): self.text_content = text
        try:
            with open(path, "rb") as f:
                raw = f.read()
            return R(raw.decode("utf-8", "replace"))
        except Exception as e:
            return R(f"mock-error: {e}")


def _cli_main():
    # `python -m markitdown <path>` — produce the body on stdout.
    if len(sys.argv) < 2:
        sys.exit(2)
    _maybe_check_rlimit()
    _maybe_oom()
    path = sys.argv[1]
    time.sleep(_delay())
    try:
        with open(path, "rb") as f:
            sys.stdout.buffer.write(f.read())
    except Exception as e:
        sys.stderr.write(f"mock-error: {e}\n")
        sys.exit(1)
