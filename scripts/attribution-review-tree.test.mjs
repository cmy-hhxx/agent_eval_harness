import test from "node:test";
import assert from "node:assert/strict";
import { projectAttributionTree, projectProblemLibraryTree, selectedAttributionEntries } from "./attribution-review-tree.mjs";
import { emptyLibrary } from "@eval/agents/clustering";

const nodeIds = ["7130973d-a74b-4d0f-9f9e-cd7ea279e404", "54d14743-bbfc-4c02-ae07-c6750484a2bb"];
function row(model, taskId, options = {}) {
  const findings = options.clean ? [] : ["f0", ...(options.second ? ["f1"] : [])].map(problem_id => ({
    problem_id, evidence_status: options.uncertain ? "待核实" : "已确认",
    attribution_reason: "真实责任结论。",
    ...(() => {
      const [component = "责任主体未确定", ...related] = options.components ?? ["未命名终稿生成调用（消息 1） / 数据解释与计算 / 事实关系推导"];
      return { component, related_responsibilities: related.map(item => ({ component: item, attribution_reason: "共同影响最终交付。" })) };
    })(),
    text: "不复制原点评", evidence: [{ message_index: 1, quote: "不复制证据全文" }] }));
  return { id: `sample-${taskId}`, inputId: `input-${taskId}`, taskId, model, date: "2026-10-14", caseId: taskId,
    question: "不复制完整提问", standard: "不复制标准全文", text: { summary: "不复制改写全文" },
    raw: { Problem: findings, summary: "不复制原总结", has_standard_answer: !!options.standard,
      is_correct: options.standard ? !!options.correct : null },
    hasStandard: !options.standard, classes: options.classes ?? [], deferred: options.deferred ?? [],
    source: { label: "source.jsonl:2", href: "./source.jsonl", extra: "不复制来源额外字段" }, resultLink: "./result.jsonl" };
}
const member = (row, findingId = "f0") => ({ taskId: row.taskId, findingId, summary: `问题摘要-${row.taskId}-${findingId}` });
const candidate = (model, members, index = 0) => ({ id: nodeIds[index], model, category: "未命名终稿生成调用（消息 1） / 数据解释与计算 / 事实关系推导", label: "代表问题", definition: "代表问题的适用范围", members });
function snapshot(rows) {
  const nodes = [], pending = [];
  for (const model of new Set(rows.map(row => row.model))) {
    const own = rows.filter(row => row.model === model && row.raw.Problem.length);
    if (own.length >= 2) nodes.push(candidate(model, own.map(row => member(row)), nodes.length));
    else pending.push(...own.map(row => member(row)));
    pending.push(...own.filter(row => row.raw.Problem.length > 1).map(row => member(row, "f1")));
  }
  return { nodes, pending, samples: rows.map(row => ({ taskId: row.taskId, taskSummary: `任务摘要-${row.taskId}` })) };
}

test("each model's representative nodes count its own independent answers with stable model order", () => {
  const rows = [row("b_expert", "be1", { second: true }), row("a_fast", "af1"), row("b_expert", "be2"), row("a_fast", "af2")], grouping = snapshot(rows);
  const before = structuredClone({ rows, grouping }), tree = projectAttributionTree(rows, grouping);
  assert.deepEqual(tree.models.map(model => model.id), ["a_fast", "b_expert"]);
  assert.deepEqual(tree.models.map(model => model.nodeCount), [1, 1]);
  assert.equal(tree.nodes[0].id, nodeIds[0]);
  assert.equal(tree.nodes[0].model, "b_expert");
  assert.equal(tree.nodes[0].sampleCount, 2);
  assert.equal(tree.nodes[0].problemCount, 2);
  assert.deepEqual(tree.nodes[0].modelCounts, [{ model: "b_expert", sampleCount: 2, problemCount: 2 }]);
  assert.equal(tree.totals.problems, 5);
  assert.equal(tree.totals.groupedProblems, 4);
  assert.equal(tree.totals.pendingProblems, 1);
  assert.deepEqual(tree.pending.samples, ["sample-be1"]);
  assert.equal(tree.samples[0].problemCount, 2);
  assert.equal(tree.samples[0].summary, "问题摘要-be1-f0；问题摘要-be1-f1");
  assert.deepEqual(tree.samples[0].groupIds, [nodeIds[0]]);
  assert.deepEqual({ rows, grouping }, before);
});

