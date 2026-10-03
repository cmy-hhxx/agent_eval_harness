import { draftFor } from "../../../tests/fixtures/comparison.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  DEFAULT_POLICY,
  emptyUsage,
  HttpError,
  type AgentBackend,
  type AttemptSpec,
  type AttemptStatus,
  type FailureContext,
  type RunManifest,
  type RunState,
  type Submission,
  type SubmissionReceipt,
  type TaskPlan,
  type TraceRead,
  type WorkerEvent,
} from "@eval/contracts";
import { body, json, listen, request } from "@eval/runtime/http";
import { createRunRepository, exists, readJson } from "@eval/data";
import { object } from "@eval/contracts";
import { services, prepare } from "../../../tests/fixtures/services.js";
import { buildPlan } from "@eval/workflows/comparison";
import { AgentRegistry, RunStore, type EvaluationServices } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import {
  fakeIdentity,
  emptyAudit,
  fixtureConfig,
  invalidResult,
  raw,
  taskResult,
  criteriaResult,
} from "../../../tests/fixtures/comparison.js";

async function harness(
  create: AgentBackend["createSession"],
  policy: Partial<typeof DEFAULT_POLICY> = {},
  dropAck = false,
  genericMaterial?: string,
) {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  const plan: TaskPlan = genericMaterial === undefined ? await buildPlan(config) : {
    tasks: [{ id: "material-task", stage: "material", inputIds: { answer: "material-input" }, dependencies: {}, data: {} }],
    inputs: { "material-input": { messages: [{ content: genericMaterial }, { content: "非必读正文" }] } },
    summary: {},
  };
  const task = plan.tasks.find((item) => item.stage === "attribution") ?? plan.tasks[0],
    criteria = plan.tasks.find((item) => item.id === task.dependencies.criteria);
  const criteriaReceipt: SubmissionReceipt | undefined = criteria && {
    taskId: criteria.id, attemptId: "criteria", submissionId: "criteria", status: "succeeded",
    acceptedAt: 1, evaluatorVersion: "fixture", judge: "fixture", evaluation: criteriaResult(), audit: emptyAudit(), usage: emptyUsage(),
  };
  const evaluationServices: EvaluationServices = genericMaterial === undefined ? services : {
    repository: createRunRepository<RunState>({
      encode: (state) => structuredClone(state), references: () => [], resultId: (row) => String(row.id), decode: (state) => state,
    }, (item, state) => ({ id: item.id, file: "material.jsonl", row: { id: item.id, result: state.receipts[item.id].evaluation } })),
    taskSource: {
      id: "material",
      bind(item, inputs) {
        const id = item.inputIds.answer;
        return { agent: "material", profile: "default", request: { input: {}, sources: { answer: { id, value: inputs[id] } } } };
      },
    },
    agents: new AgentRegistry([{ id: "material", profiles: { default: {
      id: "default", systemPrompt: "Read the material.", instructions: "Submit JSON.", submissionNudge: "Submit JSON.",
      toolNames: ["read_trace", "calculate"], fileSubmission: false,
      toolDescriptions: { read_trace: "Read source text.", calculate: "Calculate exactly.", submit_evaluation: "Submit JSON." },
      renderPrompt: () => "Read the material and submit JSON.", requestSchema: { type: "object" },
      submissionSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { const: true } } },
      requiredReads: () => [{ candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: genericMaterial.length }],
    } } }]),
  };
  const manifest: RunManifest = {
    format: "evaluation-run",
    debug: false,
    runId: "test",
    status: "running",
    engine: fakeIdentity,
    evaluatorVersion: "fixture",
    config,
    tasks: criteria ? [criteria, task] : [task],
    inputs: {},
    states: { ...(criteria ? { [criteria.id]: { status: "succeeded" as const, attempts: 1 } } : {}),
      [task.id]: { status: "pending", attempts: 0 } },
    preflight: plan.summary,
    startedAt: Date.now(),
  };
  const store = new RunStore(
    path.join(directory, "run"),
    { manifest, receipts: criteria ? { [criteria.id]: criteriaReceipt! } : {}, usage: emptyUsage(), recordedAttempts: 0 },
    plan.inputs,
    evaluationServices,
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
  const prepared = genericMaterial === undefined ? prepare(task, plan.inputs, { criteria: criteriaReceipt! }) :
    evaluationServices.agents.prepare(evaluationServices.taskSource.bind(task, plan.inputs, {}));
  const attemptPolicy = { ...DEFAULT_POLICY, ...policy };
  const spec: AttemptSpec = {
    inputRevision: 1,
    runId: "test",
    taskId: task.id,
    attemptId: "attempt",
    engine: fakeIdentity,
    evaluation: prepared.evaluation,
    prompt: prepared.renderAttempt(attemptPolicy),
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
    policy: attemptPolicy,
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
test("Host rejects malformed trace-read audits before accepting a submission", async () => {
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }));
  try {
    await fixture.store.activate(fixture.spec);
    const read = { candidate: "answer", message_index: 1, kind: "text", path: "/content", start: 0, end: 5 };
    for (const traceReads of [
      undefined,
      [{ ...read, candidate: "unknown" }],
      [{ ...read, message_index: -1 }],
      [{ ...read, start: 5, end: 4 }],
      [{ ...read, kind: "image" }],
      [{ ...read, kind: "json" }],
    ]) await assert.rejects(fixture.store.accept({
      submissionId: "invalid-audit", attemptId: fixture.spec.attemptId, taskId: fixture.spec.taskId,
      evaluation: {}, audit: { ...emptyAudit(), traceReads } as Submission["audit"], usage: emptyUsage(),
    }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid tool audit");
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});
test("Host rejects malformed table-check audit specs at the submission boundary", async () => {
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }));
  try {
    await fixture.store.activate(fixture.spec);
    const source = { table_id: "table-source", key_columns: [{ answer: 0, source: 0 }], value_columns: [{ answer: 1, source: 1 }] };
    const spec = { candidate: "answer", answer_table_id: "table-final", sources: [source] };
    const audit = (tableChecks: unknown) => ({ ...emptyAudit(), tableChecks }) as Submission["audit"];
    const submit = (audit: Submission["audit"]) => request(`${fixture.spec.hostUrl}/api/submissions`, "POST", {
      submissionId: "invalid-table-audit", attemptId: fixture.spec.attemptId, taskId: fixture.spec.taskId,
      evaluation: {}, audit, usage: emptyUsage(),
    });
    for (const tableChecks of [
      null, {}, [null], [{ ...spec, candidate: "unknown" }], [{ ...spec, answer_table_id: " " }],
      [{ ...spec, matches: true }], [{ ...spec, sources: [] }], [{ ...spec, sources: [source, source] }],
      [{ ...spec, sources: [{ ...source, table_id: "" }] }],
      [{ ...spec, sources: [{ ...source, table_id: spec.answer_table_id }] }],
      [{ ...spec, sources: [{ ...source, result: { matches: true } }] }],
      [{ ...spec, sources: [{ ...source, key_columns: [] }] }],
      [{ ...spec, sources: [{ ...source, value_columns: [] }] }],
      [{ ...spec, sources: [{ ...source, key_columns: [{ answer: -1, source: 0 }] }] }],
      [{ ...spec, sources: [{ ...source, key_columns: [{ answer: 0.5, source: 0 }] }] }],
      [{ ...spec, sources: [{ ...source, key_columns: [{ answer: 0, source: Number.MAX_SAFE_INTEGER + 1 }] }] }],
      [{ ...spec, sources: [{ ...source, key_columns: [{ answer: 0, source: 0, matches: true }] }] }],
      [{ ...spec, sources: [{ ...source, key_columns: [{ answer: 0, source: 0 }, { answer: 0, source: 2 }] }] }],
      [{ ...spec, sources: [{ ...source, key_columns: [{ answer: 0, source: 0 }, { answer: 2, source: 0 }] }] }],
      [{ ...spec, sources: [{ ...source, value_columns: [{ answer: 0, source: 1 }] }] }],
      [{ ...spec, sources: [{ ...source, value_columns: [{ answer: 1, source: 0 }] }] }],
      [{ ...spec, sources: [source, { ...source, table_id: "other", value_columns: [{ answer: 2, source: 1 }] }] }],
    ]) await assert.rejects(submit(audit(tableChecks)), (error: unknown) =>
      error instanceof HttpError && error.status === 400 && error.message === "Invalid tool audit", JSON.stringify(tableChecks));
    // Valid audit shapes reach the Agent's evaluation validation (the empty evaluation is intentionally invalid).
    for (const tableChecks of [undefined, [], [spec], [{ ...spec, sources: [source, { ...source, table_id: "other" }] }]])
      await assert.rejects(submit(audit(tableChecks)), (error: unknown) => error instanceof HttpError && error.status === 422);
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});
test("a burst of model events is persisted in batches with complete ordered replay", async (t) => {
  const append = fs.appendFile;
  let writes = 0;
  t.mock.method(fs, "appendFile", async (...args: Parameters<typeof append>) => {
    if (String(args[0]).endsWith("events.jsonl")) writes++;
    return append(...args);
  });
  syncBuiltinESMExports();
  const fixture = await harness(async (options) => ({
    async run() {
      for (let i = 0; i < 200; i++) options.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: String(i) } });
      await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
    }, async abort() {}, async dispose() {},
  }));
  try {
    await fixture.start();
    assert.equal((await fixture.done()).state, "succeeded");
    const response = await fetch(`${fixture.worker.url}/api/attempts/attempt/events?after=0`);
    const events = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as WorkerEvent);
    assert.equal(events.filter((event) => event.type === "model").length, 200);
    assert.deepEqual(events.map((event) => event.seq), events.map((_, i) => i + 1));
    const persisted = (await readFile(path.join(fixture.directory, "worker/attempt/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as WorkerEvent);
    assert.deepEqual(persisted, events);
    assert(writes < 10, `a burst must not open and append once per delta: ${writes}`);
  } finally {
    await fixture.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

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
    assert(await exists(path.join(workdir, "inputs/answer.json")));
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
          candidate: "answer",
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
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.equal(receipt?.audit.calls, 1);
    assert.deepEqual(receipt?.audit.traceReads, [{
      candidate: "answer", message_index: 1, kind: "json", path: "", start: 0,
      end: JSON.stringify(raw("q", null).messages[1], null, 2).length,
    }]);
  } finally {
    await fixture.close();
  }
});
test("generic required text stays readable beyond twelve pages after exploration is exhausted", async () => {
  const material = '材料"\\\n🙂'.repeat(40000);
  let pages = 0, recovered = "";
  const fixture = await harness(async (options) => ({
    async run() {
      for (let i = 0; i < options.spec.policy.maxToolCalls; i++) {
        const result = await options.execute("calculate", { operation: "add", operands: ["1", "2"] });
        assert.notEqual(result.isError, true);
      }
      let offset = 0;
      do {
        const args = { candidate: "answer", message_index: 0, path: "/content", offset };
        const result = await options.execute("read_trace", args);
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const blocks = result.content.map((item) => JSON.parse(item.text!));
        assert(result.content.map((item) => item.text!).join("\n").length <= options.spec.policy.maxOutputChars);
        const page = blocks[0], budget = blocks.at(-1).budget;
        assert.equal(page.source.kind, "text");
        assert.equal(page.source.path, "/content");
        assert.equal(page.offset, offset);
        assert(page.next_offset > offset);
        assert.equal(page.total_chars, material.length);
        assert.equal(page.evidence.length, 1);
        assert.equal(page.evidence[0].quote, material.slice(offset, page.next_offset));
        recovered += page.evidence[0].quote;
        pages++;
        assert.equal(budget.required_reads.used, pages);
        assert.equal(budget.exploration.used, options.spec.policy.maxToolCalls);
        assert.equal(budget.exploration.remaining, 0);
        if (pages === 1) {
          for (const forbidden of [
            args,
            { ...args, offset: page.next_offset, max_chars: 1 },
            { ...args, offset: page.next_offset, max_chars: 12000 },
            { ...args, message_index: 1 },
            { ...args, offset: "invalid" },
          ]) assert.equal((await options.execute("read_trace", forbidden)).isError, true,
            "duplicates, small pages, undeclared sources and invalid arguments consume exploration");
        }
        offset = page.next_offset;
        if (!page.has_more) break;
      } while (offset < material.length);
      assert.equal(recovered, material);
      assert(pages > 12);
      assert.equal((await options.execute("submit_evaluation", { ok: true })).terminate, true);
    },
    async abort() {}, async dispose() {},
  }), { maxToolCalls: 12, repairAttempts: 2 }, false, material);
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.deepEqual(receipt?.evaluation, { ok: true });
    assert.equal(receipt?.audit.requiredReadCalls, pages);
    assert.equal(receipt?.audit.calls, 12 + pages);
    assert(receipt!.audit.calls > fixture.spec.policy.maxToolCalls + fixture.spec.policy.repairAttempts);
    assert.equal(receipt?.audit.traceReads.length, pages);
  } finally { await fixture.close(); }
});

