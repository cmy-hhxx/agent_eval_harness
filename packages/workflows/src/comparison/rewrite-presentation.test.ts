import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import type { RewriteItem } from "@eval/agents/rewrite";
import { rewriteAgent } from "@eval/agents/rewrite";
import { AgentRegistry } from "@eval/host";
import { Ajv2020 } from "ajv/dist/2020.js";
import { attributionResult, comparisonResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { bindTask } from "./workflow.js";
import type { TaskData } from "./types.js";

function bindRewrite(stage: "attribution" | "comparison" | "clustering", evaluation: unknown,
  names: Record<string, string> = { A: "A组Fast", B: "B组Fast" }, relativePreference: "A" | "B" | null = null) {
  const source: SubmissionReceipt = { taskId: "source", attemptId: "attempt", submissionId: "submission",
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation,
    ...(stage === "comparison" ? { submitted: { relative_preference: relativePreference } } : {}),
    audit: emptyAudit(), usage: emptyUsage() };
  const task: PlannedTask = { id: "rewrite", stage: "rewrite", inputIds: {}, dependencies: { source: source.taskId },
    data: { stage: "rewrite", candidates: {}, reference: null, case: { batch_id: "batch", case_id: "case", question: "" },
      rewriteOf: { stage, taskId: source.taskId, resultId: "result" }, rewriteNames: names,
      comparisonRewriteScope: "all" } satisfies TaskData };
  return bindTask(task, {}, { source }, { tasks: [task] });
}

test("Rewrite submission carries fixed semantic identities and rejects missing or displaced slots", () => {
  const binding=bindRewrite("comparison",comparisonResult()),registry=new AgentRegistry([rewriteAgent]);
  const shown=binding.modelInput!.items as RewriteItem[];
  assert(shown.every(item=>Object.hasOwn(item,"id")));
  const draft={rewrites:shown.map(item=>({ id: item.id, text: item.preference?item.preference+"：双方都给出了正确结果4。":item.text }))};
  const before=structuredClone(draft),result=registry.resolve(binding,draft,emptyAudit()) as {rewrites:{id:string;text:string}[]};
  registry.validate(binding,result,emptyAudit());
  assert.deepEqual(result.rewrites.map(item=>item.id),(binding.request.input.items as RewriteItem[]).map(item=>item.id));
  assert.deepEqual(draft,before);
  const valid = new Ajv2020({ strict: false }).compile(registry.prepare(binding).evaluation.outputSchema);
  assert(valid(draft), JSON.stringify(valid.errors));
  assert(!valid({ rewrites: draft.rewrites.slice(1) }));
  assert(!valid({ rewrites: [...draft.rewrites].reverse() }));
  assert(!valid({ rewrites: draft.rewrites.map(item => ({ ...item, id: "findings.99.text" })) }));
});

test("tied Rewrite prefixes retain accepted relative identity and reject its omission or reversal", () => {
  const registry = new AgentRegistry([rewriteAgent]);
  const names = { A: "B组Fast", B: "A组Fast" };
  for (const meetsCore of [true, false]) for (const relative of ["A", "B"] as const) {
    const result = comparisonResult();
    for (const assessment of Object.values(result.assessments)) assessment.meets_core = meetsCore;
    result.decision_basis.tradeoff = "双方主要结果相同，具体取舍已在结构字段中确认。";
    const before = structuredClone(result), binding = bindRewrite("comparison", result, names, relative);
    const items = binding.request.input.items as RewriteItem[], formal = meetsCore ? "双方都好" : "双方都差";
    const prefix = `${formal}；相对更倾向${names[relative]}`;
    assert.equal(items[0].preference, prefix);
    assert.equal((binding.modelInput!.items as RewriteItem[])[0].preference, prefix);
    assert(items.slice(1).every(item => item.preference === undefined));
    const draft = { rewrites: items.map(item => ({ id: item.id, text: item.preference ? `${item.preference}：具体差异影响有限。` : item.text })) };
    registry.validate(binding, draft, emptyAudit());
    for (const changed of [formal, `${formal}；相对更倾向${names[relative === "A" ? "B" : "A"]}`]) {
      const invalid = structuredClone(draft);
      invalid.rewrites[0].text = `${changed}：具体差异影响有限。`;
      assert.throws(() => registry.validate(binding, invalid, emptyAudit()), /已确定偏好/);
    }
    assert.deepEqual(result, before);
  }
});

test("equivalent ties do not gain a relative preference and formal wins do not repeat one", () => {
  const tied = comparisonResult();
  tied.decision_basis.tradeoff = "正文出现候选B，但没有结构化相对偏好。";
  const tie = bindRewrite("comparison", tied, { A: "B组Fast", B: "A组Fast" }, null);
  assert.equal((tie.request.input.items as RewriteItem[])[0].preference, "双方都好");
  for (const assessment of Object.values(tied.assessments)) assessment.meets_core = false;
  assert.equal((bindRewrite("comparison", tied, undefined, null).request.input.items as RewriteItem[])[0].preference, "双方都差");
  const winner = comparisonResult();
  winner.ranking = [["B"], ["A"]];
  const win = bindRewrite("comparison", winner, { A: "B组Fast", B: "A组Fast" }, "B");
  assert.equal((win.request.input.items as RewriteItem[])[0].preference, "A组Fast更好");
});

test("core rewrite preserves a method's feasibility as its acceptance object in the actual model material", () => {
  const result = attributionResult(false);
  result.core_assessment.reason = "泛化的页面返回/关闭建议不足以证明用户能退出其所在社区。";
  const before = structuredClone(result), binding = bindRewrite("attribution", result);
  const original = (binding.request.input.items as RewriteItem[]).find(item => item.id === "core_assessment.reason")!;
  const shown = (binding.modelInput!.items as RewriteItem[]).find(item => item.id === original.id)!;
  assert.equal(shown.label, "A组Fast 回答对用户请求的满足情况");
  assert.match(shown.context!, /用户索要方法或步骤时，评价回答是否给出可执行方法，不代表用户已经实施/u);
  assert.match(shown.context!, /用户要求执行时，才沿用原文的执行结果/u);
  assert.match(shown.context!, /无法保证语义不变时保留原文/u);
  assert.equal(shown.text, before.core_assessment.reason);
  assert.deepEqual(shown, original);
  assert.deepEqual(binding.request.sources, {});
  assert.deepEqual(result, before);
});

test("Rewrite receives real names with the original responsibility and resource values when blind positions reverse", () => {
  for (const sample of [
    {
      blind: "【候选B】未验证历史时点；【候选A】用时8.654秒、15,388 tokens，【候选B】用时10.242秒、34,804 tokens。",
      real: "A组Fast未验证历史时点；B组Fast用时8.654秒、15,388 tokens，A组Fast用时10.242秒、34,804 tokens。",
    },
    {
      blind: "【候选A】准确列出3,253.60万元和5,012.24万元两笔成交价；【候选B】把5,122.43万元评估值写成实际作价。【候选A】用时8.519秒、14,301 tokens。",
      real: "B组Fast准确列出3,253.60万元和5,012.24万元两笔成交价；A组Fast把5,122.43万元评估值写成实际作价。B组Fast用时8.519秒、14,301 tokens。",
    },
  ]) {
    const result = comparisonResult();
    result.decision_basis.tradeoff = sample.blind;
    const binding = bindRewrite("comparison", result, { A: "B组Fast", B: "A组Fast" });
    const original = binding.request.input.items as RewriteItem[];
    const shown = binding.modelInput!.items as RewriteItem[];
    assert(original[0].text.includes(sample.real));
    assert(shown[0].text.includes(sample.real));
    assert(!JSON.stringify(shown).includes("【候选"));
    assert.equal(result.decision_basis.tradeoff, sample.blind);
  }
});

test("comparison rewrite preserves the blind identity map beside unmodified candidate prose", () => {
  const result = comparisonResult();
  result.decision_basis.tradeoff = "候选B耗时4.627秒，快于候选A的10.143秒；候选A总用量2,718个token，低于候选B的19,077个。基金A/B类保持不变。";
  const binding = bindRewrite("comparison", result, { A: "B组Fast", B: "A组Fast" });
  const items = binding.request.input.items as RewriteItem[];
  const mapping = JSON.stringify({ 候选A: "B组Fast", 候选B: "A组Fast" });
  assert.equal(items[0].text, result.decision_basis.tradeoff);
  assert.match(items[0].context!, /已确定的对局结论/);
  assert.equal(items[0].label, "B组Fast与A组Fast的偏好及理由");
  assert(items.every(item => item.context?.split("\n")[0] === mapping));
  assert.deepEqual(items.slice(1).map(item => item.id), ["assessment.A.summary", "assessment.B.summary", "comparison.0.A.summary", "comparison.0.B.summary", "tradeoff"]);
  assert.equal(items[1].label, "B组Fast的整体总评");
  assert.equal(items[2].label, "A组Fast的整体总评");
  assert.equal(items.at(-1)!.text, result.decision_basis.tradeoff);
  assert(items.some(item => item.id.startsWith("comparison.")));
  const shown = binding.modelInput!.items as RewriteItem[];
  assert(shown.every(item => item.context?.split("\n")[0] === mapping));
});

test("Rewrite projects each selected text slot without injecting other slots into the verdict", () => {
  const result = comparisonResult();
  result.ranking = [["A"], ["B"]];
  result.decision_basis.tradeoff = "漏插<visual>属小瑕疵；27.98%与27.18%-27.80%的口径不变。";
  const row = result.decision_basis.comparisons[0]!;
  row.aspect = "展示<visual>协议与x<0条件";
  row.better_candidates = ["A"];
  row.assessments.A!.summary = "使用<visual>展示27.98%。";
  row.assessments.B!.summary = "来源<trace ref=Ab12Cd3 />；模板[^<int>]。";
  result.assessments.A!.summary = row.assessments.A!.summary;
  result.assessments.B!.summary = row.assessments.B!.summary;
  const before = structuredClone(result);
  const binding = bindRewrite("comparison", result, { A: "A组<Fast>", B: "B组<Fast>" }, "A");
  const original = binding.request.input.items as RewriteItem[];
  const shown = binding.modelInput!.items as RewriteItem[];
  assert.equal(shown.length, 6);
  assert.equal(shown[0]!.text, "漏插＜visual＞属小瑕疵；27.98%与27.18%-27.80%的口径不变。");
  assert.equal(shown[1]!.label, "A组＜Fast＞的整体总评");
  assert.equal(shown[1]!.text, "使用＜visual＞展示27.98%。");
  assert.equal(shown[2]!.text, "来源＜trace ref=Ab12Cd3 /＞；模板[^＜int＞]。");
  assert(!shown[0]!.text.includes("展示＜visual＞协议与x＜0条件"));
  assert(!shown[0]!.text.includes("来源＜trace ref=Ab12Cd3 /＞；模板[^＜int＞]。"));
  assert.equal(shown.find(item => item.id === "comparison.0.B.summary")!.text, "来源＜trace ref=Ab12Cd3 /＞；模板[^＜int＞]。");
  assert.equal(shown[0]!.preference, "A组<Fast>更好");
  assert.deepEqual(shown.map(({ preference, forbiddenPrefixes }) => ({ preference, forbiddenPrefixes })),
    original.map(({ preference, forbiddenPrefixes }) => ({ preference, forbiddenPrefixes })));
  assert(shown.every(item => !/[<>]/.test([item.label, item.text, item.context ?? ""].join("\n"))));
  assert.equal(original[1]!.text, "使用<visual>展示27.98%。");
  assert.equal(original[2]!.text, "来源<trace ref=Ab12Cd3 />；模板[^<int>]。");
  assert(shown.some(item => item.id.startsWith("comparison.")));
  assert.deepEqual(result, before);
});

test("all attribution rewrite slots preserve protocol attributes and figures in their model-facing presentation", () => {
  const result = attributionResult();
  const text = "<vis-html ref=html-7b1ac344 />保留24.2%、15.1%；x<0且x>5；已有＜visual＞。";
  result.summary = text;
  result.correctness_reason = text;
  result.core_assessment.reason = text;
  result.criterion_assessments.forEach(item => { item.summary = text; });
  const finding = result.findings[0]!;
  result.findings = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(finding), finding_id: `f${index}`,
    text, reason: text, assessment: { ...finding.assessment, observation: text, impact: text } }));
  const before = structuredClone(result);
  const binding = bindRewrite("attribution", result);
  const original = binding.request.input.items as RewriteItem[];
  const shown = binding.modelInput!.items as RewriteItem[];
  assert.equal(shown.length, 24);
  assert(original.some(item => item.id === "findings.0.assessment.impact"));
  assert(shown.every(item => item.text === "＜vis-html ref=html-7b1ac344 /＞保留24.2%、15.1%；x＜0且x＞5；已有＜visual＞。"));
  assert(original.every(item => item.text === text));
  assert.deepEqual(shown.map(item => item.id), original.map(item => item.id));
  assert.deepEqual(result, before);
});

