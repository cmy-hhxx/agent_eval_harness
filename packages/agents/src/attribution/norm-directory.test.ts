import { attributionJudgment } from "../../../../tests/fixtures/attribution-judgment.js";
import { resolveJudgment } from "./resolve.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { cite, evidenceSources, instructionSources, parseEvidenceCoordinates } from "@eval/tools";
import { attributionAgent, attributionNormDirectory, type AttributionResult } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { comparisonScope } from "@eval/agents/comparison";

const rule = "## 推荐追问\n\n每次回答末尾输出 suggestion 块；若本 Prompt 要求结束则不追加。";
const other = "## 风险提示\n\n仅投资建议前置风险，事实查询不要求。";
function scenario(messages: Record<string, unknown>[] = [{ role: "system", content: rule + "\n\n" + other },
  { role: "user", content: "计算2+2" }, { role: "assistant", content: "2+2=4" }]) {
  const request = structuredClone(example.request) as AgentRequest, finalIndex = messages.length - 1;
  request.sources.answer.value = { messages };
  Object.assign(request.input.answer as object, { final_message_index: finalIndex, final_answer: messages[finalIndex]!.content,
    catalog: messages.map((message, message_index) => ({ message_index, role: message.role, name: message.name,
      type: message.type ?? "message", chars: JSON.stringify(message).length })) });
  const directory = setFixtureNormDirectory(request);
  const ref = (index: number, path = "/content", start?: number, end?: number) => {
    const source = evidenceSources(messages[index]).find(item => item.path === path)!;
    return { evidence_id: cite(request.sources.answer.id, index, source, start ?? 0, end ?? source.text.length).evidence_id };
  };
  const submitted = attributionJudgment(request, structuredClone(example.result) as AttributionResult);
  submitted.correctness_evidence = [ref(finalIndex)];
  submitted.criterion_assessments.forEach(item => { item.evidence = [ref(finalIndex)]; });
  const { requirement_index: _association, ...assessment } = submitted.findings[0]!.assessment;
  const finding = { ...submitted.findings[0]!, dimension: "instruction_following" as const, norm_index: 0,
    evidence: [ref(finalIndex)], assessment, text: "末尾追问交付待核对。", reason: "以本方完整规范和实际回答判断。" };
  submitted.findings = [finding];
  const registry = new AgentRegistry([attributionAgent]), binding = { agent: "attribution", profile: "default", request };
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
  return { request, messages, finalIndex, directory, submitted, finding, registry, binding, audit, ref };
}
const resolve = (value: ReturnType<typeof scenario>) => {
  const result = resolveJudgment(value.binding.request, value.submitted, value.audit) as AttributionResult;
  value.registry.validate(value.binding, result, value.audit); return result;
};
const issue = (code: string) => (error: unknown) => error instanceof ValidationError && error.issues!.some(item => item.code === code);

test("a focused final finding does not append the entire answer as supporting evidence", () => {
  const answer = "无关背景。".repeat(500) + "2+2=4";
  const value = scenario([{ role: "system", content: rule }, { role: "user", content: "计算2+2" },
    { role: "assistant", content: answer }]);
  value.finding.evidence = [value.ref(2, "/content", answer.length - 5, answer.length)];
  value.submitted.correctness_evidence = value.finding.evidence;
  value.submitted.criterion_assessments.forEach(item => { item.evidence = value.finding.evidence; });
  const result = resolve(value);
  assert(!result.findings[0]!.evidence.some(item => item.quote === answer));
  assert(result.findings[0]!.evidence.some(item => item.quote === "2+2=4"));
});

test("one flat instruction selector binds its real private norm and raw final without a second submission route", () => {
  const value = scenario(), before = structuredClone(value.submitted), result = resolve(value);
  assert.deepEqual(result.findings[0]!.evidence.map(item => item.quote), ["2+2=4"]);
  assert.deepEqual(result.findings[0]!.context_evidence!.map(item => item.quote), [rule]);
  assert.equal(result.findings[0]!.assessment.requirement_index, null);
  assert.equal(result.core_assessment.meets_core, true, "source binding does not judge compliance or change core");
  assert(!Object.hasOwn(result.findings[0]!, "norm_index"));
  assert.deepEqual(value.submitted, before);
  const comparison = { sources: { A: value.request.sources.answer }, input: { task_analysis: result.task_analysis,
    candidates: { A: { candidate_id: value.request.sources.answer.id, final_message_index: value.finalIndex } }, attributions: { A: result } } } as unknown as AgentRequest;
  assert.equal(comparisonScope(comparison).findings.A![0]!.scope, "source_only");
});

