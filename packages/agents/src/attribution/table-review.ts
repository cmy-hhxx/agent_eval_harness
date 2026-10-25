import { canonical, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { compareTraceTableRows, evidenceCovers, maskCitationMarkup, parseTraceTables, type TableCheckRequest, type TableCheckResult, type TableRowCheck, type TraceTable } from "@eval/tools";
import type { AttributionResult, Evidence } from "./types.js";
import { ownEvidence } from "./source-evidence.js";

const codeHeaders = new Set(["代码", "股票代码", "证券代码", "基金代码", "code", "ticker"]);
const nameHeaders = new Set(["名称", "简称", "公司名称", "公司简称", "企业名称", "企业简称", "股票名称", "股票简称", "证券名称", "证券简称", "基金名称", "基金简称", "name"]);
const header = (value: string) => value.replace(/\s/gu, "").toLowerCase();
const entityText = (value: string) => maskCitationMarkup(value).replace(/\s+/gu, " ").trim();
function columns(table: TraceTable) {
  const code = table.headers.flatMap((value, index) => codeHeaders.has(header(value)) ? [index] : []);
  const name = table.headers.flatMap((value, index) => nameHeaders.has(header(value)) ? [index] : []);
  return code.length === 1 && name.length === 1 ? { code: code[0], name: name[0] } : undefined;
}
function sameCode(left: string, right: string): boolean {
  left = entityText(left); right = entityText(right);
  if (left === right) return true;
  const pattern = /^(\d{6})(?:\.(SH|SZ|BJ))?$/iu;
  const a = pattern.exec(left), b = pattern.exec(right);
  return !!a && !!b && a[1] === b[1] && (!a[2] || !b[2] || a[2].toUpperCase() === b[2].toUpperCase());
}
/** Only explicit code/name tables with comparable earlier tool tables require this bounded check. */
export function attributionTablePlan(raw: { messages: unknown[] }, inputId: string, finalIndex: number): TableCheckRequest[] {
  return tablePlans(raw, parseTraceTables(raw, inputId), finalIndex);
}
function tablePlans(raw: { messages: unknown[] }, tables: TraceTable[], finalIndex: number): TableCheckRequest[] {
  const sources = tables.filter(table => {
    const message = raw.messages[table.message_index] as { role?: string; type?: string };
    return table.message_index < finalIndex && columns(table) &&
      (message.role === "tool" || ["function_call_output", "tool_result"].includes(message.type ?? ""));
  });
  return tables.filter(table => table.message_index === finalIndex).flatMap(answer => {
    const a = columns(answer);
    if (!a || !answer.rows.length) return [];
    const related = sources.flatMap(source => {
      const s = columns(source)!;
      if (!answer.rows.some(row => source.rows.some(other =>
        entityText(row.cells[a.name] ?? "") === entityText(other.cells[s.name] ?? "") || sameCode(row.cells[a.code] ?? "", other.cells[s.code] ?? "")))) return [];
      return [{ table_id: source.table_id, key_columns: [{ answer: a.name, source: s.name }],
        value_columns: [{ answer: a.code, source: s.code }] }];
    });
    return related.length ? [{ answer_table_id: answer.table_id, sources: related }] : [];
  });
}

/** Summarize every normalized row and retain full evidence for doubts; this records no model call or read. */
export function attributionTableChecks(raw: { messages: unknown[] }, inputId: string, finalIndex: number): TableCheckResult[] {
  const tables = parseTraceTables(raw, inputId);
  const plans = new Map(tablePlans(raw, tables, finalIndex).map(plan => [plan.answer_table_id, plan]));
  return tables.filter(table => table.message_index === finalIndex && columns(table) && table.rows.length).map(answer => {
    const plan = plans.get(answer.table_id);
    if (!plan) return {
      answer_table_id: answer.table_id,
      rows: answer.rows.map(row => ({ row_index: row.row_index, status: "unverified" as const,
        answer: { cells: row.cells, evidence: row.evidence }, sources: [] })),
      summary: { matched: 0, conflict: 0, unverified: answer.rows.length, ambiguous: 0 },
    };
    const checked = compareTraceTableRows(raw, plan, inputId);
    const summary: TableCheckResult["summary"] = { matched: 0, conflict: 0, unverified: 0, ambiguous: 0 };
    const rows = checked.rows.flatMap(row => {
      const status = rowStatus(row, plan);
      summary[status] += 1;
      return status === "matched" ? [] : [{ ...row, status }];
    });
    return { ...checked, rows, summary };
  });
}
function supports(evidence: Evidence[], row: TableRowCheck, plan: TableCheckRequest, raw: { messages: unknown[] }, inputId: string): boolean {
  const contains = (expected: TableRowCheck["answer"]["evidence"], values: string[]) => {
    const selected = evidence.filter(item => ownEvidence(item) && item.message_index === expected.message_index &&
      (evidenceCovers(raw, inputId, expected.evidence_id, item.evidence_id) ||
        evidenceCovers(raw, inputId, item.evidence_id, expected.evidence_id)));
    // Findings cite the compared cells; complete rows remain in the program-owned table material.
    return selected.some(item => item.quote.includes(expected.quote)) || values.every(value =>
      value.length > 0 && selected.some(item => entityText(item.quote).includes(entityText(value))));
  };
  return row.sources.some(source => {
    const mapping = plan.sources.find(item => item.table_id === source.table_id)!;
    const pairs = [...mapping.key_columns, ...mapping.value_columns];
    return contains(row.answer.evidence, pairs.map(pair => row.answer.cells[pair.answer] ?? "")) &&
      contains(source.evidence, pairs.map(pair => source.cells[pair.source] ?? ""));
  });
}
function rowStatus(row: TableRowCheck, plan: TableCheckRequest): TableRowCheck["status"] {
  if (row.status === "unverified") return row.status;
  const matches = row.sources.map(source => {
    const mapping = plan.sources.find(item => item.table_id === source.table_id)!;
    return mapping.key_columns.every(pair => entityText(row.answer.cells[pair.answer] ?? "") === entityText(source.cells[pair.source] ?? "")) &&
      mapping.value_columns.every(pair => sameCode(row.answer.cells[pair.answer] ?? "", source.cells[pair.source] ?? ""));
  });
  if (matches.length && matches.every(Boolean)) return "matched";
  return matches.some(Boolean) ? "ambiguous" : row.status;
}

export interface TableReviewConcern {
  kind: "unverified" | "unresolved_conflict";
  table_id: string;
  row_index: number;
  reason: string;
}

/** Recompute evidence coverage; semantic equivalence is the agent's cited judgment. */
export function attributionTableReview(request: AgentRequest, result: AttributionResult) {
  const raw = request.sources.answer.value as { messages: unknown[] };
  const inputId = request.sources.answer.id;
  const finalIndex = (request.input.answer as { final_message_index: number }).final_message_index;
  const plans = attributionTablePlan(raw, inputId, finalIndex);
  const material = attributionTableChecks(raw, inputId, finalIndex);
  const plannedChecks = new Map(plans.map(plan => [plan.answer_table_id, compareTraceTableRows(raw, plan, inputId)]));
  const fullChecks = material.map(check => plannedChecks.get(check.answer_table_id) ?? check);
  const errors: ValidationIssue[] = [], concerns: TableReviewConcern[] = [];
  const provided = (request.input.answer as { table_check_results?: unknown }).table_check_results;
  if (!Array.isArray(provided) || canonical(provided) !== canonical(material)) {
    errors.push({ category: "evidence", code: Array.isArray(provided) ? "table_check_results_mismatch" : "table_check_results_missing",
      path: "/answer/table_check_results", message: "请求中的表格对应核验材料必须完整且与原始材料重算结果一致。",
      expected: material, actual: provided });
  }
  for (const checked of fullChecks) {
    const plan = plans.find(plan => plan.answer_table_id === checked.answer_table_id);
    for (const row of checked.rows) {
      const status = plan ? rowStatus(row, plan) : row.status;
      if (status === "matched") continue;
      const location = `消息${row.answer.evidence.message_index}表格第${row.row_index + 1}行`;
      if (!plan) continue;
      if (status === "unverified") {
        // A textual placeholder does not assert an identifier. Whether an unknown
        // value satisfies the task remains a criterion judgment, not a source mismatch.
        const asserted = plan.sources[0].value_columns.some(pair =>
          /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(entityText(row.answer.cells[pair.answer] ?? "")));
        if (!asserted) continue;
        concerns.push({ kind: "unverified", table_id: plan.answer_table_id, row_index: row.row_index,
          reason: `${location}缺少可匹配的来源行；这不证明答案错误，需要核对来源截断、对象与范围。` });
        continue;
      }
      const findings = result.Problem.filter(finding => supports(finding.evidence, row, plan, raw, inputId));
      if (status === "ambiguous" || !findings.some(finding => finding.evidence_status === "established"))
        concerns.push({ kind: "unresolved_conflict", table_id: plan.answer_table_id, row_index: row.row_index,
          reason: `${location}仍有未解决的来源对应冲突，须独立核对对象、别名、时间范围和加工过程。` });
    }
  }
  return { plans, errors, concerns };
}
