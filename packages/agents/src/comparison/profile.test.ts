import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ValidationError, type AgentRequest, type CriteriaInput, type TaskAnalysis, type ToolAudit } from "@eval/contracts";
import { criteriaProfile, criteriaSources } from "@eval/agents/criteria";
import { comparisonAgent, comparisonProfile, comparisonSlots } from "./index.js";
import { AgentRegistry } from "@eval/host";
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import type { ComparisonInput, ComparisonResult } from "./types.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const validate = (request: AgentRequest, result: unknown, reads = audit) => comparisonProfile.validate!(request, result, reads);
const pair = () => ({ request: structuredClone(example.request), result: structuredClone(example.result) as ComparisonResult });
const submission = (result: ComparisonResult, request: AgentRequest) => requestComparisonSubmission(request,result);
const resolve = (data: ReturnType<typeof pair>) => comparisonProfile.resolve!(data.request, submission(data.result,data.request), audit) as ComparisonResult;
const review = () => {
  const data = pair();
  data.result.status = "needs_review";
  data.result.ranking = [];
  data.result.decision_basis.decisive_findings = [];
  data.result.review_requests.push({ candidate: "A", criterion_ids: ["sum"], finding_indices: [], reason: "来源遗漏，需要复核最终表格。" } as never);
  return data;
};

test("shared Criteria source combinations keep instruction provenance in either source order", () => {
  const norm = "# 输出规范\n\n严格使用JSON。";
  for (const normFirst of [true, false]) {
    const data = pair(), input = data.request.input as unknown as ComparisonInput;
    const criteriaInput: CriteriaInput = { question: "计算2+2", ground_truth: { available: true, value: "4" },
      candidates: Object.values(input.candidates).map(candidate => ({ candidate_id: candidate.candidate_id,
        instructions: [], context: [{ message_index: 0, role: "user", content: norm }] })) };
    const criteriaRequest: AgentRequest = { input: criteriaInput as unknown as AgentRequest["input"], sources: {} };
    const common = criteriaSources(criteriaInput).find(source => source.kind === "context")!;
    assert.deepEqual(common.applies_to, []);
    const source_indices = normFirst ? [common.source_index, 1] : [1, common.source_index];
    const task = criteriaProfile.resolve!(criteriaRequest, { requirements: [{ source_indices, text: "用JSON给出计算结果。" },
      { source_indices: criteriaSources(criteriaInput).filter(source => ["question", "reference", "quality"].includes(source.kind))
        .map(source => source.source_index), text: "核查计算结果的准确性与表达。" }], scoring_points: [], red_flags: [] }, audit) as TaskAnalysis;
    criteriaProfile.validate!(criteriaRequest, task, audit);
    assert.deepEqual(task.requirements[0]!.applies_to, []);
    input.task_analysis = task;
    assert.deepEqual(task.requirements.map(criterion => criterion.id), ["r1", "r2"]);
    data.result.decision_basis.comparisons[0]!.criterion_ids = ["r1"];
    for (const label of ["A", "B"] as const) {
      const final = label === "A" ? '{"answer":4}' : "2+2=4";
      input.candidates[label]!.final_message_index = 2;
      data.request.sources[label]!.value.messages = [{ type: "message", role: "user", content: norm },
        { type: "message", role: "user", content: criteriaInput.question },
        { type: "message", role: "assistant", content: final }];
      const attribution = input.attributions[label]!;
      attribution.task_analysis = structuredClone(task);
      attribution.criterion_assessments[0]!.criterion_id = "r1";
      attribution.core_assessment.criterion_ids = attribution.core_assessment.criterion_ids.map(() => "r1");
      attribution.criterion_assessments.push({ criterion_id: "r2", status: "met", evidence_status: "established",
        summary: "数值与标准4一致。" });
      attribution.findings[0]!.evidence = [canonicalEvidence(data.request.sources[label]!.id, 2, final)];
    }
    input.attributions.A!.findings[0]!.dimension = "instruction_following";
    input.attributions.A!.findings[0]!.text = "使用共同规范要求的JSON格式交付正确数值。";
    input.attributions.A!.findings[0]!.evidence.unshift(canonicalEvidence(data.request.sources.A.id, 0, norm));
    input.attributions.B!.criterion_assessments[0]!.status = "partial";
    data.result.decision_basis.comparisons[0]!.better_candidates = ["A"];
    data.result.decision_basis.comparisons.push({ aspect: "数值正确性", criterion_ids: ["r2"], importance: "high",
      better_candidates: [], assessments: {
        A: { summary: "数值4正确。", finding_indices: [], status: "met", evidence_status: "established" },
        B: { summary: "数值4正确。", finding_indices: [], status: "met", evidence_status: "established" },
      } });
    data.result.ranking = [["A"], ["B"]];
    const source = structuredClone(input.attributions), result = resolve(data);
    validate(data.request, result);
    assert.deepEqual(result.ranking, [["A"], ["B"]]);
    assert.deepEqual(input.attributions, source);
  }
});

test("an own-system instruction finding cannot gain common scope through a wrong requirement index", () => {
  const data = pair();
  const input = data.request.input as unknown as ComparisonInput;
  const rule = "回答须以风险提示开头。";
  data.request.sources.A.value.messages[0] = { type: "message", role: "system", content: rule };
  input.attributions.A.findings[0].dimension = "instruction_following";
  input.attributions.A.findings[0].evidence.unshift(canonicalEvidence(data.request.sources.A.id, 0, rule));
  // The explicit norm is real, while index 0 still addresses the shared arithmetic task.
  data.result.decision_basis.comparisons[0].better_candidates = ["A"];
  data.result.ranking = [["A"], ["B"]];
  assert.throws(() => validate(data.request, data.result), /来源规范.*共同 requirement/);
  data.request.sources.A.value.messages[0].content = `# 输出规范\n\n${input.task_analysis.requirements[0].text}\n\n仅数据交付时使用JSON；其他情况使用普通文本。`;
  input.attributions.A.findings[0].evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, input.task_analysis.requirements[0].text, "/content", 8);
  assert.throws(() => validate(data.request, data.result), /来源规范.*共同 requirement/,
    "a sentence inside a larger normative section cannot replace that complete source block");
  data.result.decision_basis.comparisons[0].better_candidates = [];
  data.result.decision_basis.decisive_findings = [];
  data.result.ranking = [["A", "B"]];
  validate(data.request, data.result);

  // A genuinely shared USER requirement may still establish an instruction advantage.
  data.request.sources.A.value.messages[0] = { type: "message", role: "user", content: input.task_analysis.requirements[0].text };
  input.attributions.A.findings[0].evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, input.task_analysis.requirements[0].text);
  data.result.decision_basis.comparisons[0].better_candidates = ["A"];
  data.result.ranking = [["A"], ["B"]];
  validate(data.request, data.result);
});

test("a format finding with an explicitly cited complete private SYSTEM norm cannot decide the pair", () => {
  for (const requirementIndex of [null, 0]) {
    const data = pair(), input = data.request.input as unknown as ComparisonInput;
    const norm = "# 输出规范\n\n回答须以风险提示开头。";
    data.request.sources.A.value.messages[0] = { type: "message", role: "system", content: norm };
    const finding = input.attributions.A.findings[0]!;
    finding.dimension = "format";
    finding.assessment.requirement_index = requirementIndex;
    finding.evidence.unshift(canonicalEvidence(data.request.sources.A.id, 0, norm));
    data.result.decision_basis.comparisons[0]!.better_candidates = ["A"];
    data.result.ranking = [["A"], ["B"]];
    const acceptedSource = structuredClone(input.attributions);
    assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
      ["comparison_advantage_scope_mismatch", "comparison_advantage_finding_scope_mismatch", "decisive_finding_scope_mismatch", "preference_unproven"].some(code =>
        error.issues?.some(issue => issue.code === code)));
    assert.deepEqual(input.attributions, acceptedSource);
    data.result.decision_basis.comparisons[0]!.better_candidates = [];
    data.result.decision_basis.decisive_findings = [];
    data.result.ranking = [["A", "B"]];
    validate(data.request, data.result);
  }
});

