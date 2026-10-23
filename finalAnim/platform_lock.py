"""Keep one server per log directory on Windows, macOS, and Linux."""
import os
from pathlib import Path


def _lock_windows(handle):
    import msvcrt
    handle.seek(0)
    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)


def acquire_log_lock(log_root):
    root = Path(log_root)
    root.mkdir(parents=True, exist_ok=True)
    handle = (root / ".server.lock").open("a+b")
    try:
        if os.name == "nt":
            _lock_windows(handle)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        handle.close()
        raise RuntimeError("Another finalAnim server is already using this log directory, or the directory cannot be locked.") from error
    return handle