test("Host refuses forged required-read counts without matching new declared reads", async () => {
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }), {}, false, "材料".repeat(1000));
  const read: TraceRead = fixture.spec.evaluation.requiredReads![0];
  const audits = [
    { ...emptyAudit(), requiredReadCalls: undefined },
    { ...emptyAudit(), calls: 1, requiredReadCalls: -1 },
    { ...emptyAudit(), calls: 1, requiredReadCalls: 0.5 },
    { ...emptyAudit(), calls: 1, requiredReadCalls: 2 },
    { ...emptyAudit(), calls: 15 },
    { ...emptyAudit(), calls: 15, requiredReadCalls: 1 },
    { ...emptyAudit(), calls: 1, requiredReadCalls: 1, traceReads: [{ ...read, kind: "json" as const, path: "", end: 1 }] },
    { ...emptyAudit(), calls: 1, requiredReadCalls: 1, traceReads: [{ ...read, message_index: 1, end: 2 }] },
    { ...emptyAudit(), calls: 2, requiredReadCalls: 2, traceReads: [read, read] },
    { ...emptyAudit(), calls: 3, requiredReadCalls: 3, traceReads: [
      { ...read, end: 600 }, { ...read, start: 600, end: 1200 }, { ...read, start: 1200 },
    ] },
  ];
  try {
    await fixture.store.activate(fixture.spec);
    for (const [index, audit] of audits.entries())
      await assert.rejects(request(`${fixture.spec.hostUrl}/api/submissions`, "POST", {
        submissionId: `invalid-required-audit-${index}`, attemptId: fixture.spec.attemptId, taskId: fixture.spec.taskId,
        evaluation: { ok: true }, audit, usage: emptyUsage(),
      }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid tool audit", JSON.stringify(audit));
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});

test("a task without declared required material cannot claim a reading allowance", async () => {
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }), {}, false, "材料");
  fixture.spec.evaluation.requiredReads = [];
  try {
    await fixture.store.activate(fixture.spec);
    await assert.rejects(request(`${fixture.spec.hostUrl}/api/submissions`, "POST", {
      submissionId: "undeclared-required-audit", attemptId: fixture.spec.attemptId, taskId: fixture.spec.taskId,
      evaluation: { ok: true }, usage: emptyUsage(),
      audit: { ...emptyAudit(), calls: 15, requiredReadCalls: 1,
        traceReads: [{ candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: 2 }] },
    }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid tool audit");
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});

test("file submission repairs a rejected evidence ID after exploration is exhausted", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        await options.execute("read_trace", {
          candidate: "answer",
          message_index: 1,
        });
        const invalid = draftFor(options.spec, taskResult(options.spec)) as any;
        invalid.findings[0].evidence[0].evidence_id = "ev_1_text_0_8192_/content";
        const rejected = await options.execute("submit_evaluation", invalid);
        assert.equal(rejected.isError, true);
        const feedback = JSON.parse(rejected.content[0]!.text!);
        assert.equal(feedback.draft_file, "evaluation-draft.json");
        const issue = feedback.errors.find((item: { code: string }) => item.code === "evidence_range_invalid");
        assert(issue, "Host rejection must preserve actionable evidence feedback through Worker");
        const replacement = issue.expected.suggested_evidence.find((item: { quote: string }) => item.quote === "2+2=4");
        assert(replacement, "repair must select a source-backed quote from feedback");
        assert.deepEqual(
          await readJson(path.join(options.workdir, "evaluation-draft.json")),
          invalid,
        );
        const fixed = await options.execute("execute_code", {
          language: "python",
          code: "import json\nfrom pathlib import Path\np=Path('evaluation-draft.json')\nr=json.loads(p.read_text())\nr['findings'][0]['evidence'][0]['evidence_id']=VALID_ID\np.write_text(json.dumps(r,ensure_ascii=False))".replace(
            "VALID_ID",
            JSON.stringify(replacement.evidence_id),
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
test("a missing submission file does not invent a saved repair draft", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      const rejected = await options.execute("submit_evaluation_file", { path: "evaluation-draft.json" });
      assert.equal(rejected.isError, true);
      const feedback = JSON.parse(rejected.content[0]!.text!);
      assert.equal(await exists(path.join(options.workdir, "evaluation-draft.json")), false);
      assert.equal(Object.hasOwn(feedback, "draft_file"), false);
      assert.doesNotMatch(feedback.message, /已保存/);
      assert.match(feedback.message, /submit_evaluation/);
      assert.equal(
        (await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)))).terminate,
        true,
      );
    },
    async abort() {}, async dispose() {},
  }), { repairAttempts: 0 });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.deepEqual((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats, {
      contentSubmissions: 1,
      fileErrors: 1,
    });
  } finally { await fixture.close(); }
});
test("a rejected draft without file submission capability requests a complete direct submission", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      assert.deepEqual(options.tools.filter((tool) => tool.name.startsWith("submit_evaluation")).map((tool) => tool.name),
        ["submit_evaluation"]);
      const unavailable = await options.execute("submit_evaluation_file", { path: "evaluation-draft.json" });
      assert.equal(unavailable.isError, true);
      assert.match(unavailable.content[0]!.text!, /Unknown tool/);
      assert.equal(await exists(path.join(options.workdir, "evaluation-draft.json")), false);
      const invalid = draftFor(options.spec, invalidResult(options.spec));
      const rejected = await options.execute("submit_evaluation", invalid);
      assert.equal(rejected.isError, true);
      const feedback = JSON.parse(rejected.content[0]!.text!);
      assert.deepEqual(await readJson(path.join(options.workdir, "evaluation-draft.json")), invalid);
      assert.equal(Object.hasOwn(feedback, "draft_file"), false);
      assert.match(feedback.message, /完整 JSON/);
      assert.match(feedback.message, /submit_evaluation/);
      assert.equal(
        (await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)))).terminate,
        true,
      );
    },
    async abort() {}, async dispose() {},
  }), { repairAttempts: 1 });
  fixture.spec.evaluation.fileSubmission = false;
  fixture.spec.evaluation.toolDescriptions = { ...fixture.spec.evaluation.toolDescriptions };
  delete fixture.spec.evaluation.toolDescriptions.submit_evaluation_file;
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.deepEqual((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats, {
      contentSubmissions: 2,
      fileErrors: 0,
    });
  } finally { await fixture.close(); }
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
    assert.equal(status.failure?.stopped, true);
    assert.equal(status.retryable, false, "repeated business errors must not become retryable interruptions");
    assert.match(status.error || "", /Repeated validation errors/);
  } finally {
    await fixture.close();
  }
});
test("resuming a failed draft gets a repair opportunity within the new attempt", async () => {
  let recovery: FailureContext | undefined;
  const failed = await harness(async (options) => ({
    async run() {
      const draft = draftFor(options.spec, invalidResult(options.spec));
      await options.execute("submit_evaluation", draft);
      await options.execute("submit_evaluation", draft);
    },
    async abort() {}, async dispose() {},
  }));
  try {
    await failed.start();
    const status = await failed.done();
    assert.equal(status.state, "failed");
    assert.equal(status.failure?.repeatedErrors, 2);
    recovery = { ...status.failure!, attemptId: "previous-attempt" };
  } finally { await failed.close(); }
  const resumed = await harness(async (options) => ({
    async run() {
      assert.equal(await exists(path.join(options.workdir, "evaluation-draft.json")), false,
        "a stopped draft must not be offered as a repair file in a fresh attempt");
      assert.equal((await options.execute("submit_evaluation", draftFor(options.spec, invalidResult(options.spec)))).isError, true);
      assert.equal((await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    },
    async abort() {}, async dispose() {},
  }));
  resumed.spec.recovery = recovery;
  try {
    await resumed.start();
    assert.equal((await resumed.done()).state, "succeeded");
    assert.equal(resumed.counts().posts, 2);
  } finally { await resumed.close(); }
});

test("a session that stops before submitting gets one nudge and can still succeed", async () => {
  const prompts: string[] = [];
  const fixture = await harness(async (options) => ({
    async run(prompt) {
      prompts.push(prompt);
      if (prompts.length === 1) return;
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
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /任务材料/);
    assert.match(prompts[1]!, /没有收到通过校验的提交/);
  } finally {
    await fixture.close();
  }
});
test("a session that ignores the nudge fails after one bounded follow-up and can retry without a draft", async () => {
  let runs = 0;
  const fixture = await harness(async () => ({
    async run() {
      runs++;
    },
    async abort() {},
    async dispose() {},
  }));
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.equal(runs, 2);
    assert.equal(status.error, "Agent ended without an accepted submission");
    assert.equal(status.retryable, true);
    assert.equal(status.failure?.errors[0]?.category, "interruption");
    assert.equal(status.failure?.contentSubmissions, 0);
    assert.equal(status.failure?.draft, undefined);
  } finally {
    await fixture.close();
  }
});
for (const reason of ["no-submission", "idle"] as const)
  for (const stopped of [false, true])
    test(`an unsubmitted ${reason} recovery preserves repair state (stopped: ${stopped})`, async () => {
      const draft = { invalid: true };
      const issue = { category: "structure" as const, code: "invalid_draft", path: "/invalid", message: "Invalid draft" };
      let release = () => {};
      const fixture = await harness(async (options) => ({
        async run() {
          assert.equal(await exists(path.join(options.workdir, "evaluation-draft.json")), !stopped);
          if (reason === "idle") await new Promise<void>((resolve) => { release = resolve; });
        },
        async abort() { release(); }, async dispose() {},
      }), { idleTimeoutSeconds: reason === "idle" ? 1 : 10 });
      fixture.spec.recovery = {
        draft, errors: [issue], contentSubmissions: 2, fileErrors: 1, repeatedErrors: 2, stopped, attemptId: "previous-attempt",
      };
      try {
        await fixture.start();
        const status = await fixture.done();
        assert.equal(status.state, reason === "idle" ? "timed_out" : "failed");
        assert.equal(status.retryable === true, stopped, "only an attempt without a resumable business draft uses interruption retries");
        assert.equal(status.failure?.contentSubmissions, 2);
        assert.equal(status.failure?.fileErrors, 1);
        assert.equal(status.failure?.repeatedErrors, 0);
        assert.equal(status.failure?.stopped, false);
        assert.equal(status.failure?.attemptId, fixture.spec.attemptId);
        assert.deepEqual(status.failure?.draft, stopped ? undefined : draft);
        assert.equal(status.failure?.errors[0]?.category, "interruption");
        assert.deepEqual(status.failure?.errors.slice(1), stopped ? [] : [issue]);
      } finally { await fixture.close(); }
    });
for (const reason of ["idle", "deadline", "cancel"] as const)
  test(`worker ${reason} aborts and disposes its own session`, async () => {
    let disposed = false, running = false,
      release: () => void = () => {};
    const fixture = await harness(
      async () => ({
        run: () =>
          new Promise<void>((r) => {
            release = r;
            running = true;
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
      // Allow session setup IO under load before testing deadline-driven disposal.
      if (reason === "deadline") fixture.spec.deadline = Date.now() + 2000;
      await fixture.start();
      if (reason === "cancel") {
        for (let i = 0; i < 200 && !running; i++)
          await new Promise((r) => setTimeout(r, 25));
        assert.equal(running, true, "cancel only after the session exists");
        await request(fixture.worker.url + "/api/attempts/attempt/cancel", "POST", {});
      }
      const status = await fixture.done();
      assert.equal(status.state, reason === "cancel" ? "cancelled" : "timed_out");
      if (reason === "idle") {
        assert.equal(status.error, "Model/tool idle timeout");
        assert.equal(status.retryable, true);
        assert.equal(status.failure?.errors[0]?.category, "interruption");
        assert.equal(status.failure?.contentSubmissions, 0);
        assert.equal(status.failure?.draft, undefined);
      } else assert.notEqual(status.retryable, true, "cancellation and the task deadline cannot trigger automatic retry");
      assert.equal(disposed, true);
      assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
    } finally {
      await fixture.close();
    }
  });
test("mismatched engine, unknown tools and missing descriptions are refused before a model session", async () => {
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
    await assert.rejects(
      request(fixture.worker.url + "/api/attempts", "POST", {
        ...fixture.spec,
        evaluation: {
          ...fixture.spec.evaluation,
          toolDescriptions: { submit_evaluation: "Only one submission description" },
        },
      }),
      /Invalid evaluation tool descriptions/,
    );
    await assert.rejects(
      request(fixture.worker.url + "/api/attempts", "POST", {
        ...fixture.spec,
        evaluation: { ...fixture.spec.evaluation, submissionNudge: " " },
      }),
      /Invalid evaluation spec/,
    );
    assert.equal(sessions, 0);
  } finally {
    await fixture.close();
  }
});
test("malformed required-material specs are refused before creating a model session", async () => {
  let sessions = 0;
  const fixture = await harness(async () => {
    sessions++;
    throw new Error("Must not start");
  }, {}, false, "材料");
  const read = fixture.spec.evaluation.requiredReads![0];
  try {
    for (const requiredReads of [
      null, {}, [null], [{ ...read, candidate: "unknown" }], [{ ...read, message_index: -1 }],
      [{ ...read, kind: "json" }], [{ ...read, path: undefined }], [{ ...read, start: -1 }],
      [{ ...read, start: 0.5 }], [{ ...read, end: 0 }], [{ ...read, start: 2, end: 1 }],
      [{ ...read, end: Number.MAX_SAFE_INTEGER + 1 }],
    ]) await assert.rejects(request(`${fixture.worker.url}/api/attempts`, "POST", {
      ...fixture.spec, evaluation: { ...fixture.spec.evaluation, requiredReads },
    }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid required material ranges");
    await assert.rejects(request(`${fixture.worker.url}/api/attempts`, "POST", {
      ...fixture.spec,
      evaluation: { ...fixture.spec.evaluation, toolNames: ["calculate"],
        toolDescriptions: { calculate: "Calculate exactly.", submit_evaluation: "Submit JSON." } },
    }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid required material ranges");
    for (const inputs of [undefined, null, {}, [null], [{ id: 1, name: "answer" }], [fixture.spec.inputs[0], fixture.spec.inputs[0]]])
      await assert.rejects(request(`${fixture.worker.url}/api/attempts`, "POST", { ...fixture.spec, inputs }),
        (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid input refs");
    assert.equal(sessions, 0);
  } finally { await fixture.close(); }
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
          candidate: "answer",
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

for (const [message, retryable] of [
  ["Connection error.", true],
  ["terminated", true],
  ["Request timed out.", true],
  ['evaluation-gateway API error (529): {"message":"当前服务集群负载较高，请稍后重试，感谢您的耐心等待。 (2064)","code":"server_error"}', true],
  ["HTTP 503 Service Unavailable", true],
  ["HTTP/2 500 Internal Server Error", true],
  ["Invalid OpenAI Responses tool arguments: submit_evaluation (call_01a0fc93466c7cd2907ddcf5|070ed59d2f624fb64934837f33bc1803_fc_0); expected complete JSON object", true],
  ["Invalid OpenAI Responses tool arguments: fc_123; expected JSON object", true],
  ["Evaluation validation failed: Invalid OpenAI Responses tool arguments: submit_evaluation (call_123); expected complete JSON object", false],
  ["Invalid OpenAI Responses tool arguments: submit_evaluation (call_123); expected complete JSON object; wrong business criteria", false],
  ["Evaluation validation failed: expected 529 characters", false],
  ["Evaluation validation failed: expected 503 characters", false],
  ["evaluation-gateway API error (422): invalid request", false],
] as const)
  test(`SDK error retryable=${retryable}: ${message}`, async () => {
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
      fixture.spec.model.api = "openai-responses";
      await fixture.start();
      const status = await fixture.done();
      assert.equal(status.error, message);
      assert.equal(status.retryable, retryable);
      assert.equal(status.failure?.errors[0]?.category, retryable ? "transport" : "interruption");
    } finally {
      await fixture.close();
    }
  });

test("an ordinary thrown error cannot impersonate an SDK malformed-arguments response", async () => {
  const message = "Invalid OpenAI Responses tool arguments: submit_evaluation (call_123); expected complete JSON object";
  const fixture = await harness(async () => ({ async run() { throw new Error(message); }, async abort() {}, async dispose() {} }));
  try {
    fixture.spec.model.api = "openai-responses";
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.error, message);
    assert.equal(status.retryable, false);
    assert.equal(status.failure?.errors[0]?.category, "interruption");
  } finally { await fixture.close(); }
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
