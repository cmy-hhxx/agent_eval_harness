import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonical, errorText, type JsonObject, type PlannedTask, type RunRepository, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { businessDate, businessRunDirectories, claimBusinessPartitions, createBusinessPublisher, fileSourceReader,
  formalAttributionFiles, formalResultLine, organizedResultLines, readBusinessResults, readJsonl,
  sourcePredatesAcceptance, type BusinessPublication, type BusinessResult } from "@eval/data";
import { answerBusinessKey, businessAnswer, businessCandidates, businessDestination, businessResultKey,
  businessScope, completeBusinessResult, sameBusinessMaterial } from "./business-results.js";
import { loadRunInputs } from "../inputs/load.js";
import type { Candidate, EvaluationConfig } from "../inputs/types.js";

const reusable = new Set(["criteria", "attribution-compact", "attribution-session", "comparison"]);
type BusinessTaskData = { comparisonId?: string; attributionIdentity?: string; rewriteOf?: { taskId: string } };
function prefer(first: BusinessResult | undefined, next: BusinessResult) {
  return !first || next.complete && !first.complete || next.complete === first.complete &&
    (next.acceptedAt > first.acceptedAt || next.acceptedAt === first.acceptedAt && next.published &&
      (!first.published || next.submissionId === first.submissionId));
}