test("norm directory retains complete headed and unheaded cross-leaf conditions without unrelated sections", () => {
  for (const content of [[{ text: "## 风险位置" }, { text: "投资建议前置风险。" }, { text: "事实查询除外。" }, { text: other }],
    [{ text: "投资建议前置风险。" }, { text: "事实查询除外。" }]]) {
    const value = scenario([{ role: "system", content }, { role: "user", content: "计算2+2" }, { role: "assistant", content: "2+2=4" }]);
    const result = resolve(value);
    assert.deepEqual(result.findings[0]!.context_evidence!.map(item => item.quote), content.slice(0, content.length === 4 ? 3 : 2).map(item => item.text));
  }
});

test("trusted criterion origin binds the requirement while private rules never borrow the ordinary question", () => {
  const value = scenario(), task = value.request.input.task_analysis as unknown as AttributionResult["task_analysis"];
  task.requirements[0]!.text = rule; task.requirements[0]!.acceptance_rule = task.requirements[0]!.text;
  const norm = value.directory[0]!.evidence[0]!;
  Object.assign(value.request.input.answer as object, { criterion_instruction_sources: { r1: [{ ...norm, path: "/content" }] } });
  value.directory = setFixtureNormDirectory(value.request);
  assert.equal(value.directory[0]!.requirement_index, 0);
  const result = resolve(value);
  assert.equal(result.findings[0]!.assessment.requirement_index, 0);
  const comparison = { sources: { A: value.request.sources.answer, B: value.request.sources.answer },
    input: { task_analysis: result.task_analysis,
      candidates: { A: { candidate_id: value.request.sources.answer.id, final_message_index: value.finalIndex },
        B: { candidate_id: value.request.sources.answer.id, final_message_index: value.finalIndex } },
      attributions: { A: result, B: result } } } as unknown as AgentRequest;
  assert.equal(comparisonScope(comparison).findings.A![0]!.scope, "pair", "complete normative context still proves the common scope");
  delete result.findings[0]!.context_evidence;
  assert.equal(comparisonScope(comparison).findings.A![0]!.scope, "source_only", "a focused output excerpt alone does not prove common normative scope");
  const wrong = structuredClone(value.submitted);
  wrong.findings[0]!.assessment.requirement_index = 0;
  assert.throws(() => resolve({ ...value, submitted: wrong }), issue("schema_false schema"));
});

test("independent USER paragraphs keep exact criterion owners and preserve unassociated context without merging it into the question", () => {
  const question = "计算2+2", condition = "仅报告数值，不输出操作建议。", metadata = "上下文：记录中的操作对象仅限示例。原时间为2026年10月5日。";
  const value = scenario([{ role: "user", content: [question, condition, metadata].join("\n\n") }, { role: "assistant", content: "2+2=4" }]);
  const task = value.request.input.task_analysis as unknown as AttributionResult["task_analysis"];
  task.requirements[0]!.text = question; task.requirements[0]!.acceptance_rule = task.requirements[0]!.text;
  task.requirements.push({ ...task.requirements[0]!, id: "r2", text: condition });
  const source = evidenceSources(value.messages[0]).find(item => item.path === "/content")!;
  const origin = (quote: string) => ({ ...cite(value.request.sources.answer.id, 0, source, source.text.indexOf(quote), source.text.indexOf(quote) + quote.length), path: "/content" });
  Object.assign(value.request.input.answer as object, { criterion_instruction_sources: { r1: [origin(question)], r2: [origin(condition)] } });
  const directory = setFixtureNormDirectory(value.request);
  assert.deepEqual(directory.map(item => ({ requirement: item.requirement_index, quotes: item.evidence.map(proof => proof.quote) })), [
    { requirement: 0, quotes: [question] }, { requirement: 1, quotes: [condition] }, { requirement: null, quotes: [metadata] },
  ]);
  assert(directory.every(item => item.roles.length === 1 && item.roles[0] === "user"));
});

