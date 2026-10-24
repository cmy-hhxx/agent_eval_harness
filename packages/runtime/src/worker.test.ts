import { draftFor, submitFor } from "../../../tests/fixtures/comparison.js";
import { canonicalEvidence } from "../../../tests/fixtures/evidence.js";
import { waitForTestState } from "../../../tests/fixtures/wait.js";
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
  ValidationError,
  type AgentBackend,
  type AgentProfile,
  type MaterialInspection,
  type AttemptSpec,
  type AttemptStatus,
  type FailureContext,
  type RunManifest,
  type RunState,
  type Submission,
  type SubmissionReceipt,
  type TaskPlan,
  type TraceRead,
  type ValidationIssue,
  type WorkerEvent,
} from "@eval/contracts";
import { body, json, listen, request } from "@eval/runtime/http";
import { createRunRepository, exists, readJson } from "@eval/data";
import { object } from "@eval/contracts";
import { services } from "../../../tests/fixtures/services.js";
import { attributionAgent } from "@eval/agents/attribution";
import { traceReadCoverage } from "@eval/tools";
import { buildPlan, type AttributionResult } from "@eval/workflows/comparison";
import { AgentRegistry, RunStore, type EvaluationServices } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import {
  fakeIdentity,
  emptyAudit,
  fixtureConfig,
  invalidDraft,
  inspectMaterials,
  raw,
  taskResult,
  criteriaResult,
  parsedMaterial,
} from "../../../tests/fixtures/comparison.js";

interface WorkerHarnessOptions {
  policy?: Partial<typeof DEFAULT_POLICY>;
  dropAck?: boolean;
  material?: string;
  profile?: Partial<AgentProfile>;
  dropInspectionAck?: boolean;
  revealedInput?: import("@eval/contracts").JsonObject;
}

const fileProfile: Partial<AgentProfile> = {
  fileSubmission: true, jsonStringSubmission:false, draftWriteInCallLimit:false,
  toolDescriptions: {
    ...Object.fromEntries(Object.entries(attributionAgent.profiles.default.toolDescriptions).filter(([name])=>name!=="submit_evaluation")),
    submit_evaluation_file: "Submit the complete evaluation JSON file.",
  },
};

test("saved flat findings survive later drafting and repair without extra call allowance", async () => {
  const problems = [
    { text: "混用不同期间", reason: "2024-05-07：13.82；2024-05-06：13.40。", evidence_indices: [1, 2] },
    { text: "比例计算不符", reason: "部分7、总量25，占比28%。", evidence_indices: [2, 3] },
  ];
  const fixture = await harness(async options => ({ async run() {
    const write = (fields: object) => options.execute("edit_json", { path: "evaluation-draft.json", set_json: JSON.stringify(fields) });
    const first = await write({ problems });
    assert.equal(first.isError, undefined);
    assert.equal(object(object(object(first.details).budget).exploration).remaining, 1);
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    const complete = await write({ summary: 7 });
    assert.equal(complete.isError, undefined);
    const rejected = await options.execute("submit_evaluation_file", { path: "evaluation-draft.json" });
    assert.equal(rejected.isError, true);
    assert.equal(object(object(object(rejected.details).budget).exploration).remaining, 2, "one of the three repair calls is reserved for drafting");
    for (let index = 0; index < 2; index++)
      await options.execute("calculate", { operation: "add", operands: ["1", "1"] });
    const repaired = await write({ summary: "保留两条已确认问题" });
    assert.equal(repaired.isError, undefined);
    assert.equal((await options.execute("submit_evaluation_file", { path: "evaluation-draft.json" })).terminate, true);
  }, async abort() {}, async dispose() {} }), {
    material: "source", policy: { maxToolCalls: 3, repairAttempts: 1 },
    profile: { ...fileProfile, draftWriteInCallLimit: attributionAgent.profiles.default.draftWriteInCallLimit,
      toolNames: ["read_trace", "calculate", "edit_json"], requiredReads: () => [],
      toolDescriptions: { read_trace: "Read source.", calculate: "Calculate.", edit_json: "Update draft.", submit_evaluation_file: "Submit draft." },
      submissionSchema: { type: "object", required: ["summary", "problems"], properties: {
        summary: { type: "string" }, problems: { type: "array", items: { type: "object" } },
      } },
    },
  });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
    assert.deepEqual(object(receipt.submitted).problems, problems);
    assert.deepEqual(object(receipt.evaluation).problems, problems);
    assert.equal(receipt.audit.calls, 6, "three initial calls plus three repair calls, including both reserved writes");
    assert.deepEqual(receipt.submissionStats, { contentSubmissions: 2, fileErrors: 0 });
  } finally { await fixture.close(); }
});

test("JSON text submission preserves nested rows, empty arrays and markup without a model-written file", async()=>{
  const original={summary:'中文 "引号" </summary>',problems:[{text:"记录保留原样",component:[]}],values:[false,null,0]};
  const fixture=await harness(async options=>({async run(){
    const tool=options.tools.find(tool=>tool.name==="submit_evaluation")!;
    assert.deepEqual(tool.inputSchema,{type:"object",additionalProperties:false,required:["json"],properties:{json:{type:"string",minLength:2}}});
    assert(tool.description.includes('"json_content_schema"'));
    assert.equal((await options.execute("submit_evaluation",{json:JSON.stringify(original)})).terminate,true);
  },async abort(){},async dispose(){}}),{material:"fixture",profile:{jsonStringSubmission:true,requiredReads:()=>[],submissionSchema:{type:"object"}}});
  try{
    await fixture.start();assert.equal((await fixture.done()).state,"succeeded");
    const receipt=await fixture.store.receipt(fixture.spec.taskId);
    assert.deepEqual(receipt!.submitted,original);
    assert.deepEqual(receipt!.evaluation,original);
    assert.equal(receipt!.submissionStats!.contentSubmissions,1);
    assert.equal(receipt!.submissionStats!.fileErrors,0);
  }finally{await fixture.close();}
});

test("invalid JSON text uses the loading budget and preserves content repair attempts",async()=>{
  const fixture=await harness(async options=>({async run(){
    const rejected=await options.execute("submit_evaluation",{json:'{"ok":'});
    assert.equal(rejected.isError,true);
    const feedback=JSON.parse(rejected.content[0].text!);
    assert(feedback.errors.some((issue:ValidationIssue)=>issue.code==="submission_json_invalid"));
    assert.equal(feedback.budget.content_remaining,2);
    assert.equal((await options.execute("submit_evaluation",{json:'{"ok":true}'})).terminate,true);
  },async abort(){},async dispose(){}}),{material:"fixture",policy:{repairAttempts:1},profile:{jsonStringSubmission:true,requiredReads:()=>[]}});
  try{
    await fixture.start();assert.equal((await fixture.done()).state,"succeeded");
    const receipt=await fixture.store.receipt(fixture.spec.taskId);
    assert.equal(receipt!.submissionStats!.contentSubmissions,1);
    assert.equal(receipt!.submissionStats!.fileErrors,1);
    assert.equal(receipt!.submissionStats!.jsonRepairs,undefined);
    assert.equal(fixture.counts().posts,1);
  }finally{await fixture.close();}
});

test("surplus closing punctuation after a complete JSON object is repaired without changing values", async () => {
  const original = { text: '正文中的 } ] 和 "引号"', values: [null, false, 0], nested: { rows: [] } };
  const fixture = await harness(async options => ({ async run() {
    assert.equal((await options.execute("submit_evaluation", { json: JSON.stringify(original) + "}\n]" })).terminate, true);
  }, async abort() {}, async dispose() {} }), { material: "fixture", profile: {
    jsonStringSubmission: true, requiredReads: () => [], submissionSchema: { type: "object" },
  } });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.deepEqual(receipt!.evaluation, original);
    assert.equal(receipt!.submissionStats!.jsonRepairs, 1);
    assert.equal(receipt!.submissionStats!.fileErrors, 0);
  } finally { await fixture.close(); }
});

test("trailing content and incomplete JSON are not discarded as closing punctuation", async () => {
  for (const json of ['{"ok":true}{"other":false}', '{"ok":true},"other":false}', '{"ok":true', '{"ok":true} explanation']) {
    const fixture = await harness(async options => ({ async run() {
      const rejected = await options.execute("submit_evaluation", { json });
      assert.equal(rejected.isError, true);
      assert((rejected.details as { errors: ValidationIssue[] }).errors.some(issue => issue.code === "submission_json_invalid"));
      assert.equal((await options.execute("submit_evaluation", { json: '{"ok":true}' })).terminate, true);
    }, async abort() {}, async dispose() {} }), { material: "fixture",
      profile: { jsonStringSubmission: true, requiredReads: () => [] } });
    try {
      await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
      assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.jsonRepairs, undefined);
    } finally { await fixture.close(); }
  }
});

test("unescaped quotes inside JSON strings are escaped deterministically and audited",async()=>{
  const fixture=await harness(async options=>({async run(){
    const result=await options.execute("submit_evaluation",{json:'{"text":"标注"冲高回落"指向"}'});
    assert.equal(result.terminate,true);
  },async abort(){},async dispose(){}}),{material:"fixture",profile:{jsonStringSubmission:true,requiredReads:()=>[],
    submissionSchema:{type:"object",additionalProperties:false,required:["text"],properties:{text:{type:"string"}}}}});
  try{
    await fixture.start();assert.equal((await fixture.done()).state,"succeeded");
    const receipt=await fixture.store.receipt(fixture.spec.taskId);
    assert.deepEqual(receipt!.evaluation,{text:'标注"冲高回落"指向'});
    assert.equal(receipt!.submissionStats!.jsonRepairs,1);
    assert.equal(receipt!.submissionStats!.contentSubmissions,1);
  }finally{await fixture.close();}
});

test("structural JSON errors still fail instead of inventing a repair",async()=>{
  const fixture=await harness(async options=>({async run(){
    const rejected=await options.execute("submit_evaluation",{json:'{"text":"a" "b":"c"}'});
    assert.equal(rejected.isError,true);
    const feedback=JSON.parse(rejected.content[0].text!);
    const issue=feedback.errors.find((item:ValidationIssue)=>item.code==="submission_json_invalid");
    assert.match(issue.message,/无法安全修复/u);
    assert.match(issue.message,/英文双引号必须转义/u);
    assert((issue.actual as {position:number}).position>=0);
    assert.equal((await options.execute("submit_evaluation",{json:'{"ok":true}'})).terminate,true);
  },async abort(){},async dispose(){}}),{material:"fixture",policy:{repairAttempts:1},profile:{jsonStringSubmission:true,requiredReads:()=>[]}});
  try{
    await fixture.start();assert.equal((await fixture.done()).state,"succeeded");
    const receipt=await fixture.store.receipt(fixture.spec.taskId);
    assert.equal(receipt!.submissionStats!.contentSubmissions,1);
  }finally{await fixture.close();}
});

test("raw control characters inside JSON strings are escaped without changing text",async()=>{
  const original={summary:"第一行\n第二行\t结束",values:[1]};
  const fixture=await harness(async options=>({async run(){
    const result=await options.execute("submit_evaluation",{json:'{"summary":"第一行\n第二行\t结束","values":[1]}'});
    assert.equal(result.terminate,true);
  },async abort(){},async dispose(){}}),{material:"fixture",profile:{jsonStringSubmission:true,requiredReads:()=>[],submissionSchema:{type:"object"}}});
  try{
    await fixture.start();assert.equal((await fixture.done()).state,"succeeded");
    const receipt=await fixture.store.receipt(fixture.spec.taskId);
    assert.deepEqual(receipt!.submitted,original);
    assert.equal(receipt!.submissionStats!.contentSubmissions,1);
  }finally{await fixture.close();}
});

