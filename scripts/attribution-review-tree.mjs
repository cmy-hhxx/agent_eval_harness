import { responsibilityLabels } from "@eval/agents/attribution";
import { effectiveProblemOccurrences, normalizeLabel, projectLibrary } from "@eval/agents/clustering";

const modelOrder = ["a_fast", "a_expert", "b_fast", "b_expert"];
const modelNames = { a_fast: "A组Fast", a_expert: "A组Expert", b_fast: "B组Fast", b_expert: "B组Expert" };
const key = (taskId, findingId) => JSON.stringify([taskId, findingId]);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const unique = values => [...new Set(values)];
const text = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`归因审阅缺少${name}`);
  return value;
};

/** Select one accepted source per frozen input, including later attribution reviews. */
export function selectedAttributionEntries(state, entries) {
  const chosen = state.manifest.preflight.selected_answers;
  if (!Array.isArray(chosen) || !chosen.length) throw new Error("归因审阅缺少冻结回答选择");
  const scope = state.manifest.executionScope && new Set(state.manifest.executionScope), byTask = new Map(), latest = new Map();
  for (const entry of entries) {
    const meta = entry.value.meta;
    if (!meta?.task_id || byTask.has(meta.task_id)) throw new Error("归因 JSONL 任务身份缺失或重复");
    byTask.set(meta.task_id, entry);
  }
  for (const task of state.manifest.tasks) {
    const receipt = state.receipts[task.id];
    if (task.stage !== "attribution" || !receipt || state.manifest.states[task.id]?.status !== "succeeded" || (scope && !scope.has(task.id))) continue;
    const inputId = task.data.candidates.A.input_id, previous = latest.get(inputId);
    if (!previous || state.receipts[previous.id].acceptedAt <= receipt.acceptedAt) latest.set(inputId, task);
  }
  const inputs = new Set();
  return chosen.flatMap(answer => {
    if (inputs.has(answer.input_id)) throw new Error("冻结回答重复：" + answer.input_id);
    inputs.add(answer.input_id);
    const task = latest.get(answer.input_id);
    if (!task) return [];
    const entry = byTask.get(task.id), row = entry?.value, meta = row?.meta, candidate = task.data.candidates.A;
    if (!row || !meta || !candidate) throw new Error("冻结回答缺少已接受归因：" + answer.input_id);
    const receipt = state.receipts[task.id];
    if (task.inputIds.answer !== answer.input_id || meta.input_id !== answer.input_id || meta.version !== answer.version || candidate.version !== answer.version ||
      meta.batch_id !== answer.batch_id || candidate.batch_id !== answer.batch_id || meta.case_id !== answer.case_id || candidate.case_id !== answer.case_id ||
      meta.submission_id !== receipt.submissionId || meta.evaluator_version !== receipt.evaluatorVersion)
      throw new Error("冻结回答与正式归因身份不一致：" + task.id);
    return [entry];
  });
}

/** A clustering job pins its exact accepted source, including sources from other runs. */
export function pinnedAttributionEntries(sources, states, entriesByRun) {
  if (!Array.isArray(sources) || !sources.length) throw new Error("聚类审阅缺少冻结归因来源");
  const inputs = new Set(), indexes = new Map();
  for (const [run, entries] of entriesByRun) {
    const byTask = new Map();
    for (const entry of entries) {
      const meta = entry.value.meta;
      if (!meta?.task_id || byTask.has(meta.task_id)) throw new Error("归因 JSONL 任务身份缺失或重复：" + run);
      byTask.set(meta.task_id, entry);
    }
    indexes.set(run, byTask);
  }
  return sources.map(source => {
    if (inputs.has(source.input_id)) throw new Error("聚类审阅输入重复：" + source.input_id);
    inputs.add(source.input_id);
    const state = states.get(source.run), task = state?.manifest.tasks.find(task => task.id === source.task_id), receipt = state?.receipts[source.task_id];
    const entry = indexes.get(source.run)?.get(source.task_id), row = entry?.value, meta = row?.meta, candidate = task?.data.candidates.A;
    if (!row || !state || state.manifest.runId !== source.run_id || task?.stage !== "attribution" || !candidate || !receipt || state.manifest.states[task.id]?.status !== "succeeded" ||
      !meta || receipt.submissionId !== source.submission_id || receipt.evaluatorVersion !== source.evaluator_version || meta.submission_id !== source.submission_id ||
      meta.evaluator_version !== source.evaluator_version || meta.input_id !== source.input_id || task.inputIds.answer !== source.input_id || candidate.input_id !== source.input_id ||
      meta.version !== source.model || candidate.version !== source.model || meta.batch_id !== source.batch_id || candidate.batch_id !== source.batch_id ||
      meta.case_id !== source.case_id || candidate.case_id !== source.case_id || candidate.source !== source.source.file || candidate.line !== source.source.line)
      throw new Error("冻结聚类来源与正式归因不一致：" + source.run + "/" + source.task_id);
    return { source, entry };
  });
}

