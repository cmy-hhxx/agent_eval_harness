import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, type Engine, type ModelConfig, type PlannedTask, type RunState, type SubmissionReceipt, type TaskPlan, type WorkflowDefinition } from "@eval/contracts";
import { fileSourceReader } from "@eval/data";
import { criteriaProfile } from "@eval/agents/criteria";
import { attributionProfile } from "@eval/agents/attribution";
import { comparisonProfile } from "@eval/agents/comparison";
import { adapt, candidateKey } from "../inputs/records.js";
import { assertComparableGroups } from "./input.js";
import { bindTask } from "./binding.js";
import { comparisonRepository } from "./run-data.js";
import { loadRunInputs } from "../inputs/load.js";
import { comparisonWorkflow } from "./workflow.js";
import { seededRandom } from "./stability-statistics.js";
import type { Candidate, VersionConfig } from "../inputs/types.js";
import type { EvalConfig, TaskData } from "./types.js";
export { stabilityRepository } from "./stability-storage.js";

export interface StabilityAnswer {
  version: string; name: string; adapter: string; source: string; line: number; comparison_tier?: string; timing_unit?: "ms" | "s";
}
export interface StabilityCase {
  batch_id: string; case_id: string; answers: [StabilityAnswer, StabilityAnswer];
  risks: string[]; rewrite: boolean; end_to_end: boolean;
  source_task_id?: string;
}
export type StabilityPurpose = "baseline" | "comparison" | "rewrite" | "end_to_end";
export interface StabilityTrial {
  case_key: string; purpose: StabilityPurpose; repeat: number; orientation: "AB" | "BA";
  order?: number;
  externalDependencies?: Record<string, string>;
  condition?: { engine: Engine; model: Omit<ModelConfig, "apiKeyEnv">; execution: EvalConfig["execution"] };
  materials?: Record<string, string>;
}
export type StabilityTaskData = TaskData & { stability: StabilityTrial };
export interface StabilityConfig extends EvalConfig {
  stability: {
    cases: StabilityCase[]; seed: number; maxAttempts: number; stopStartingAt?: number;
    sourceRun?: string; sourceReceipts: { task_id: string; submission_id: string }[];
    selection: "purposeful_risk_sample" | "source_run_order";
  };
}
export const stabilityCaseKey = (item: Pick<StabilityCase, "batch_id" | "case_id">) => canonical([item.batch_id, item.case_id]);

async function recordMaterialConditions(tasks: PlannedTask[], catalog: Candidate[], pending?: ReadonlySet<string>) {
  const revisions = new Map<string, string>();
  for (const source of new Set(catalog.map(candidate => candidate.source))) revisions.set(source, await fileSourceReader.revision(source));
  for (const task of tasks) {
    if (pending && !pending.has(task.id)) continue;
    const trial = (task.data as StabilityTaskData).stability;
    trial.materials = Object.fromEntries(catalog.filter(candidate => stabilityCaseKey(candidate) === trial.case_key)
      .map(candidate => [candidate.source, revisions.get(candidate.source)!]));
  }
}

/** Raw records may move, but saved evaluation metadata must still describe the material being read. */
async function loadExperimentInputs(manifest: RunState["manifest"], taskIds?: ReadonlySet<string>) {
  const records = new Map<string, Candidate>(), inputs = await loadRunInputs(manifest, undefined, taskIds, records);
  const metadata = ({ input_id: _id, line: _line, ...value }: Candidate) => value;
  for (const candidate of manifest.inputCatalog as Candidate[]) {
    const current = records.get(candidate.input_id);
    if (current && !isDeepStrictEqual(metadata(candidate), metadata(current)))
      throw new Error("Experiment input metadata changed; use current source results or start a new experiment from --cases: " +
        candidate.source + ":" + current.line);
  }
  return inputs;
}

function task(stage: TaskData["stage"], candidates: Record<string, Candidate>, reference: unknown,
  dependencies: Record<string, string>, trial: StabilityTrial, extra: Partial<TaskData> = {}): PlannedTask {
  return { id: randomUUID(), stage, dependencies,
    inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [stage === "attribution" ? "answer" : label, candidate.input_id])),
    data: { stage, candidates, reference, ...extra, stability: structuredClone(trial) } satisfies StabilityTaskData };
}

