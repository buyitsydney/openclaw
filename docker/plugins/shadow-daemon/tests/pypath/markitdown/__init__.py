"""Mock markitdown for tests. Returns file contents verbatim as 'markdown'.
Simulates ~50ms work so parallel tests meaningfully exercise the executor."""
import sys, time, os

__version__ = "0.0.1-mock"


class MarkItDown:
    def convert(self, path):
        time.sleep(0.05)
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
    path = sys.argv[1]
    time.sleep(0.05)
    try:
        with open(path, "rb") as f:
            sys.stdout.buffer.write(f.read())
    except Exception as e:
        sys.stderr.write(f"mock-error: {e}\n")
        sys.exit(1)
