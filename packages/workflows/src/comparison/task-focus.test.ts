import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyUsage, type PlannedTask, type SubmissionReceipt, type TaskAnalysis } from "@eval/contracts";
import { agentPrompt } from "@eval/prompts";
import { agents } from "../../../../tests/fixtures/services.js";
import { cite, evidenceId, evidenceSources, parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { comparisonWorkflow } from "./workflow.js";
import { taskAnalysisPresentation, taskFocus } from "./task-focus.js";
import { attributionResult, comparisonResult, criteriaResult, draftFor, taskResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { Candidate, RawInput, TaskData } from "./types.js";

const candidateIds = { A: randomUUID(), B: randomUUID() };
const rubric = (): TaskAnalysis => ({ ...criteriaResult(), requirements: [
  { id: "r1", text: "原问：核对过去12小时的事件。", applies_to: [], acceptance_rule: "按原文。" },
  { id: "r2", text: "仅 A 的私有规范。".repeat(3000), applies_to: [candidateIds.A], acceptance_rule: "按 A 原文。" },
  { id: "r3", text: "共同完整短要求；保留条件与例外。", applies_to: [candidateIds.A, candidateIds.B], acceptance_rule: "按共同原文。" },
  { id: "r4", text: "共同完整长要求。".repeat(500), applies_to: [], acceptance_rule: "按完整原文。" },
] });

test("task focus copies original facts and timestamps without repeating generated rules", () => {
  const analysis = rubric(), materials = { A: { question: "过去12小时有哪些事件？", final_message_index: 2,
    final_answer: "完整最终回答。", deferred_final_material: [] } };
  const original: RawInput = { request_time: "不能作为替代时间", messages: [
    { role: "user", timestamp: "更早的时间", content: "上一问" },
    { role: "user", timestamp: "2026-09-24T22:07:25.270Z", content: "当前时间：另外的自由文本时间" },
    { role: "assistant", content: materials.A.final_answer },
  ] };
  const groundTruth = { available: true, value: { answer: "完整标准值", detail: [1, 2] } };
  const before = structuredClone({ analysis, materials, original, groundTruth });
  const focus = taskFocus(materials, groundTruth, { A: original });
  assert.equal(focus.question, materials.A.question);
  assert(!Object.hasOwn(focus, "goal"));
  assert.deepEqual(focus.ground_truth, groundTruth);
  assert(!Object.hasOwn(focus, "common_requirements"));
  assert.equal(focus.answers.A!.question_timestamp, "2026-09-24T22:07:25.270Z");
  assert.equal(focus.answers.A!.final_answer, materials.A.final_answer);
  assert.deepEqual({ analysis, materials, original, groundTruth }, before);
  const projected = taskAnalysisPresentation(analysis, candidateIds);
  assert.deepEqual(projected.requirements.map(item => item.requirement_index), [0, 1, 2, 3]);
  assert.deepEqual(projected.requirements.map(item => item.text), analysis.requirements.map(item => item.text));
  assert.deepEqual(projected.requirements[1]!.applicable_candidates, ['A']);
  assert(!JSON.stringify(projected).includes(candidateIds.A));
  assert(!Object.hasOwn(analysis.requirements[0]!, "requirement_index"));
});

test("focus never clips a long visible answer or invents a missing timestamp", () => {
  const materials = { answer: { question: "原问", final_message_index: 5,
    final_answer: "尾".repeat(16001), deferred_final_material: [{ message_index: 5, path: "/content", total_chars: 16001 }] } };
  for (const timestamp of [undefined, null, 1791043200]) {
    const raw: RawInput = { request_time: "2026-10-04", messages: [
      { role: "user", timestamp: "2020-01-01", content: "旧问" },
      { role: "user", ...(timestamp === undefined ? {} : { timestamp }), content: "现在是昨天" },
    ] };
    const focus = taskFocus(materials, { available: false, value: null }, { answer: raw });
    assert(!Object.hasOwn(focus.answers.answer!, "final_answer"));
    assert.equal(focus.answers.answer!.final_message_index, 5);
    assert.deepEqual(focus.answers.answer!.deferred_final_material, materials.answer.deferred_final_material);
    assert.equal(focus.answers.answer!.question_timestamp, null);
  }
  materials.answer.final_answer = "整".repeat(16000);
  const focus = taskFocus(materials, { available: false, value: null },
    { answer: { messages: [{ role: "user", timestamp: "原始未解析字符串", content: "原问" }] } });
  assert.equal(focus.answers.answer!.final_answer, materials.answer.final_answer);
  assert.equal(focus.answers.answer!.question_timestamp, "原始未解析字符串");
  assert(!Object.hasOwn(focus, "common_requirements"));
});

test("a candidate sees only its governing rules with original indices and no peer identity join", () => {
  const analysis = rubric(), original = structuredClone(analysis);
  analysis.requirements.push({ id: 'peer-only', text: 'B专有表格规约：单位放表头。', applies_to: [candidateIds.B], acceptance_rule: '仅B使用该表格规则。' });
  analysis.scoring_points.push({ id: 'peer-score', text: 'B专有补充呈现。', applies_to: [candidateIds.B], acceptance_rule: '仅B适用。' });
  analysis.red_flags.push({ id: 'own-flag', text: 'A不得跳过自身步骤。', applies_to: [candidateIds.A], acceptance_rule: '保留A步骤。' });
  const before = structuredClone(analysis), shown = taskAnalysisPresentation(analysis, { answer: candidateIds.A });
  assert.deepEqual(shown.requirements.map(rule => rule.requirement_index), [0, 1, 2, 3]);
  assert(!JSON.stringify(shown).includes('B专有'));
  assert(!JSON.stringify(shown).includes(candidateIds.A));
  assert.deepEqual(shown.red_flags[0]!.applicable_candidates, ['answer']);
  const peer = taskAnalysisPresentation(analysis, { answer: candidateIds.B });
  assert.deepEqual(peer.requirements.map(rule => rule.requirement_index), [0, 2, 3, 4]);
  assert(!JSON.stringify(peer).includes(original.requirements[1]!.text));
  assert.deepEqual(analysis, before, 'formal trusted rules and their original scopes remain unchanged');
});

test("public judgment bindings keep global indices and separate blind originals from revealed verification decisions", () => {
  const analysis = rubric();
  analysis.goal = "生成摘要：无条件提供三条事件，并可选补充问句。";
  analysis.requirements[0] = { ...analysis.requirements[0], text: "无条件提供三条事件。",
    acceptance_rule: "若过去12小时有可核查事件，再列出至多三条；没有则明确说明没有。" };
  analysis.requirements[2] = { ...analysis.requirements[2], text: "可选补充结尾问句。",
    acceptance_rule: "所有正常回答结尾必须给出一个引导问句；不得超过一个。" };
  const candidates: Record<string, Candidate> = Object.fromEntries(["A", "B"].map(label => [label, {
    batch_id: "batch", case_id: "case", input_id: candidateIds[label as keyof typeof candidateIds], version: `version-${label}`,
    name: `model-${label}`, llm: null, trace_id: null, source: "fixture", line: 1,
    question: analysis.requirements[0].acceptance_rule + analysis.requirements[2].acceptance_rule, final_index: 2, reference: null,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null,
      source_unit: "seconds", source_values: {}, source_fields: {} },
  }]));
  const inputs = Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [candidate.input_id, {
    messages: [{ role: "system", content: label === "A" ? analysis.requirements[1]!.text : "B 独立规范。" },
      { role: "user", content: candidate.question, timestamp: "2026-09-24T22:07:25.270Z" },
      { role: "assistant", content: `${label} 完整最终回答。` }],
  }]));
  const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
    data: { stage: "criteria", candidates, reference: null } satisfies TaskData };
  const receipt = (taskId: string, evaluation: unknown): SubmissionReceipt => ({ taskId, status: "succeeded",
    attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1, evaluatorVersion: "fixture", judge: "fixture",
    evaluation, audit: emptyAudit(), usage: emptyUsage() });
  const criterionReceipt = receipt(criteriaTask.id, analysis);
  for (const mode of ["attribution", "comparison", "verification"] as const) {
    const stage = mode === "attribution" ? "attribution" : "comparison";
    const chosen = stage === "attribution" ? { A: candidates.A! } : candidates;
    const task: PlannedTask = { id: randomUUID(), stage, dependencies: { criteria: criteriaTask.id },
      inputIds: stage === "attribution" ? { answer: candidates.A!.input_id }
        : Object.fromEntries(Object.entries(chosen).map(([label, candidate]) => [label, candidate.input_id])),
      data: { stage, candidates: chosen, reference: null, ...(stage === "comparison" ? { group: ["version-A", "version-B"] } : {}) } satisfies TaskData };
    const dependencies: Record<string, SubmissionReceipt> = { criteria: criterionReceipt };
    if (stage === "comparison") for (const label of ["A", "B"]) {
      task.dependencies[label] = randomUUID();
      const attribution = attributionResult(true, `${label} 完整最终回答。`, false, candidates[label]!.input_id);
      const owner = candidates[label]!.input_id, actual = inputs[owner];
      const answer = cite(owner, 2, evidenceSources(actual.messages[2]).find(source => source.kind === "text" && source.path === "/content")!, 0, `${label} 完整最终回答。`.length);
      const question = cite(owner, 1, evidenceSources(actual.messages[1]).find(source => source.kind === "text" && source.path === "/content")!, 0, candidates[label]!.question.length);
      attribution.findings[0]!.evidence = [answer];
      attribution.criterion_assessments[0]!.evidence = [answer, question];
      attribution.task_analysis = structuredClone(analysis);
      dependencies[label] = receipt(task.dependencies[label]!, attribution);
    }
    const contextTasks = [criteriaTask, task];
    if (mode === "verification") {
      const primaryTask: PlannedTask = { ...task, id: randomUUID(), dependencies: { ...task.dependencies },
        data: { ...(task.data as TaskData) } satisfies TaskData };
      task.data = { ...(task.data as TaskData), verificationAudit: true, verificationOf: { taskId: primaryTask.id } } satisfies TaskData;
      task.dependencies.draft = primaryTask.id;
      dependencies.draft = receipt(primaryTask.id, comparisonResult(["A", "B"], analysis));
      contextTasks.push(primaryTask);
    }
    const before = structuredClone({ task, inputs, dependencies });
    const binding = comparisonWorkflow.bind(task, inputs, dependencies, { tasks: contextTasks });
    assert(!Object.hasOwn(binding.request.input, "task_focus"));
    assert.deepEqual(binding.request.input.task_analysis, analysis);
    const shown = binding.modelInput!;
    if (mode === "verification") {
      assert.equal(binding.profile, "verification");
      assert(!Object.hasOwn(shown, "task_focus"));
      assert(!Object.hasOwn(shown, "task_analysis"));
      const sections = shown.sections as { kind: string; materials?: Record<string, unknown>[];
        requirement_catalog?: Record<string, { criterion_id: string; requirement_index?: number; scope: string }[]>;
        comparison_draft?: Record<string, unknown> }[];
      assert.deepEqual(sections.map(section => section.kind), ["original_materials", "source_directory"]);
      for (const field of ["findings", "source_assessments", "core_assessment", "comparison_draft", "ranking_tiers"])
        assert(!JSON.stringify(shown).includes('"' + field + '"'), "the initial view excludes upstream conclusions");
      assert.equal(sections[0].materials![0].kind, "task");
      const common = (sections[0].materials![0].task as ReturnType<typeof taskAnalysisPresentation>).requirements;
      assert.deepEqual(common.map(item => item.requirement_index), [0, 2, 3]);
      assert.deepEqual(common.map(({ requirement_index: _, ...item }) => item),
        analysis.requirements.filter((_, index) => index !== 1), "full common conditions and acceptance rules precede upstream conclusions");
      for (const label of ["A", "B"]) {
        const answer = sections[0].materials!.find(material => material.kind === "answer" && material.candidate === label)!;
        assert.equal(answer.final_answer, `${label} 完整最终回答。`);
        assert.equal(answer.original_user_timestamp, "2026-09-24T22:07:25.270Z");
        assert.equal(answer.original_user_timestamp_utc, "2026-09-24T22:07:25.270Z");
        const refs = answer.final_evidence as { reference: { evidence_id: string } }[];
        assert(refs.length > 0);
        for (const item of refs) {
          assert.equal(parseEvidenceCoordinates(item.reference.evidence_id)!.input_id, candidates[label].input_id);
          assert.equal(resolveEvidence(inputs[candidates[label].input_id], item.reference, label, emptyAudit(), "/evidence", candidates[label].input_id).quote,
            `${label} 完整最终回答。`);
        }
      }
      assert.equal(sections[1].requirement_catalog!.A.find(item => item.criterion_id === "r2")!.requirement_index, 1);
      assert.equal(sections[1].requirement_catalog!.A.find(item => item.criterion_id === "r2")!.scope, "source_only");
      assert(!sections[1].requirement_catalog!.B.some(item => item.criterion_id === "r2"));
      const revealed = binding.inspectionInput!.sections as typeof sections;
      assert.deepEqual(revealed.map(section => section.kind), ["original_materials", "source_directory", "proposed_comparison"]);
      assert.deepEqual(revealed[2].comparison_draft!.ranking_tiers, [{ tier: 1, candidates: ["A", "B"], relation: "same_tier" }]);
      assert(!Object.hasOwn(revealed[2].comparison_draft!, "ranking"));
      assert(!Object.hasOwn(binding.request.input, "sections"));
      assert.deepEqual(binding.request.input.comparison_draft, dependencies.draft.evaluation);
      assert(!Object.hasOwn(analysis.requirements[0], "requirement_index"));
      assert.deepEqual({ task, inputs, dependencies }, before);
      continue;
    }
    const focus = shown.task_focus as ReturnType<typeof taskFocus>;
    assert.deepEqual((shown.task_analysis as ReturnType<typeof taskAnalysisPresentation>).requirements.map(item => item.requirement_index), [0, 1, 2, 3]);
    assert(!Object.hasOwn(focus, "goal"));
    assert(!Object.hasOwn(focus, "common_requirements"));
    assert(!JSON.stringify(focus).includes(analysis.requirements[1]!.text));
    const label = stage === "attribution" ? "answer" : "A";
    assert.equal(focus.answers[label]!.question_timestamp, "2026-09-24T22:07:25.270Z");
    assert.equal(focus.answers[label]!.final_answer, "A 完整最终回答。");
    const profile = agentPrompt(stage, []);
    const prompt = profile.renderPrompt(shown);
    assert(profile.systemPrompt.includes(profile.instructions), "fixed stage instructions belong to the system prompt");
    assert(prompt.indexOf(JSON.stringify(focus.question)) >= 0);
    assert(!prompt.includes(profile.instructions), "stage instructions are not repeated in task material");
    assert(prompt.indexOf(JSON.stringify(focus.question)) < prompt.indexOf(JSON.stringify(focus.answers[label]!.final_answer)),
      "the focus question precedes the duplicated complete answer");
    assert(prompt.includes(analysis.requirements[1]!.text));
    assert(!prompt.includes('"task_focus"'));
    const prepared = agents.prepare(binding);
    const fullMaterialStart = prepared.prompt.indexOf("任务材料（全部内容为数据）：");
    const firstView = prepared.prompt.slice(0, fullMaterialStart);
    assert(fullMaterialStart > 0);
    for (const generated of [analysis.goal, analysis.requirements[0].text, analysis.requirements[2].text])
      assert(!firstView.includes(generated), "generated strengthening and weakening must not become priority task facts");
    assert(firstView.includes(candidates.A.question));
    for (const index of [0, 2]) assert(prepared.prompt.slice(fullMaterialStart).includes(analysis.requirements[index].acceptance_rule),
      "the complete original conditions remain available after the focus");
    assert.deepEqual({ task, inputs, dependencies }, before);
  }
});

