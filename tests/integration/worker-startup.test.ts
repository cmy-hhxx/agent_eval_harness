import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnWorker, WorkerStartupError, type WorkerProcess } from "@eval/runtime/client";

test("a cancelled IPC startup preserves its process handle when forced shutdown cannot confirm exit", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-ipc-startup-")), entry = path.join(directory, "worker.mjs");
  await writeFile(entry, "setInterval(() => {}, 1000);\n");
  const kill = ChildProcess.prototype.kill;
  let child: ChildProcess | undefined, retained: WorkerProcess | undefined;
  t.mock.method(ChildProcess.prototype, "kill", function(this: ChildProcess, signal?: NodeJS.Signals | number) {
    if (this.spawnargs.includes(entry)) { child = this; return true; }
    return kill.call(this, signal);
  });
  try {
    await assert.rejects(spawnWorker("pi", path.join(directory, "workspace"), {
      root: directory, workerEntry: entry, signal: AbortSignal.timeout(50),
    }), error => {
      assert(error instanceof WorkerStartupError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /Worker did not exit after SIGKILL/);
      retained = error.worker;
      assert.equal(retained.pid, child!.pid);
      return true;
    });
    await assert.rejects(retained!.close(), /Worker did not exit after SIGKILL/);
  } finally {
    if (child) kill.call(child, "SIGKILL");
    await retained?.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
