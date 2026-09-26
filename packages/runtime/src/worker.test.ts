import { draftFor } from "../../../tests/fixtures/comparison.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_POLICY,
  emptyUsage,
  type AgentBackend,
  type AttemptSpec,
  type AttemptStatus,
  type FailureContext,
  type RunManifest,
  type Submission,
  type WorkerEvent,
} from "@eval/contracts";
import { body, json, listen, request } from "@eval/runtime/http";
import { exists, readJson } from "@eval/data";
import { object } from "@eval/contracts";
import { services, prepare } from "../../../tests/fixtures/services.js";
import { buildPlan } from "@eval/workflows/comparison";
import { RunStore } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import {
  fakeIdentity,
  fixtureConfig,
  invalidResult,
  raw,
  taskResult,
} from "../../../tests/fixtures/comparison.js";

async function harness(
  create: AgentBackend["createSession"],
  policy: Partial<typeof DEFAULT_POLICY> = {},
  dropAck = false,
) {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  const plan = await buildPlan(config),
    task = plan.tasks[0];
  const manifest: RunManifest = {
    format: "evaluation-run",
    debug: false,
    runId: "test",
    status: "running",
    engine: fakeIdentity,
    config,
    tasks: plan.tasks,
    inputs: {},
    states: { [task.id]: { status: "pending", attempts: 0 } },
    preflight: plan.summary,
    startedAt: Date.now(),
  };
  const store = new RunStore(
    path.join(directory, "run"),
    { manifest, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 },
    plan.inputs,
    services,
  );
  let posts = 0,
    lookups = 0;
  const host = await listen(async (req, res, url) => {
    if (url.pathname.endsWith("/checkpoint")) {
      await store.checkpoint(task.id, (await body(req)) as FailureContext);
      return json(res, { saved: true });
    }
    if (req.method === "POST") {
      posts++;
      const receipt = await store.accept((await body(req)) as Submission);
      if (dropAck && posts === 1) res.destroy();
      else json(res, receipt);
    } else if (url.pathname.includes("/submissions/")) {
      lookups++;
      json(res, await store.findSubmission(url.pathname.split("/").at(-1)!));
    } else json(res, plan.inputs[url.pathname.split("/").at(-1)!]);
  });
  const worker = await startWorker(
    { identity: fakeIdentity, createSession: create },
    path.join(directory, "worker"),
  );
  const prepared = prepare(task, plan.inputs, {});
  const spec: AttemptSpec = {
    inputRevision: 1,
    runId: "test",
    taskId: task.id,
    attemptId: "attempt",
    engine: fakeIdentity,
    ...prepared,
    model: {
      provider: "fixture",
      baseUrl: "http://127.0.0.1",
      api: "openai-completions",
      apiKeyEnv: "FIXTURE_KEY",
      model: "fixture",
      thinking: "off",
      contextWindow: 10000,
      maxOutputTokens: 1000,
    },
    policy: { ...DEFAULT_POLICY, ...policy },
    inputs: Object.entries(task.inputIds).map(([name, id]) => ({
      id,
      name,
    })),
    hostUrl: host.url,
    deadline: Date.now() + 10000,
  };
  return {
    directory,
    spec,
    worker,
    store,
    counts: () => ({ posts, lookups }),
    async start() {
      await store.activate(spec);
      await request(worker.url + "/api/attempts", "POST", spec);
    },
    async done() {
      for (let i = 0; i < 200; i++) {
        const status = await request<AttemptStatus>(worker.url + "/api/attempts/attempt");
        if (status.state !== "running") return status;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("Worker did not settle");
    },
    async close() {
      await worker.close();
      await host.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("lost submission acknowledgement is recovered by ID; SSE replay is contiguous", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        const accepted = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        assert.equal(accepted.terminate, true);
      },
      async abort() {},
      async dispose() {},
    }),
    {},
    true,
  );
  try {
    await fixture.start();
    assert.equal((await fixture.done()).state, "succeeded");
    assert.deepEqual(fixture.counts(), { posts: 1, lookups: 1 });
    const read = async (after: number) => {
      const response = await fetch(`${fixture.worker.url}/api/attempts/attempt/events?after=${after}`);
      return (await response.text())
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)) as WorkerEvent);
    };
    const events = await read(0);
    assert.equal(events.at(-1)?.type, "finished");
    assert.deepEqual(
      events.map((e) => e.seq),
      events.map((_, i) => i + 1),
    );
    assert.deepEqual(await read(2), events.slice(2));
  } finally {
    await fixture.close();
  }
});
test("stream log keeps deltas and final messages without repeated snapshots; release follows settlement", async () => {
  const finalMessage = {
    role: "assistant",
    content: "你好",
    usage: { input: 8, output: 2, totalTokens: 10 },
  };
  let workdir = "";
  const partial = { role: "assistant", content: "重复快照".repeat(10000) };
  const fixture = await harness(async (options) => {
    workdir = options.workdir;
    assert(await exists(path.join(workdir, "inputs/A.json")));
    await assert.rejects(request(fixture.worker.url + "/api/attempts/attempt", "DELETE"), /still running/);
    return {
      async run() {
        options.onEvent({ type: "message_start", message: partial });
        for (const delta of ["你", "好"])
          options.onEvent({
            type: "message_update",
            message: partial,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta,
              partial,
            },
          });
        options.onEvent({ type: "message_end", message: finalMessage });
        options.onEvent({
          type: "turn_end",
          message: finalMessage,
          toolResults: [partial],
        });
        options.onEvent({
          type: "agent_end",
          messages: [partial, finalMessage],
          willRetry: false,
        });
        await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
      },
      async abort() {},
      async dispose() {},
    };
  });
  try {
    await fixture.start();
    assert.equal((await fixture.done()).state, "succeeded");
    assert.equal(await exists(workdir), false);
    const response = await fetch(fixture.worker.url + "/api/attempts/attempt/events");
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as WorkerEvent);
    const model = events.filter((event) => event.type === "model").map((event) => object(event.data));
    assert(text.length < 15000);
    assert.deepEqual(model.find((event) => event.type === "message_end")?.message, finalMessage);
    assert.equal(
      model
        .filter((event) => event.type === "message_update")
        .map((event) => object(event.assistantMessageEvent).delta)
        .join(""),
      "你好",
    );
    assert.equal(partial.content.length, 40000, "logging must not mutate SDK state");
    const record = await readJson<{
      metrics: { usage: { totalTokens: number } };
    }>(path.join(fixture.directory, "worker/attempt/attempt.json"));
    assert.equal(record.metrics.usage.totalTokens, 10);
    await request(fixture.worker.url + "/api/attempts/attempt", "DELETE");
    assert.equal(await exists(path.join(fixture.directory, "worker/attempt")), false);
    await request(fixture.worker.url + "/api/attempts/attempt", "DELETE");
    await assert.rejects(
      request(fixture.worker.url + "/api/attempts", "POST", fixture.spec),
      /already released/,
    );
  } finally {
    await fixture.close();
  }
});
test("exhausted exploration budget still permits submission and two repairs", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        await options.execute("read_trace", {
          candidate: "A",
          message_index: 1,
        });
        assert.equal(
          (
            await options.execute("read_trace", {
              candidate: "B",
              message_index: 1,
            })
          ).isError,
          true,
        );
        const invalid = invalidResult(options.spec) as any;
        invalid.findings[0].evidence[0].quote = "invented";
        assert.equal(
          (await options.execute("submit_evaluation", draftFor(options.spec, invalid))).isError,
          true,
        );
        assert.equal((await options.execute("submit_evaluation", draftFor(options.spec, {}))).isError, true);
        assert.equal(
          (await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)))).terminate,
          true,
        );
      },
      async abort() {},
      async dispose() {},
    }),
    { maxToolCalls: 1, repairAttempts: 2 },
  );
  try {
    await fixture.start();
    assert.equal((await fixture.done()).state, "succeeded");
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))?.audit.calls, 1);
  } finally {
    await fixture.close();
  }
});
test("file submission repairs a rejected evidence ID after exploration is exhausted", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        await options.execute("read_trace", {
          candidate: "A",
          message_index: 1,
        });
        const invalid = invalidResult(options.spec) as any;
        invalid.findings[0].evidence[0].quote = "2 + 2 = 4";
        assert.equal(
          (await options.execute("submit_evaluation", draftFor(options.spec, invalid))).isError,
          true,
        );
        assert.deepEqual(
          await readJson(path.join(options.workdir, "evaluation-draft.json")),
          draftFor(options.spec, invalid),
        );
        const fixed = await options.execute("execute_code", {
          language: "python",
          code: "import json\nfrom pathlib import Path\np=Path('evaluation-draft.json')\nr=json.loads(p.read_text())\nr['findings'][0]['evidence'][0]['evidence_id']=VALID_ID\np.write_text(json.dumps(r,ensure_ascii=False))".replace(
            "VALID_ID",
            JSON.stringify(
              (draftFor(options.spec, taskResult(options.spec)) as any).findings[0].evidence[0].evidence_id,
            ),
          ),
        });
        assert.notEqual(fixed.isError, true);
        assert.equal(
          (
            await options.execute("read_trace", {
              candidate: "B",
              message_index: 1,
            })
          ).isError,
          true,
        );
        assert.equal(
          (
            await options.execute("submit_evaluation_file", {
              path: "evaluation-draft.json",
            })
          ).terminate,
          true,
        );
      },
      async abort() {},
      async dispose() {},
    }),
    { maxToolCalls: 1, repairAttempts: 1 },
  );
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.deepEqual(receipt?.evaluation, taskResult(fixture.spec));
    assert.equal(receipt?.audit.calls, 2);
  } finally {
    await fixture.close();
  }
});
test("file loading errors do not consume content repairs", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        const outside = path.join(options.workdir, "../outside.json");
        await writeFile(outside, JSON.stringify(taskResult(options.spec)));
        await symlink(outside, path.join(options.workdir, "outside-link.json"));
        assert.equal(
          (
            await options.execute("submit_evaluation_file", {
              path: "outside-link.json",
            })
          ).isError,
          true,
        );
        const invalid = invalidResult(options.spec) as any;
        invalid.findings[0].evidence[0].quote = "invented";
        await writeFile(
          path.join(options.workdir, "invalid.json"),
          JSON.stringify(draftFor(options.spec, invalid)),
        );
        assert.equal(
          (
            await options.execute("submit_evaluation_file", {
              path: "invalid.json",
            })
          ).isError,
          true,
        );
        assert.equal(
          (await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)))).terminate,
          true,
        );
      },
      async abort() {},
      async dispose() {},
    }),
    { repairAttempts: 1 },
  );
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.equal(fixture.counts().posts, 2);
    assert.deepEqual((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats, {
      contentSubmissions: 2,
      fileErrors: 1,
    });
  } finally {
    await fixture.close();
  }
});
test("three file loading failures stop independently of the content budget", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        for (let i = 0; i < 3; i++)
          assert.equal(
            (
              await options.execute("submit_evaluation_file", {
                path: "missing.json",
              })
            ).isError,
            true,
          );
      },
      async abort() {},
      async dispose() {},
    }),
    { repairAttempts: 0 },
  );
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.equal(status.failure?.fileErrors, 3);
    assert.equal(status.failure?.contentSubmissions, 0);
    assert.equal(fixture.counts().posts, 0);
  } finally {
    await fixture.close();
  }
});
test("different invalid field values do not count as repeated identical errors", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      for (const invalid of ["first", "second"]) {
        const draft = taskResult(options.spec) as unknown as {
          findings: { importance: string }[];
        };
        draft.findings[0].importance = invalid;
        assert.equal(
          (await options.execute("submit_evaluation", draftFor(options.spec, draft))).isError,
          true,
        );
      }
      assert.equal(
        (await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)))).terminate,
        true,
      );
    },
    async abort() {},
    async dispose() {},
  }));
  try {
    await fixture.start();
    assert.equal((await fixture.done()).state, "succeeded");
  } finally {
    await fixture.close();
  }
});
test("an unchanged error stops repair even when another field was fixed", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      const invalid = invalidResult(options.spec) as any;
      invalid.findings[0].evidence[0].quote = "wrong-a";
      invalid.findings.push({
        ...structuredClone(invalid.findings[0]),
        finding_id: "extra",
        evidence: [{ quote: "wrong-b" }],
      });
      await options.execute("submit_evaluation", draftFor(options.spec, invalid));
      invalid.findings[1].evidence[0].quote = "2+2=4";
      await options.execute("submit_evaluation", draftFor(options.spec, invalid));
    },
    async abort() {},
    async dispose() {},
  }));
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.equal(status.failure?.repeatedErrors, 2);
    assert.match(status.error || "", /Repeated validation errors/);
  } finally {
    await fixture.close();
  }
});
for (const reason of ["idle", "deadline", "cancel"] as const)
  test(`worker ${reason} aborts and disposes its own session`, async () => {
    let disposed = false,
      release: () => void = () => {};
    const fixture = await harness(
      async () => ({
        run: () =>
          new Promise<void>((r) => {
            release = r;
          }),
        async abort() {
          release();
        },
        async dispose() {
          disposed = true;
        },
      }),
      { idleTimeoutSeconds: reason === "idle" ? 1 : 10 },
    );
    try {
      if (reason === "deadline") fixture.spec.deadline = Date.now() + 200;
      await fixture.start();
      if (reason === "cancel") {
        await new Promise((r) => setTimeout(r, 100));
        await request(fixture.worker.url + "/api/attempts/attempt/cancel", "POST", {});
      }
      const status = await fixture.done();
      assert.equal(status.state, reason === "cancel" ? "cancelled" : "timed_out");
      assert.equal(disposed, true);
      assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
    } finally {
      await fixture.close();
    }
  });
