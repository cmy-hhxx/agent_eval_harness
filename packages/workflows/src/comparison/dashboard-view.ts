import path from "node:path";
import { fileSourceReader, readJson, locateRun, problemLibraryFile, readProblemLibrary } from "@eval/data";
import { safeId, type JsonObject, type ProblemLibrary, type ProblemOccurrence, type ProblemOrigin, type SubmissionReceipt, type TaskState } from "@eval/contracts";
import { readRunTasks } from "./run-data.js";
import { buildPlan, contentText, locateRecordStream, type PlanOptions } from "./input.js";
import type { Candidate, ComparisonResult, EvalConfig, Stage, TaskData } from "./types.js";
import type { Checkpoint } from "./codec.js";
import { verdictSlotId } from "./commentary.js";
import { countProblemSamples, effectiveProblemOccurrences, problemSampleKey, projectLibrary } from "@eval/agents/clustering";

/** Read-only workflow projection: the dashboard never interprets blind labels or result files. */
async function checkpoint(run: string): Promise<Checkpoint> {
  const value = await readJson<Checkpoint>(locateRun(run).stateFile);
  if (value.format !== "evaluation-run") throw new Error("无效的运行状态");
  return value;
}

export interface InputDate {
  /** Run date: the source file name when it is a date, else the source folder. */
  date: string;
  /** Registered batch ids recorded on this date; identity stays `batch_id`. */
  batches: string[];
  versions: string[];
  cases: { id: string; versions: string[]; batches: string[] }[];
}
/** Model-first sources name each file by run date; single-file sources fall back to their folder. */
function sourceDate(source: string): string {
  const name = path.basename(source, path.extname(source));
  return /^\d{4}-\d{2}-\d{2}$/.test(name) ? name : path.basename(path.dirname(source));
}
/** File dates are available before answer validation; null counts cannot be used for sampling. */
export async function listInputDates(config: EvalConfig) {
  const dates = new Map<string, string[]>();
  for (const version of config.inputs.versions) {
    // Full inventory records unreadable/missing-source issues using the plan parser.
    const files = await fileSourceReader.files(version.sources).catch(() => []);
    for (const file of files) {
      const date = sourceDate(file), versions = dates.get(date) ?? [];
      if (!versions.includes(version.id)) versions.push(version.id);
      dates.set(date, versions);
    }
  }
  return [...dates].sort(([a], [b]) => a.localeCompare(b))
    .map(([date, versions]) => ({ date, versions, batches: [], cases: null }));
}
/** Scans configured sources with the plan parser, so offered dates match what a run accepts. */
export async function listInputInventory(config: EvalConfig, options: Pick<PlanOptions, "scanFile"> = {}): Promise<{ dates: InputDate[]; issues: number }> {
  const plan = await buildPlan({
    ...config,
    comparisons: [],
    clustering: { ...config.clustering, enabled: false },
    inputs: { ...config.inputs, batches: undefined, case_ids: undefined, limit: undefined },
  }, undefined, { ...options, materializeInputs: false });
  const dates = new Map<
    string,
    { batches: Set<string>; versions: Set<string>; cases: Map<string, { versions: Set<string>; batches: Set<string> }> }
  >();
  const versionOrder = config.inputs.versions.map((version) => version.id);
  for (const record of (plan.catalog as Candidate[]) || []) {
    const date = sourceDate(record.source);
    const item = dates.get(date) ?? { batches: new Set(), versions: new Set(), cases: new Map() };
    item.batches.add(record.batch_id);
    item.versions.add(record.version);
    let covered = item.cases.get(record.case_id);
    if (!covered) item.cases.set(record.case_id, (covered = { versions: new Set(), batches: new Set() }));
    covered.versions.add(record.version);
    covered.batches.add(record.batch_id);
    dates.set(date, item);
  }
  return {
    dates: [...dates]
      .map(([date, item]) => ({
        date,
        batches: [...item.batches].sort(),
        versions: versionOrder.filter((id) => item.versions.has(id)),
        cases: [...item.cases]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, covered]) => ({
            id,
            versions: versionOrder.filter((version) => covered.versions.has(version)),
            batches: [...covered.batches].sort(),
          })),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    issues: ((plan.summary.issues as unknown[]) || []).length,
  };
}

