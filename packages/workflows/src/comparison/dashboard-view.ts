import path from "node:path";
import { readJson, locateRun, problemLibraryFile, readProblemLibrary } from "@eval/data";
import type { JsonObject, TaskState } from "@eval/contracts";
import { readRunTasks } from "./run-data.js";
import { buildPlan, contentText, locateRecordStream } from "./input.js";
import type { Candidate, EvalConfig, Stage, TaskData } from "./types.js";
import type { Checkpoint } from "./codec.js";

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
/** Scans configured sources with the plan parser, so offered dates match what a run accepts. */
export async function listInputInventory(config: EvalConfig): Promise<{ dates: InputDate[]; issues: number }> {
  const plan = await buildPlan({
    ...config,
    comparisons: [],
    inputs: { ...config.inputs, batches: undefined, case_ids: undefined, limit: undefined },
  });
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
    if (task.stage === "clustering") continue;
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
        return { message_index: entry.message_index, quote: clip(entry.quote, 4000) };
      })
    : value;
/** Sample-view projection of an accepted row: current Schema fields, long text clipped; comparison `evaluations` stay in the JSONL. */
export function caseResultView(stage: Stage, row: JsonObject | undefined): JsonObject | null {
  if (!row) return null;
  if (stage === "attribution") {
    const value = (row.evaluation ?? {}) as JsonObject;
    return {
      evaluation: {
        has_standard_answer: value.has_standard_answer,
        is_correct: value.is_correct,
        task_analysis: value.task_analysis,
        correctness_reason: clip(value.correctness_reason, 8000),
        correctness_evidence: clipEvidence(value.correctness_evidence),
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
    };
  }
  if (stage === "rewrite") return { rewrites: row.rewrites };
  if (stage === "comparison")
    return {
      models: row.models,
      ground_truth: row.ground_truth,
      ranking: row.ranking,
      task_analysis: row.task_analysis,
      decision_basis: row.decision_basis,
      assessments: row.assessments,
      verdicts: row.verdicts,
    };
  return null;
}

export async function readCaseDetail(run: string, batch: string, caseId: string) {
  const saved = await checkpoint(run);
  const taskIds = Object.entries(saved.tasks).flatMap(([id, task]) => {
    // Clustering tasks cover a whole model × batch; they belong to the run overview, not a single case.
    if (task.stage === "clustering") return [];
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
  return {
    batch_id: batch,
    case_id: caseId,
    question: [...candidates.values()][0]?.question || (first.data as TaskData).case?.question || "",
    candidates: [...candidates.values()].map(({ input_id, version, name }) => ({
      input_id, version, name,
    })),
    tasks: taskIds.map((id) => {
      const task = saved.tasks[id]!;
      const status: TaskState = task;
      return {
        id,
        stage: task.stage,
        status: status.status,
        attempts: status.attempts,
        reason: status.reason || status.failure?.errors[0]?.message || null,
        last_progress_at: status.lastProgressAt ?? null,
        duration_ms: status.durationMs ?? null,
        versions: Object.values(task.inputIds).flatMap((inputId) => saved.inputs[inputId]?.version ?? []),
        rewrite_of: (task.data as TaskData).rewriteOf ?? null,
      };
    }),
  };
}

/** One task's accepted row, loaded when the sample view expands it. */
export async function readTaskResult(run: string, taskId: string) {
  const saved = await checkpoint(run);
  const task = saved.tasks[taskId];
  if (!task) return undefined;
  // Repository decoding checks the accepted reference against its authoritative JSONL row.
  const state = await readRunTasks(run, [taskId]);
  return {
    task_id: taskId,
    stage: task.stage,
    result: caseResultView(task.stage as Stage, state.receipts[taskId]?.exported?.row),
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
  first_seen: { batch_id: string; case_id: string; evaluator_version: string; at: string } | null;
}
export interface ProblemLibraryView {
  model: string;
  components: {
    id: string;
    label: string;
    definition: string;
    aliases: string[];
    classes: ProblemClassView[];
  }[];
  merged: { id: string; label: string; into: string; into_label: string | null; reason: string | null }[];
  totals: { components: number; classes: number; occurrences: number };
}

function clusteringModels(saved: Checkpoint): string[] {
  return [...new Set(
    Object.values(saved.tasks).flatMap((task) =>
      task.stage === "clustering" && (task.data as TaskData).scope?.version
        ? [(task.data as TaskData).scope!.version] : [],
    ),
  )];
}

/** Problem-library snapshot for the models that ran clustering in this run; read-only. */
export async function listProblemLibrary(run: string): Promise<ProblemLibraryView[]> {
  const saved = await checkpoint(run);
  const config = saved.config as EvalConfig;
  const models = clusteringModels(saved);
  const views: ProblemLibraryView[] = [];
  for (const model of models) {
    const library = await readProblemLibrary(problemLibraryFile(config.problemLibrary, model));
    if (!library) continue;
    const counts = new Map<string, number>();
    for (const occurrence of library.occurrences)
      counts.set(occurrence.class_id, (counts.get(occurrence.class_id) ?? 0) + 1);
    const active = Object.values(library.classes).filter((problem) => problem.status === "active");
    views.push({
      model,
      components: Object.values(library.components).map((component) => ({
        id: component.id,
        label: component.label,
        definition: component.definition,
        aliases: component.aliases,
        classes: active
          .filter((problem) => problem.component_id === component.id)
          .map((problem) => ({
            id: problem.id,
            label: problem.label,
            definition: problem.definition,
            aliases: problem.aliases,
            occurrences: counts.get(problem.id) ?? 0,
            first_seen: problem.first_seen
              ? {
                  batch_id: problem.first_seen.batch_id,
                  case_id: problem.first_seen.case_id,
                  evaluator_version: problem.first_seen.evaluator_version,
                  at: problem.first_seen.at,
                }
              : null,
          }))
          .sort((a, b) => b.occurrences - a.occurrences || a.label.localeCompare(b.label)),
      })),
      merged: Object.values(library.classes)
        .filter((problem) => problem.status === "merged")
        .map((problem) => {
          const event = library.events.find(
            (entry) => entry.type === "class_merged" && entry.detail.from === problem.id,
          );
          return {
            id: problem.id,
            label: problem.label,
            into: problem.merged_into || "",
            into_label: problem.merged_into
              ? (library.classes[problem.merged_into]?.label ?? null)
              : null,
            reason: event ? String(event.detail.reason ?? "") || null : null,
          };
        }),
      totals: {
        components: Object.keys(library.components).length,
        classes: active.length,
        occurrences: library.occurrences.length,
      },
    });
  }
  return views.sort((a, b) => a.model.localeCompare(b.model));
}

/** Occurrences of one problem class, newest first; merged classes resolve to their target. */
export async function readProblemClass(run: string, model: string, classId: string, page: number) {
  const pageSize = 50;
  const saved = await checkpoint(run);
  const config = saved.config as EvalConfig;
  if (!clusteringModels(saved).includes(model)) return undefined;
  const library = await readProblemLibrary(problemLibraryFile(config.problemLibrary, model));
  const problem = library?.classes[classId];
  if (!library || !problem) return undefined;
  const component = library.components[problem.component_id];
  const occurrences = library.occurrences
    .filter((occurrence) => occurrence.class_id === classId)
    .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : a.at < b.at ? 1 : -1));
  return {
    model,
    class: {
      id: problem.id,
      label: problem.label,
      definition: problem.definition,
      aliases: problem.aliases,
      status: problem.status,
      merged_into: problem.merged_into,
      first_seen: problem.first_seen,
    },
    component: component
      ? { id: component.id, label: component.label, definition: component.definition }
      : null,
    total: occurrences.length,
    page,
    page_size: pageSize,
    occurrences: occurrences.slice((page - 1) * pageSize, page * pageSize).map((occurrence) => ({
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
    })),
  };
}
