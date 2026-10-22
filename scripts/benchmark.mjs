import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { exists, readJson, readJsonl, writeJson, readInputSource, localFiles } from "@eval/data";
import { canonical } from "@eval/contracts";
import { readRunState, loadRunInputs, outputSchema } from "@eval/workflows/comparison";
import { services, agents } from "@eval/host-app/composition";
import { boundProfiles, createModelResolver, loadConfig, testEvaluationOutput } from "@eval/host-app/config";
import { runEvaluation } from "@eval/host";
import { pairSamples, compareSamples, summarizeSamples, goldTemplate, calibrateSamples } from "./benchmark-analysis.mjs";
import { rejectedEvaluationDrafts } from "./benchmark-fixtures.mjs";

const {
  values,
  positionals: [command],
} = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: "string", multiple: true },
    fixtures: { type: "string" },
    output: { type: "string" },
    config: { type: "string", multiple: true, default: ["configs/host.json"] },
    engine: { type: "string", default: "pi" },
    "run-id": { type: "string" },
    limit: { type: "string", default: "32" },
    execute: { type: "boolean" },
    swap: { type: "boolean" },
    gold: { type: "string" },
    "bootstrap-rounds": { type: "string", default: "2000" },
  },
});
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be positive");
if (values.output && command !== "run")
  values.output = testEvaluationOutput(values.output, values.output);

// Locate a record by business identity, tolerant of appends and reordering in the fixture source.
function matchesInput(raw, ref) {
  const meta = raw && typeof raw === "object" ? raw.meta || {} : {};
  const batch = raw?.batch_id ?? meta.batch_id;
  const id = raw?.case_id ?? meta.case_id;
  if (batch !== undefined && String(batch) !== ref.batch) return false;
  if (id !== undefined && String(id) !== ref.case) return false;
  return ref.version === null || raw?.version === ref.version;
}
function restoreInput(lines, ref, source) {
  const parse = (line) => {
    if (!line || !line.trim()) return undefined;
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  };
  const direct = parse(lines[ref.line - 1]);
  if (direct && matchesInput(direct, ref)) return direct;
  for (const line of lines) {
    const raw = parse(line);
    if (raw && matchesInput(raw, ref)) return raw;
  }
  throw new Error("Fixed fixture source record no longer matches: " + source + ":" + ref.line);
}
async function loadFixtures(file) {
  const saved = await readJson(file);
  if (saved.format !== "eval-offline-fixtures")
    throw new Error("Regenerate the fixture index with benchmark collect");
  const sources = new Map(),
    inputs = {};
  for (const [id, ref] of Object.entries(saved.inputs)) {
    if (typeof ref.source !== "string" || typeof ref.batch !== "string" || typeof ref.case !== "string")
      throw new Error("Regenerate the fixture index with benchmark collect");
    if (!sources.has(ref.source))
      sources.set(ref.source, (await readInputSource(ref.source)).replace(/^\uFEFF/, "").split(/\r?\n/));
    inputs[id] = restoreInput(sources.get(ref.source), ref, ref.source);
  }
  for (const fixture of saved.fixtures)
    fixture.inputs = Object.fromEntries(fixture.inputIds.map((id) => [id, inputs[id]]));
  return saved;
}

function evaluate(fixture) {
  try {
    const binding = services.taskSource.bind(fixture.task, fixture.inputs, fixture.dependencies, { tasks: [fixture.task, ...fixture.dependencyTasks] });
    const result = agents.resolve(binding, structuredClone(fixture.draft), fixture.audit);
    agents.validate(binding, result, fixture.audit);
    return { accepted: true, codes: [] };
  } catch (error) {
    return {
      accepted: false,
      codes: [...new Set((error.issues || [{ code: "invalid_draft" }]).map((e) => e.code))].sort(),
    };
  }
}