export interface CaseFilter {
  batch?: string;
  stage?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export async function listRunCases(run: string, filter: CaseFilter) {
  const saved = await checkpoint(run);
  const cases = new Map<string, {
    batch_id: string;
    case_id: string;
    question: string;
    stages: Record<string, Record<string, number>>;
    task_count: number;
    matches: boolean;
  }>();
  for (const task of Object.values(saved.tasks)) {
    const data = task.data as TaskData;
    // Clustering tasks cover a whole model × batch; they belong to the run overview, not a single case.
    if (task.stage === "clustering" || data.rewriteOf?.stage === "clustering") continue;
    // Checkpoints strip `candidates`; the registered input restores the sample identity.
    const candidate = Object.values(task.inputIds).map((inputId) => saved.inputs[inputId]).find(Boolean);
    const identity = data.case || candidate;
    if (!identity) throw new Error("任务缺少样本身份");
    const key = JSON.stringify([identity.batch_id, identity.case_id]);
    let item = cases.get(key);
    if (!item) {
      item = {
        batch_id: identity.batch_id,
        case_id: identity.case_id,
        question: candidate?.question || data.case?.question || "",
        stages: {},
        task_count: 0,
        matches: false,
      };
      cases.set(key, item);
    }
    if (!item.question && candidate?.question) item.question = candidate.question;
    const counts = (item.stages[task.stage] ??= {});
    counts[task.status] = (counts[task.status] || 0) + 1;
    item.task_count++;
    if ((!filter.stage || filter.stage === task.stage) && (!filter.status || filter.status === task.status))
      item.matches = true;
  }
  const rows = [...cases.values()]
    .filter((item) =>
      item.matches &&
      (!filter.batch || item.batch_id === filter.batch),
    )
    .sort((a, b) =>
      a.batch_id.localeCompare(b.batch_id) || a.case_id.localeCompare(b.case_id),
    )
    .map(({ matches: _matches, ...item }) => item);
  return {
    total: rows.length,
    page: filter.page,
    page_size: filter.pageSize,
    cases: rows.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize),
  };
}

const clip = (value: unknown, limit: number): unknown =>
  typeof value === "string" && value.length > limit ? `${value.slice(0, limit)}…` : value;
const clipEvidence = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((item) => {
        const entry = (item ?? {}) as JsonObject;
        return { ...(entry.source_input_id ? { source: entry.source, source_input_id: entry.source_input_id } : {}), message_index: entry.message_index, quote: clip(entry.quote, 4000) };
      })
    : value;