test("mismatched engine and unknown tools are refused before a model session", async () => {
  let sessions = 0;
  const fixture = await harness(async () => {
    sessions++;
    throw new Error("Must not start");
  });
  try {
    await assert.rejects(
      request(fixture.worker.url + "/api/attempts", "POST", {
        ...fixture.spec,
        engine: { ...fakeIdentity, version: "changed" },
      }),
      /build/,
    );
    await assert.rejects(
      request(fixture.worker.url + "/api/attempts", "POST", {
        ...fixture.spec,
        evaluation: { ...fixture.spec.evaluation, toolNames: ["unavailable"] },
      }),
      /Tool unavailable/,
    );
    assert.equal(sessions, 0);
  } finally {
    await fixture.close();
  }
});
test("token budget aborts at the model response boundary", async () => {
  let aborted = false;
  const fixture = await harness(
    async (options) => ({
      async run() {
        options.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            usage: { input: 8, output: 2, totalTokens: 10 },
          },
        });
        await options.execute("read_trace", {
          candidate: "A",
          message_index: 1,
        });
      },
      async abort() {
        aborted = true;
      },
      async dispose() {},
    }),
    { maxTokens: 10 },
  );
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.match(status.error || "", /Token budget/);
    assert(aborted);
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally {
    await fixture.close();
  }
});

for (const message of ["Connection error.", "terminated", "Request timed out."])
  test(`transient SDK error is retryable: ${message}`, async () => {
    const fixture = await harness(async (options) => ({
      async run() {
        options.onEvent({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: message,
          },
        });
      },
      async abort() {},
      async dispose() {},
    }));
    try {
      await fixture.start();
      const status = await fixture.done();
      assert.equal(status.error, message);
      assert.equal(status.retryable, true);
    } finally {
      await fixture.close();
    }
  });

test("repair exhaustion preserves its cause instead of a generic SDK abort", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        await options.execute("submit_evaluation", draftFor(options.spec, {}));
        throw new Error("This operation was aborted");
      },
      async abort() {},
      async dispose() {},
    }),
    { repairAttempts: 0 },
  );
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.error, "Submission repair budget exhausted");
    assert.equal(status.retryable, false);
  } finally {
    await fixture.close();
  }
});
