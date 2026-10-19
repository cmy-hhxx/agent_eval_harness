#!/usr/bin/env python3
"""Deploy the input dashboard to .servers.conf's eval_input_data_server."""

from __future__ import annotations

import argparse
import configparser
import shlex
import subprocess
from pathlib import Path

CODE_DIR = Path(__file__).resolve().parent
REMOTE_DIR = "/mnt/fin_bench/A_AA_comparision_data/0_process_code"
FILES = (
    "app.py", "multi_agent_inputs.py", "dashboard.html", "dashboard.css", "dashboard.js",
    "records.html", "records.bundle.js", "docs.html", "docs/handoff.md", "requirements.txt",
)
RESTART = '''import errno, json, os, shlex, signal, socket, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen

sys.path.insert(0, str(Path.cwd() / ".packages"))
import py7zr

pid_file = Path("service.pid")
if pid_file.is_file():
    pid = int(pid_file.read_text().strip())
    args = subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True).stdout.strip()
    if args:
        command = shlex.split(args)
        if len(command) != 2 or not Path(command[0]).name.startswith("python") or Path(command[1]).name != "app.py":
            raise SystemExit("service.pid belongs to an unexpected process")
        # Stop extraction helpers in our own session before recovering staged publication.
        if os.getpgid(pid) == pid:
            os.killpg(pid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
        for _ in range(30):
            status = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
            if not status or status.startswith("Z"):
                break
            time.sleep(1)
        else:
            raise SystemExit("previous dashboard process did not stop")

# The parent can exit before a terminated extraction helper releases its socket.
for _ in range(30):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("0.0.0.0", 8081))
            break
        except OSError as error:
            if error.errno != errno.EADDRINUSE:
                raise
    time.sleep(1)
else:
    raise SystemExit("dashboard port is still occupied; previous helpers have not exited")

with Path("service.log").open("ab") as log:
    process = subprocess.Popen(["python3", "app.py"], stdin=subprocess.DEVNULL,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
pid_file.write_text(str(process.pid) + "\\n")
for _ in range(30):
    if process.poll() is not None:
        raise SystemExit("dashboard exited; inspect service.log")
    try:
        checks = []
        for prefix in ("", "/gpt", "/aime", "/ifind"):
            with urlopen(f"http://127.0.0.1:8081{prefix}/health", timeout=2) as response:
                checks.append(json.load(response).get("ok") is True)
        if all(checks):
            print("Dashboard restarted; all four source health checks passed.")
            break
    except OSError:
        pass
    time.sleep(1)
else:
    raise SystemExit("dashboard health check timed out")
'''


def connection(config_path: Path) -> tuple[list[str], str]:
    config = configparser.ConfigParser(interpolation=None)
    with config_path.open() as stream:
        config.read_file(stream)
    server = config["eval_input_data_server"]
    if server.get("auth") != "key":
        raise ValueError("eval_input_data_server must use auth = key")
    key = Path(server["key"]).expanduser()
    if not key.is_absolute():
        key = config_path.resolve().parent / key
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
           "-p", server.get("port", "22"), "-i", str(key)]
    target = f"{server['user']}@{server['host']}"
    return ssh, target


def deploy(config_path: Path) -> None:
    ssh, target = connection(config_path)
    subprocess.run(["node", str(CODE_DIR / "build.mjs")], cwd=CODE_DIR.parent, check=True)
    subprocess.run(["rsync", "-rtz", "--relative", "--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r",
                    "-e", shlex.join(ssh), *FILES, f"{target}:{REMOTE_DIR}/"], cwd=CODE_DIR, check=True)
    subprocess.run([*ssh, target, f"cd {shlex.quote(REMOTE_DIR)} && python3 -"],
                   input=RESTART, text=True, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=CODE_DIR.parent / ".servers.conf")
    args = parser.parse_args()
    deploy(args.config)


if __name__ == "__main__":
    main()