function chain(candidates: Record<string, Candidate>, reference: unknown, trial: StabilityTrial, config: EvalConfig) {
  const criteriaScope = canonical([trial.case_key, trial.purpose, trial.repeat]);
  const criteria = task("criteria", candidates, reference, {}, trial, { criteriaScope });
  const attributes = Object.entries(candidates).map(([label, candidate]) => ({ label,
    task: task("attribution", { A: candidate }, reference, { criteria: criteria.id }, trial,
      { criteriaScope, initialContextChars: config.execution.initialContextChars, standardAnswerReview: false }) }));
  const comparison = task("comparison", candidates, reference,
    { criteria: criteria.id, ...Object.fromEntries(attributes.map(item => [item.label, item.task.id])) }, trial,
    { criteriaScope, group: Object.values(candidates).map(candidate => candidate.version), comparisonId: "cmp_" + randomUUID(),
      initialContextChars: config.execution.initialContextChars });
  return { tasks: [criteria, ...attributes.map(item => item.task), comparison], comparison };
}

function comparisonTrial(source: PlannedTask, trial: StabilityTrial, external: boolean) {
  const data = source.data as TaskData, swap = trial.orientation === "BA";
  const candidates = swap ? { A: data.candidates.B!, B: data.candidates.A! } : data.candidates;
  const dependencies = { criteria: source.dependencies.criteria!, A: source.dependencies[swap ? "B" : "A"]!,
    B: source.dependencies[swap ? "A" : "B"]! };
  return task("comparison", candidates, data.reference, external ? {} : dependencies,
    { ...trial, ...(external ? { externalDependencies: dependencies } : {}) },
    { criteriaScope: data.criteriaScope, group: data.group, comparisonId: "cmp_" + randomUUID(), initialContextChars: data.initialContextChars });
}

function rewriteTrial(source: PlannedTask, trial: StabilityTrial, external: boolean) {
  const data = source.data as TaskData, first = data.candidates.A!;
  return task("rewrite", {}, null, external ? {} : { source: source.id },
    { ...trial, ...(external ? { externalDependencies: { source: source.id } } : {}) },
    { rewriteOf: { stage: "comparison", taskId: source.id, resultId: data.comparisonId! }, comparisonRewriteScope: "verdicts",
      rewriteNames: Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => [label, candidate.name])),
      case: { batch_id: first.batch_id, case_id: first.case_id, question: first.question } });
}

function validateCases(cases: StabilityCase[]) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 12) throw new Error("Stability pilot requires 1–12 explicit cases");
  const identities = new Set<string>();
  for (const item of cases) {
    if (!item.batch_id?.trim() || !item.case_id?.trim() || !Array.isArray(item.answers) || item.answers.length !== 2 ||
      item.answers.some(answer => !answer.source || !Number.isInteger(answer.line) || answer.line < 1 || !answer.version || !answer.adapter || !answer.name) ||
      item.answers[0].version === item.answers[1].version || typeof item.rewrite !== "boolean" || typeof item.end_to_end !== "boolean" ||
      !Array.isArray(item.risks) || item.risks.some(risk => typeof risk !== "string")) throw new Error("Invalid stability case reference");
    const key = stabilityCaseKey(item);
    if (identities.has(key)) throw new Error("Duplicate stability case: " + key);
    identities.add(key);
  }
}

async function sourceState(run: string) {
  // The normal repository must decode the current source contract; no legacy conversion is allowed.
  const state = await comparisonRepository.readRun(run);
  return state;
}

function sourceComparison(state: RunState, item: StabilityCase): PlannedTask {
  const expected = item.answers.map(answer => answer.version).sort();
  const matches = state.manifest.tasks.filter(candidate => {
    const data = candidate.data as TaskData;
    return candidate.stage === "comparison" && !data.verificationAudit && state.receipts[candidate.id] &&
      (!item.source_task_id || candidate.id === item.source_task_id) &&
      data.candidates.A.batch_id === item.batch_id && data.candidates.A.case_id === item.case_id &&
      isDeepStrictEqual(Object.values(data.candidates).map(answer => answer.version).sort(), expected);
  });
  if (matches.length !== 1) throw new Error("Source case needs one unambiguous accepted comparison: " + stabilityCaseKey(item));
  const selected = matches[0]!;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const profiles = { criteria: criteriaProfile, attribution: attributionProfile, comparison: comparisonProfile };
  for (const id of [selected.id, ...Object.values(selected.dependencies)]) {
    const source = state.manifest.tasks.find(candidate => candidate.id === id), receipt = state.receipts[id];
    if (!source || !receipt || !(source.stage in profiles)) throw new Error("Source experiment dependency is unavailable: " + id);
    const profile = profiles[source.stage as keyof typeof profiles];
    if (!ajv.validate(profile.resultSchema ?? profile.submissionSchema, receipt.evaluation))
      throw new Error("Source result does not satisfy the current contract; rerun it explicitly: " + id + "; " + ajv.errorsText());
  }
  return selected;
}

