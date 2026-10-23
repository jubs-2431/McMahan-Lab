"""Actual server entrypoint smoke test; no provider requests or participant logs."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).parent


class StartupTest(unittest.TestCase):
    def test_entrypoint_http_assets_and_clean_shutdown(self):
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            for name in ("server.py", "platform_lock.py", "state_validation.py", "index.html", "main.js", "serial-markers.mjs"):
                shutil.copy2(ROOT / name, stage / name)
            assets = ("output/conversions/kevin_cc_reexport_three_fixed.glb", "test-avatars/avaturn_feale_pose_edit.glb")
            for name in assets:
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            env = {**os.environ, "WEB_APP_PORT": str(port)}
            # Do not inherit provider secrets; this test does not synthesize speech.
            for key in ("OPENAI_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"):
                env.pop(key, None)
            with (stage / "startup.log").open("w+") as output:
                process = subprocess.Popen([sys.executable, "server.py"], cwd=stage, env=env,
                                           stdout=output, stderr=subprocess.STDOUT)
                try:
                    deadline = time.monotonic() + 20
                    base = f"http://127.0.0.1:{port}"
                    while True:
                        try:
                            with urlopen(base + "/api/health", timeout=1) as response:
                                self.assertEqual(response.status, 200)
                            break
                        except (URLError, TimeoutError):
                            if process.poll() is not None or time.monotonic() >= deadline:
                                output.seek(0)
                                self.fail("Server did not start: " + output.read())
                            time.sleep(0.1)
                    for route in ("/", "/confederate", "/main.js", "/serial-markers.mjs"):
                        with urlopen(base + route, timeout=5) as response:
                            self.assertEqual(response.status, 200)
                    for route in ("/avatar-male.glb", "/avatar-female.glb"):
                        with urlopen(base + route, timeout=5) as response:
                            self.assertEqual(response.read(4), b"glTF", "Run git lfs pull to download avatar assets")
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
