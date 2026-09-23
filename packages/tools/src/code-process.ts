// Own only this invocation's process group. IPC loss means the worker has died.
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Code command missing");
const child = spawn(command, args, {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
let stopping = false,
  finished = false,
  code: number | null = null;
function signalGroup(signal: NodeJS.Signals) {
  if (child.pid)
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
}
function stop() {
  if (stopping) return;
  stopping = true;
  signalGroup("SIGTERM");
  setTimeout(() => {
    signalGroup("SIGKILL");
    if (finished) process.exit(code ?? 1);
  }, 500);
  setTimeout(() => process.exit(code ?? 1), 1500);
}
child.once("error", (error) => {
  console.error(error.message);
  finished = true;
  code = 127;
  stop();
});
child.once("exit", (value) => {
  finished = true;
  code = value;
  stop();
});
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
