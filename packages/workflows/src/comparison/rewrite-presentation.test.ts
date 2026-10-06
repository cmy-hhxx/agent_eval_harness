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
  assert.equal(shown.length, 22);
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