async function harness(
  create: AgentBackend["createSession"],
  { policy = {}, dropAck = false, material, profile, dropInspectionAck = false,
    revealedInput = { upstream: "hidden conclusion" } }: WorkerHarnessOptions = {},
) {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  let closeHost: (() => Promise<void>) | undefined;
  let closeWorker: (() => Promise<void>) | undefined;
  const close = async () => {
    try {
      await closeWorker?.();
    } finally {
      try {
        await closeHost?.();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const plan: TaskPlan = material === undefined ? await buildPlan(config) : {
      tasks: [{ id: "material-task", stage: "material", inputIds: { answer: "11111111-1111-4111-8111-111111111111" }, dependencies: {}, data: {} }],
      inputs: { "11111111-1111-4111-8111-111111111111": { messages: [{ content: material }, { content: "非必读正文" }] } },
      summary: {},
    };
    const task = plan.tasks.find((item) => item.stage === "attribution") ?? plan.tasks[0],
      criteria = plan.tasks.find((item) => item.id === task.dependencies.criteria);
    const criteriaReceipt: SubmissionReceipt | undefined = criteria && {
      taskId: criteria.id, attemptId: "criteria", submissionId: "criteria", status: "succeeded",
      acceptedAt: 1, evaluatorVersion: "fixture", judge: "fixture", evaluation: criteriaResult(), audit: emptyAudit(), usage: emptyUsage(),
    };
    const evaluationServices: EvaluationServices = material === undefined ? {
      ...services,
      ...(profile ? { agents: new AgentRegistry([{ ...attributionAgent, profiles: {
        default: { ...attributionAgent.profiles.default, ...(profile.fileSubmission ? {jsonStringSubmission:false}:{}), ...profile },
      } }]) } : {}),
    } : {
      repository: createRunRepository<RunState>({
        encode: (state) => structuredClone(state), references: () => [], resultId: (row) => String(row.id), decode: (state) => state,
      }, (item, state) => ({ id: item.id, file: "material.jsonl", row: { id: item.id, result: state.receipts[item.id].evaluation } })),
      taskSource: {
        id: "material",
        bind(item, inputs) {
          const id = item.inputIds.answer;
          return { agent: "material", profile: "default", request: { input: {}, sources: { answer: { id, value: inputs[id] } } }, ...(profile?.inspection ? { modelInput: { primary: "original facts" }, inspectionInput: revealedInput } : {}) };
        },
      },
      agents: new AgentRegistry([{ id: "material", profiles: { default: {
        id: "default", systemPrompt: "Read the material.", instructions: "Submit JSON.", submissionNudge: "Submit JSON.",
        toolNames: ["read_trace", "calculate"], fileSubmission: false,
        toolDescriptions: { read_trace: "Read source text.", calculate: "Calculate exactly.", submit_evaluation: "Submit JSON." },
        renderPrompt: () => "Read the material and submit JSON.", requestSchema: { type: "object" },
        submissionSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { const: true } } },
        requiredReads: () => [{ candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: material.length }],
        ...profile,
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
    const prepared = evaluationServices.agents.prepare(evaluationServices.taskSource.bind(task, plan.inputs,
      criteria ? { criteria: criteriaReceipt! } : {}, { tasks: plan.tasks }));
    let posts = 0, inspectionPosts = 0,
      lookups = 0;
    const host = await listen(async (req, res, url) => {
      if (url.pathname === "/api/evidence-bank") return json(res, await store.registerEvidenceBank((await body(req)) as unknown as import("@eval/contracts").EvidenceBankUpdate));
      if (url.pathname === "/api/inspections") {
        const payload = (await body(req)) as unknown as MaterialInspection; inspectionPosts++;
        const result = await store.inspect(payload);
        if (dropInspectionAck && inspectionPosts === 1) res.destroy(); else json(res, result);
        return;
      }
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
    closeHost = () => host.close();
    const worker = await startWorker(
      { identity: fakeIdentity, createSession: create },
      path.join(directory, "worker"),
    );
    closeWorker = () => worker.close();
    const attemptPolicy = { ...DEFAULT_POLICY, ...policy };
    const spec: AttemptSpec = {
      inputRevision: 1,
      runId: "test",
      taskId: task.id,
      attemptId: "attempt",
      engine: fakeIdentity,
      evaluation: prepared.evaluation,
      prompt: prepared.renderAttempt(attemptPolicy),
      evidenceBank: [...prepared.evidenceBank],
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
      prepared,
      worker,
      store,
      counts: () => ({ posts, lookups }),
      inspectionPosts: () => inspectionPosts,
      async start(currentSpec = spec) {
        await store.activate(currentSpec);
        await request(worker.url + "/api/attempts", "POST", currentSpec);
      },
      async done(attemptId = spec.attemptId) {
        return waitForTestState(
          () => request<AttemptStatus>(worker.url + "/api/attempts/" + attemptId),
          status => status.state !== "running",
          `Worker attempt ${attemptId} did not settle`,
        );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
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
      evaluation: {}, audit: { ...emptyAudit(), evidenceBank: [...fixture.spec.evidenceBank], traceReads } as Submission["audit"], usage: emptyUsage(),
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
    const audit = (tableChecks: unknown) => ({ ...emptyAudit(), evidenceBank: [...fixture.spec.evidenceBank], tableChecks }) as Submission["audit"];
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
      await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
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
        const accepted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        assert.equal(accepted.terminate, true);
      },
      async abort() {},
      async dispose() {},
    }), { dropAck: true },
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
        await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
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
test("Host returns independent business errors with structure errors before a three-submission evidence repair completes", async () => {
  const feedback: ValidationIssue[][] = [];
  const fixture = await harness(async (options) => ({
    async run() {
      for (const draft of [
        { value: "wrong", satisfies: false, proof: "unknown" },
        { value: 1, satisfies: true, proof: "unknown" },
      ]) {
        const rejected = await submitFor(options, draft);
        assert.equal(rejected.isError, true);
        feedback.push(JSON.parse(rejected.content[0]!.text!).errors);
      }
      assert.deepEqual(feedback.map((issues) => issues.map((issue) => issue.code)), [
        ["schema_type", "requirement_unmet"], ["proof_invalid"],
      ], "independent business errors are visible in the first feedback instead of a later repair");
      const accepted = await submitFor(options, { value: 1, satisfies: true, proof: "source" });
      assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
      assert.equal(accepted.terminate, true);
    }, async abort() {}, async dispose() {},
  }), { policy: { repairAttempts: 2 }, material: "source", profile: {
    submissionSchema: { type: "object", additionalProperties: false, required: ["value", "satisfies", "proof"],
      properties: { value: { type: "number" }, satisfies: { type: "boolean" }, proof: { type: "string" } } },
    requiredReads: () => [],
    validateSubmission(_request, draft) {
      if (!draft || typeof draft !== "object" || Array.isArray(draft) || (draft as { satisfies?: unknown }).satisfies !== false) return [];
      return [{ category: "decision", code: "requirement_unmet", path: "/satisfies", actual: false, message: "Requirement is unmet." }];
    },
    resolve(_request, draft) {
      if ((draft as { proof: string }).proof !== "source") throw new ValidationError([
        { category: "evidence", code: "proof_invalid", path: "/proof", actual: (draft as { proof: string }).proof, message: "Proof is invalid." },
      ]);
      return draft;
    },
  } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.deepEqual(fixture.counts(), { posts: 3, lookups: 0 }, "every complete draft reaches the same Host validation entry point");
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats?.contentSubmissions, 3);
  } finally { await fixture.close(); }
});

test("parallel file preparations and submissions share one bounded content ledger", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      const results = await Promise.all(Array.from({ length: 6 }, (_, index) => {
        const draft = draftFor(options.spec, taskResult(options.spec)) as { strengths: { importance: string }[] };
        draft.strengths[0].importance = `invalid-${index}`;
        return submitFor(options, draft);
      }));
      assert(results.every((result) => result.isError));
    }, async abort() {}, async dispose() {},
  }), { profile: fileProfile, policy: { repairAttempts: 3 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.equal(status.failure?.contentSubmissions, 4, "parallel callers cannot pass the same pre-load budget check");
    const events = (await readFile(path.join(fixture.directory, "worker/attempt/events.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as WorkerEvent);
    const loaded = events.filter(event => event.type === "submission" && object(event.data).content_loaded);
    assert.equal(loaded.length, 4, "remaining callers cannot load a hidden fifth draft");
    const last = object(loaded.at(-1)!.data).evaluation as { strengths: { importance: string }[] };
    assert.equal(status.failure?.errors[0].actual, last.strengths[0]!.importance,
      "the terminal error belongs to the actual last serialized submission, independent of file-write order");
    assert.equal(status.failure?.repeatedErrors, 1);
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});

test("parallel file submissions load at most one file when only one content submission remains", async (t) => {
  let fileReads = 0;
  const originalReadFile = fs.readFile;
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof originalReadFile>) => {
    if (["final-a.json", "final-b.json"].includes(path.basename(String(args[0])))) fileReads++;
    return originalReadFile(...args);
  });
  syncBuiltinESMExports();
  const fixture = await harness(async (options) => ({
    async run() {
      for (let index = 0; index < 3; index++) {
        const draft = draftFor(options.spec, taskResult(options.spec)) as { strengths: { importance: string }[] };
        draft.strengths[0].importance = `invalid-${index}`;
        assert.equal((await submitFor(options, draft)).isError, true);
      }
      for (const name of ["final-a.json", "final-b.json"]) {
        const draft = draftFor(options.spec, taskResult(options.spec)) as { strengths: { importance: string }[] };
        draft.strengths[0].importance = name;
        await writeFile(path.join(options.workdir, name), JSON.stringify(draft));
      }
      const results = await Promise.all(["final-a.json", "final-b.json"].map((name) =>
        options.execute("submit_evaluation_file", { path: name }),
      ));
      assert(results.every((result) => result.isError));
    }, async abort() {}, async dispose() {},
  }), { profile: fileProfile, policy: { repairAttempts: 3 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.equal(status.failure?.contentSubmissions, 4);
    assert.equal(fileReads, 1, "serialization covers loading as well as content validation");
    assert.equal(status.failure?.errors[0].actual, "final-a.json");
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally {
    await fixture.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("unacknowledged final submission updates cumulative content costs without replacing rejected-draft feedback", async (t) => {
  let lastRejected: unknown;
  const fixture = await harness(async (options) => ({
    async run() {
      for (let index = 0; index < 3; index++) {
        const draft = draftFor(options.spec, taskResult(options.spec)) as { strengths: { importance: string }[] };
        draft.strengths[0].importance = `invalid-${index}`;
        lastRejected = structuredClone(draft);
        assert.equal((await submitFor(options, draft)).isError, true);
      }
      const unacknowledged = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(unacknowledged.isError, true);
      assert.match(unacknowledged.content[0]!.text!, /HTTP 503/);
    }, async abort() {}, async dispose() {},
  }), { policy: { repairAttempts: 3 } });
  const accept = fixture.store.accept.bind(fixture.store);
  t.mock.method(fixture.store, "accept", async (submission: Submission) => {
    if ((submission.evaluation as { strengths: { importance: string }[] }).strengths[0].importance !== "high") return accept(submission);
    throw new HttpError(503, "HTTP 503 Connection error.");
  });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.equal(status.failure?.contentSubmissions, 4, "the final complete submission consumes content even when POST and lookup fail");
    assert.deepEqual(status.failure?.draft, lastRejected);
    assert.equal(status.failure?.errors[0].actual, "invalid-2");
    assert.equal(status.failure?.repeatedErrors, 1);
    assert.equal(status.failure?.stopped, false);
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
    assert.deepEqual(fixture.counts(), { posts: 6, lookups: 3 }, "each complete draft reaches Host, and retransmission uses one logical submission cost");
  } finally { await fixture.close(); }
});

test("exhausted exploration budget still permits submission and two repairs", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        const submit = async (value: unknown) => {
          const written = await options.execute("execute_code", { language: "python",
            code: `import json\nfrom pathlib import Path\nPath('evaluation.json').write_text(json.dumps(json.loads(${JSON.stringify(JSON.stringify(value))}), ensure_ascii=False))`,
            outputs: ["evaluation.json"] });
          assert.equal(written.isError, undefined, JSON.stringify(written));
          return options.execute("submit_evaluation_file", { path: "evaluation.json" });
        };
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
        const invalid = invalidDraft(options.spec);
        assert.equal(
          (await submit(invalid)).isError,
          true,
        );
        const useRepairCalls = async () => {
          for (let index = 0; index < 2; index++)
            assert.equal((await options.execute("calculate", { operation: "add", operands: ["2", "2"] })).isError, undefined);
          const exhausted = await options.execute("calculate", { operation: "add", operands: ["2", "2"] });
          assert.equal(exhausted.isError, true);
          assert.match(exhausted.content[0]!.text!, /探索工具预算已耗尽/);
        };
        await useRepairCalls();
        assert.equal((await submit(draftFor(options.spec, {}))).isError, true);
        await useRepairCalls();
        assert.equal(
          (await submit(draftFor(options.spec, taskResult(options.spec)))).terminate,
          true,
        );
      },
      async abort() {},
      async dispose() {},
    }), { policy: { maxToolCalls: 2, repairAttempts: 2 } },
  );
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.equal(receipt?.audit.calls, 2 + 3 * fixture.spec.policy.repairAttempts,
      "the initial and repair allowances include all real writer calls");
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
      assert.equal((await submitFor(options, { ok: true })).terminate, true);
    },
    async abort() {}, async dispose() {},
  }), { policy: { maxToolCalls: 12, repairAttempts: 2 }, material: material });
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
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }), { material: "材料".repeat(1000) });
  const read: TraceRead = fixture.spec.evaluation.requiredReads![0];
  const explorationLimit = fixture.spec.policy.maxToolCalls + 3 * fixture.spec.policy.repairAttempts;
  const audits = [
    { ...emptyAudit(), requiredReadCalls: undefined },
    { ...emptyAudit(), calls: 1, requiredReadCalls: -1 },
    { ...emptyAudit(), calls: 1, requiredReadCalls: 0.5 },
    { ...emptyAudit(), calls: 1, requiredReadCalls: 2 },
    { ...emptyAudit(), calls: explorationLimit + 1 },
    { ...emptyAudit(), calls: explorationLimit + 2, requiredReadCalls: 1 },
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
        evaluation: { ok: true }, audit: { ...audit, evidenceBank: [...fixture.spec.evidenceBank] }, usage: emptyUsage(),
      }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid tool audit", JSON.stringify(audit));
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});

test("a task without declared required material cannot claim a reading allowance", async () => {
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }), { material: "材料" });
  fixture.spec.evaluation.requiredReads = [];
  try {
    await fixture.store.activate(fixture.spec);
    await assert.rejects(request(`${fixture.spec.hostUrl}/api/submissions`, "POST", {
      submissionId: "undeclared-required-audit", attemptId: fixture.spec.attemptId, taskId: fixture.spec.taskId,
      evaluation: { ok: true }, usage: emptyUsage(),
      audit: { ...emptyAudit(), evidenceBank: [...fixture.spec.evidenceBank], calls: 15, requiredReadCalls: 1,
        traceReads: [{ candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: 2 }] },
    }), (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === "Invalid tool audit");
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});

