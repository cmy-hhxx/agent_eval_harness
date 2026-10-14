import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { cite, evidenceSources, selectEvidenceSource } from "@eval/tools";
import { agentPrompt } from "@eval/prompts";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, attributionProfile, type AttributionResult } from "./index.js";
import { responsibilityChoices, responsibilityIssues, resolveProblemSubmission } from "./responsibility.js";
import example from "./fixtures/example.json" with { type: "json" };
import { attributionSubmission, setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";

const presentation = "回答呈现与采集", environment = "执行环境与权限配置";
function fixture(messages: unknown[], finalIndex = messages.length - 1) {
  const request = structuredClone(example.request) as AgentRequest;
  (request.sources.answer.value as { messages: unknown[] }).messages = messages;
  Object.assign(request.input.answer as object, { final_message_index: finalIndex,
    catalog: messages.map((value, message_index) => {
      const message = value as { type?: string; role?: string; name?: string };
      return { message_index, type: message.type ?? "message", role: message.role, name: message.name, chars: JSON.stringify(value).length };
    }) });
  const evidence = (index: number, path: string) => {
    const range = selectEvidenceSource(evidenceSources(messages[index]), path)!;
    assert(range, path);
    return cite(request.sources.answer.id, index, range.source, range.start, range.end);
  };
  const problem = (component: string[]) => ({ component, label: "实际交付失败", definition: "实际过程的异常导致最终交付失败。" });
  return { request, evidence, problem };
}
function processFixture() {
  return fixture([{ type: "message", role: "user", content: "生成结果并交付图表。" },
    { type: "message", role: "system", content: "工具应正确执行；图表应完整交付。" },
    { type: "tool_result", name: "Renderer", output: { status: "failed", result: "生产交付被截断，预期可访问的目录权限被错误配置。" } },
    { type: "final_answer", role: "assistant", content: "用户收到的图表被截断，结果未能完整交付。" }]);
}
const missing = (error: unknown) => error instanceof ValidationError && error.issues!.some(issue => issue.code === "problem_component_evidence_missing");

test("new responsibility choices require actual process records rather than instructions or pure final text", () => {
  const f = fixture([{ type: "message", role: "system", content: "渲染及执行环境须正确。" },
    { type: "final_answer", role: "assistant", content: "2+2=4" }]);
  assert.deepEqual(responsibilityChoices(f.request), ["模型自身推理"]);
  for (const component of [presentation, environment]) {
    assert.throws(() => resolveProblemSubmission(f.request, f.problem([component]), [f.evidence(0, "/content"), f.evidence(1, "/content")], "/problem"), missing);
    assert.throws(() => resolveProblemSubmission(f.request, f.problem([component]), [f.evidence(1, "/content")], "/problem"), missing);
  }
});

test("presentation and environment responsibilities require their own process plus final delivery", () => {
  const f = processFixture(), process = f.evidence(2, "/output/result"), final = f.evidence(3, "/content"), norm = f.evidence(1, "/content");
  assert.deepEqual(responsibilityChoices(f.request), ["模型自身推理", "Renderer", presentation, environment]);
  for (const component of [presentation, environment]) {
    assert.deepEqual(resolveProblemSubmission(f.request, f.problem([component]), [process, final], "/problem").component, [component]);
    for (const insufficient of [[norm, final], [final], [process], [{ ...process, source: "peer", source_input_id: "22222222-2222-4222-8222-222222222222" }, final]])
      assert.throws(() => resolveProblemSubmission(f.request, f.problem([component]), insufficient, "/problem"), missing);
  }
});

test("matched model output supports presentation, while model-input norms and independent planning do not", () => {
  const f = fixture([{ type: "message", role: "user", content: "生成图表。" },
    { type: "llm_turn", input_messages: [{ role: "system", content: "图表须可用。" }], output: [{ role: "assistant", content: "交付图表。" }] },
    { type: "llm_turn", input_messages: [{ role: "system", content: "独立规划。" }], output: [{ role: "assistant", content: "独立规划结果。" }] },
    { type: "final_answer", role: "assistant", content: "交付图表。" }]);
  assert(responsibilityChoices(f.request).includes(presentation)); assert(!responsibilityChoices(f.request).includes(environment));
  const final = f.evidence(3, "/content"), generated = f.evidence(1, "/output/0/content");
  assert.deepEqual(responsibilityIssues(f.request, f.problem([presentation]), [generated, final], "/problem"), []);
  for (const process of [f.evidence(1, "/input_messages/0/content"), f.evidence(1, "/input_messages"), f.evidence(2, "/output/0/content")])
    assert.throws(() => resolveProblemSubmission(f.request, f.problem([presentation]), [process, final], "/problem"), missing);
  assert.throws(() => resolveProblemSubmission(f.request, f.problem([environment]), [generated, final], "/problem"), missing);
});

test("captured visual placeholders do not establish a production presentation fault or matched generation", () => {
  const generated = '2+2=4\n<vis-jgy ref="visual-1"/>', captured = '2+2=4\n{"jgy_visual":"skipped","ref":"visual-1"}';
  const f = fixture([{ type: "message", role: "user", content: "计算2+2" },
    { type: "llm_turn", input_messages: [{ role: "user", content: "计算2+2" }], output: [{ role: "assistant", content: generated }] },
    { type: "final_answer", role: "assistant", content: captured }]);
  assert.deepEqual(responsibilityChoices(f.request), ["模型自身推理"]);
  assert.throws(() => resolveProblemSubmission(f.request, f.problem([presentation]), [f.evidence(1, "/output/0/content"), f.evidence(2, "/content")], "/problem"), missing);
  const prompt = agentPrompt("attribution", []).instructions;
  assert.match(prompt, /生成标签被采集成 JSON.*资源已 resolved.*评测截图没有图.*不能单独证明用户看不到图/su);
  assert.match(prompt, /纯采集缺口属于评审材料缺口.*不给候选记 problem/su);
});

test("an explicit ETF inference can locate model responsibility without input snapshots", () => {
  const f = fixture([{ type: "message", role: "user", content: "推荐场外基金。" },
    { type: "final_answer", role: "assistant", content: "场内ETF规模很大，因此场外联接基金跟踪误差更小。" }]);
  const problem = { component: ["模型自身推理"], label: "把规模推成跟踪优势", definition: "由场内ETF规模直接推出场外联接跟踪误差更小，缺少支持这一关系的依据。" };
  assert.deepEqual(resolveProblemSubmission(f.request, problem, [f.evidence(1, "/content")], "/problem"), problem);
  const prompt = agentPrompt("attribution", []).instructions;
  assert.match(prompt, /最终回答中明确呈现的错误请求、算式或推导可直接作为模型责任证据，不因缺少实际输入快照留空/u);
});

test("a visible violation of a verified own instruction does not require input snapshots for model responsibility", () => {
  const f = fixture([{ type: "message", role: "user", content: "回答以风险提示开头。" },
    { type: "final_answer", role: "assistant", content: "先给交易建议，最后才提示风险。" }]);
  const problem = { component: ["模型自身推理"], label: "风险提示顺序不符", definition: "本方已给出的开头风险提示要求被放到了末尾。" };
  assert.deepEqual(resolveProblemSubmission(f.request, problem, [f.evidence(0, "/content"), f.evidence(1, "/content")], "/problem"), problem);
  assert.match(agentPrompt("attribution", []).instructions, /本方已给指令及其触发条件已核实、最终行为明确违反时，也可直接归模型，无须先取得实际输入快照/u);
});

test("normal access denial does not automatically become a tool or environment fault", () => {
  const f = fixture([{ type: "message", role: "user", content: "读取未授权文件。" },
    { type: "tool_result", name: "FileReader", output: { status: "denied", reason: "策略正常禁止访问未授权目录。" } },
    { type: "final_answer", role: "assistant", content: "该文件未授权，无法读取。" }]);
  assert.deepEqual(resolveProblemSubmission(f.request, f.problem([]), [f.evidence(1, "/output"), f.evidence(2, "/content")], "/problem").component, []);
  const prompt = agentPrompt("attribution", []).instructions;
  assert.match(prompt, /正常权限拒绝、安全拦截和不受支持的请求不算工具自身错误/u);
  assert.match(prompt, /模型请求越权或误用工具仍按具体请求定位，不把正常限制当环境故障/u);
});

test("a component cannot borrow another tool's proof or treat norms as operational evidence", () => {
  const f = fixture([{ type: "message", role: "user", content: "生成结果。" },
    { type: "tool_result", name: "Renderer", output: "生产渲染故障。" },
    { type: "tool_result", name: "FileReader", output: "正常返回文件。" },
    { type: "final_answer", role: "assistant", content: "渲染失败。" }]);
  const selected = [f.evidence(1, "/output"), f.evidence(3, "/content")];
  const issues = responsibilityIssues(f.request, f.problem([presentation, "FileReader"]), selected, "/problem");
  assert.deepEqual(issues.map(issue => issue.actual), ["FileReader"]);
  assert.throws(() => resolveProblemSubmission(f.request, f.problem(["上下文组装与传递"]), selected, "/problem"), missing);
});

test("new responsibilities pass the dynamic submission schema and formal validation with real process and delivery", () => {
  const f = fixture([{ type: "message", role: "user", content: "计算2+2" },
    { type: "tool_result", name: "Renderer", output: "生产交付被截断：预期允许的目录被错误配置为禁止访问。" },
    { type: "final_answer", role: "assistant", content: "2+2=4。附图在实际交付中被截断。" }]);
  const final = f.evidence(2, "/content"), process = f.evidence(1, "/output");
  Object.assign(f.request.input.answer as object, { final_answer: final.quote, final_evidence: [final] });
  setFixtureNormDirectory(f.request);
  const schema = attributionProfile.modelSubmissionSchema!(f.request) as { properties: { problems: { items: { properties: { component: { items: { enum: string[] } } } } } } };
  assert(schema.properties.problems.items.properties.component.items.enum.includes(presentation));
  assert(schema.properties.problems.items.properties.component.items.enum.includes(environment));
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] };
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [final]; result.findings[0].evidence = [final]; result.criterion_assessments.forEach(row => row.evidence = [final]);
  result.findings.push({ ...structuredClone(result.findings[0]), finding_id: "f1", type: "problem", dimension: "format", importance: "low",
    text: "附图交付被截断。", reason: "执行记录显示错误权限配置，实际最终附图交付被截断。", evidence: [process, final],
    assessment: { requirement_index: null, observation: "实际交付图表被截断。", evidence_status: "established", impact: "不影响加法结果，但附图不可用。" },
    problem: { component: [presentation, environment], label: "实际交付被截断", definition: "环境的错误权限配置影响生产呈现，实际附图交付被截断。" } });
  const registry = new AgentRegistry([attributionAgent]), binding = { agent: "attribution", profile: "default", request: f.request };
  const draft = attributionSubmission(f.request, result, audit), accepted = registry.resolve(binding, draft, audit) as AttributionResult;
  registry.validate(binding, accepted, audit); assert.deepEqual(accepted.findings[1].problem!.component, [presentation, environment]);
  accepted.findings[1].evidence = [final]; assert.throws(() => registry.validate(binding, accepted, audit), missing);
});

test("responsibility follows verified defects rather than different metrics or a forced failure taxonomy", () => {
  const prompt = agentPrompt("attribution", []).instructions;
  assert.match(prompt, /均线与期间最低价等不同指标可以同时正确，不能仅因数值不同判前后矛盾/u);
  assert.match(prompt, /不强套类别或把普通优点、局部缺陷都写成关键步骤失败/u);
  assert.match(prompt, /每个责任方分别说明自己的失误及如何传到最终结果，不借其他责任方的证据/u);
});
