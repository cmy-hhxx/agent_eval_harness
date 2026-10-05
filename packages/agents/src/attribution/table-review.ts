import { canonical, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { compareTraceTableRows, displayEvidence, evidenceSources, maskCitationMarkup, parseTraceTables, type TableCheckRequest, type TableCheckResult, type TableRowCheck, type TraceTable } from "@eval/tools";
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
function literalPairStatement(text: string, name: string, code: string): boolean {
  text = entityText(text); name = entityText(name); code = entityText(code);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`^(?:查询(?:结果|返回)\\s*[:：]\\s*)?${escape(name)}(?:的)?(?:股票|证券)?代码\\s*(?:为|是|[:：=])\\s*([A-Za-z0-9][A-Za-z0-9_.-]*?)[。.!]?$`, "u");
  const match = expression.exec(text.trim());
  return !!match && sameCode(match[1], code);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function codeInput(value: unknown): boolean {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return false; }
  }
  const input = record(value);
  return !!input && ["code", "script", "command", "cmd"].some(key => typeof input[key] === "string");
}
function executionCall(value: unknown): boolean {
  const call = record(value);
  if (!call) return false;
  const fn = record(call.function) ?? call;
  return /(?:^|[./:])(?:execute_code|run_code|code_interpreter|python3?|bash|shell)$/iu.test(String(fn.name ?? "")) ||
    codeInput(fn.arguments) || codeInput(fn.input);
}
/** Restrict independent support to returned text, with observable execution provenance excluded. */
function independentReturnText(messages: unknown[], index: number): string[] {
  const message = record(messages[index]);
  if (!message || !(message.role === "tool" || ["function_call_output", "tool_result"].includes(String(message.type))) ||
    executionCall(message) || Object.hasOwn(message, "stdout") || Object.hasOwn(message, "stderr")) return [];
  const ids = [message.call_id, message.tool_call_id].filter(value => typeof value === "string");
  if (ids.length && messages.slice(0, index).some(value => {
    const earlier = record(value);
    return [earlier, ...(Array.isArray(earlier?.tool_calls) ? earlier.tool_calls : [])].some(value => {
      const call = record(value);
      return !!call && ids.some(id => id === call.call_id || id === call.id) && executionCall(call);
    });
  })) return [];
  const material = Object.fromEntries(Object.entries(message).filter(([key]) => ["content", "output", "result"].includes(key)));
  const leaves = evidenceSources(material).filter(source => source.kind === "text");
  if (leaves.some(source => /\/(?:stdout|stderr)(?:\/|$)/iu.test(source.path))) return [];
  return leaves.filter(source => !/\/(?:input|input_messages|arguments|metadata)(?:\/|$)/iu.test(source.path))
    .map(source => source.text);
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
function supports(evidence: Evidence[], row: TableRowCheck): boolean {
  const contains = (expected: { message_index: number; quote: string }) => evidence.some(item =>
    ownEvidence(item) && item.message_index === expected.message_index && item.quote.includes(expected.quote));
  return contains(row.answer.evidence) && row.sources.some(source => contains(source.evidence));
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

/** Recompute from source records, never trust a model-supplied comparison verdict. */
export function attributionTableReview(request: AgentRequest, result: AttributionResult, options: { accepted?: boolean } = {}) {
  const raw = request.sources.answer.value as { messages: unknown[] };
  const inputId = request.sources.answer.id;
  const finalIndex = (request.input.answer as { final_message_index: number }).final_message_index;
  const plans = attributionTablePlan(raw, inputId, finalIndex);
  const fullChecks = plans.map(plan => compareTraceTableRows(raw, plan, inputId));
  const material = attributionTableChecks(raw, inputId, finalIndex);
  const errors: ValidationIssue[] = [], concerns: TableReviewConcern[] = [];
  const confirmedConflicts: { table_id: string; row_index: number; finding_indices: number[] }[] = [];
  const provided = (request.input.answer as { table_check_results?: unknown }).table_check_results;
  if (!Array.isArray(provided) || canonical(provided) !== canonical(material)) {
    errors.push({ category: "evidence", code: Array.isArray(provided) ? "table_check_results_mismatch" : "table_check_results_missing",
      path: "/answer/table_check_results", message: "请求中的表格对应核验材料必须完整且与原始材料重算结果一致。",
      expected: material, actual: provided });
  }
  const resolutions = new Map<string, NonNullable<AttributionResult["table_resolutions"]>[number]>();
  const hasEvidence = (evidence: Evidence[], target: { message_index: number; quote: string }) => evidence.some(item =>
    ownEvidence(item) && item.message_index === target.message_index && item.quote.includes(target.quote));
  for (const [index, resolution] of (result.table_resolutions ?? []).entries()) {
    const key = `${resolution.table_id}:${resolution.row_index}`;
    const planIndex = plans.findIndex(plan => plan.answer_table_id === resolution.table_id);
    const row = fullChecks[planIndex]?.rows.find(row => row.row_index === resolution.row_index);
    if ((!options.accepted && !request.input.review_context) || !resolution.reason.trim() || resolutions.has(key) ||
      !row || rowStatus(row, plans[planIndex]) === "matched") {
      errors.push({ category: "evidence", code: "table_resolution_invalid", path: `/table_resolutions/${index}`,
        message: "仅独立复核可提交给定表格行的核验结论，每行一次，不能绕过来源核对。" });
      continue;
    }
    resolutions.set(key, resolution);
  }
  for (const [planIndex, plan] of plans.entries()) {
    const checked = fullChecks[planIndex];
    for (const row of checked.rows) {
      const status = rowStatus(row, plan);
      if (status === "matched") continue;
      const location = `消息${row.answer.evidence.message_index}表格第${row.row_index + 1}行`;
      const resolution = resolutions.get(`${plan.answer_table_id}:${row.row_index}`);
      let resolved = false;
      if (resolution) {
        const nameColumn = plan.sources[0].key_columns[0].answer;
        const codeColumn = plan.sources[0].value_columns[0].answer;
        const name = row.answer.cells[nameColumn], code = row.answer.cells[codeColumn];
        // A later positive statement can fill a missing source row, but cannot
        // erase an already observed conflict. Keep each returned leaf intact.
        const originalSupport = status === "unverified" && resolution.evidence.some(item => {
          const peer = item.source === undefined ? undefined : record((request.input.reference_materials as Record<string, unknown> | undefined)?.[item.source]);
          const source = item.source === undefined ? undefined : request.sources[item.source];
          const chosen = ownEvidence(item) ? { raw, finalIndex } : peer?.grader_only === true && source &&
            item.source_input_id === source.id && peer.source_input_id === source.id && record(source.value) &&
            Array.isArray(record(source.value)!.messages) && typeof peer.final_message_index === "number"
            ? { raw: source.value as { messages: unknown[] }, finalIndex: peer.final_message_index } : undefined;
          return !!chosen && item.message_index < chosen.finalIndex && independentReturnText(chosen.raw.messages, item.message_index).some(text =>
            text.trim() === item.quote.trim() && literalPairStatement(text, name, code));
        });
        const completeEvidence = hasEvidence(resolution.evidence, row.answer.evidence) &&
          row.sources.every(source => hasEvidence(resolution.evidence, source.evidence));
        const supportedProblem = result.findings.some(finding => finding.type === "problem" &&
          finding.assessment.evidence_status === "established" && supports(finding.evidence, row));
        resolved = completeEvidence && !!resolution.reason.trim() &&
          (resolution.outcome === "supported" ? originalSupport : supportedProblem);
        if (!resolved) errors.push({ category: "evidence", code: "table_resolution_unsupported", path: "/table_resolutions",
          message: `${location}的独立结论缺少最终行、全部已知反证或对应原始来源；不能仅以解释文字解除疑点。` });
        if (resolved && resolution.outcome === "supported") continue;
      }
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
      const findings = result.findings.filter(finding => finding.type === "problem" && supports(finding.evidence, row));
      if (status === "conflict") {
        const findingIndices = result.findings.flatMap((finding, index) => finding.type === "problem" &&
          finding.assessment.evidence_status === "established" && supports(finding.evidence, row) ? [index] : []);
        if (findingIndices.length) confirmedConflicts.push({ table_id: plan.answer_table_id,
          row_index: row.row_index, finding_indices: findingIndices });
      }
      if (!findings.length) errors.push({ category: "evidence", code: "table_conflict_unreported", path: "/findings",
        message: `${location}与来源存在字面对应冲突，须引用两侧原文在 finding 中说明事实、别名/范围或不确定性，不能遗漏。`,
        expected: { status, suggested_evidence: [row.answer.evidence, ...row.sources.map(source => source.evidence)].map(displayEvidence) } });
      if (!resolved && (status === "ambiguous" || !findings.some(finding => finding.assessment.evidence_status === "established")))
        concerns.push({ kind: "unresolved_conflict", table_id: plan.answer_table_id, row_index: row.row_index,
          reason: `${location}仍有未解决的来源对应冲突，须独立核对对象、别名、时间范围和加工过程。` });
    }
  }
  return { plans, errors, concerns, confirmed_conflicts: confirmedConflicts };
}