/** Assemble current workflow definitions with shared formal-result publication and admission. */
export function businessResultRepository(repository: RunRepository, adapters: {
  readSource(run: string, ids: string[]): Promise<RunState>;
  evaluation(task: PlannedTask, row: JsonObject): unknown;
}): RunRepository {
  const origins = new Map<string, BusinessResult>();
  async function describe(run: string, state: RunState, task: PlannedTask): Promise<Omit<BusinessResult, "line" | "published"> | undefined> {
    const receipt = state.receipts[task.id], reference = receipt?.exported;
    if (!reference || task.stage === "rewrite") return;
    const original = origins.get(task.id);
    const candidates = businessCandidates(task, state), answers = candidates.map(businessAnswer);
    const target = businessDestination(task, state, reference.file!);
    const scope = businessScope(task);
    return { ...target, id: businessResultKey(task.stage, answers, scope), stage: task.stage, scope, answers,
      acceptedAt: receipt.acceptedAt, evaluatorVersion: receipt.evaluatorVersion, judge: receipt.judge,
      submissionId: receipt.submissionId,
      complete: completeBusinessResult(task, state), origin: original?.origin ?? {
        run, taskId: task.id, reference: { id: reference.id, file: reference.file,
          line: reference.line ?? await formalResultLine(run, reference, reference.row) },
      } };
  }
  /** Formal-result reuse, partition claims and admission survive across streamed shards. */
  function createPreparation(run: string, state: RunState) {
    const config = state.manifest.config as EvaluationConfig;
    const delivery = config.output.layout === "business", root = config.output.path;
    const issues = (state.manifest.preflight.issues ??= []) as JsonObject[];
    const sourceStates = new Map<string, RunState>([[run, state]]);
    const organization = new Map<string, Awaited<ReturnType<typeof organizedResultLines>>>();
    const checkedSources = new Set<string>();
    const sourceInputs = new Map<string, Record<string, unknown>>();
    const claimed = new Set<string>(), unlocks: (() => Promise<void>)[] = [];
    const records: BusinessResult[] = [], latest = new Map<string, BusinessResult>();
    let publish: ReturnType<typeof createBusinessPublisher> | undefined;
    /** Delivery ledger and registered source runs are read once, shared by every shard. */
    const ready = async () => {
      if (publish) return;
      publish = createBusinessPublisher(root);
      records.push(...await readBusinessResults(root));
      // Registered ledgers plus the runs that delivered into this root; never a scan of result files.
      for (const sourceRun of new Set([...await businessRunDirectories(root), ...config.output.receiptSources ?? []])) {
        if (sourceRun === run) continue;
        try {
          const metadata = await adapters.readSource(sourceRun, []);
          const ids = metadata.manifest.tasks.filter(task => reusable.has(task.stage) &&
            metadata.manifest.states[task.id]?.status === "succeeded").map(task => task.id);
          if (!ids.length) continue;
          const saved = await adapters.readSource(sourceRun, ids);
          sourceStates.set(sourceRun, saved);
          organization.set(sourceRun, await organizedResultLines(sourceRun));
          checkedSources.add(path.join(sourceRun, "results", "attribution.jsonl"));
          for (const task of saved.manifest.tasks) {
            if (!saved.receipts[task.id]?.exported) continue;
            const record = await describe(sourceRun, saved, task);
            if (record) records.push({ ...record, line: 1, published: false });
          }
        } catch (error) {
          issues.push({ reason: "formal_source_unverifiable", source: sourceRun, message: errorText(error) });
        }
      }
      for (const record of records) if (prefer(latest.get(record.id), record)) latest.set(record.id, record);
    };
    async function add(catalog: Candidate[], tasks: PlannedTask[], inputs: Record<string, unknown>, selectedTaskIds?: string[]) {
      sourceInputs.set(run, inputs);
      await ready();
      const blocks = new Map<string, string>();
      for (const candidate of catalog) {
        try { businessDate(candidate.batch_id); }
        catch (error) { blocks.set(candidate.input_id, errorText(error)); }
      }
      const partitions = catalog.filter(candidate => !blocks.has(candidate.input_id))
        .map(candidate => ({ date: candidate.batch_id, model: candidate.version }))
        .filter(value => !claimed.has(canonical([value.date, value.model])));
      if (partitions.length) {
        const held = await claimBusinessPartitions(root, partitions);
        unlocks.push(held.close);
        for (const value of partitions) claimed.add(canonical([value.date, value.model]));
        for (const candidate of catalog) if (held.blocked.has(canonical([candidate.batch_id, candidate.version])))
          blocks.set(candidate.input_id, "业务日期与模型分区正由另一评测运行持有，暂缓派发");
      }
      {
        const requested = new Map(catalog.map(candidate => [answerBusinessKey(businessAnswer(candidate)), candidate]));
        // Ledger rows are verified from the run that accepted them, never by scanning a root.
        const pending = new Map<string, Set<string>>();
        for (const record of records) {
          if (record.origin.run === run || !record.answers.some(answer => requested.has(answerBusinessKey(answer)))) continue;
          if (sourceStates.get(record.origin.run)?.receipts[record.origin.taskId]) continue;
          const ids = pending.get(record.origin.run) ?? new Set<string>();
          ids.add(record.origin.taskId); pending.set(record.origin.run, ids);
        }
        for (const [sourceRun, ids] of pending) {
          try {
            const saved = await adapters.readSource(sourceRun, [...ids]), merged = sourceStates.get(sourceRun);
            if (!merged) {
              sourceStates.set(sourceRun, saved);
              organization.set(sourceRun, await organizedResultLines(sourceRun));
            } else {
              merged.manifest.tasks.push(...saved.manifest.tasks);
              Object.assign(merged.manifest.states, saved.manifest.states);
              Object.assign(merged.receipts, saved.receipts);
              const known = new Map((merged.manifest.inputCatalog as Candidate[]).map(candidate => [candidate.input_id, candidate]));
              for (const candidate of saved.manifest.inputCatalog as Candidate[]) known.set(candidate.input_id, candidate);
              merged.manifest.inputCatalog = [...known.values()];
            }
            checkedSources.add(path.join(sourceRun, "results", "attribution.jsonl"));
          } catch (error) {
            issues.push({ reason: "formal_source_unverifiable", source: sourceRun, message: errorText(error) });
          }
        }
        const unique = new Map<string, BusinessResult>();
        for (const record of records) {
          const key = canonical([record.origin, record.id]);
          if (prefer(unique.get(key), record)) unique.set(key, record);
        }
        const sourceIds = new Map<string, Set<string>>();
        for (const record of unique.values()) if (record.answers.some(answer => requested.has(answerBusinessKey(answer)))) {
          const ids = sourceIds.get(record.origin.run) ?? new Set<string>();
          ids.add(record.origin.taskId); sourceIds.set(record.origin.run, ids);
        }
        for (const [sourceRun, ids] of sourceIds) {
          const source = sourceStates.get(sourceRun);
          if (!source) continue;
          let bound = sourceInputs.get(sourceRun);
          if (!bound) sourceInputs.set(sourceRun, bound = {});
          const tasks = source.manifest.tasks.filter(task => ids.has(task.id));
          const needed = new Set(tasks.flatMap(task => businessCandidates(task, source).map(candidate => candidate.input_id)));
          const missing = new Set([...needed].filter(id => !Object.hasOwn(bound, id)));
          if (!missing.size) continue;
          try {
            const loaded = await loadRunInputs({ ...source.manifest, tasks,
              inputCatalog: (source.manifest.inputCatalog as Candidate[]).filter(candidate => missing.has(candidate.input_id)) });
            Object.defineProperties(bound, Object.getOwnPropertyDescriptors(loaded));
          }
          catch (error) { issues.push({ reason: "formal_input_unverifiable", source: sourceRun, message: errorText(error) }); }
        }
        const byAnswer = new Map<string, BusinessResult[]>();
        for (const record of unique.values()) for (const answer of record.answers) {
          const key = answerBusinessKey(answer), rows = byAnswer.get(key) ?? [];
          rows.push(record); byAnswer.set(key, rows);
        }
        const matches = new Map<string, BusinessResult[]>();
        for (const candidate of catalog) {
          if (blocks.has(candidate.input_id)) continue;
          const possible = byAnswer.get(answerBusinessKey(businessAnswer(candidate))) ?? [];
          const matching: BusinessResult[] = [];
          for (const record of possible) {
            const answer = record.answers.find(value => answerBusinessKey(value) === answerBusinessKey(businessAnswer(candidate)))!;
            try {
              const source = sourceStates.get(record.origin.run);
              if (!source || !sourceInputs.has(record.origin.run)) throw new Error("来源收据或原始输入不可读取");
              const original = (source.manifest.inputCatalog as Candidate[]).find(value =>
                answerBusinessKey(businessAnswer(value)) === answerBusinessKey(answer));
              if (!original) throw new Error("来源收据缺少对应的被评回答");
              if (answer.revision ? await fileSourceReader.revision(answer.source) !== answer.revision
                : !await sourcePredatesAcceptance(answer.source, record.acceptedAt))
                throw new Error("来源输入在接受结果后发生变化，无法确认原回答");
              const originalInputs = sourceInputs.get(record.origin.run)!;
              if (!isDeepStrictEqual(originalInputs[original.input_id], inputs[candidate.input_id])) continue;
              matching.push(record);
            } catch (error) {
              blocks.set(candidate.input_id, "正式结果来源无法核实：" + errorText(error));
            }
          }
          if (matching.length) {
            matching.sort((a, b) => Number(b.published) - Number(a.published) || a.acceptedAt - b.acceptedAt || a.id.localeCompare(b.id));
            candidate.answer_id = matching[0].answers.find(answer => answerBusinessKey(answer) === answerBusinessKey(businessAnswer(candidate)))!.id;
            blocks.delete(candidate.input_id); matches.set(candidate.input_id, matching);
          }
        }
        // Exact original bodies and receipts have matched. Fresh work uses that persistent
        // source UUID so reused compact references and new trace/comparison references agree.
        // Never change a source namespace after this run has already accepted work in it.
        const identities = new Map(catalog.flatMap(candidate => candidate.answer_id && candidate.answer_id !== candidate.input_id &&
          ![...state.manifest.tasks, ...tasks].some(task => state.receipts[task.id] && Object.values(task.inputIds).includes(candidate.input_id))
          ? [[candidate.input_id, candidate.answer_id] as const] : []));
        for (const [previous, retained] of identities) {
          if (Object.hasOwn(inputs, retained)) throw new Error("已核实原始来源 UUID 冲突");
          Object.defineProperty(inputs, retained, Object.getOwnPropertyDescriptor(inputs, previous)!);
          delete inputs[previous];
          const input = state.manifest.inputs[previous];
          state.manifest.inputs[retained] = { ...input, id: retained, name: retained };
          delete state.manifest.inputs[previous];
          for (const map of [matches, blocks] as const) {
            if (!map.has(previous)) continue;
            if (map === matches) matches.set(retained, matches.get(previous)!);
            else blocks.set(retained, blocks.get(previous)!);
            map.delete(previous);
          }
        }
        const retain = (candidate: Candidate) => { candidate.input_id = identities.get(candidate.input_id) ?? candidate.input_id; };
        catalog.forEach(retain);
        for (const task of tasks) {
          task.inputIds = Object.fromEntries(Object.entries(task.inputIds).map(([label, id]) => [label, identities.get(id) ?? id]));
          businessCandidates(task, state).forEach(retain);
        }
        // Different run UUIDs converge only after the original input bodies have matched.
        const verified: BusinessResult[] = [];
        for (const record of unique.values()) {
          if (!record.answers.length || record.answers.some(answer => {
            const candidate = requested.get(answerBusinessKey(answer));
            return !candidate || !matches.get(candidate.input_id)?.includes(record);
          })) continue;
          const answers = record.answers.map(answer => ({ ...answer, id: requested.get(answerBusinessKey(answer))!.answer_id! }));
          const updated = { ...record, answers, id: businessResultKey(record.stage, answers, record.scope) };
          const source = sourceStates.get(record.origin.run)!, receipt = source.receipts[record.origin.taskId];
          if (!receipt?.exported) continue;
          if (!delivery) { verified.push({ ...updated, published: true }); continue; }
          try {
            const map = organization.get(record.origin.run);
            const line = map?.get(canonical([record.origin.reference.file, record.origin.reference.line]))?.get(updated.file);
            await publish!(updated, receipt.exported.row, false, line);
            // The delivery is durable; later shards may reuse this verdict in the same run.
            const published = { ...updated, line: 0, published: true };
            if (prefer(latest.get(published.id), published)) latest.set(published.id, published);
          }
          catch (error) {
            for (const answer of record.answers) blocks.set(requested.get(answerBusinessKey(answer))!.input_id, errorText(error));
          }
        }
        for (const record of verified) if (prefer(latest.get(record.id), record)) latest.set(record.id, record);
        // A bare historical row is not proof of the evaluated model or a complete evaluation.
        const confirmed = new Set(matches.keys());
        const bareIdentities = new Map<string, Candidate[]>();
        for (const candidate of catalog) if (!confirmed.has(candidate.input_id)) {
          const answer = businessAnswer(candidate), key = canonical([answer.session ?? candidate.case_id, answer.traces]);
          const selected = bareIdentities.get(key) ?? []; selected.push(candidate); bareIdentities.set(key, selected);
        }
        for (const file of bareIdentities.size ? await formalAttributionFiles(root, config.inputs.versions.map(version => version.id)) : []) {
          if (checkedSources.has(file) || file === path.join(run, "results", "attribution.jsonl")) continue;
          for await (const value of readJsonl(file)) {
            const row = value as { session_meta?: { session_id?: string; case_id?: string }; turns?: { meta?: { trace_id?: string } }[] };
            if (!row.session_meta || !row.turns) continue;
            const session = row.session_meta.session_id ?? row.session_meta.case_id ?? null;
            const traces = row.turns.map(turn => turn.meta?.trace_id ?? null);
            for (const candidate of bareIdentities.get(canonical([session, traces])) ?? [])
              blocks.set(candidate.input_id, "已有正式归因行缺少可核实的模型、原回答或完整成功收据：" + file);
          }
        }
        const replacements = new Map<string, string>(), reused = new Set<string>();
        for (const task of tasks) {
          const status = (state.manifest.states[task.id] ??= { status: "pending", attempts: 0 });
          delete status.admissionBlock;
          if (config.output.reuseCompleted === false || state.receipts[task.id] || !reusable.has(task.stage)) continue;
          const candidates = businessCandidates(task, state);
          if (!candidates.length || candidates.some(candidate => blocks.has(candidate.input_id))) continue;
          const scope = businessScope(task), key = businessResultKey(task.stage, candidates.map(businessAnswer), scope);
          const record = latest.get(key);
          if (!record?.complete || !record.published) continue;
          const source = sourceStates.get(record.origin.run) ?? await adapters.readSource(record.origin.run, [record.origin.taskId]);
          const originalTask = source.manifest.tasks.find(item => item.id === record.origin.taskId)!;
          if (!sameBusinessMaterial(task, originalTask)) continue;
          const original = source.receipts[originalTask.id];
          if (!original?.exported || original.incompleteDependencies?.length) continue;
          const id = originalTask.id;
          if ([...state.manifest.tasks, ...tasks].some(item => item.id === id && item !== task)) throw new Error("复用任务身份冲突");
          replacements.set(task.id, id);
          const evaluation = structuredClone(task.stage === "attribution-session" ? original.exported.row
            : adapters.evaluation(task, original.exported.row));
          if (task.stage === "criteria") {
            const names = new Map(businessCandidates(originalTask, source).map(candidate => [candidate.input_id, candidate.version]));
            const ids = new Map(candidates.map(candidate => [candidate.version, candidate.input_id]));
            for (const group of ["requirements", "scoring_points", "red_flags"])
              for (const item of (evaluation as Record<string, { applies_to: string[] }[]>)[group])
                item.applies_to = item.applies_to.map(value => ids.get(names.get(value)!) ?? value);
          }
          if (task.stage === "comparison") (task.data as BusinessTaskData).comparisonId = (originalTask.data as BusinessTaskData).comparisonId;
          const receipt: SubmissionReceipt = { ...original, taskId: id, evaluation,
            reusedFrom: original.reusedFrom ?? { run: record.origin.run, taskId: originalTask.id },
            exported: { ...original.exported, id: task.stage === "attribution-session" ? id : original.exported.id } };
          delete receipt.submitted;
          state.receipts[id] = receipt;
          state.manifest.states[id] = { ...status, status: "succeeded", attempts: 0 };
          if (id !== task.id) delete state.manifest.states[task.id];
          task.id = id; reused.add(id); origins.set(id, record);
        }
        // A reused comparison must retain the actual Criteria/Attribution receipts that
        // established its finding indices, even when a newer attribution is delivered.
        const originRecords = new Map([...unique.values()].map(record => [canonical([record.origin.run, record.origin.taskId]), record]));
        const tasksById = new Map([...state.manifest.tasks, ...tasks].map(task => [task.id, task]));
        const additional: PlannedTask[] = [];
        for (const comparison of tasks.filter(task => task.stage === "comparison" && reused.has(task.id))) {
          const origin = origins.get(comparison.id)!, source = sourceStates.get(origin.origin.run)!;
          const original = source.manifest.tasks.find(task => task.id === origin.origin.taskId)!;
          const sourceTasks = new Map(source.manifest.tasks.map(task => [task.id, task]));
          const ensure = (id: string): string => {
            if (state.receipts[id] && tasksById.has(id)) return id;
            const task = sourceTasks.get(id), receipt = source.receipts[id];
            if (!task || !receipt?.exported || !reusable.has(task.stage) || !completeBusinessResult(task, source))
              throw new Error("已复用对局缺少完整的原始依赖收据：" + id);
            const candidates = businessCandidates(task, source);
            const mapped = new Map(candidates.map(candidate => {
              const current = requested.get(answerBusinessKey(businessAnswer(candidate)));
              if (!current || !matches.get(current.input_id)?.some(record => record.origin.run === origin.origin.run && record.origin.taskId === id))
                throw new Error("已复用对局的原始评测材料无法核实：" + id);
              return [candidate.input_id, current];
            }));
            const restored = structuredClone(task), data = restored.data as Record<string, unknown>;
            if (data.candidate) data.candidate = mapped.get((data.candidate as Candidate).input_id);
            if (data.candidates) data.candidates = Object.fromEntries(Object.entries(data.candidates as Record<string, Candidate>)
              .map(([label, candidate]) => [label, mapped.get(candidate.input_id)!]));
            restored.inputIds = Object.fromEntries(Object.entries(restored.inputIds).map(([label, inputId]) => {
              const current = mapped.get(inputId);
              if (!current) throw new Error("原始依赖缺少回答坐标：" + id);
              return [label, current.input_id];
            }));
            restored.dependencies = Object.fromEntries(Object.entries(restored.dependencies)
              .filter(([, dependency]) => reusable.has(sourceTasks.get(dependency)?.stage ?? ""))
              .map(([label, dependency]) => [label, ensure(dependency)]));
            const evaluation = structuredClone(task.stage === "attribution-session" ? receipt.exported.row
              : adapters.evaluation(restored, receipt.exported.row));
            if (task.stage === "criteria") for (const group of ["requirements", "scoring_points", "red_flags"])
              for (const item of (evaluation as Record<string, { applies_to: string[] }[]>)[group])
                item.applies_to = item.applies_to.map(value => mapped.get(value)?.input_id ?? value);
            state.receipts[id] = { ...receipt, evaluation, reusedFrom: receipt.reusedFrom ?? { run: origin.origin.run, taskId: id },
              exported: { ...receipt.exported, id: task.stage === "attribution-session" ? id : receipt.exported.id } };
            state.manifest.states[id] = { status: "succeeded", attempts: 0 };
            const record = originRecords.get(canonical([origin.origin.run, id]));
            if (record) origins.set(id, record);
            tasksById.set(id, restored); additional.push(restored); return id;
          };
          try {
            const oldCandidates = (original.data as { candidates: Record<string, Candidate> }).candidates;
            const candidates = (comparison.data as { candidates: Record<string, Candidate> }).candidates;
            comparison.dependencies = Object.fromEntries(Object.entries(original.dependencies).map(([label, id]) => {
              const currentLabel = oldCandidates[label] ? Object.keys(candidates).find(key => candidates[key].version === oldCandidates[label].version)! : label;
              return [currentLabel, ensure(id)];
            }));
          } catch (error) {
            delete state.receipts[comparison.id];
            state.manifest.states[comparison.id] = { status: "blocked", attempts: 0, admissionBlock: errorText(error) };
          }
        }
        tasks.push(...additional);
        const removed = new Set<string>();
        const reusedAttributions = [...state.manifest.tasks, ...tasks].filter(task => task.stage === "attribution-session" && reused.has(task.id));
        for (const task of tasks) {
          task.dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, replacements.get(id) ?? id]));
          const data = task.data as BusinessTaskData;
          if (data.attributionIdentity) data.attributionIdentity = replacements.get(data.attributionIdentity) ?? data.attributionIdentity;
          if (data.rewriteOf) data.rewriteOf.taskId = replacements.get(data.rewriteOf.taskId) ?? data.rewriteOf.taskId;
        }
        for (const task of tasks) {
          const data = task.data as BusinessTaskData;
          const compactId = (task.data as Record<string, unknown>).compactTaskId;
          if (task.stage === "attribution-compact-field" && typeof compactId === "string" &&
            reused.has(replacements.get(compactId) ?? compactId)) removed.add(task.id);
          if (["attribution-component", "attribution-trace"].includes(task.stage) && reusedAttributions.some(source =>
            businessCandidates(source, state)[0]?.input_id === businessCandidates(task, state)[0]?.input_id &&
            (source.data as Record<string, unknown>).attributionIdentity === data.attributionIdentity)) removed.add(task.id);
          if (task.stage === "rewrite" && data.rewriteOf && reused.has(data.rewriteOf.taskId)) removed.add(task.id);
        }
        if (removed.size) {
          const kept = tasks.filter(task => !removed.has(task.id));
          tasks.length = 0;
          tasks.push(...kept);
          state.manifest.tasks = state.manifest.tasks.filter(task => !removed.has(task.id));
        }
        for (const task of tasks) {
          task.dependencies = Object.fromEntries(Object.entries(task.dependencies).filter(([, id]) => !removed.has(id)));
          const reasons = businessCandidates(task, state).flatMap(candidate => blocks.get(candidate.input_id) ?? []);
          if (reasons.length && !state.receipts[task.id])
            (state.manifest.states[task.id] ??= { status: "pending", attempts: 0 }).admissionBlock = reasons.join("；");
        }
        for (const id of removed) { delete state.manifest.states[id]; delete state.receipts[id]; }
        if (selectedTaskIds) {
          const retained = new Set([...state.manifest.tasks, ...tasks].map(task => task.id));
          const remap = (ids: string[]) => ids.map(id => replacements.get(id) ?? id).filter(id => retained.has(id));
          if (state.manifest.executionScope) state.manifest.executionScope = remap(state.manifest.executionScope);
          selectedTaskIds.splice(0, selectedTaskIds.length, ...remap(selectedTaskIds));
        }
        for (const [id, reason] of blocks) issues.push({ reason: "formal_result_admission_blocked", input_id: id, message: reason });
        state.manifest.preflight.reused_results = Object.values(state.receipts).filter(receipt => receipt.reusedFrom).length;
      }
    }
    return { add, close: async () => { for (const unlock of unlocks.reverse()) await unlock(); } };
  }
  const preparations = new Map<string, ReturnType<typeof createPreparation>>();
  return {
    ...repository,
    async prepareRun(run, state, inputs, selectedTaskIds) {
      const config = state.manifest.config as EvaluationConfig;
      if (config.output.layout !== "business" && config.output.reuseCompleted === false) return async () => {};
      const prepared = createPreparation(run, state);
      preparations.set(run, prepared);
      await prepared.add(state.manifest.inputCatalog as Candidate[], state.manifest.tasks, inputs, selectedTaskIds);
      return prepared.close;
    },
    async prepareShard(run, state, inputs, catalog, tasks) {
      const config = state.manifest.config as EvaluationConfig;
      if (config.output.layout !== "business" && config.output.reuseCompleted === false) return;
      const prepared = preparations.get(run) ?? createPreparation(run, state);
      preparations.set(run, prepared);
      await prepared.add(catalog as Candidate[], tasks, inputs);
    },
    createResultWriter(run, inputs) {
      const write = repository.createResultWriter(run, inputs), seen = new Map<string, JsonObject>();
      let publisher: ReturnType<typeof createBusinessPublisher> | undefined;
      let delivered: Set<string> | undefined, planned: Map<string, PlannedTask> | undefined;
      return async state => {
        await write(state);
        const config = state.manifest.config as EvaluationConfig;
        if (config.output.layout !== "business") return;
        publisher ??= createBusinessPublisher(config.output.path);
        // A fresh process sees every committed receipt again. The provenance journal
        // already records which accepted submissions reached a delivery file, so only
        // unseen or newer verdicts need the serialized delivery lock.
        delivered ??= new Set((await readBusinessResults(config.output.path))
          .filter(record => record.published).map(record => record.submissionId));
        // Accepted receipts are far fewer than planned tasks; rescanning a six-figure
        // manifest on every flush would starve dispatch on the largest runs.
        if (!planned || planned.size !== state.manifest.tasks.length)
          planned = new Map(state.manifest.tasks.map(task => [task.id, task]));
        const entries: BusinessPublication[] = [], accepted: [string, JsonObject][] = [];
        for (const [taskId, receipt] of Object.entries(state.receipts)) {
          const row = receipt.exported?.row, task = planned.get(taskId);
          if (!row || !task || seen.get(task.id) === row || task.stage === "rewrite") continue;
          if (delivered.has(receipt.submissionId)) { seen.set(task.id, row); continue; }
          const record = await describe(run, state, task);
          if (record) {
            entries.push({ record, row, refresh: seen.has(task.id) });
            accepted.push([task.id, row]);
          } else seen.set(task.id, row);
        }
        await publisher.many(entries);
        for (const [id, row] of accepted) seen.set(id, row);
      };
    },
  };
}
