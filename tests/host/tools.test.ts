import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ToolContext } from "../../packages/contracts/src/index.js";
import { ArtifactStore, ROOT } from "../../packages/contracts/src/io.js";
import { createRegistry, ToolRuntime } from "../../packages/tools/src/index.js";
import { emptyAudit, raw } from "./fixtures.js";

async function context() {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "eval-tools-"));
  const ctx: ToolContext = {
    attemptId: "test",
    workdir,
    inputs: new Map([["A", raw()]]),
    audit: emptyAudit(),
    policy: { ...DEFAULT_POLICY, maxToolCalls: 3 },
    artifacts: new ArtifactStore(path.join(workdir, "artifacts")),
  };
  return ctx;
}
test("registered tools are available without engine-specific changes and budgets are enforced", async () => {
  const ctx = await context();
  try {
    const registry = createRegistry([
      {
        name: "custom_count",
        description: "count",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: [{ type: "text", text: "42" }] };
        },
      },
    ]);
    const runtime = new ToolRuntime(ctx, registry.select(["custom_count", "read_trace"]));
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await runtime.execute("custom_count", {}, new AbortController().signal)).content[0].text,
        "42",
      );
    assert.equal(
      (
        await runtime.execute(
          "read_trace",
          { candidate: "A", message_index: 1 },
          new AbortController().signal,
        )
      ).isError,
      true,
    );
    assert.equal(ctx.audit.calls, 3);
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("code executes with persistent task files and paged artifact output", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code", "read_artifact"]));
    const result = await runtime.execute(
      "execute_code",
      {
        language: "python",
        code: 'from pathlib import Path\nPath("answer.txt").write_text("4")\nprint(2+2)',
        outputs: ["answer.txt"],
      },
      new AbortController().signal,
    );
    assert(!result.isError, JSON.stringify(result));
    const details = result.details as { stdout: string; exit_code: number };
    assert.equal(details.exit_code, 0);
    assert.equal(details.stdout.trim(), "4");
    const output = ctx.audit.artifacts.find((a) => a.name === "answer.txt")!;
    const read = await runtime.execute("read_artifact", { id: output.id }, new AbortController().signal);
    assert.equal((read.details as { text: string }).text, "4");
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("cancellation terminates the code process group", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code"]));
    const signal = new AbortController();
    const started = Date.now();
    const task = runtime.execute(
      "execute_code",
      { language: "shell", code: "sleep 30 &\nwait" },
      signal.signal,
    );
    setTimeout(() => signal.abort(), 150);
    const result = await task;
    assert(Date.now() - started < 5000);
    assert.equal((result.details as { cancelled: boolean }).cancelled, true);
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("code timeout is enforced without waiting for the task deadline", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code"]));
    const start = Date.now();
    const result = await runtime.execute(
      "execute_code",
      { language: "python", code: "import time; time.sleep(30)", timeout_seconds: 1 },
      new AbortController().signal,
    );
    assert.equal((result.details as { timed_out: boolean }).timed_out, true);
    assert(Date.now() - start < 4000);
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("worker SIGKILL does not leave an executing Python process behind", async () => {
  const ctx = await context(),
    child = spawn(process.execPath, [path.join(ROOT, "dist/tests/host/code-child.js"), ctx.workdir], {
      stdio: "ignore",
    });
  let pid: number | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        pid = Number(await readFile(path.join(ctx.workdir, "pid"), "utf8"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    assert(pid, "Python did not start");
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGKILL");
    await exited;
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(alive, false, "Invocation guardian must terminate its process group after IPC disconnect");
  } finally {
    child.kill("SIGKILL");
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
