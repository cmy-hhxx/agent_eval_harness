import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { exists, readJson, readJsonl, writeJson, readInputSource } from "@eval/data";
import { canonical } from "@eval/contracts";
import { readRunState, loadRunInputs } from "@eval/workflows/comparison";
import { services, agents } from "@eval/host-app/composition";
import { boundProfiles, createModelResolver, loadConfig } from "@eval/host-app/config";
import { cite, evidenceSources } from "@eval/tools";
import { runEvaluation } from "@eval/host";

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
  },
});
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be positive");

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
  if (saved.format !== "eval-offline-fixtures/2")
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

// Convert only exact matches. Unresolvable evidence remains invalid; never repair judgments.
// Comparison drafts carry no evidence (they reference findings by index); only attribution drafts are wired.
function wireDraft(fixture) {
  const draft = structuredClone(fixture.draft);
  if (!draft || typeof draft !== "object" || fixture.task.stage !== "attribution") return draft;
  const evidence = (refs) =>
    Array.isArray(refs)
      ? refs.map((ref) => {
          if (ref.evidence_id) return ref;
          const id = fixture.task.inputIds.A,
            message = fixture.inputs[id]?.messages[ref.message_index];
          if (typeof ref.quote !== "string" || !message) return { evidence_id: "unresolved" };
          if (ref.quote.startsWith("[图像观察]")) return ref; // requires explicit viewing, never infer it
          for (const source of evidenceSources(message)) {
            const start = source.text.indexOf(ref.quote);
            if (start >= 0 && ref.quote)
              return {
                evidence_id: cite(ref.message_index, source, start, start + ref.quote.length).evidence_id,
              };
          }
          return {
            evidence_id: "unresolved:" + ref.message_index + ":" + ref.quote,
          };
        })
      : refs;
  draft.correctness_evidence = evidence(draft.correctness_evidence);
  for (const [index, finding] of (draft.findings || []).entries()) {
    finding.finding_id ??= "finding-" + index;
    finding.evidence = evidence(finding.evidence);
  }
  return draft;
}
function evaluate(fixture) {
  try {
    const binding = services.workflow.bind(fixture.task, fixture.inputs, fixture.dependencies);
    const result = agents.resolve(binding, wireDraft(fixture), fixture.audit);
    agents.validate(binding, result, fixture.audit);
    return { accepted: true, codes: [] };
  } catch (error) {
    return {
      accepted: false,
      codes: [...new Set((error.issues || [{ code: "invalid_draft" }]).map((e) => e.code))].sort(),
    };
  }
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
        let draft;
        for await (const event of readJsonl(file)) {
          if (event.type === "tool_start" && event.data.name === "submit_evaluation") draft = event.data.args;
          if (
            event.type !== "tool_end" ||
            event.data.name !== "submit_evaluation" ||
            !event.data.result?.isError ||
            !draft
          )
            continue;
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
              },
            dependencies: Object.fromEntries(
              Object.entries(task.dependencies).map(([label, id]) => [label, state.receipts[id]]),
            ),
          };
          fixture.expected = evaluate(fixture);
          candidates.push(fixture);
          draft = undefined;
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
    format: "eval-offline-fixtures/2",
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
      path: path.resolve(values.output || ".artifacts/model-benchmarks"),
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
  async function rows(run) {
    const output = new Map();
    for (const file of await readdir(path.join(run, "results")))
      if (file.endsWith(".jsonl"))
        for await (const row of readJsonl(path.join(run, "results", file)))
          output.set(canonical([row.case, Object.keys(row.evaluations).sort()]), row);
    return output;
  }
  const [left, right] = await Promise.all(values.run.map(rows));
  const comparisons = [...new Set([...left.keys(), ...right.keys()])].map((key) => {
    const a = left.get(key),
      b = right.get(key);
    return {
      case: a?.case || b.case,
      complete: !!a && !!b,
      stable:
        !!a &&
        !!b &&
        a.verdict.result === b.verdict.result &&
        a.verdict.winner_version === b.verdict.winner_version,
      verdicts: [a?.verdict, b?.verdict],
      decision_basis: [a?.decision_basis, b?.decision_basis],
    };
  });
  const report = {
    comparisons: comparisons.length,
    stable: comparisons.filter((c) => c.stable).length,
    manual_review: "逐项抽查决定性发现、反向证据及判决；一致性不等于事实正确性",
    samples: comparisons,
  };
  if (values.output) await writeJson(values.output, report);
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("benchmark collect|replay|run|compare; real models are called only by run --execute");
  if (command) process.exitCode = 2;
}