/** Build a bounded experiment from source coordinates, or reference accepted current-contract results. */
export async function prepareStability(base: EvalConfig, supplied: StabilityCase[] | undefined, options: {
  sourceRun?: string; seed?: number; maxAttempts?: number; stopStartingAt?: number;
} = {}): Promise<{ config: StabilityConfig; plan: TaskPlan }> {
  const source = options.sourceRun ? await sourceState(options.sourceRun) : undefined;
  const sourceCases = new Map<string, PlannedTask>();
  for (const candidate of source?.manifest.tasks ?? []) {
    const data = candidate.data as TaskData;
    if (candidate.stage !== "comparison" || data.verificationAudit || !source?.receipts[candidate.id]) continue;
    const key = stabilityCaseKey(data.candidates.A);
    if (!sourceCases.has(key)) sourceCases.set(key, candidate);
  }
  const cases = supplied ?? (source ? [...sourceCases.values()].slice(0, 12).map(candidate => {
      const data = candidate.data as TaskData;
      return { batch_id: data.candidates.A.batch_id, case_id: data.candidates.A.case_id,
        answers: Object.values(data.candidates).map(answer => {
          const version = (source.manifest.config as EvalConfig).inputs.versions.find(version => version.id === answer.version)!;
          return { version: version.id, name: version.name, adapter: version.adapter, comparison_tier: version.comparison_tier,
            source: answer.source, line: answer.line, timing_unit: version.timing_unit };
        }) as [StabilityAnswer, StabilityAnswer], risks: ["source_run_sample"], rewrite: false, end_to_end: false, source_task_id: candidate.id };
    }) : undefined);
  if (!cases) throw new Error("Provide --cases or --source-run");
  validateCases(cases);
  const maxAttempts = options.maxAttempts ?? 240, seed = options.seed ?? 20261019;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 240 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff ||
    options.stopStartingAt !== undefined && !Number.isFinite(options.stopStartingAt)) throw new Error("Invalid experiment limits or seed");
  const versions = new Map<string, VersionConfig>();
  for (const item of cases) for (const answer of item.answers) {
    const version = versions.get(answer.version);
    if (version && (version.name !== answer.name || version.adapter !== answer.adapter || version.comparison_tier !== answer.comparison_tier))
      throw new Error("Conflicting experiment version metadata: " + answer.version);
    if (version) { if (!version.sources.some(source => source.path === answer.source)) version.sources.push({ kind: "file", path: answer.source }); }
    else versions.set(answer.version, { id: answer.version, name: answer.name, adapter: answer.adapter,
      comparison_tier: answer.comparison_tier, sources: [{ kind: "file", path: answer.source }], timing_unit: answer.timing_unit ?? "ms" });
  }
  const config: StabilityConfig = { ...base, inputs: { versions: [...versions.values()], batches: [...new Set(cases.map(item => item.batch_id))] },
    comparisons: [...new Map(cases.map(item => [canonical(item.answers.map(answer => answer.version)), item.answers.map(answer => answer.version)])).values()],
    standardAnswerReview: false, reviewQuestions: undefined,
    rewrite: { comparison: false, attribution: false, clustering: false }, clustering: { ...base.clustering, enabled: false },
    stability: { cases: structuredClone(cases), seed, maxAttempts, sourceReceipts: [], selection: supplied ? "purposeful_risk_sample" : "source_run_order",
      ...(options.sourceRun ? { sourceRun: options.sourceRun } : {}),
      ...(options.stopStartingAt === undefined ? {} : { stopStartingAt: options.stopStartingAt }) } };
  assertComparableGroups(config);
  const catalog: Candidate[] = [], byCase = new Map<string, Candidate[]>();
  if (source) {
    for (const item of cases) {
      const selected = sourceComparison(source, item), data = selected.data as TaskData;
      item.source_task_id = selected.id;
      const candidates = Object.values(data.candidates);
      item.answers = item.answers.map(answer => {
        const actual = candidates.find(candidate => candidate.version === answer.version)!;
        const version = (source.manifest.config as EvalConfig).inputs.versions.find(version => version.id === answer.version)!;
        return { ...answer, source: actual.source, line: actual.line, name: version.name, adapter: version.adapter,
          comparison_tier: version.comparison_tier, timing_unit: version.timing_unit };
      }) as StabilityCase["answers"];
      byCase.set(stabilityCaseKey(item), candidates);
      // A shared rubric or an accepted attribution may refer to a third same-case answer.
      for (const dependency of source.manifest.tasks.filter(task => [selected.id, ...Object.values(selected.dependencies)].includes(task.id))) {
        const context = dependency.data as TaskData;
        for (const candidate of [...Object.values(context.candidates), ...Object.values(context.referenceCandidates ?? {})]) {
          if (!catalog.some(entry => entry.input_id === candidate.input_id)) catalog.push(candidate);
          const version = (source.manifest.config as EvalConfig).inputs.versions.find(version => version.id === candidate.version)!;
          if (!version) throw new Error("Source input version is unavailable: " + candidate.version);
          const registered = versions.get(version.id);
          if (registered) Object.assign(registered, { ...version, sources: [...registered.sources, { kind: "file", path: candidate.source }] });
          else versions.set(version.id, { ...version, sources: [{ kind: "file", path: candidate.source }] });
        }
      }
    }
    config.inputs.versions = [...versions.values()];
  } else {
    const requested = new Map<string, { item: StabilityCase; answer: StabilityAnswer }[]>();
    for (const item of cases) for (const answer of item.answers)
      requested.set(answer.source, [...(requested.get(answer.source) ?? []), { item, answer }]);
    for (const [file, entries] of requested) {
      const revision = await fileSourceReader.revision(file), pending = new Set(entries);
      for await (const { index, line } of fileSourceReader.lines(file, revision)) {
        for (const entry of [...pending]) if (entry.answer.line === index) {
          const candidate = adapt(JSON.parse(line), versions.get(entry.answer.version)!, file, index);
          if (candidate.batch_id !== entry.item.batch_id || candidate.case_id !== entry.item.case_id)
            throw new Error("Source coordinate disagrees with case identity: " + file + ":" + index);
          const key = stabilityCaseKey(entry.item);
          byCase.set(key, [...(byCase.get(key) ?? []), candidate]); catalog.push(candidate); pending.delete(entry);
        }
        if (!pending.size) break;
      }
      if (pending.size || await fileSourceReader.revision(file) !== revision) throw new Error("Experiment source missing or changed: " + file);
    }
  }
  const tasks: PlannedTask[] = [], random = seededRandom(seed);
  for (const item of cases) {
    const case_key = stabilityCaseKey(item), available = byCase.get(case_key)!;
    if (available.length !== 2 || new Set(available.map(candidateKey)).size !== 2 ||
      new Set(available.map(answer => answer.question.replace(/\s+/gu, ""))).size !== 1)
      throw new Error("Experiment requires two answers to the identical question: " + case_key);
    const refs = available.map(answer => answer.reference).filter(reference => reference !== null);
    if (refs.some(reference => !isDeepStrictEqual(reference, refs[0]))) throw new Error("Conflicting experiment references: " + case_key);
    const ordered = item.answers.map(answer => available.find(candidate => candidate.version === answer.version)!);
    if (random() < .5) ordered.reverse();
    const candidates = { A: ordered[0]!, B: ordered[1]! }, reference = refs[0] ?? null;
    const baseline = source ? { tasks: [], comparison: sourceComparison(source, item) } :
      chain(candidates, reference, { case_key, purpose: "baseline", repeat: 0, orientation: "AB" }, config);
    tasks.push(...baseline.tasks);
    if (source) for (const id of [baseline.comparison.id, ...Object.values(baseline.comparison.dependencies)])
      if (!config.stability.sourceReceipts.some(reference => reference.task_id === id))
        config.stability.sourceReceipts.push({ task_id: id, submission_id: source.receipts[id]!.submissionId });
    for (let repeat = 1; repeat <= 5; repeat++) for (const [index, orientation] of (["AB", "BA"] as const).entries())
      tasks.push(comparisonTrial(baseline.comparison, { case_key, purpose: "comparison", repeat, orientation,
        order: (repeat - 1) * 2 + index }, !!source));
    if (item.rewrite) for (let repeat = 1; repeat <= 5; repeat++)
      tasks.push(rewriteTrial(baseline.comparison, { case_key, purpose: "rewrite", repeat, orientation: "AB" }, !!source));
    if (item.end_to_end) for (let repeat = 1; repeat <= 3; repeat++) {
      const trial: StabilityTrial = { case_key, purpose: "end_to_end", repeat, orientation: "AB" };
      const full = chain((baseline.comparison.data as TaskData).candidates, reference, trial, config);
      tasks.push(...full.tasks, rewriteTrial(full.comparison, trial, false));
    }
  }
  config.stability.cases = structuredClone(cases);
  if (tasks.length > maxAttempts) throw new Error(`Planned ${tasks.length} stage attempts exceed budget ${maxAttempts}`);
  const manifest = { tasks, config, inputCatalog: catalog } as RunState["manifest"];
  const inputs = await loadExperimentInputs(manifest);
  await recordMaterialConditions(tasks, catalog);
  const plan: TaskPlan = { tasks, inputs, catalog, summary: { experiment: "validate-stability", cases: cases.length,
    planned_stage_attempts: tasks.length, max_stage_attempts: maxAttempts, reserved_attempts: maxAttempts - tasks.length,
    by_phase: Object.fromEntries((["baseline", "comparison", "rewrite", "end_to_end"] as const)
      .map(purpose => [purpose, tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === purpose).length])),
    source_run: options.sourceRun ?? null, seed, issues: [], skipped: [], by_batch: {} } };
  return { config, plan };
}