const resultAjv = new Ajv2020({ allErrors: true, strict: false });
const validateComparison = resultAjv.compile(outputSchema);
const stamp = (info) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
async function loadComparisonSamples(run) {
  const file = path.join(run, "results/comparison.jsonl"), rows = [];
  const stateFile = path.join(run, "state.json");
  const traces = new Map();
  const reviewReceipts = new Map();
  let stateStamp, planned = null;
  if (await exists(stateFile)) {
    const before = stateStamp = stamp(await localFiles.stat(stateFile));
    const checkpoint = await readJson(stateFile);
    if (stamp(await localFiles.stat(stateFile)) !== before) throw new Error("State changed while reading: " + stateFile);
    const comparisons = Object.values(checkpoint.tasks ?? {}).filter((task) => task.stage === "comparison" && !task.data?.verificationAudit);
    planned = { pair_cases: comparisons.length, needs_review: 0 };
    for (const [taskId, task] of Object.entries(checkpoint.tasks ?? {})) {
      const receipt = task.receipt, comparisonId = receipt?.exported?.comparisonId;
      if (task.stage !== "comparison" || task.data?.verificationAudit || !receipt?.exported) continue;
      if (task.status !== "succeeded") throw new Error("Exported comparison receipt is not succeeded: " + taskId);
      if (receipt.exported.file === "comparison-review.jsonl") {
        if (receipt.exported.taskId !== taskId) throw new Error("Review receipt task identity disagrees: " + taskId);
        reviewReceipts.set(taskId, receipt);
        continue;
      }
      if (!comparisonId || receipt.exported.file !== undefined && receipt.exported.file !== "comparison.jsonl" ||
          receipt.evaluation?.status !== undefined && receipt.evaluation.status !== "decided")
        throw new Error("Expected a decided comparison export receipt: " + taskId);
      if (traces.has(comparisonId)) throw new Error("Duplicate comparison receipt: " + comparisonId);
      traces.set(comparisonId, {
        evaluator_version: receipt.evaluatorVersion, judge: receipt.judge,
        task_id: taskId, submission_id: receipt.submissionId,
        trace_status: "receipt_linked",
        criteria_task_id: task.dependencies.criteria ?? null,
        criteria: task.dependencies.criteria ? {
          task_id: task.dependencies.criteria,
          evaluator_version: checkpoint.tasks[task.dependencies.criteria]?.receipt?.evaluatorVersion ?? null,
          judge: checkpoint.tasks[task.dependencies.criteria]?.receipt?.judge ?? null,
        } : null,
        attributions: Object.values(task.dependencies).filter((dependencyId) => checkpoint.tasks[dependencyId]?.stage === "attribution").map((dependencyId) => {
          const dependency = checkpoint.tasks[dependencyId], accepted = dependency?.receipt;
          return {
            task_id: dependencyId,
            version: checkpoint.inputs?.[dependency?.inputIds?.answer]?.version ?? null,
            evaluator_version: accepted?.evaluatorVersion ?? null, judge: accepted?.judge ?? null,
          };
        }).sort((a, b) => (a.version ?? "").localeCompare(b.version ?? "")),
      });
    }
  }
  if (await exists(file)) {
    const before = stamp(await localFiles.stat(file));
    for await (const row of readJsonl(file)) {
      if (!validateComparison(row)) throw new Error("Invalid current comparison export: " + resultAjv.errorsText(validateComparison.errors));
      rows.push(row);
    }
    if (stamp(await localFiles.stat(file)) !== before) throw new Error("Results changed while reading: " + file);
  } else if (!(await exists(run))) throw new Error("Run does not exist: " + run);
  if (planned !== null) {
    const resultIds = new Set(rows.map((row) => row.comparison_id));
    if (rows.some((row) => !traces.has(row.comparison_id)) || [...traces.keys()].some((id) => !resultIds.has(id)))
      throw new Error("Comparison results and succeeded export receipts disagree: " + run);
    const reviewFile = path.join(run, "results/comparison-review.jsonl"), reviewIds = new Set();
    if (await exists(reviewFile)) {
      const before = stamp(await localFiles.stat(reviewFile));
      for await (const row of readJsonl(reviewFile)) {
        const receipt = reviewReceipts.get(row.task_id);
        if (!receipt || reviewIds.has(row.task_id) || row.evaluation_type !== "comparison_review" ||
            row.result?.status !== "needs_review" || row.evaluator_version !== receipt.evaluatorVersion)
          throw new Error("Review results and succeeded export receipts disagree: " + reviewFile);
        reviewIds.add(row.task_id);
      }
      if (stamp(await localFiles.stat(reviewFile)) !== before) throw new Error("Results changed while reading: " + reviewFile);
    }
    if (reviewIds.size !== reviewReceipts.size) throw new Error("Review results and succeeded export receipts disagree: " + reviewFile);
    planned.needs_review = reviewIds.size;
  }
  if (stateStamp && stamp(await localFiles.stat(stateFile)) !== stateStamp) throw new Error("State changed while reading results: " + stateFile);
  return { samples: pairSamples(rows, traces), planned };
}