test("sample rows expose curated prose and references and derive judgments from original results", () => {
  const rows = [row("a_fast", "correct", { standard: true, correct: true }), row("a_fast", "incorrect", { standard: true, unmet: true }), row("b_fast", "clean", { clean: true })];
  const tree = projectAttributionTree(rows, snapshot(rows));
  assert.deepEqual(tree.samples.map(sample => sample.correctnessStatus), ["correct", "incorrect", "not_applicable"]);
  assert.deepEqual(tree.samples.map(sample => sample.hasStandard), [true, true, false]);
  assert.equal(tree.samples[2].summary, "无已确认问题");
  assert.equal(tree.samples[2].problemCount, 0);
  assert.equal(tree.samples[2].importance, null);
  assert.equal(tree.samples[2].evidenceStatus, null);
  assert.deepEqual(tree.samples[2].groupIds, []);
  assert.equal(tree.models.find(model => model.id === "b_fast").sampleCount, 1);
  assert.equal(tree.models.find(model => model.id === "b_fast").nodeCount, 0);
  assert.equal(JSON.stringify(tree).includes("不复制"), false);
  for (const sample of tree.samples) for (const forbidden of ["raw", "text", "question", "standard", "evidence"]) assert.equal(forbidden in sample, false);
  assert.deepEqual(tree.samples[0].source, { label: "source.jsonl:2", href: "./source.jsonl" });
});

test("multi-component problems retain responsibility arrays without duplicating support or transferring class ownership", () => {
  const rows = [row("a_fast", "multi", { components: ["finquery / 原始返回及字段含义 / 结果完整性", "finquery / 工具请求参数 / 返回解析"], classes: [{ findingId: "f0", component: "finquery / 原始返回及字段含义 / 结果完整性" }], deferred: [{ findingId: "f0", component: "finquery / 工具请求参数 / 返回解析" }] }), row("a_fast", "other", { components: [] })];
  const grouping = snapshot(rows);
  grouping.nodes = [{ ...candidate("a_fast", [{ ...member(rows[0]), components: ["finquery / 原始返回及字段含义 / 结果完整性"] }]), category: "finquery / 原始返回及字段含义 / 结果完整性" }];
  grouping.pending = [{ ...member(rows[0]), components: ["finquery / 工具请求参数 / 返回解析"] }, member(rows[1])];
  const tree = projectAttributionTree(rows, grouping), observations = tree.nodes[0].observations;
  assert.deepEqual(observations[0].components, ["finquery / 原始返回及字段含义 / 结果完整性"]);
  assert.equal(observations[0].libraryStatus, "classified");
  assert.equal(observations[0].findingLibraryStatus, "mixed");
  assert.equal(tree.pending.observations[0].libraryStatus, "deferred");
  assert.equal(tree.pending.observations[1].libraryStatus, "unlocated");
  assert.equal(tree.nodes[0].problemCount, 1);
  assert.equal(tree.nodes[0].sampleCount, 1);
  assert.equal(tree.totals.problems, 2);
  assert.equal(tree.samples[0].problemCount, 1);
  assert.deepEqual(tree.samples[0].components, ["finquery / 原始返回及字段含义 / 结果完整性", "finquery / 工具请求参数 / 返回解析"]);
  assert.equal(tree.totals.classified, 1);
  assert.equal(tree.totals.deferred, 1);
  assert.equal(tree.totals.unlocated, 1);
  assert.equal(tree.totals.mixed, 1);
});

test("deferred requires component coordinates, and uncertain evidence remains visible", () => {
  const rows = [row("a_fast", "unknown", { deferred: [{ findingId: "f0", reason: "缺少组件不推断" }] }), row("a_fast", "uncertain", { uncertain: true, low: true })];
  const tree = projectAttributionTree(rows, snapshot(rows));
  assert.deepEqual(tree.nodes[0].observations.map(item => item.libraryStatus), ["unclassified", "uncertain"]);
  assert.equal(tree.totals.deferred, 0);
  assert.equal(tree.samples[1].evidenceStatus, "待核实");
  assert.equal(tree.samples[1].importance, null);
});

