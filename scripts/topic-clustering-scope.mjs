/** A final topic tree can use accepted attributions only after the full source run has ended. */
export function completedTopicScope(checkpoint, job, model, batchId, capturedAt) {
  if (checkpoint.status !== "finished" || checkpoint.pausedStages?.length ||
    job.date !== batchId || !job.runIds?.includes(checkpoint.runId) || job.sourceReady !== true ||
    !["completed", "blocked", "waiting_inputs"].includes(job.evaluation) ||
    job.download !== "ready" || job.downloadError || !job.downloaded ||
    Object.keys(job.observed).some(key => job.downloaded[key] !== job.observed[key]) ||
    Object.entries(checkpoint.tasks).some(([id, task]) => (!checkpoint.executionScope || checkpoint.executionScope.includes(id)) &&
      ["pending", "running"].includes(task.status)))
    throw new Error("Topic evaluation or full input promotion is unfinished");
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Topic scope requires capture time");
  const tasks = Object.entries(checkpoint.tasks).filter(([, task]) => task.stage === "attribution" &&
    checkpoint.inputs[task.inputIds.answer]?.version === model);
  if (!tasks.length || tasks.some(([, task]) => checkpoint.inputs[task.inputIds.answer].batch_id !== batchId))
    throw new Error("Topic attribution model/date scope is invalid");
  const byInput = new Map(), excluded = [];
  for (const [taskId, task] of tasks) {
    const inputId = task.inputIds.answer;
    if (task.status !== "succeeded") { excluded.push({ taskId, inputId, status: task.status }); continue; }
    if (!task.receipt?.submissionId || !Number.isFinite(task.receipt.acceptedAt))
      throw new Error("Accepted topic attribution is missing its receipt");
    const previous = byInput.get(inputId);
    if (!previous || previous.acceptedAt < task.receipt.acceptedAt)
      byInput.set(inputId, { taskId, inputId, submissionId: task.receipt.submissionId, acceptedAt: task.receipt.acceptedAt });
  }
  const accepted = [...byInput.values()];
  const excludedInputs = [...new Set(excluded.map(item => item.inputId))].filter(id => !byInput.has(id));
  return { kind: "full-evaluation", capturedAt, sourceEvaluationComplete: true,
    targetAttributions: byInput.size + excludedInputs.length, acceptedAttributions: byInput.size,
    excludedAttributions: excludedInputs.length, accepted, selectedInputs: accepted.map(ref => ref.inputId),
    excluded: excluded.filter(item => excludedInputs.includes(item.inputId)) };
}

/** An answer already clustered keeps that accepted receipt, even if another accepted task exists for it. */
export function reuseClusteredScope(checkpoint, scope, sources) {
  const accepted = new Map(scope.accepted.map(ref => [ref.inputId, ref])), seen = new Set();
  for (const source of sources) {
    const task = checkpoint.tasks[source.task_id], input = checkpoint.inputs[source.input_id];
    if (seen.has(source.input_id) || !accepted.has(source.input_id) || source.run_id !== checkpoint.runId ||
        task?.stage !== "attribution" || task.status !== "succeeded" || task.inputIds.answer !== source.input_id ||
        task.receipt?.submissionId !== source.submission_id || !Number.isFinite(task.receipt.acceptedAt) ||
        input?.version !== source.model || input.batch_id !== source.batch_id)
      throw new Error("Previously clustered receipt changed: " + source.input_id);
    seen.add(source.input_id);
    accepted.set(source.input_id, { taskId: source.task_id, inputId: source.input_id,
      submissionId: source.submission_id, acceptedAt: task.receipt.acceptedAt });
  }
  return { ...scope, accepted: [...accepted.values()] };
}

/** A user-approved cutoff keeps its accepted receipts even when later evaluation results arrive. */
export function frozenTopicScope(checkpoint, scope, model, batchId) {
  const cutoff = Date.parse(scope?.capturedAt);
  if (scope?.kind !== "accepted-at-cutoff" || scope.sourceEvaluationComplete !== false || !Number.isFinite(cutoff) ||
    ![scope.targetAttributions, scope.acceptedAttributions, scope.excludedAttributions].every(n => Number.isInteger(n) && n >= 0) ||
    scope.targetAttributions !== scope.acceptedAttributions + scope.excludedAttributions ||
    !scope.accepted?.length || scope.accepted.length !== scope.acceptedAttributions ||
    new Set(scope.accepted.map(ref => ref.inputId)).size !== scope.accepted.length ||
    scope.selectedInputs?.length !== scope.accepted.length ||
    scope.selectedInputs.some((id, index) => id !== scope.accepted[index].inputId))
    throw new Error("Invalid frozen topic scope");
  for (const ref of scope.accepted) {
    const task = checkpoint.tasks[ref.taskId], input = checkpoint.inputs[ref.inputId];
    if (task?.stage !== "attribution" || task.status !== "succeeded" || task.inputIds.answer !== ref.inputId ||
      task.receipt?.submissionId !== ref.submissionId || !ref.submissionId ||
      task.receipt.acceptedAt !== ref.acceptedAt || !Number.isFinite(ref.acceptedAt) || ref.acceptedAt > cutoff ||
      input?.version !== model || input.batch_id !== batchId)
      throw new Error("Frozen source attribution changed: " + ref.taskId);
  }
  return scope;
}

/** Keep every original and incremental job receipt, with non-overlapping primary answer selections. */
export function completedClusteringJobs(states) {
  if (!states.length) throw new Error("Clustering jobs are missing");
  const library = states[0].manifest.config.problemLibrary;
  const jobs = states.map(state => {
    const manifest = state.manifest, scope = manifest.executionScope;
    const tasks = manifest.tasks.filter(task => !scope || scope.includes(task.id));
    if (manifest.status !== "finished" || tasks.some(task => manifest.states[task.id]?.status !== "succeeded" ||
      !state.receipts[task.id] || state.receipts[task.id].taskId !== task.id))
      throw new Error("Clustering or rewrite is unfinished");
    if (manifest.config.problemLibrary.kind !== library.kind || manifest.config.problemLibrary.path !== library.path)
      throw new Error("Clustering jobs use different problem libraries");
    return { run_id: manifest.runId, evaluator_version: manifest.evaluatorVersion,
      source_input_ids: manifest.config.clusteringJob.sources.map(source => source.input_id),
      submissions: tasks.map(task => ({ task_id: task.id, stage: task.stage,
        submission_id: state.receipts[task.id].submissionId, evaluator_version: state.receipts[task.id].evaluatorVersion })) };
  });
  const sources = states.flatMap(state => state.manifest.config.clusteringJob.sources);
  if (new Set(jobs.map(job => job.run_id)).size !== jobs.length ||
    new Set(sources.map(source => source.input_id)).size !== sources.length)
    throw new Error("Clustering jobs or answer sources are duplicated");
  return { sources, clustering: { jobs } };
}