test("mixed common and private SYSTEM blocks restrict any finding dimension until its private evidence is removed", () => {
  for (const dimension of ["format", "correctness"] as const) {
    const data = pair(), input = data.request.input as unknown as ComparisonInput;
    const common = `# 共同要求\n\n${input.task_analysis.requirements[0]!.text}`;
    const privateNorm = "# 自身输出规约\n\n回答须以风险提示开头。";
    input.task_analysis.requirements[0]!.text = common; input.task_analysis.requirements[0]!.acceptance_rule = input.task_analysis.requirements[0]!.text;
    for (const attribution of Object.values(input.attributions)) attribution.task_analysis = structuredClone(input.task_analysis);
    data.request.sources.A.value.messages[0] = { type: "message", role: "system", content: `${common}\n\n${privateNorm}` };
    data.result.task_analysis=structuredClone(input.task_analysis);
    const finding = input.attributions.A.findings[0]!;
    finding.dimension = dimension;
    finding.assessment.requirement_index = null;
    finding.evidence.unshift(canonicalEvidence(data.request.sources.A.id, 0, `${common}\n\n${privateNorm}`));
    data.result.decision_basis.comparisons[0]!.better_candidates = ["A"];
    data.result.ranking = [["A"], ["B"]];
    assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
      error.issues?.some(issue => ["comparison_advantage_finding_scope_mismatch","comparison_advantage_scope_mismatch"].includes(issue.code)) === true);
    finding.evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, common);
    data.result.task_analysis=structuredClone(input.task_analysis);
    validate(data.request, data.result);
    finding.evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, privateNorm, "/content", common.length + 2);
    assert.throws(() => validate(data.request, data.result), /专有要求|来源规范.*共同 requirement/);
  }
});

test("ordinary format evidence and complete common SYSTEM or USER norms remain eligible for comparison", () => {
  for (const role of [undefined, "system", "user"] as const) {
    const data = pair(), input = data.request.input as unknown as ComparisonInput;
    const finding = input.attributions.A.findings[0]!;
    finding.dimension = "format";
    finding.assessment.requirement_index = null;
    if (role) {
      const common = input.task_analysis.requirements[0]!.text;
      for (const label of ["A", "B"] as const)
        data.request.sources[label].value.messages[0] = { type: "message", role, content: common };
      finding.evidence.unshift(canonicalEvidence(data.request.sources.A.id, 0, common));
    }
    data.result.decision_basis.comparisons[0]!.better_candidates = ["A"];
    data.result.ranking = [["A"], ["B"]];
    validate(data.request, data.result);
  }
});

test("private norm detection requires all real content-leaf origins and does not match a short partial quote", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  const heading = "# 自身输出规约", body = "回答须以风险提示开头。", exception = "事实查询时可以不前置风险提示。";
  const raw = data.request.sources.A.value as { messages: unknown[] };
  raw.messages[0] = { type: "message", role: "system", content: [
    { type: "input_text", text: heading }, { type: "input_text", text: body }, { type: "input_text", text: exception },
  ] };
  const finding = input.attributions.A.findings[0]!, answer = structuredClone(finding.evidence);
  finding.dimension = "format";
  finding.assessment.requirement_index = null;
  data.result.decision_basis.comparisons[0]!.better_candidates = ["A"];
  data.result.ranking = [["A"], ["B"]];
  for (const quotes of [["风险提示"], [body], [heading, body]]) {
    finding.evidence = [...answer, ...quotes.map(quote => canonicalEvidence(data.request.sources.A.id, 0, quote, `/content/${quote === heading ? 0 : 1}/text`, quote === "风险提示" ? 5 : 0))];
    data.result.task_analysis=structuredClone(input.task_analysis);
    validate(data.request, data.result);
  }
  finding.evidence.push(canonicalEvidence(data.request.sources.A.id, 0, exception, "/content/2/text"));
  assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
    error.issues?.some(issue => ["comparison_advantage_finding_scope_mismatch","comparison_advantage_scope_mismatch"].includes(issue.code)) === true);
  input.task_analysis.requirements[0]!.text += `\n\n${heading}\n${body}\n${exception}`;
  input.task_analysis.requirements[0]!.acceptance_rule = input.task_analysis.requirements[0]!.text;
  for (const attribution of Object.values(input.attributions)) attribution.task_analysis = structuredClone(input.task_analysis);
  data.result.task_analysis=structuredClone(input.task_analysis);
    validate(data.request, data.result);
});

test("a complete shared USER leaf keeps pair scope without absorbing its appended private condition", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  const question = input.task_analysis.requirements[0]!.text, condition = "本回答的投资建议须以风险提示开头。";
  const raw = data.request.sources.A.value as { messages: { role?: string; content: unknown }[] };
  raw.messages[0] = { role: "user", content: [{ type: "input_text", text: question }, { type: "input_text", text: condition }] };
  const finding = input.attributions.A.findings[0]!;
  finding.dimension = "instruction_following";
  finding.evidence.unshift(canonicalEvidence(data.request.sources.A.id, 0, question, "/content/0/text"));
  data.result.decision_basis.comparisons[0]!.better_candidates = ["A"];
  data.result.ranking = [["A"], ["B"]];
  validate(data.request, data.result);
  finding.evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, condition, "/content/1/text");
  assert.throws(() => validate(data.request, data.result), /来源规范.*共同 requirement/);
});

test("a mixed public and private instruction quote cannot establish a shared instruction advantage", () => {
  for (const role of ["user", "system"]) {
    const data = pair(), input = data.request.input as unknown as ComparisonInput;
    const question = input.task_analysis.requirements[0]!.text, privateRule = "本回答须以风险提示开头。";
    const mixed = `${question}\n\n${privateRule}`;
    data.request.sources.A.value.messages[0] = { type: "message", role, content: mixed };
    const finding = input.attributions.A.findings[0]!;
    finding.dimension = "instruction_following";
    finding.evidence.unshift(canonicalEvidence(data.request.sources.A.id, 0, mixed));
    data.result.decision_basis.comparisons[0]!.better_candidates = ["A"];
    data.result.ranking = [["A"], ["B"]];
    assert.throws(() => validate(data.request, data.result), /来源规范.*共同 requirement/);
    finding.evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, privateRule, "/content", question.length + 2);
    assert.throws(() => validate(data.request, data.result), /来源规范.*共同 requirement/);
    finding.evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, question);
    validate(data.request, data.result);
    finding.evidence[0] = canonicalEvidence(data.request.sources.A.id, 0, question.slice(0, -1));
    assert.throws(() => validate(data.request, data.result), /来源规范.*共同 requirement/);
  }
});

test("a located review request resolves without first constructing a complete comparison matrix", () => {
  const data = review();
  Object.assign(data.request.input, { source_review: { A: [{ kind: "unverified", reason: "最终表有未核实来源行。", requires_review: true }] } });
  const draft = submission(data.result,data.request);
  const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
  assert.deepEqual(result.ranking, []);
  assert.deepEqual(result.decision_basis.comparisons, []);
  assert.deepEqual(result.decision_basis.decisive_findings, []);
  assert.equal(result.assessments.A.meets_core, null);
  assert.deepEqual(result.assessments.A.core_failure_refs, []);
  assert.equal(result.assessments.B.meets_core, true);
  validate(data.request, result);
  assert.throws(() => comparisonProfile.resolve!(data.request, { ...draft, ranking: [], decision_basis: data.result.decision_basis }, audit));
  const decided = pair();
  decided.result.decision_basis.comparisons = [];
  assert.throws(() => validate(decided.request, decided.result), /1 items/);
  for (const item of result.review_requests) item.candidate = "B";
  assert.throws(() => validate(data.request, result), /来源核验/);
});

test("review requests cannot leave an unknown assessment unreviewed or send a blank reason", () => {
  const data = review();
  data.result.assessments.B.meets_core = null;
  assert.throws(() => validate(data.request, data.result), /核心状态未决/);
  data.result.assessments.B.meets_core = true;
  data.result.review_requests[0].reason = "   ";
  assert.throws(() => validate(data.request, data.result), /复核原因不能为空/);
});

test("unresolved source table evidence requires independent review instead of a decided ranking", () => {
  const data = pair();
  Object.assign(data.request.input, { source_review: { A: [{ kind: "unresolved_conflict", reason: "原始来源与最终代码/名称对应仍有冲突。", requires_review: true }] } });
  assert.throws(() => validate(data.request, data.result), (error: unknown) =>
    error instanceof Error && error.message.includes("来源核验"));
  const pending = review();
  Object.assign(pending.request.input, { source_review: { A: [{ kind: "unresolved_conflict", reason: "原始来源与最终代码/名称对应仍有冲突。", requires_review: true }] } });
  validate(pending.request, pending.result);
});

test("unknown core evidence requests review of the unresolved candidate and its core criteria", () => {
  const data = review();
  data.request.input.attributions.A.core_assessment.meets_core = null as unknown as boolean;
  data.request.input.attributions.A.criterion_assessments[0].status = "unknown";
  data.request.input.attributions.A.criterion_assessments[0].evidence_status = "uncertain";
  data.result.assessments.A.meets_core = null;
  data.result.decision_basis.comparisons[0].assessments.A.status = "unknown";
  data.result.decision_basis.comparisons[0].assessments.A.evidence_status = "uncertain";
  validate(data.request, data.result);
  data.result.review_requests[0].candidate = "B";
  assert.throws(() => validate(data.request, data.result), /核心状态未决/);
  data.result.review_requests[0].candidate = "A";
  data.result.review_requests[0].criterion_ids = [];
  data.result.review_requests[0].finding_indices = [0];
  assert.throws(() => validate(data.request, data.result), /核心状态未决/);
});

