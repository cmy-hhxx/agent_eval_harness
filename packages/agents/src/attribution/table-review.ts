import { compareTraceTableRows, maskCitationMarkup, parseTraceTables, type TableCheckRequest, type TableCheckResult, type TraceTable } from "@eval/tools";

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

function rowStatus(row: TableCheckResult["rows"][number], plan: TableCheckRequest): TableCheckResult["rows"][number]["status"] {
  if (row.status === "unverified") return row.status;
  const matches = row.sources.map(source => {
    const mapping = plan.sources.find(item => item.table_id === source.table_id)!;
    return mapping.key_columns.every(pair => entityText(row.answer.cells[pair.answer] ?? "") === entityText(source.cells[pair.source] ?? "")) &&
      mapping.value_columns.every(pair => sameCode(row.answer.cells[pair.answer] ?? "", source.cells[pair.source] ?? ""));
  });
  if (matches.length && matches.every(Boolean)) return "matched";
  return matches.some(Boolean) ? "ambiguous" : row.status;
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
