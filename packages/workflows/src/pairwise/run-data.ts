import {
  errorText,
  ValidationError,
  type RunManifest,
  type RunState,
  type TaskPlan,
  type ValidationIssue,
} from "@eval/contracts";
import { createRunRepository, readInputSource } from "@eval/data";
import { adapt, buildPlan, candidateKey, inputSources } from "./input.js";
import type { BatchPreflight, Candidate, EvalConfig, RawInput, TaskData } from "./types.js";
import { pairwiseCodec } from "./codec.js";
import { encodeResult } from "./results.js";
export const pairwiseRepository = createRunRepository(pairwiseCodec, encodeResult);
export const { readRun: readRunState, writeRun: writeRunState, createResultWriter } = pairwiseRepository;
export async function loadRunInputs(
  manifest: RunManifest,
  issues?: ValidationIssue[],
): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {},
    errors: ValidationIssue[] = [];
  const config = manifest.config as EvalConfig;
  const sources = inputSources(manifest.inputCatalog as Candidate[]);
  for (const [source, candidates] of sources) {
    let revision: string, lines: string[];
    try {
      const file = await readInputSource(source);
      revision = file.revision;
      lines = file.text.replace(/^\uFEFF/, "").split(/\r?\n/);
    } catch (error) {
      errors.push({
        category: "file",
        code: "input_source_unavailable",
        path: source,
        expected: "可读取的原始输入文件",
        actual: null,
        message: errorText(error),
      });
      continue;
    }
    for (const candidate of candidates) {
      try {
        if (candidate.source_revision !== revision)
          throw new Error("输入源文件已变化，无法校验旧结果的原始证据：" + source);
        const raw = JSON.parse(lines[candidate.line - 1]) as RawInput;
        const version = config.inputs.versions.find((v) => v.id === candidate.version)!;
        if (
          candidateKey(adapt(raw, version, source, candidate.line, config.inputs.default_batch_id)) !==
          candidateKey(candidate)
        )
          throw new Error("输入源记录与登记的业务标识不一致：" + candidate.input_id);
        inputs[candidate.input_id] = raw;
      } catch (error) {
        errors.push({
          category: "file",
          code: "input_source_unavailable",
          path: source,
          expected: candidate.input_id,
          actual: null,
          message: errorText(error),
        });
      }
    }
  }
  if (issues) issues.push(...errors);
  else if (errors.length) throw new ValidationError(errors);
  return inputs;
}
export async function reconcileRun(_run: string, state: RunState, current: unknown): Promise<TaskPlan> {
  const config = state.manifest.config as EvalConfig,
    supplied = current as EvalConfig;
  const selected: EvalConfig = {
    ...config,
    judge: supplied.judge,
    execution: supplied.execution,
    inputs: {
      ...config.inputs,
      versions: config.inputs.versions.map((v) => ({
        ...v,
        path: supplied.inputs.versions.find((item) => item.id === v.id)?.path || v.path,
      })),
    },
  };
  const previous = state.manifest.tasks;
  const plan = await buildPlan(selected, {
    tasks: previous,
    inputs: {},
    summary: state.manifest.preflight,
    catalog: state.manifest.inputCatalog,
  });
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  // Accepted work is immutable within a run. Only unfinished/new tasks use the latest source records.
  for (const task of previous) if (state.receipts[task.id] || !tasks.has(task.id)) tasks.set(task.id, task);
  const dependencies = new Set([...tasks.values()].flatMap((task) => Object.values(task.dependencies)));
  for (const [id, task] of tasks)
    if (task.stage === "correctness" && !dependencies.has(id) && !state.receipts[id]) tasks.delete(id);
  plan.tasks = [...tasks.values()];
  plan.summary.correctness_tasks = plan.tasks.filter((task) => task.stage === "correctness").length;
  plan.summary.pairwise_tasks = plan.tasks.filter((task) => task.stage === "pairwise").length;
  for (const [batch, counts] of Object.entries(plan.summary.by_batch as Record<string, BatchPreflight>)) {
    const selected = plan.tasks.filter((task) => (task.data as TaskData).candidates.A.batch_id === batch);
    counts.correctness_tasks = selected.filter((task) => task.stage === "correctness").length;
    counts.pairwise_tasks = selected.filter((task) => task.stage === "pairwise").length;
  }
  const catalog = new Map((plan.catalog as Candidate[]).map((c) => [c.input_id, c]));
  for (const task of plan.tasks)
    for (const c of Object.values((task.data as TaskData).candidates)) catalog.set(c.input_id, c);
  const needed = plan.tasks.filter(
    (t) => !state.receipts[t.id] || (t.stage === "pairwise" && !state.receipts[t.id].exported),
  );
  const unavailable = [...new Set(needed.flatMap((t) => Object.values(t.inputIds)))].filter(
    (id) => !Object.hasOwn(plan.inputs, id),
  );
  if (unavailable.length)
    throw new ValidationError(
      unavailable.map((id) => ({
        category: "input",
        code: "input_source_unavailable",
        path: catalog.get(id)!.source,
        candidate: catalog.get(id)!.version,
        expected: id,
        actual: null,
        message: "未完成任务的原始输入缺失、无效或冲突；请修复源文件后续跑。已有结果保留。",
      })),
    );
  // Unused new revisions of completed inputs need no persistent registration.
  const used = new Set(plan.tasks.flatMap((t) => Object.values(t.inputIds)));
  const represented = new Set([...used].map((id) => candidateKey(catalog.get(id)!)));
  plan.catalog = [...catalog.values()].filter(
    (c) => used.has(c.input_id) || !represented.has(candidateKey(c)),
  );
  for (const task of plan.tasks) {
    const revision = (task.data as TaskData).revision || 1,
      old = state.manifest.states[task.id];
    if (!state.receipts[task.id] && (!old || (old.revision || 1) !== revision))
      state.manifest.states[task.id] = {
        status: "pending",
        attempts: old?.attempts || 0,
        revision,
      };
  }
  state.manifest.config = selected;
  state.manifest.tasks = plan.tasks;
  state.manifest.inputCatalog = plan.catalog;
  state.manifest.inputs = Object.fromEntries(
    (plan.catalog as Candidate[]).map((c) => [c.input_id, { id: c.input_id, name: c.input_id }]),
  );
  state.manifest.preflight = plan.summary;
  return plan;
}