test("source-review records distinguish a retained unknown from a blocking conflict", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  input.attributions.B.core_assessment.meets_core = false;
  input.attributions.B.core_assessment.criterion_ids = [input.task_analysis.requirements[0].id];
  input.attributions.B.criterion_assessments[0].status = "unmet";
  input.source_review = { B: [{ kind: "unverified", reason: "另有来源未展示行，保留未知，不作为已确认错误。", requires_review: false }] };
  const draft = submission(data.result,data.request);

  const before = structuredClone(data.request);
  const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
  validate(data.request, result);
  assert.deepEqual(data.request, before);
  assert.equal(result.assessments.B.meets_core, false);
  input.source_review.B[0].requires_review = true;
  assert.throws(() => validate(data.request, result), /来源核验/);
});

test("source blockers are program-owned after a single structural repair", () => {
 const data = pair(), registry = new AgentRegistry([comparisonAgent]);
 Object.assign(data.request.input,{ source_review:{ A:[{ kind:"unverified", reason:"尚缺影响结果的来源行。",requires_review:true }] } });
 const draft = submission(data.result,data.request); draft.a_tradeoff = "";
 assert.throws(() => registry.resolve({ agent:"comparison",profile:"default",request:data.request },draft,audit),
  (error:unknown) => error instanceof ValidationError && error.issues!.every(issue => issue.category === "structure"));
 draft.a_tradeoff = "来源尚待核查。";
 const result = registry.resolve({ agent:"comparison",profile:"default",request:data.request },draft,audit) as ComparisonResult;
 assert.equal(result.status,"needs_review"); assert.equal(result.review_requests[0].candidate,"A");
 registry.validate({ agent:"comparison",profile:"default",request:data.request },result,audit);
});

test("source-review schema keeps invalid material blocking without deciding literal differences", () => {
  const data = pair(), validator = new Ajv2020({ strict: false }).compile(comparisonProfile.requestSchema);
  Object.assign(data.request.input, { source_review: { A: [{ kind: "unverified", reason: "未确认的行。", requires_review: false }] } });
  assert(validator(data.request.input), JSON.stringify(validator.errors));
  for (const kind of ["unresolved_conflict", "invalid_material"]) {
    const input = structuredClone(data.request.input) as unknown as ComparisonInput;
    input.source_review!.A[0].kind = kind as "unresolved_conflict" | "invalid_material";
    assert.equal(validator(input), kind !== "invalid_material");
    input.source_review!.A[0].requires_review = true;
    assert(validator(input), JSON.stringify(validator.errors));
  }
  const missing = structuredClone(data.request.input);
  delete (missing as unknown as { source_review: { A: Record<string, unknown>[] } }).source_review.A[0].requires_review;
  assert.equal(validator(missing), false);
});
const fail = (data: ReturnType<typeof pair>, label: "A" | "B") => {
  const attribution = data.request.input.attributions[label];
  attribution.core_assessment.meets_core = false;
  attribution.core_assessment.criterion_ids = ["sum"];
  attribution.criterion_assessments[0].status = "unmet";
  attribution.findings[0].type = "problem";
  data.result.assessments[label].meets_core = false;
  data.result.assessments[label].core_failure_refs = ["sum"];
  data.result.decision_basis.comparisons[0].assessments[label].status = "unmet";
};
const privateRisk = (data: ReturnType<typeof pair>) => {
  const input = data.request.input as unknown as ComparisonInput;
  input.task_analysis.requirements.push({ id: "own_risk", text: "本方风险提示置首。",
    applies_to: [input.candidates.A.candidate_id], acceptance_rule: "按本方原始要求核验提示位置。" });
  for (const label of ["A", "B"] as const) {
    input.attributions[label].task_analysis = structuredClone(input.task_analysis);
    data.request.input.attributions[label].criterion_assessments.push({ criterion_id: "own_risk",
      status: label === "A" ? "unmet" : "not_applicable", evidence_status: "established",
      summary: label === "A" ? "风险在结论后。" : "此条仅评审A，材料未提供本方同等约束。",
      evidence: label === "A" ? structuredClone(data.request.input.attributions.A.criterion_assessments[0].evidence) : [] });
  }
  data.result.task_analysis = structuredClone(input.task_analysis);
  data.result.decision_basis.comparisons.push({ aspect: "本方风险提示位置", criterion_ids: ["own_risk"],
    importance: "low", better_candidates: [], assessments: {
      A: { summary: "风险在结论后，未遵守本方顺序。", finding_indices: [], status: "unmet", evidence_status: "established" },
      B: { summary: "此条仅评审A，材料未提供本方同等约束。", finding_indices: [], status: "not_applicable", evidence_status: "established" },
    } });
  return input;
};
const privateTime = () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  input.task_analysis.requirements.push({ id: "r9", text: "## 时间、行情和比较\n\n先读取 user prompt 中的当前时间及其时区，确定唯一的今天 D0、昨天 D0-1 个日历日、明天 D0+1 个日历日。事实日期以数据行的实际日期、搜索结果的 published_date 或正文中的明确日期为准；只有完全对应时才能使用今天、昨天、明天，否则写明确日期、截至该日期、最近交易日或最新可用数据。",
    applies_to: [input.candidates.B.candidate_id], acceptance_rule: "按自身完整时间规范核验实际回答。" });
  for (const label of ["A", "B"] as const) {
    input.attributions[label].task_analysis = structuredClone(input.task_analysis);
    input.attributions[label].criterion_assessments.push({ criterion_id: "r9",
      status: label === "B" ? "met" : "not_applicable", evidence_status: "established",
      summary: label === "B" ? "使用明确的数据日期。" : "仅适用B的时间规范。" });
  }
  data.result.task_analysis = structuredClone(input.task_analysis);
  return data;
};











test("Comparison accepts an independently judged pair and mirrors the shared analysis", () => {
  assert.deepEqual(Object.keys(comparisonAgent.profiles), ["default", "verification"]);
  validate(example.request, example.result);
  const draft = submission(example.result as ComparisonResult,example.request);
  const resolved = comparisonProfile.resolve!(example.request, draft, audit) as typeof example.result;
  assert.deepEqual(resolved.task_analysis, example.request.input.task_analysis);
  assert.notEqual(resolved.task_analysis, example.request.input.task_analysis);
  assert.deepEqual(resolved.assessments, example.result.assessments);
  assert.deepEqual(resolved.decision_basis.comparisons[0].criterion_ids,["sum"]);
  assert.deepEqual(resolved.decision_basis.comparisons[0].assessments.A.finding_indices,[0]);
  assert.equal(resolved.decision_basis.tradeoff,"相对更倾向【候选A】。【候选A】：正确给出结果。 【候选B】：正确给出结果。");
  validate(example.request, resolved);
  assert.throws(() => comparisonProfile.resolve!(example.request, example.result, audit), /additional properties/);
  const changed = pair(); changed.result.task_analysis.goal = "新目标";
  assert.throws(() => validate(changed.request, changed.result), /不得增加、改写或删除/);
  const localError = pair(); localError.request.input.attributions.A.is_correct = false;
  validate(localError.request, localError.result);
});

test("submissions reject source state fields and resolution preserves source core failures", () => {
  const data = pair(); fail(data, "A"); data.result.ranking = [["B"], ["A"]];
  const draft = submission(data.result,data.request);
  const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
  assert.equal(result.assessments.A.meets_core, false);
  assert.deepEqual(result.assessments.A.core_failure_refs, ["sum"]);
  assert.equal(result.decision_basis.comparisons[0].assessments.A.status, "unmet");
  validate(data.request, result);
  assert.deepEqual(draft, submission(data.result,data.request), "resolution must not mutate the model submission");
  for (const field of ["meets_core", "core_failure_refs"]) {
    const invalid = structuredClone(draft);
    Object.assign(invalid, { [field]: result.assessments.A[field as "meets_core" | "core_failure_refs"] });
    assert.throws(() => comparisonProfile.resolve!(data.request, invalid, audit), /additional properties/);
  }
  for (const field of ["status", "evidence_status"]) {
    const invalid = structuredClone(draft);
    Object.assign(invalid.comparisons[0]!, { [field]: "met" });
    assert.throws(() => comparisonProfile.resolve!(data.request, invalid, audit), /additional properties/);
  }
  const invalid = structuredClone(draft);
  (invalid as unknown as Record<string, unknown>)["候选A"] = invalid.a_summary;
  delete (invalid as unknown as Record<string,unknown>).a_summary;
  assert.throws(() => comparisonProfile.resolve!(data.request, invalid, audit), /additional properties|required property/);
});