/** Sample-view projection of accepted rows, including each comparison model's attribution. */
export function caseResultView(stage: Stage, row: JsonObject | undefined, versions: Record<string, string> = {}): JsonObject | null {
  if (!row) return null;
  if (stage === "comparison" && row.evaluation_type === "comparison_review") {
    const result = row.result as ComparisonResult;
    const version = (label: string) => versions[label] ?? label;
    row = { ...row, ...result,
      ranking: result.ranking.map((tier) => tier.map(version)),
      assessments: Object.fromEntries(Object.entries(result.assessments).map(([label, assessment]) => [version(label), assessment])),
      review_requests: result.review_requests.map((request) => ({ ...request, candidate: version(request.candidate) })),
      decision_basis: { ...result.decision_basis,
        comparisons: result.decision_basis.comparisons.map((item) => ({ ...item,
          better_candidates: item.better_candidates.map(version),
          assessments: Object.fromEntries(Object.entries(item.assessments).map(([label, assessment]) => [version(label), assessment])),
        })),
        decisive_findings: result.decision_basis.decisive_findings.map((ref) => ({ ...ref, candidate: version(ref.candidate) })),
      },
      verdicts: {},
    };
  }
  const source = (stage === "attribution" ? row.evaluation : stage === "clustering" || stage === "criteria" ? row.result : row) as JsonObject;
  const rewritten = source.rewritten as { evaluator_version: string; rewrites: { id: string; text: string }[] } | undefined;
  const paths = new Map<string, string>();
  if (stage === "comparison" && rewritten) {
    paths.set("tradeoff", "decision_basis.tradeoff");
    for (const [label, version] of Object.entries(versions))
      paths.set(`assessment.${label}.summary`, `assessments.${version}.summary`);
    (row.decision_basis as { comparisons: unknown[] }).comparisons.forEach((_, index) => {
      for (const [label, version] of Object.entries(versions))
        paths.set(`comparison.${index}.${label}.summary`, `decision_basis.comparisons.${index}.assessments.${version}.summary`);
    });
    const labels = new Map(Object.entries(versions).map(([label, version]) => [version, label]));
    for (const pair of Object.keys(row.verdicts as JsonObject)) {
      const [first, second] = pair.split("__vs__").map((version) => labels.get(version));
      if (first && second) paths.set(verdictSlotId(first, second), `verdicts.${pair}.reason`);
    }
  }
  // Resolve blind slot IDs in the workflow, never by browser order or display names.
  const rewriteView = rewritten ? { rewritten: {
    evaluator_version: rewritten.evaluator_version,
    rewrites: rewritten.rewrites.map((item) => {
      const fieldPath = stage === "comparison" ? paths.get(item.id) : item.id;
      if (!fieldPath) throw new Error(`改写槽位缺少字段映射：${item.id}`);
      return { ...item, path: fieldPath, text: clip(item.text, 8000) };
    }),
  } } : {};
  if (stage === "attribution") {
    const value = (row.evaluation ?? {}) as JsonObject;
    return {
      evaluation: {
        has_standard_answer: value.has_standard_answer,
        is_correct: value.is_correct,
        task_analysis: value.task_analysis,
        correctness_reason: clip(value.correctness_reason, 8000),
        correctness_evidence: clipEvidence(value.correctness_evidence),
        numeric_checks: value.numeric_checks,
        criterion_assessments: value.criterion_assessments,
        core_assessment: value.core_assessment,
        summary: clip(value.summary, 8000),
        findings: Array.isArray(value.findings)
          ? value.findings.map((finding) => {
              const item = (finding ?? {}) as JsonObject;
              return {
                finding_id: item.finding_id,
                type: item.type,
                dimension: item.dimension,
                importance: item.importance,
                stage: item.stage,
                text: clip(item.text, 4000),
                reason: clip(item.reason, 4000),
                evidence: clipEvidence(item.evidence),
                assessment: item.assessment,
                problem: item.problem,
              };
            })
          : value.findings,
      },
      ...rewriteView,
    };
  }
  if (stage === "clustering" || stage === "criteria") {
    const { rewritten, ...result } = row.result as JsonObject;
    return { result, ...rewriteView };
  }
  if (stage === "comparison")
    return {
      models: row.models,
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.review_requests !== undefined ? { review_requests: row.review_requests } : {}),
      ground_truth: row.ground_truth,
      ranking: row.ranking,
      task_analysis: row.task_analysis,
      decision_basis: row.decision_basis,
      assessments: row.assessments,
      evaluations: Object.fromEntries(Object.entries((row.evaluations ?? {}) as Record<string, JsonObject>).map(([version, evaluation]) => {
        const view = caseResultView("attribution", { evaluation })!;
        return [version, { ...view.evaluation as JsonObject, ...(view.rewritten ? { rewritten: view.rewritten } : {}) }];
      })),
      verdicts: row.verdicts,
      ...rewriteView,
    };
  return null;
}

export async function readCaseDetail(run: string, batch: string, caseId: string) {
  const saved = await checkpoint(run);
  const taskIds = Object.entries(saved.tasks).flatMap(([id, task]) => {
    // Clustering tasks cover a whole model × batch; they belong to the run overview, not a single case.
    if (task.stage === "clustering" || task.data.verificationPending || task.data.rewriteOf?.stage === "clustering") return [];
    const candidate = Object.values(task.inputIds)
      .map((inputId) => saved.inputs[inputId])
      .find(Boolean);
    const identity = (task.data as TaskData).case || candidate;
    return identity?.batch_id === batch && identity?.case_id === caseId ? [id] : [];
  });
  if (!taskIds.length) return undefined;
  const candidates = new Map<string, Candidate>();
  for (const id of taskIds)
    for (const inputId of Object.values(saved.tasks[id]!.inputIds)) {
      const candidate = saved.inputs[inputId];
      if (candidate) candidates.set(inputId, { ...candidate, input_id: inputId });
    }
  const first = saved.tasks[taskIds[0]!]!;
  const rewriteIds = rewriteSubmissionIds(saved);
  return {
    batch_id: batch,
    case_id: caseId,
    question: [...candidates.values()][0]?.question || (first.data as TaskData).case?.question || "",
    ground_truth: { available: first.data.reference !== null, value: first.data.reference },
    candidates: [...candidates.values()].map(({ input_id, version, name }) => ({
      input_id, version, name,
    })),
    tasks: taskIds.filter((id) => saved.tasks[id]!.stage !== "rewrite")
      .map((id) => taskDetails(saved, id, rewriteIds)),
  };
}

