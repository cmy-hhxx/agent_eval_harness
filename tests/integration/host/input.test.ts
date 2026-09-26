import { services as appServices } from "@eval/host-app/composition";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig, createModelResolver } from "@eval/host-app/config";
import { adapt, buildPlan, inputAdapterIds, inputAdapters } from "@eval/workflows/comparison";
import { prepare, validateEvaluation } from "../../fixtures/services.js";
import { annotateFindings } from "@eval/workflows/comparison";
import type { Finding } from "@eval/workflows/comparison";
import type { TaskData } from "@eval/workflows/comparison";
import { emptyAudit, fakeEvaluatorVersion, fakeJudge, fixtureConfig, attributionResult, raw } from "../../fixtures/comparison.js";
import path from "node:path";
import { emptyUsage } from "@eval/contracts";
import { ArtifactStore, compressFile, readJsonl, writeJsonl } from "@eval/data";
import { ROOT } from "../../fixtures/services.js";
import { createRegistry, ToolRuntime } from "@eval/tools";

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
  assert.equal(host.models.bindings.comparison?.profile, "judge");
  assert.equal(host.models.bindings.rewrite?.profile, "judge");
  assert.equal(host.evaluation.output.path, path.join(ROOT, "data/runs/comparison"));
  for (const version of host.evaluation.inputs.versions)
    assert.equal(version.sources[0].path, path.join(ROOT, "data/sources/model-answers", version.id));
  assert.throws(() => createModelResolver(host.models)("attribution"), /Missing model id/);
  const resolved = await loadConfig([file, path.join(ROOT, "configs/models.example.json")], {
    EVAL_BASE_URL: "https://gateway.example/v1",
  });
  const modelForStage = createModelResolver(resolved.models);
  assert.equal(modelForStage("attribution").model, "your-gateway-model-id");
  assert.equal(modelForStage("attribution").maxOutputTokens, 4096);
  assert.equal(modelForStage("comparison").maxOutputTokens, 8192);
  assert.equal(modelForStage("comparison").thinking, "low");
  assert.equal(modelForStage("rewrite").model, "your-gateway-model-id");
  await assert.rejects(loadConfig(file, {}), /Missing EVAL_BASE_URL/);
  await assert.rejects(loadConfig(file, { EVAL_BASE_URL: "file:///tmp/model" }), /Invalid EVAL_BASE_URL/);
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
  assert(inputAdapterIds.includes("a") && inputAdapterIds.includes("aa"));
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
      result = attributionResult(false, "2+2=4", false),
      audit = emptyAudit();
    result.findings[0].evidence[0].quote = "[图像观察]图片呈现结果";
    assert.throws(() => validateEvaluation(task, plan.inputs, result, audit, {}), /未查看/);
    const runtime = new ToolRuntime(
      {
        attemptId: "image",
        workdir: directory,
        inputs: new Map([["A", input]]),
        policy: config.execution,
        audit,
        artifacts: new ArtifactStore(path.join(directory, "artifacts")),
      },
      createRegistry().select(["view_image"]),
    );
    const viewed = await runtime.execute(
      "view_image",
      { candidate: "A", message_index: 1 },
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
    assert.equal(plan.tasks.length, 3);
    assert.equal(plan.summary.attribution_tasks, 2);
    assert.equal(plan.summary.comparison_tasks, 1);
    const original = plan.tasks.filter((t) => t.stage === "comparison").map((t) => t.data);
    config.inputs.versions.reverse();
    assert.deepEqual(
      (await buildPlan(config, plan)).tasks.filter((t) => t.stage === "comparison").map((t) => t.data),
      original,
    );
    for (const task of plan.tasks.filter((t) => t.stage === "comparison"))
      assert.equal(Object.keys(task.dependencies).length, 2);
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
test("prompt resources reach both task stages and the run snapshot", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const plan = await buildPlan(config);
    const prompts = path.join(ROOT, "packages/agents/src");
    const systems: Record<string, string> = {};
    const instructions: Record<string, string> = {};
    for (const stage of ["attribution", "comparison"]) {
      const profile =
        stage === "comparison" ? "comparison/profiles/default" : "attribution/profiles/default";
      const system = (await readFile(path.join(prompts, profile, "system.md"), "utf8")).trim();
      const instruction = (await readFile(path.join(prompts, profile, "instructions.md"), "utf8")).trim();
      systems[stage] = system;
      instructions[stage] = instruction;
      const task = plan.tasks.find((item) => item.stage === stage)!;
      const prepared = prepare(task, plan.inputs, {});
      assert.equal(prepared.evaluation.systemPrompt, system);
      assert(prepared.prompt.startsWith(instruction + "\n任务材料"));
      assert(prepared.prompt.includes("计算2+2"));
      const rules = system + "\n" + instruction;
      assert(rules.includes("evidence_id"));
      assert(rules.includes("submit_evaluation"));
      if (stage === "attribution") {
        assert(!rules.includes("both_good"));
        assert(!rules.includes("decisive_findings"));
        assert(instruction.includes("final_message_index"));
        assert(rules.includes("strength 的 problem 必须为 null"));
        assert(rules.includes("问题库由聚类阶段统一维护"));
      } else {
        for (const rule of [
          "ranking",
          "assessments",
          "meets_core",
          "decisive_findings",
          "finding_index",
        ])
          assert(rules.includes(rule), rule);
      }
    }
    const snapshot = appServices.snapshots["contract.json"] as Record<string, unknown>;
    assert.equal(snapshot.systemPrompt, systems.comparison);
    assert.deepEqual(snapshot.instructions, instructions);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subjective inputs still run attribution and direct evidence needs no forced tool calls", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks.find((item) => item.stage === "attribution")!;
    assert.equal(plan.tasks.length, 3);
    assert.deepEqual(task.dependencies, {});
    const prepared = prepare(task, plan.inputs, {});
    assert(!prepared.evaluation.toolNames.includes("set_task_contract"));
    validateEvaluation(task, plan.inputs, attributionResult(true, "2+2=4", false), emptyAudit(), {});
    const bad = attributionResult(true, "2+2=4", false);
    bad.findings[0].evidence[0].quote = "fabricated";
    assert.throws(() => validateEvaluation(task, plan.inputs, bad, emptyAudit(), {}), /原文|证据/);
    const subjective = attributionResult(true, "2+2=4");
    assert.throws(
      () => validateEvaluation(task, plan.inputs, subjective, emptyAudit(), {}),
      /has_standard_answer/,
    );
    const forged = attributionResult(true, "2+2=4", false);
    forged.findings[0] = {
      ...forged.findings[0],
      type: "problem",
      problem: { component: "组件", label: "问题", definition: "描述" },
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
      output: "<referencable-result>\nID: 1\n财务数据",
    },
    { type: "function_call", name: "web_search", call_id: "s" },
    {
      type: "function_call_output",
      call_id: "s",
      output: "<referencable-result>\nID: 2\n新闻",
    },
    { type: "message", role: "assistant", content: "财务数据[^1]。新闻[^2]。" },
  ];
  const finding = {
    evidence: [{ message_index: 5, quote: "财务数据[^1]" }],
  } as Finding;
  assert.deepEqual(annotateFindings(input, [finding])[0], {
    tools: ["FinQuery"],
    confidence: "high",
    source: "quote_reference",
    locations: [{ message_index: 2, tool_name: "FinQuery" }],
  });
  finding.evidence[0].quote = "财务数据";
  const trace = annotateFindings(input, [finding])[0];
  assert.deepEqual(trace.tools, []);
  assert.deepEqual(trace.candidate_tools, ["FinQuery", "Search"]);
});

test("submission feedback locates invalid comparison references", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks.find((item) => item.stage === "comparison")!,
      labels = Object.keys((task.data as TaskData).candidates);
    const attributions = Object.fromEntries(
      Object.entries(task.dependencies).map(([label, id]) => [
        label,
        {
          taskId: id,
          attemptId: `a-${label}`,
          submissionId: id,
          evaluation: attributionResult(true, "2+2=4", false),
          evaluatorVersion: fakeEvaluatorVersion,
          judge: fakeJudge,
          audit: emptyAudit(),
          usage: emptyUsage(),
          status: "succeeded" as const,
          acceptedAt: 0,
        },
      ]),
    );
    const result = {
      task_analysis: {
        task_type: "整数加法",
        goal: "计算2+2",
        requirements: ["给出正确的加法结果"],
        scoring_points: ["使用指定操作数"],
        red_flags: ["擅自替换操作数"],
      },
      ranking: [labels],
      assessments: Object.fromEntries(labels.map((label) => [label, { meets_core: true, summary: "结论。" }])),
      decision_basis: {
        tradeoff: "并列。",
        decisive_findings: [{ candidate: labels[0]!, finding_index: 9 }],
      },
    };
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
