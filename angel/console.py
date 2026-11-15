"""Console output helpers for legacy Windows code pages.

Keep the existing stream encoding; escape only characters that cannot be
represented by the active terminal, instead of crashing a CLI or daemon.
"""

import sys


def configure_stream(stream) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if not callable(reconfigure):
        return
    try:
        reconfigure(errors="backslashreplace")
    except (OSError, ValueError, TypeError):
        # Embedded streams and test doubles may not support reconfiguration.
        pass


def configure_stdio() -> None:
    configure_stream(sys.stdout)
    configure_stream(sys.stderr)