test("a rejected file submission preserves the model working file for the next file submission", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      const valid = draftFor(options.spec, taskResult(options.spec));
      const working = path.join(options.workdir, "evaluation-draft.json");
      await writeFile(working, JSON.stringify(valid));
      const invalid = { ...(structuredClone(valid) as Record<string, unknown>),
        item: { criterion_id: "r4", status: "met" } };
      const rejected = await submitFor(options, invalid);
      assert.equal(rejected.isError, true);
      assert.deepEqual(await readJson(working), valid, "Worker cannot overwrite the model's valid working file with a different rejected draft");
      const feedback = JSON.parse(rejected.content[0]!.text!);
      assert.equal(feedback.draft_file, "submission-rejected.json");
      assert.match(feedback.message, /submission-rejected\.json/);
      assert.deepEqual(await readJson(path.join(options.workdir, feedback.draft_file)), invalid,
        "the program snapshot contains the exact rejected submission");
      assert.equal((await options.execute("submit_evaluation_file", { path: "evaluation-draft.json" })).terminate, true);
    }, async abort() {}, async dispose() {},
  }), { profile: fileProfile, policy: { repairAttempts: 1 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.equal(fixture.counts().posts, 2);
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats?.contentSubmissions, 2);
  } finally { await fixture.close(); }
});
test("loaded file submissions retain exact rejected JSON after the same path is overwritten", async () => {
  let rejectedObject: unknown, acceptedObject: unknown;
  const fixture = await harness(async options => ({ async run() {
    acceptedObject = draftFor(options.spec,taskResult(options.spec));
    rejectedObject = { ...(structuredClone(acceptedObject) as Record<string,unknown>), unexpected: true };
    const file = path.join(options.workdir,"submission-rejected.json");
    await writeFile(file,JSON.stringify(rejectedObject));
    assert.equal((await options.execute("submit_evaluation_file",{path:"submission-rejected.json"})).isError,true);
    await writeFile(file,JSON.stringify(acceptedObject));
    assert.equal((await options.execute("submit_evaluation_file",{path:"submission-rejected.json"})).terminate,true);
  }, async abort() {}, async dispose() {} }), { profile: fileProfile, policy: {repairAttempts:1} });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state,"succeeded");
    const events=(await readFile(path.join(fixture.directory,"worker/attempt/events.jsonl"),"utf8")).trim().split("\n")
      .map(line=>JSON.parse(line) as WorkerEvent);
    const loaded=events.filter(event=>event.type==="submission" &&
      (event.data as {content_loaded?:boolean}).content_loaded).map(event=>event.data as {
        accepted:boolean; evaluation:unknown; contentSubmissions:number;
      });
    assert.equal(loaded.length,2); assert(loaded.every(event=>event.accepted===false));
    assert.deepEqual(loaded[0].evaluation,rejectedObject);
    assert.deepEqual(loaded[1].evaluation,acceptedObject);
    assert.deepEqual(loaded.map(event=>event.contentSubmissions),[1,2]);
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions,2);
  } finally {await fixture.close();}
});
test("file submission repairs evidence through locating, reading and editing after exploration is exhausted", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        await options.execute("read_trace", {
          candidate: "answer",
          message_index: 1,
        });
        const invalid = draftFor(options.spec, taskResult(options.spec)) as any;
        invalid.strengths[0].evidence_indices[0] = Number.MAX_SAFE_INTEGER;
        const rejected = await submitFor(options, invalid);
        assert.equal(rejected.isError, true);
        const feedback = JSON.parse(rejected.content[0]!.text!);
        assert.equal(feedback.draft_file, "submission-rejected.json");
        const issue = feedback.errors.find((item: { code: string }) => item.code === "evidence_selection_invalid");
        assert(issue, "Host rejection must preserve actionable evidence feedback through Worker");
        assert.deepEqual(
          await readJson(path.join(options.workdir, "submission-rejected.json")),
          invalid,
        );
        const searched = await options.execute("search_trace", { candidate: "answer", query: "2+2=4" });
        assert.equal(searched.isError, undefined, JSON.stringify(searched));
        const located = JSON.parse(searched.content[0]!.text!).matches.find(
          (item: { path: string; evidence: { message_index: number } }) => item.path === "/content" && item.evidence.message_index === 1,
        );
        assert(located, "repair first locates the original source instead of inventing a replacement coordinate");
        const read = await options.execute("read_trace", {
          candidate: "answer", message_index: located.evidence.message_index, path: located.path,
        });
        assert.equal(read.isError, undefined, JSON.stringify(read));
        const replacement = JSON.parse(read.content[0]!.text!).evidence.find((item: { quote: string }) => item.quote === "2+2=4");
        assert(replacement, "repair reads the supporting original quote before selecting its reference");
        const fixed = await options.execute("execute_code", {
          language: "python",
          code: "import json\nfrom pathlib import Path\np=Path('submission-rejected.json')\nr=json.loads(p.read_text())\nr['strengths'][0]['evidence_indices'][0]=json.loads(VALID_REFERENCE)\np.write_text(json.dumps(r,ensure_ascii=False))".replace(
            "VALID_REFERENCE",
            JSON.stringify(JSON.stringify(replacement.reference.evidence_index)),
          ),
        });
        assert.notEqual(fixed.isError, true);
        const exhausted = await options.execute("read_trace", { candidate: "answer", message_index: 1 });
        assert.equal(exhausted.isError, true);
        assert.match(exhausted.content[0]!.text!, /探索工具预算已耗尽/);
        const submitted = await options.execute("submit_evaluation_file", { path: "submission-rejected.json" });
        assert.equal(submitted.terminate, true, JSON.stringify(submitted));
      },
      async abort() {},
      async dispose() {},
    }), { profile: fileProfile, policy: { maxToolCalls: 1, repairAttempts: 1 } },
  );
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", JSON.stringify(status));
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    const source = await request<{ messages: { role: string; content: string }[] }>(
      `${fixture.spec.hostUrl}/api/inputs/${fixture.spec.inputs.find(input => input.name === "answer")!.id}`,
    );
    assert.equal(source.messages[0]!.role, "user");
    const expected = taskResult(fixture.spec) as AttributionResult;
    const task = fixture.store.manifest.tasks.find(item => item.id === fixture.spec.taskId)!;
    const trustedAnalysis = fixture.store.state.receipts[task.dependencies.criteria]!.evaluation as AttributionResult["task_analysis"];
    const shown = parsedMaterial(fixture.spec) as { task_analysis: { requirements: { requirement_index: number }[] } };
    assert.deepEqual(shown.task_analysis.requirements.map(item => item.requirement_index), [1, 2, 3, 4, 5],
      "the model view displays the global requirement index");
    assert(trustedAnalysis.requirements.every(item => !Object.hasOwn(item, "requirement_index")),
      "the accepted Criteria remains the undecorated business analysis");
    expected.task_analysis = structuredClone(trustedAnalysis);
    expected.findings[0]!.assessment.observation = expected.findings[0]!.text;
    expected.findings[0]!.assessment.impact = expected.findings[0]!.reason;
    expected.criterion_assessments.forEach(row => {
      row.context_evidence = [canonicalEvidence(fixture.spec.inputs.find(input => input.name === "answer")!.id, 0, source.messages[0]!.content)];
    });
    expected.findings[0]!.context_evidence = [canonicalEvidence(fixture.spec.inputs.find(input => input.name === "answer")!.id, 0, source.messages[0]!.content)];
    assert.deepEqual(receipt?.evaluation, expected);
    assert.equal(receipt?.audit.calls, 1 + 3 * fixture.spec.policy.repairAttempts);
  } finally {
    await fixture.close();
  }
});
test("a content repair can write its fixed file after all three repair exploration calls are spent", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      await options.execute("read_trace", { candidate: "answer", message_index: 1 });
      const invalid = draftFor(options.spec, taskResult(options.spec)) as any;
      invalid.strengths[0].evidence_indices[0] = Number.MAX_SAFE_INTEGER;
      const rejected = await submitFor(options, invalid);
      assert.equal(rejected.isError, true);
      const feedback = JSON.parse(rejected.content[0]!.text!);
      let reference: unknown;
      for (let i = 0; i < 3; i++) {
        const searched = await options.execute("search_trace", { candidate: "answer", query: "2+2=4" });
        assert.equal(searched.isError, undefined, JSON.stringify(searched));
        reference = JSON.parse(searched.content[0]!.text!).matches.find(
          (item: { path: string; evidence: { message_index: number } }) => item.path === "/content" && item.evidence.message_index === 1,
        )?.evidence.reference;
      }
      assert(reference && typeof reference === "object" && "evidence_index" in reference, "the replacement is selected from a real source result");
      assert.equal((await options.execute("search_trace", { candidate: "answer", query: "2+2=4" })).isError, true);
      const fixed = await options.execute("execute_code", {
        language: "python",
        code: "import json\nfrom pathlib import Path\np=Path(SNAPSHOT)\nr=json.loads(p.read_text())\nr['strengths'][0]['evidence_indices'][0]=json.loads(REFERENCE)\np.write_text(json.dumps(r,ensure_ascii=False))"
          .replace("SNAPSHOT", JSON.stringify(feedback.draft_file))
          .replace("REFERENCE", JSON.stringify(JSON.stringify((reference as {evidence_index:number}).evidence_index))),
        outputs: [feedback.draft_file],
      });
      assert.notEqual(fixed.isError, true, "the bounded writer allowance survives exhausted repair exploration");
      const budget = JSON.parse(fixed.content.at(-1)!.text!).budget;
      assert.deepEqual(budget.exploration, { used: 4, remaining: 0 });
      assert.deepEqual(budget.draft_writes, { used: 1, remaining: 0, tools: ["execute_code", "edit_json"] });
      const extra = await options.execute("execute_code", { language: "python", code: "raise AssertionError('must not run')" });
      assert.equal(extra.isError, true, "one rejection reserves only one writer call");
      const submitted = await options.execute("submit_evaluation_file", { path: feedback.draft_file });
      assert.equal(submitted.terminate, true, JSON.stringify(submitted));
    },
    async abort() {}, async dispose() {},
  }), { profile: fileProfile, policy: { maxToolCalls: 1, repairAttempts: 1 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", JSON.stringify(status));
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.equal(receipt?.submissionStats?.contentSubmissions, 2);
    assert.equal(receipt?.audit.calls, 5, "the reserved writer remains part of the total real tool audit");
  } finally { await fixture.close(); }
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
        const invalid = invalidDraft(options.spec);
        await writeFile(
          path.join(options.workdir, "invalid.json"),
          JSON.stringify(invalid),
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
          (await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate,
          true,
        );
      },
      async abort() {},
      async dispose() {},
    }), { profile: fileProfile, policy: { repairAttempts: 1 } },
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