test("unknown own SYS never borrows tool output, peer instructions or a separate planner", () => {
  const value = scenario([{ role: "user", content: "计算2+2" }, { role: "tool", content: rule },
    { type: "llm_turn", input_messages: [{ role: "system", content: rule }], output: [{ role: "assistant", content: "内部计划" }] },
    { role: "assistant", content: "2+2=4" }]);
  assert(value.directory.every(item => !item.roles.includes("system")));
  value.finding.norm_index = null as unknown as number;
  assert.throws(() => resolve(value), issue("finding_norm_unknown"));
  value.finding.assessment.evidence_status = "uncertain";
  const result = resolve(value);
  assert.deepEqual(result.findings[0]!.evidence.map(item => item.quote), ["2+2=4"]);
});

test("norm selectors reject invalid ownership while topic labels preserve the same selected norm", () => {
  const value = scenario();
  const wrong = structuredClone(value.submitted); wrong.findings[0]!.norm_index = value.directory.length;
  assert.throws(() => resolve({ ...value, submitted: wrong }), issue("finding_norm_index_invalid"));
  const absent = structuredClone(value.submitted); delete absent.findings[0]!.norm_index;
  assert.throws(() => resolve({ ...value, submitted: absent }), issue("schema_required"));
  const nonInstruction = structuredClone(value.submitted); nonInstruction.findings[0]!.dimension = "format";
  const classified=resolve({ ...value, submitted: nonInstruction });
  assert.equal(classified.findings[0].dimension,"format");
  assert.equal(classified.findings[0].assessment.requirement_index,resolve(value).findings[0].assessment.requirement_index);
  assert.deepEqual(classified.findings[0].evidence,resolve(value).findings[0].evidence);
  (value.request.input.answer as Record<string, unknown>).norm_directory = [...value.directory].reverse();
  assert.throws(() => resolve(value), issue("norm_directory_invalid"));
});

test("a missing norm selector is rejected and explicit directory choice repairs it", () => {
  const value=scenario(),missing=structuredClone(value.submitted);
  delete missing.findings[0]!.norm_index;
  assert.throws(()=>resolve({...value,submitted:missing}),issue("finding_norm_index_invalid"));
  missing.findings[0]!.norm_index=value.finding.norm_index;
  assert.deepEqual(resolve({...value,submitted:missing}),resolve(value));
});

test("non-final instruction findings require concrete execution coordinates and cannot substitute repeated norm text", () => {
  const value = scenario([{ role: "user", content: "计算2+2" },
    { type: "llm_turn", input_messages: [{ role: "system", content: rule }, { role: "user", content: "计算2+2" }],
      output: [{ role: "assistant", content: rule }] }, { role: "assistant", content: rule }]);
  value.finding.stage = "execution";
  value.finding.evidence = [];
  assert.throws(() => resolve(value), issue("schema_minItems"));
  value.finding.evidence = [value.ref(1, "/input_messages/0/content")];
  assert.throws(() => resolve(value), issue("instruction_answer_evidence_required"));
  value.finding.evidence = [value.ref(1, "/output/0/content")];
  assert.equal(resolve(value).findings[0]!.evidence[0]!.evidence_id, value.ref(1, "/output/0/content").evidence_id);
});

test("selected long norms retain the full read gate while unselected directory blocks need no reads", () => {
  const long = "## 长规范\n\n" + "完整条件与例外。".repeat(35);
  const value = scenario([{ role: "system", content: rule + "\n\n" + long }, { role: "user", content: "计算2+2" }, { role: "assistant", content: "2+2=4" }]);
  resolve(value);
  value.finding.norm_index = value.directory.find(item => item.evidence.some(proof => proof.quote === long))!.norm_index;
  assert.throws(() => resolve(value), issue("finding_norm_not_read"));
  const norm = value.directory[value.finding.norm_index]!.evidence[0]!, point = parseEvidenceCoordinates(norm.evidence_id)!;
  if (point.kind !== "text") assert.fail("text norm");
  value.audit.traceReads.push({ candidate: "answer", message_index: point.message_index, kind: "text", path: point.path, start: point.start, end: point.end });
  assert.equal(resolve(value).findings[0]!.context_evidence![0]!.quote, long);
});