test("formal class subsets retain their UUID with one supporting input, and empty nodes or duplicate inputs are rejected", () => {
  const single = [row("a_fast", "single", { second: true })], grouping = snapshot(single);
  grouping.nodes = [candidate("a_fast", grouping.pending)]; grouping.pending = [];
  const tree = projectAttributionTree(single, grouping);
  assert.equal(tree.nodes[0].id, nodeIds[0]); assert.equal(tree.nodes[0].sampleCount, 1); assert.equal(tree.nodes[0].problemCount, 2);
  grouping.nodes[0].members = [];
  assert.throws(() => projectAttributionTree(single, grouping), /须有样本/);
  const repeated = [row("a_fast", "one"), row("a_fast", "another-run")];
  repeated[1].inputId = repeated[0].inputId;
  assert.throws(() => projectAttributionTree(repeated, snapshot(repeated)), /样本身份缺失或重复/);
});

test("every original problem must occur exactly once in its model's node or pending pool", () => {
  const rows = [row("a_fast", "one", { second: true }), row("a_fast", "two")], grouping = snapshot(rows);
  grouping.pending.push({ ...grouping.nodes[0].members[0] });
  assert.throws(() => projectAttributionTree(rows, grouping), /成员缺失或重复/);
  grouping.pending = [];
  assert.throws(() => projectAttributionTree(rows, grouping), /问题覆盖不完整/);
  grouping.pending = [{ taskId: "one", findingId: "missing", summary: "缺失" }];
  assert.throws(() => projectAttributionTree(rows, grouping), /成员缺失或重复/);
});

test("the snapshot supplies persistent UUIDs, model ownership and complete curated task summaries", () => {
  const rows = [row("a_fast", "one"), row("a_fast", "two")], grouping = snapshot(rows);
  grouping.nodes[0].id = "generated-alias";
  assert.throws(() => projectAttributionTree(rows, grouping), /节点UUID/);
  grouping.nodes[0].id = nodeIds[0]; delete grouping.nodes[0].model;
  assert.throws(() => projectAttributionTree(rows, grouping), /节点模型/);
  grouping.nodes[0].model = "missing-model";
  assert.throws(() => projectAttributionTree(rows, grouping), /模型不存在/);
  grouping.nodes[0].model = "a_fast"; grouping.samples.pop();
  assert.throws(() => projectAttributionTree(rows, grouping), /样本快照覆盖不完整/);
  assert.throws(() => projectAttributionTree(rows), /缺少节点/);
});

test("a pool-only snapshot keeps clean answers and accepted problem provenance without inventing nodes", () => {
  const rows = [row("a_fast", "pending", { components: [], standard: true }), row("b_fast", "clean", { clean: true })];
  const tree = projectAttributionTree(rows, snapshot(rows));
  assert.deepEqual(tree.nodes, []);
  assert.equal(tree.pending.problemCount, 1);
  assert.equal(tree.totals.reviewNodeCount, 0);
  assert.equal(tree.samples.length, 2);
  assert.equal(tree.models[0].nodeCount, 0);
});

test("cross-model members are rejected and another model cannot supply a second supporting answer", () => {
  const rows = [row("a_fast", "af"), row("b_fast", "bf")], grouping = snapshot(rows);
  grouping.nodes = [candidate("a_fast", rows.map(row => member(row)))]; grouping.pending = [];
  assert.throws(() => projectAttributionTree(rows, grouping), /成员跨模型/);
  grouping.nodes[0].members = [member(rows[0])]; grouping.pending = [member(rows[1])];
  const tree = projectAttributionTree(rows, grouping);
  assert.equal(tree.nodes[0].sampleCount, 1); assert.equal(tree.models.find(model => model.id === "b_fast").nodeCount, 0);
});

test("same-named groups in different models have distinct UUIDs and independent trees", () => {
  const rows = [row("a_fast", "af1"), row("a_fast", "af2"), row("b_fast", "bf1"), row("b_fast", "bf2")], grouping = snapshot(rows);
  const tree = projectAttributionTree(rows, grouping);
  assert.equal(tree.nodes[0].label, tree.nodes[1].label);
  assert.notEqual(tree.nodes[0].id, tree.nodes[1].id);
  assert.deepEqual(tree.models.map(model => model.nodeCount), [1, 1]);
  assert.deepEqual(tree.nodes.map(node => node.model), ["a_fast", "b_fast"]);
  for (const node of tree.nodes) assert(node.samples.every(id => tree.samples.find(sample => sample.id === id).model === node.model));
  grouping.nodes[1].id = grouping.nodes[0].id;
  assert.throws(() => projectAttributionTree(rows, grouping), /节点UUID无效或重复/);
});

