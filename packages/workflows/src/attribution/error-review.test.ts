import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, type SessionProblem } from "@eval/agents/attribution";
import { cite, evidenceSources, parseEvidenceCoordinates } from "@eval/tools";
import { ValidationError, type JsonObject } from "@eval/contracts";
import { adapt, type RawInput } from "@eval/workflows/inputs";
import { sourceCompactReceipt, componentDraft, componentTask, memberIndex } from "../../../../tests/fixtures/compact.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { bindAttribution, attributionWorkflow } from "./index.js";

function fixture(mode: "unresolved" | "recovered" | "misread" | "business") {
  const final = mode === "business" ? "脚本已保存文件，但月度表为空，未能交付。" : mode === "unresolved" ? "脚本失败，文件未交付。" : mode === "recovered" ? "已生成并交付工作簿。" : "月度租金合计为200。";
  const raw: RawInput = { batch_id: "batch", case_id: `error-${mode}`, messages: [
    { type: "user_question", content: "生成含120个月度行的工作簿并核对租金合计。" },
    { type: "llm_turn", name: "planner-excel", output: "运行 make.py 构建并核验工作簿。" },
    { type: "tool_call", name: "shell", call_id: "build", input: { command: "python make.py" } },
    { type: "tool_result", name: "shell", call_id: "build", output: mode === "business" ? { exit_code: 0, stdout: "saved workbook.xlsx; monthly_rows=0; monthly_total=0; CHECK" } : mode === "misread" ? { exit_code: 0, stdout: "monthly_total=100; PASS" }
      : { exit_code: 1, stderr: 'File "make.py", line 8\nNameError: MON_HDR is not defined' } },
    ...(mode !== "recovered" ? [] : [
      { type: "tool_call", name: "shell", call_id: "fixed", input: { command: "python make.py" } },
      { type: "tool_result", name: "shell", call_id: "fixed", output: { exit_code: 0, stdout: "monthly_total=100; PASS; delivered workbook.xlsx" } },
    ]),
    { type: "llm_turn", name: "llm-call-final", output: final },
    { type: "final_answer", content: final },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const receipt = sourceCompactReceipt(candidate, raw), compact = receipt.evaluation as { turns: { tool_errors: JsonObject[] }[] };
  if (mode === "unresolved" || mode === "recovered") {
    const source = evidenceSources(raw.messages[3]).find(source => source.path === "/output/stderr")!;
    const { evidence_id, quote } = cite(candidate.input_id, 3, source, 0, source.text.length);
    compact.turns[0]!.tool_errors = [{ tool_error_idx: 1, tool_error_content: "make.py 未定义变量，构建报错。", evidence: [{ evidence_id, quote }] }];
  }
  const actor = mode === "misread" ? "最终答复生成" : "make.py", inputs = { [candidate.input_id]: raw }, task = componentTask(candidate, receipt, inputs, actor);
  const binding = bindAttribution(task, inputs, { compact: receipt }), registry = new AgentRegistry([attributionAgent]), prepared = registry.prepare(binding);
  const index = (message: number, path: string) => prepared.evidenceBank.findIndex(id => {
    const point = parseEvidenceCoordinates(id);
    return point?.kind === "text" && point.message_index === message && point.path === path;
  }) + 1;
  const original = index(3, mode === "misread" || mode === "business" ? "/output/stdout" : "/output/stderr");
  assert(original > 0);
  const finalIndex = index(raw.messages.length - 1, "/content"); assert(finalIndex > 0);
  const problem = mode === "recovered" ? { label: "首次构建报错", definition: "脚本引用未定义变量导致首次构建失败。",
    problem_phenomena: "首次运行 make.py 报 NameError，修复后重建通过。", reason: "make.py 引用未定义的 MON_HDR，第二次运行已修正。",
    severity: "P4", severity_reason: "修复后重建通过并交付，无剩余交付影响。",
    evidence: [{ index: original, reason: "首次构建报错。" }, { index: index(5, "/output/stdout"), reason: "修正后重建回执。" }] }
    : { label: mode === "misread" ? "合计误读" : "工作簿未交付", definition: "实际结果与交付要求不一致。",
    problem_phenomena: final, reason: mode === "business" ? "构建完成却生成0行，未达到120行要求。" : mode === "misread" ? "正确的100被终稿误写为200。" : "make.py 未定义变量导致构建失败，未修复。",
    severity: "P1", severity_reason: "核心结果不可用。", evidence: [{ index: original, reason: "实际执行回执。" }, { index: finalIndex, reason: "最终交付。" }] };
  const draft = componentDraft([problem], memberIndex(binding.request.input.components as JsonObject[], actor));
  if (mode === "unresolved" || mode === "recovered") draft.tool_error_reviews.push({ tool_error_idx: 1,
    status: mode === "recovered" ? "recovered_no_impact" : "unresolved_impact",
    content: mode === "recovered" ? "修复后验收通过并交付，无剩余影响。" : "变量未定义且未恢复，阻断交付。",
    evidence: mode === "recovered" ? [original, index(5, "/output/stdout"), finalIndex] : [original, finalIndex],
  });
  if (mode === "unresolved" || mode === "recovered") draft.problems[0]!.tool_error_indices = [1];
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  return { registry, binding, draft, audit, task, receipt, inputs, finalIndex };
}

for (const mode of ["unresolved", "recovered", "misread", "business"] as const) test(`group review closes original error evidence and keeps recovered errors as P4: ${mode}`, () => {
  const f = fixture(mode), result = f.registry.resolve(f.binding, f.draft, f.audit) as { problem: SessionProblem[] };
  f.registry.validate(f.binding, result, f.audit);
  attributionWorkflow.advance!(f.task, { ...f.receipt, evaluation: result, submitted: f.draft, audit: f.audit }, {} as never, f.inputs);
  assert.deepEqual(result.problem.map(problem => [problem.component, problem.severity]), mode === "misread" ? [["最终答复生成", "P1"]] : [["make.py", mode === "recovered" ? "P4" : "P1"]]);
  assert(!JSON.stringify(result.problem).includes("tool_error_reviews"));
  assert(!JSON.stringify(result.problem).includes("tool_error_indices"));
});

test("error disposition cannot skip original exception, disappear, or move to final disclosure", () => {
  const f = fixture("unresolved");
  const missing = structuredClone(f.draft); missing.tool_error_reviews = [];
  assert.throws(() => f.registry.resolve(f.binding, missing, f.audit), ValidationError);
  const unrelated = structuredClone(f.draft);
  (unrelated.tool_error_reviews[0] as { evidence: number[] }).evidence = [f.finalIndex];
  assert.throws(() => f.registry.resolve(f.binding, unrelated, f.audit), /原始报错消息/);
  const finalTask = componentTask((f.task.data as { candidate: Parameters<typeof componentTask>[0] }).candidate, f.receipt, f.inputs, "最终答复生成");
  const finalBinding = bindAttribution(finalTask, f.inputs, { compact: f.receipt });
  assert.deepEqual(finalBinding.request.input.tool_errors, [], "execution errors are not transferred to final disclosure");

});

test("recovery needs a later tool receipt, not only the original failure or final self-report", () => {
  const f = fixture("recovered");
  for (const evidence of [[f.draft.tool_error_reviews[0]!.evidence[0]!],
    [f.draft.tool_error_reviews[0]!.evidence[0]!, f.finalIndex]]) {
    const unsupported = structuredClone(f.draft); unsupported.tool_error_reviews[0]!.evidence = evidence;
    assert.throws(() => f.registry.resolve(f.binding, unsupported, f.audit), /之后的实际工具回执/);
  }
  const unknown = structuredClone(f.draft), error = unknown.tool_error_reviews[0]!;
  error.status = "uncertain"; error.content = "仅确认发生过异常，后续恢复和剩余影响未取得决定性证据。";
  error.evidence = [error.evidence[0]!];
  assert.throws(() => f.registry.resolve(f.binding, unknown, f.audit), /uncertain 不关联问题/);
  unknown.problems = [];
  assert.doesNotThrow(() => f.registry.resolve(f.binding, unknown, f.audit));
});
