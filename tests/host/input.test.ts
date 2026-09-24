import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { buildPlan, comparisonPair, loadConfig } from "../../packages/pairwise-eval/src/input.js";
import { pairwisePack, validateEvaluation } from "../../packages/pairwise-eval/src/index.js";
import { annotateFindings } from "../../packages/pairwise-eval/src/annotations.js";
import type { Finding } from "../../packages/pairwise-eval/src/types.js";
import { emptyAudit, fixtureConfig, pairResult, raw } from "./fixtures.js";
import path from "node:path";
import { ArtifactStore, ROOT, compressFile, readInputs, writeInputs, writeJsonl } from "../../packages/contracts/src/io.js";
import { createRegistry, ToolRuntime } from "../../packages/tools/src/index.js";

test("compressed input archive preserves full records and rejects truncated storage", async () => {
  const { directory } = await fixtureConfig();
  try {
    const inputs = {
      first: { ...raw(), trace: "中文与 emoji 🦊\n".repeat(10000), image: "data:image/png;base64,aW1hZ2U=" },
      second: raw("q2", null),
    };
    await writeInputs(directory, inputs);
    assert.deepEqual(await readInputs(directory), inputs);
    const file = path.join(directory, "_internal/inputs.jsonl.gz"), bytes = await readFile(file);
    assert(bytes.length < JSON.stringify(inputs).length / 10);
    await assert.rejects(writeJsonl(file, (function* () {
      yield { id: "replacement", value: {} };
      throw new Error("Input producer failed");
    })()), /Input producer failed/);
    assert((await readFile(file)).equals(bytes), "failed archive writes must preserve the previous file");
    await assert.rejects(compressFile(path.join(directory, "missing.jsonl")), /ENOENT/);
    await writeFile(file, bytes.subarray(0, bytes.length - 10));
    await assert.rejects(readInputs(directory), /unexpected end/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration resolves the shared gateway and uses the data directory", async () => {
  const file = path.join(ROOT, "configs/host.json");
  const config = await loadConfig(file, { EVAL_BASE_URL: "https://gateway.example/v1" });
  assert.equal(config.judge.baseUrl, "https://gateway.example/v1");
  assert.equal(config.judge.apiKeyEnv, "EVAL_API_KEY");
  assert.equal(config.outputDir, path.join(ROOT, "data/runs"));
  for (const version of config.inputs.versions)
    assert.equal(version.path, path.join(ROOT, "data/inputs", version.id + ".jsonl"));
  await assert.rejects(loadConfig(file, {}), /Missing EVAL_BASE_URL/);
  await assert.rejects(loadConfig(file, { EVAL_BASE_URL: "file:///tmp/model" }), /Invalid model baseUrl/);
});

test("all ordered pairs admit only same-tier cross-group comparisons", () => {
  const ids = ["a_fast", "a_expert", "aa_fast", "aa_expert"];
  for (const a of ids)
    for (const b of ids) {
      const allowed =
        (a === "a_fast" && b === "aa_fast") ||
        (b === "a_fast" && a === "aa_fast") ||
        (a === "a_expert" && b === "aa_expert") ||
        (b === "a_expert" && a === "aa_expert");
      if (allowed) assert.equal(comparisonPair([a, b]).length, 2);
      else assert.throws(() => comparisonPair([a, b]));
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
      (await buildPlan(config)).tasks.filter((t) => t.stage === "pairwise").map((t) => t.data),
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
    const prompts = path.join(ROOT, "packages/pairwise-eval/resources/prompts");
    const system = (await readFile(path.join(prompts, "system.md"), "utf8")).trim();
    const instructions: Record<string, string> = {};
    for (const stage of ["correctness", "pairwise"]) {
      const instruction = (await readFile(path.join(prompts, `${stage}.md`), "utf8")).trim();
      instructions[stage] = instruction;
      const task = plan.tasks.find((item) => item.stage === stage)!;
      const prepared = pairwisePack.prepare(task, plan.inputs, {});
      assert.equal(prepared.evaluation.systemPrompt, system);
      assert(prepared.prompt.startsWith(instruction + "\n任务材料"));
      assert(prepared.prompt.includes("计算2+2"));
    }
    const snapshot = pairwisePack.snapshots!()["contract.json"] as Record<string, unknown>;
    assert.equal(snapshot.systemPrompt, system);
    assert.deepEqual(snapshot.instructions, instructions);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("subjective inputs skip correctness, and direct evidence needs no forced tool calls", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks[0];
    assert.equal(plan.tasks.length, 1);
    assert.deepEqual(task.dependencies, {});
    const prepared = pairwisePack.prepare(task, plan.inputs, {});
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
    { type: "function_call_output", call_id: "f", output: "<referencable-result>\nID: 1\n财务数据" },
    { type: "function_call", name: "web_search", call_id: "s" },
    { type: "function_call_output", call_id: "s", output: "<referencable-result>\nID: 2\n新闻" },
    { type: "message", role: "assistant", content: "财务数据[^1]。新闻[^2]。" },
  ];
  const finding = { evidence: [{ message_index: 5, quote: "财务数据[^1]" }] } as Finding;
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
    assert.throws(() => validateEvaluation(plan.tasks[0], plan.inputs, result, emptyAudit(), {}), (error: unknown) => {
      assert(error instanceof Error);
      for (const location of [
        "counterevidence 缺少 A:1",
        "counterevidence 缺少 B:0",
        "evaluations.A.findings[0].evidence[0]",
        "evaluations.B.findings[0].evidence[0]",
      ]) assert(error.message.includes(location), error.message);
      return true;
    });
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