test("single examples in each of four models remain in their own pending pool", () => {
  const rows = ["a_fast", "a_expert", "b_fast", "b_expert"].map(model => row(model, model));
  const tree = projectAttributionTree(rows, snapshot(rows));
  assert.equal(tree.nodes.length, 0);
  assert.equal(tree.pending.problemCount, 4);
  assert.deepEqual(tree.models.map(model => model.nodeCount), [0, 0, 0, 0]);
  for (const model of tree.models) assert.equal(tree.pending.observations.filter(item => tree.samples.find(sample => sample.id === item.sampleId).model === model.id).length, 1);
});

test("frozen inputs use the latest in-scope accepted review and preserve its exact native JSONL line", () => {
  const task = (id, input = "input", version = "a_fast") => ({ id, stage: "attribution", inputIds: { answer: input },
    data: { candidates: { A: { input_id: input, version, batch_id: "2026-10-01", case_id: "case" } } } });
  const tasks = [task("original"), task("review"), task("outside-review"), task("unselected", "other")];
  tasks[1].data.reviewOf = { taskId: "original", round: 1, reasons: ["核验疑点"] };
  const entries = tasks.map(item => ({ value: { meta: { task_id: item.id, input_id: item.inputIds.answer,
    version: "a_fast", batch_id: "2026-10-01", case_id: "case", submission_id: "submission-" + item.id, evaluator_version: "judge" } },
    line: '{  "task_id": "' + item.id + '", "original": "原行字面不改" }' }));
  const state = { manifest: { tasks, executionScope: ["original", "review", "unselected"],
    preflight: { selected_answers: [{ input_id: "input", version: "a_fast", batch_id: "2026-10-01", case_id: "case", task_id: "original" }] },
    states: Object.fromEntries(tasks.map(item => [item.id, { status: "succeeded" }])) },
    receipts: Object.fromEntries(tasks.map((item, index) => [item.id, { acceptedAt: index + 1, submissionId: "submission-" + item.id, evaluatorVersion: "judge" }])) };
  const before = structuredClone({ state, entries }), selected = selectedAttributionEntries(state, entries);
  assert.deepEqual(selected, [entries[1]]); assert.equal(selected[0], entries[1]); assert.equal(selected[0].line, entries[1].line);
  assert.deepEqual({ state, entries }, before);
  delete state.receipts.review; state.manifest.states.review.status = "pending";
  assert.deepEqual(selectedAttributionEntries(state, entries), [entries[0]]);
  delete state.receipts.original;
  assert.deepEqual(selectedAttributionEntries(state, entries), [], "unaccepted inputs do not reject the completed subset");
  assert.throws(() => selectedAttributionEntries(before.state, []), /缺少已接受归因/, "an accepted receipt still requires its formal result row");
  const wrong = structuredClone(before); wrong.entries[1].value.meta.submission_id = "wrong";
  assert.throws(() => selectedAttributionEntries(wrong.state, wrong.entries), /身份不一致/);
  wrong.entries[1] = before.entries[1]; wrong.state.manifest.preflight.selected_answers.push(before.state.manifest.preflight.selected_answers[0]);
  assert.throws(() => selectedAttributionEntries(wrong.state, wrong.entries), /冻结回答重复/);
});

