import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ToolContext } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { ROOT } from "../../../tests/fixtures/services.js";
import { createRegistry, resolveEvidence, ToolRuntime } from "@eval/tools";
import { emptyAudit, raw } from "../../../tests/fixtures/comparison.js";

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
test("trace search finds numeric tool fields and returns an exact structured quote", async () => {
  const ctx = await context();
  try {
    const source = {
      type: "tool_result",
      output: { datas: [{ "数量[20240220]": 4444 }] },
    };
    ctx.inputs.set("A", { messages: [source] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    const result = await runtime.execute(
      "search_trace",
      { candidate: "A", query: '"数量[20240220]": 4444' },
      new AbortController().signal,
    );
    const details = result.details as {
      total: number;
      matches: { evidence: { message_index: number; quote: string } }[];
    };
    assert.equal(details.total, 1);
    assert.equal(details.matches[0].evidence.message_index, 0);
    assert(JSON.stringify(source, null, 2).includes(details.matches[0].evidence.quote));
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("out-of-range evidence can be repaired from source-backed feedback without guessing offsets", () => {
  const input = { messages: Array.from({ length: 31 }, () => ({
    role: "assistant", content: [{ type: "text", text: "数".repeat(4096) }], type: "message",
  })) };
  let issue: { message: string; expected: unknown } | undefined;
  try {
    resolveEvidence(input, { evidence_id: "ev_30_text_0_8192_/content/0/text" }, "answer", [], "/findings/0/evidence/0");
    assert.fail("an invalid range must still be rejected");
  } catch (error) {
    issue = (error as { issues: { message: string; expected: unknown }[] }).issues[0];
  }
  assert.match(issue!.message, /文本长度为 4096/);
  const repair = issue!.expected as { suggested_evidence?: { evidence_id: string; quote: string }[] };
  assert(repair.suggested_evidence?.length, "feedback must offer source-backed IDs, not require manual coordinate repair");
  for (const evidence of repair.suggested_evidence)
    assert.equal(resolveEvidence(input, evidence, "answer", [], "/findings/0/evidence/0").quote, evidence.quote);
});
test("trace pages keep evidence intact within the output budget", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxOutputChars = 4096;
    ctx.inputs.set("A", { messages: [{ role: "assistant", content: "长文本".repeat(4000) }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, max_chars: 16000 }, new AbortController().signal);
    assert(!result.isError);
    const text = result.content[0]!.text!;
    assert(text.length <= ctx.policy.maxOutputChars, "pagination must happen before generic result truncation");
    const page = JSON.parse(text);
    assert(page.evidence.length);
    assert(page.has_more);
    for (const evidence of page.evidence)
      assert.equal(resolveEvidence(ctx.inputs.get("A") as { messages: unknown[] }, evidence, "A", [], "/evidence").quote, evidence.quote);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});

test("trace text-path pagination uses field coordinates and returns copyable evidence for every page", async () => {
  const ctx = await context();
  try {
    const text = '值"\\\n🙂'.repeat(800).slice(0, 4096);
    const input = { messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
    ctx.inputs.set("A", input);
    ctx.policy.maxOutputChars = 4096;
    ctx.policy.maxToolCalls = 30;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    let offset = 0, recovered = "";
    do {
      const result = await runtime.execute("read_trace", {
        candidate: "A", message_index: 0, path: "/content/0/text", offset, max_chars: 16000,
      }, new AbortController().signal);
      assert(!result.isError, JSON.stringify(result));
      const page = JSON.parse(result.content[0]!.text!);
      assert.equal(page.total_chars, 4096);
      assert.equal(page.source.path, "/content/0/text");
      assert.equal(page.evidence.length, 1);
      const evidence = page.evidence[0];
      assert.equal(resolveEvidence(input, evidence, "A", [], "/evidence").quote, text.slice(offset, page.next_offset));
      recovered += evidence.quote;
      assert(page.next_offset > offset);
      offset = page.next_offset;
      if (!page.has_more) break;
    } while (offset < text.length);
    assert.equal(recovered, text);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("search pages preserve complete evidence and paginate without skipping matches", async () => {
  const ctx = await context();
  try {
    const input = { messages: Array.from({ length: 12 }, (_, i) => ({
      role: "tool", content: `${'"\\\n'.repeat(80)}目标${i}${'"\\\n'.repeat(80)}`,
    })) };
    ctx.inputs.set("A", input);
    ctx.policy.maxOutputChars = 4096;
    ctx.policy.maxToolCalls = 30;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    let offset = 0, total = 0;
    const ids = new Set<string>();
    do {
      const result = await runtime.execute("search_trace", { candidate: "A", query: "目标", offset }, new AbortController().signal);
      assert(!result.isError);
      assert(result.content[0]!.text!.length <= ctx.policy.maxOutputChars);
      const page = JSON.parse(result.content[0]!.text!);
      total = page.total;
      assert(page.matches.length);
      for (const { evidence } of page.matches) {
        assert.equal(resolveEvidence(input, evidence, "A", [], "/evidence").quote, evidence.quote);
        assert(evidence.quote.includes("目标"));
        assert(!ids.has(evidence.evidence_id));
        ids.add(evidence.evidence_id);
      }
      assert.equal(page.next_offset, offset + page.matches.length);
      offset = page.next_offset;
      if (!page.has_more) break;
    } while (offset < total);
    assert.equal(ids.size, total);
    assert.equal(total, 24);
    assert.equal(ctx.audit.artifacts.length, 0);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("registered tools are available without engine-specific changes and budgets are enforced", async () => {
  const ctx = await context();
  try {
    const registry = createRegistry([
      {
        name: "custom_count",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
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
      {
        language: "python",
        code: "import time; time.sleep(30)",
        timeout_seconds: 1,
      },
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
    child = spawn(process.execPath, [path.join(ROOT, "dist/tests/fixtures/code-child.js"), ctx.workdir], {
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