test("01868 mixed core criteria derive only the established failed requirement without changing attribution", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  input.task_analysis.requirements = [
    { id: "r1", text: "查询指定指标", applies_to: [], acceptance_rule: "回答目标指标。" },
    { id: "r2", text: "同比变化正确", applies_to: [], acceptance_rule: "给出标准答案 -0.6 个百分点。" },
    { id: "r3", text: "过程说明完整", applies_to: [input.candidates.B.candidate_id], acceptance_rule: "说明计算依据。" },
    { id: "r4", text: "完成最终交付", applies_to: [input.candidates.B.candidate_id], acceptance_rule: "给出可读最终回答。" },
  ];
  for (const label of ["A", "B"] as const) {
    const attribution = input.attributions[label];
    attribution.task_analysis = structuredClone(input.task_analysis);
    attribution.criterion_assessments = input.task_analysis.requirements.map(({ id }) => ({
      criterion_id: id, evidence_status: "established", evidence: [], summary: "已核对来源。",
      status: label === "A" ? (["r3", "r4"].includes(id) ? "not_applicable" : "met")
        : id === "r2" ? "unmet" : id === "r3" ? "partial" : "met",
    }));
    attribution.core_assessment = label === "A"
      ? { meets_core: true, criterion_ids: ["r1", "r2"], reason: "核心数值正确。" }
      : { meets_core: false, criterion_ids: ["r1", "r2", "r4"], reason: "回答 +1.25 个百分点，与标准 -0.6 方向相反。" };
  }
  input.attributions.B.findings[0].type = "problem";
  data.result.ranking = [["A"], ["B"]];
  data.result.decision_basis.comparisons[0].criterion_ids = ["r1", "r2", "r3", "r4"];
  const source = structuredClone(input.attributions), result = resolve(data);
  assert.equal(result.assessments.B.meets_core, false);
  assert.deepEqual(result.assessments.B.core_failure_refs, ["r2"]);
  assert.deepEqual(input.attributions, source, "Comparison must preserve accepted Attribution verdicts and context criteria");
  validate(data.request, result);
  result.assessments.B.core_failure_refs = ["r1", "r2", "r4"];
  assert.throws(() => validate(data.request, result), (error: unknown) => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "core_failure_refs_mismatch") &&
    error.issues!.some(issue => issue.code === "core_failure_unproven" && issue.actual === "r1"));
});

test("resolution aggregates applicable source criteria and preserves uncertain findings", () => {
  const data = pair();
  const partial = { id: "detail", text: "补全细节", applies_to: [], acceptance_rule: "给出全部细节。" };
  data.request.input.task_analysis.scoring_points.push(partial as never);
  data.result.decision_basis.comparisons[0].criterion_ids.push("detail");
  for (const label of ["A", "B"] as const) {
    const source = data.request.input.attributions[label];
    source.task_analysis = structuredClone(data.request.input.task_analysis);
    source.criterion_assessments.push({ criterion_id: "detail", status: label === "A" ? "partial" : "unknown",
      evidence_status: label === "A" ? "established" : "uncertain", summary: "细节核对。", evidence: [] });
  }
  const result = resolve(data);
  assert.equal(result.decision_basis.comparisons[1].assessments.A.status, "partial");
  assert.equal(result.decision_basis.comparisons[0].assessments.A.evidence_status, "established");
  assert.equal(result.decision_basis.comparisons[1].assessments.B.status, "unknown");
  assert.equal(result.decision_basis.comparisons[1].assessments.B.evidence_status, "uncertain");
  validate(data.request, result);
  data.request.input.attributions.A.findings[0].assessment.evidence_status = "uncertain";
  data.result.decision_basis.decisive_findings = [{ candidate: "B", finding_index: 0 }];
  const uncertain = resolve(data);
  assert.equal(uncertain.decision_basis.comparisons[0].assessments.A.evidence_status, "uncertain");
  validate(data.request, uncertain);
  data.result.decision_basis.comparisons[0].better_candidates = ["A"];
  assert.throws(() => validate(data.request, resolve(data)), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "comparison_advantage_unproven"));
});

test("resource slots require recorded valid metrics and cannot be omitted", () => {
 const data = pair(), candidates = (data.request.input as unknown as ComparisonInput).candidates;
 for (const candidate of Object.values(candidates)) { candidate.original_answer_timing.finish_seconds=null; candidate.original_answer_usage.total_tokens=null; }
 assert.equal(comparisonSlots(data.request).filter(slot => slot.kind === "resource").length,0);
 candidates.A.original_answer_usage.issues=["total_tokens 与 input_tokens + output_tokens 不一致，不能比较总量"];
 assert.equal(comparisonSlots(data.request).filter(slot => slot.kind === "resource").length,0);
 candidates.A.original_answer_usage.total_tokens=100; candidates.A.original_answer_usage.issues=[];
 const slots = comparisonSlots(data.request); assert.equal(slots.at(-1)!.kind,"resource"); assert.equal(slots.at(-1)!.optional,false);
 const draft = submission(data.result,data.request); assert.notEqual(draft.comparisons.at(-1),null);
 validate(data.request,comparisonProfile.resolve!(data.request,draft,audit));
 candidates.A.original_answer_usage.total_tokens=null; candidates.A.original_answer_timing.finish_seconds=0;
 assert.equal(comparisonSlots(data.request).at(-1)!.kind,"resource");
});

test("required reads declare every deferred final source using its own candidate and path", () => {
  const data = pair();
  data.request.input.candidates.A.deferred_final_material = [{ message_index: 1, path: "/content", total_chars: 5 }] as never[];
  data.request.input.candidates.B.deferred_final_material = [{ message_index: 1, path: "/content/0/text", total_chars: 7 }] as never[];
  assert.deepEqual(comparisonProfile.requiredReads!(data.request), [
    { candidate: "A", message_index: 1, kind: "text", path: "/content", start: 0, end: 5 },
    { candidate: "B", message_index: 1, kind: "text", path: "/content/0/text", start: 0, end: 7 },
  ]);
});

test("Comparison requires exact pair candidate keys and complete row and finding coverage", () => {
  const data = pair();
  const duplicate = structuredClone(data.result); duplicate.ranking = [["A", "A"]];
  assert.throws(() => validate(data.request, duplicate), /重复|恰好/);
  const badLabels = JSON.parse(JSON.stringify(data.result).replaceAll('"A"', '"【候选A】"'));
  assert.throws(() => validate(data.request, badLabels), /合法候选标识.*\["A","B"\]/);
  const incomplete = structuredClone(data.result); delete (incomplete.assessments as Record<string, unknown>).B;
  assert.throws(() => validate(data.request, incomplete), /每个候选/);
  const missingCandidate = structuredClone(data.result); delete (missingCandidate.decision_basis.comparisons[0].assessments as Record<string, unknown>).B;
  assert.throws(() => validate(data.request, missingCandidate), /同一行包含全部候选/);
  const missingStrength = structuredClone(data.result); missingStrength.decision_basis.comparisons[0].assessments.B.finding_indices = [];
  assert.throws(() => validate(data.request, missingStrength), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "comparison_finding_uncovered" && issue.candidate === "B" && issue.actual === 0));
  const badRef = structuredClone(data.result); badRef.decision_basis.comparisons[0].assessments.A.finding_indices = [99];
  assert.throws(() => validate(data.request, badRef), /只能引用该候选/);
  const missed = pair(); missed.request.input.attributions.A.findings.push({ ...missed.request.input.attributions.A.findings[0], type: "problem", importance: "medium" });
  validate(missed.request, missed.result);
  Object.assign(data.request.input.candidates, { C: data.request.input.candidates.A });
  assert.throws(() => validate(data.request, data.result), /只比较 A、B/);
  const requestSchema = new Ajv2020({ strict: false }).compile(comparisonProfile.requestSchema);
  assert.equal(requestSchema(data.request.input), false);
});

test("criterion facts remain readable without forcing low uncertain findings into every cell", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  data.result.decision_basis.decisive_findings = [];
  for (const label of ["A", "B"] as const) {
    input.attributions[label].findings[0].importance = "low";
    input.attributions[label].findings[0].assessment.evidence_status = "uncertain";
    data.result.decision_basis.comparisons[0].assessments[label].finding_indices = [];
  }
  validate(data.request,data.result);
  const retained = resolve(data);
  validate(data.request,retained);
  for (const label of ["A", "B"] as const) {
    assert.deepEqual(retained.decision_basis.comparisons[0].assessments[label].finding_indices,[0]);
    assert.equal(retained.decision_basis.comparisons[0].assessments[label].evidence_status,"uncertain");
  }
  assert.deepEqual(retained.decision_basis.decisive_findings,[]);
});

test("core gate copies attribution and requires explicit established requirement refs", () => {
  const data = pair(); fail(data, "A");
  data.result.ranking = [["B"], ["A"]]; validate(data.request, data.result);
  data.result.assessments.A.meets_core = true;
  assert.throws(() => validate(data.request, data.result), /只能照录来源/);
  data.result.assessments.A.meets_core = false;
  data.result.assessments.A.core_failure_refs = [];
  assert.throws(() => validate(data.request, data.result), /至少一项/);
  data.result.assessments.A.core_failure_refs = ["sum"];
  data.request.input.attributions.A.criterion_assessments[0].evidence_status = "uncertain";
  data.result.decision_basis.comparisons[0].assessments.A.evidence_status = "uncertain";
  assert.throws(() => validate(data.request, data.result), /已证实的 unmet\/partial/);
});

