import { canonicalEvidence } from "../../fixtures/evidence.js";
import { services as appServices } from "@eval/host-app/composition";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig, loadEvaluation, createModelResolver } from "@eval/host-app/config";
import { adapt, buildPlan, createInputScanCache, expandComparisonPairs, inputAdapterIds, inputAdapters, reconcileRun } from "@eval/workflows/comparison";
import { prepare, validateEvaluation } from "../../fixtures/services.js";
import { annotateFindings } from "@eval/workflows/comparison";
import type { Finding } from "@eval/workflows/comparison";
import type { TaskData, RawInput } from "@eval/workflows/comparison";
import { emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig, attributionResult, comparisonResult, criteriaResultForTask, raw } from "../../fixtures/comparison.js";
import path from "node:path";
import { canonical, evidenceId, emptyUsage, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { ArtifactStore, compressFile, fileSourceReader, readJsonl, writeJsonl } from "@eval/data";
import { ROOT } from "../../fixtures/services.js";
import { createRegistry, ToolRuntime } from "@eval/tools";

function fixtureReceipt(taskId: string, evaluation: unknown): SubmissionReceipt {
  return { taskId, attemptId: "fixture", submissionId: taskId, evaluation, evaluatorVersion: fakeEvaluatorVersion,
    judge: fakeJudge, audit: emptyAudit(), usage: emptyUsage(), status: "succeeded", acceptedAt: 0 };
}

test("semantic review configuration retains explicit questions and rejects ambiguous selectors", async () => {
  const { directory } = await fixtureConfig();
  const file = path.join(directory, "review.json"), base = path.join(ROOT, "configs/host.json");
  const entry = { batch_id: "b1", case_id: "q", questions: ["核对限制与实际交付，不预设结论。"] };
  try {
    await writeFile(file, JSON.stringify({ reviewQuestions: [entry] }));
    const loaded = await loadConfig([base, file], { EVAL_BASE_URL: "https://gateway.example/v1" });
    assert.deepEqual(loaded.evaluation.reviewQuestions, [entry]);
    for (const reviewQuestions of [[entry, entry], [{ ...entry, questions: [] }], [{ ...entry, questions: [""] }],
      [{ ...entry, case_id: "" }], [{ ...entry, winner: "A" }]]) {
      await writeFile(file, JSON.stringify({ reviewQuestions }));
      await assert.rejects(loadConfig([base, file], { EVAL_BASE_URL: "https://gateway.example/v1" }), /Invalid reviewQuestions/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("compressed JSONL preserves full records and rejects truncated storage", async () => {
  const { directory } = await fixtureConfig();
  try {
    const rows = [
      {
        ...raw(),
        trace: "中文与 emoji 🦊\n".repeat(10000),
        image: "data:image/png;base64,aW1hZ2U=",
      },
      raw("q2", null),
    ];
    const file = path.join(directory, "records.jsonl.gz");
    const readRows = async () => {
      const values: unknown[] = [];
      for await (const row of readJsonl(file)) values.push(row);
      return values;
    };
    await writeJsonl(file, rows);
    assert.deepEqual(await readRows(), rows);
    const bytes = await readFile(file);
    assert(bytes.length < JSON.stringify(rows).length / 10);
    await assert.rejects(
      writeJsonl(
        file,
        (function* () {
          yield { id: "replacement", value: {} };
          throw new Error("Input producer failed");
        })(),
      ),
      /Input producer failed/,
    );
    assert((await readFile(file)).equals(bytes), "failed archive writes must preserve the previous file");
    await assert.rejects(compressFile(path.join(directory, "missing.jsonl")), /ENOENT/);
    await writeFile(file, bytes.subarray(0, bytes.length - 10));
    await assert.rejects(readRows(), /unexpected end/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration composes layered files and resolves bound models", async () => {
  const file = path.join(ROOT, "configs/host.json");
  const host = await loadConfig(file, { EVAL_BASE_URL: "https://gateway.example/v1" });
  assert.equal(host.models.models.judge?.baseUrl, "https://gateway.example/v1");
  assert.equal(host.models.models.judge?.apiKeyEnv, "EVAL_API_KEY");
  assert.equal(host.models.bindings.attribution?.profile, "judge");
  assert.equal(host.models.bindings.criteria?.profile, "judge");
  assert.equal(host.models.bindings.comparison?.profile, "judge");
  assert.equal(host.models.bindings.rewrite?.profile, "judge");
  assert.equal(host.models.models.judge?.thinking, "medium");
  assert.equal(host.evaluation.execution.concurrency, 8);
  assert.deepEqual(host.evaluation.rewrite, { attribution: true, comparison: true, clustering: true });
  assert.equal(host.evaluation.output.path, path.join(ROOT, "data/runs/comparison"));
  for (const version of host.evaluation.inputs.versions)
    assert.equal(version.sources[0].path, path.join(ROOT, "data/sources/model-answers", version.id));
  assert.throws(() => createModelResolver(host.models)("attribution"), /Missing model id/);
  const resolved = await loadConfig([file, path.join(ROOT, "configs/models.example.json")], {
    EVAL_BASE_URL: "https://gateway.example/v1",
  });
  const modelForStage = createModelResolver(resolved.models);
  const unconfigured = createModelResolver({
    ...resolved.models,
    models: { ...resolved.models.models, judge: { ...resolved.models.models.judge!, thinking: undefined } },
  });
  for (const stage of ["criteria", "attribution", "comparison", "rewrite", "clustering"]) {
    assert.equal(modelForStage(stage).model, "your-gateway-model-id");
    assert.equal(modelForStage(stage).maxOutputTokens, 32768);
    assert.equal(modelForStage(stage).thinking, stage === "attribution" ? "high" : "medium");
    assert.equal(unconfigured(stage).thinking, stage === "attribution" ? "high" : "medium", "stage settings remain explicit when the profile uses its default");
  }
  const overridden = createModelResolver({
    ...resolved.models,
    models: { ...resolved.models.models, judge: { ...resolved.models.models.judge!, thinking: "high" } },
    bindings: { ...resolved.models.bindings, comparison: { ...resolved.models.bindings.comparison, thinking: "low" } },
  });
  assert.equal(overridden("attribution").thinking, "high", "explicit profile reasoning is preserved");
  assert.equal(overridden("comparison").thinking, "low", "stage reasoning overrides the profile default");
  await assert.rejects(loadConfig(file, {}), /Missing EVAL_BASE_URL/);
  await assert.rejects(loadConfig(file, { EVAL_BASE_URL: "file:///tmp/model" }), /Invalid EVAL_BASE_URL/);
});

test("model profiles preserve explicit max effort and endpoint developer-role capabilities", async () => {
  const { directory } = await fixtureConfig();
  try {
    const source = JSON.parse(await readFile(path.join(ROOT, "configs/host.json"), "utf8"));
    source.models.judge.model = "analysis-model";
    source.models.judge.thinking = "max";
    delete source.bindings.attribution.thinking;
    source.models.judge.supportsDeveloperRole = false;
    const file = path.join(directory, "max-profile.json");
    await writeFile(file, JSON.stringify(source));
    const loaded = await loadConfig(file, { EVAL_BASE_URL: "https://gateway.example/v1" });
    const model = createModelResolver(loaded.models)("attribution");
    assert.equal(model.thinking, "max");
    assert.equal(model.supportsDeveloperRole, false);
    assert.equal(loaded.models.models.judge!.supportsDeveloperRole, false);
    const withoutCapability = { ...loaded.models.models.judge! };
    delete withoutCapability.supportsDeveloperRole;
    const defaultModel = createModelResolver({ ...loaded.models, models: { judge: withoutCapability } })("attribution");
    assert.equal(Object.hasOwn(defaultModel, "supportsDeveloperRole"), false);
    source.models.judge.supportsDeveloperRole = "false";
    await writeFile(file, JSON.stringify(source));
    await assert.rejects(loadConfig(file, { EVAL_BASE_URL: "https://gateway.example/v1" }), /supportsDeveloperRole/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("omitted rewrite settings enable each stage while explicit opt-outs remain effective", async () => {
  const { directory } = await fixtureConfig();
  try {
    const source = JSON.parse(await readFile(path.join(ROOT, "configs/host.json"), "utf8"));
    delete source.rewrite;
    const file = path.join(directory, "defaults.json");
    await writeFile(file, JSON.stringify(source));
    const defaults = await loadConfig(file, { EVAL_BASE_URL: "https://gateway.example/v1" });
    assert.deepEqual(defaults.evaluation.rewrite, { comparison: true, attribution: true, clustering: true });
    source.rewrite = { attribution: false };
    await writeFile(file, JSON.stringify(source));
    const partial = await loadConfig(file, { EVAL_BASE_URL: "https://gateway.example/v1" });
    assert.deepEqual(partial.evaluation.rewrite, { comparison: true, attribution: false, clustering: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default comparisons plan separate Fast and Expert matches", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const loaded = await loadConfig(path.join(ROOT, "configs/host.json"), { EVAL_BASE_URL: "https://gateway.example/v1" });
    config.comparisons = loaded.evaluation.comparisons;
    const plan = await buildPlan(config);
    assert.deepEqual(plan.summary.comparisons, [
      ["a_fast", "b_fast"], ["a_expert", "b_expert"],
    ]);
    assert.deepEqual(plan.tasks.filter((task) => task.stage === "comparison")
      .map((task) => (task.data as TaskData).group), plan.summary.comparisons);
    assert.equal(plan.summary.attribution_tasks, 4);
    assert.equal(plan.summary.comparison_tasks, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration and planning reject model IDs that make pair keys ambiguous", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const ambiguous = "a__vs__extra";
    config.inputs.versions[0].id = ambiguous;
    config.comparisons = [[ambiguous, "b_fast"]];
    const file = path.join(directory, "ambiguous-pair.json");
    await writeFile(file, JSON.stringify({ inputs: config.inputs, comparisons: config.comparisons }));
    await assert.rejects(loadConfig([path.join(ROOT, "configs/host.json"), file],
      { EVAL_BASE_URL: "https://gateway.example/v1" }), /保留分隔符 __vs__/);
    await assert.rejects(buildPlan(config), /保留分隔符 __vs__/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("comparison tiers reject Fast/Expert mixing, but allow a third model in each group", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const file = path.join(directory, "comparison.json");
    await writeFile(file, JSON.stringify({ comparisons: [["a_fast", "a_expert"]] }));
    await assert.rejects(loadConfig([path.join(ROOT, "configs/host.json"), file], { EVAL_BASE_URL: "https://gateway.example/v1" }), /Fast.*Expert|fast.*expert/i);
    config.comparisons = [["a_fast", "a_expert"]];
    await assert.rejects(buildPlan(config), /Fast.*Expert|fast.*expert/i);
    await assert.rejects(loadConfig(path.join(ROOT, "configs/host.json"),
      { EVAL_BASE_URL: "https://gateway.example/v1" }, { versions: ["a_fast", "a_expert"] }),
    /没有可比较的组合/);
    for (const [id, name, tier] of [["deepseek", "DeepSeek", "Fast"], ["kimi", "Kimi", "Expert"]] as const) {
      const source = path.join(directory, `${id}.jsonl`);
      await writeJsonl(source, [raw("q1")]);
      config.inputs.versions.push({ id, name, comparison_tier: tier, adapter: "a", sources: [{ kind: "file", path: source }] });
    }
    config.comparisons = [["a_fast", "b_fast", "deepseek"], ["a_expert", "b_expert", "kimi"]];
    const root = path.join(ROOT, "configs/host.json");
    const loaded = await loadConfig(root, { EVAL_BASE_URL: "https://gateway.example/v1" });
    await writeFile(file, JSON.stringify({
      inputs: { versions: [...loaded.evaluation.inputs.versions, ...config.inputs.versions.slice(4)] },
      comparisons: config.comparisons,
    }));
    assert.deepEqual((await loadConfig([root, file], { EVAL_BASE_URL: "https://gateway.example/v1" })).evaluation.comparisons, config.comparisons);
    const plan = await buildPlan(config);
    assert.equal(plan.summary.comparison_tasks, 6);
    assert.deepEqual(plan.tasks.filter((task) => task.stage === "comparison")
      .map((task) => (task.data as TaskData).group), [
        ["a_fast", "b_fast"], ["a_fast", "deepseek"], ["b_fast", "deepseek"],
        ["a_expert", "b_expert"], ["a_expert", "kimi"], ["b_expert", "kimi"],
      ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("overlapping comparison groups share one attribution and rewrite per answer", async () => {
  const { directory, config } = await fixtureConfig(undefined, true, true);
  try {
    config.inputs.versions[1].comparison_tier = "Fast";
    config.comparisons = [["a_fast", "b_fast"], ["a_fast", "b_fast", "a_expert"]];
    const plan = await buildPlan(config);
    const attributions = plan.tasks.filter((task) => task.stage === "attribution");
    assert.equal(attributions.length, 3, "each answer is attributed once, regardless of group overlap");
    assert.equal(new Set(attributions.map((task) => task.inputIds.answer)).size, 3);
    const comparisons = plan.tasks.filter((task) => task.stage === "comparison");
    for (const task of comparisons)
      for (const [label, inputId] of Object.entries(task.inputIds))
        assert.equal(task.dependencies[label], attributions.find((task) => task.inputIds.answer === inputId)!.id);
    assert.equal(plan.summary.attribution_tasks, 3);
    assert.equal((plan.summary.by_batch as Record<string, { attribution_tasks: number }>).b1.attribution_tasks, 3);
    assert.equal(plan.summary.rewrite_tasks, 9, "three attributions, three independent comparisons and three clusters");
    const clusters = plan.tasks.filter((task) => task.stage === "clustering");
    const clustered = clusters.flatMap((task) => Object.values(task.dependencies))
      .filter((id) => plan.tasks.find((task) => task.id === id)!.stage === "attribution");
    assert.deepEqual(new Set(clustered), new Set(attributions.map((task) => task.id)));
    assert.equal(clustered.length, 3);
    assert.equal(new Set(attributions.map((task) => task.dependencies.criteria)).size, 1, "shared compatible question scope prepares one rubric");
    for (const cluster of clusters) {
      const refs = Object.values(cluster.dependencies);
      assert.equal(refs.filter((id) => comparisons.some((task) => task.id === id)).length, 0,
        "clustering depends on attribution, independently of pair comparisons");
    }
    const resumed = await buildPlan(config, plan);
    assert.deepEqual(resumed.tasks.map((task) => task.id), plan.tasks.map((task) => task.id));
    assert.deepEqual(resumed.tasks.filter((task) => task.stage === "comparison").map((task) => task.dependencies),
      comparisons.map((task) => task.dependencies));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("three candidates create independent pairs, preserving valid pairs when one answer is missing or conflicts", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    config.inputs.versions[1].comparison_tier = "Fast";
    config.comparisons = [["a_fast", "b_fast", "a_expert"]];
    assert.deepEqual(expandComparisonPairs([...config.comparisons, ["b_fast", "a_fast"]]), [
      ["a_fast", "b_fast"], ["a_fast", "a_expert"], ["b_fast", "a_expert"],
    ]);
    const complete = await buildPlan(config);
    assert.equal(complete.tasks.filter((task) => task.stage === "comparison").length, 3);
    assert.equal(complete.tasks.filter((task) => task.stage === "attribution").length, 3);
    const source = config.inputs.versions[1].sources[0].path;
    await writeJsonl(source, []);
    const missing = await buildPlan(config);
    assert.deepEqual(missing.tasks.filter((task) => task.stage === "comparison").map((task) => (task.data as TaskData).group), [["a_fast", "b_fast"]]);
    assert.equal((missing.summary.skipped as unknown[]).length, 2);
    const conflict = raw(); conflict.messages[0].content = "计算3+3";
    await writeJsonl(source, [conflict]);
    const mismatched = await buildPlan(config);
    assert.deepEqual(mismatched.tasks.filter((task) => task.stage === "comparison").map((task) => (task.data as TaskData).group), [["a_fast", "b_fast"]]);
    assert.equal((mismatched.summary.issues as unknown[]).length, 2);
    delete config.inputs.versions[1].comparison_tier;
    await assert.rejects(buildPlan(config), /comparison_tier/);
    config.comparisons = [["a_fast", "b_fast", "a_expert", "b_expert"]];
    await assert.rejects(buildPlan(config), /2–3/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reversed pair declarations preserve task identities and blind assignment on resume", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const before = await buildPlan(config);
    const original = before.tasks.find((task) => task.stage === "comparison")!;
    config.comparisons = [["b_fast", "a_fast"]];
    const after = await buildPlan(config, before);
    const resumed = after.tasks.find((task) => task.stage === "comparison")!;
    assert.equal(resumed.id, original.id);
    assert.deepEqual((resumed.data as TaskData).candidates, (original.data as TaskData).candidates);
    const accepted = await buildPlan(config, before, { acceptedTaskIds: new Set([original.id]) });
    assert.equal(accepted.tasks.filter((task) => task.stage === "comparison").length, 0, "accepted business pairs are not replanned");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("model selection and resume collapse equivalent narrowed comparison groups", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    config.inputs.versions[1].comparison_tier = "Fast";
    const file = path.join(directory, "groups.json");
    await writeFile(file, JSON.stringify({
      inputs: config.inputs,
      comparisons: [["a_fast", "b_fast"], ["b_fast", "a_fast", "a_expert"]],
      output: config.output, problemLibrary: config.problemLibrary,
      rewrite: config.rewrite, clustering: config.clustering,
    }));
    const sources = [path.join(ROOT, "configs/host.json"), file];
    const env = { EVAL_BASE_URL: "https://gateway.example/v1" };
    const settings = { versions: ["a_fast", "b_fast"] };
    const selected = (await loadConfig(sources, env, settings)).evaluation;
    assert.deepEqual(selected.comparisons, [["a_fast", "b_fast"]], "keep the first group's declared order");
    assert.deepEqual((await loadEvaluation(sources, settings)).comparisons, selected.comparisons);
    const plan = await buildPlan(selected);
    assert.equal(plan.summary.comparison_tasks, 1);
    const state: RunState = {
      manifest: { format: "evaluation-run", runId: "selected", status: "finished", debug: false,
        engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config: selected,
        tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary, startedAt: Date.now(),
        states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
      }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
    };
    const resumed = await reconcileRun(directory, state, (await loadConfig(sources, env)).evaluation);
    assert.deepEqual(resumed.summary.comparisons, selected.comparisons);
    assert.equal(resumed.summary.comparison_tasks, 1);
    assert.deepEqual(resumed.tasks.map((task) => task.id), plan.tasks.map((task) => task.id));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new comparisons shuffle blind labels once and preserve the assignment on resume", async (t) => {
  const { directory, config } = await fixtureConfig();
  const random = t.mock.method(crypto, "randomInt", () => 0);
  syncBuiltinESMExports();
  try {
    const plan = await buildPlan(config);
    assert.equal(random.mock.callCount(), 1, "new two-answer comparisons must run the shuffle");
    const comparison = plan.tasks.find((task) => task.stage === "comparison")!;
    assert.equal((comparison.data as TaskData).candidates.A.version, "b_fast");
    const resumed = await buildPlan(config, plan);
    assert.equal(random.mock.callCount(), 1, "resuming must not reshuffle registered labels");
    assert.deepEqual(resumed.tasks.find((task) => task.stage === "comparison")!.data, comparison.data);
  } finally {
    random.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory input paths merge matching files from date folders", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const inputRoot = path.join(directory, "inputs");
    for (const folder of ["0922", "0923"]) await mkdir(path.join(inputRoot, folder), { recursive: true });
    for (const version of config.inputs.versions) {
      version.sources = [{ kind: "directory", path: inputRoot, include: [version.id + ".jsonl"] }];
      await writeJsonl(path.join(inputRoot, "0922", version.id + ".jsonl"), [raw("day-0922")]);
      await writeJsonl(path.join(inputRoot, "0923", version.id + ".jsonl"), [raw("day-0923")]);
    }
    const plan = await buildPlan(config);
    assert.deepEqual(plan.summary.issues, []);
    assert.equal(plan.summary.valid_inputs, 8);
    assert.equal(plan.summary.cases, 2);
    assert.equal(plan.summary.comparison_tasks, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no-standard-answer samples still run attribution and only skip the correctness verdict", async () => {
  const input = raw();
  input.has_standard_answer = false;
  const { directory, config } = await fixtureConfig([[input], [input], [input], [input]]);
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.summary.attribution_tasks, 2);
    assert.equal(plan.summary.comparison_tasks, 1);
    assert.equal(plan.summary.clustering_tasks, 0, "clustering is opt-in per fixture config");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("comparison groups are configured, not fixed to built-in versions", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const versions: typeof config.inputs.versions = [];
    for (const [id, name] of [
      ["deepseek", "DeepSeek"],
      ["kimi", "Kimi"],
    ] as const) {
      const file = path.join(directory, `${id}.jsonl`);
      await writeJsonl(file, [raw("q1")]);
      versions.push({ id, name, adapter: "a", sources: [{ kind: "file", path: file }] });
    }
    config.inputs.versions = versions;
    config.comparisons = [["deepseek", "kimi"]];
    const plan = await buildPlan(config);
    assert.deepEqual(plan.summary.comparisons, [["deepseek", "kimi"]]);
    assert.equal(plan.summary.comparison_tasks, 1);
    const group = (plan.tasks.find((task) => task.stage === "comparison")!.data as { group: string[] })
      .group!;
    assert.equal(group.join("__vs__"), "deepseek__vs__kimi");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("input adapters are registered by declaration, not by branching", () => {
  assert.deepEqual(inputAdapterIds, ["a", "b"]);
  const record = {
    batch_id: "b1",
    case_id: "q1",
    messages: [
      { type: "question", role: "user", content: "计算2+2" },
      { type: "reply", role: "assistant", content: "2+2=4" },
    ],
    meta: { ok: true, ground_truth: "4", model_id: "custom-model" },
  };
  const version = { id: "custom", name: "Custom", adapter: "custom", sources: [] };
  inputAdapters.custom = {
    id: "custom",
    accepts: (message) => ["question", "reply"].includes(String(message.type)),
    answerModel: (raw) => (raw.meta?.model_id ? String(raw.meta.model_id) : null),
  };
  try {
    const candidate = adapt(record, version, "custom.jsonl", 1);
    assert.equal(candidate.version, "custom");
    assert.equal(candidate.llm, "custom-model");
    assert.throws(() => adapt(record, { ...version, adapter: "nope" }, "custom.jsonl", 1), /未注册的输入适配器/);
  } finally {
    delete inputAdapters.custom;
  }
});
test("image observations require an actual image tool audit", async () => {
  const input = raw("image", null);
  input.messages[1].content = [
    { type: "text", text: "2+2=4" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2UtZml4dHVyZQ==" },
  ];
  const { directory, config } = await fixtureConfig([[input], [], [input], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks.find((item) => item.stage === "attribution")!,
      result = attributionResult(false, "2+2=4", false, task.inputIds.answer!),
      audit = emptyAudit();
    result.criterion_assessments[0].evidence![0] = canonicalEvidence(task.inputIds.answer!, 1, "2+2=4", "/content/0/text");
    result.findings[0].evidence[0] = { evidence_id: evidenceId(task.inputIds.answer!, 1, "image"), message_index: 1, quote: "[图像观察]图片呈现结果" };
    result.findings[0].evidence.push(canonicalEvidence(task.inputIds.answer!, 0, "计算2+2"));
    assert.throws(() => validateEvaluation(task, plan.inputs, result, audit, {}), /未查看/);
    const runtime = new ToolRuntime(
      {
        attemptId: "image",
        workdir: directory,
        inputs: new Map([["answer", input]]),
        inputIds: new Map([["answer", task.inputIds.answer]]),
        policy: config.execution,
        audit,
        artifacts: new ArtifactStore(path.join(directory, "artifacts")),
      },
      createRegistry().select(["view_image"]),
    );
    const viewed = await runtime.execute(
      "view_image",
      { candidate: "answer", message_index: 1 },
      new AbortController().signal,
    );
    assert.equal(viewed.content[1].type, "image");
    validateEvaluation(task, plan.inputs, result, audit, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("planner preserves stage dependencies, fixed pair order and blind assignment", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.tasks.length, 4);
    assert.equal(plan.summary.attribution_tasks, 2);
    assert.equal(plan.summary.comparison_tasks, 1);
    const original = plan.tasks.filter((t) => t.stage === "comparison").map((t) => t.data);
    config.inputs.versions.reverse();
    assert.deepEqual(
      (await buildPlan(config, plan)).tasks.filter((t) => t.stage === "comparison").map((t) => t.data),
      original,
    );
    for (const task of plan.tasks.filter((t) => t.stage === "comparison"))
      assert.equal(Object.keys(task.dependencies).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("duplicate input invalidates only affected group; conflicting question invalidates case", async () => {
  const { directory, config } = await fixtureConfig([[raw()], [raw(), raw()], [raw()], [raw()]]);
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.summary.comparison_tasks, 1);
    assert.match(JSON.stringify(plan.summary.issues), /duplicate_input/);
    assert.equal(plan.summary.attribution_tasks, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const conflicting = raw();
  conflicting.messages[0].content = "计算3+3";
  const second = await fixtureConfig([[raw()], [raw()], [conflicting], [raw()]]);
  try {
    assert.equal((await buildPlan(second.config)).tasks.length, 0);
  } finally {
    await rm(second.directory, { recursive: true, force: true });
  }
});
test("indexed previews preserve validation and selections without retaining answer bodies", async () => {
  const conflict = raw("conflict");
  conflict.messages[0]!.content = "计算3+3";
  const invalid = { ...raw("invalid"), messages: [] };
  const fixture = await fixtureConfig([
    [raw("ok"), raw("duplicate"), raw("duplicate"), raw("conflict"), invalid], [],
    [raw("ok"), raw("duplicate"), conflict, raw("invalid")], [],
  ]);
  const { config, directory } = fixture;
  const scanFile = createInputScanCache();
  try {
    const source = config.inputs.versions[0]!.sources[0]!.path;
    await writeFile(source, (await readFile(source, "utf8")) + "{broken json\n");
    for (const selection of [{}, { limit: 1 }, { case_ids: ["ok"] }, { batches: ["absent"] }]) {
      const selected = { ...config, inputs: { ...config.inputs, ...selection } };
      const regular = await buildPlan(selected, undefined, { materializeInputs: false });
      const indexed = await buildPlan(selected, undefined, { materializeInputs: false, scanFile });
      assert.deepEqual(indexed.summary, regular.summary);
      assert.deepEqual(indexed.inputs, {});
      const catalog = (plan: typeof indexed) => (plan.catalog as Record<string, unknown>[])
        .map(({ input_id: _id, ...record }) => record);
      assert.deepEqual(catalog(indexed), catalog(regular));
    }
    const rows = [];
    for await (const row of scanFile(source, config.inputs.versions[0]!, undefined, await fileSourceReader.revision(source)))
      if (row) rows.push(row);
    assert(rows.length > 0);
    assert(rows.every((row) => !Object.hasOwn(row, "raw")), "cached rows contain projections, not raw traces");
    await assert.rejects(buildPlan(config, undefined, { scanFile }), /只读预检/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("input scan cache shares in-flight reads, rechecks revisions and retries failed reads", async () => {
  const { directory, config } = await fixtureConfig();
  const scanFile = createInputScanCache();
  const version = config.inputs.versions[0]!, source = version.sources[0]!.path;
  const original = fileSourceReader.lines;
  let scans = 0, fail = false;
  fileSourceReader.lines = async function* (...args) {
    scans++;
    yield* original(...args);
    if (fail) throw new Error("test read interrupted");
  };
  const collect = async (revision: string, adapter = version) => {
    const rows = [];
    for await (const row of scanFile(source, adapter, undefined, revision)) rows.push(row);
    return rows;
  };
  try {
    const revision = await fileSourceReader.revision(source);
    await Promise.all([collect(revision), collect(revision)]);
    assert.equal(scans, 1);
    await writeJsonl(source, [raw("changed")]);
    await assert.rejects(collect(revision), /发生变化/);
    const current = await fileSourceReader.revision(source);
    fail = true;
    await assert.rejects(collect(current), /interrupted/);
    fail = false;
    const rows = await collect(current);
    assert.equal(rows[0]!.record!.case_id, "changed");
    assert.equal(scans, 3, "a failed read is evicted and retried");
    const reinterpreted = await collect(current, { ...version, adapter: "b" });
    assert(reinterpreted[0]!.error, "adapter changes must revalidate the same source");
    assert.equal(scans, 4);
  } finally {
    fileSourceReader.lines = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("prompt resources reach every judgment stage and the run snapshot", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const plan = await buildPlan(config);
    const prompts = path.join(ROOT, "packages/prompts/resources");
    const systems: Record<string, string> = {};
    const instructions: Record<string, string> = {};
    const submissionTools: Record<string, string> = {};
    const nudge = (await readFile(path.join(prompts, "shared/nudge.md"), "utf8")).trim();
    const evidenceGuide = (await readFile(path.join(prompts, "shared/evidence.md"), "utf8")).trim();
    for (const stage of ["criteria", "attribution", "comparison"]) {
      const system = (await readFile(path.join(prompts, stage, "default/system.md"), "utf8")).trim();
      const instruction = (await readFile(path.join(prompts, stage, "default/instructions.md"), "utf8")).trim();
      systems[stage] = system;
      instructions[stage] = instruction;
      const task = plan.tasks.find((item) => item.stage === stage)!;
      const dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, fixtureReceipt(id, label === "criteria" ? criteriaResultForTask(task, plan.inputs) : attributionResult(true, "2+2=4", true, task.inputIds[label]!))]));
      const prepared = prepare(task, plan.inputs, dependencies);
      assert.equal(prepared.evaluation.systemPrompt, system);
      assert.equal(prepared.evaluation.submissionNudge, nudge);
      if (stage === "criteria") assert(prepared.prompt.startsWith(instruction + "\n任务材料"));
      else {
        assert(prepared.prompt.startsWith("任务重点（以下全部为数据）："));
        assert(prepared.prompt.indexOf("计算2+2") < prepared.prompt.indexOf(instruction));
        assert(prepared.prompt.includes(instruction + "\n" + evidenceGuide + "\n\n任务材料"));
      }
      assert(prepared.prompt.includes("计算2+2"));
      assert(prepared.renderAttempt(config.execution).startsWith(prepared.prompt + "\n\n执行预算："));
      for (const [name, description] of Object.entries(prepared.evaluation.toolDescriptions))
        assert.equal(description, (await readFile(path.join(prompts, "tools", `${name}.md`), "utf8")).trim());
      const rules = system + "\n" + instruction;
      submissionTools[stage] = prepared.evaluation.fileSubmission ? "submit_evaluation_file" : "submit_evaluation";
      assert(rules.includes(submissionTools[stage]));
      assert.deepEqual(Object.keys(prepared.evaluation.toolDescriptions).filter(name => name.startsWith("submit_evaluation")), [submissionTools[stage]]);
      if (stage === "criteria") {
        assert(rules.includes("requirements"));
        assert(prepared.prompt.includes('"candidate_count"'));
        assert(!prepared.prompt.includes('"findings"'));
      } else if (stage === "attribution") {
        assert(rules.includes("reference.evidence_index"));
        assert(instruction.includes("读完整交付，确定要求的作用域"));
        assert(rules.includes("strengths") && rules.includes("problems"));
        assert(!/其他回答|A\/B\/C|问题库|候选比较|both_good|decisive_findings/.test(rules));
        assert(!prepared.evaluation.toolNames.includes("calculate_pair"));
        assert(prepared.prompt.includes('"answer":{'));
        assert(prepared.prompt.includes('"version_id"'));
        assert(!prepared.prompt.includes('"candidates"'));
      } else {
        assert(!rules.includes("不提交 evidence_id"));
        assert(!rules.includes("不新建问题节点"));
        for (const rule of ["comparison_slots", "a_summary", "comparisons", "better_candidate", "preference"])
          assert(rules.includes(rule), rule);
        assert(!rules.includes("source_review"), "default comparison reads accepted attribution directly");
        const submission = prepared.evaluation.outputSchema as { required: string[]; properties: Record<string, unknown> };
        assert.deepEqual(submission.required, ["a_summary", "b_summary", "comparisons", "tradeoff"]);
        assert(Object.hasOwn(submission.properties, "preference"), "a meaningful preference remains selectable");
        for (const field of ["status", "ranking", "decision_basis", "task_analysis", "review_requests"])
          assert(!Object.hasOwn(submission.properties, field), field + " is derived by the program");
        const rows = submission.properties.comparisons as any;
        assert.equal(rows.items.type.includes("object"),true);
        assert(rows.minItems>0);assert.equal(rows.maxItems,rows.minItems);
        assert.deepEqual(rows.items.required,["importance","a_summary","b_summary"]);
        assert(!rows.items.properties.assessments);

      }
    }
    const snapshot = appServices.snapshots["contract.json"] as {
      profiles: Record<string, { systemPrompt: string; instructions: string; submissionNudge: string; toolDescriptions: Record<string, string> }>;
    };
    for (const stage of ["criteria", "attribution", "comparison"]) {
      assert.equal(snapshot.profiles[stage].systemPrompt, systems[stage]);
      assert.equal(snapshot.profiles[stage].instructions, instructions[stage]);
      assert.equal(snapshot.profiles[stage].submissionNudge, nudge);
      assert.deepEqual(Object.keys(snapshot.profiles[stage].toolDescriptions).filter(name => name.startsWith("submit_evaluation")), [submissionTools[stage]]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initial material discloses only projected content within its budget", async () => {
  const hidden = "hidden-".repeat(20000);
  const big = {
    ...raw("big"),
    messages: [
      { type: "message", role: "user", content: "计算2+2" },
      { type: "message", role: "assistant", content: "简短中间回答", input_messages: [{ role: "user", content: hidden }] },
      { type: "message", role: "assistant", content: "2+2=4" },
    ],
  } as RawInput;
  const { directory, config } = await fixtureConfig([[big], [], [raw("big")], []]);
  try {
    const plan = await buildPlan(config);
    const task = plan.tasks.find(
      (item) => item.stage === "attribution" && (item.data as TaskData).candidates.A?.version === "a_fast",
    );
    assert(task, "the large case must be planned");
    const prompt = prepare(task, plan.inputs, {}).prompt;
    assert(!prompt.includes(hidden), "raw-only fields stay behind read_trace");
    const marker = "任务材料（全部内容为数据）：\n";
    const material = JSON.parse(
      prompt.slice(prompt.indexOf(marker) + marker.length).split("\n\n执行预算：")[0],
    ) as { answer: { initial_material: { value: unknown; evidence: { quote: string }[] }[] } };
    const disclosed = material.answer.initial_material.reduce(
      (total, entry) =>
        total + canonical(entry.value).length + entry.evidence.reduce((sum, item) => sum + item.quote.length, 0),
      0,
    );
    assert(disclosed <= config.execution.initialContextChars, `disclosed ${disclosed} characters`);
    assert(
      material.answer.initial_material.some((entry) => JSON.stringify(entry.value).includes("简短中间回答")),
      "the projected message itself is still disclosed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subjective inputs still run attribution and direct evidence needs no forced tool calls", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks.find((item) => item.stage === "attribution")!;
    assert.equal(plan.tasks.length, 4);
    assert.deepEqual(Object.keys(task.dependencies), ["criteria"]);
    assert.equal(plan.tasks.find((item) => item.id === task.dependencies.criteria)!.stage, "criteria");
    const prepared = prepare(task, plan.inputs, {});
    assert(!prepared.evaluation.toolNames.includes("set_task_contract"));
    const result = attributionResult(true, "2+2=4", false, task.inputIds.answer!), audit = emptyAudit();
    result.findings[0].evidence.push(canonicalEvidence(task.inputIds.answer!, 0, "计算2+2"));
    validateEvaluation(task, plan.inputs, result, audit, {});
    assert.equal(audit.calls, 0);
    const bad = structuredClone(result);
    bad.findings[0].evidence[0].quote = "fabricated";
    assert.throws(() => validateEvaluation(task, plan.inputs, bad, emptyAudit(), {}), /原文|证据/);
    const subjective = attributionResult(true, "2+2=4", true, task.inputIds.answer!);
    assert.throws(
      () => validateEvaluation(task, plan.inputs, subjective, emptyAudit(), {}),
      /has_standard_answer/,
    );
    const forged = structuredClone(result);
    forged.findings[0] = {
      ...forged.findings[0],
      type: "problem",
      problem: { component: ["组件"], label: "问题", definition: "描述" },
    } as (typeof forged.findings)[number];
    assert.throws(
      () => validateEvaluation(task, plan.inputs, forged, emptyAudit(), {}),
      /调用链|具体工具|组件/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("provenance resolves only references in the finding quote", () => {
  const input = raw();
  input.messages = [
    { type: "message", role: "user", content: "问题" },
    { type: "function_call", name: "FinQuery", call_id: "f" },
    {
      type: "function_call_output",
      call_id: "f",
      output: "<referencable-result>\nID: 1\n财务数据\n</referencable-result>",
    },
    { type: "function_call", name: "web_search", call_id: "s" },
    {
      type: "function_call_output",
      call_id: "s",
      output: "<referencable-result>\nID: 2\n新闻\n</referencable-result>",
    },
    { type: "message", role: "assistant", content: "财务数据[^1]。新闻[^2]。" },
  ];
  const finding = {
    evidence: [canonicalEvidence("11111111-1111-4111-8111-111111111111", 5, "财务数据[^1]")],
  } as Finding;
  assert.deepEqual(annotateFindings(input, "11111111-1111-4111-8111-111111111111", [finding])[0], {
    tools: ["FinQuery"],
    confidence: "high",
    source: "quote_reference",
    locations: [{ message_index: 2, tool_name: "FinQuery" }],
  });
  finding.evidence[0] = canonicalEvidence("11111111-1111-4111-8111-111111111111", 5, "财务数据");
  const trace = annotateFindings(input, "11111111-1111-4111-8111-111111111111", [finding])[0];
  assert.deepEqual(trace.tools, []);
  assert.deepEqual(trace.candidate_tools, ["FinQuery", "Search"]);
});

test("submission feedback locates invalid comparison references", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks.find((item) => item.stage === "comparison" && !(item.data as TaskData).verificationAudit)!,
      labels = Object.keys((task.data as TaskData).candidates);
    const attributions = Object.fromEntries(
      Object.entries(task.dependencies).map(([label, id]) => [
        label,
        {
          taskId: id,
          attemptId: `a-${label}`,
          submissionId: id,
          evaluation: label === "criteria" ? criteriaResultForTask(task, plan.inputs) : attributionResult(true, "2+2=4", false, task.inputIds[label]!),
          evaluatorVersion: fakeEvaluatorVersion,
          judge: fakeJudge,
          audit: emptyAudit(),
          usage: emptyUsage(),
          status: "succeeded" as const,
          acceptedAt: 0,
        },
      ]),
    );
    const result = comparisonResult(labels);
    result.task_analysis = criteriaResultForTask(task, plan.inputs);
    result.decision_basis.decisive_findings = [{ candidate: labels[0]!, finding_index: 9 }];
    assert.throws(
      () => validateEvaluation(task, plan.inputs, result, emptyAudit(), attributions),
      /既有 finding/,
    );
    result.decision_basis.decisive_findings = labels.map((label) => ({
      candidate: label,
      finding_index: 0,
    }));
    validateEvaluation(task, plan.inputs, result, emptyAudit(), attributions);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config requires an explicit evaluator version", async () => {
  const { directory } = await fixtureConfig();
  try {
    const source = JSON.parse(await readFile(path.join(ROOT, "configs/host.json"), "utf8"));
    delete source.evaluatorVersion;
    const file = path.join(directory, "missing-version.json");
    await writeFile(file, JSON.stringify(source));
    await assert.rejects(loadConfig(file, { EVAL_BASE_URL: "http://127.0.0.1:1/v1" }), /evaluatorVersion/);
    source.evaluatorVersion = "  ";
    await writeFile(file, JSON.stringify(source));
    await assert.rejects(loadConfig(file, { EVAL_BASE_URL: "http://127.0.0.1:1/v1" }), /evaluatorVersion/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
