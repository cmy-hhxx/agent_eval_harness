import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import type { RewriteItem } from "@eval/agents/rewrite";
import { rewriteAgent } from "@eval/agents/rewrite";
import { AgentRegistry } from "@eval/host";
import { attributionResult, comparisonResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { bindTask } from "./workflow.js";
import type { TaskData } from "./types.js";

function bindRewrite(stage: "attribution" | "comparison" | "clustering", evaluation: unknown,
  names: Record<string, string> = { A: "A组Fast", B: "B组Fast" }) {
  const source: SubmissionReceipt = { taskId: "source", attemptId: "attempt", submissionId: "submission",
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation,
    audit: emptyAudit(), usage: emptyUsage() };
  const task: PlannedTask = { id: "rewrite", stage: "rewrite", inputIds: {}, dependencies: { source: source.taskId },
    data: { stage: "rewrite", candidates: {}, reference: null, case: { batch_id: "batch", case_id: "case", question: "" },
      rewriteOf: { stage, taskId: source.taskId, resultId: "result" }, rewriteNames: names,
      comparisonRewriteScope: "all" } satisfies TaskData };
  return bindTask(task, {}, { source }, { tasks: [task] });
}

test("Workflow binds ordered text to original slot identities and rejects missing positions", () => {
  const binding=bindRewrite("comparison",comparisonResult()),registry=new AgentRegistry([rewriteAgent]);
  const shown=binding.modelInput!.items as RewriteItem[];
  assert(shown.every(item=>!Object.hasOwn(item,"id")));
  const draft={texts:shown.map(item=>item.preference?item.preference+"：双方都给出了正确结果4。":item.text)};
  const before=structuredClone(draft),result=registry.resolve(binding,draft,emptyAudit()) as {rewrites:{id:string;text:string}[]};
  registry.validate(binding,result,emptyAudit());
  assert.deepEqual(result.rewrites.map(item=>item.id),(binding.request.input.items as RewriteItem[]).map(item=>item.id));
  assert.deepEqual(draft,before);
  assert.throws(()=>registry.resolve(binding,{texts:draft.texts.slice(1)},emptyAudit()),/数量必须与槽位一致/);
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
  assert(items[0].text.includes(result.decision_basis.tradeoff));
  assert.equal(items[0].label, "B组Fast与A组Fast的偏好及理由");
  assert(items.every(item => item.context?.split("\n")[0] === mapping));
  assert.equal(items[1].label, "计算结果 · B组Fast的逐项点评（只改写本格）");
  assert(items[1].context!.includes("同项对照，不能写成本格事实：A组Fast："));
  assert(items[1].forbiddenPrefixes!.includes("A组Fast："));
  const shown = binding.modelInput!.items as RewriteItem[];
  assert(shown.every(item => item.context?.split("\n")[0] === mapping));
});

test("Rewrite projects protocol seeds in verdicts and readonly cells without changing exact slot metadata", () => {
  const result = comparisonResult();
  result.ranking = [["A"], ["B"]];
  result.decision_basis.tradeoff = "漏插<visual>属小瑕疵；27.98%与27.18%-27.80%的口径不变。";
  const row = result.decision_basis.comparisons[0]!;
  row.aspect = "展示<visual>协议与x<0条件";
  row.better_candidates = ["A"];
  row.assessments.A!.summary = "使用<visual>展示27.98%。";
  row.assessments.B!.summary = "来源<trace ref=Ab12Cd3 />；模板[^<int>]。";
  const before = structuredClone(result);
  const binding = bindRewrite("comparison", result, { A: "A组<Fast>", B: "B组<Fast>" });
  const original = binding.request.input.items as RewriteItem[];
  const shown = binding.modelInput!.items as RewriteItem[];
  assert.equal(shown.length, 3);
  assert(shown[0]!.text.includes("漏插＜visual＞属小瑕疵；27.98%与27.18%-27.80%的口径不变。"));
  assert.equal(shown[1]!.label, "展示＜visual＞协议与x＜0条件 · A组＜Fast＞的逐项点评（只改写本格）");
  assert.equal(shown[1]!.text, "使用＜visual＞展示27.98%。");
  assert(shown[1]!.context!.includes("来源＜trace ref=Ab12Cd3 /＞；模板[^＜int＞]。"));
  assert.equal(shown[0]!.preference, "A组<Fast>更好");
  assert(shown[1]!.forbiddenPrefixes!.includes("B组<Fast>："));
  assert.deepEqual(shown.map(({ preference, forbiddenPrefixes }) => ({ preference, forbiddenPrefixes })),
    original.map(({ preference, forbiddenPrefixes }) => ({ preference, forbiddenPrefixes })));
  assert(shown.every(item => !/[<>]/.test([item.label, item.text, item.context ?? ""].join("\n"))));
  assert.equal(original[1]!.text, "使用<visual>展示27.98%。");
  assert(original[1]!.context!.includes("来源<trace ref=Ab12Cd3 />；模板[^<int>]。"));
  assert.deepEqual(result, before);
});

test("all attribution rewrite slots preserve protocol attributes and figures in their model-facing presentation", () => {
  const result = attributionResult();
  const text = "<vis-html ref=html-7b1ac344 />保留24.2%、15.1%；x<0且x>5；已有＜visual＞。";
  result.summary = text;
  result.correctness_reason = text;
  const finding = result.findings[0]!;
  result.findings = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(finding), finding_id: `f${index}`,
    text, reason: text, assessment: { ...finding.assessment, observation: text, impact: text } }));
  const before = structuredClone(result);
  const binding = bindRewrite("attribution", result);
  const original = binding.request.input.items as RewriteItem[];
  const shown = binding.modelInput!.items as RewriteItem[];
  assert.equal(shown.length, 12);
  assert(original.every(item => !item.id.includes(".assessment.")));
  assert(shown.every(item => item.text === "＜vis-html ref=html-7b1ac344 /＞保留24.2%、15.1%；x＜0且x＞5；已有＜visual＞。"));
  assert(original.every(item => item.text === text));
  assert(shown.every(item => !Object.hasOwn(item,"id")));
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
    { label: "＜div＞格式 · 定义", text: "＜div＞5.1＜/div＞；a＜b＞c。" },
    { label: "＜div＞格式 · 新建理由", text: "保留＜tag attr='123'＞协议名和属性。" },
    { label: "合并理由", text: "x＜0；已有＜0＞。" },
  ]);
  assert.equal(original[0]!.label, "<div>格式 · 定义");
  assert.equal(original[0]!.text, "<div>5.1</div>；a<b>c。");
  assert.deepEqual(result, before);
});