function rewriteSubmissionIds(saved: Checkpoint): Map<string, string[]> {
  const ids = new Map<string, string[]>();
  for (const task of Object.values(saved.tasks)) {
    if (task.stage !== "rewrite" || !task.receipt) continue;
    const source = task.data.rewriteOf!.taskId;
    const submissions = ids.get(source) ?? [];
    submissions.push(task.receipt.submissionId);
    ids.set(source, submissions);
  }
  return ids;
}

function taskDetails(saved: Checkpoint, id: string, rewriteIds: Map<string, string[]>) {
  const task = saved.tasks[id]!;
  const status: TaskState = task;
  const scope = task.data.scope;
  return {
    id, stage: task.stage, status: status.status, attempts: status.attempts,
    reason: status.reason || status.failure?.errors[0]?.message || null,
    last_progress_at: status.lastProgressAt ?? null,
    duration_ms: status.durationMs ?? null,
    versions: scope ? [scope.version]
      : Object.entries(task.inputIds).filter(([label]) => task.stage !== "attribution" || label === "answer").flatMap(([, inputId]) => saved.inputs[inputId]?.version ?? []),
    ...(scope ? { batch_id: scope.batch_id, shard: scope.shard } : {}),
    rewrite_submission_ids: [id, ...(task.stage === "comparison" ? Object.values(task.dependencies) : [])]
      .flatMap((source) => rewriteIds.get(source) ?? []),
  };
}

/** Run-level clustering tasks; accepted result bodies are loaded on expansion. */
export async function listClusteringTasks(run: string) {
  const saved = await checkpoint(run);
  const rewriteIds = rewriteSubmissionIds(saved);
  return Object.entries(saved.tasks).flatMap(([id, task]) =>
    task.stage === "clustering" ? [taskDetails(saved, id, rewriteIds)] : [],
  );
}

/** One task's accepted row, loaded when the sample view expands it. */
export async function readTaskResult(run: string, taskId: string) {
  const saved = await checkpoint(run);
  const task = saved.tasks[taskId];
  if (!task || task.data.verificationPending) return undefined;
  // Repository decoding checks the accepted reference against its authoritative JSONL row.
  const dependencies = task.stage === "comparison" ? Object.values(task.dependencies) : [];
  const state = await readRunTasks(run, [taskId, ...dependencies]);
  let row = state.receipts[taskId]?.exported?.row;
  if (row && task.stage === "comparison") {
    const evaluations = Object.fromEntries(Object.entries(task.dependencies).filter(([label]) => Object.hasOwn(task.inputIds, label)).map(([label, id]) => {
      const attribution = state.receipts[id]?.exported?.row;
      if (!attribution) throw new Error(`缺少归因任务结果：${id}`);
      return [saved.inputs[task.inputIds[label]].version, attribution.evaluation];
    }));
    const models = Object.fromEntries(Object.entries(task.inputIds).map(([, id]) => {
      const candidate = saved.inputs[id]!;
      return [candidate.version, { version: candidate.name, llm: candidate.llm, trace_id: candidate.trace_id }];
    }));
    row = { ...row, evaluations, ...(row.evaluation_type === "comparison_review" ? {
      models, ground_truth: { available: task.data.reference !== null, value: task.data.reference },
    } : {}) };
  }
  return {
    task_id: taskId,
    stage: task.stage,
    result: caseResultView(task.stage as Stage, row,
      Object.fromEntries(Object.entries(task.inputIds).map(([label, id]) => [label, saved.inputs[id].version]))),
  };
}