function libraryFixture(components = ["未命名终稿生成调用（消息 1） / 数据解释与计算 / 事实关系推导"]) {
  const rows = [row("a_fast", "one", { components }), row("a_fast", "two", { components }), row("a_fast", "unknown", { components: [] }), row("b_fast", "clean", { clean: true })];
  for (const item of rows) {
    item.taskSummary = "高层任务摘要-" + item.taskId;
    item.problemSummaries = new Map(item.raw.Problem.map(finding => [finding.problem_id, "通俗问题摘要-" + item.taskId]));
    item.attribution = { run: "/fixture/attribution", run_id: "attribution", task_id: item.taskId, submission_id: "source-" + item.taskId, evaluator_version: "judge" };
    item.sourceRecord = { file: "/fixture/source.jsonl", line: 2 };
  }
  const library = emptyLibrary("a_fast"), classTexts = new Map([["a_fast", new Map()]]);
  for (const [index, label] of components.entries()) {
    const componentId = index ? "c80dbbfe-7ae2-448f-9a11-931bb7f107e5" : "a9c41d34-83a7-46fb-9d53-5c6085c943e7", id = nodeIds[index];
    library.components[componentId] = { id: componentId, label, definition: "责任定义", aliases: [], first_seen: null };
    library.classes[id] = { id, component_id: componentId, label: "原类名称", definition: "原类定义", aliases: [], status: "active", merged_into: null,
      first_seen: null, category: "不能代替责任的主题" };
    classTexts.get("a_fast").set(id, { label: "通俗类名称-" + index, definition: "通俗类定义-" + index });
    library.occurrences.push(...rows.slice(0, 2).map(item => ({ id: "occurrence-" + index + "-" + item.taskId, class_id: id, version: item.model,
      evaluator_version: "cluster", batch_id: item.date, case_id: item.caseId, input_id: item.inputId, run_id: "cluster", task_id: "cluster-task",
      submission_id: "cluster-submission", finding_id: "f0", evidence_status: "已确认", message_index: 1,
      source: item.sourceRecord, attribution: item.attribution, classification: "created", previous_class_id: null, at: "2026-10-14T00:00:00Z" })));
  }
  return { rows, library, classTexts };
}

test("formal libraries form responsibility-first nodes with polished class text and exact current accepted sources", () => {
  const { rows, library, classTexts } = libraryFixture();
  const before = structuredClone({ rows, library }), empty = emptyLibrary("b_fast");
  library.classes["eb817b5c-17d3-4098-9c6b-0e699254a741"] = { ...library.classes[nodeIds[0]], id: "eb817b5c-17d3-4098-9c6b-0e699254a741", status: "merged", merged_into: nodeIds[0] };
  library.classes["662970d7-58e6-47b7-8f84-234bca5f01c8"] = { ...library.classes[nodeIds[0]], id: "662970d7-58e6-47b7-8f84-234bca5f01c8", label: "没有当前样本的类" };
  library.occurrences.push({ ...library.occurrences[0], id: "historical", attribution: { ...rows[0].attribution, task_id: "old-task" } });
  const tree = projectProblemLibraryTree(rows, [library, empty], classTexts);
  assert.equal(tree.nodes.length, 1); assert.equal(tree.nodes[0].id, nodeIds[0]);
  assert.equal(tree.nodes[0].category, "未命名终稿生成调用（消息 1） / 数据解释与计算 / 事实关系推导"); assert.equal(tree.nodes[0].label, "通俗类名称-0"); assert.equal(tree.nodes[0].definition, "通俗类定义-0");
  assert.equal(tree.nodes[0].problemCount, 2); assert.equal(tree.nodes[0].sampleCount, 2);
  assert.deepEqual(tree.nodes[0].observations.map(item => item.libraryStatus), ["classified", "classified"]);
  assert.equal(tree.pending.problemCount, 1); assert.equal(tree.pending.observations[0].libraryStatus, "unlocated");
  assert.equal(tree.totals.problems, 3); assert.equal(tree.totals.samples, 4);
  assert.deepEqual(rows, before.rows);
  for (const forbidden of ["不复制", "原类", "不能代替责任的主题", "old-task", "quote", "raw", "evidence_id"]) assert(!JSON.stringify(tree).includes(forbidden), forbidden);
});