test("a private-only core failure automatically requests source review without changing attribution", () => {
 const data=pair(), input=privateRisk(data);
 input.attributions.A.core_assessment={ meets_core:false,criterion_ids:["own_risk"],reason:"风险未置首。" };
 const source=structuredClone(input.attributions), pending=resolve(data);
 assert.equal(pending.status,"needs_review"); assert.equal(pending.assessments.A.meets_core,null);
 assert(pending.review_requests.some(item => item.candidate === "A" && item.criterion_ids.includes("own_risk")));
 validate(data.request,pending); assert.deepEqual(input.attributions,source);
});

test("a blocking unresolved-conflict source review keeps the pair pending with the located reason", () => {
 const data=pair(), input=data.request.input as unknown as ComparisonInput;
 input.source_review = { A: [{ kind: "unresolved_conflict", requires_review: true,
   reason: "共同要求 r1 双方给出不同结论：A=2025-12-31；B=2026-01-05。" }] };
 const source=structuredClone(input.attributions), pending=resolve(data);
 assert.equal(pending.status,"needs_review");
 assert(pending.review_requests.some(item => item.candidate === "A" && item.reason.includes("不同结论")));
 validate(data.request,pending); assert.deepEqual(input.attributions,source);
});

test("private findings remain visible but cannot become advantages or decisive findings through an unlinked row", () => {
  const data = pair(), input = privateRisk(data);
  input.attributions.A.findings.push({ ...structuredClone(input.attributions.A.findings[0]), type: "problem",
    dimension: "instruction_following", importance: "medium", text: "未把风险提示置首。",
    assessment: { ...input.attributions.A.findings[0].assessment, requirement_index: 1 } });
  data.result.decision_basis.comparisons[1].assessments.A.finding_indices = [1];
  validate(data.request, resolve(data));
  data.result.decision_basis.comparisons.push({ aspect: "指令合规", criterion_ids: [], importance: "medium",
    better_candidates: ["B"], assessments: {
      A: { summary: "未遵守本方风险顺序。", finding_indices: [1], status: "met", evidence_status: "established" },
      B: { summary: "提供正确结果，材料未提供同等顺序约束。", finding_indices: [0], status: "met", evidence_status: "established" },
    } });
  data.result.ranking = [["B"], ["A"]];
  assert.throws(() => validate(data.request, resolve(data)), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => ["comparison_advantage_finding_scope_mismatch","comparison_advantage_scope_mismatch","preference_unproven"].includes(issue.code)));
  data.result.decision_basis.comparisons[2].better_candidates = [];
  assert.throws(() => validate(data.request, resolve(data)), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => ["ranking_unproven","preference_unproven"].includes(issue.code)), "clearing private advantages must not leave an unsupported winner");
  data.result.ranking = [["A", "B"]];
  const retained = resolve(data);
  validate(data.request, retained);
  assert.deepEqual(retained.decision_basis.comparisons[1].assessments.A.finding_indices, [1]);
  assert.equal(retained.decision_basis.comparisons[1].assessments.B.status, "not_applicable");
  data.result.decision_basis.decisive_findings.push({ candidate: "A", finding_index: 1 });
  assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => issue.code === "decisive_finding_scope_mismatch"));
});

test("unlocated instruction following remains commentary even when a comparison row cites a common criterion", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  input.attributions.A.findings[0].dimension = "instruction_following";
  input.attributions.A.findings[0].assessment.requirement_index = null;
  input.attributions.A.findings[0].text = "遵循已提供的输出指令。";
  data.result.decision_basis.comparisons[0].assessments.A.finding_indices = [];
  data.result.decision_basis.decisive_findings = [{ candidate: "B", finding_index: 0 }];
  data.result.decision_basis.comparisons.push({ aspect: "本方指令遵循", criterion_ids: [], importance: "medium",
    better_candidates: ["A"], assessments: {
      A: { summary: "遵循已提供的输出指令。", finding_indices: [0], status: "met", evidence_status: "established" },
      B: { summary: "共同结果正确，本方 system 未提供。", finding_indices: [0], status: "met", evidence_status: "established" },
    } });
  data.result.ranking = [["A"], ["B"]];
  assert.throws(() => validate(data.request, resolve(data)), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => ["comparison_advantage_finding_scope_mismatch","comparison_advantage_scope_mismatch","preference_unproven"].includes(issue.code)));
  data.result.decision_basis.comparisons[1].better_candidates = [];
  data.result.ranking = [["A", "B"]];
  validate(data.request, resolve(data));
  data.result.decision_basis.decisive_findings.push({ candidate: "A", finding_index: 0 });
  assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => issue.code === "decisive_finding_scope_mismatch"));
  input.task_analysis.requirements[0].text = "计算2+2并按用户要求给出可解析JSON。"; input.task_analysis.requirements[0].acceptance_rule = input.task_analysis.requirements[0].text;
  for (const source of Object.values(input.attributions)) source.task_analysis = structuredClone(input.task_analysis);
  data.result.decision_basis.comparisons[1].criterion_ids = ["sum"];
  data.result.decision_basis.comparisons[1].better_candidates = ["A"];
  data.result.ranking = [["A"], ["B"]];
  const source = structuredClone(input.attributions);
  assert.throws(() => validate(data.request, resolve(data)), (error: unknown) => error instanceof ValidationError &&
    ["comparison_advantage_scope_mismatch", "comparison_advantage_finding_scope_mismatch", "decisive_finding_scope_mismatch", "preference_unproven"].some(code =>
      error.issues?.some(issue => issue.code === code)), "a comparison row cannot assign scope to an unlocated source finding");
  assert.deepEqual(input.attributions, source, "Comparison must not rewrite the accepted source association");
  data.result.decision_basis.decisive_findings = [{ candidate: "B", finding_index: 0 }];
  data.result.decision_basis.comparisons[1].better_candidates = [];
  assert.throws(() => validate(data.request, resolve(data)), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => ["ranking_unproven","preference_unproven"].includes(issue.code)), "clearing unlocated compliance advantages cannot retain a winner");
  data.result.ranking = [["A", "B"]];
  validate(data.request, resolve(data));
  assert.deepEqual(input.attributions, source, "the original compliance finding remains available as commentary");

  input.attributions.A.findings[0].assessment.requirement_index = 0;
  input.attributions.A.findings[0].text = "遵循共同用户要求，给出可解析JSON。";
  data.request.sources.A.value.messages[0] = { type: "message", role: "user", content: input.task_analysis.requirements[0].text };
  input.attributions.A.findings[0].evidence.push(canonicalEvidence(data.request.sources.A.id, 0, input.task_analysis.requirements[0].text));
  data.result.decision_basis.comparisons[1].assessments.A.summary = "按共同用户要求给出可解析JSON。";
  data.result.decision_basis.comparisons[1].better_candidates = ["A"];
  data.result.decision_basis.decisive_findings.push({ candidate: "A", finding_index: 0 });
  data.result.ranking = [["A"], ["B"]];
  validate(data.request, resolve(data));
});

test("a shared user delivery failure stays decisive for the current pair in a three-candidate criterion scope", () => {
  const data = pair(), input = privateRisk(data);
  const thirdId = "33333333-3333-4333-8333-333333333333";
  input.task_analysis.requirements[0].applies_to = [input.candidates.A.candidate_id, input.candidates.B.candidate_id];
  input.task_analysis.requirements.push({ id: "third_only", text: "第三个候选的输出要求。",
    applies_to: [thirdId], acceptance_rule: "仅评审第三个候选。" });
  for (const label of ["A", "B"] as const) {
    input.attributions[label].task_analysis = structuredClone(input.task_analysis);
    data.request.input.attributions[label].criterion_assessments.push({ criterion_id: "third_only", status: "not_applicable",
      evidence_status: "established", summary: "本对局双方均不适用。", evidence: [] });
  }
  fail(data, "A");
  input.attributions.A.core_assessment.criterion_ids = ["sum", "own_risk"];
  data.result.ranking = [["B"], ["A"]];
  data.result.decision_basis.comparisons[0].better_candidates = ["B"];
  const source = structuredClone(input.attributions), result = resolve(data);
  validate(data.request, result);
  assert.equal(result.assessments.A.meets_core, false);
  assert.deepEqual(result.assessments.A.core_failure_refs, ["sum"]);
  assert.deepEqual(result.task_analysis, input.task_analysis);
  assert.deepEqual(result.decision_basis.comparisons[1].criterion_ids, ["own_risk"]);
  assert.deepEqual(input.attributions, source);
  const missing = structuredClone(result);
  missing.decision_basis.comparisons.shift();
  assert.throws(() => validate(data.request, missing), (error: unknown) => error instanceof ValidationError &&
    ["A", "B"].every(candidate => error.issues?.some(issue => issue.code === "comparison_criterion_uncovered" &&
      issue.candidate === candidate && issue.actual === "sum")), "a shared A/B criterion is mandatory even when a third candidate has its own requirement");
});