export interface RegisteredInputView {
  input_id: string;
  batch_id: string;
  case_id: string;
  line: number;
  recorded_line: number;
  question: string;
  answer: string;
}
/** Question and final answer of one registered record; the message trace stays in the source. */
export async function readRegisteredInput(run: string, inputId: string): Promise<RegisteredInputView | undefined> {
  const saved = await checkpoint(run);
  const candidate = saved.inputs[inputId] as Candidate | undefined;
  if (!candidate) return undefined;
  const config = saved.config as EvalConfig;
  const version = config.inputs.versions.find((entry) => entry.id === candidate.version);
  if (!version) throw new Error("输入版本未登记：" + candidate.version);
  const { raw, line, record } = await locateRecordStream(
    candidate.source,
    candidate,
    version,
    config.inputs.default_batch_id,
  );
  return {
    input_id: inputId,
    batch_id: record.batch_id,
    case_id: record.case_id,
    line,
    recorded_line: candidate.line,
    question: record.question,
    answer: contentText(raw.messages[record.final_index]?.content),
  };
}

/** Business ID -> locator -> source body; no raw input is copied into a run. */
export async function locateAnalysisInput(run: string, inputId: string) {
  const saved = await checkpoint(run);
  const candidate = saved.inputs[inputId];
  if (!candidate) throw new Error("输入未登记：" + inputId);
  return { run, inputId, candidate: { ...candidate, input_id: inputId }, config: saved.config as EvalConfig };
}
export async function readAnalysisInput(locator: Awaited<ReturnType<typeof locateAnalysisInput>>) {
  const { candidate, config } = locator;
  const version = config.inputs.versions.find((entry) => entry.id === candidate.version);
  if (!version) throw new Error("输入版本未登记：" + candidate.version);
  return (await locateRecordStream(candidate.source, candidate, version, config.inputs.default_batch_id)).raw;
}

export interface ProblemClassView {
  id: string;
  label: string;
  definition: string;
  aliases: string[];
  occurrences: number;
  first_seen: ProblemOrigin | null;
  category_paths?: string[][];
}
export interface ProblemCategoryView {
  path: string[];
  class_ids: string[];
  occurrences: number;
}
export interface ProblemMergeView {
  id: string;
  label: string;
  into: string;
  into_label: string | null;
  reason: string | null;
}
export interface ProblemLibraryView {
  model: string;
  name: string;
  updated_at: string | null;
  components: {
    id: string;
    label: string;
    definition: string;
    aliases: string[];
    classes: ProblemClassView[];
  }[];
  merged: ProblemMergeView[];
  categories: ProblemCategoryView[];
  totals: { components: number; classes: number; occurrences: number };
}

/** Prefix topic views share class IDs; counts always refer to distinct source findings. */
export function problemCategories(library: ProblemLibrary): ProblemCategoryView[] {
  const groups = new Map<string, { path: string[]; classes: Set<string> }>();
  for (const problem of Object.values(library.classes)) {
    if (problem.status !== "active") continue;
    for (const path of problem.category_paths ?? [])
      for (let length = 1; length <= path.length; length++) {
        const prefix = path.slice(0, length), key = JSON.stringify(prefix.map(segment => segment.trim().replace(/\s+/gu, " ").toLowerCase()));
        const group = groups.get(key) ?? { path: prefix, classes: new Set<string>() };
        group.classes.add(problem.id);
        groups.set(key, group);
      }
  }
  return [...groups.values()].map(group => ({ path: group.path, class_ids: [...group.classes],
    occurrences: countProblemSamples(effectiveProblemOccurrences(library).filter(sample => group.classes.has(sample.class_id))) }))
    .sort((a, b) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));
}

function mergedClasses(library: ProblemLibrary): ProblemMergeView[] {
  return Object.values(library.classes)
    .filter((problem) => problem.status === "merged")
    .map((problem) => {
      const event = library.events.find(
        (entry) => entry.type === "class_merged" && entry.detail.from === problem.id,
      );
      return {
        id: problem.id,
        label: problem.label,
        into: problem.merged_into || "",
        into_label: problem.merged_into ? (library.classes[problem.merged_into]?.label ?? null) : null,
        reason: event ? String(event.detail.reason ?? "") || null : null,
      };
    });
}