test("independent multi-component class membership counts each problem and answer once globally", () => {
  const { rows, library, classTexts } = libraryFixture(["未命名终稿生成调用（消息 1） / 数据解释与计算 / 事实关系推导", "finquery / 工具请求参数 / 返回解析"]);
  library.occurrences.push({ ...library.occurrences[0], id: "same-class-duplicate" });
  const tree = projectProblemLibraryTree(rows, [library], classTexts);
  assert.equal(tree.nodes.length, 2); assert.deepEqual(tree.nodes.map(node => node.problemCount), [2, 2]);
  assert.deepEqual(tree.nodes.map(node => node.sampleCount), [2, 2]);
  assert.deepEqual(tree.nodes.map(node => node.observations[0].components), [["未命名终稿生成调用（消息 1） / 数据解释与计算 / 事实关系推导"], ["finquery / 工具请求参数 / 返回解析"]]);
  assert.equal(tree.totals.problems, 3); assert.equal(tree.totals.groupedProblems, 2); assert.equal(tree.totals.pendingProblems, 1);
  assert.equal(tree.models[0].problemCount, 3); assert.equal(tree.samples[0].problemCount, 1);
  assert.equal(tree.samples[0].summary, "通俗问题摘要-one"); assert.deepEqual(tree.samples[0].components, ["未命名终稿生成调用（消息 1） / 数据解释与计算 / 事实关系推导", "finquery / 工具请求参数 / 返回解析"]);
  assert.equal(tree.samples[3].problemCount, 0);
  library.occurrences = library.occurrences.filter(item => item.class_id === nodeIds[0]);
  const partial = projectProblemLibraryTree(rows, [library], classTexts);
  assert.equal(partial.samples[0].problemCount, 1); assert.equal(partial.totals.problems, 3);
  assert.equal(partial.pending.observations.find(item => item.sampleId === rows[0].id).libraryStatus, "unclassified");
  assert.equal(partial.pending.observations.find(item => item.sampleId === rows[0].id).findingLibraryStatus, "mixed");
});

test("library projection rejects wrong receipt, evidence, component and duplicate same-component ownership", () => {
  const { rows, library, classTexts } = libraryFixture();
  for (const change of [item => item.attribution.submission_id = "wrong", item => item.source.line = 99,
    item => item.message_index = 99, item => item.version = "b_fast", item => delete item.attribution]) {
    const wrong = structuredClone(library); change(wrong.occurrences[0]);
    assert.throws(() => projectProblemLibraryTree(rows, [wrong], classTexts), /来源|不一致/);
  }
  const borrowed = structuredClone(rows); borrowed[0].raw.Problem[0].evidence[0].source_input_id = "another-input";
  assert.throws(() => projectProblemLibraryTree(borrowed, [library], classTexts), /不一致/, "a message index from borrowed evidence cannot prove an owned occurrence");
  const wrong = structuredClone(library); wrong.components[Object.keys(wrong.components)[0]].label = "错误工具";
  assert.throws(() => projectProblemLibraryTree(rows, [wrong], classTexts), /不一致/);
  library.classes[nodeIds[1]] = { ...library.classes[nodeIds[0]], id: nodeIds[1] };
  library.occurrences.push({ ...library.occurrences[0], id: "another-class", class_id: nodeIds[1] });
  assert.throws(() => projectProblemLibraryTree(rows, [library], classTexts), /同责任问题重复归类/);
});

test("unfinished inputs retain only high-level fields and model targets without becoming clean accepted answers", () => {
  const { rows, library, classTexts } = libraryFixture();
  const incomplete = ["a_fast", "b_expert"].map(model => ({ id: "unfinished-" + model, inputId: "remaining-" + model, model,
    date: "2026-10-14", caseId: "remaining", taskSummary: "高层未完成任务摘要", hasStandard: false,
    question: "不复制未完成原问", raw: { answer: "不复制未完成原文" }, reason: "不复制取消与复核账本" }));
  const tree = projectProblemLibraryTree(rows, [library], classTexts, incomplete);
  assert.equal(tree.samples.length, 4); assert.equal(tree.unfinished.length, 2);
  assert.equal(tree.totals.samples, 4); assert.equal(tree.totals.targetSamples, 6); assert.equal(tree.totals.unfinishedSamples, 2);
  const model = tree.models.find(model => model.id === "b_expert");
  assert.equal(model.sampleCount, 0); assert.equal(model.targetCount, 1); assert.equal(model.unfinishedCount, 1); assert.equal(model.problemCount, 0);
  assert(tree.unfinished.every(sample => !("problemCount" in sample) && !("coreStatus" in sample) && !("correctnessStatus" in sample)));
  assert(!JSON.stringify(tree).includes("不复制"));
  incomplete[0].inputId = rows[0].inputId;
  assert.throws(() => projectProblemLibraryTree(rows, [library], classTexts, incomplete), /未完成样本身份/);
});
