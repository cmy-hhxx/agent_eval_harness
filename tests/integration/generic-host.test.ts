import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { createRunRepository, type RunCodec } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import {
  DEFAULT_POLICY,
  type AgentBackend,
  type AgentDefinition,
  type AgentProfile,
  type RunState,
  type WorkflowDefinition,
} from "@eval/contracts";

const identity = {
  engine: "pi" as const,
  version: "test",
  commit: "test",
  buildId: "test",
};
const model = {
  provider: "test",
  baseUrl: "http://127.0.0.1:1",
  api: "openai-completions" as const,
  apiKeyEnv: "TEST_KEY",
  model: "test",
  thinking: "off" as const,
  contextWindow: 10000,
  maxOutputTokens: 1000,
};
const profile: AgentProfile = {
  id: "default",
  systemPrompt: "Evaluate JSON.",
  instructions: "Return the value as score.",
  toolNames: [],
  requestSchema: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "number" } },
  },
  submissionSchema: {
    type: "object",
    required: ["score"],
    additionalProperties: false,
    properties: { score: { type: "number" } },
  },
};
const agent: AgentDefinition = {
  id: "numeric",
  profiles: { default: profile },
};
const plan = {
  tasks: [1, 2].map((n) => ({
    id: `task-${n}`,
    stage: "numeric",
    inputIds: { record: `input-${n}` },
    dependencies: {},
    data: null,
  })),
  inputs: { "input-1": { value: 11 }, "input-2": { value: 22 } },
  summary: {},
};
const workflow: WorkflowDefinition = {
  id: "numbers",
  plan: async () => plan,
  bind(task, inputs) {
    const id = task.inputIds.record;
    return {
      agent: "numeric",
      profile: "default",
      request: {
        input: inputs[id] as { value: number },
        sources: { record: { id, value: inputs[id] } },
      },
    };
  },
};
// The generic test codec needs no comparison-only fields or input copies.
const codec: RunCodec<RunState> = {
  encode: (state) => structuredClone(state),
  references: () => [],
  resultId: (row) => String(row.id),
  decode: (value) => value,
};
const repository = createRunRepository(codec, (task, state) => ({
  id: task.id,
  file: "scores.jsonl",
  row: { id: task.id, result: state.receipts[task.id].evaluation },
}));

test("Host accepts generic JSON and profiles replace prompt and schema together", async () => {
  const registry = new AgentRegistry([
    agent,
    {
      id: "text",
      profiles: {
        default: {
          ...profile,
          instructions: "Write a summary.",
          submissionSchema: {
            type: "object",
            required: ["summary"],
            additionalProperties: false,
            properties: { summary: { type: "string" } },
          },
        },
      },
    },
  ]);
  const binding = workflow.bind(plan.tasks[0], plan.inputs, {}),
    audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
  assert(registry.prepare(binding).prompt.startsWith("Return the value as score."));
  assert.throws(() => registry.resolve(binding, { summary: "wrong profile" }, audit), /score/);
  const alternate = { ...binding, agent: "text" };
  assert(registry.prepare(alternate).prompt.startsWith("Write a summary."));
  assert.deepEqual(registry.resolve(alternate, { summary: "eleven" }, audit), {
    summary: "eleven",
  });
  assert.throws(
    () =>
      registry.prepare({
        ...binding,
        request: { ...binding.request, input: { unrelated: true } },
      }),
    /value/,
  );
});

