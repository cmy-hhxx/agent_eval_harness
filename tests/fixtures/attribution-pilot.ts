import path from "node:path";
import { randomUUID } from "node:crypto";
import { emptyUsage, type PlannedTask, type RunState } from "@eval/contracts";
import { writeJsonl } from "@eval/data";
import { adapt, type Candidate } from "@eval/workflows/inputs";
import { attributionRewritePlaceholder, createResultWriter, writeRunState, type AttributionJobConfig, type TaskData } from "@eval/workflows/comparison";
import { planAttributionUnit } from "@eval/workflows/attribution";
import { attributionResult, criteriaResultForTask, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig, raw } from "./comparison.js";

export async function attributionPilotFixture() {
  const fixture = await fixtureConfig(undefined, true);
  fixture.config.output = { kind: "directory", path: path.join(fixture.directory, "source/eval_output/test_eval/attribution") };
  const run = path.join(fixture.config.output.path, "pilot");
  const records = Array.from({ length: 6 }, (_, index) => ({ ...raw(`case-${index}`, index % 2 ? null : "4"),
    batch_id: `2026-10-${String(1 + Math.floor(index / 2)).padStart(2, "0")}` }));
  const catalog: Candidate[] = [], inputs: Record<string, unknown> = {};
  for (const version of fixture.config.inputs.versions) {
    const file = version.sources[0].path; await writeJsonl(file, records);
    records.forEach((record, index) => { const candidate = adapt(record, version, file, index + 1); catalog.push(candidate); inputs[candidate.input_id] = record; });
  }
  const tasks: PlannedTask[] = [];
  for (const record of records) {
    const same = catalog.filter(candidate => candidate.case_id === record.case_id), criteriaScope = randomUUID();
    const candidates = Object.fromEntries(same.map((candidate, index) => [String.fromCharCode(65 + index), candidate]));
    const criteria: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
      inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
      data: { stage: "criteria", candidates, reference: same[0].reference, criteriaScope } satisfies TaskData };
    tasks.push(criteria);
    for (const candidate of same) {
      const unit = planAttributionUnit(candidate, { data: { stage: "attribution-component", candidates: { A: candidate },
        reference: candidate.reference, criteriaScope }, dependencies: { criteria: criteria.id }, identity: criteria.id });
      tasks.push(...unit.tasks, attributionRewritePlaceholder(unit.session.id, { rewriteNames: { A: candidate.name },
        case: { batch_id: candidate.batch_id, case_id: candidate.case_id, question: candidate.question } }));
    }
  }
  const chosen = tasks.filter(task => task.stage === "attribution-session").slice(0, 2), scope = new Set(chosen.map(task => task.id));
  chosen.forEach(task => scope.add(task.dependencies.criteria));
  tasks.filter(task => task.stage === "rewrite" && scope.has(task.dependencies.source)).forEach(task => scope.add(task.id));
  const config: AttributionJobConfig = { ...fixture.config, comparisons: [], clustering: { ...fixture.config.clustering, enabled: false },
    attributionJob: { runs: [path.join(fixture.directory, "formal-source")], fromBatch: "2026-10-01" } };
  const state: RunState = { receipts: {}, usage: emptyUsage(), recordedAttempts: 7, manifest: {
    format: "evaluation-run", runId: "pilot", status: "interrupted", debug: false, engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    config, tasks, inputCatalog: catalog, inputs: {}, startedAt: 1, executionScope: [...scope],
    states: Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: { attribution_answers: catalog.length, selected_answers: chosen.map(task => { const candidate = (task.data as TaskData).candidate!;
      return { task_id: task.id, input_id: candidate.input_id, version: candidate.version, batch_id: candidate.batch_id, case_id: candidate.case_id }; }), pilot_answers: chosen.length } } };
  const paid = [...new Set(chosen.map(task => task.dependencies.criteria)), ...chosen.map(task => task.id)];
  for (const id of paid) {
    const task = tasks.find(task => task.id === id)!;
    state.receipts[id] = { taskId: id, attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1, status: "succeeded", evaluatorVersion: fakeEvaluatorVersion,
      judge: fakeJudge, usage: emptyUsage(), audit: emptyAudit(), evaluation: task.stage === "criteria" ? criteriaResultForTask(task, inputs) : attributionResult(true, "2+2=4", true, (task.data as TaskData).candidate!.input_id) };
    state.manifest.states[id] = { status: "succeeded", attempts: 3 };
  }
  await createResultWriter(run, inputs)(state); await writeRunState(run, state);
  return { ...fixture, baseConfig: fixture.config, run, state, config, chosen, inputs };
}
