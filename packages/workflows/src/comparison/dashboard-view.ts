import { readJson, locateRun, fileSourceReader } from "@eval/data";
import type { TaskState } from "@eval/contracts";
import { readRunState } from "./run-data.js";
import { locateRecord, taskCase } from "./input.js";
import type { Candidate, EvalConfig, TaskData } from "./types.js";
import type { Checkpoint } from "./codec.js";

/** Read-only workflow projection: the dashboard never interprets blind labels or result files. */
async function checkpoint(run: string): Promise<Checkpoint> {
  const value = await readJson<Checkpoint>(locateRun(run).stateFile);
  if (value.format !== "evaluation-run") throw new Error("无效的运行状态");
  return value;
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
  for (const [id, task] of Object.entries(saved.tasks)) {
    const data = task.data as TaskData;
    const candidate = Object.values(task.inputIds).map((inputId) => saved.inputs[inputId]).find(Boolean);
    const identity = data.case || candidate;
    if (!identity) throw new Error(`任务 ${id} 缺少样本身份`);
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
    const identity = taskCase(task.data as TaskData);
    return identity.batch_id === batch && identity.case_id === caseId;
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
