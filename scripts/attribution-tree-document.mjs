import { safeId } from "@eval/contracts";

/** A manual publication is a complete single-model tree with its accepted provenance. */
export function attributionTreeDocument({ evaluationTaskId, batchId, versionId, runId, topic, createdAt,
  tree, sources, clustering }) {
  for (const id of [evaluationTaskId, batchId, versionId, runId]) safeId(id);
  if (typeof topic !== "string" || !topic.trim() || !Number.isFinite(Date.parse(createdAt)))
    throw new Error("Tree publication requires a topic and creation time");
  if (tree.models.length !== 1 || tree.models[0].id !== versionId || tree.unfinished.length ||
    !sources.length || sources.length !== tree.samples.length || tree.totals.targetSamples !== sources.length ||
    tree.totals.samples !== sources.length || tree.totals.unfinishedSamples !== 0)
    throw new Error("Tree publication requires complete single-model coverage");
  const byInput = new Map(sources.map(source => [source.input_id, source]));
  if (byInput.size !== sources.length || sources.some(source => source.model !== versionId ||
    source.batch_id !== batchId || !source.task_id || !source.submission_id || !source.run_id || !source.evaluator_version))
    throw new Error("Tree publication source identity invalid");
  if (new Set(tree.samples.map(sample => sample.inputId)).size !== sources.length)
    throw new Error("Tree samples duplicate or omit source inputs");
  const samples = new Map();
  for (const sample of tree.samples) {
    const source = byInput.get(sample.inputId);
    if (samples.has(sample.id) || !source || sample.model !== versionId || sample.date !== batchId ||
      sample.caseId !== source.case_id || sample.taskId !== source.task_id)
      throw new Error("Tree sample does not match its accepted model/source");
    samples.set(sample.id, sample);
  }
  const members = [...tree.nodes.flatMap(node => {
    if (node.model !== versionId || !node.id) throw new Error("Cross-model tree node");
    return node.observations;
  }), ...tree.pending.observations];
  if (new Set(tree.nodes.map(node => node.id)).size !== tree.nodes.length ||
    members.some(item => !samples.has(item.sampleId) || !item.findingId))
    throw new Error("Tree node or finding reference invalid");
  const findings = new Set(members.map(item => JSON.stringify([item.sampleId, item.findingId])));
  if (findings.size !== tree.totals.problems || tree.samples.some(sample =>
    new Set(members.filter(item => item.sampleId === sample.id).map(item => item.findingId)).size !== sample.problemCount))
    throw new Error("Tree findings coverage incomplete");
  const jobs = clustering.jobs;
  if (!Array.isArray(jobs) || !jobs.length || jobs[0].run_id !== runId ||
    new Set(jobs.map(job => job.run_id)).size !== jobs.length || jobs.some(job =>
      !job.run_id || !job.evaluator_version || !Array.isArray(job.source_input_ids) || !job.source_input_ids.length ||
      !Array.isArray(job.submissions) || job.submissions.some(item =>
        !["clustering", "rewrite"].includes(item.stage) || !item.task_id || !item.submission_id || !item.evaluator_version) ||
      new Set(job.submissions.map(item => item.task_id)).size !== job.submissions.length))
    throw new Error("Clustering receipts missing or duplicated");
  jobs.forEach(job => safeId(job.run_id));
  const covered = jobs.flatMap(job => job.source_input_ids);
  if (covered.length !== sources.length || new Set(covered).size !== covered.length ||
    covered.some(id => !byInput.has(id)) || (tree.totals.problems > 0 && !jobs.some(job => job.submissions.length)))
    throw new Error("Clustering jobs do not cover the accepted sources exactly");
  return {
    _id: `attribution_tree:${evaluationTaskId}:${batchId}:${versionId}:${runId}`,
    kind: "attribution_tree", evaluationTaskId, batchId, versionId, runId,
    evaluation_topic: topic, createdAt,
    result: { attribution_tree: tree, sources, clustering },
  };
}
