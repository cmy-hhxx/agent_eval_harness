import { collectInputs } from "../inputs/scan.js";
import { attributionDimension } from "../review/dimensions.js";
import { candidateKey } from "../inputs/records.js";
import { problemLibraryFile, readProblemLibrary } from "@eval/data";
import { randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type PlannedTask, type ProblemLibrary, type TaskPlan } from "@eval/contracts";
import { canonical } from "@eval/contracts";
import { emptyLibrary, projectLibrary } from "@eval/agents/clustering";
import { attributionRewritePlaceholder } from "./attribution-rewrite-planning.js";
import { predictionKey, predictionMaterial, readPredictionAnswers } from "./prediction.js";
import type { BatchPreflight, EvalConfig, TaskData } from "./types.js";
import type { Candidate } from "../inputs/types.js";
import { planAttributionUnit, type AttributionTaskData } from "@eval/workflows/attribution";

const normalize = (text: string) => text.replace(/\s+/gu, "");
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
/** Business identity for any task, including rewrite tasks that own no input. */
export function taskCase(data: TaskData): { batch_id: string; case_id: string } {
  return data.case ?? { batch_id: data.candidates.A.batch_id, case_id: data.candidates.A.case_id };
}
function taskKey(task: PlannedTask): string {
  const data = task.data as TaskData;
  if (attributionDimension(task.stage)) return canonical([task.stage, task.dependencies.source]);
  if (task.stage.startsWith("attribution-")) {
    const attribution = task.data as AttributionTaskData;
    return canonical(["attribution-unit", attribution.candidate.input_id, task.stage,
      attribution.traceIndex ?? null, attribution.component ?? null, data.criteriaScope ?? null]);
  }
  const comparisonRole = data.verificationAudit ? "audit" : "standalone";
  if (data.reviewOf) return canonical(["review", data.reviewOf.taskId, task.stage, data.group ?? Object.values(data.candidates).map((c) => c.version)]);
  if (data.stage === "criteria") return canonical(["criteria", data.criteriaScope]);
  if (data.stage === "clustering")
    return canonical([data.scope!.batch_id, "clustering", data.scope!.version, data.scope!.shard]);
  if (data.rewriteScope)
    return canonical([data.rewriteScope.batch_id, "rewrite", data.rewriteOf!.taskId]);
  const c = taskCase(data);
  const selector =
    data.stage === "rewrite"
      ? ["rewrite", data.rewriteOf!.taskId]
      : data.group ? [...data.group].sort() : [data.candidates.A.version];
  return canonical([c.batch_id, c.case_id, task.stage, selector, ...(data.stage === "comparison" ? [comparisonRole] : [])]);
}
/** Batch identity for every stage, including clustering tasks that span cases. */
export function taskIdentity(data: TaskData): { batch_id: string; case_id: string | null } {
  if (data.scope) return { batch_id: data.scope.batch_id, case_id: null };
  if (data.rewriteScope) return { batch_id: data.rewriteScope.batch_id, case_id: null };
  const c = taskCase(data);
  return { batch_id: c.batch_id, case_id: c.case_id };
}
/** Prevent a comparison task from ranking answers of different declared size classes. */
export function assertComparableGroups(config: Pick<EvalConfig, "inputs" | "comparisons">): void {
  for (const version of config.inputs.versions)
    if (version.id.includes("__vs__")) throw new Error("输入版本 ID 不能包含对局保留分隔符 __vs__：" + version.id);
  const tiers = new Map(config.inputs.versions.map((version) => [version.id, version.comparison_tier]));
  for (const group of config.comparisons) {
    if (group.length < 2 || group.length > 3 || new Set(group).size !== group.length)
      throw new Error("对比组必须包含 2–3 个不同候选：" + group.join(" / "));
    const declared = new Set(group.map((id) => tiers.get(id)).filter((tier): tier is string => !!tier));
    if ((group.length === 3 || declared.size) && group.some((id) => !tiers.get(id)))
      throw new Error("对比组每个候选必须明确同档 comparison_tier：" + group.join(" / "));
    if (declared.size > 1)
      throw new Error(`对比组混合了不同模型规模（${[...declared].join(" / ")}）：${group.join(" / ")}`);
  }
}
/** Independent two-way tasks, deduplicated by the unordered business pair. */
export function expandComparisonPairs(groups: readonly (readonly string[])[]): string[][] {
  const pairs: string[][] = [], seen = new Set<string>();
  for (const group of groups) {
    if (group.length < 2 || group.length > 3 || new Set(group).size !== group.length)
      throw new Error("对比组必须包含 2–3 个不同候选：" + group.join(" / "));
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const pair = [group[i]!, group[j]!], key = canonical([...pair].sort());
      if (!seen.has(key)) { seen.add(key); pairs.push(pair); }
    }
  }
  return pairs;
}
/** Narrow configured groups without scheduling the same remaining model set twice. */
export function selectComparisonGroups(groups: readonly string[][], versionIds: readonly string[]): string[][] {
  const allowed = new Set(versionIds), seen = new Set<string>();
  const selected: string[][] = [];
  for (const group of groups) {
    const remaining = group.filter((id) => allowed.has(id));
    if (remaining.length < 2) continue;
    const key = canonical([...remaining].sort());
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(remaining);
  }
  return selected;
}

