import { services as appServices } from "@eval/host-app/composition";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig, createModelResolver } from "@eval/host-app/config";
import { adapt, buildPlan, comparisonPair, inputAdapterIds, inputAdapters } from "@eval/workflows/pairwise";
import { prepare, validateEvaluation } from "../../fixtures/services.js";
import { annotateFindings } from "@eval/workflows/pairwise";
import type { Finding } from "@eval/workflows/pairwise";
import { emptyAudit, fixtureConfig, pairResult, raw } from "../../fixtures/pairwise.js";
import path from "node:path";
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
  assert.equal(host.models.bindings.correctness?.profile, "judge");
  assert.equal(host.models.bindings.pairwise?.profile, "judge");
  assert.equal(host.evaluation.output.path, path.join(ROOT, "data/runs/pairwise"));
  for (const version of host.evaluation.inputs.versions)
    assert.equal(version.sources[0].path, path.join(ROOT, "data/sources/model-answers"));
  assert.throws(() => createModelResolver(host.models)("correctness"), /Missing model id/);
  const resolved = await loadConfig([file, path.join(ROOT, "configs/models.example.json")], {
    EVAL_BASE_URL: "https://gateway.example/v1",
  });
  const modelForStage = createModelResolver(resolved.models);
  assert.equal(modelForStage("correctness").model, "your-gateway-model-id");
  assert.equal(modelForStage("correctness").maxOutputTokens, 4096);
  assert.equal(modelForStage("pairwise").maxOutputTokens, 8192);
  assert.equal(modelForStage("pairwise").thinking, "low");
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
    assert.equal(plan.summary.pairwise_tasks, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no-standard-answer flags on all versions skip correctness tasks", async () => {
  const input = raw();
  input.has_standard_answer = false;
  const { directory, config } = await fixtureConfig([[input], [input], [input], [input]]);
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.summary.correctness_tasks, 0);
    assert.equal(plan.summary.subjective_inputs_skipping_correctness, 4);
    assert.equal(plan.summary.pairwise_tasks, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("comparison pairs are configured, not fixed to built-in versions", async () => {
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
    config.pairs = [["deepseek", "kimi"]];
    const plan = await buildPlan(config);
    assert.deepEqual(plan.summary.allowed_pairs, [["deepseek", "kimi"]]);
    assert.equal(plan.summary.pairwise_tasks, 1);
    const pair = (plan.tasks.find((task) => task.stage === "pairwise")!.data as { pair: string[] }).pair!;
    assert.equal(pair.join("__vs__"), "deepseek__vs__kimi");
    for (const invalid of [["deepseek"], ["deepseek", "deepseek"]]) assert.throws(() => comparisonPair(invalid));
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
      task = plan.tasks[0],
      result = pairResult(),
      audit = emptyAudit();
    result.evaluations.A.findings[0].evidence[0].quote = "[图像观察]图片呈现结果";
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
    assert.equal(plan.tasks.length, 6);
    assert.equal(plan.summary.correctness_tasks, 4);
    assert.equal(plan.summary.pairwise_tasks, 2);
    const original = plan.tasks.filter((t) => t.stage === "pairwise").map((t) => t.data);
    config.inputs.versions.reverse();
    assert.deepEqual(
      (await buildPlan(config, plan)).tasks.filter((t) => t.stage === "pairwise").map((t) => t.data),
      original,
    );
    for (const task of plan.tasks.filter((t) => t.stage === "pairwise"))
      assert.equal(Object.keys(task.dependencies).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("duplicate input invalidates only affected pair; conflicting question invalidates case", async () => {
  const { directory, config } = await fixtureConfig([[raw(), raw()], [raw()], [raw()], [raw()]]);
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.summary.pairwise_tasks, 1);
    assert.match(JSON.stringify(plan.summary.issues), /duplicate_input/);
    assert.equal(plan.summary.correctness_tasks, 2);
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
    const system = (
      await readFile(path.join(prompts, "comparison/profiles/default/system.md"), "utf8")
    ).trim();
    const instructions: Record<string, string> = {};
    for (const stage of ["correctness", "pairwise"]) {
      const instruction = (
        await readFile(
          path.join(
            prompts,
            stage === "pairwise"
              ? "comparison/profiles/default/instructions.md"
              : "critique/profiles/correctness/instructions.md",
          ),
          "utf8",
        )
      ).trim();
      instructions[stage] = instruction;
      const task = plan.tasks.find((item) => item.stage === stage)!;
      const prepared = prepare(task, plan.inputs, {});
      assert.equal(prepared.evaluation.systemPrompt, system);
      assert(prepared.prompt.startsWith(instruction + "\n任务材料"));
      assert(prepared.prompt.includes("计算2+2"));
      const rules = prepared.evaluation.systemPrompt + "\n" + instruction;
      assert(rules.includes("evidence_id"));
      assert(rules.includes("submit_evaluation"));
      if (stage === "correctness") {
        assert(!rules.includes("both_good"));
        assert(!rules.includes("decisive_findings"));
        assert(rules.includes("final_message_index"));
      } else {
        for (const rule of [
          "both_good",
          "both_bad",
          "decisive_findings",
          "counterevidence",
          "requirement_uncovered",
        ])
          assert(rules.includes(rule), rule);
      }
    }
    const snapshot = appServices.snapshots["contract.json"] as Record<string, unknown>;
    assert.equal(snapshot.systemPrompt, system);
    assert.deepEqual(snapshot.instructions, instructions);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subjective inputs skip correctness, and direct evidence needs no forced tool calls", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks[0];
    assert.equal(plan.tasks.length, 1);
    assert.deepEqual(task.dependencies, {});
    const prepared = prepare(task, plan.inputs, {});
    assert(!prepared.evaluation.toolNames.includes("set_task_contract"));
    validateEvaluation(task, plan.inputs, pairResult(), emptyAudit(), {});
    const bad = pairResult();
    bad.evaluations.A.findings[0].evidence[0].quote = "fabricated";
    assert.throws(() => validateEvaluation(task, plan.inputs, bad, emptyAudit(), {}), /原文/);
    const uncertain = pairResult();
    uncertain.evaluations.A.findings[0].assessment.evidence_status = "uncertain";
    assert.throws(() => validateEvaluation(task, plan.inputs, uncertain, emptyAudit(), {}), /不确定/);
    const wrong = pairResult();
    wrong.decision_basis.decisive_findings[0].finding_index = 7;
    assert.throws(() => validateEvaluation(task, plan.inputs, wrong, emptyAudit(), {}), /不存在/);
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

test("submission feedback locates every invalid quote and missing counterevidence", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config),
      result = pairResult();
    result.verdict.result = "A_better";
    const problem = structuredClone(result.evaluations.A.findings[0]);
    problem.type = "problem";
    result.evaluations.A.findings.push(problem);
    result.evaluations.A.findings[0].evidence[0].quote = "invented A";
    result.evaluations.B.findings[0].evidence[0].quote = "invented B";
    assert.throws(
      () => validateEvaluation(plan.tasks[0], plan.inputs, result, emptyAudit(), {}),
      (error: unknown) => {
        assert(error instanceof Error);
        for (const location of [
          "counterevidence 缺少 A:1",
          "counterevidence 缺少 B:0",
          "evaluations.A.findings[0].evidence[0]",
          "evaluations.B.findings[0].evidence[0]",
        ])
          assert(error.message.includes(location), error.message);
        return true;
      },
    );
    result.decision_basis.counterevidence = [
      { candidate: "A", finding_index: 1 },
      { candidate: "B", finding_index: 0 },
    ];
    result.evaluations.A.findings[0].evidence[0].quote = "2+2=4";
    result.evaluations.B.findings[0].evidence[0].quote = "2+2=4";
    validateEvaluation(plan.tasks[0], plan.inputs, result, emptyAudit(), {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
