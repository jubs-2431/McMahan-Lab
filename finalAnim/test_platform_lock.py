import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import platform_lock


class PlatformLockTest(unittest.TestCase):
    def test_windows_locks_first_byte_without_waiting(self):
        fake = SimpleNamespace(LK_NBLCK=2, locking=Mock())
        with tempfile.TemporaryFile('a+b') as handle:
            handle.write(b'lock')
            with patch.dict(sys.modules, {'msvcrt': fake}):
                platform_lock._lock_windows(handle)
            self.assertEqual(handle.tell(), 0)
            fake.locking.assert_called_once_with(handle.fileno(), 2, 1)

    def test_failed_lock_closes_handle(self):
        handle = Mock()
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(platform_lock, '_lock_windows', side_effect=OSError('busy')), patch.object(Path, 'open', return_value=handle):
                # Exercise error cleanup through the current platform's lock primitive.
                if os.name == 'nt':
                    with self.assertRaises(RuntimeError):
                        platform_lock.acquire_log_lock(folder)
                else:
                    with patch('fcntl.flock', side_effect=OSError('busy')):
                        with self.assertRaises(RuntimeError):
                            platform_lock.acquire_log_lock(folder)
        handle.close.assert_called_once()

    def test_competing_process_rejected_then_release_allows_start(self):
        with tempfile.TemporaryDirectory() as folder:
            lock = platform_lock.acquire_log_lock(folder)
            code = 'import sys; from platform_lock import acquire_log_lock; lock = acquire_log_lock(sys.argv[1])'
            args = [sys.executable, '-c', code, folder]
            try:
                busy = subprocess.run(args, cwd=Path(__file__).parent, capture_output=True, text=True)
                self.assertNotEqual(busy.returncode, 0)
                self.assertIn('Another finalAnim server', busy.stderr)
            finally:
                lock.close()
            free = subprocess.run(args, cwd=Path(__file__).parent, capture_output=True, text=True)
            self.assertEqual(free.returncode, 0, free.stderr)


if __name__ == '__main__':
    unittest.main()