export interface PlanOptions {
  acceptedTaskIds?: ReadonlySet<string>;
  /** Skip raw input materialization when only task counts or summaries are needed. */
  materializeInputs?: boolean;
}
export async function buildPlan(
  config: EvalConfig,
  previous?: TaskPlan,
  options: PlanOptions = {},
): Promise<TaskPlan> {
  const accepted = options.acceptedTaskIds ?? new Set<string>();
  assertComparableGroups(config);
  const comparisonPairs = expandComparisonPairs(config.comparisons);
  const predictionAnswers = config.prediction ? await readPredictionAnswers(config.prediction.answersFile) : undefined;
  const predictionSelections = config.prediction?.selections ?? [];
  // Accepted formal pairs are immutable. Unfinished standalone tasks are replanned with their current UUIDs.
  const retainedPairs = new Set((previous?.tasks ?? []).filter(task => task.stage === "comparison" &&
    !(task.data as TaskData).verificationAudit &&
    accepted.has(task.id))
    .flatMap((task) => {
      const data = task.data as TaskData, identity = taskCase(data), group = data.group!;
      return group.flatMap((first, index) => group.slice(index + 1).map((second) =>
        canonical([identity.batch_id, identity.case_id, [first, second].sort()])));
    }));
  const oldTasks = new Map(previous?.tasks.map((task) => [taskKey(task), task]));
  const collected = await collectInputs(config, previous && { inputs: previous.inputs,
    catalog: previous.catalog as Candidate[] | undefined ?? previous.tasks.flatMap(task => Object.values((task.data as TaskData).candidates)) }, {
    materializeInputs: options.materializeInputs,
    ...(config.prediction ? {
      selectRecord: (batchId: string | null, caseId: string | null, version: string) =>
        predictionSelections.some(selection => selection.batchId === batchId && selection.caseId === caseId && selection.versions.includes(version)),
      prepareRecord: (record: Candidate) => {
        const selection = predictionSelections.find(item => item.batchId === record.batch_id && item.caseId === record.case_id)!;
        const answer = predictionAnswers!.get(predictionKey(selection.batchId, selection.questionId));
        if (!answer || answer.text !== record.question)
          throw new Error("Prediction question does not match original input: " + selection.questionId);
        record.reference = predictionMaterial(config.prediction!, selection, answer).reference;
      },
    } : {}),
  });
  const { catalog, inputs, cases: selected, issues, locations, sources: resolvedSources } = collected;
  const records = new Map(catalog.map(record => [candidateKey(record), record]));
  const skipped: unknown[] = [];
  // Read each model's problem library once; clustering tasks get its projection and budget headroom.
  const libraries = new Map<string, ProblemLibrary>();
  if (config.clustering.enabled)
    for (const version of config.inputs.versions) {
      const file = problemLibraryFile(config.problemLibrary, version.id);
      libraries.set(version.id, (await readProblemLibrary(file)) ?? emptyLibrary(version.id));
    }
  const tasks: PlannedTask[] = [],
    criteriaTasks = new Map<string, PlannedTask>(),
    checks = new Map<string, { tasks: PlannedTask[]; session: PlannedTask }>(),
    attributionTasks: PlannedTask[] = [],
    rewrites = new Map<string, PlannedTask[]>(),
    groupCounts: Record<string, number> = {};
  /** Reserve attribution's first group and preserve existing groups; rewrites own no input material. */
  function addRewrite(
    sourceStage: "attribution" | "comparison" | "clustering",
    sourceTaskId: string,
    resultId: string,
    context: Pick<TaskData, "case" | "rewriteScope">,
    revision: number,
    names: Record<string, string>,
  ) {
    if (!config.rewrite[sourceStage]) return;
    if (rewrites.has(sourceTaskId)) return;
    if (sourceStage === "attribution") {
      const existing = previous?.tasks.filter(task => task.stage === "rewrite" && (task.data as TaskData).rewriteOf?.taskId === sourceTaskId) ?? [];
      rewrites.set(sourceTaskId, (existing.length ? existing : [undefined]).map(prior => {
        const task = attributionRewritePlaceholder(sourceTaskId, { case: context.case, rewriteNames: names }, prior);
        (task.data as TaskData).revision = Math.max((prior?.data as TaskData | undefined)?.revision ?? 1, revision);
        return task;
      }));
      return;
    }
    const key = context.rewriteScope
      ? canonical([context.rewriteScope.batch_id, "rewrite", sourceTaskId])
      : canonical([context.case!.batch_id, context.case!.case_id, "rewrite", ["rewrite", sourceTaskId]]);
    const old = oldTasks.get(key);
    rewrites.set(sourceTaskId, [{
      id: old?.id || randomUUID(),
      stage: "rewrite",
      dependencies: { source: sourceTaskId },
      inputIds: {},
      data: {
        stage: "rewrite",
        candidates: {},
        reference: null,
        rewriteOf: { stage: sourceStage, taskId: sourceTaskId, resultId },
        rewriteNames: names,
        ...((old?.data as TaskData | undefined)?.comparisonRewriteScope
          ? { comparisonRewriteScope: (old!.data as TaskData).comparisonRewriteScope } : {}),
        ...((old?.data as TaskData | undefined)?.rewriteSlotIds
          ? { rewriteSlotIds: (old!.data as TaskData).rewriteSlotIds } : {}),
        ...(sourceStage === "comparison" && config.rewrite.comparisonItems && !accepted.has(old?.id ?? "")
          ? { comparisonRewriteScope: "all" as const } : {}),
        ...context,
        revision,
      },
    }]);
  }
  const byBatch = new Map<string, BatchPreflight>();
  function batchStats(batch: string): BatchPreflight {
    if (!byBatch.has(batch))
      byBatch.set(batch, {
        cases: 0,
        valid_inputs: 0,
        attribution_tasks: 0,
        comparison_tasks: 0,
        comparison_verification_tasks: 0,
        skipped_groups: 0,
        input_issues: 0,
      });
    return byBatch.get(batch)!;
  }
  let validInputs = 0;
  for (const [batch, id] of selected) {
    const stats = batchStats(batch);
    stats.cases++;
    const available = config.inputs.versions
      .map((v) => records.get(canonical([batch, id, v.id])))
      .filter((r): r is Candidate => !!r);
    validInputs += available.length;
    stats.valid_inputs += available.length;
    const sources = (versions: string[]) =>
      versions.flatMap((version) => locations.get(canonical([batch, id, version])) || []);
    // A single known reference propagates across the same question. Conflicting
    // references form separate scopes; an unreferenced answer never switches
    // standards depending on which opponent happens to be in the pair.
    const scopeOf = (record: Candidate) => {
      const matching = available.filter((other) => normalize(other.question) === normalize(record.question));
      const refs = new Map(matching.filter((other) => other.reference !== null)
        .map((other) => [canonical(other.reference), other.reference]));
      return { question: normalize(record.question), reference: refs.size === 1 ? refs.values().next().value : record.reference };
    };
    for (const group of comparisonPairs) {
      const predictionSelection = predictionSelections.find(item => item.batchId === batch && item.caseId === id &&
        item.versions.length === group.length && item.versions.every(version => group.includes(version)));
      if (config.prediction && !predictionSelection) continue;
      const prediction = config.prediction && predictionSelection ? predictionMaterial(config.prediction, predictionSelection,
        predictionAnswers!.get(predictionKey(batch, predictionSelection.questionId))!).metadata : undefined;
      if (!group.every((v) => config.inputs.versions.some((item) => item.id === v))) continue;
      if (retainedPairs.has(canonical([batch, id, [...group].sort()]))) continue;
      const values = group.map((v) => records.get(canonical([batch, id, v])));
      const present = values.filter((value): value is Candidate => !!value);
      const refs = new Map(present.map(scopeOf).map((scope) => [canonical(scope.reference), scope.reference]));
      const reference = refs.values().next().value ?? null;
      const conflict = new Set(present.map((record) => normalize(record.question))).size > 1 || refs.size > 1;
      if (conflict) issues.push({ batch_id: batch, case_id: id, versions: group,
        reason: "question_or_reference_conflict", sources: sources(group) });
      if (conflict || values.some((v) => !v)) {
        stats.skipped_groups++;
        skipped.push({
          batch_id: batch,
          case_id: id,
          versions: group,
          reason: conflict ? "case_conflict" : "missing_or_invalid_answer",
          missing: group.filter((_, i) => !values[i]),
          sources: sources(group),
        });
        continue;
      }
      const groupKey = canonical([batch, id, "comparison", [...group].sort(), "standalone"]);
      const oldGroup = oldTasks.get(groupKey),
        oldData = oldGroup?.data as TaskData | undefined;
      let ordered: Candidate[] = [];
      if (oldData) {
        const byVersion = new Map((values as Candidate[]).map((candidate) => [candidate.version, candidate]));
        ordered = Object.keys(oldData.candidates)
          .sort()
          .map((label) => byVersion.get(oldData.candidates[label]!.version)!)
          .filter((candidate): candidate is Candidate => !!candidate);
      }
      if (ordered.length !== values.length) {
        ordered = [...(values as Candidate[])];
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
        }
      }
      if (ordered.length > LABELS.length) throw new Error("对比组候选数超过盲测标签容量");
      const candidates = Object.fromEntries(ordered.map((candidate, i) => [LABELS[i]!, candidate])),
        dependencies: Record<string, string> = {};
      const rubricCandidates = available.filter((record) => {
        const scope = scopeOf(record);
        return scope.question === normalize(ordered[0]!.question) && isDeepStrictEqual(scope.reference, reference) &&
          comparisonPairs.some((pair) => pair.includes(record.version));
      }).sort((a, b) => a.version.localeCompare(b.version));
      const criteriaScope = canonical([batch, id, rubricCandidates.map((c) => c.version)]);
      let criteria = criteriaTasks.get(criteriaScope);
      if (!criteria) {
        const old = oldTasks.get(canonical(["criteria", criteriaScope]));
        const changed = !!old && (!isDeepStrictEqual((old.data as TaskData).reference, reference) ||
          rubricCandidates.some((candidate, i) => {
            const prior = (old.data as TaskData).candidates[LABELS[i]!];
            return candidate.input_id !== prior?.input_id || candidate.question !== prior.question ||
              candidate.final_index !== prior.final_index;
          }));
        criteria = {
          id: old && !(changed && accepted.has(old.id)) ? old.id : randomUUID(), stage: "criteria", dependencies: {},
          inputIds: Object.fromEntries(rubricCandidates.map((c, i) => [LABELS[i]!, c.input_id])),
          data: { stage: "criteria", candidates: Object.fromEntries(rubricCandidates.map((c, i) => [LABELS[i]!, c])),
            reference, criteriaScope, revision: old && !accepted.has(old.id)
              ? ((old.data as TaskData).revision ?? 1) + Number(changed) : 1 },
        };
        criteriaTasks.set(criteriaScope, criteria);
      }
      dependencies.criteria = criteria.id;
      for (const [label, record] of Object.entries(candidates)) {
        const checkKey = canonical([batch, id, "attribution", [record.version], criteriaScope]);
        const existing = checks.get(checkKey);
        if (existing) {
          dependencies[label] = existing.session.id;
          continue;
        }
        const reviewQuestions = config.reviewQuestions?.find(item => item.batch_id === batch && item.case_id === id)?.questions;
        const data: TaskData & { revision?: number } = {
          stage: "attribution-component",
          candidates: { A: record },
          standardAnswerReview: config.standardAnswerReview === true,
          reference,
          ...(prediction ? { prediction } : {}),
          criteriaScope,
          initialContextChars: config.execution.initialContextChars,
          ...(reviewQuestions ? { reviewQuestions: [...reviewQuestions] } : {}),
        };
        const oldCheck = previous?.tasks.find(task => task.stage === "attribution-session" &&
          (task.data as AttributionTaskData).candidate.input_id === record.input_id &&
          (task.data as TaskData).criteriaScope === criteriaScope)?.data as TaskData | undefined;
        data.revision =
          (oldCheck?.revision || 1) +
          Number(
            !!oldCheck &&
              (!isDeepStrictEqual(oldCheck.reference, reference) ||
                !isDeepStrictEqual(oldCheck.reviewQuestions, data.reviewQuestions) ||
                oldCheck.candidates.A.input_id !== record.input_id),
          );
        const unit = planAttributionUnit(record, { data: { ...data } as Record<string, unknown>, dependencies: { criteria: criteria.id }, previousTasks: previous?.tasks,
          identity: criteria.id });
        stats.attribution_tasks++;
        checks.set(checkKey, unit); attributionTasks.push(...unit.tasks);
        addRewrite(
          "attribution",
          unit.session.id,
          unit.session.id,
          { case: { batch_id: record.batch_id, case_id: record.case_id, question: record.question } },
          data.revision || 1,
          { A: record.name },
        );
        dependencies[label] = unit.session.id;
      }
      const data: TaskData = {
        stage: "comparison",
        candidates,
        reference,
        ...(prediction ? { prediction } : {}),
        criteriaScope,
        group,
        initialContextChars: config.execution.initialContextChars,
        comparisonId: oldData?.comparisonId || "cmp_" + randomUUID(),
        revision:
          (oldData?.revision || 1) +
          Number(
            !!oldData &&
              (!isDeepStrictEqual(oldData.reference, reference) ||
                oldGroup!.dependencies.criteria !== criteria.id ||
                Object.entries(candidates).some(
                  ([label, c]) => c.input_id !== oldData.candidates[label]!.input_id,
                )),
          ),
      };
      const comparisonTask: PlannedTask = {
        id: oldGroup?.id || randomUUID(),
        stage: "comparison",
        dependencies,
        inputIds: Object.fromEntries(Object.entries(candidates).map(([k, r]) => [k, r.input_id])),
        data,
      };
      tasks.push(comparisonTask);
      addRewrite(
        "comparison",
        comparisonTask.id,
        data.comparisonId!,
        { case: { batch_id: batch, case_id: id, question: ordered[0]!.question } },
        data.revision || 1,
        Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.name])),
      );
      const name = group.join("+");
      groupCounts[name] = (groupCounts[name] || 0) + 1;
      stats.comparison_tasks++;
    }
  }
  // Explicitly selected answers without a complete configured pair still receive independent attribution.
  const selectedKeys = new Set(selected.map(entry => canonical(entry)));
  const attributed = new Set([...checks.values()].map(unit => (unit.session.data as AttributionTaskData).candidate.input_id));
  for (const task of previous?.tasks ?? [])
    if (task.stage === "attribution-session" && accepted.has(task.id)) attributed.add((task.data as AttributionTaskData).candidate.input_id);
  if (config.inputs.records) for (const record of records.values()) {
    if (!selectedKeys.has(canonical([record.batch_id, record.case_id])) || attributed.has(record.input_id)) continue;
    const criteriaScope = canonical([record.batch_id, record.case_id, [record.version]]);
    const previousCriteria = oldTasks.get(canonical(["criteria", criteriaScope]));
    const criteria: PlannedTask = { id: previousCriteria?.id || randomUUID(), stage: "criteria", dependencies: {},
      inputIds: { A: record.input_id }, data: { stage: "criteria", candidates: { A: record },
        reference: record.reference, criteriaScope } satisfies TaskData };
    criteriaTasks.set(criteriaScope, criteria);
    const key = canonical([record.batch_id, record.case_id, "attribution", [record.version], criteriaScope]);
    const unit = planAttributionUnit(record, { data: { stage: "attribution-component", candidates: { A: record }, standalone: true, reference: record.reference,
      criteriaScope, initialContextChars: config.execution.initialContextChars,
      standardAnswerReview: config.standardAnswerReview === true }, dependencies: { criteria: criteria.id }, previousTasks: previous?.tasks,
      identity: criteria.id });
    checks.set(key, unit); attributionTasks.push(...unit.tasks);
    batchStats(record.batch_id).attribution_tasks++;
    addRewrite("attribution", unit.session.id, unit.session.id,
      { case: { batch_id: record.batch_id, case_id: record.case_id, question: record.question } }, 1, { A: record.name });
  }
  // Clustering groups the batch's attribution receipts per model; shards bound prompt and output size.
  const clusteringTasks: PlannedTask[] = [];
  if (config.clustering.enabled) {
    interface CasePlan {
      input_id: string;
      case_id: string;
      source: string;
      line: number;
      task_id: string;
      revision: number;
    }
    interface Shard {
      version: string;
      batch_id: string;
      shard: number;
      cases: CasePlan[];
    }
    const grouped = new Map<string, { version: string; batch_id: string; cases: CasePlan[] }>();
    // Select the current attribution for each answer independently of comparative decisions.
    const activeComparisons = [...new Map([...(previous?.tasks ?? []), ...tasks]
      .filter(task => task.stage === "comparison").map(task => [task.id, task])).values()]
      .filter(task => !(task.data as TaskData).verificationAudit);
    const referencedAttributions = new Set(activeComparisons.flatMap(task => Object.keys((task.data as TaskData).candidates)
      .map(label => task.dependencies[label])));
    const comparedInputs = new Set(activeComparisons.flatMap(task => Object.values(task.inputIds)));
    const acceptedClusters = (previous?.tasks ?? []).filter((task) => task.stage === "clustering" && accepted.has(task.id));
    const covered = new Set(acceptedClusters.flatMap((task) => Object.values(task.dependencies)));
    const retained = (previous?.tasks ?? []).filter((task) => task.stage === "attribution-session" && accepted.has(task.id));
    const attributions = new Map([...checks.values()].map(unit => [unit.session.id, unit.session] as const)
      .concat(retained.map(task => [task.id, task] as const)));
    for (const task of attributions.values()) {
      if (covered.has(task.id)) continue;
      const data = task.data as TaskData,
        candidate = data.candidates.A;
      if (comparedInputs.has(candidate.input_id) && !referencedAttributions.has(task.id)) continue;
      const key = canonical([candidate.version, candidate.batch_id]);
      const entry = grouped.get(key) ?? {
        version: candidate.version,
        batch_id: candidate.batch_id,
        cases: [],
      };
      entry.cases.push({
        input_id: candidate.input_id,
        case_id: candidate.case_id,
        source: candidate.source,
        line: candidate.line,
        task_id: task.id,
        revision: data.revision || 1,
      });
      grouped.set(key, entry);
    }
    const shards: Shard[] = [];
    for (const entry of [...grouped.values()].sort((a, b) =>
      canonical([a.version, a.batch_id]) < canonical([b.version, b.batch_id]) ? -1 : 1,
    )) {
      entry.cases.sort((a, b) =>
        canonical([a.case_id, a.input_id]) < canonical([b.case_id, b.input_id]) ? -1 : 1,
      );
      const size = config.clustering.maxCasesPerTask;
      const firstShard = 1 + Math.max(-1, ...acceptedClusters.map((task) => (task.data as TaskData).scope!)
        .filter((scope) => scope.version === entry.version && scope.batch_id === entry.batch_id).map((scope) => scope.shard));
      for (let index = 0; index * size < entry.cases.length; index++)
        shards.push({
          version: entry.version,
          batch_id: entry.batch_id,
          shard: firstShard + index,
          cases: entry.cases.slice(index * size, (index + 1) * size),
        });
    }
    const shardCount = new Map<string, number>(),
      shardIndex = new Map<string, number>();
    for (const shard of shards)
      shardCount.set(shard.version, (shardCount.get(shard.version) ?? 0) + 1);
    for (const shard of shards) {
      const library = libraries.get(shard.version)!;
      const activeClasses = Object.values(library.classes).filter(
        (problem) => problem.status === "active",
      ).length;
      const activeComponents = Object.keys(library.components).length;
      const count = shardCount.get(shard.version)!,
        index = shardIndex.get(shard.version) ?? 0;
      shardIndex.set(shard.version, index + 1);
      // Reserve the run's whole headroom across shards so concurrent tasks cannot exceed the cap.
      const share = (total: number) =>
        Math.floor(total / count) + (index < total % count ? 1 : 0);
      const old = oldTasks.get(canonical([shard.batch_id, "clustering", shard.version, shard.shard]));
      clusteringTasks.push({
        id: old?.id || randomUUID(),
        stage: "clustering",
        dependencies: Object.fromEntries(shard.cases.map((entry) => [entry.input_id, entry.task_id])),
        inputIds: {},
        data: {
          stage: "clustering",
          candidates: {},
          reference: null,
          projection: projectLibrary(library),
          scope: {
            version: shard.version,
            batch_id: shard.batch_id,
            shard: shard.shard,
            cases: Object.fromEntries(
              shard.cases.map((entry) => [
                entry.input_id,
                { case_id: entry.case_id, source: { file: entry.source, line: entry.line } },
              ]),
            ),
            budget: {
              active_classes: activeClasses,
              max_classes: config.clustering.maxClassesPerModel,
              max_new_classes: Math.min(
                config.clustering.maxNewClassesPerTask,
                share(Math.max(0, config.clustering.maxClassesPerModel - activeClasses)),
              ),
              active_components: activeComponents,
              max_components: config.clustering.maxComponentsPerModel,
              // Bind narrows this to the components the task's observations actually use.
              max_new_components: share(Math.max(0, config.clustering.maxComponentsPerModel - activeComponents)),
              consolidate: activeClasses >= config.clustering.consolidateAt,
              min_support: config.clustering.minSupport,
            },
          },
          revision: Math.max(...shard.cases.map((entry) => entry.revision), 1),
        },
      });
      const task = clusteringTasks.at(-1)!;
      const version = config.inputs.versions.find((item) => item.id === shard.version)!;
      addRewrite("clustering", task.id, task.id, {
        rewriteScope: { batch_id: shard.batch_id, model: version.display_name || version.name },
      }, (task.data as TaskData).revision!, {});
    }
  }
  for (const issue of issues) if (issue.batch_id) batchStats(issue.batch_id).input_issues++;
  if ((config.comparisons.length || config.inputs.records) && options.materializeInputs !== false)
    await collected.materialize();
  for (const review of comparisonPairs.length ? config.reviewQuestions ?? [] : []) if (![...checks.values()].some(unit => {
    const candidate = (unit.session.data as AttributionTaskData).candidate;
    return candidate.batch_id === review.batch_id && candidate.case_id === review.case_id;
  })) issues.push({ batch_id: review.batch_id, case_id: review.case_id, stage: "attribution-session", reason: "review_case_unavailable" });
  return {
    tasks: [...criteriaTasks.values(), ...attributionTasks, ...tasks, ...clusteringTasks, ...[...rewrites.values()].flat()],
    inputs,
    catalog,
    summary: {
      valid_inputs: validInputs,
      cases: selected.length,
      criteria_tasks: criteriaTasks.size,
      attribution_tasks: checks.size,
      comparison_tasks: tasks.filter(task => !(task.data as TaskData).verificationAudit).length,
      comparison_verification_tasks: tasks.filter(task => !!(task.data as TaskData).verificationAudit).length,
      rewrite_tasks: [...rewrites.values()].reduce((count, tasks) => count + tasks.length, 0),
      clustering_tasks: clusteringTasks.length,
      comparisons: config.comparisons,
      group_counts: groupCounts,
      sources: resolvedSources,
      by_batch: Object.fromEntries([...byBatch].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      issues,
      skipped,
    },
  };
}
