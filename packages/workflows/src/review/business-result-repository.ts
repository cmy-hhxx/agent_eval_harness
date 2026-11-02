import { canonical, type JsonObject, type PlannedTask, type RunRepository, type RunState } from "@eval/contracts";
import { businessBatch, claimBusinessPartitions, completedCaseKey, createBusinessPublisher, formalResultLine,
  readBusinessResults, readCompletedCases, type BusinessPublication, type BusinessResult } from "@eval/data";
import { businessAnswer, businessCandidates, businessDestination, businessResultKey, businessScope, completeBusinessResult } from "./business-results.js";
import type { Candidate, EvaluationConfig } from "../inputs/types.js";

type BusinessTaskData = { rewriteOf?: { taskId: string } };

/** Publish formal results and skip cases already present in the selected output directory. */
export function businessResultRepository(repository: RunRepository): RunRepository {
  async function describe(run: string, state: RunState, task: PlannedTask, tasks: ReadonlyMap<string, PlannedTask>): Promise<Omit<BusinessResult, "line" | "published"> | undefined> {
    const receipt = state.receipts[task.id], reference = receipt?.exported;
    if (!reference || task.stage === "rewrite") return;
    const answers = businessCandidates(task, state, tasks).map(businessAnswer);
    const target = businessDestination(task, state, reference.file!, tasks), scope = businessScope(task);
    return { ...target, id: businessResultKey(task.stage, answers, scope), stage: task.stage, scope, answers,
      acceptedAt: receipt.acceptedAt, evaluatorVersion: receipt.evaluatorVersion, judge: receipt.judge,
      submissionId: receipt.submissionId, complete: completeBusinessResult(task, state, tasks), origin: {
        run, taskId: task.id, reference: { id: reference.id, file: reference.file,
          line: reference.line ?? await formalResultLine(run, reference, reference.row) } } };
  }
  function preparation(state: RunState) {
    const config = state.manifest.config as EvaluationConfig;
    const comparisons = (config as EvaluationConfig & { comparisons?: string[][] }).comparisons ?? [];
    const pairs = comparisons.flatMap(group => group.flatMap((a, i) => group.slice(i + 1).map(b => [a, b])));
    const completed = readCompletedCases(config.output.path, config.inputs.versions.map(version => version.id), pairs);
    const claimed = new Set<string>(), blocked = new Set<string>(), unlocks: (() => Promise<void>)[] = [];
    const skipped = new Set<string>();
    async function add(catalog: Candidate[], tasks: PlannedTask[], selected?: string[]) {
      const existing = await completed;
      const all = new Map([...state.manifest.tasks, ...tasks].map(task => [task.id, task]));
      const done = (task: PlannedTask) => {
        if (state.receipts[task.id]) return false;
        const candidates = businessCandidates(task, state, all);
        return !!candidates.length && candidates.every(candidate =>
          [candidate.case_id, candidate.session_id].some(id => id && existing.has(completedCaseKey(task.stage,
            candidates.map(value => value.version), candidate.batch_id, id))));
      };
      const compared = new Set(tasks.filter(task => task.stage === "comparison").flatMap(task =>
        businessCandidates(task, state, all).map(candidate => candidate.input_id)));
      const keep = new Set<string>();
      const visit = (id: string) => {
        if (keep.has(id)) return;
        keep.add(id);
        const task = all.get(id);
        if (task) Object.values(task.dependencies).forEach(visit);
      };
      const terminalStages = new Set(["comparison", "attribution-session"]);
      for (const task of tasks) {
        if (task.stage === "comparison" || task.stage === "attribution-session" &&
            !businessCandidates(task, state, all).some(candidate => compared.has(candidate.input_id))) {
          if (!done(task)) visit(task.id);
          else skipped.add(completedCaseKey(task.stage, businessCandidates(task, state, all).map(value => value.version),
            businessCandidates(task, state, all)[0]!.batch_id, businessCandidates(task, state, all)[0]!.case_id));
        } else if (!terminalStages.has(task.stage) && !task.stage.startsWith("attribution-") &&
            !["criteria", "rewrite", "instruction-review"].includes(task.stage)) visit(task.id);
      }
      // Explicit maintenance scopes and accepted in-run receipts retain their work and provenance.
      for (const id of selected ?? []) visit(id);
      for (const task of tasks) if (state.receipts[task.id]) visit(task.id);
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of tasks) if (task.stage === "rewrite" && !keep.has(task.id) &&
            Object.values(task.dependencies).some(id => keep.has(id))) { visit(task.id); changed = true; }
      }
      const removed = new Set(tasks.filter(task => !keep.has(task.id)).map(task => task.id));
      tasks.splice(0, tasks.length, ...tasks.filter(task => !removed.has(task.id)));
      for (const id of removed) { delete state.manifest.states[id]; delete state.receipts[id]; }
      if (state.manifest.executionScope) state.manifest.executionScope = state.manifest.executionScope.filter(id => !removed.has(id));
      const needed = new Set(tasks.flatMap(task => businessCandidates(task, state, all).map(candidate => candidate.input_id)));
      for (const candidate of catalog) if (!needed.has(candidate.input_id)) candidate.released = true;
      state.manifest.preflight.skipped_cases = skipped.size;
      // Locks prevent simultaneous writers; they are unrelated to completed-case matching.
      const partitions = catalog.filter(candidate => needed.has(candidate.input_id)).map(candidate => ({ date: businessBatch(candidate.batch_id), model: candidate.version }))
        .filter(value => !claimed.has(canonical([value.date, value.model])));
      if (partitions.length) {
        const held = await claimBusinessPartitions(config.output.path, partitions); unlocks.push(held.close);
        for (const value of partitions) claimed.add(canonical([value.date, value.model]));
        for (const key of held.blocked) blocked.add(key);
      }
      for (const task of tasks) {
        const previous = state.manifest.states[task.id];
        if (businessCandidates(task, state, all).some(candidate => blocked.has(canonical([candidate.batch_id, candidate.version]))))
          state.manifest.states[task.id] = { ...previous, status: "blocked", attempts: previous?.attempts ?? 0,
            admissionBlock: "该业务批次与模型正在被另一任务写入，请暂停后继续" };
        else if (previous?.admissionBlock) {
          if (previous.reason === previous.admissionBlock) delete previous.reason;
          delete previous.admissionBlock;
          if (previous.status === "blocked") previous.status = "pending";
        }
      }
    }
    return { add, close: async () => { for (const unlock of unlocks.reverse()) await unlock(); } };
  }
  const preparations = new Map<string, ReturnType<typeof preparation>>();
  return {
    ...repository,
    async prepareRun(run, state, _inputs, selectedTaskIds) {
      const config = state.manifest.config as EvaluationConfig;
      if (config.output.layout !== "business") return async () => {};
      const prepared = preparation(state); preparations.set(run, prepared);
      try { await prepared.add(state.manifest.inputCatalog as Candidate[] ?? [], state.manifest.tasks, selectedTaskIds); }
      catch (error) { await prepared.close(); preparations.delete(run); throw error; }
      return async () => { await prepared.close(); preparations.delete(run); };
    },
    async prepareShard(run, _state, _inputs, catalog, tasks) {
      const prepared = preparations.get(run);
      if (prepared) await prepared.add(catalog as Candidate[], tasks);
    },
    createResultWriter(run, inputs) {
      const write = repository.createResultWriter(run, inputs), seen = new Map<string, JsonObject>();
      let publisher: ReturnType<typeof createBusinessPublisher> | undefined;
      let delivered: Set<string> | undefined, planned: Map<string, PlannedTask> | undefined;
      let existingFinal: Set<string> | undefined;
      return async state => {
        await write(state);
        const config = state.manifest.config as EvaluationConfig;
        if (config.output.layout !== "business" || !Object.keys(state.receipts).length) return;
        const pairs = ((config as EvaluationConfig & { comparisons?: string[][] }).comparisons ?? [])
          .flatMap(group => group.flatMap((a, i) => group.slice(i + 1).map(b => [a, b])));
        existingFinal ??= await readCompletedCases(config.output.path, config.inputs.versions.map(version => version.id), pairs);
        publisher ??= createBusinessPublisher(config.output.path);
        // The journal tracks accepted verdicts; a later rewrite can still update their
        // presentation without changing the accepted verdict or its source identity.
        delivered ??= new Set((await readBusinessResults(config.output.path))
          .filter(record => record.published).map(record => record.submissionId));
        // Accepted receipts are far fewer than planned tasks; rescanning a six-figure
        // manifest on every flush would starve dispatch on the largest runs.
        if (!planned || planned.size !== state.manifest.tasks.length)
          planned = new Map(state.manifest.tasks.map(task => [task.id, task]));
        const presentations = new Map<string, { row: JsonObject; acceptedAt: number }>();
        for (const receipt of Object.values(state.receipts)) {
          const task = planned.get(receipt.taskId), row = receipt.exported?.row;
          if (task?.stage !== "rewrite" || row?.evaluation_type !== "group_model_comparison") continue;
          const source = (task.data as BusinessTaskData).rewriteOf?.taskId;
          if (source && (!presentations.has(source) || presentations.get(source)!.acceptedAt < receipt.acceptedAt))
            presentations.set(source, { row, acceptedAt: receipt.acceptedAt });
        }
        const entries: BusinessPublication[] = [], accepted: [string, JsonObject][] = [];
        for (const [taskId, receipt] of Object.entries(state.receipts)) {
          const row = presentations.get(taskId)?.row ?? receipt.exported?.row, task = planned.get(taskId);
          if (!row || !task || seen.get(task.id) === row || task.stage === "rewrite") continue;
          if (delivered.has(receipt.submissionId) && !(task.stage === "comparison" && row.rewritten)) {
            seen.set(task.id, row); continue;
          }
          const record = await describe(run, state, task, planned);
          if (record) {
            if (!delivered.has(receipt.submissionId) && record.answers.some(answer => existingFinal!.has(
              completedCaseKey(task.stage, record.answers.map(value => value.model), answer.batch, answer.caseId)))) {
              seen.set(task.id, row); continue;
            }
            entries.push({ record, row, refresh: seen.has(task.id) || delivered.has(receipt.submissionId) });
            accepted.push([task.id, row]);
          } else seen.set(task.id, row);
        }
        await publisher.many(entries);
        for (const [id, row] of accepted) seen.set(id, row);
      };
    },
  };
}