/** Current configured models, including empty libraries; the shared knowledge stays across runs. */
export async function listConfiguredProblemLibrary(config: EvalConfig): Promise<ProblemLibraryView[]> {
  return Promise.all(config.inputs.versions.map(async (version) => {
    const model = version.id;
    const name = version.display_name || version.name;
    const library = await readProblemLibrary(problemLibraryFile(config.problemLibrary, model));
    if (!library) return { model, name, updated_at: null, components: [], merged: [], categories: [],
      totals: { components: 0, classes: 0, occurrences: 0 } };
    const active = Object.values(library.classes).filter((problem) => problem.status === "active");
    return {
      model,
      name,
      updated_at: library.updated_at,
      components: projectLibrary(library).components.map(component => ({ ...component,
        classes: component.classes.map(problem => ({ ...problem, first_seen: library.classes[problem.id]!.first_seen }))
          .sort((a, b) => b.occurrences - a.occurrences || a.label.localeCompare(b.label)),
      })),
      merged: mergedClasses(library),
      categories: problemCategories(library),
      totals: {
        components: Object.keys(library.components).length,
        classes: active.length,
        occurrences: countProblemSamples(effectiveProblemOccurrences(library)),
      },
    };
  }));
}

export interface ProblemSampleRecall {
  available: boolean;
  reason: "run_missing" | "run_unavailable" | "sample_missing" | "result_missing" | "finding_missing" | "input_unavailable" | null;
  attribution_task_id: string | null;
  url: string | null;
}

const unavailableRecall = (reason: Exclude<ProblemSampleRecall["reason"], null>): ProblemSampleRecall =>
  ({ available: false, reason, attribution_task_id: null, url: null });

/** Resolve only this page's run, attribution and source references; no result bodies enter the library. */
async function sampleRecalls(config: EvalConfig, occurrences: ProblemOccurrence[]): Promise<ProblemSampleRecall[]> {
  const runs = new Map<string, { directory?: string; saved?: Checkpoint; reason?: Exclude<ProblemSampleRecall["reason"], null> }>();
  await Promise.all([...new Set(occurrences.map((item) => item.run_id))].map(async (runId) => {
    try {
      const directory = path.join(config.output.path, safeId(runId));
      const saved = await checkpoint(directory);
      if (saved.runId !== runId || !saved.inputs || !saved.tasks)
        throw new Error("运行状态身份或索引无效");
      runs.set(runId, { directory, saved });
    } catch (error) {
      runs.set(runId, { reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "run_missing" : "run_unavailable" });
    }
  }));
  const prepared = occurrences.map((occurrence) => {
    const run = runs.get(occurrence.run_id)!;
    if (!run.saved || !run.directory) return { occurrence, recall: unavailableRecall(run.reason!) };
    const { saved, directory } = run;
    const candidate = saved.inputs[occurrence.input_id];
    const task = Object.entries(saved.tasks).find(([, task]) =>
      task.stage === "attribution" && Object.values(task.inputIds).includes(occurrence.input_id));
    if (!candidate || candidate.version !== occurrence.version || candidate.batch_id !== occurrence.batch_id ||
        candidate.case_id !== occurrence.case_id || !task)
      return { occurrence, recall: unavailableRecall("sample_missing") };
    const [taskId, taskState] = task;
    if (taskState.status !== "succeeded" || !taskState.receipt?.exported)
      return { occurrence, recall: unavailableRecall("result_missing") };
    return { occurrence, saved, directory, candidate, taskId };
  });
  const taskGroups = new Map<string, Set<string>>();
  for (const item of prepared)
    if (item.directory && item.taskId)
      (taskGroups.get(item.directory) ?? taskGroups.set(item.directory, new Set()).get(item.directory)!).add(item.taskId);
  const receipts = new Map<string, Record<string, SubmissionReceipt>>();
  await Promise.all([...taskGroups].map(async ([directory, ids]) => {
    try { receipts.set(directory, (await readRunTasks(directory, [...ids])).receipts); }
    catch {
      // One missing result must not disable the other intact samples on this page.
      const recovered: Record<string, SubmissionReceipt> = {};
      await Promise.all([...ids].map(async (id) => {
        try {
          const receipt = (await readRunTasks(directory, [id])).receipts[id];
          if (receipt) recovered[id] = receipt;
        } catch { /* This occurrence receives the result_missing state below. */ }
      }));
      receipts.set(directory, recovered);
    }
  }));
  const inputs = new Map<string, Promise<boolean>>();
  return Promise.all(prepared.map(async (item) => {
    if (item.recall) return item.recall;
    const { occurrence, saved, directory, candidate, taskId } = item;
    const row = receipts.get(directory!)?.[taskId!]?.exported?.row;
    if (!row) return unavailableRecall("result_missing");
    const evaluation = row.evaluation as { findings?: { finding_id?: string }[] } | undefined;
    if (!evaluation?.findings?.some((finding) => finding.finding_id === occurrence.finding_id))
      return unavailableRecall("finding_missing");
    const inputKey = JSON.stringify([directory, occurrence.input_id]);
    if (!inputs.has(inputKey)) inputs.set(inputKey, (async () => {
      try {
        const runConfig = saved!.config as EvalConfig;
        const version = runConfig.inputs.versions.find((entry) => entry.id === candidate!.version);
        if (!version) return false;
        const revision = await fileSourceReader.revision(candidate!.source);
        await locateRecordStream(candidate!.source, { ...candidate!, input_id: occurrence.input_id }, version, runConfig.inputs.default_batch_id);
        return await fileSourceReader.revision(candidate!.source) === revision;
      } catch { return false; }
    })());
    if (!(await inputs.get(inputKey))) return unavailableRecall("input_unavailable");
    const query = new URLSearchParams({ run: occurrence.run_id, batch: occurrence.batch_id,
      case: occurrence.case_id, model: occurrence.version, task: taskId!, finding: occurrence.finding_id });
    return { available: true, reason: null, attribution_task_id: taskId!, url: `/?${query}` };
  }));
}