test("established resource advantages can support a winner when the task explicitly prioritizes waiting time", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  const question = "尽快计算2+2，正确结果相同时优先缩短等待时间。";
  input.task_analysis.goal = question;
  for (const label of ["A", "B"] as const) {
    data.request.input.candidates[label].question = question;
    data.request.sources[label].value.messages[0].content = question;
    input.attributions[label].task_analysis = structuredClone(input.task_analysis);
  }
  data.result.task_analysis = structuredClone(input.task_analysis);
  input.candidates.A.original_answer_timing.finish_seconds = 10;
  input.candidates.B.original_answer_timing.finish_seconds = 100;
  data.result.decision_basis.comparisons.push({ aspect: "完成等待", criterion_ids: [], importance: "medium",
    better_candidates: ["A"], assessments: {
      A: { summary: "正确结果10秒完成。", finding_indices: [], status: "met", evidence_status: "established" },
      B: { summary: "相同正确结果100秒完成。", finding_indices: [], status: "met", evidence_status: "established" },
    } });
  data.result.ranking = [["A"], ["B"]];
  const result = resolve(data);
  validate(data.request, result);
  assert.deepEqual(result.ranking, [["A"], ["B"]]);
  assert.deepEqual(result.decision_basis.comparisons[1].better_candidates, ["A"]);
  assert.equal(result.decision_basis.comparisons[1].assessments.B.evidence_status, "established");
});

test("established medium problems on both sides of one shared slot can retain medium importance without a preference", () => {
  for (const swapped of [false, true]) {
    const data = pair(), input = data.request.input as unknown as ComparisonInput;
    for (const label of ["A", "B"] as const) {
      const final = label === "A" ? "2+2=4。相加的两个数是1和3。" : "2+2=4。加法计算就是两个数相乘。";
      data.request.input.candidates[label].final_answer = final;
      data.request.sources[label].value.messages[1].content = final;
      const attribution = input.attributions[label], finding = attribution.findings[0];
      attribution.criterion_assessments[0].status = "partial";
      attribution.core_assessment.reason = "结果4可用，但计算说明有局部错误。";
      finding.type = "problem"; finding.dimension = "reasoning"; finding.importance = "medium";
      finding.text = label === "A" ? "解释中的加数与题目不符。" : "把加法解释为乘法。";
      finding.reason = "结果正确，但解释需要修正。";
      finding.evidence = [canonicalEvidence(data.request.sources[label].id, 1, final)];
      finding.assessment.observation = finding.text;
      finding.assessment.impact = "局部解释错误，未使最终数值不可用。";
      Object.assign(finding, { problem: { component: [], label: "计算说明错误", definition: finding.text } });
    }
    if (swapped) {
      [data.request.sources.A, data.request.sources.B] = [data.request.sources.B, data.request.sources.A];
      [input.candidates.A, input.candidates.B] = [input.candidates.B, input.candidates.A];
      [input.attributions.A, input.attributions.B] = [input.attributions.B, input.attributions.A];
    }
    data.result.decision_basis.comparisons[0].importance = "medium";
    data.result.decision_basis.tradeoff = "双方结果4可用，计算说明各有已确认的局部错误；共同槽内没有已证明的单方优势。";
    const draft = submission(data.result, data.request), before = structuredClone({ request: data.request, draft });
    assert.equal(draft.comparisons[0]!.importance, "medium");
    assert.equal(draft.comparisons[0]!.better_candidate, null);
    assert.equal(draft.preference, null);
    const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
    validate(data.request, result);
    assert.deepEqual(result.ranking, [["A", "B"]]);
    assert.equal(result.decision_basis.comparisons[0].importance, "medium");
    assert.deepEqual(result.decision_basis.comparisons[0].better_candidates, []);
    assert.deepEqual(result.decision_basis.decisive_findings, []);
    for (const label of ["A", "B"] as const) {
      assert.equal(result.assessments[label].meets_core, true);
      assert.deepEqual(result.decision_basis.comparisons[0].assessments[label].finding_indices, [0]);
      assert.equal(result.decision_basis.comparisons[0].assessments[label].evidence_status, "established");
    }
    assert.deepEqual({ request: data.request, draft }, before, "resolution preserves both accepted findings and the submitted choice");
  }
});

test("an absent overall preference cannot silently turn a resource advantage into a winner", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  input.candidates.A.original_answer_timing.finish_seconds = 6.597;
  input.candidates.B.original_answer_timing.finish_seconds = 7.391;
  for (const preference of [null, undefined]) {
    const draft = submission(data.result, data.request);
    const slot = comparisonSlots(data.request).findIndex(item => item.kind === "resource");
    draft.comparisons[slot] = { importance: "medium" };
    draft.preference = preference;
    draft.a_tradeoff = "结果正确，等待时间的微小差异不足以决定胜负。";
    draft.b_tradeoff = "结果正确，等待时间的微小差异不足以决定胜负。";
    const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
    assert.deepEqual(result.ranking, [["A", "B"]], "the resolver must preserve the submitted overall preference");
    assert.throws(() => validate(data.request, result), (error: unknown) => error instanceof ValidationError &&
      !!error.issues?.some(issue => issue.code === "ranking_ignores_advantage"), "contradictory importance must be repaired before acceptance");
    draft.comparisons[slot]!.importance = "low";
    const tied = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
    validate(data.request, tied);
    assert.deepEqual(tied.ranking, [["A", "B"]]);
    draft.preference = "A";
    assert.throws(() => comparisonProfile.resolve!(data.request, draft, audit), (error: unknown) => error instanceof ValidationError &&
      !!error.issues?.some(issue => issue.code === "preference_unproven"));
  }
});

test("both-bad candidates remain tied while the short rationale may retain relative value", () => {
  const data = pair(); fail(data, "A"); fail(data, "B");
  data.result.ranking = [["A", "B"]];
  data.result.decision_basis.tradeoff = "双方核心结果都错。A保留了方法说明，但仍未完成结果交付。";
  validate(data.request, data.result);
  data.result.ranking = [["A"], ["B"]];
  assert.throws(() => validate(data.request, data.result), /未达标候选必须同层/);
});

test("common criteria require rows even when attribution has no finding", () => {
  const data = pair();
  const criterion = { id: "format", text: "表达清晰", applies_to: [], acceptance_rule: "可直接读取结果。" };
  data.request.input.task_analysis.scoring_points.push(criterion as never);
  data.result.task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].criterion_assessments.push({ criterion_id: "format", status: "met", evidence_status: "established", summary: "清晰。", evidence: [] });
  assert.throws(() => validate(data.request, data.result), error => error instanceof ValidationError &&
    ["A", "B"].every(candidate => error.issues!.some(issue => issue.code === "comparison_criterion_uncovered" &&
      issue.candidate === candidate && issue.actual === "format")));
  data.result.decision_basis.comparisons.push({ aspect: "表达", criterion_ids: ["format"], importance: "low", better_candidates: [], assessments: { A: { summary: "清晰。", finding_indices: [], status: "met", evidence_status: "established" }, B: { summary: "清晰。", finding_indices: [], status: "met", evidence_status: "established" } } });
  validate(data.request, data.result);
});

test("an own time criterion without a finding stays in Attribution without a duplicate comparison row", () => {
  const data = privateTime(), input = data.request.input as unknown as ComparisonInput;
  const source = structuredClone(input.attributions), draft = submission(data.result,data.request);
  const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
  validate(data.request, result);
  assert.deepEqual(result.decision_basis.comparisons.map(row => row.criterion_ids), [["sum"]]);
  assert.deepEqual(result.task_analysis, input.task_analysis, "the own time requirement remains in the mirrored analysis");
  assert.equal(input.attributions.B.criterion_assessments.find(fact => fact.criterion_id === "r9")!.status, "met");
  assert.equal(input.attributions.A.criterion_assessments.find(fact => fact.criterion_id === "r9")!.status, "not_applicable");
  assert.deepEqual(input.attributions, source, "Comparison must preserve both complete source assessments");
});

test("an incomplete own source assessment automatically requests review without filling the fact", () => {
 const data=privateTime(), input=data.request.input as unknown as ComparisonInput;
 input.attributions.B.criterion_assessments=input.attributions.B.criterion_assessments.filter(fact => fact.criterion_id !== "r9");
 const source=structuredClone(input.attributions), pending=resolve(data);
 validate(data.request,pending); assert.equal(pending.status,"needs_review"); assert.equal(pending.assessments.B.meets_core,null);
 assert(pending.review_requests.some(item => item.candidate === "B" && item.criterion_ids.includes("r9")));
 assert.deepEqual(input.attributions,source);
});