/** Read formal active classes only; old source occurrences never replace the latest selected answer. */
export function projectProblemLibraryTree(rows, libraries, classTexts, unfinished = []) {
  const assigned = rows.map(row => ({ ...row, classes: [] })), byTask = new Map(assigned.map(row => [row.taskId, row]));
  const inputIds = new Set(rows.map(row => row.inputId)), nodes = [], claimed = new Map();
  for (const library of libraries) {
    const classes = new Map(projectLibrary(library).components.flatMap(component => component.classes.map(problem => [problem.id, { component, problem }])));
    const members = new Map();
    for (const occurrence of effectiveProblemOccurrences(library)) {
      const target = classes.get(occurrence.class_id);
      if (!target || !inputIds.has(occurrence.input_id)) continue;
      if (!occurrence.attribution) throw new Error("问题库样本缺少正式归因来源：" + occurrence.id);
      const row = byTask.get(occurrence.attribution.task_id);
      if (!row) continue;
      const finding = row.raw.Problem.find(item => item.problem_id === occurrence.finding_id);
      const component = (finding ? responsibilityLabels(finding) : []).find(value => [target.component.label, ...target.component.aliases].some(label => normalizeLabel(label) === normalizeLabel(value)));
      if (library.model !== row.model || occurrence.version !== row.model || occurrence.input_id !== row.inputId ||
        occurrence.batch_id !== row.date || occurrence.case_id !== row.caseId || occurrence.attribution.run !== row.attribution.run ||
        occurrence.attribution.run_id !== row.attribution.run_id || occurrence.attribution.submission_id !== row.attribution.submission_id ||
        occurrence.attribution.evaluator_version !== row.attribution.evaluator_version || occurrence.source.file !== row.sourceRecord.file ||
        occurrence.source.line !== row.sourceRecord.line || !finding || !component ||
        occurrence.evidence_status !== finding.evidence_status || !finding.evidence.some(item => item.source === undefined && item.source_input_id === undefined &&
          item.message_index === occurrence.message_index))
        throw new Error("问题库引用与当前正式归因不一致：" + occurrence.attribution.task_id + "/" + occurrence.finding_id);
      const coordinate = JSON.stringify([row.inputId, finding.problem_id, target.component.id]), previous = claimed.get(coordinate);
      if (previous && previous !== target.problem.id) throw new Error("同责任问题重复归类：" + coordinate);
      if (previous) continue;
      claimed.set(coordinate, target.problem.id);
      row.classes.push({ findingId: finding.problem_id, component, id: target.problem.id });
      members.set(target.problem.id, [...members.get(target.problem.id) ?? [], {
        taskId: row.taskId, findingId: finding.problem_id, components: [component], summary: row.problemSummaries.get(finding.problem_id),
      }]);
    }
    for (const [id, selected] of members) {
      const { component, problem } = classes.get(id), display = classTexts.get(library.model)?.get(id) ?? problem;
      nodes.push({ id, model: library.model, category: component.label, label: display.label, definition: display.definition, members: selected });
    }
  }
  const pending = assigned.flatMap(row => row.raw.Problem.flatMap(finding => {
    const components = responsibilityLabels(finding).filter(component => !row.classes.some(item => item.findingId === finding.problem_id && item.component === component));
    return components.length || !responsibilityLabels(finding).length ? [{ taskId: row.taskId, findingId: finding.problem_id,
      components, summary: row.problemSummaries.get(finding.problem_id) }] : [];
  }));
  return projectAttributionTree(assigned, { nodes, pending, samples: assigned.map(row => ({ taskId: row.taskId, taskSummary: row.taskSummary })) }, unfinished);
}