/** Occurrences of one configured model's problem class, newest first, with verified sample recall. */
export async function readConfiguredProblemClass(config: EvalConfig, model: string, classId: string, page: number) {
  const pageSize = 50;
  const version = config.inputs.versions.find((entry) => entry.id === model);
  if (!version) return undefined;
  const library = await readProblemLibrary(problemLibraryFile(config.problemLibrary, model));
  const problem = library?.classes[classId];
  if (!library || !problem) return undefined;
  const component = library.components[problem.component_id];
  const seenSamples = new Set<string>();
  const occurrences = effectiveProblemOccurrences(library)
    .filter((occurrence) => occurrence.class_id === classId)
    .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : a.at < b.at ? 1 : -1))
    .filter(occurrence => {
      const key = problemSampleKey(occurrence);
      if (seenSamples.has(key)) return false;
      seenSamples.add(key);
      return true;
    });
  const selected = occurrences.slice((page - 1) * pageSize, page * pageSize);
  const recalls = await sampleRecalls(config, selected);
  const related = new Set([classId]);
  const merged = mergedClasses(library);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of merged)
      if (related.has(entry.into) && !related.has(entry.id)) { related.add(entry.id); changed = true; }
  }
  return {
    model,
    name: version.display_name || version.name,
    class: {
      id: problem.id,
      label: problem.label,
      definition: problem.definition,
      aliases: problem.aliases,
      status: problem.status,
      merged_into: problem.merged_into,
      first_seen: problem.first_seen,
      ...(problem.category_paths === undefined ? {} : { category_paths: problem.category_paths }),
    },
    component: component
      ? { id: component.id, label: component.label, definition: component.definition }
      : null,
    lineage: merged.filter((entry) => related.has(entry.id)),
    total: occurrences.length,
    page,
    page_size: pageSize,
    occurrences: selected.map((occurrence, index) => ({
      id: occurrence.id,
      run_id: occurrence.run_id,
      task_id: occurrence.task_id,
      submission_id: occurrence.submission_id,
      input_id: occurrence.input_id,
      batch_id: occurrence.batch_id,
      case_id: occurrence.case_id,
      version: occurrence.version,
      evaluator_version: occurrence.evaluator_version,
      finding_id: occurrence.finding_id,
      evidence_status: occurrence.evidence_status,
      message_index: occurrence.message_index,
      quote: occurrence.quote,
      source: occurrence.source,
      classification: occurrence.classification,
      previous_class_id: occurrence.previous_class_id,
      at: occurrence.at,
      recall: recalls[index],
    })),
  };
}