test("own scoring points and red flags without findings also retain source coverage without duplicate rows", () => {
  const data = privateTime(), input = data.request.input as unknown as ComparisonInput;
  input.task_analysis.scoring_points.push({ id: "own_score", text: "A自身的呈现规则。",
    applies_to: [input.candidates.A.candidate_id], acceptance_rule: "仅评审A自身呈现。" });
  input.task_analysis.red_flags.push({ id: "own_red", text: "B自身的内容边界。",
    applies_to: [input.candidates.B.candidate_id], acceptance_rule: "仅评审B自身边界。" });
  for (const label of ["A", "B"] as const) {
    input.attributions[label].task_analysis = structuredClone(input.task_analysis);
    for (const [criterion_id, owner] of [["own_score", "A"], ["own_red", "B"]] as const)
      input.attributions[label].criterion_assessments.push({ criterion_id,
        status: label === owner ? "met" : "not_applicable", evidence_status: "established",
        summary: label === owner ? "自身规则已评审。" : "该规则不适用。" });
  }
  const source = structuredClone(input.attributions), result = resolve(data);
  validate(data.request, result);
  assert.deepEqual(result.decision_basis.comparisons.map(row => row.criterion_ids), [["sum"]]);
  assert.deepEqual(result.task_analysis, input.task_analysis);
  assert.deepEqual(input.attributions, source);
});

test("own strengths and material problems remain required matrix findings when their criterion row is optional", () => {
  const data = privateTime(), input = data.request.input as unknown as ComparisonInput;
  const original = input.attributions.B.findings[0];
  input.attributions.B.criterion_assessments.find(fact => fact.criterion_id === "r9")!.status = "partial";
  const strength = { ...structuredClone(original), dimension: "instruction_following" as const,
    text: "按自身时间规范标明数据日期。", assessment: { ...original.assessment, requirement_index: 1 } };
  const problem = { ...structuredClone(original), type: "problem" as const,
    dimension: "instruction_following" as const, importance: "medium" as const,
    text: "另一处日期表述未遵守自身时间规范。", assessment: { ...original.assessment, requirement_index: 1 },
    problem: { component: "model", label: "日期表述失当", definition: "日期表述未遵守自身时间规范。" } };
  input.attributions.B.findings.push(strength, problem);
  const automatic=resolve(data); validate(data.request,automatic);
  assert.deepEqual(automatic.decision_basis.comparisons[1].assessments.B.finding_indices,[1,2]);
  data.result.decision_basis.comparisons.push({ aspect: "B自身时间规范的既有发现", criterion_ids: ["r9"],
    importance: "medium", better_candidates: [], assessments: {
      A: { summary: "仅适用B的自身规则。", finding_indices: [], status: "not_applicable", evidence_status: "established" },
      B: { summary: "保留已接受的优点与问题。", finding_indices: [1, 2], status: "partial", evidence_status: "established" },
    } });
  const source = structuredClone(input.attributions), retained = resolve(data);
  validate(data.request, retained);
  assert.deepEqual(retained.decision_basis.comparisons[1].assessments.B.finding_indices, [1, 2]);
  data.result.decision_basis.comparisons[1].better_candidates = ["B"];
  assert.throws(() => validate(data.request, resolve(data)), (error: unknown) => error instanceof ValidationError &&
    ["comparison_advantage_scope_mismatch", "comparison_advantage_finding_scope_mismatch"].some(code =>
      error.issues?.some(issue => issue.code === code)));
  data.result.decision_basis.comparisons[1].better_candidates = [];
  for (const index of [1, 2]) {
    data.result.decision_basis.decisive_findings.push({ candidate: "B", finding_index: index });
    assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
      !!error.issues?.some(issue => issue.code === "decisive_finding_scope_mismatch"));
    data.result.decision_basis.decisive_findings.pop();
  }
  assert.deepEqual(input.attributions, source, "required visibility does not change the private findings or their scope");
});

test("scope differences do not create an advantage and row states cannot strengthen source facts", () => {
  const data = pair();
  data.request.input.task_analysis.requirements[0].applies_to = [data.request.input.candidates.A.candidate_id] as never[];
  data.result.task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].task_analysis = structuredClone(data.request.input.task_analysis);
  data.result.decision_basis.decisive_findings = [];
  data.request.input.attributions.B.criterion_assessments[0].status = "not_applicable";
  data.result.decision_basis.comparisons[0].assessments.B.status = "not_applicable";
  data.result.decision_basis.comparisons[0].assessments.B.summary = "此条仅评审A，材料未提供B的同等约束。";
  data.result.decision_basis.tradeoff = "双方核心结果都可用，A遵守已提供的自身约束，B的同等约束未提供，未见有依据的相对优势。";
  validate(data.request, data.result);
  const retained = structuredClone(data.result.decision_basis);
  data.result.decision_basis.comparisons[0].better_candidates = ["A"] as never[];
  assert.throws(() => validate(data.request, data.result), (error: unknown) => {
    assert(error instanceof ValidationError);
    const scope = error.issues?.find(issue => issue.code === "comparison_advantage_scope_mismatch");
    assert.equal(scope?.path, "/decision_basis/comparisons/0/better_candidates");
    assert.match(scope?.message ?? "", /保留当前比较格/);
    assert.match(scope?.message ?? "", /better_candidate=null/);
    assert.match(scope?.message ?? "", /summary.*材料未提供本方同等约束/);
    return true;
  });
  data.result.decision_basis.comparisons[0].better_candidates = [];
  const repaired = resolve(data);
  validate(data.request, repaired);
  assert.equal(repaired.decision_basis.tradeoff,`相对更倾向【候选A】。【候选A】：${data.result.assessments.A.summary} 【候选B】：${data.result.assessments.B.summary}`);
  assert.deepEqual(repaired.decision_basis.comparisons[0].criterion_ids,retained.comparisons[0].criterion_ids);
  data.request.input.task_analysis.requirements.push({ id: "own_b", text: "B的专有约束", applies_to: [data.request.input.candidates.B.candidate_id], acceptance_rule: "按B自己的要求完成。" } as never);
  data.request.input.attributions.A.criterion_assessments.push({ criterion_id: "own_b", status: "not_applicable", evidence_status: "established", summary: "不适用。", evidence: [] });
  data.request.input.attributions.B.criterion_assessments.push({ criterion_id: "own_b", status: "met", evidence_status: "established", summary: "已完成。", evidence: [] });
  data.result.task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].task_analysis = structuredClone(data.request.input.task_analysis);
  data.result.decision_basis.comparisons[0].criterion_ids.push("own_b");
  data.result.decision_basis.comparisons[0].better_candidates = ["A"] as never[];
  data.result.decision_basis.comparisons[0].assessments.B.status = "met";
  assert.throws(() => validate(data.request, data.result), /标准必须共同适用于双方/);
  const uncertain = pair();
  uncertain.request.input.attributions.B.criterion_assessments[0].status = "unknown";
  uncertain.request.input.attributions.B.criterion_assessments[0].evidence_status = "uncertain";
  assert.throws(() => validate(uncertain.request, uncertain.result), /不能把来源 uncertain|只能照录来源标准状态/);
  uncertain.result.decision_basis.comparisons[0].assessments.B.status = "unknown";
  uncertain.result.decision_basis.comparisons[0].assessments.B.evidence_status = "uncertain";
  validate(uncertain.request, uncertain.result);
  uncertain.result.decision_basis.comparisons[0].better_candidates = ["A"] as never[];
  assert.throws(() => validate(uncertain.request, uncertain.result), (error: unknown) => {
    assert(error instanceof ValidationError);
    const unproven = error.issues?.find(issue => issue.code === "comparison_advantage_unproven");
    assert.equal(unproven?.code, "comparison_advantage_unproven");
    assert.match(unproven?.message ?? "", /保留当前比较格/);
    assert.match(unproven?.message ?? "", /better_candidate=null/);
    return true;
  });
  uncertain.result.decision_basis.comparisons[0].better_candidates = [];
  const uncertainRepaired = resolve(uncertain);
  validate(uncertain.request, uncertainRepaired);
  assert.deepEqual(uncertainRepaired.decision_basis.comparisons[0].criterion_ids, ["sum"]);
  assert.equal(uncertainRepaired.decision_basis.comparisons[0].assessments.B.status, "unknown");
  assert.equal(uncertainRepaired.decision_basis.comparisons[0].assessments.B.evidence_status, "uncertain");
});