for (const scenario of ["resume", "missing-tool", "invalid-input"]) {
  test(`dependent tasks bind committed results before validation: ${scenario}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eval-dependent-"));
    const dependentPlan = {
      ...plan,
      tasks: [plan.tasks[0], { ...plan.tasks[1], dependencies: { previous: plan.tasks[0].id } }],
    };
    const dependentWorkflow: WorkflowDefinition = {
      ...workflow,
      plan: async () => dependentPlan,
      bind(task, inputs, dependencies) {
        const binding = workflow.bind(task, inputs, dependencies);
        if (task.dependencies.previous) {
          const receipt = dependencies.previous;
          assert.equal(receipt?.taskId, task.dependencies.previous);
          binding.profile = "dependent";
          binding.request.input = {
            value:
              scenario === "invalid-input" ? "invalid" : (receipt!.evaluation as { score: number }).score + 1,
          };
        }
        return binding;
      },
    };
    const entered: string[] = [];
    let skipDependentSubmission = scenario === "resume";
    const worker = await startWorker(
      {
        identity,
        async createSession(options) {
          return {
            async run() {
              entered.push(options.spec.taskId);
              if (options.spec.taskId === plan.tasks[1].id && skipDependentSubmission) return;
              const prompt = options.spec.prompt;
              const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
              const result = await options.execute("submit_evaluation", { score: input.value });
              assert(!result.isError);
            },
            async abort() {},
            async dispose() {},
          };
        },
      },
      path.join(directory, "worker"),
    );
    const options = {
      runId: "dependent",
      config: {},
      engine: "pi" as const,
      identity,
      output: { kind: "directory" as const, path: directory },
      plan: dependentPlan,
      workflow: dependentWorkflow,
      repository,
      agents: new AgentRegistry([
        {
          ...agent,
          profiles: {
            ...agent.profiles,
            dependent: {
              ...profile,
              id: "dependent",
              toolNames: scenario === "missing-tool" ? ["unavailable_tool"] : [],
            },
          },
        },
      ]),
      runtime: { root: directory, workerEntry: "unused-with-external-workers" },
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 10, idleTimeoutSeconds: 5 },
      modelForStage: () => model,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    };
    try {
      if (scenario !== "resume") {
        await assert.rejects(
          runEvaluation(options),
          scenario === "missing-tool" ? /Required engine or tools not available/ : /value/,
        );
        const saved = await repository.readRun(path.join(directory, options.runId));
        assert.deepEqual(saved.receipts[plan.tasks[0].id].evaluation, { score: 11 });
        assert.equal(saved.receipts[plan.tasks[1].id], undefined);
        assert.deepEqual(entered, [plan.tasks[0].id]);
        return;
      }
      await runEvaluation(options);
      const interrupted = await repository.readRun(path.join(directory, options.runId));
      assert.deepEqual(interrupted.receipts[plan.tasks[0].id].evaluation, { score: 11 });
      assert.equal(interrupted.manifest.states[plan.tasks[1].id].status, "failed");

      skipDependentSubmission = false;
      await runEvaluation(options);
      const completed = await repository.readRun(path.join(directory, options.runId));
      assert.deepEqual(completed.receipts[plan.tasks[1].id].evaluation, { score: 12 });
      assert.equal(
        completed.receipts[plan.tasks[0].id].submissionId,
        interrupted.receipts[plan.tasks[0].id].submissionId,
      );
      assert.deepEqual(entered, [plan.tasks[0].id, plan.tasks[1].id, plan.tasks[1].id]);
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("parallel runs isolate sessions, workspaces, results and cancellation; completed generic JSON resumes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-generic-"));
  const workspaces = new Set<string>(),
    sessions = new Set<string>(),
    aborted: string[] = [];
  let entered = 0,
    release!: () => void,
    allStarted!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const backend: AgentBackend = {
    identity,
    async createSession(options) {
      assert(!workspaces.has(options.workdir));
      workspaces.add(options.workdir);
      assert(!sessions.has(options.spec.attemptId));
      sessions.add(options.spec.attemptId);
      let stop!: () => void,
        cancelled = false;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      return {
        async run() {
          entered++;
          if (entered === 4) allStarted();
          await Promise.race([barrier, stopped]);
          if (cancelled) return;
          const raw = JSON.parse(await readFile(path.join(options.workdir, "inputs/record.json"), "utf8"));
          const receipt = await options.execute("submit_evaluation", {
            score: raw.value,
          });
          assert(!receipt.isError);
        },
        async abort() {
          cancelled = true;
          aborted.push(options.spec.runId);
          stop();
        },
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all(
    [0, 1, 2, 3].map((n) => startWorker(backend, path.join(directory, `worker-${n}`))),
  );
  const controller = new AbortController();
  const options = {
    config: {},
    engine: "pi" as const,
    identity,
    output: { kind: "directory" as const, path: directory },
    plan,
    workflow,
    repository,
    agents: new AgentRegistry([agent]),
    runtime: { root: directory, workerEntry: "unused-with-external-workers" },
    policy: { ...DEFAULT_POLICY, timeoutSeconds: 10, idleTimeoutSeconds: 5 },
    modelForStage: () => model,
    concurrency: 2,
    retries: 0,
    retryDelaySeconds: 0,
  };
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    first = runEvaluation({
      ...options,
      runId: "cancelled",
      signal: controller.signal,
      workerUrls: workers.slice(0, 2).map((w) => w.url),
    });
    second = runEvaluation({
      ...options,
      runId: "complete",
      workerUrls: workers.slice(2).map((w) => w.url),
    });
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("parallel sessions did not start")), 5000).unref(),
      ),
    ]);
    await assert.rejects(runEvaluation({ ...options, runId: "complete" }), /owned/);
    controller.abort();
    await first;
    assert.equal(entered, 4);
    assert.deepEqual(new Set(aborted), new Set(["cancelled"]));
    release();
    await second;
    const completed = await repository.readRun(path.join(directory, "complete"));
    assert.equal(Object.keys(completed.receipts).length, 2);
    assert.equal(
      Object.keys((await repository.readRun(path.join(directory, "cancelled"))).receipts).length,
      0,
    );
    const bytes = await readFile(path.join(directory, "complete/results/scores.jsonl"), "utf8");
    assert.deepEqual(
      bytes
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).result.score)
        .sort(),
      [11, 22],
    );
    await runEvaluation({
      ...options,
      runId: "complete",
      plan: {
        ...plan,
        inputs: { "input-1": { value: 99 }, "input-2": { value: 88 } },
      },
      modelForStage: () => ({ ...model, model: "changed" }),
      policy: { ...options.policy, maxToolCalls: 1 },
      workerUrls: [],
    });
    assert.equal(entered, 4);
    assert.deepEqual(
      (await readFile(path.join(directory, "complete/results/scores.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .sort(),
      bytes.trim().split("\n").sort(),
    );
  } finally {
    controller.abort();
    release();
    await Promise.allSettled([first, second]);
    await Promise.all(workers.map((worker) => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
