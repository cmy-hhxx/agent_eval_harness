import { services as appServices } from "@eval/host-app/composition";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { loadConfig, createModelResolver } from "@eval/host-app/config";
import { adapt, buildPlan, createInputScanCache, inputAdapterIds, inputAdapters } from "@eval/workflows/comparison";
import { prepare, validateEvaluation } from "../../fixtures/services.js";
import { annotateFindings } from "@eval/workflows/comparison";
import type { Finding } from "@eval/workflows/comparison";
import type { TaskData, RawInput } from "@eval/workflows/comparison";
import { emptyAudit, fakeEvaluatorVersion, fakeJudge, fixtureConfig, attributionResult, raw } from "../../fixtures/comparison.js";
import path from "node:path";
import { canonical, emptyUsage } from "@eval/contracts";
import { ArtifactStore, compressFile, fileSourceReader, readJsonl, writeJsonl } from "@eval/data";
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
  assert.equal(modelForStage("attribution").maxOutputTokens, 8192);
  assert.equal(modelForStage("attribution").thinking, "medium");
  assert.equal(modelForStage("comparison").maxOutputTokens, 8192);
  assert.equal(modelForStage("comparison").thinking, "medium");
  assert.equal(modelForStage("rewrite").model, "your-gateway-model-id");
  await assert.rejects(loadConfig(file, {}), /Missing EVAL_BASE_URL/);
  await assert.rejects(loadConfig(file, { EVAL_BASE_URL: "file:///tmp/model" }), /Invalid EVAL_BASE_URL/);
});

test("default comparisons plan separate Fast and Expert matches", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const loaded = await loadConfig(path.join(ROOT, "configs/host.json"), { EVAL_BASE_URL: "https://gateway.example/v1" });
    config.comparisons = loaded.evaluation.comparisons;
    const plan = await buildPlan(config);
    assert.deepEqual(plan.summary.comparisons, [
      ["a_fast", "aa_fast"], ["a_expert", "aa_expert"],
    ]);
    assert.deepEqual(plan.tasks.filter((task) => task.stage === "comparison")
      .map((task) => (task.data as TaskData).group), plan.summary.comparisons);
    assert.equal(plan.summary.attribution_tasks, 4);
    assert.equal(plan.summary.comparison_tasks, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    for (const [id, name] of [["deepseek", "DeepSeek"], ["kimi", "Kimi"]] as const) {
      const source = path.join(directory, `${id}.jsonl`);
      await writeJsonl(source, [raw("q1")]);
      config.inputs.versions.push({ id, name, adapter: "a", sources: [{ kind: "file", path: source }] });
    }
    config.comparisons = [["a_fast", "aa_fast", "deepseek"], ["a_expert", "aa_expert", "kimi"]];
    const root = path.join(ROOT, "configs/host.json");
    const loaded = await loadConfig(root, { EVAL_BASE_URL: "https://gateway.example/v1" });
    await writeFile(file, JSON.stringify({
      inputs: { versions: [...loaded.evaluation.inputs.versions, ...config.inputs.versions.slice(4)] },
      comparisons: config.comparisons,
    }));
    assert.deepEqual((await loadConfig([root, file], { EVAL_BASE_URL: "https://gateway.example/v1" })).evaluation.comparisons, config.comparisons);
    const plan = await buildPlan(config);
    assert.equal(plan.summary.comparison_tasks, 2);
    assert.deepEqual(plan.tasks.filter((task) => task.stage === "comparison")
      .map((task) => (task.data as TaskData).group), config.comparisons);
  } finally {
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
        inputs: new Map([["answer", input]]),
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
    const reinterpreted = await collect(current, { ...version, adapter: "aa" });
    assert(reinterpreted[0]!.error, "adapter changes must revalidate the same source");
    assert.equal(scans, 4);
  } finally {
    fileSourceReader.lines = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("prompt resources reach both task stages and the run snapshot", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const plan = await buildPlan(config);
    const prompts = path.join(ROOT, "packages/prompts/resources");
    const systems: Record<string, string> = {};
    const instructions: Record<string, string> = {};
    const nudge = (await readFile(path.join(prompts, "shared/nudge.md"), "utf8")).trim();
    for (const stage of ["attribution", "comparison"]) {
      const system = (await readFile(path.join(prompts, stage, "default/system.md"), "utf8")).trim();
      const instruction = (await readFile(path.join(prompts, stage, "default/instructions.md"), "utf8")).trim();
      systems[stage] = system;
      instructions[stage] = instruction;
      const task = plan.tasks.find((item) => item.stage === stage)!;
      const prepared = prepare(task, plan.inputs, {});
      assert.equal(prepared.evaluation.systemPrompt, system);
      assert.equal(prepared.evaluation.submissionNudge, nudge);
      assert(prepared.prompt.startsWith(instruction + "\n任务材料"));
      assert(prepared.prompt.includes("计算2+2"));
      assert(prepared.renderAttempt(config.execution).startsWith(prepared.prompt + "\n\n执行预算："));
      for (const [name, description] of Object.entries(prepared.evaluation.toolDescriptions))
        assert.equal(description, (await readFile(path.join(prompts, "tools", `${name}.md`), "utf8")).trim());
      const rules = system + "\n" + instruction;
      assert(rules.includes("submit_evaluation"));
      if (stage === "attribution") {
        assert(rules.includes("evidence_id"));
        assert(instruction.includes("final_message_index"));
        assert(rules.includes("优点的 `problem=null`"));
        assert(!/其他回答|A\/B\/C|问题库|候选比较|both_good|decisive_findings/.test(rules));
        assert(!prepared.evaluation.toolNames.includes("calculate_pair"));
        assert(prepared.prompt.includes('"answer":{'));
        assert(prepared.prompt.includes('"version_id"'));
        assert(!prepared.prompt.includes('"candidates"'));
      } else {
        assert(!rules.includes("不提交 evidence_id"));
        assert(!rules.includes("不新建问题节点"));
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
    const snapshot = appServices.snapshots["contract.json"] as {
      profiles: Record<string, { systemPrompt: string; instructions: string; submissionNudge: string; toolDescriptions: Record<string, string> }>;
    };
    for (const stage of ["attribution", "comparison"]) {
      assert.equal(snapshot.profiles[stage].systemPrompt, systems[stage]);
      assert.equal(snapshot.profiles[stage].instructions, instructions[stage]);
      assert.equal(snapshot.profiles[stage].submissionNudge, nudge);
      assert(snapshot.profiles[stage].toolDescriptions.submit_evaluation);
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
        comparisons: [{ aspect: "计算结果", importance: "high", better_candidates: [], assessments: Object.fromEntries(
          labels.map((label) => [label, { summary: "正确给出4。", finding_indices: [0] }]),
        ) }],
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