test("clustering rewrite presentation covers ordinary HTML and mathematical angle characters without parsing them", () => {
  const result = { assignments: [], new_classes: [{ key: "n1", component: "格式", label: "<div>格式",
    definition: "<div>5.1</div>；a<b>c。", closest_existing: null, novelty: "保留<tag attr='123'>协议名和属性。" }],
    merges: [{ into: "target", from: ["source"], reason: "x<0；已有＜0＞。" }] };
  const before = structuredClone(result);
  const binding = bindRewrite("clustering", result, {});
  const original = binding.request.input.items as RewriteItem[];
  const shown = binding.modelInput!.items as RewriteItem[];
  assert.deepEqual(shown.map(item => ({ label: item.label, text: item.text })), [
    { label: "＜div＞格式 · 名称", text: "＜div＞格式" },
    { label: "＜div＞格式 · 定义", text: "＜div＞5.1＜/div＞；a＜b＞c。" },
    { label: "＜div＞格式 · 新建理由", text: "保留＜tag attr='123'＞协议名和属性。" },
    { label: "合并理由", text: "x＜0；已有＜0＞。" },
  ]);
  assert.equal(original[1]!.label, "<div>格式 · 定义");
  assert.equal(original[1]!.text, "<div>5.1</div>；a<b>c。");
  assert.deepEqual(result, before);
});