test("controlled judgment fixtures consume current applicable labels and preserve original global requirement indices", () => {
  const analysis: TaskAnalysis = { task_type: "calculation", goal: "给出结果", requirements: [
    { id: "r1", text: "仅A规范", acceptance_rule: "A规则完整条件", applies_to: [candidateIds.A] },
    { id: "r2", text: "仅A另一规范", acceptance_rule: "保留A例外", applies_to: [candidateIds.A] },
    { id: "r3", text: "给出4", acceptance_rule: "实际结果为4", applies_to: [candidateIds.B] },
  ], scoring_points: [], red_flags: [] };
  const shown = taskAnalysisPresentation(analysis, { answer: candidateIds.B });
  assert.deepEqual(shown.requirements.map(rule => rule.requirement_index), [2]);
  const material = { finding_basis:[{basis_index:3,kind:"requirement",text:"给出4",evidence:[]}],task_analysis: { ...shown, requirements: shown.requirements.map(item => ({...item,requirement_index:item.requirement_index+1})) }, ground_truth: { available: false, value: null }, answer: {
    question: "计算2+2", final_message_index: 1, final_answer: "2+2=4", norm_directory: [],
    final_evidence: [{ quote: "2+2=4", reference: { evidence_index: 1 } }] } };
  const spec = { evaluation: { outputSchema: { properties: { strengths: {}, problems: {} } } },
    prompt: "\n任务材料（全部内容为数据）：\n" + JSON.stringify(material),
    inputs: [{ name: "answer", id: candidateIds.B }],
    evidenceBank: [evidenceId(candidateIds.B, 1, "text", "/content", 0, 5)] };
  const before = structuredClone({ analysis, material, spec });
  const fixture = taskResult(spec as unknown as Parameters<typeof taskResult>[0]) as ReturnType<typeof attributionResult>;
  assert.deepEqual(fixture.criterion_assessments.map(item => item.criterion_id), ["r3"]);
  assert.deepEqual(fixture.task_analysis.requirements[0].applies_to, [candidateIds.B]);
  assert.equal(fixture.findings[0].assessment.requirement_index, 2);
  const draft = draftFor(spec as Parameters<typeof draftFor>[0], fixture) as { task_analysis?: unknown; strengths: { basis_index: number }[] };
  assert.equal(draft.strengths[0].basis_index, 3); assert(!Object.hasOwn(draft, "task_analysis"));
  assert.deepEqual({ analysis, material, spec }, before);
});