test("a missing submission file restores a bounded writer after a different JSON file consumed its reserved call", async () => {
  const fixture = await harness(async options => ({ async run() {
    assert.equal((await options.execute("calculate", { operation: "add", operands: ["2", "2"] })).isError, undefined);
    const consumed = await options.execute("execute_code", { language: "python",
      code: "from pathlib import Path\nPath('other.json').write_text('{\"ok\":true}')", outputs: ["other.json"] });
    assert.equal(consumed.isError, undefined);
    assert.deepEqual(object(object(consumed.details).budget).draft_writes, { used: 1, remaining: 0, tools: ["execute_code"] });
    const code = "from pathlib import Path\nPath('evaluation.json').write_text('{\"ok\":true}')";
    assert.equal((await options.execute("execute_code", { language: "python", code })).isError, true,
      "a successful protected call is not silently refunded");
    const missing = await options.execute("submit_evaluation_file", { path: "evaluation.json" });
    assert.equal(missing.isError, true);
    const budget = object(object(missing.details).budget);
    assert.equal(budget.content_remaining, 4, "a missing file spends no content submission");
    assert.equal(budget.file_errors_remaining, 2);
    assert.deepEqual(budget.draft_writes, { used: 1, remaining: 1, tools: ["execute_code"] },
      "file feedback reoffers one unused writer call without refunding the previous call");
    const corrected = await options.execute("execute_code", { language: "python", code, outputs: ["evaluation.json"] });
    assert.equal(corrected.isError, undefined, JSON.stringify(corrected));
    assert.deepEqual(object(object(corrected.details).budget).exploration, { used: 1, remaining: 0 });
    assert.deepEqual(object(object(corrected.details).budget).draft_writes, { used: 2, remaining: 0, tools: ["execute_code"] });
    assert.equal((await options.execute("submit_evaluation_file", { path: "evaluation.json" })).terminate, true);
  }, async abort() {}, async dispose() {} }), { material: "source", policy: { maxToolCalls: 1, repairAttempts: 3 },
    profile: { requiredReads: () => [], fileSubmission: true, toolNames: ["calculate", "execute_code"],
      toolDescriptions: { calculate: "Calculate exactly.", execute_code: "Write the complete JSON file.", submit_evaluation_file: "Submit the JSON file." } } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
    assert.deepEqual(receipt.submissionStats, { contentSubmissions: 1, fileErrors: 1 });
    assert.equal(receipt.audit.calls, 3, "the exploration call and both protected calls remain charged");
  } finally { await fixture.close(); }
});

for (const newLoadingError of [false, true])
test(`resumed exhausted file budget ${newLoadingError ? "still stops a new loading error" : "does not stop validly loaded content repairs"}`, async () => {
  const fixture = await harness(async options => ({ async run() {
    const rejected = await submitFor(options, { ok: false });
    assert.equal(rejected.isError, true);
    const budget = object(object(rejected.details).budget);
    assert.equal(budget.content_remaining, 1);
    assert.equal(budget.file_errors_remaining, 0, "historical file errors are not refunded");
    if (newLoadingError) {
      await options.execute("submit_evaluation_file", { path: "missing.json" });
    } else {
      assert.equal((await submitFor(options, { ok: true })).terminate, true);
    }
  }, async abort() {}, async dispose() {} }), {
    material: "source", policy: { repairAttempts: 1 },
    profile: { fileSubmission: true, requiredReads: () => [], toolNames: [],
      toolDescriptions: { submit_evaluation_file: "Submit the complete JSON file." } },
  });
  fixture.spec.recovery = { errors: [{ category: "structure", code: "submission_file_invalid", path: "/",
    message: "Previous attempts could not load a submission file." }], contentSubmissions: 0,
    fileErrors: 3, repeatedErrors: 0, stopped: true, attemptId: "prior-attempt" };
  try {
    await fixture.start();
    const status = await fixture.done();
    if (newLoadingError) {
      assert.equal(status.state, "failed");
      assert.match(status.error!, /Submission loading budget exhausted/);
      assert.equal(status.failure?.contentSubmissions, 1);
      assert.equal(status.failure?.fileErrors, 4);
    } else {
      assert.equal(status.state, "succeeded", status.error);
      assert.deepEqual((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats,
        { contentSubmissions: 2, fileErrors: 3 });
    }
  } finally { await fixture.close(); }
});

test("file loading feedback cannot renew exhausted protected writers or bypass the independent file cap", async () => {
  const fixture = await harness(async options => ({ async run() {
    await options.execute("calculate", { operation: "add", operands: ["2", "2"] });
    for (let used = 1; used <= 4; used++) {
      const failed = await options.execute("execute_code", { language: "python", code: "raise RuntimeError('failed writer')", outputs: ["evaluation.json"] });
      assert.equal(failed.isError, true);
      assert.deepEqual(object(object(failed.details).budget).draft_writes,
        { used, remaining: used < 4 ? 1 : 0, tools: ["execute_code"] });
    }
    for (let fileErrors = 1; fileErrors <= 3; fileErrors++) {
      const missing = await options.execute("submit_evaluation_file", { path: "evaluation.json" });
      assert.equal(missing.isError, true);
      const budget = object(object(missing.details).budget);
      assert.equal(budget.content_remaining, 4);
      assert.equal(budget.file_errors_remaining, 3 - fileErrors);
      assert.deepEqual(budget.draft_writes, { used: 4, remaining: 0, tools: ["execute_code"] });
    }
  }, async abort() {}, async dispose() {} }), { material: "source", policy: { maxToolCalls: 1, repairAttempts: 3 },
    profile: { requiredReads: () => [], fileSubmission: true, toolNames: ["calculate", "execute_code"],
      toolDescriptions: { calculate: "Calculate exactly.", execute_code: "Write the complete JSON file.", submit_evaluation_file: "Submit the JSON file." } } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.match(status.error!, /Submission loading budget exhausted/);
    assert.equal(status.failure?.contentSubmissions, 0);
    assert.equal(status.failure?.fileErrors, 3);
    assert.equal(fixture.counts().posts, 0);
  } finally { await fixture.close(); }
});

test("file profiles retain their JSON schema and expose no direct submission fallback", async () => {
  const fixture = await harness(async options => ({ async run() {
    assert(!options.tools.some(tool => tool.name === "submit_evaluation"));
    const tool = options.tools.find(tool => tool.name === "submit_evaluation_file")!;
    assert.deepEqual(tool.inputSchema, { type: "object", additionalProperties: false, required: ["path"],
      properties: { path: { type: "string", minLength: 1 } } });
    const data = JSON.parse(tool.description.slice(tool.description.indexOf('\n{"file_content_schema":') + 1));
    assert.deepEqual(data.file_content_schema, options.spec.evaluation.outputSchema);
    const unavailable = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.content[0]!.text!, /Unknown tool/);
    assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
  }, async abort() {}, async dispose() {} }), { profile: fileProfile });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions, 1);
  } finally { await fixture.close(); }
});

