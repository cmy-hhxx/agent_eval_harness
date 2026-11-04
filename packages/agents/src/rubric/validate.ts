import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import batchSchema from "../../../../schemas/rubric/result.schema.json" with {type:"json"};
import caseSchema from "../../../../schemas/rubric/case.schema.json" with {type:"json"};
import type { RubricCase, RubricChecklistItem, RubricResult, RubricState } from "./types.js";

const batchShape = new Ajv2020({allErrors:true,strict:false}).compile(batchSchema);
const caseShape = new Ajv2020({allErrors:true,strict:false}).compile(caseSchema);
const states: RubricState[] = ["pass", "partial", "fail", "na"];

/** One trace's checklist handed to the judge; the Host builds it from the standard and the given label. */
export function rubricCase(request: AgentRequest): RubricCase {
  return request.input as unknown as RubricCase;
}

/** A case-level row merges the accepted per-trace batches; it never re-judges anything. */
export interface RubricCaseMaterial {
  case_id: string;
  batch_id: string;
  version: string;
  traces: {trace_index: number; category: RubricCase["category"]; checklist: RubricChecklistItem[]}[];
}

type Bad = (path: string, message: string) => void;

function checkVerdicts(checklist: RubricChecklistItem[], verdicts: RubricResult["verdicts"],
  counts: RubricResult["counts"], path: string, bad: Bad): void {
  if (verdicts.length !== checklist.length) bad(`${path}/verdicts`, "每条标准条目必须恰好判定一次，不增不减。");
  const seen = new Set<number>(), totals: Record<RubricState, number> = {pass: 0, partial: 0, fail: 0, na: 0};
  for (const [index, verdict] of verdicts.entries()) {
    const at = `${path}/verdicts/${index}`, item = checklist.find(item => item.index === verdict.item_index);
    if (!item) { bad(`${at}/item_index`, "条目编号超出本题清单范围。"); continue; }
    if (seen.has(verdict.item_index)) bad(`${at}/item_index`, "同一标准条目不能重复判定。");
    seen.add(verdict.item_index);
    if (verdict.item_id !== item.item_id || verdict.source !== item.source) bad(at, "条目ID与来源必须原样沿用标准条目。");
    if (item.kind !== undefined && verdict.kind !== item.kind) bad(`${at}/kind`, "条目类别必须与标准一致。");
    if (!item.states.includes(verdict.state)) bad(`${at}/state`, `本条只允许 ${item.states.join(" / ")}。`);
    if (item.judge === "program" && !["pass", "fail", "na"].includes(verdict.state)) bad(`${at}/state`, "程序判只有 pass / fail；不适用才判 na。");
    if (!verdict.reason.trim()) bad(`${at}/reason`, "每条判定必须写出依据。");
    if (verdict.state === "na") {
      if (!verdict.na_reason?.trim()) bad(`${at}/na_reason`, "判 na 必须写明 na_reason。");
      totals.na += 1;
      continue;
    }
    if (verdict.na_reason !== undefined) bad(`${at}/na_reason`, "非 na 判定不能填写 na_reason。");
    if (!verdict.evidence.length) bad(`${at}/evidence`, "判定必须附原文证据；查不到原文时只能判 na 并写明原因。");
    totals[verdict.state] += 1;
  }
  for (const {index} of checklist) if (!seen.has(index)) bad(`${path}/verdicts`, `缺少编号 ${index} 的标准条目判定。`);
  for (const state of states) if (counts[state] !== totals[state]) bad(`${path}/counts`, "状态计数只能由逐条判定汇总，不能自行填写或加权。");
}

export function validateRubric(request: AgentRequest, result: unknown, _audit: ToolAudit): void {
  if (!batchShape(result)) throw new ValidationError(schemaIssues(batchShape.errors, result));
  const material = rubricCase(request), value = result as unknown as RubricResult, issues: ValidationIssue[] = [];
  const bad: Bad = (path, message) => issues.push({category: "decision", code: "rubric_contract", path, message});
  if (value.case_id !== material.case_id) bad("/case_id", "必须使用执行器提供的本题ID。");
  if (value.trace_index !== material.trace_index) bad("/trace_index", "trace 序号必须与本题材料一致。");
  if (value.batch_id !== material.batch_id) bad("/batch_id", "业务批次必须与本题材料一致。");
  if (value.version !== material.version) bad("/version", "模型版本必须与本题材料一致。");
  if (value.category_id !== material.category.id || value.category_name !== material.category.name)
    bad("/category_id", "二级分类必须原样沿用执行器给定的标签，不能自行归类或改写。");
  if (value.l1_id !== material.category.l1 || value.l1_name !== material.category.l1_name)
    bad("/l1_id", "一级分类必须原样沿用执行器给定的标签。");
  if (value.checklist_size !== material.checklist.length) bad("/checklist_size", "清单条数必须与标准给定的条数一致。");
  checkVerdicts(material.checklist, value.verdicts, value.counts, "", bad);
  if (issues.length) throw new ValidationError(issues);
}

export function validateRubricCase(request: AgentRequest, result: unknown, _audit: ToolAudit): void {
  if (!caseShape(result)) throw new ValidationError(schemaIssues(caseShape.errors, result));
  const material = request.input as unknown as RubricCaseMaterial;
  const value = result as unknown as RubricResult & {traces: RubricResult[]};
  const issues: ValidationIssue[] = [];
  const bad: Bad = (path, message) => issues.push({category: "decision", code: "rubric_contract", path, message});
  if (value.case_id !== material.case_id) bad("/case_id", "必须使用执行器提供的本题ID。");
  if (value.batch_id !== material.batch_id) bad("/batch_id", "业务批次必须与本题材料一致。");
  if (value.version !== material.version) bad("/version", "模型版本必须与本题材料一致。");
  const traces = new Map(value.traces.map(trace => [trace.trace_index, trace]));
  if (traces.size !== value.traces.length) bad("/traces", "trace 不能重复。");
  if (traces.size !== material.traces.length) bad("/traces", "每条 trace 必须恰好一份清单。");
  for (const trace of material.traces) {
    const row = traces.get(trace.trace_index);
    if (!row) { bad("/traces", `缺少 trace ${trace.trace_index} 的清单。`); continue; }
    const path = `/traces/${trace.trace_index}`;
    if (row.category_id !== trace.category.id || row.category_name !== trace.category.name)
      bad(`${path}/category_id`, "二级分类必须与执行器给定的标签一致。");
    if (row.l1_id !== trace.category.l1 || row.l1_name !== trace.category.l1_name)
      bad(`${path}/l1_id`, "一级分类必须与执行器给定的标签一致。");
    if (row.case_id !== material.case_id || row.batch_id !== material.batch_id || row.version !== material.version)
      bad(path, "trace 业务身份必须与 case 一致。");
    if (row.checklist_size !== trace.checklist.length) bad(`${path}/checklist_size`, "清单条数必须与标准给定的条数一致。");
    checkVerdicts(trace.checklist, row.verdicts, row.counts, path, bad);
  }
  for (const state of states) if (value.counts[state] !== value.traces.reduce((sum, trace) => sum + trace.counts[state], 0))
    bad("/counts", "case 状态计数必须等于所有 trace 计数之和。");
  if (issues.length) throw new ValidationError(issues);
}
