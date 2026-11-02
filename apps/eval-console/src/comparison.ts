import { canonical, type JsonObject, type RunState, type ShardSource, type WorkflowDefinition } from "@eval/contracts";
import { type SourceCursor } from "@eval/data";
import { candidateKey, createInputBindings, createInputShardScan, type Candidate } from "@eval/workflows/inputs";
import { assertComparableGroups, buildPlan, comparisonWorkflow, taskCase, type EvalConfig, type TaskData } from "@eval/workflows/comparison";

interface CaseStream {
  pending: Candidate[];
  seen: Record<string, true>;
  invalid: Record<string, true>;
  planned: Record<string, true>;
  cursors: Record<string, SourceCursor & { revision: string }>;
}
const caseKey = (c: { batch_id: string; case_id: string }) => canonical([c.batch_id, c.case_id]);
const bindings = new WeakMap<object, ReturnType<typeof createInputBindings>>();
function bind(state: RunState) {
  let value = bindings.get(state.manifest);
  if (!value) bindings.set(state.manifest, value = createInputBindings(state.manifest.config as EvalConfig));
  return value;
}

/** Align model rows by business date/case, retaining only coordinates between small reads. */
export function comparisonCaseShards(config: EvalConfig, state: RunState): ShardSource {
  const manifest = state.manifest;
  // Explicit maintenance plans retain their fixed task scope and never discover new cases.
  if (!manifest.preflight.case_stream || manifest.executionScope) return { next: async () => undefined, done: () => true };
  const stream = manifest.preflight.case_stream as CaseStream;
  const admitted = new Set(Object.keys(stream.seen));
  const scan = createInputShardScan(config, {
    catalog: () => stream.pending,
    admitted, cursors: stream.cursors,
    foundScope: config.inputs.records ? new Set<string>() : undefined,
  });
  const window = config.execution.sessionWindow;
  const limitReached = () => !config.inputs.records && config.inputs.limit !== undefined && Object.keys(stream.planned).length >= config.inputs.limit;
  const activeCases = () => new Set(manifest.tasks.filter(task => ["pending", "running"].includes(manifest.states[task.id]?.status))
    .map(task => caseKey(taskCase(task.data as TaskData)))).size;
  const ready = () => {
    const groups = new Map<string, Candidate[]>();
    for (const candidate of stream.pending) {
      const key = caseKey(candidate);
      if (stream.planned[key]) continue;
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    return [...groups].find(([, rows]) => config.inputs.versions.every(version => rows.some(c => c.version === version.id) ||
      stream.invalid[canonical([rows[0].batch_id, rows[0].case_id, version.id])] || scan.versionDone(version.id)));
  };
  return {
    done: () => limitReached() || scan.done() && stream.pending.every(c => stream.planned[caseKey(c)]),
    async next() {
      // The previous shard has now been merged by Host. Keep it durable until this acknowledgement.
      stream.pending = stream.pending.filter(c => !stream.planned[caseKey(c)]);
      if (limitReached() || activeCases() >= window) return undefined;
      const group = ready();
      if (group) {
        const [key, candidates] = group;
        const plan = await buildPlan({ ...config, reviewQuestions: config.reviewQuestions?.filter(item => caseKey(item) === key) },
          undefined, { candidates });
        stream.planned[key] = true;
        for (const field of ["cases", "valid_inputs", "criteria_tasks", "attribution_tasks", "comparison_tasks", "rewrite_tasks"])
          manifest.preflight[field] = Number(manifest.preflight[field] ?? 0) + Number(plan.summary[field] ?? 0);
        const byBatch = (manifest.preflight.by_batch ??= {}) as Record<string, Record<string, number>>;
        for (const [batch, counts] of Object.entries(plan.summary.by_batch as Record<string, Record<string, number>>)) {
          const entry = byBatch[batch] ??= {};
          for (const [name, count] of Object.entries(counts)) entry[name] = (entry[name] ?? 0) + count;
        }
        manifest.preflight.skipped ??= [];
        (manifest.preflight.skipped as unknown[]).push(...plan.summary.skipped as unknown[]);
        return { source: candidates.map(c => c.source).join(", "), revision: "", candidates,
          tasks: plan.tasks, inputs: bind(state)(candidates), issues: plan.summary.issues as JsonObject[] };
      }
      const shard = await scan.next();
      if (!shard) {
        // EOF can make the last incomplete case ready; return a progress tick before planning it.
        return ready() ? { source: "", revision: "", candidates: [], tasks: [], inputs: {} } : undefined;
      }
      for (const c of shard.candidates) {
        stream.seen[candidateKey(c)] = true;
        if (!stream.planned[caseKey(c)]) stream.pending.push(c);
      }
      for (const issue of shard.issues) if (issue.batch_id && issue.case_id && issue.version) {
        const key = canonical([issue.batch_id, issue.case_id, issue.version]);
        stream.invalid[key] = true;
        stream.pending = stream.pending.filter(c => candidateKey(c) !== key);
      }
      return { source: shard.source, revision: shard.revision, candidates: [], tasks: [], inputs: {}, issues: shard.issues };
    },
  };
}

/** Completed case bodies leave memory; their task/receipt indexes remain available for reports. */
function releaseCases(state: RunState, inputs: Record<string, unknown>) {
  const planned = new Set(state.manifest.tasks.map(task => caseKey(taskCase(task.data as TaskData))));
  const pending = new Set(state.manifest.tasks.filter(task => state.manifest.states[task.id]?.status !== "succeeded")
    .map(task => caseKey(taskCase(task.data as TaskData))));
  for (const c of state.manifest.inputCatalog as Candidate[] ?? []) if (c.released || planned.has(caseKey(c)) && !pending.has(caseKey(c))) {
    c.released = true;
    delete inputs[c.input_id];
  }
}

/** The console's normal comparison path streams cases; explicit corpus-wide analyses keep their planner. */
export const consoleComparisonWorkflow: WorkflowDefinition = {
  ...comparisonWorkflow,
  async plan(value) {
    const config = value as EvalConfig;
    if (config.clustering.enabled || config.prediction) return comparisonWorkflow.plan(config);
    assertComparableGroups(config);
    if (!Number.isSafeInteger(config.execution.sessionWindow) || config.execution.sessionWindow < 1)
      throw new Error("execution.sessionWindow must be a positive integer");
    return { tasks: [], inputs: {}, catalog: [], summary: { sharded: true,
      case_stream: { pending: [], seen: {}, invalid: {}, planned: {}, cursors: {} }, issues: [],
      sources: Object.fromEntries(config.inputs.versions.map(v => [v.id, v.sources.map(s => s.path)])), by_batch: {},
    } };
  },
  shards: (config, state) => comparisonCaseShards(config as EvalConfig, state),
  release(state, inputs) { if (state.manifest.preflight.case_stream) releaseCases(state, inputs); },
  async reconcile(run, state, value) {
    if (!state.manifest.preflight.case_stream || state.manifest.executionScope)
      return comparisonWorkflow.reconcile!(run, state, value);
    const config = value as EvalConfig;
    state.manifest.config = { ...state.manifest.config as EvalConfig, execution: config.execution };
    const catalog = state.manifest.inputCatalog as Candidate[];
    const stream = state.manifest.preflight.case_stream as CaseStream;
    const tasks = new Set(state.manifest.tasks.map(task => caseKey(taskCase(task.data as TaskData))));
    for (const c of stream.pending) if (!tasks.has(caseKey(c)) && !catalog.some(row => caseKey(row) === caseKey(c) && row.released))
      delete stream.planned[caseKey(c)];
    return { tasks: state.manifest.tasks, inputs: bind(state)(catalog.filter(c => !c.released)),
      catalog, summary: state.manifest.preflight as JsonObject };
  },
};
