import { responsibilityLabels } from "@eval/agents/attribution";
import path from "node:path";
import { canonical, safeId, type ProblemLibrary, type RunState } from "@eval/contracts";
import { fileSourceReader, problemLibraryFile, readProblemLibrary, withProblemLibraryLock, writeProblemLibrary } from "@eval/data";
import {
  acceptedProblemOccurrenceReview, applyProblemOccurrenceReview, countProblemSamples,
  effectiveProblemOccurrences, normalizeLabel, problemAssociation, problemAssociationKey, resolveActiveClass,
  validateProblemOccurrenceReview, validateProblemOccurrenceReviewDecision,
  type ClusteringAssignment, type ClusteringResult, type ProblemOccurrenceReviewDecision, type ProblemOccurrenceReviewTarget,
} from "@eval/agents/clustering";
import { parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { loadRunInputs } from "../inputs/load.js";
import { readRunState, readRunTasks } from "./run-data.js";
import { taskObservations } from "./observations.js";
import type { AttributionResult, EvalConfig, TaskData } from "./types.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import { clusteringJobStorage, loadClusteringJobInputs, readClusteringJobSources } from "./clustering-job.js";
import { allClusteringJobSources, clusteringJobItems, jobObservations, type ClusteringJobConfig, type ClusteringJobTask } from "./clustering-job-types.js";

export interface ProblemOccurrenceReviewResult {
  review_id: string;
  applied: boolean;
  targets: {
    occurrence_id: string;
    association: ProblemOccurrenceReviewTarget["association"];
    affected_occurrence_ids: string[];
  }[];
  before: number;
  after: number;
}
function fail(message: string): never { throw new Error(message); }

function resultFor(
  before: ProblemLibrary, after: ProblemLibrary, decision: ProblemOccurrenceReviewDecision,
  targets: ProblemOccurrenceReviewTarget[], applied: boolean,
): ProblemOccurrenceReviewResult {
  return {
    review_id: decision.id, applied,
    targets: targets.map(target => ({
      occurrence_id: target.occurrence_id, association: target.association,
      affected_occurrence_ids: before.occurrences.filter(item =>
        problemAssociationKey(problemAssociation(before, item)) === problemAssociationKey(target.association)).map(item => item.id),
    })),
    before: countProblemSamples(effectiveProblemOccurrences(before)),
    after: countProblemSamples(effectiveProblemOccurrences(after)),
  };
}

/** New-class decisions name the original directory entry; its UUID may now resolve through merges. */
function assignmentSupportsClass(
  library: ProblemLibrary, result: ClusteringResult, assignment: ClusteringAssignment,
  componentId: string, classId: string,
): boolean {
  const current = resolveActiveClass(library, classId);
  if (!current || current.component_id !== componentId || assignment.deferred_reason !== undefined) return false;
  if (assignment.class_id !== undefined)
    return resolveActiveClass(library, assignment.class_id)?.id === current.id;
  const created = result.new_classes.find(item => item.key === assignment.new_class_key);
  const component = library.components[componentId]!;
  if (!created || ![component.label, ...component.aliases].some(label => normalizeLabel(label) === normalizeLabel(created.component))) return false;
  const resolved = new Set(Object.values(library.classes)
    .filter(item => item.component_id === componentId && [item.label, ...item.aliases]
      .some(label => normalizeLabel(label) === normalizeLabel(created.label)))
    .map(item => resolveActiveClass(library, item.id)?.id).filter((id): id is string => id !== undefined));
  return resolved.size === 1 && resolved.has(current.id);
}

/** Compare the source bindings actually used to rebuild the accepted observations, without run locks. */
function originBinding(state: RunState, taskId: string) {
  const task = state.manifest.tasks.find(item => item.id === taskId);
  const receipt = state.receipts[taskId];
  if (!task || !receipt) fail("复核期间原 accepted 来源缺失");
  const data = task.data as TaskData;
  const attributions = Object.keys(data.scope!.cases).sort().map(inputId => {
    const id = task.dependencies[inputId]!;
    const dependency = state.manifest.tasks.find(item => item.id === id);
    const accepted = state.receipts[id];
    if (!dependency || dependency.stage !== "attribution" || !accepted) fail("原聚类依赖缺少已接受 Attribution");
    return { input_id: inputId, task_id: id, input_ids: dependency.inputIds,
      owner: (dependency.data as TaskData).candidates.A,
      submission_id: accepted.submissionId, evaluation: accepted.evaluation };
  });
  const used = new Set(attributions.flatMap(item => Object.values(item.input_ids)));
  const catalog = (state.manifest.inputCatalog as Candidate[]).filter(item => used.has(item.input_id))
    .sort((a, b) => a.input_id.localeCompare(b.input_id));
  const exported = receipt.exported?.row;
  return { run_id: state.manifest.runId, scope: data.scope, reclassify_of: data.reclassifyOf,
    dependencies: task.dependencies, submission_id: receipt.submissionId, evaluation: receipt.evaluation,
    exported: exported && { task_id: exported.task_id, model: exported.model, items: exported.items }, attributions, catalog };
}

async function jobOrigin(state: RunState, taskId: string) {
  const config = state.manifest.config as ClusteringJobConfig;
  const task = state.manifest.tasks.find(task => task.id === taskId);
  if (!task || !state.receipts[taskId]) fail("独立聚类来源收据缺失");
  const sources = await readClusteringJobSources(allClusteringJobSources(config));
  const observations = jobObservations(await loadClusteringJobInputs(config), task.data as ClusteringJobTask);
  return { sources, observations, binding: {
    task, submission_id: state.receipts[taskId].submissionId, evaluation: state.receipts[taskId].evaluation,
    items: state.receipts[taskId].exported?.row.items,
    sources: allClusteringJobSources(config).map(source => {
      const original = sources.get(source.run)!;
      return { source, task: original.manifest.tasks.find(task => task.id === source.task_id),
        receipt: original.receipts[source.task_id], catalog: original.manifest.inputCatalog };
    }),
  } };
}

/** Explicit operator source review; preview is read-only and apply writes only the model library. */
export async function reviewProblemOccurrences(
  config: EvalConfig,
  decision: ProblemOccurrenceReviewDecision,
  options: { apply?: boolean; evaluatorVersion: string },
): Promise<ProblemOccurrenceReviewResult> {
  validateProblemOccurrenceReviewDecision(decision);
  if (!options.evaluatorVersion.trim()) fail("问题样本复核缺少 evaluatorVersion");
  if (!config.inputs.versions.some(version => version.id === decision.model))
    fail("问题样本复核模型未注册：" + decision.model);
  const file = problemLibraryFile(config.problemLibrary, decision.model);
  const initial = await readProblemLibrary(file);
  if (!initial) fail("问题库不存在：" + decision.model);
  validateProblemOccurrenceReview(initial, decision);
  const accepted = acceptedProblemOccurrenceReview(initial, decision);
  if (accepted) return resultFor(initial, initial, decision, accepted.targets, options.apply === true);

  const runs = new Map<string, { directory: string; state: RunState }>();
  const revisions = new Map<string, string>();
  const origins: { directory: string; clusteringTaskId: string; attributionTaskIds: string[]; independent: boolean; binding: unknown }[] = [];
  const targets: ProblemOccurrenceReviewTarget[] = [];
  for (const [index, item] of decision.items.entries()) {
    const occurrence = initial.occurrences.find(entry => entry.id === item.occurrence_id)!;
    const runKey = occurrence.clustering_run ?? path.join(config.output.path, safeId(occurrence.run_id));
    let run = runs.get(runKey);
    if (!run) {
      const directory = runKey;
      const state = occurrence.clustering_run ? await clusteringJobStorage.readRun(directory) : await readRunState(directory);
      if (state.manifest.runId !== occurrence.run_id) fail("原运行身份不一致：" + occurrence.run_id);
      run = { directory, state };
      runs.set(runKey, run);
    }
    const { state, directory } = run;
    const task = state.manifest.tasks.find(task => task.id === occurrence.task_id);
    const receipt = state.receipts[occurrence.task_id];
    const scope = (task?.data as TaskData | undefined)?.scope;
    const independent = !!occurrence.clustering_run;
    const job = independent && task ? await jobOrigin(state, task.id) : undefined;
    if (!task || task.stage !== "clustering" || !receipt || receipt.submissionId !== occurrence.submission_id ||
      (independent ? (task.data as ClusteringJobTask).model !== decision.model :
        scope?.version !== decision.model || scope.batch_id !== occurrence.batch_id))
      fail("问题样本原 Clustering 收据或范围不一致：" + item.occurrence_id);
    const attributionTaskId = independent ? occurrence.attribution?.task_id : task.dependencies[occurrence.input_id];
    const sourceState = independent ? job!.sources.get(occurrence.attribution?.run ?? "") : state;
    const attributionTask = sourceState?.manifest.tasks.find(task => task.id === attributionTaskId);
    const attribution = attributionTaskId ? sourceState?.receipts[attributionTaskId] : undefined;
    const owner = (attributionTask?.data as TaskData | undefined)?.candidates.A;
    const scopeCase = independent ? allClusteringJobSources(state.manifest.config as ClusteringJobConfig).find(source =>
      source.input_id === occurrence.input_id && source.task_id === attributionTaskId &&
      canonical({ run: source.run, run_id: source.run_id, task_id: source.task_id,
        submission_id: source.submission_id, evaluator_version: source.evaluator_version }) === canonical(occurrence.attribution))
      : scope!.cases[occurrence.input_id];
    if (!attributionTask || attributionTask.stage !== "attribution" || !attribution ||
      attributionTask.inputIds.answer !== occurrence.input_id || owner?.input_id !== occurrence.input_id ||
      owner.version !== decision.model || owner.case_id !== occurrence.case_id || owner.batch_id !== occurrence.batch_id ||
      !scopeCase || scopeCase.case_id !== occurrence.case_id ||
      canonical(scopeCase.source) !== canonical(occurrence.source))
      fail("问题样本原 Attribution 来源或 owner 不一致：" + item.occurrence_id);
    const finding = (attribution.evaluation as AttributionResult).findings.find(finding => finding.finding_id === occurrence.finding_id);
    const association = problemAssociation(initial, occurrence);
    const component = initial.components[association.component_id]!;
    if (!finding || finding.type !== "problem" || !finding.problem ||
      !responsibilityLabels(finding.problem).some(label => [component.label, ...component.aliases]
        .some(name => normalizeLabel(name) === normalizeLabel(label))))
      fail("问题样本原 finding 或责任组件不存在：" + item.occurrence_id);

    const row = receipt.exported?.row as { task_id?: string; model?: string; items?: unknown[] } | undefined;
    const result = receipt.evaluation as ClusteringResult;
    const observations = job ? job.observations : taskObservations(task, id => state.receipts[id]);
    if (!row || row.task_id !== task.id || row.model !== decision.model || !Array.isArray(row.items) ||
      !observations.some(observation =>
        [component.label, ...component.aliases].some(name => normalizeLabel(name) === normalizeLabel(observation.component)) &&
        observation.refs.some(({ quote: _quote, ...ref }) => canonical(ref) === canonical({
          input_id: occurrence.input_id, finding_id: occurrence.finding_id, case_id: occurrence.case_id,
          source: occurrence.source, message_index: occurrence.message_index,
          evidence_status: occurrence.evidence_status,
          batch_id: occurrence.batch_id,
          ...(independent ? { attribution: occurrence.attribution } : {}),
        })) && row.items!.some(item => canonical(item) === canonical(independent ? clusteringJobItems([observation])[0] : {
          id: observation.id, component: observation.component, label: observation.label,
          count: observation.count, established_count: observation.established_count, uncertain_count: observation.uncertain_count,
          established_answer_ids: observation.established_answer_ids,
        })) && result.assignments.some(assignment => assignment.item_id === observation.id &&
          assignmentSupportsClass(initial, result, assignment, association.component_id, occurrence.class_id))))
      fail("问题样本在原接受聚类中没有该组件和原观察的实际归类：" + occurrence.id);

    const allowed = new Set(Object.values(attributionTask.inputIds));
    if (!allowed.has(occurrence.input_id)) fail("问题样本原来源范围缺少 owner");
    const catalog = sourceState!.manifest.inputCatalog as Candidate[];
    const candidates = new Map(catalog.filter(candidate => allowed.has(candidate.input_id)).map(candidate => [candidate.input_id, candidate]));
    if (candidates.size !== allowed.size) fail("原归因来源范围含未登记输入");
    for (const candidate of candidates.values()) {
      if (!revisions.has(candidate.source)) revisions.set(candidate.source, await fileSourceReader.revision(candidate.source));
      if (candidate.batch_id !== owner.batch_id || candidate.case_id !== owner.case_id || candidate.question !== owner.question)
        fail("原归因 source scope 不是同一案例或原问题");
    }
    const inputs = await loadRunInputs(sourceState!.manifest, undefined, new Set([attributionTaskId!]));
    let hasOwnerProof = false;
    for (const [proofIndex, reference] of item.evidence.entries()) {
      const coordinates = parseEvidenceCoordinates(reference.evidence_id);
      if (!coordinates) fail("问题样本复核需要完整当前 evidence_id");
      if (coordinates.kind === "image") fail("问题样本复核不接受图片证明；不能构造 viewedImages 审计");
      const sourceId = coordinates.input_id;
      hasOwnerProof ||= sourceId === occurrence.input_id;
      if (!allowed.has(sourceId)) fail("复核证明来源不属于原 Attribution source scope：" + sourceId);
      const raw = inputs[sourceId] as RawInput | undefined;
      if (!raw || !Array.isArray(raw.messages)) fail("复核证明原输入不可读取：" + sourceId);
      resolveEvidence(raw, reference, sourceId, { viewedImages: [], traceReads: [] },
        "/items/" + index + "/evidence/" + proofIndex, sourceId);
    }
    if (!hasOwnerProof) fail("问题样本复核证明至少包含本方 owner 原材料：" + occurrence.input_id);
    targets.push({
      occurrence_id: occurrence.id, association, class_id_at_review: occurrence.class_id,
      origin: { run_id: occurrence.run_id, task_id: occurrence.task_id, submission_id: occurrence.submission_id },
      attribution: { task_id: attributionTaskId!, submission_id: attribution.submissionId },
    });
    origins.push({ directory, clusteringTaskId: task.id,
      independent, attributionTaskIds: independent ? [] : Object.keys(scope!.cases).map(inputId => task.dependencies[inputId]!),
      binding: job ? job.binding : originBinding(state, task.id) });
  }
  const checkSources = async () => {
    for (const [source, revision] of revisions)
      if (await fileSourceReader.revision(source) !== revision) fail("复核证明读取期间原输入发生变化：" + source);
    for (const origin of origins) {
      const current = origin.independent ? await clusteringJobStorage.readRun(origin.directory) :
        await readRunTasks(origin.directory, [origin.clusteringTaskId, ...origin.attributionTaskIds]);
      const binding = origin.independent ? (await jobOrigin(current, origin.clusteringTaskId)).binding : originBinding(current, origin.clusteringTaskId);
      if (canonical(origin.binding) !== canonical(binding))
        fail("复核期间原 accepted 来源发生变化");
    }
  };
  const preview = applyProblemOccurrenceReview(initial, decision, targets, options);
  if (!options.apply) {
    await checkSources();
    return resultFor(initial, preview, decision, targets, false);
  }
  // Never acquire a run lock under this model lock; report uses the opposite order.
  return withProblemLibraryLock(config.problemLibrary, decision.model, async () => {
    const current = await readProblemLibrary(file);
    if (!current) fail("复核期间问题库消失");
    const replay = acceptedProblemOccurrenceReview(current, decision);
    if (replay) return resultFor(current, current, decision, replay.targets, true);
    for (const target of targets) {
      const before = initial.occurrences.find(item => item.id === target.occurrence_id)!;
      const after = current.occurrences.find(item => item.id === target.occurrence_id);
      if (!after) fail("复核期间问题样本消失：" + target.occurrence_id);
      const { class_id: _beforeClass, previous_class_id: _beforeLineage, ...beforeOrigin } = before;
      const { class_id: _afterClass, previous_class_id: _afterLineage, ...afterOrigin } = after;
      if (canonical(beforeOrigin) !== canonical(afterOrigin) ||
        canonical(problemAssociation(current, after)) !== canonical(target.association))
        fail("复核期间问题样本原来源或责任组件变化：" + target.occurrence_id);
      if (resolveActiveClass(current, before.class_id)?.id !== after.class_id ||
        (before.class_id === after.class_id && before.previous_class_id !== after.previous_class_id))
        fail("复核期间问题样本原归类发生变化且不属于原合并 lineage：" + target.occurrence_id);
    }
    await checkSources();
    const next = applyProblemOccurrenceReview(current, decision, targets, options);
    await writeProblemLibrary(file, next);
    return resultFor(current, next, decision, targets, true);
  });
}
