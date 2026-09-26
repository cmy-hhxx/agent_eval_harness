import path from "node:path";
import { readJson, locateRun, fileSourceReader, problemLibraryFile, readProblemLibrary } from "@eval/data";
import type { TaskState } from "@eval/contracts";
import { readRunState } from "./run-data.js";
import { buildPlan, locateRecord, taskIdentity } from "./input.js";
import type { Candidate, EvalConfig, TaskData } from "./types.js";
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
  query?: string;
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
  const query = (filter.query || "").toLocaleLowerCase();
  const rows = [...cases.values()]
    .filter((item) =>
      item.matches &&
      (!filter.batch || item.batch_id === filter.batch) &&
      (!query || `${item.case_id} ${item.question}`.toLocaleLowerCase().includes(query)),
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

export async function readCaseDetail(run: string, batch: string, caseId: string) {
  // Repository decoding checks the accepted references against authoritative JSONL rows.
  const state = await readRunState(run);
  const tasks = state.manifest.tasks.filter((task) => {
    const identity = taskIdentity(task.data as TaskData);
    return identity.case_id === caseId && identity.batch_id === batch;
  });
  if (!tasks.length) return undefined;
  const candidates = new Map<string, Candidate>();
  for (const task of tasks)
    for (const candidate of Object.values((task.data as TaskData).candidates))
      candidates.set(candidate.input_id, candidate);
  const first = tasks[0].data as TaskData;
  return {
    batch_id: batch,
    case_id: caseId,
    question: [...candidates.values()][0]?.question || first.case?.question || "",
    candidates: [...candidates.values()].map(({ input_id, version, name }) => ({
      input_id, version, name,
    })),
    tasks: tasks.map((task) => {
      const status: TaskState = state.manifest.states[task.id];
      const data = task.data as TaskData;
      return {
        id: task.id,
        stage: task.stage,
        status: status.status,
        attempts: status.attempts,
        reason: status.reason || status.failure?.errors[0]?.message || null,
        last_progress_at: status.lastProgressAt ?? null,
        duration_ms: status.durationMs ?? null,
        versions: Object.values(data.candidates).map((c) => c.version),
        rewrite_of: data.rewriteOf ?? null,
        result: state.receipts[task.id]?.exported?.row ?? null,
      };
    }),
  };
}

export async function readRegisteredInput(run: string, inputId: string) {
  const saved = await checkpoint(run);
  const candidate = saved.inputs[inputId] as Candidate | undefined;
  if (!candidate) return undefined;
  const config = saved.config as EvalConfig;
  const version = config.inputs.versions.find((entry) => entry.id === candidate.version);
  if (!version) throw new Error("输入版本未登记：" + candidate.version);
  const text = await fileSourceReader.read(candidate.source);
  const { raw, line } = locateRecord(text, { ...candidate, input_id: inputId }, version, candidate.source, config.inputs.default_batch_id);
  return {
    input_id: inputId,
    batch_id: candidate.batch_id,
    case_id: candidate.case_id,
    line,
    recorded_line: candidate.line,
    raw,
  };
}

export interface ProblemClassView {
  id: string;
  label: string;
  definition: string;
  aliases: string[];
  occurrences: number;
  first_seen: { batch_id: string; case_id: string; at: string } | null;
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
      finding_id: occurrence.finding_id,
      message_index: occurrence.message_index,
      quote: occurrence.quote,
      source: occurrence.source,
      classification: occurrence.classification,
      previous_class_id: occurrence.previous_class_id,
      at: occurrence.at,
    })),
  };
}