test("uncertain findings cannot be decisive and one-sided material advantages cannot tie or reverse rank", () => {
  const data = pair(), input = data.request.input as unknown as ComparisonInput;
  const question = "计算2+2，并简要说明计算过程。", final = "2+2=4。从2开始再数2个，得到4。";
  input.task_analysis.goal = question;
  input.task_analysis.requirements[0].text = "给出正确的加法结果并说明计算过程。";
  input.task_analysis.requirements[0].acceptance_rule = "最终给出4，并说明2与2相加的过程。";
  for (const label of ["A", "B"] as const) {
    data.request.input.candidates[label].question = question;
    data.request.sources[label].value.messages[0].content = question;
    input.attributions[label].task_analysis = structuredClone(input.task_analysis);
  }
  data.result.task_analysis = structuredClone(input.task_analysis);
  data.request.input.candidates.A.final_answer = final;
  data.request.sources.A.value.messages[1].content = final;
  input.attributions.A.findings[0].text = "结果正确，并说明了相加的过程。";
  input.attributions.A.findings[0].evidence = [canonicalEvidence(data.request.sources.A.id, 1, final)];
  const problem = input.attributions.B.findings[0];
  problem.type = "problem"; problem.dimension = "completeness"; problem.importance = "medium";
  problem.text = "结果正确，但没有说明计算过程。";
  problem.reason = "用户要求说明计算过程，回答只给出结果4。";
  problem.assessment.observation = problem.text;
  problem.assessment.impact = "数值可用，但共同要求中的过程说明缺失。";
  Object.assign(problem, { problem: { component: [], label: "计算过程缺失", definition: problem.text } });
  input.attributions.B.criterion_assessments[0].status = "partial";
  input.attributions.B.criterion_assessments[0].summary = problem.text;
  data.result.decision_basis.comparisons[0].assessments.B.status = "partial";
  data.request.input.attributions.A.findings[0].assessment.evidence_status = "uncertain";
  assert.throws(() => validate(data.request, data.result), /uncertain finding 不能作为决定性依据/);
  data.result.decision_basis.decisive_findings = [{ candidate: "B", finding_index: 0 }];
  data.result.decision_basis.comparisons[0].better_candidates = ["A"] as never[];
  assert.throws(() => validate(data.request, data.result), /uncertain finding 的比较行/);
  data.request.input.attributions.A.findings[0].assessment.evidence_status = "established";
  assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => issue.code === "ranking_ignores_advantage"));
  data.result.ranking = [["B"], ["A"]];
  assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
    !!error.issues?.some(issue => issue.code === "ranking_ignores_advantage"));
  data.result.ranking = [["A"], ["B"]]; validate(data.request, data.result);
  for (const importance of ["medium", "high"] as const) {
    data.result.decision_basis.comparisons[0].importance = importance;
    const source = structuredClone(data.request.input.attributions), result = resolve(data);
    validate(data.request, result);
    assert.deepEqual(result.ranking, [["A"], ["B"]]);
    assert.equal(result.decision_basis.comparisons[0].importance, importance);
    assert.deepEqual(result.decision_basis.comparisons[0].better_candidates, ["A"]);
    assert.deepEqual(data.request.input.attributions, source);
  }
});

test("needs_review carries located requests and never produces a ranking or decisive finding", () => {
  const data = review();
  data.request.input.attributions.A.core_assessment.meets_core = null as unknown as boolean;
  data.result.assessments.A.meets_core = null as unknown as boolean;
  validate(data.request, data.result);
  data.result.ranking = [["A", "B"]];
  assert.throws(() => validate(data.request, data.result), /0 items/);
  data.result.ranking = [];
  data.result.review_requests[0].criterion_ids = [];
  assert.throws(() => validate(data.request, data.result), /定位至少一个标准/);
  const conflict = review();
  conflict.result.assessments.A.meets_core = null as unknown as boolean;
  conflict.result.decision_basis.comparisons[0].assessments.A.status = "unknown";
  conflict.result.decision_basis.comparisons[0].assessments.A.evidence_status = "uncertain";
  validate(conflict.request, conflict.result);
  conflict.result.status = "decided"; conflict.result.review_requests = []; conflict.result.ranking = [["A", "B"]];
  assert.throws(() => validate(conflict.request, conflict.result), /boolean/);
});

test("missing and conflicting source criterion facts route to located review without creating facts", () => {
  const missing = review();
  missing.request.input.attributions.A.criterion_assessments = [];
  missing.result.assessments.A.meets_core = null;
  const cell = missing.result.decision_basis.comparisons[0].assessments.A;
  cell.status = "unknown"; cell.evidence_status = "uncertain";
  validate(missing.request, missing.result);
  cell.status = "met"; cell.evidence_status = "established";
  assert.throws(() => validate(missing.request, missing.result), /只能照录来源标准状态|不能把来源 uncertain/);
  const duplicate = review();
  duplicate.request.input.attributions.A.criterion_assessments.push({ ...duplicate.request.input.attributions.A.criterion_assessments[0], status: "unmet" });
  const conflictCell = duplicate.result.decision_basis.comparisons[0].assessments.A;
  conflictCell.status = "unknown"; conflictCell.evidence_status = "uncertain";
  validate(duplicate.request, duplicate.result);
});

test("same criterion ID cannot hide different acceptance rules or candidate scopes in source attribution", () => {
  const changed = pair();
  changed.request.input.attributions.A.task_analysis.requirements[0].acceptance_rule = "仅给出操作数即可通过。";
  assert.throws(() => validate(changed.request, changed.result), /来源归因的 task_analysis.*不能沿用同名 ID/);
  const pending = review();
  pending.request.input.attributions.A.task_analysis.requirements[0].acceptance_rule = "仅给出操作数即可通过。";
  validate(pending.request, pending.result);
  pending.result.review_requests[0].criterion_ids = [];
  pending.result.review_requests[0].finding_indices = [0];
  assert.throws(() => validate(pending.request, pending.result), /相关 criterion_ids/);
  const scoped = pair();
  scoped.request.input.attributions.B.task_analysis.requirements[0].applies_to = [scoped.request.input.candidates.A.candidate_id] as never[];
  assert.throws(() => validate(scoped.request, scoped.result), /来源归因的 task_analysis/);
});

test("complete deferred final material and final images are hard evidence prerequisites", () => {
  const data = pair();
  data.request.input.candidates.A.deferred_final_material.push({ message_index: 1, path: "/content", total_chars: 5 } as never);
  assert.throws(() => validate(data.request, data.result), /未完整读取/);
  const reads = structuredClone(audit);
  reads.traceReads = [{ candidate: "A", message_index: 1, path: "/content", kind: "text", start: 0, end: 2 }];
  assert.throws(() => validate(data.request, data.result, reads), /未完整读取/);
  reads.traceReads.push({ candidate: "A", message_index: 1, path: "/content", kind: "text", start: 2, end: 5 });
  validate(data.request, data.result, reads);
  (data.request.sources.B.value.messages[1] as Record<string, unknown>).content = "data:image/png;base64,aA==";
  assert.throws(() => validate(data.request, data.result, reads), /必须先 view_image/);
  reads.viewedImages.push("B:1"); validate(data.request, data.result, reads);
});


test("first feedback combines malformed Comparison with each unviewed candidate final image", () => {
  const data = pair();
  for (const label of ["A", "B"] as const) Object.assign(data.request.sources[label].value.messages[1]!, {
    attachments: [{ type: "image", mimeType: "image/png", data: "AA==" }],
  });
  const draft = submission(data.result,data.request);
  draft.a_summary = 7 as unknown as string;
  const registry = new AgentRegistry([comparisonAgent]);
  const binding = { agent: "comparison", profile: "default", request: data.request };
  const before = structuredClone({ request: data.request, draft });
  const issues = (reads: ToolAudit) => {
    try { registry.resolve(binding, draft, reads); assert.fail("malformed summary must fail"); }
    catch (error) { assert(error instanceof ValidationError); return error.issues!; }
  };
  assert.equal(comparisonProfile.validateSubmission!(data.request, submission(data.result,data.request), audit)
    .filter(issue => issue.code === "final_image_not_viewed").length, 2,
  "early and dependent validation return each image gap once before Host de-duplication");
  const errors = issues(audit);
  assert.deepEqual(errors.map(issue => issue.code), ["schema_type", "final_image_not_viewed", "final_image_not_viewed"]);
  assert.deepEqual(errors.filter(issue => issue.code === "final_image_not_viewed").map(issue => issue.candidate), ["A", "B"]);
  assert.deepEqual(issues({ ...audit, viewedImages: ["B:1"] }).filter(issue => issue.code === "final_image_not_viewed").map(issue => issue.candidate), ["A"]);
  const viewed = { ...audit, viewedImages: ["A:1", "B:1"] };
  assert.deepEqual(issues(viewed).map(issue => issue.code), ["schema_type"]);
  assert.throws(() => validate(data.request, data.result), (error: unknown) => error instanceof ValidationError &&
    error.issues!.filter(issue => issue.code === "final_image_not_viewed").length === 2);
  validate(data.request, data.result, viewed);
  assert.deepEqual({ request: data.request, draft }, before);
});