if (command === "collect") {
  if (!values.run?.length || !values.output)
    throw new Error("collect --run PATH [--run PATH] --output FIXTURES.json [--limit 32]");
  if (await exists(values.output))
    throw new Error("Fixed fixture set already exists; choose a new output path");
  const candidates = [];
  for (const run of values.run) {
    const state = await readRunState(run),
      inputs = await loadRunInputs(state.manifest);
    for (const task of state.manifest.tasks) {
      const directory = path.join(run, "_internal/tasks", task.id);
      if (!(await exists(directory))) continue;
      for (const attempt of (await readdir(directory)).filter((n) => n.startsWith("attempt-")).sort()) {
        const base = path.join(directory, attempt),
          recordFile = path.join(base, "attempt.json");
        if (!(await exists(recordFile))) continue;
        const record = await readJson(recordFile);
        const file = path.join(
          base,
          (await exists(path.join(base, "events.jsonl.gz"))) ? "events.jsonl.gz" : "events.jsonl",
        );
        if (!(await exists(file))) continue;
        for await (const { event, draft } of rejectedEvaluationDrafts(readJsonl(file))) {
          const dependencyTasks = Object.values(task.dependencies).map((id) =>
            state.manifest.tasks.find((t) => t.id === id),
          );
          const ids = new Set([task, ...dependencyTasks].flatMap((t) => Object.values(t.inputIds)));
          const fixture = {
            source: `${base}:${event.seq}`,
            task,
            dependencyTasks,
            inputs: Object.fromEntries([...ids].map((id) => [id, inputs[id]])),
            draft,
            audit: record.metrics?.audit ||
              state.receipts[task.id]?.audit || {
                calls: 0,
                viewedImages: [],
                calculations: [],
                artifacts: [],
                traceReads: [],
              },
            dependencies: Object.fromEntries(
              Object.entries(task.dependencies).map(([label, id]) => [label, state.receipts[id]]),
            ),
          };
          fixture.expected = evaluate(fixture);
          candidates.push(fixture);
        }
      }
    }
  }
  const distinct = new Map(candidates.map((f) => [canonical(f.expected), f]));
  const selected = [...distinct.values()];
  for (const fixture of candidates)
    if (!selected.includes(fixture) && selected.length < limit) selected.push(fixture);
  const fixtures = selected.slice(0, limit);
  const inputs = {};
  for (const fixture of fixtures)
    for (const task of [fixture.task, ...fixture.dependencyTasks])
      for (const c of Object.values(task.data.candidates))
        inputs[c.input_id] = {
          source: c.source,
          line: c.line,
          batch: c.batch_id,
          case: c.case_id,
          version: fixture.inputs[c.input_id]?.version ?? null,
        };
  await writeJson(values.output, {
    format: "eval-offline-fixtures",
    note: "固定草稿与源文件引用，不复制输入，也不代表全量首次通过率",
    observed_rejections: candidates.length,
    inputs,
    fixtures: fixtures.map(({ inputs, ...fixture }) => ({
      ...fixture,
      inputIds: Object.keys(inputs),
    })),
  });
  console.log(
    JSON.stringify(
      {
        file: path.resolve(values.output),
        observed_rejections: candidates.length,
        selected: fixtures.length,
        mechanically_valid: fixtures.filter((f) => f.expected.accepted).length,
      },
      null,
      2,
    ),
  );
} else if (command === "replay") {
  if (!values.fixtures) throw new Error("replay --fixtures FIXTURES.json [--output REPORT.json]");
  const { fixtures } = await loadFixtures(values.fixtures);
  const results = fixtures.map((fixture) => {
    const actual = evaluate(fixture);
    return {
      source: fixture.source,
      expected: fixture.expected,
      actual,
      matches: canonical(actual) === canonical(fixture.expected),
    };
  });
  const report = {
    total: results.length,
    accepted: results.filter((r) => r.actual.accepted).length,
    regressions: results.filter((r) => !r.matches).length,
    results,
  };
  if (values.output) await writeJson(values.output, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.regressions) process.exitCode = 2;
} else if (command === "run") {
  if (!values.fixtures || !values["run-id"])
    throw new Error(
      "run --fixtures FIXTURES.json --run-id ID [--engine pi|prime] [--limit 4] [--swap] [--execute]",
    );
  if (!["pi", "prime"].includes(values.engine)) throw new Error("--engine must be pi or prime");
  const { fixtures } = await loadFixtures(values.fixtures);
  const selected = [
    ...new Map(fixtures.filter((f) => f.task.stage === "comparison").map((f) => [f.task.id, f])).values(),
  ].slice(0, limit);
  if (!selected.length) throw new Error("No comparison fixtures");
  const originals = [
    ...new Map(selected.flatMap((f) => [...f.dependencyTasks, f.task]).map((t) => [t.id, t])).values(),
  ];
  const ids = new Map(originals.map((task) => [task.id, randomUUID()]));
  const tasks = originals.map((original) => {
    const task = structuredClone(original);
    task.id = ids.get(original.id);
    task.data.revision = 1;
    task.dependencies = Object.fromEntries(
      Object.entries(task.dependencies).map(([label, id]) => [label, ids.get(id)]),
    );
    if (task.stage === "comparison") {
      task.data.comparisonId = "cmp_" + randomUUID();
      if (values.swap)
        for (const object of [task.data.candidates, task.inputIds, task.dependencies])
          if (Object.hasOwn(object, "A")) [object.A, object.B] = [object.B, object.A];
    }
    return task;
  });
  console.log(
    JSON.stringify(
      {
        mode: values.execute ? "execute" : "preview",
        comparisons: selected.length,
        tasks: tasks.length,
        swapped: !!values.swap,
        run_id: values["run-id"],
      },
      null,
      2,
    ),
  );
  if (values.execute) {
    const host = await loadConfig(values.config);
    const config = host.evaluation;
    config.output = {
      kind: "directory",
      path: testEvaluationOutput(config.output.path, values.output),
    };
    if (await exists(path.join(config.output.path, values["run-id"])))
      throw new Error("Benchmark requires a new run ID");
    const modelForStage = createModelResolver(host.models);
    for (const stage of Object.keys(host.models.bindings)) modelForStage(stage);
    for (const profile of boundProfiles(host.models))
      if (!process.env[profile.apiKeyEnv]) throw new Error("Model credential missing");
    const plan = {
      tasks,
      inputs: Object.assign({}, ...selected.map((f) => f.inputs)),
      catalog: [
        ...new Map(
          tasks
            .flatMap((t) => Object.values(t.data.candidates))
            .map((c) => [canonical([c.batch_id, c.case_id, c.version]), c]),
        ).values(),
      ],
      summary: {
        issues: [],
        skipped: [],
        cases: selected.length,
        comparison_tasks: selected.length,
        by_batch: {},
      },
    };
    config.inputs.batches = [...new Set(plan.catalog.map((c) => c.batch_id))];
    console.log(
      JSON.stringify(
        await runEvaluation({
          runId: values["run-id"],
          output: config.output,
          engine: values.engine,
          evaluatorVersion: host.evaluatorVersion,
          config,
          ...services,
          plan,
          policy: config.execution,
          concurrency: config.execution.concurrency,
          retries: config.execution.retries,
          retryDelaySeconds: config.execution.retryDelaySeconds,
          modelForStage,
          onProgress: console.log,
        }),
        null,
        2,
      ),
    );
  }
} else if (command === "compare") {
  if (values.run?.length !== 2)
    throw new Error("compare --run ORIGINAL --run SWAPPED [--output REPORT.json]");
  const [left, right] = await Promise.all(values.run.map(loadComparisonSamples));
  const report = compareSamples(left.samples, right.samples);
  if (values.output) await writeJson(values.output, report);
  console.log(JSON.stringify(report, null, 2));
} else if (["summarize", "calibrate", "gold-template"].includes(command)) {
  if (!values.run?.length || command !== "summarize" && values.run.length !== 1)
    throw new Error(command + " --run PATH " + (command === "summarize" ? "[--run PATH] " : "") + "[--output REPORT.json]");
  const loaded = await Promise.all(values.run.map(loadComparisonSamples)), samples = new Map();
  for (const run of loaded) for (const [id, sample] of run.samples) {
    if (samples.has(id)) throw new Error("Ambiguous duplicate case/model pair across runs: " + id);
    samples.set(id, sample);
  }
  let report;
  if (command === "summarize") report = summarizeSamples(samples, { rounds: Number(values["bootstrap-rounds"]),
    planned: loaded.every((run) => run.planned !== null) ? {
      pair_cases: loaded.reduce((sum, run) => sum + run.planned.pair_cases, 0),
      needs_review: loaded.reduce((sum, run) => sum + run.planned.needs_review, 0),
    } : null });
  if (command === "calibrate") {
    if (!values.gold) throw new Error("calibrate --run PATH --gold EXPERT.json [--output REPORT.json]");
    report = calibrateSamples(samples, await readJson(values.gold));
  }
  if (command === "gold-template") {
    if (!values.output) throw new Error("gold-template --run PATH --output EXPERT.json");
    if (await exists(values.output)) throw new Error("Expert annotation file already exists; choose a new path");
    report = goldTemplate(samples);
  }
  if (values.output) await writeJson(values.output, report);
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("benchmark collect|replay|run|compare|summarize|gold-template|calibrate; real models are called only by run --execute");
  if (command) process.exitCode = 2;
}