/** Project formal class members and unassigned observations without exposing original prose. */
export function projectAttributionTree(rows, grouping, unfinished = []) {
  if (!grouping || !Array.isArray(grouping.nodes) || !Array.isArray(grouping.pending) || !Array.isArray(grouping.samples))
    throw new Error("归因审阅缺少节点、待观察和样本快照");
  const byTask = new Map(), bySample = new Map(), inputIds = new Set(), problems = new Map(), claimed = new Map(), nodeIds = new Set();
  const order = [...modelOrder, ...unique([...rows, ...unfinished].map(row => row.model)).filter(model => !modelOrder.includes(model))];
  const totals = { samples: rows.length, problems: 0, groupedProblems: 0, deferred: 0, unlocated: 0,
    classified: 0, uncertain: 0, unclassified: 0, mixed: 0, reviewNodeCount: 0, pendingProblems: 0, pendingSamples: 0 };
  for (const row of rows) {
    if (!row.inputId || byTask.has(row.taskId) || bySample.has(row.id) || inputIds.has(row.inputId))
      throw new Error(`归因审阅样本身份缺失或重复：${row.taskId}`);
    byTask.set(row.taskId, row); bySample.set(row.id, row); inputIds.add(row.inputId);
    for (const finding of row.raw?.Problem ?? []) {
      const coordinate = key(row.taskId, finding.problem_id);
      if (problems.has(coordinate)) throw new Error(`归因审阅问题坐标重复：${coordinate}`);
      const components = responsibilityLabels(finding);
      const statusByComponent = new Map(components.map(component => [component,
        (row.classes ?? []).some(item => item.findingId === finding.problem_id && item.component === component) ? "classified" :
          finding.evidence_status === "待核实" ? "uncertain" :
            (row.deferred ?? []).some(item => item.findingId === finding.problem_id && item.component === component) ? "deferred" : "unclassified"]));
      const statuses = components.length ? unique([...statusByComponent.values()]) : ["unlocated"];
      for (const status of statuses) totals[status]++;
      const libraryStatus = statuses.length === 1 ? statuses[0] : "mixed";
      if (libraryStatus === "mixed") totals.mixed++;
      problems.set(coordinate, { row, finding, libraryStatus, statusByComponent }); totals.problems++;
    }
  }
  const curatedSamples = new Map();
  for (const sample of grouping.samples) {
    if (!byTask.has(sample.taskId) || curatedSamples.has(sample.taskId)) throw new Error(`归因审阅样本快照坐标无效：${sample.taskId}`);
    curatedSamples.set(sample.taskId, text(sample.taskSummary, "任务摘要"));
  }
  if (curatedSamples.size !== rows.length) throw new Error("归因审阅样本快照覆盖不完整");
  const observe = member => {
    const coordinate = key(member.taskId, member.findingId), problem = problems.get(coordinate);
    if (!problem) throw new Error(`归因审阅成员缺失或重复：${coordinate}`);
    const { row, finding, libraryStatus: findingLibraryStatus, statusByComponent } = problem;
    const components = member.components ?? responsibilityLabels(finding), seen = claimed.get(coordinate) ?? new Set();
    if (!Array.isArray(components) || new Set(components).size !== components.length || components.some(component => !responsibilityLabels(finding).includes(component)) ||
      (!components.length && responsibilityLabels(finding).length) || (components.length ? components : [null]).some(component => seen.has(component)))
      throw new Error(`归因审阅成员缺失或重复：${coordinate}`);
    for (const component of components.length ? components : [null]) seen.add(component);
    claimed.set(coordinate, seen);
    const statuses = components.length ? unique(components.map(component => statusByComponent.get(component))) : ["unlocated"];
    const libraryStatus = statuses.length === 1 ? statuses[0] : "mixed";
    return { sampleId: row.id, findingId: finding.problem_id, summary: text(member.summary, "问题摘要"),
      components: [...components], evidenceStatus: finding.evidence_status,
      importance: null, libraryStatus, findingLibraryStatus };
  };
  const sampleCount = observations => new Set(observations.map(item => bySample.get(item.sampleId).inputId)).size;
  const nodes = grouping.nodes.map(node => {
    if (!uuid.test(node.id) || nodeIds.has(node.id)) throw new Error(`归因审阅节点UUID无效或重复：${node.id}`);
    nodeIds.add(node.id);
    const model = text(node.model, "节点模型");
    if (!rows.some(row => row.model === model)) throw new Error(`归因审阅节点模型不存在：${model}`);
    if (!Array.isArray(node.members)) throw new Error(`归因审阅节点缺少成员：${node.id}`);
    const observations = node.members.map(observe), support = sampleCount(observations);
    if (observations.some(item => bySample.get(item.sampleId).model !== model)) throw new Error(`归因审阅节点成员跨模型：${node.id}`);
    if (!support || observations.some(item => item.components.length !== 1)) throw new Error(`归因审阅正式节点须有样本且归属单一责任：${node.id}`);
    return { id: node.id, model, category: text(node.category, "主题"), label: text(node.label, "节点名称"),
      definition: text(node.definition, "节点定义"),
      problemCount: observations.length, sampleCount: support, samples: unique(observations.map(item => item.sampleId)),
      modelCounts: [{ model, sampleCount: support, problemCount: observations.length }], observations };
  });
  const pendingObservations = grouping.pending.map(observe);
  if (claimed.size !== problems.size || [...problems.entries()].some(([coordinate, problem]) =>
    claimed.get(coordinate)?.size !== Math.max(1, responsibilityLabels(problem.finding).length))) throw new Error("归因审阅问题覆盖不完整");
  const observations = [...nodes.flatMap(node => node.observations), ...pendingObservations];
  const samples = rows.map(row => {
    const own = [...new Map(observations.filter(item => item.sampleId === row.id).map(item => [item.findingId, item])).values()];
    const evidence = unique(own.map(item => item.evidenceStatus)), raw = row.raw;
    return { id: row.id, inputId: row.inputId, taskId: row.taskId, date: row.date, caseId: row.caseId,
      model: row.model, modelName: row.modelName ?? modelNames[row.model] ?? row.model, taskSummary: curatedSamples.get(row.taskId),
      hasStandard: raw?.has_standard_answer ?? row.hasStandard,
      correctnessStatus: raw?.has_standard_answer === false ? "not_applicable" : raw?.is_correct === true ? "correct" : raw?.is_correct === false ? "incorrect" : "unknown",
      problemCount: own.length, summary: own.length ? own.map(item => item.summary).join("；") : "无已确认问题",
      components: unique(observations.filter(item => item.sampleId === row.id).flatMap(item => item.components)), importance: null,
      evidenceStatus: evidence.length === 1 ? evidence[0] : evidence.length ? "mixed" : null,
      groupIds: nodes.filter(node => node.samples.includes(row.id)).map(node => node.id),
      source: row.source ? { label: row.source.label, href: row.source.href } : null, resultLink: row.resultLink };
  });
  const incomplete = unfinished.map(row => {
    if (!row.inputId || inputIds.has(row.inputId) || bySample.has(row.id)) throw new Error("归因审阅未完成样本身份缺失或重复");
    inputIds.add(row.inputId); bySample.set(row.id, row);
    return { id: row.id, inputId: row.inputId, model: row.model, modelName: row.modelName ?? modelNames[row.model] ?? row.model,
      date: row.date, caseId: row.caseId, taskSummary: text(row.taskSummary, "任务摘要"), hasStandard: row.hasStandard };
  });
  const models = order.filter(model => [...rows, ...incomplete].some(row => row.model === model)).map(id => {
    const own = samples.filter(sample => sample.model === id);
    const remaining = incomplete.filter(sample => sample.model === id);
    return { id, model: id, label: own[0]?.modelName ?? remaining[0].modelName, sampleCount: own.length,
      targetCount: own.length + remaining.length, unfinishedCount: remaining.length,
      problemCount: own.reduce((sum, sample) => sum + sample.problemCount, 0), nodeCount: nodes.filter(node => node.model === id).length };
  });
  const pending = { label: "待观察问题池", observations: pendingObservations, samples: unique(pendingObservations.map(item => item.sampleId)),
    problemCount: new Set(pendingObservations.map(item => key(item.sampleId, item.findingId))).size, sampleCount: sampleCount(pendingObservations) };
  totals.groupedProblems = new Set(nodes.flatMap(node => node.observations.map(item => key(item.sampleId, item.findingId)))).size;
  totals.reviewNodeCount = nodes.length; totals.pendingProblems = pending.problemCount; totals.pendingSamples = pending.sampleCount;
  totals.targetSamples = rows.length + incomplete.length; totals.unfinishedSamples = incomplete.length;
  return { models, nodes, samples, unfinished: incomplete, pending, totals };
}
