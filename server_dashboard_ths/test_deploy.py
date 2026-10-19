import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import deploy


class DeploymentTest(unittest.TestCase):
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
            self.assertEqual(run.call_count, 2)
            sync, restart = run.call_args_list
            command = sync.args[0]
            self.assertEqual(command[0], "rsync")
            self.assertIn("--relative", command)
            self.assertNotIn("--delete", command)
            self.assertIn(str(Path(folder) / "keys/id_rsa"), command[command.index("-e") + 1])
            self.assertEqual(command[-1], f"operator@input.example:{deploy.REMOTE_DIR}/")
            for name in deploy.FILES:
                self.assertTrue((deploy.CODE_DIR / name).is_file(), name)
                self.assertIn(f"{deploy.CODE_DIR}/./{name}", command)
            self.assertNotIn(".servers.conf", " ".join(command))
            self.assertEqual(restart.args[0][-2], "operator@input.example")
            self.assertIn("3577", restart.args[0])
            self.assertNotIn("register-local-import", restart.kwargs["input"])
            self.assertIn("/health", restart.kwargs["input"])
            compile(restart.kwargs["input"], "remote-restart", "exec")

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
