import { attributionTreeDocument } from "./attribution-tree-document.mjs";
import { isDeepStrictEqual } from "node:util";

/** Replace this topic's snapshot without losing accepted samples or touching another topic. */
export function topicProblemChanges(previous, documents, library) {
  if (!documents.length) throw new Error("Empty topic publication");
  const identity = documents[0], keys = ["evaluationTaskId", "batchId", "runId", "model"];
  const next = new Map(documents.map(doc => [doc._id, doc])), old = new Map(previous.map(doc => [doc._id, doc]));
  if (next.size !== documents.length || old.size !== previous.length) throw new Error("Duplicate topic publication identity");
  for (const doc of [...previous, ...documents]) {
    if (keys.some(key => doc[key] !== identity[key]) || !["class", "sample"].includes(doc.kind) ||
      doc.model !== library.model || !Number.isFinite(Date.parse(doc.scope?.capturedAt)) ||
      Date.parse(doc.scope.capturedAt) > Date.parse(identity.scope.capturedAt))
      throw new Error("Topic publication identity or snapshot time changed");
  }
  const remove = [];
  for (const doc of previous) {
    const replacement = next.get(doc._id);
    if (replacement && (replacement.kind !== doc.kind || replacement.id !== doc.id ||
      doc.kind === "sample" && !isDeepStrictEqual(doc.source, replacement.source)))
      throw new Error("Accepted topic sample identity changed");
    if (!replacement) {
      if (doc.kind !== "class" || library.classes[doc.id]?.status !== "merged")
        throw new Error("Topic publication would omit an accepted sample or active class");
      remove.push(doc);
    }
  }
  return { insert: documents.filter(doc => !old.has(doc._id)),
    replace: documents.filter(doc => old.has(doc._id) && !isDeepStrictEqual(old.get(doc._id), doc))
      .map(doc => ({ previous: old.get(doc._id), document: doc })),
    remove, unchanged: documents.filter(doc => isDeepStrictEqual(old.get(doc._id), doc)).length };
}

/** Project a verified topic tree into the collection's class/sample records. */
export function topicProblemDocuments({ record, library, attributions, inputs, scope }) {
  const { evaluationTaskId, batchId, versionId, runId, evaluation_topic, createdAt, result } = record;
  attributionTreeDocument({ evaluationTaskId, batchId, versionId, runId, topic: evaluation_topic,
    createdAt, tree: result.attribution_tree, sources: result.sources, clustering: result.clustering });
  if (versionId !== "b_post_train_fast" || library.model !== versionId ||
    !((scope.kind === "full-evaluation" && scope.sourceEvaluationComplete === true) ||
      (scope.kind === "accepted-at-cutoff" && scope.sourceEvaluationComplete === false)) ||
    !Number.isFinite(Date.parse(scope.capturedAt)) ||
    ![scope.targetAttributions, scope.acceptedAttributions, scope.excludedAttributions].every(n => Number.isInteger(n) && n >= 0) ||
    scope.acceptedAttributions !== result.sources.length ||
    scope.targetAttributions !== scope.acceptedAttributions + scope.excludedAttributions)
    throw new Error("Invalid completed topic scope");
  const tree = result.attribution_tree, sources = new Map(result.sources.map(s => [s.input_id, s]));
  const metadata = { evaluationTaskId, evaluation_topic, batchId, runId,
    scope: { kind: scope.kind, capturedAt: scope.capturedAt, sourceEvaluationComplete: scope.sourceEvaluationComplete,
      targetAttributions: scope.targetAttributions, acceptedAttributions: scope.acceptedAttributions,
      excludedAttributions: scope.excludedAttributions } };
  const identity = `${evaluationTaskId}:${batchId}:${versionId}:${runId}`;
  const records = tree.nodes.map(node => {
    const original = library.classes[node.id], paths = original?.category_paths;
    if (original?.status !== "active" || paths?.length !== 1 || paths[0].length !== 1 ||
      library.components[original.component_id]?.label !== node.category)
      throw new Error("Class has no single verified direction: " + node.id);
    return { _id: `class:${identity}:${node.id}`, kind: "class", id: node.id, model: versionId,
      category: node.category, direction: paths[0][0], label: node.label, definition: node.definition,
      originalLabel: original.label, originalDefinition: original.definition, ...metadata };
  });
  for (const sample of tree.samples) {
    const source = sources.get(sample.inputId), row = attributions.get(source.task_id), input = inputs[sample.inputId];
    if (!row || row.submission_id !== source.submission_id || row.evaluator_version !== source.evaluator_version ||
      row.version !== versionId || row.input_id !== sample.inputId || row.case.batch_id !== batchId ||
      row.case.case_id !== sample.caseId || input?.version !== versionId || input.case_id !== sample.caseId ||
      input.batch_id !== batchId || !input.trace_id) throw new Error("Sample source mismatch: " + sample.inputId);
    const raw = row.evaluation.findings.filter(finding => finding.type === "problem");
    if (new Set(raw.map(f => f.finding_id)).size !== raw.length || raw.length !== sample.problemCount)
      throw new Error("Sample problem coverage mismatch: " + sample.inputId);
    const findings = raw.map(finding => {
      const nodes = tree.nodes.filter(node => node.observations.some(o => o.sampleId === sample.id && o.findingId === finding.finding_id));
      const pending = tree.pending.observations.filter(o => o.sampleId === sample.id && o.findingId === finding.finding_id);
      const observed = [...nodes.flatMap(node => node.observations.filter(o => o.sampleId === sample.id && o.findingId === finding.finding_id)), ...pending];
      if (!observed.length || observed.some(o => o.evidenceStatus !== finding.assessment.evidence_status ||
        o.importance !== finding.importance) || new Set(observed.map(o => o.summary)).size !== 1)
        throw new Error("Finding projection differs from accepted attribution: " + finding.finding_id);
      // Cross-answer evidence must never become this model's replay evidence.
      if (finding.evidence.some(e => e.source !== undefined || e.source_input_id !== undefined))
        throw new Error("Cross-answer evidence cannot be published as a model sample");
      return { id: finding.finding_id, summary: observed[0].summary, text: finding.text, reason: finding.reason,
        importance: finding.importance, evidenceStatus: finding.assessment.evidence_status,
        status: nodes.length ? (pending.length ? "mixed" : "grouped") : pending[0].findingLibraryStatus,
        pendingStatuses: [...new Set(pending.map(o => o.libraryStatus))], classIds: nodes.map(node => node.id),
        components: [...finding.problem.component],
        evidence: finding.evidence.map(e => ({ message_index: e.message_index, quote: e.quote })) };
    });
    records.push({ _id: `sample:${identity}:${sample.inputId}`, kind: "sample", id: sample.inputId,
      model: versionId, inputId: sample.inputId, traceId: input.trace_id, date: batchId, caseId: sample.caseId,
      taskSummary: sample.taskSummary, source: { runId: source.run_id, taskId: source.task_id,
        submissionId: source.submission_id, evaluatorVersion: source.evaluator_version },
      replay: null, findings, ...metadata });
  }
  if (new Set(records.map(doc => doc._id)).size !== records.length) throw new Error("Duplicate topic document identity");
  return records;
}
