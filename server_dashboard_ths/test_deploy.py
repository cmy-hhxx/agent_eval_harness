import tempfile
import unittest
import shutil
import subprocess
import os
import signal
import socket
import sys
import time
from pathlib import Path
from unittest.mock import patch

import deploy


class DeploymentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run(["node", str(deploy.CODE_DIR / "build.mjs")], check=True)

    @unittest.skipUnless(hasattr(os, "fork"), "requires POSIX process groups")
    def test_restart_waits_for_delayed_child_to_release_listener(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".packages").mkdir()
            (root / ".packages/py7zr.py").write_text("")
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            (root / "app.py").write_text(f'''import os, signal, socket, time
from pathlib import Path
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("0.0.0.0", {port}))
listener.listen()
if os.fork() == 0:
    def stop(*args):
        time.sleep(2)
        os._exit(0)
    signal.signal(signal.SIGTERM, stop)
    Path("ready").touch()
while True:
    time.sleep(1)
''')
            old = subprocess.Popen([sys.executable, "app.py"], cwd=root, start_new_session=True)
            try:
                for _ in range(100):
                    if (root / "ready").exists():
                        break
                    time.sleep(.02)
                else:
                    self.fail("old listener did not start")
                (root / "service.pid").write_text(str(old.pid))
                (root / "app.py").write_text(f'''from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Timer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{{"ok":true}}'
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
server = HTTPServer(("0.0.0.0", {port}), Handler)
Timer(10, server.shutdown).start()
server.serve_forever()
''')
                result = subprocess.run([sys.executable, "-c", deploy.RESTART.replace("8081", str(port))],
                                        cwd=root, text=True, capture_output=True, timeout=40)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("health checks passed", result.stdout)
            finally:
                for pid in {old.pid, int((root / "service.pid").read_text())}:
                    try:
                        os.killpg(pid, signal.SIGTERM)
                    except OSError:
                        pass  # Fixture server also shuts itself down after ten seconds.
                old.wait(timeout=5)

    def test_reads_input_server_and_only_syncs_runtime_files_before_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / ".servers.conf"
            config.write_text("""[other_server]
host = wrong.example
[eval_input_data_server]
host = input.example
user = operator
port = 3577
auth = key
key = keys/id_rsa
""")
            with patch.object(deploy.subprocess, "run") as run:
                deploy.deploy(config)
            self.assertEqual(run.call_count, 3)
            build, sync, restart = run.call_args_list
            self.assertEqual(build.args[0], ["node", str(deploy.CODE_DIR / "build.mjs")])
            command = sync.args[0]
            self.assertEqual(command[0], "rsync")
            self.assertIn("--relative", command)
            self.assertNotIn("--delete", command)
            self.assertIn(str(Path(folder) / "keys/id_rsa"), command[command.index("-e") + 1])
            self.assertEqual(command[-1], f"operator@input.example:{deploy.REMOTE_DIR}/")
            for name in deploy.FILES:
                self.assertTrue((deploy.CODE_DIR / name).is_file(), name)
                self.assertIn(name, command)
            self.assertEqual(sync.kwargs["cwd"], deploy.CODE_DIR)
            self.assertNotIn(".servers.conf", " ".join(command))
            self.assertEqual(restart.args[0][-2], "operator@input.example")
            self.assertIn("3577", restart.args[0])
            self.assertNotIn("register-local-import", restart.kwargs["input"])
            self.assertIn("/health", restart.kwargs["input"])
            compile(restart.kwargs["input"], "remote-restart", "exec")

    @unittest.skipUnless(shutil.which("rsync"), "deployment requires rsync")
    def test_real_rsync_places_only_runtime_files_directly_in_destination(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / ".servers.conf"
            config.write_text("[eval_input_data_server]\nhost=input.example\nuser=operator\nauth=key\nkey=keys/id_rsa\n")
            destination = root / "remote-code"
            destination.mkdir()
            run = subprocess.run
            def transfer(command, **kwargs):
                if command[0] == "rsync":
                    return run([*command[:-1], str(destination) + "/"], **kwargs)
                return subprocess.CompletedProcess(command, 0)
            with patch.object(deploy.subprocess, "run", side_effect=transfer):
                deploy.deploy(config)
            self.assertEqual({str(path.relative_to(destination)) for path in destination.rglob("*") if path.is_file()}, set(deploy.FILES))
            for name in deploy.FILES:
                self.assertEqual((destination / name).read_bytes(), (deploy.CODE_DIR / name).read_bytes())

    def test_unsupported_auth_does_not_copy_or_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / ".servers.conf"
            config.write_text("[eval_input_data_server]\nauth = password\n")
            with patch.object(deploy.subprocess, "run") as run:
                with self.assertRaisesRegex(ValueError, "auth = key"):
                    deploy.deploy(config)
            run.assert_not_called()



if __name__ == "__main__":
    unittest.main()