test("complete original initial visibility avoids redundant norm reads while truncated or wrong-origin material does not", () => {
  const long = "## 完整规范\n\n" + "原始触发条件与例外。".repeat(30);
  const value = scenario([{ role: "system", content: long }, { role: "user", content: "计算2+2" }, { role: "assistant", content: "2+2=4" }]);
  const answer = value.request.input.answer as Record<string, unknown>;
  answer.instruction_sources = instructionSources({ messages: value.messages }, value.request.sources.answer.id, value.finalIndex);
  resolve(value); assert.deepEqual(value.audit.traceReads, [], "initial visibility is not fabricated as a tool read");
  (answer.instruction_sources as { content: unknown }[])[0]!.content = long.slice(0, 200);
  assert.throws(() => resolve(value), issue("finding_norm_not_read"));
  delete answer.instruction_sources;
  answer.initial_material = [{ message_index: 0, value: structuredClone(value.messages[0]), evidence: value.directory[0]!.evidence }];
  resolve(value);
  (answer.initial_material as { message_index: number }[])[0]!.message_index = 1;
  assert.throws(() => resolve(value), issue("finding_norm_not_read"));
  delete answer.initial_material;
  answer.initial_material = [];
  const task = value.request.input.task_analysis as unknown as AttributionResult["task_analysis"];
  task.requirements[0]!.text = long; task.requirements[0]!.acceptance_rule = task.requirements[0]!.text;
  setFixtureNormDirectory(value.request);
  assert.equal(resolve(value).findings[0]!.assessment.requirement_index, 0, "complete trusted criterion text is already visible");
});

test("final scope ignores forged request evidence and requires actual image viewing", () => {
  const value = scenario();
  (value.request.input.answer as Record<string, unknown>).final_evidence = value.directory[0]!.evidence;
  assert.equal(resolve(value).findings[0]!.evidence.at(-1)!.message_index, value.finalIndex);
  value.messages[2]!.attachments = [{ type: "image", mimeType: "image/png", data: "AA==" }];
  assert.throws(() => resolve(value), issue("final_image_not_viewed"));
  value.audit.viewedImages.push("answer:2");
  assert(!resolve(value).findings[0]!.evidence.some(item => item.quote.startsWith("[图像观察]")), "viewing an image does not automatically cite it");
});

test("explicit responsibility requires selected own evidence independently of normative context; every finding keeps its own program ID", () => {
  const value = scenario([{ role: "system", content: rule }, { role: "user", content: "计算2+2" },
    { role: "tool", type: "tool_result", name: "Calc", content: "2+2=4" }, { role: "assistant", content: "2+2=4" }]);
  const problem = { ...value.finding, type: "problem" as const, evidence: [value.ref(2), value.ref(3)],
    problem: { component: ["模型自身推理", "Calc"], label: "执行交付偏差", definition: "模型和工具责任分别核对。" } };
  value.submitted.findings = Array.from({ length: 9 }, () => structuredClone(problem));
  const result = resolve(value);
  assert.equal(result.findings.length, 9); assert.equal(result.findings[8]!.finding_id, "f8");
  assert.deepEqual(result.findings[8]!.problem!.component, ["模型自身推理", "Calc"]);
  assert.deepEqual(result.findings[8]!.evidence.map(item => item.quote), ["2+2=4", "2+2=4"]);
  problem.evidence = [value.ref(3)]; value.submitted.findings = [problem];
  assert.throws(() => resolve(value), issue("problem_component_evidence_missing"));
});

test("accepted canonical proof is validated without replaying selectors, rebinding a reordered directory, or appending scopes", () => {
  const value = scenario(), result = resolve(value), before = structuredClone(result);
  (value.request.input.answer as Record<string, unknown>).norm_directory = [...value.directory].reverse();
  value.registry.validate(value.binding, result, value.audit);
  assert.deepEqual(result, before);
  assert(!Object.hasOwn(result, "norm_directory"));
  assert.deepEqual(attributionNormDirectory(value.request).map(item => item.norm_index), value.directory.map(item => item.norm_index));
});