test("exhausted exploration permits correcting a failed draft writer using the current directory", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      for (let i = 0; i < 24; i++)
        assert.equal((await options.execute("calculate", { operation: "add", operands: ["1", "1"] })).isError, undefined);
      const wrongPath = path.join(options.workdir, "wrong-run", "evaluation.json");
      const create = await options.execute("execute_code", { language: "python",
        code: `from pathlib import Path\nPath(${JSON.stringify(wrongPath)}).write_text('{"ok":true}')`, outputs: ["evaluation.json"] });
      assert.equal(JSON.parse(create.content[0]!.text!).exit_code, 1, "the initial draft allowance reaches the real writer");
      assert.match(JSON.parse(create.content[0]!.text!).stderr, /FileNotFoundError/);
      assert.deepEqual(object(object(create.details).budget).draft_writes, { used: 1, remaining: 1, tools: ["execute_code"] });
      assert.equal(await exists(path.join(options.workdir, "evaluation.json")), false);
      assert(!options.tools.some(tool => tool.name === "submit_evaluation"));
      const unavailable = await options.execute("read_trace", { candidate: "answer", message_index: 1 });
      assert.equal(unavailable.isError, true, "a failed writer unlocks no exploration allowance");
      assert.match(unavailable.content[0]!.text!, /探索工具预算已耗尽/);
      const corrected = await options.execute("execute_code", { language: "python",
        code: "from pathlib import Path\nPath('evaluation.json').write_text('{\"ok\":true}')", outputs: ["evaluation.json"] });
      assert.equal(corrected.isError, undefined, JSON.stringify(corrected));
      assert.deepEqual(object(object(corrected.details).budget).draft_writes, { used: 2, remaining: 0, tools: ["execute_code"] });
      assert.equal((await options.execute("submit_evaluation_file", { path: "evaluation.json" })).terminate, true);
    },
    async abort() {}, async dispose() {},
  }), { policy: { maxToolCalls: 24, repairAttempts: 2 }, material: "original facts",
    profile: { fileSubmission: true, requiredReads: () => [], toolNames: ["read_trace", "calculate", "execute_code"],
      toolDescriptions: { read_trace: "Read original source.", calculate: "Calculate exactly.", execute_code: "Write JSON.", submit_evaluation_file: "Submit JSON file." } } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.deepEqual((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats, {
      contentSubmissions: 1,
      fileErrors: 0,
    });
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))?.audit.calls, 26);
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
      const invalid = { ok: false };
      const rejected = await submitFor(options, invalid);
      assert.equal(rejected.isError, true);
      const feedback = JSON.parse(rejected.content[0]!.text!);
      assert.deepEqual(await readJson(path.join(options.workdir, "submission-rejected.json")), invalid);
      assert.equal(Object.hasOwn(feedback, "draft_file"), false);
      assert.match(feedback.message, /完整 JSON/);
      assert.equal(feedback.next_tool, "submit_evaluation");
      assert.equal(
        (await submitFor(options, { ok: true })).terminate,
        true,
      );
    },
    async abort() {}, async dispose() {},
  }), { policy: { repairAttempts: 1 }, material: "source", profile: { requiredReads: () => [] } });
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
    }), { profile: fileProfile, policy: { repairAttempts: 0 } },
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
          (await submitFor(options, draftFor(options.spec, draft))).isError,
          true,
        );
      }
      assert.equal(
        (await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate,
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
test("Attribution can repair coverage and remaining identical problem errors within three repairs", async () => {
  const feedback: ValidationIssue[][] = [];
  const fixture = await harness(async (options) => ({
    async run() {
      // Repairing coverage must preserve opportunities to fix the remaining invalid strength fields.
      const draft = draftFor(options.spec, taskResult(options.spec)) as {
        strengths: { definition?: unknown }[];
        criterion_assessments: unknown[];
      };
      draft.strengths = Array.from({ length: 4 }, () => ({
        ...structuredClone(draft.strengths[0]!), definition: "",
      }));
      const assessments = draft.criterion_assessments;
      draft.criterion_assessments = [];
      for (let submission = 0; submission < 3; submission++) {
        if (submission === 1) draft.criterion_assessments = assessments;
        if (submission === 2) {
          delete draft.strengths[0]!.definition;
          delete draft.strengths[1]!.definition;
        }
        const rejected = await submitFor(options, draft);
        assert.equal(rejected.isError, true);
        const response = JSON.parse(rejected.content[0]!.text!);
        feedback.push(response.errors);
        assert.equal(response.budget.content_remaining, 3 - submission);
      }
      assert.deepEqual(feedback.map((errors) => errors.filter((error) => error.code === "schema_additionalProperties").length), [4, 4, 2]);
      assert(feedback.every((errors) => errors.some((error) => error.code.startsWith("schema_"))));
      assert(feedback[0]!.some((error) => error.code === "criterion_slot_count"));
      assert(!feedback[1]!.some((error) => error.code === "criterion_slot_count"));
      draft.strengths.forEach((finding) => { delete finding.definition; });
      assert.equal((await submitFor(options, draft)).terminate, true);
    },
    async abort() {},
    async dispose() {},
  }), { policy: { repairAttempts: 3 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.equal(fixture.counts().posts, 4, "partial progress uses the initial submission plus all three repairs");
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats?.contentSubmissions, 4);
  } finally { await fixture.close(); }
});
test("identical invalid drafts retain the remaining repairs and stop at the cumulative content cap", async () => {
  const remaining: number[] = [];
  const fixture = await harness(async (options) => ({
    async run() {
      const draft = invalidDraft(options.spec) as Record<string, unknown>;
      for (let index = 0; index < 4; index++) {
        // Object-key order changes formatting, not the submitted content.
        const response = await submitFor(options, index % 2 ? Object.fromEntries(Object.entries(draft).reverse()) : draft);
        assert.equal(response.isError, true);
        remaining.push(JSON.parse(response.content[0]!.text!).budget.content_remaining);
      }
    }, async abort() {}, async dispose() {},
  }), { policy: { repairAttempts: 3 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "failed");
    assert.equal(status.failure?.repeatedErrors, 4);
    assert.equal(status.failure?.contentSubmissions, 4);
    assert.equal(fixture.counts().posts, 4);
    assert.deepEqual(remaining, [3, 2, 1, 0]);
    assert.equal(status.retryable, false, "repeated business errors must not become retryable interruptions");
    assert.equal(status.error, "Submission repair budget exhausted");
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally {
    await fixture.close();
  }
});
test("a substantive third submission can repair two identical rejections", async () => {
  const fixture = await harness(async (options) => ({
    async run() {
      const draft = invalidDraft(options.spec);
      for (let index = 0; index < 2; index++) {
        const response = await submitFor(options, draft);
        assert.equal(response.isError, true);
        const feedback = JSON.parse(response.content[0]!.text!);
        assert.equal(feedback.budget.content_remaining, 3 - index);
        if (index) assert.match(feedback.message, /与上一稿相同/);
      }
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    }, async abort() {}, async dispose() {},
  }), { policy: { repairAttempts: 3 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.equal(fixture.counts().posts, 3);
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats?.contentSubmissions, 3);
  } finally { await fixture.close(); }
});
test("changed drafts with the same errors retain repair opportunities without resetting the content cap", async () => {
  const feedback: { errors: ValidationIssue[]; budget: { content_remaining: number } }[] = [];
  const writerRemaining: number[] = [];
  const fixture = await harness(async (options) => ({
    async run() {
      const draft = invalidDraft(options.spec) as { summary: string };
      for (let submission = 0; submission < 4; submission++) {
        draft.summary = `修正描述 ${submission}`;
        const rejected = await submitFor(options, draft);
        assert.equal(rejected.isError, true);
        feedback.push(JSON.parse(rejected.content[0]!.text!));
        writerRemaining.push((rejected.details as { budget: { draft_writes: { remaining: number } } }).budget.draft_writes.remaining);
      }
    }, async abort() {}, async dispose() {},
  }), { profile:fileProfile,policy: { repairAttempts: 3 } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(fixture.counts().posts, 4);
    assert.deepEqual(feedback.map((item) => item.errors), Array(4).fill(feedback[0]!.errors));
    assert.deepEqual(feedback.map((item) => item.budget.content_remaining), [3, 2, 1, 0]);
    assert.deepEqual(writerRemaining, [1, 1, 1, 0], "each remaining file repair preserves one writer; cumulative exhaustion removes it");
    assert.equal(status.failure?.contentSubmissions, 4);
    assert.equal(status.failure?.repeatedErrors, 1);
    assert.equal(status.failure?.stopped, false);
    assert.equal(status.error, "Submission repair budget exhausted");
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});
for (const reason of ["deadline", "idle", "no-submission"] as const)
test(`unsubmitted file drafts survive ${reason} and resume without spending content budget`, async () => {
  let release: (() => void) | undefined;
  const fixture = await harness(async options => ({
    async run() {
      if (options.spec.recovery) {
        assert.deepEqual(await readJson(path.join(options.workdir, "submission-rejected.json")), { ok: true });
        assert.equal(options.spec.recovery.contentSubmissions, 0);
        assert.equal((await options.execute("submit_evaluation_file", { path: "submission-rejected.json" })).terminate, true);
        return;
      }
      assert.equal((await options.execute("edit_json", { path: "evaluation-draft.json", set_json: '{"ok":true}' })).isError, undefined);
      assert.equal((await options.execute("edit_json", { path: "evaluation-draft.json", set_json: '{"ok":' })).isError, true);
      if (reason !== "no-submission") await new Promise<void>(resolve => { release = resolve; });
    },
    async abort() { release?.(); }, async dispose() {},
  }), { material: "fixture", policy: { idleTimeoutSeconds: reason === "idle" ? 1 : 10 }, profile: { ...fileProfile, toolNames: ["edit_json"], requiredReads: () => [],
    toolDescriptions: { edit_json: "Update the evaluation draft.", submit_evaluation_file: "Submit the evaluation draft." } } });
  try {
    if (reason === "deadline") fixture.spec.deadline = Date.now() + 2000;
    await fixture.start();
    const first = await fixture.done();
    assert.equal(first.state, reason === "no-submission" ? "failed" : "timed_out");
    assert.equal(first.retryable === true, reason !== "deadline");
    assert.equal(first.failure?.errors[0]?.category, "interruption");
    assert.deepEqual(first.failure?.draft, { ok: true });
    assert.equal(first.failure?.contentSubmissions, 0);
    assert.equal(fixture.counts().posts, 0, "a durable draft is not an accepted or submitted evaluation");
    await fixture.store.endAttempt(fixture.spec, first.state as "failed" | "timed_out", first.error!);
    const spec = { ...fixture.spec, attemptId: "resume-written-draft", recovery: first.failure,
      prompt: fixture.prepared.renderAttempt(fixture.spec.policy, first.failure), deadline: Date.now() + 10000 };
    await fixture.start(spec);
    assert.equal((await fixture.done(spec.attemptId)).state, "succeeded");
    assert.equal((await fixture.store.receipt(spec.taskId))?.submissionStats?.contentSubmissions, 1);
  } finally { await fixture.close(); }
});

test("resuming an unfinished invalid draft preserves its repair file and cumulative content count", async () => {
  const submitted = new Set<string>();
  const fixture = await harness(async (options) => ({
    async run() {
      if (!options.spec.recovery) {
        if (submitted.has(options.spec.attemptId)) return; // Ignore the same-session nudge to exercise explicit resume.
        submitted.add(options.spec.attemptId);
        const draft = invalidDraft(options.spec);
        await submitFor(options, draft);
        await submitFor(options, draft);
        return;
      }
      assert.equal(await exists(path.join(options.workdir, "submission-rejected.json")), true,
        "a recoverable draft remains available while its cumulative repair budget remains");
      assert.deepEqual(await readJson(path.join(options.workdir, "submission-rejected.json")), options.spec.recovery.draft);
      assert.equal((await submitFor(options, invalidDraft(options.spec))).isError, true);
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    },
    async abort() {}, async dispose() {},
  }));
  try {
    await fixture.start();
    const first = await fixture.done();
    assert.equal(first.state, "failed");
    assert.equal(first.failure!.repeatedErrors, 2);
    await fixture.store.endAttempt(fixture.spec, "failed", first.error!);
    const policy = { ...fixture.spec.policy, repairAttempts: 1 };
    const spec = { ...fixture.spec, attemptId: "resumed", policy, recovery: first.failure,
      prompt: fixture.prepared.renderAttempt(policy, first.failure), evidenceBank: [...fixture.prepared.evidenceBank], deadline: Date.now() + 10000 };
    await fixture.start(spec);
    assert.equal((await fixture.done(spec.attemptId)).state, "succeeded");
    assert.equal(fixture.counts().posts, 4);
    assert.equal((await fixture.store.receipt(spec.taskId))?.submissionStats?.contentSubmissions, 4);
  } finally { await fixture.close(); }
});

test("a session that stops before submitting gets one nudge and can still succeed", async () => {
  const prompts: string[] = [];
  const fixture = await harness(async (options) => ({
    async run(prompt) {
      prompts.push(prompt);
      if (prompts.length === 1) return;
      assert.equal(
        (await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate,
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
    assert.equal(prompts[1], fixture.spec.evaluation.submissionNudge);
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

test("a session stopping after rejected submission repairs within the same attempt", async () => {
  let runs = 0;
  const fixture = await harness(async options => ({
    async run() {
      runs++;
      const result = await options.execute("submit_evaluation", { json: JSON.stringify({ ready: runs > 1 }) });
      assert.equal(runs === 1 ? result.isError : result.terminate, true);
    }, async abort() {}, async dispose() {},
  }), { material: "fixture", policy: { repairAttempts: 1 }, profile: {
    jsonStringSubmission: true, requiredReads: () => [],
    submissionSchema: { type: "object", properties: { ready: { const: true } }, required: ["ready"] },
  } });
  try {
    await fixture.start();
    assert.equal((await fixture.done()).state, "succeeded");
    assert.equal(runs, 2);
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions, 2);
  } finally { await fixture.close(); }
});

test("submission delivers missing material before charging a content attempt", async () => {
  const material = "图表数据".repeat(12344);
  const target: TraceRead = { candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: material.length };
  let delivered = "", pages = 0;
  const fixture = await harness(async options => ({
    async run() {
      await options.execute("calculate", { operation: "add", operands: ["1", "1"] });
      while (pages < 20) {
        const result = await submitFor(options, { ok: true });
        if (result.terminate) return;
        assert.notEqual(result.isError, true, "material delivery is not a rejected verdict");
        const feedback = JSON.parse(result.content[0].text!);
        assert.equal(feedback.material_pending, true);
        assert.equal(feedback.budget.content_remaining, 1);
        const page = JSON.parse(result.content[1].text!);
        assert.equal(page.offset, delivered.length);
        delivered += page.evidence[0].quote;
        pages++;
      }
      assert.fail("required material must make bounded progress");
    }, async abort() {}, async dispose() {},
  }), { material, policy: { maxToolCalls: 1, repairAttempts: 0 }, profile: {
    validate(_request, _value, audit) {
      assert(traceReadCoverage(audit, target).covered, "Host only receives a verdict after its evidence was delivered");
    },
  } });
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.state, "succeeded", status.error);
    assert.equal(delivered, material);
    assert(pages > 1);
    const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
    assert.equal(receipt.submissionStats!.contentSubmissions, 1);
    assert.equal(receipt.audit.requiredReadCalls, pages);
    assert.equal(fixture.counts().posts, 1);
  } finally { await fixture.close(); }
});

test("a session resumes after automatic material delivery without rereading or charging repairs", async () => {
  const material = "图表数据".repeat(12344), target: TraceRead = {
    candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: material.length,
  };
  let runs = 0, offset = 0, pages = 0;
  const fixture = await harness(async options => ({
    async run(prompt) {
      runs++;
      if (runs === 2) {
        assert.equal(prompt, fixture.spec.evaluation.submissionNudge);
      }
      do {
        const read = await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content", offset });
        assert.notEqual(read.isError, true);
        const page = JSON.parse(read.content[0].text!);
        assert.equal(page.offset, offset);
        offset = page.next_offset; pages++;
      } while (runs > 1 && offset < material.length);
      const result = await submitFor(options, { ok: true });
      if (runs === 1) {
        assert.equal(JSON.parse(result.content[0].text!).material_pending, true);
        offset = JSON.parse(result.content[1].text!).next_offset;
        pages++;
      } else assert.equal(result.terminate, true);
    }, async abort() {}, async dispose() {},
  }), { material, policy: { maxToolCalls: 1, repairAttempts: 1 }, profile: {
    validate(_request, _value, audit) {
      const coverage = traceReadCoverage(audit, target);
      if (!coverage.covered) throw new ValidationError([{ category: "evidence", code: "deferred_final_material_not_read",
        path: "/answer/deferred_final_material/0", message: "补读缺失范围。", actual: coverage.missing }]);
    },
  } });
  try {
    await fixture.start();
    assert.equal((await fixture.done()).state, "succeeded");
    const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
    assert.equal(runs, 2);
    assert.equal(receipt.audit.requiredReadCalls, pages);
    assert.equal(receipt.audit.calls, pages);
    assert.equal(traceReadCoverage(receipt.audit, target).covered, true);
    assert.equal(receipt.submissionStats!.contentSubmissions, 1);
  } finally { await fixture.close(); }
});
for (const reason of ["no-submission", "idle"] as const)
  for (const stopped of [false, true])
    test(`an unsubmitted ${reason} recovery preserves repair state (stopped: ${stopped})`, async () => {
      const draft = { invalid: true };
      const issue = { category: "structure" as const, code: "invalid_draft", path: "/invalid", message: "Invalid draft" };
      let release = () => {};
      const fixture = await harness(async (options) => ({
        async run() {
          assert.equal(await exists(path.join(options.workdir, "submission-rejected.json")), !stopped);
          if (reason === "idle") await new Promise<void>((resolve) => { release = resolve; });
        },
        async abort() { release(); }, async dispose() {},
      }), { policy: { idleTimeoutSeconds: reason === "idle" ? 1 : 10 } });
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
      }), { policy: { idleTimeoutSeconds: reason === "idle" ? 1 : 10 } },
    );
    try {
      // Allow session setup IO under load before testing deadline-driven disposal.
      if (reason === "deadline") fixture.spec.deadline = Date.now() + 2000;
      await fixture.start();
      if (reason === "cancel") {
        await waitForTestState(async () => ({ running, disposed }), state => state.running,
          "cancel only after the session exists");
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
  }, { material: "材料" });
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
    }), { policy: { maxTokens: 10 } },
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

for (const [message, retryable, quota = false] of [
  ['429 {"code":"insufficient_quota","message":"You exceeded your current quota"}', false, true],
  ["You exceeded your current quota, please check your plan and billing details.", false, true],
  ["402 Insufficient Balance", false, true],
  ["API error: 额度已耗尽", false, true],
  ["429 rate_limit_exceeded: tokens per minute quota exceeded", true],
  ["429 quota_exceeded: tokens per minute", true],
  ["429 subscription_sharing_usage_limit_exceeded", false, true],
  ["401 Invalid API key; check your billing details", false],
  ["Connection error.", true],
  ["terminated", true],
  ["Request timed out.", true],
  ["litellm.APIError: Responses API stream ended before response.completed or response.incomplete", true],
  ['evaluation-gateway API error (529): {"message":"当前服务集群负载较高，请稍后重试，感谢您的耐心等待。 (2064)","code":"server_error"}', true],
  ["HTTP 503 Service Unavailable", true],
  ["HTTP/2 500 Internal Server Error", true],
  ["The server had an error processing your request. Sorry about that! You can retry your request, or contact us through an Azure support request.", true],
  ["server_error: The server encountered an internal error.", true],
  ["Invalid OpenAI Responses tool arguments: submit_evaluation (call_01a0fc93466c7cd2907ddcf5|070ed59d2f624fb64934837f33bc1803_fc_0); expected complete JSON object", false],
  ["Invalid OpenAI Responses tool arguments: fc_123; expected JSON object", false],
  ["Evaluation validation failed: Invalid OpenAI Responses tool arguments: submit_evaluation (call_123); expected complete JSON object", false],
  ["Invalid OpenAI Responses tool arguments: submit_evaluation (call_123); expected complete JSON object; wrong business criteria", false],
  ["Evaluation validation failed: expected 529 characters", false],
  ["Evaluation validation failed: expected 503 characters", false],
  ["Evaluation validation failed: The server had an error processing your request.", false],
  ["Evaluation validation failed: Responses API stream ended before response.completed or response.incomplete", false],
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
      assert.equal(status.modelQuotaExhausted, quota);
      assert.equal(status.failure?.errors[0]?.category, retryable ? "transport" : "interruption");
    } finally {
      await fixture.close();
    }
  });

for (const message of ["The server had an error processing your request.", "insufficient_quota"])
test(`an ordinary thrown error cannot impersonate an SDK provider failure: ${message}`, async () => {
  const fixture = await harness(async () => ({ async run() { throw new Error(message); }, async abort() {}, async dispose() {} }));
  try {
    await fixture.start();
    const status = await fixture.done();
    assert.equal(status.error, message);
    assert.equal(status.retryable, false);
    assert.equal(status.modelQuotaExhausted, false);
  } finally { await fixture.close(); }
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

const malformedArguments = (name: string) =>
  `Invalid OpenAI Responses tool arguments: ${name} (call_invalid|fc_invalid); expected complete JSON object`;
const emitMalformedArguments = (options: Parameters<AgentBackend["createSession"]>[0], name: string) =>
  options.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", rawStopReason: "completed",
    errorMessage: malformedArguments(name) } });

test("SDK malformed submission uses loading repairs and preserves the Host content budget", async () => {
  let runs = 0;
  const fixture = await harness(async options => ({ async run(prompt) {
    if (++runs === 1) { emitMalformedArguments(options, "submit_evaluation"); return; }
    const feedback = JSON.parse(prompt);
    assert.equal(feedback.failed_tool, "submit_evaluation");
    assert.equal(feedback.next_tool, "submit_evaluation");
    assert.equal(feedback.errors[0].code, "tool_arguments_invalid");
    assert.equal(feedback.budget.content_remaining, 4);
    assert.equal(fixture.store.state.manifest.states[fixture.spec.taskId].failure!.contentSubmissions, 0);
    assert.equal(fixture.store.state.manifest.states[fixture.spec.taskId].failure!.fileErrors, 1);
    assert.equal(fixture.counts().posts, 0, "malformed JSON never reaches Host acceptance");
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content", offset: 0 });
    assert.equal((await submitFor(options, { ok: true })).isError, undefined);
  }, async abort() {}, async dispose() {} }), { policy: { repairAttempts: 3 }, material: "original facts" });
  try {
    fixture.spec.model.api = "openai-responses";
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    assert.equal(runs, 2); assert.equal(fixture.counts().posts, 1);
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions, 1);
    const events = (await readFile(path.join(fixture.directory,"worker/attempt/events.jsonl"),"utf8")).trim().split("\n")
      .map(line => JSON.parse(line) as WorkerEvent);
    const malformed = events.filter(event => event.type === "tool_start" &&
      (event.data as { malformed_arguments?: boolean }).malformed_arguments);
    assert.equal(malformed.length,1);
    assert.equal((malformed[0].data as { argument_object_available: boolean }).argument_object_available,false);
    assert(!Object.hasOwn(malformed[0].data as object,"args"),"the event must not manufacture a JSON object");
    assert.equal(events.filter(event => event.type === "tool_start" &&
      (event.data as { name?: string }).name === "submit_evaluation").length,2,"replay ledger counts both attempts");
  } finally { await fixture.close(); }
});

test("three malformed SDK submissions exhaust loading repairs without a draft or transport retry", async () => {
  let runs = 0;
  const fixture = await harness(async options => ({ async run() { runs++; emitMalformedArguments(options, "submit_evaluation"); },
    async abort() {}, async dispose() {} }), { policy: { repairAttempts: 3 }, material: "original facts" });
  try {
    fixture.spec.model.api = "openai-responses";
    await fixture.start(); const status = await fixture.done();
    assert.equal(status.state, "failed"); assert.equal(status.retryable, false);
    assert.equal(runs, 3); assert.equal(status.failure!.contentSubmissions, 0);
    assert.equal(status.failure!.fileErrors, 3);
    assert.equal(status.failure!.draft, undefined);
    assert.equal(status.failure!.errors[0].code, "tool_arguments_invalid");
    assert.equal(fixture.counts().posts, 0); assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});

test("malformed arguments preserve an older real draft without diagnosing identical JSON", async () => {
  let runs = 0;
  const original = { ok: false };
  const fixture = await harness(async options => ({ async run(prompt) {
    runs++;
    if (runs === 1) {
      await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content", offset: 0 });
      assert.equal((await submitFor(options, original)).isError,true);
      emitMalformedArguments(options,"submit_evaluation"); return;
    }
    const checkpoint = fixture.store.state.manifest.states[fixture.spec.taskId].failure!;
    assert.equal(checkpoint.repeatedErrors,0,"absent argument objects cannot be compared");
    assert.deepEqual(checkpoint.draft,original);
    assert.deepEqual(JSON.parse(await readFile(path.join(options.workdir,"submission-rejected.json"),"utf8")),original);
    assert(!prompt.includes("完整 JSON 与上一稿相同"));
    if (runs === 2) { emitMalformedArguments(options,"submit_evaluation"); return; }
    await options.execute("read_trace",{candidate:"answer",message_index:0,path:"/content",offset:0});
    assert.equal((await submitFor(options, {ok:true})).isError,undefined);
  }, async abort() {}, async dispose() {} }), { policy: { repairAttempts: 3 }, material: "original facts" });
  try {
    fixture.spec.model.api="openai-responses";
    await fixture.start(); assert.equal((await fixture.done()).state,"succeeded");
    assert.equal(runs,3); assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions,2);
  } finally { await fixture.close(); }
});

test("malformed SDK reads consume exploration only and stop at its existing cap", async () => {
  let runs = 0;
  const fixture = await harness(async options => ({ async run() { runs++; emitMalformedArguments(options, "read_trace"); },
    async abort() {}, async dispose() {} }), { policy: { maxToolCalls: 2 }, material: "original facts" });
  try {
    fixture.spec.model.api = "openai-responses";
    await fixture.start(); const status = await fixture.done();
    assert.equal(status.state, "failed"); assert.equal(status.retryable, false);
    assert.equal(runs, 3); assert.equal(status.failure!.contentSubmissions, 0); assert.equal(fixture.counts().posts, 0);
    const record = await readJson<{ metrics: { audit: { calls: number } } }>(path.join(fixture.directory,"worker/attempt/attempt.json"));
    assert.equal(record.metrics.audit.calls, 2);
  } finally { await fixture.close(); }
});

test("malformed SDK writers can correct arguments within the protected total cap without executing them", async () => {
  let runs = 0;
  const fixture = await harness(async options => ({ async run(prompt) {
    runs++;
    if (runs === 1) {
      await options.execute("calculate", { operation: "add", operands: ["1", "1"] });
    } else {
      const feedback = JSON.parse(prompt);
      assert.equal(feedback.failed_tool, "execute_code");
      assert.equal(feedback.errors[0].code, "tool_arguments_invalid");
      assert.equal(feedback.budget.content_remaining, 3);
      assert.deepEqual(feedback.budget.exploration, { used: 1, remaining: 0 });
      assert.deepEqual(feedback.budget.draft_writes, { used: runs - 1, remaining: runs <= 3 ? 1 : 0, tools: ["execute_code"] });
      assert.equal(await exists(path.join(options.workdir, ".execution")), false,
        "absent SDK arguments must never be manufactured or passed to the script executor");
    }
    emitMalformedArguments(options, "execute_code");
  }, async abort() {}, async dispose() {} }), { policy: { maxToolCalls: 1, repairAttempts: 2 }, material: "original facts",
    profile: { fileSubmission: true, toolNames: ["calculate", "execute_code"], requiredReads: () => [],
      toolDescriptions: { calculate: "Calculate exactly.", execute_code: "Write JSON.", submit_evaluation_file: "Submit JSON file." } } });
  try {
    fixture.spec.model.api = "openai-responses";
    await fixture.start(); const status = await fixture.done();
    assert.equal(runs, 4, "three protected malformed calls receive feedback; a fourth cannot extend the total cap");
    assert.equal(status.state, "failed"); assert.equal(status.retryable, false);
    assert.equal(status.failure!.contentSubmissions, 0); assert.equal(status.failure!.fileErrors, 0);
    assert.equal(fixture.counts().posts, 0);
    const record = await readJson<{ metrics: { audit: { calls: number } } }>(path.join(fixture.directory, "worker/attempt/attempt.json"));
    assert.equal(record.metrics.audit.calls, 4, "exploration and all three protected failed writers each count once");
  } finally { await fixture.close(); }
});

test("malformed inspection and later malformed final preserve the immutable inspection and bank", async () => {
  let runs = 0;
  let before: FailureContext;
  const fixture = await harness(async options => ({ async run(prompt) {
    runs++;
    if (runs === 1) { emitMalformedArguments(options,"inspect_material"); return; }
    const feedback = JSON.parse(prompt);
    if (runs === 2) {
      assert.equal(feedback.next_tool,"inspect_material");
      await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content", offset: 0 });
      await inspectMaterials(options,{actual:"original facts"});
      before = structuredClone(fixture.store.state.manifest.states[fixture.spec.taskId].failure!);
      emitMalformedArguments(options,"submit_evaluation"); return;
    }
    assert.equal(feedback.next_tool,"submit_evaluation");
    const checkpoint = fixture.store.state.manifest.states[fixture.spec.taskId].failure!;
    assert(checkpoint.inspection); assert(before.evidenceBank!.length > 0);
    assert.deepEqual(checkpoint.evidenceBank,before.evidenceBank);
    assert.deepEqual(checkpoint.inspection,before.inspection);
    assert.equal(checkpoint.contentSubmissions,1);
    assert.equal(checkpoint.fileErrors,2);
    assert.equal((await submitFor(options, {ok:true})).isError,undefined);
  }, async abort() {}, async dispose() {} }), { policy: { repairAttempts: 3 }, material: "original facts", profile: inspectionProfile });
  try {
    fixture.spec.model.api="openai-responses";
    await fixture.start(); assert.equal((await fixture.done()).state,"succeeded");
    const receipt=(await fixture.store.receipt(fixture.spec.taskId))!;
    assert.equal(runs,3); assert.equal(fixture.inspectionPosts(),1); assert(receipt.audit.inspection);
    assert.equal(receipt.submissionStats!.contentSubmissions,2);
  } finally { await fixture.close(); }
});

for (const [name, rawStopReason, api] of [
  ["unregistered_network_tool", "completed", "openai-responses"],
  ["submit_evaluation", "incomplete.max_output_tokens", "openai-responses"],
  ["submit_evaluation", "failed", "openai-responses"],
  ["submit_evaluation", "completed", "openai-completions"],
] as const)
  test(`SDK argument repair rejects untrusted phase ${name}/${rawStopReason}/${api}`, async () => {
    let runs = 0;
    const fixture = await harness(async options => ({ async run() {
      runs++;
      options.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", rawStopReason,
        errorMessage: malformedArguments(name) } });
    }, async abort() {}, async dispose() {} }), { material: "original facts" });
    try {
      fixture.spec.model.api = api;
      await fixture.start(); const status = await fixture.done();
      assert.equal(status.state,"failed"); assert.equal(status.retryable,false);
      assert.equal(runs,1); assert.equal(status.failure!.contentSubmissions,0); assert.equal(fixture.counts().posts,0);
    } finally { await fixture.close(); }
  });

test("same-run recovery counts a malformed final without repeating an accepted inspection", async () => {
  let resumed = 0;
  const fixture = await harness(async options => ({ async run(prompt) {
    if (options.spec.attemptId === "attempt") {
      await options.execute("read_trace",{candidate:"answer",message_index:0,path:"/content",offset:0});
      await inspectMaterials(options,{actual:"original facts"});
      throw new Error("fixture connection lost after inspection");
    }
    if (++resumed === 1) { emitMalformedArguments(options,"submit_evaluation"); return; }
    const feedback=JSON.parse(prompt);
    assert.equal(feedback.next_tool,"submit_evaluation");
    assert.equal(feedback.budget.content_remaining,2);
    assert.equal((await submitFor(options, {ok:true})).isError,undefined);
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: inspectionProfile });
  try {
    fixture.spec.model.api="openai-responses";
    await fixture.start(); const first=await fixture.done(); assert(first.failure!.inspection);
    await fixture.store.checkpoint(fixture.spec.taskId,first.failure!);
    await fixture.store.endAttempt(fixture.spec,"failed",first.error!);
    const policy={...fixture.spec.policy,repairAttempts:1};
    const spec={...fixture.spec,attemptId:"resumed-malformed",policy,recovery:first.failure,
      prompt:fixture.prepared.renderAttempt(policy,first.failure),evidenceBank:[...first.failure!.evidenceBank!],deadline:Date.now()+10000};
    await fixture.start(spec); const second=await fixture.done(spec.attemptId);
    assert.equal(second.state,"succeeded"); assert.equal(resumed,2); assert.equal(fixture.inspectionPosts(),1);
    const receipt=(await fixture.store.receipt(spec.taskId))!;
    assert.equal(receipt.submissionStats!.contentSubmissions,2);
    assert.deepEqual(receipt.audit.inspection,first.failure!.inspection);
    assert.deepEqual(receipt.audit.evidenceBank,first.failure!.evidenceBank);
  } finally { await fixture.close(); }
});

test("repair exhaustion preserves its cause instead of a generic SDK abort", async () => {
  const fixture = await harness(
    async (options) => ({
      async run() {
        await submitFor(options, draftFor(options.spec, {}));
        throw new Error("This operation was aborted");
      },
      async abort() {},
      async dispose() {},
    }), { policy: { repairAttempts: 0 } },
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

const inspectionProfile: Partial<AgentProfile> = {
  toolNames: ["read_trace", "inspect_material"],
  toolDescriptions: { read_trace: "Read source text.", inspect_material: "Independently inspect original materials.", submit_evaluation: "Submit JSON." },
  renderPrompt: input => JSON.stringify(input),
  inspection: { schema: { type: "object", additionalProperties: false, required: ["actual"], properties: { actual: { type: "string" } } },
    validate(_request, value) {
      if ((value as { actual: string }).actual !== "original facts") throw new ValidationError([
        { category: "evidence", code: "actual_mismatch", path: "/actual", message: "Use the actual original facts." },
      ]);
    } },
};

for (const method of ["accept", "inspect"] as const)
  for (const deadline of [false, true])
    test(`Host ${method} acknowledgement waits use the task deadline, not model idle time (${deadline})`, async () => {
      let entered = false, release = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const fixture = await harness(async options => ({ async run() {
        await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
        if (method === "inspect") await inspectMaterials(options, { actual: "original facts" });
        await submitFor(options, { ok: true });
      }, async abort() {}, async dispose() {} }), {
        material: "original facts", policy: { idleTimeoutSeconds: 1 },
        ...(method === "inspect" ? { profile: inspectionProfile } : {}),
      });
      const accept = fixture.store.accept.bind(fixture.store), inspect = fixture.store.inspect.bind(fixture.store);
      if (method === "accept") fixture.store.accept = async value => { entered = true; await gate; return accept(value); };
      else fixture.store.inspect = async value => { entered = true; await gate; return inspect(value); };
      try {
        fixture.spec.deadline = Date.now() + 5000;
        await fixture.start();
        await waitForTestState(async () => entered, Boolean, "submission reaches the Host");
        await new Promise(resolve => setTimeout(resolve, 1100));
        const waiting = await request<AttemptStatus>(fixture.worker.url + "/api/attempts/attempt");
        assert.equal(waiting.state, "running", "Host acknowledgement is active submission work, not model idleness");
        if (!deadline) release();
        const status = await fixture.done();
        assert.equal(status.state, deadline ? "timed_out" : "succeeded");
        if (deadline) assert.equal(status.error, "Task deadline exceeded");
        else assert.equal((await fixture.store.receipt(fixture.spec.taskId))?.submissionStats?.contentSubmissions,
          method === "inspect" ? 2 : 1);
      } finally { release(); await fixture.close(); }
    });

for (const inspect of [false, true])
  test(`failed first drafting and the revealed phase share a bounded writer allowance (${inspect})`, async () => {
    const write = (value: unknown) => ({ language: "python", code:
      `from pathlib import Path\nPath('evaluation.json').write_text(${JSON.stringify(JSON.stringify(value))}, encoding='utf-8')`, outputs: ["evaluation.json"] });
    const fixture = await harness(async options => ({
      async run() {
        await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
        const spent = await options.execute("calculate", { operation: "add", operands: ["1", "1"] });
        const budget = object(object(spent.details).budget);
        assert.equal(object(budget.exploration).remaining, 0);
        const failed = await options.execute("execute_code", { language: "python", code: "raise AssertionError('first writer failed')", outputs: ["evaluation.json"] });
        assert.equal(failed.isError, true);
        assert.deepEqual(object(object(failed.details).budget).draft_writes, { used: 1, remaining: 1, tools: ["execute_code"] });
        const contentTool = inspect ? "inspect_material" : "submit_evaluation_file";
        const missing = await options.execute(contentTool, { path: "missing.json" });
        assert.equal(missing.isError, true);
        const written = await options.execute("execute_code", write(inspect ? { actual: "original facts" } : { ok: true }));
        assert.notEqual(written.isError, true, "the first file must remain writable after all exploration calls are spent");
        const submitted = await options.execute(contentTool, { path: "evaluation.json" });
        assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
        if (inspect) {
          for (let index = 0; index < 3; index++) {
            const calculated = await options.execute("calculate", { operation: "add", operands: ["1", "1"] });
            assert.notEqual(calculated.isError, true);
          }
          const final = await options.execute("execute_code", write({ ok: true }));
          assert.notEqual(final.isError, true, "revealing the verdict must reserve its own final draft write");
          assert.deepEqual(object(object(final.details).budget).draft_writes, { used: 3, remaining: 0, tools: ["execute_code"] });
          const extra = await options.execute("execute_code", write({ ok: true }));
          assert.equal(extra.isError, true, "the initial failure, corrected inspection and final writer share the original cap");
          assert.equal((await options.execute("submit_evaluation_file", { path: "evaluation.json" })).terminate, true);
        } else assert.equal(submitted.terminate, true);
      }, async abort() {}, async dispose() {},
    }), { material: "original facts", policy: { maxToolCalls: 1, repairAttempts: 2 }, profile: {
      ...(inspect ? inspectionProfile : {}), fileSubmission: true,
      toolNames: ["read_trace", "calculate", "execute_code", ...(inspect ? ["inspect_material"] : [])],
      toolDescriptions: { read_trace: "Read source text.", calculate: "Calculate exactly.", execute_code: "Write JSON.",
        ...(inspect ? { inspect_material: "Inspect JSON." } : {}), submit_evaluation_file: "Submit a JSON file." },
    } });
    try {
      await fixture.start();
      const status = await fixture.done();
      assert.equal(status.state, "succeeded", status.error);
      const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
      assert.deepEqual(receipt.submissionStats, { contentSubmissions: inspect ? 2 : 1, fileErrors: 1 });
      assert.equal(receipt.audit.calls, inspect ? 8 : 4, "mandatory reads and all successful or failed writers remain real audited calls");
      assert.equal(fixture.inspectionPosts(), Number(inspect));
    } finally { await fixture.close(); }
  });

for (const fileSubmission of [false, true])
test(`inspection preserves original JSON fields at the Host (file submission: ${fileSubmission})`, async () => {
  const original = { checks: [{ answer_evidence: [], source_evidence: [], detail: {} }], concerns: [],
    source_reviews: [{}, { nested: [{}, { text: 'quoted "text"\\path\nline' }] }],
    ...JSON.parse('{"__proto__":{"preserved":true},"constructor":{},"prototype":[]}') };
  const profile: Partial<AgentProfile> = { ...inspectionProfile, fileSubmission,
    toolDescriptions: { read_trace: "Read source text.", inspect_material: "Independently inspect original materials.",
      ...(fileSubmission ? { submit_evaluation_file: "Submit JSON file." } : { submit_evaluation: "Submit JSON." }) }, inspection: {
    schema: { type: "object" }, validate(_request, value) { assert.deepEqual(value, original); },
  } };
  const fixture = await harness(async options => ({ async run() {
    const inspectionTool = options.tools.find(tool => tool.name === "inspect_material")!;
    assert.deepEqual(inspectionTool.inputSchema, fileSubmission ? { type: "object", additionalProperties: false,
      required: ["path"], properties: { path: { type: "string", minLength: 1 } } } : profile.inspection!.schema);
    assert.equal(inspectionTool.description.includes('"file_content_schema"'), fileSubmission);
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    const inspected = await inspectMaterials(options, original);
    assert.equal(inspected.isError, undefined, JSON.stringify(inspected));
    assert.deepEqual(await readJson(path.join(options.workdir, "submission-rejected.json")), original);
    assert.equal((await submitFor(options, { ok: true })).isError, undefined);
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: profile });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
    assert.deepEqual(receipt.audit.inspection!.value, original);
    assert.equal(receipt.submissionStats!.contentSubmissions, 2);
    assert.equal(fixture.inspectionPosts(), 1);
    const events = (await readFile(path.join(fixture.directory, "worker/attempt/events.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as WorkerEvent);
    const started = events.find(event => event.type === "tool_start" && object(event.data).name === "inspect_material")!;
    assert.deepEqual(object(started.data).args, fileSubmission ? { path: "inspection.json" } : original);
    const submitted = events.filter(event => event.type === "submission" && object(event.data).inspection === true);
    assert.equal(submitted.length, 1);
    assert.deepEqual(object(submitted[0]!.data).evaluation, original);
    assert.equal(object(submitted[0]!.data).content_loaded, true);
    assert.equal(object(submitted[0]!.data).contentSubmissions, 1);
  } finally { await fixture.close(); }
});

for (const kind of ["body", "missing", "malformed", "outside", "symlink"] as const)
  test(`inspection file ${kind} errors spend file budget without revealing or spending content`, async () => {
    const fixture = await harness(async options => ({ async run() {
      await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
      let args: unknown = { path: "missing-inspection.json" };
      if (kind === "body") args = { actual: "original facts" };
      else if (kind === "malformed") {
        await writeFile(path.join(options.workdir, "invalid-inspection.json"), '{"actual":');
        args = { path: "invalid-inspection.json" };
      } else if (kind === "outside" || kind === "symlink") {
        const outside = path.join(options.workdir, "..", "outside-inspection.json");
        await writeFile(outside, JSON.stringify({ actual: "original facts" }));
        if (kind === "outside") args = { path: "../outside-inspection.json" };
        else {
          await symlink(outside, path.join(options.workdir, "inspection-link.json"));
          args = { path: "inspection-link.json" };
        }
      }
      const rejected = await options.execute("inspect_material", args);
      assert.equal(rejected.isError, true);
      const feedback = rejected.details as { errors: ValidationIssue[]; next_tool: string; message: string; instructions: string;
        budget: { content_remaining: number; file_errors_remaining: number } };
      assert.equal(feedback.errors[0]!.code, "submission_file_invalid");
      assert.equal(feedback.next_tool, "inspect_material");
      assert.equal(feedback.message, inspectionProfile.toolDescriptions!.inspect_material);
      assert.equal(feedback.instructions, inspectionProfile.toolDescriptions!.inspect_material);
      assert(!JSON.stringify(feedback).includes("hidden conclusion"));
      assert.equal(feedback.budget.content_remaining, 1 + options.spec.policy.repairAttempts,
        "file errors preserve the complete content submission budget");
      assert.equal(feedback.budget.file_errors_remaining, 2);
      assert.equal(fixture.store.state.manifest.states[fixture.spec.taskId].failure!.contentSubmissions, 0);
      assert.equal(fixture.inspectionPosts(), 0);
      const inspected = await inspectMaterials(options, { actual: "original facts" });
      assert.equal(inspected.isError, undefined);
      assert.equal((inspected.details as { next_tool: string }).next_tool, "submit_evaluation_file");
      assert.equal((await submitFor(options, { ok: true })).isError, undefined);
    }, async abort() {}, async dispose() {} }), { material: "original facts", profile: {
      ...inspectionProfile, fileSubmission: true, toolDescriptions: {
        read_trace: "Read source text.", inspect_material: "Independently inspect original materials.",
        submit_evaluation_file: "Submit JSON file.",
      },
    } });
    try {
      await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
      const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
      assert.deepEqual(receipt.submissionStats, { contentSubmissions: 2, fileErrors: 1 });
      assert.equal(fixture.inspectionPosts(), 1);
    } finally { await fixture.close(); }
  });

for (const fileSubmission of [false, true])
  test(`inspection and final feedback retain their actual phase (file submission: ${fileSubmission})`, async () => {
    const fixture = await harness(async options => ({ async run() {
      await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
      const wrong = await inspectMaterials(options, { actual: "wrong" });
      const before = wrong.details as { next_tool: string; message: string; instructions: string };
      assert.equal(before.next_tool, "inspect_material");
      assert.equal(before.message, inspectionProfile.toolDescriptions!.inspect_material);
      assert.equal(before.instructions, before.message);
      assert(!JSON.stringify(before).includes("hidden conclusion"));
      assert.equal(fixture.store.state.manifest.states[fixture.spec.taskId].failure!.contentSubmissions, 1);
      const inspected = await inspectMaterials(options, { actual: "original facts" });
      assert.equal(inspected.isError, undefined);
      assert.equal((inspected.details as { next_tool: string }).next_tool,
        fileSubmission ? "submit_evaluation_file" : "submit_evaluation");
      const finalRejected = await submitFor(options, { ok: false });
      assert.equal(finalRejected.isError, true);
      assert.equal((finalRejected.details as { next_tool: string }).next_tool,
        fileSubmission ? "submit_evaluation_file" : "submit_evaluation");
      assert.equal((await submitFor(options, { ok: true })).isError, undefined);
    }, async abort() {}, async dispose() {} }), { policy: { repairAttempts: 3 }, material: "original facts", profile: {
      ...inspectionProfile, fileSubmission, toolDescriptions: {
        read_trace: "Read source text.", inspect_material: "Independently inspect original materials.",
        ...(fileSubmission ? { submit_evaluation_file: "Submit JSON file." } : { submit_evaluation: "Submit JSON." }) },
    } });
    try {
      await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
      assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions, 4);
    } finally { await fixture.close(); }
  });

for (const fileSubmission of [false, true])
test(`inspection and final submission preserve one content queue (file submission: ${fileSubmission})`, async () => {
  const fixture = await harness(async options => ({ async run() {
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    if (fileSubmission) {
      await writeFile(path.join(options.workdir, "wrong-inspection.json"), JSON.stringify({ actual: "wrong" }));
      await writeFile(path.join(options.workdir, "inspection.json"), JSON.stringify({ actual: "original facts" }));
    }
    const [wrong, inspected, final] = await Promise.all([
      options.execute("inspect_material", fileSubmission ? { path: "wrong-inspection.json" } : { path: "inspection.json" }),
      options.execute("inspect_material", fileSubmission ? { path: "inspection.json" } : { actual: "original facts" }),
      submitFor(options, { ok: true }),
    ]);
    assert.equal(wrong.isError, true); assert.equal(inspected.isError, undefined); assert.equal(final.isError, undefined);
    if (!fileSubmission) assert((wrong.details as { errors: ValidationIssue[] }).errors.every(error => error.category !== "file"),
      "a path object in direct mode is submitted as JSON, never loaded as a file");
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: {
    ...inspectionProfile, fileSubmission, toolDescriptions: {
      read_trace: "Read source text.", inspect_material: "Independently inspect original materials.",
      ...(fileSubmission ? { submit_evaluation_file: "Submit JSON file." } : { submit_evaluation: "Submit JSON." }),
    },
  } });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    const receipt = (await fixture.store.receipt(fixture.spec.taskId))!;
    assert.equal(receipt.submissionStats!.contentSubmissions, 3);
    assert.equal(receipt.submissionStats!.fileErrors, 0);
    assert.deepEqual(receipt.audit.inspection!.value, { actual: "original facts" });
    assert.equal(fixture.inspectionPosts(), 2);
  } finally { await fixture.close(); }
});

test("material inspection and final submission share the same content counter and real Host checkpoint", async () => {
  const fixture = await harness(async options => ({ async run() {
    assert(!options.spec.prompt.includes("hidden conclusion"));
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    const spent = await options.execute("calculate", { operation: "add", operands: ["1", "1"] });
    assert.equal(object(object(object(spent.details).budget).exploration).remaining, 0);
    assert.deepEqual(object(object(spent.details).budget).draft_writes, { used: 0, remaining: 0, tools: ["execute_code"] });
    const blocked = await options.execute("execute_code", { language: "python", code: "raise AssertionError('must not execute')" });
    assert.equal(blocked.isError, true, "direct inspection does not reserve a writer after exploration is spent");
    const inspected = await inspectMaterials(options, { actual: "original facts" });
    assert.equal(inspected.isError, undefined); assert(JSON.stringify(inspected).includes("hidden conclusion"));
    assert.equal((inspected.details as { budget: { content_remaining: number } }).budget.content_remaining, 1);
    assert.equal(object(object(object(inspected.details).budget).draft_writes).remaining, 0);
    assert.equal((await submitFor(options, { ok: true })).isError, undefined);
  }, async abort() {}, async dispose() {} }), { policy: { maxToolCalls: 1, repairAttempts: 1 }, material: "original facts", profile: {
    ...inspectionProfile, toolNames: ["read_trace", "calculate", "execute_code", "inspect_material"],
    toolDescriptions: { ...inspectionProfile.toolDescriptions, calculate: "Calculate exactly.", execute_code: "Calculate with Python." },
  } });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.equal(receipt!.submissionStats!.contentSubmissions, 2); assert.equal(receipt!.audit.calls, 2);
    assert.deepEqual(receipt!.audit.inspection!.value, { actual: "original facts" });
    assert.deepEqual(fixture.counts(), { posts: 1, lookups: 0 }); assert.equal(fixture.inspectionPosts(), 1);
  } finally { await fixture.close(); }
});

test("three failed inspections plus a valid fourth cannot obtain a hidden fifth final submission", async () => {
  let finalAttempted = false;
  const fixture = await harness(async options => ({ async run() {
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    for (let i = 0; i < 3; i++) assert.equal((await inspectMaterials(options, { actual: "wrong" })).isError, true);
    const success = await inspectMaterials(options, { actual: "original facts" });
    assert.equal(success.isError, undefined); assert.equal((success.details as { budget: { content_remaining: number } }).budget.content_remaining, 0);
    finalAttempted = true; await submitFor(options, { ok: true });
  }, async abort() {}, async dispose() {} }), { policy: { repairAttempts: 3 }, material: "original facts", profile: inspectionProfile });
  try {
    await fixture.start(); const status = await fixture.done(); assert.equal(status.state, "failed");
    assert.equal(finalAttempted, true); assert.equal(status.failure!.contentSubmissions, 4);
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
    assert.equal(fixture.counts().posts, 0); assert.equal(fixture.inspectionPosts(), 4);
    assert(status.failure!.inspection, "successful fourth inspection stays recoverable despite exhausted final space");
  } finally { await fixture.close(); }
});

test("same-payload transport retry does not consume another inspection draft", async () => {
  const fixture = await harness(async options => ({ async run() {
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    assert.equal((await inspectMaterials(options, { actual: "original facts" })).isError, undefined);
    assert.equal((await submitFor(options, { ok: true })).isError, undefined);
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: inspectionProfile, dropInspectionAck: true });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    assert.equal(fixture.inspectionPosts(), 2);
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions, 2);
  } finally { await fixture.close(); }
});

test("final submission before inspection is rejected and consumes the shared content budget", async () => {
  const fixture = await harness(async options => ({ async run() {
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    const rejected = await submitFor(options, { ok: true });
    assert.equal(rejected.isError, true);
    assert(JSON.stringify(rejected).includes("inspection_required"));
    assert(JSON.stringify(rejected).includes("inspect_material"));
    assert.equal((await inspectMaterials(options, { actual: "original facts" })).isError, undefined);
    assert.equal((await submitFor(options, { ok: true })).isError, undefined);
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: inspectionProfile });
  try { await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions, 3);
  } finally { await fixture.close(); }
});

test("inspection checkpoint is request-bound, idempotent and cannot be erased by a later failure", async () => {
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }), { material: "original facts", profile: inspectionProfile });
  try {
    await fixture.store.activate(fixture.spec);
    const payload: MaterialInspection = { taskId: fixture.spec.taskId, attemptId: fixture.spec.attemptId, inspectionId: "first-inspection",
      value: { actual: "original facts" }, audit: { ...emptyAudit(), evidenceBank: [...fixture.spec.evidenceBank] }, contentSubmissions: 1 };
    const initial = await fixture.store.inspect(payload), repeat = await fixture.store.inspect(payload); assert.deepEqual(initial, repeat);
    await assert.rejects(fixture.store.inspect({ ...payload, inspectionId: "replaced-inspection" }), /cannot be replaced/);
    await assert.rejects(fixture.store.inspect({ ...payload, attemptId: "other" }), /cancelled/);
    await fixture.store.checkpoint(fixture.spec.taskId, { errors: [], evidenceBank: [...initial.evidenceBank], attemptId: fixture.spec.attemptId, contentSubmissions: 2,
      fileErrors: 0, repeatedErrors: 0, stopped: false });
    assert.deepEqual(fixture.store.manifest.states[fixture.spec.taskId]!.failure!.inspection, initial.inspection);
  } finally { await fixture.close(); }
});


test("a session ending after successful inspection gets one bounded final-submission nudge", async () => {
  let calls = 0;
  const fixture = await harness(async options => ({ async run() {
    if (++calls === 1) {
      const pending = await inspectMaterials(options, { actual: "original facts" });
      assert.equal(object(pending.details).material_pending, true);
      assert.equal(fixture.inspectionPosts(), 0, "source delivery must not reveal the verdict or accept an inspection");
      assert.equal(JSON.parse(pending.content[1].text!).evidence[0].quote, "original facts");
      await inspectMaterials(options, { actual: "original facts" });
    }
    else await submitFor(options, { ok: true });
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: inspectionProfile });
  try { await fixture.start(); assert.equal((await fixture.done()).state, "succeeded"); assert.equal(calls, 2);
    assert.equal((await fixture.store.receipt(fixture.spec.taskId))!.submissionStats!.contentSubmissions, 2);
  } finally { await fixture.close(); }
});


test("a recovered successful inspection restores actual proof and revealed context without another inspection draft", async () => {
  const fixture = await harness(async options => ({ async run() {
    if (options.spec.attemptId === "attempt") {
      await options.execute("read_trace", { candidate: "answer", message_index: 0, offset: 0, max_chars: 14, path: "/content" });
      await inspectMaterials(options, { actual: "original facts" });
      throw new Error("fixture disconnect after inspection");
    }
    assert(options.spec.prompt.includes("hidden conclusion"));
    assert.equal((await submitFor(options, { ok: true })).isError, undefined);
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: inspectionProfile });
  try {
    await fixture.start(); const first = await fixture.done(); assert.equal(first.state, "failed"); assert(first.failure!.inspection);
    await fixture.store.checkpoint(fixture.spec.taskId, first.failure!);
    await fixture.store.endAttempt(fixture.spec, "failed", first.error!);
    const policy = { ...fixture.spec.policy, repairAttempts: 2 }, spec = { ...fixture.spec, attemptId: "resumed-inspection", policy,
      recovery: first.failure, prompt: fixture.prepared.renderAttempt(policy, first.failure), evidenceBank: [...fixture.prepared.evidenceBank], deadline: Date.now() + 10000 };
    await fixture.store.activate(spec); await request(fixture.worker.url + "/api/attempts", "POST", spec);
    const second = await fixture.done(spec.attemptId);
    assert.equal(second.state, "succeeded"); assert.equal(fixture.inspectionPosts(), 1);
    const receipt = await fixture.store.receipt(spec.taskId); assert.equal(receipt!.submissionStats!.contentSubmissions, 2);
    assert.deepEqual(receipt!.audit.inspection, first.failure!.inspection);
    assert(receipt!.audit.traceReads.some(read => read.path === "/content" && read.start === 0 && read.end === 14));
  } finally { await fixture.close(); }
});


test("ordinary recovery checkpoint cannot forge inspection or reduce an already spent content count", async () => {
  const fixture = await harness(async () => ({ async run() {}, async abort() {}, async dispose() {} }), { policy: { repairAttempts: 3 }, material: "original facts", profile: inspectionProfile });
  try {
    await fixture.store.activate(fixture.spec);
    const forged = { id: "forged", value: { actual: "original facts" }, proof: { traceReads: [], viewedImages: [] } };
    const failure: FailureContext = { errors: [], evidenceBank: [...fixture.spec.evidenceBank], attemptId: fixture.spec.attemptId, contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: false };
    await assert.rejects(fixture.store.checkpoint(fixture.spec.taskId, { ...failure, inspection: forged }), /successful Host inspection/);
    await assert.rejects(fixture.store.accept({ submissionId: "forged-final", attemptId: fixture.spec.attemptId, taskId: fixture.spec.taskId,
      evaluation: { ok: true }, audit: { ...emptyAudit(), evidenceBank: [...fixture.spec.evidenceBank], inspection: forged }, usage: emptyUsage(),
      submissionStats: { contentSubmissions: 1, fileErrors: 0 } }), /先调用 inspect_material/);
    assert.equal(fixture.inspectionPosts(), 0); assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
    await fixture.store.checkpoint(fixture.spec.taskId, { ...failure, contentSubmissions: 3 });
    const payload: MaterialInspection = { taskId: fixture.spec.taskId, attemptId: fixture.spec.attemptId, inspectionId: "real-inspection",
      value: forged.value, audit: { ...emptyAudit(), evidenceBank: [...fixture.spec.evidenceBank] }, contentSubmissions: 1 };
    await assert.rejects(fixture.store.inspect(payload), /advance the shared/);
    const successful = await fixture.store.inspect({ ...payload, contentSubmissions: 4 });
    await fixture.store.checkpoint(fixture.spec.taskId, { ...failure, contentSubmissions: 0 });
    assert.equal(fixture.store.manifest.states[fixture.spec.taskId]!.failure!.contentSubmissions, 4);
    const audit = { ...emptyAudit(), evidenceBank: [...successful.evidenceBank], inspection: successful.inspection };
    await assert.rejects(fixture.store.accept({ submissionId: "hidden-fifth", attemptId: fixture.spec.attemptId, taskId: fixture.spec.taskId,
      evaluation: { ok: true }, audit, usage: emptyUsage(), submissionStats: { contentSubmissions: 5, fileErrors: 0 } }), /共用本次剩余内容预算/);
    assert.equal(await fixture.store.receipt(fixture.spec.taskId), undefined);
  } finally { await fixture.close(); }
});

test("successful inspection delivers the complete Host context beyond ordinary tool-output limits", async () => {
  const upstream = "hidden conclusion:" + "x".repeat(32000) + "REVEALED_CONTEXT_TAIL";
  const fixture = await harness(async options => ({ async run() {
    await options.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" });
    const inspection = await inspectMaterials(options, { actual: "original facts" });
    assert.equal(inspection.isError, undefined);
    assert.equal((inspection.details as { accepted?: boolean }).accepted, true);
    const revealed = JSON.parse(inspection.content[0]!.text!) as { material: { upstream: string } };
    assert.equal(revealed.material.upstream, upstream, "all later findings and verdict fields must reach the model");
    assert.equal(fixture.inspectionPosts(), 1);
    assert.equal((await submitFor(options, { ok: true })).isError, undefined);
  }, async abort() {}, async dispose() {} }), { material: "original facts", profile: inspectionProfile, revealedInput: { upstream } });
  try {
    await fixture.start(); assert.equal((await fixture.done()).state, "succeeded");
    const receipt = await fixture.store.receipt(fixture.spec.taskId);
    assert.equal(receipt!.submissionStats!.contentSubmissions, 2);
    assert.equal(receipt!.audit.artifacts.length, 0, "revealed task context does not need an unread delegated artifact");
  } finally { await fixture.close(); }
});