/** One instance per Host run; source receipts stay in memory and are persisted only as immutable references. */
export async function createStabilityWorkflow(initial: StabilityConfig): Promise<WorkflowDefinition> {
  let source: RunState | undefined;
  async function loadSource(config: StabilityConfig) {
    source = config.stability.sourceRun ? await sourceState(config.stability.sourceRun) : undefined;
    for (const reference of config.stability.sourceReceipts)
      if (source?.receipts[reference.task_id]?.submissionId !== reference.submission_id)
        throw new Error("Accepted source receipt changed or disappeared: " + reference.task_id);
    if (source) for (const item of config.stability.cases) sourceComparison(source, item);
  }
  await loadSource(initial);
  return {
    id: "validate-stability",
    async plan(value) {
      const config = value as StabilityConfig;
      const prepared = await prepareStability(config, config.stability.cases, config.stability);
      await loadSource(prepared.config);
      return prepared.plan;
    },
    async reconcile(_run, state, current) {
      const saved = state.manifest.config as StabilityConfig;
      await loadSource(saved);
      const pending = new Set(state.manifest.tasks.filter(task => !state.receipts[task.id]).map(task => task.id));
      const inputs = await loadExperimentInputs(state.manifest, saved.stability.sourceRun ? undefined : pending);
      state.manifest.config = { ...saved, execution: (current as StabilityConfig).execution };
      await recordMaterialConditions(state.manifest.tasks, state.manifest.inputCatalog as Candidate[], pending);
      return { tasks: state.manifest.tasks, catalog: state.manifest.inputCatalog,
        inputs, summary: state.manifest.preflight };
    },
    bind(task, inputs, dependencies, context) {
      const external = (task.data as StabilityTaskData).stability.externalDependencies ?? {};
      const resolved: Record<string, SubmissionReceipt | undefined> = { ...dependencies };
      for (const [label, id] of Object.entries(external)) {
        if (!source?.receipts[id]) throw new Error("Source receipts must be loaded before binding: " + id);
        resolved[label] = source.receipts[id];
      }
      return bindTask({ ...task, dependencies: { ...task.dependencies, ...external } }, inputs, resolved,
        { tasks: [...context.tasks, ...(source?.manifest.tasks ?? [])] });
    },
    blockedReason(task, dependencies) {
      const external = (task.data as StabilityTaskData).stability.externalDependencies ?? {};
      return comparisonWorkflow.blockedReason?.(task, { ...dependencies, ...Object.fromEntries(Object.entries(external)
        .flatMap(([label, id]) => source?.receipts[id] ? [[label, source.receipts[id]]] : [])) });
    },
    canStart(task, manifest) {
      const trial = (task.data as StabilityTaskData).stability;
      const unfinished = (candidate: PlannedTask) => ["pending", "running"].includes(manifest.states[candidate.id]!.status);
      if (trial.purpose === "baseline") return true;
      if (manifest.tasks.some(candidate => (candidate.data as StabilityTaskData).stability.purpose === "baseline" && unfinished(candidate))) return false;
      if (trial.purpose !== "comparison")
        return !manifest.tasks.some(candidate => (candidate.data as StabilityTaskData).stability.purpose === "comparison" && unfinished(candidate));
      return !manifest.tasks.some(candidate => {
        const prior = (candidate.data as StabilityTaskData).stability;
        return prior.case_key === trial.case_key && prior.purpose === "comparison" && prior.order! < trial.order! && unfinished(candidate);
      });
    },
  };
}
