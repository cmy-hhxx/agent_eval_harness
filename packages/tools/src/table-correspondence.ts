import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { cite, evidenceSources } from "./evidence.js";

type TableEvidence = ReturnType<typeof cite>;
export interface TraceTableRow {
  row_index: number;
  cells: string[];
  evidence: TableEvidence;
}
export interface TraceTable {
  table_id: string;
  message_index: number;
  path: string;
  headers: string[];
  rows: TraceTableRow[];
  evidence: TableEvidence;
}
export interface TableColumnPair { answer: number; source: number }
export interface TraceTableSource {
  table_id: string;
  key_columns: TableColumnPair[];
  value_columns: TableColumnPair[];
}
export interface TableCheckRequest {
  answer_table_id: string;
  sources: TraceTableSource[];
}
export type TableRowStatus = "matched" | "conflict" | "unverified" | "ambiguous";
export interface TableRowCheck {
  row_index: number;
  /** Literal correspondence only: conflict does not establish an entity or a factual error. */
  status: TableRowStatus;
  answer: { cells: string[]; evidence: TableEvidence };
  sources: (TraceTableRow & { table_id: string; matched_by: "key" | "value" })[];
}
export interface TableCheckResult {
  answer_table_id: string;
  rows: TableRowCheck[];
  summary: Record<TableRowStatus, number>;
}
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
const visibleText = (node: MarkdownNode): string => node.value ?? (node.type === "break" ? "\n" :
  (node.children ?? []).map(visibleText).join(""));
const normalizeCell = (text: string) => text.replace(/\s+/gu, " ").trim();

/** Inventory actual message content/returns, never copied input_messages or model-authored call arguments. */
export function parseTraceTables(raw: { messages: unknown[] }): TraceTable[] {
  const tables: TraceTable[] = [];
  raw.messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    const isReturn = value.role === "tool" || ["function_call_output", "tool_result"].includes(String(value.type));
    if (!isReturn && ["function_call", "tool_call"].includes(String(value.type))) return;
    const material = Object.fromEntries(Object.entries(value).filter(([key]) =>
      (isReturn ? ["content", "output", "result"] : ["content"]).includes(key)));
    for (const source of evidenceSources(material).filter((item) => item.kind === "text")) {
      // Avoid parsing a large leaf unless it can contain a Markdown table delimiter.
      if (!source.text.includes("|") || !/\|\s*:?-{3,}/u.test(source.text)) continue;
      const visit = (node: MarkdownNode) => {
        if (node.type === "table") {
          const start = node.position?.start.offset, end = node.position?.end.offset;
          if (start === undefined || end === undefined) return;
          const nodes = node.children ?? [];
          const headers = (nodes[0]?.children ?? []).map((cell) => normalizeCell(visibleText(cell)));
          if (headers.length < 2) return;
          const evidence = cite(messageIndex, source, start, end);
          const rows = nodes.slice(1).flatMap((row, rowIndex) => {
            const from = row.position?.start.offset, to = row.position?.end.offset;
            if (from === undefined || to === undefined) return [];
            const cells = (row.children ?? []).map((cell) => normalizeCell(visibleText(cell)));
            // Preserve short/long rows as given. Missing selected cells are unverified, not empty facts.
            return [{ row_index: rowIndex, cells, evidence: cite(messageIndex, source, from, to) }];
          });
          tables.push({ table_id: `table_${evidence.evidence_id}`, message_index: messageIndex,
            path: source.path, headers, rows, evidence });
          return;
        }
        for (const child of node.children ?? []) visit(child);
      };
      visit(fromMarkdown(source.text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
    }
  });
  return tables;
}

function orderedColumns(columns: TableColumnPair[], answer: TraceTable, source: TraceTable): TableColumnPair[] {
  if (!columns.length || columns.some((pair) => !Number.isSafeInteger(pair.answer) || pair.answer < 0 ||
    pair.answer >= answer.headers.length || !Number.isSafeInteger(pair.source) || pair.source < 0 || pair.source >= source.headers.length) ||
    new Set(columns.map((pair) => pair.answer)).size !== columns.length ||
    new Set(columns.map((pair) => pair.source)).size !== columns.length)
    throw new Error("表格对应列必须非空、唯一并使用有效的零起始列索引");
  return [...columns].sort((a, b) => a.answer - b.answer);
}
const tuple = (row: TraceTableRow, columns: TableColumnPair[], side: "answer" | "source") => {
  const values = columns.map((column) => row.cells[column[side]]);
  return values.every((value) => typeof value === "string" && value.length) ? JSON.stringify(values) : null;
};

/** Compare declared columns in both directions; no fuzzy names, suffix removal, unit conversion or completeness inference. */
export function compareTraceTableRows(raw: { messages: unknown[] }, request: TableCheckRequest): TableCheckResult {
  const tables = new Map(parseTraceTables(raw).map((table) => [table.table_id, table]));
  const answer = tables.get(request.answer_table_id);
  if (!answer) throw new Error("回答表不存在；请先用 check_table 获取当前材料的 table_id");
  if (!request.sources.length) throw new Error("至少指定一个来源表；缺少来源时不能伪造对应核验");
  if (new Set(request.sources.map((source) => source.table_id)).size !== request.sources.length)
    throw new Error("来源表不得重复");
  const sources = request.sources.map((spec) => {
    const table = tables.get(spec.table_id);
    if (!table) throw new Error("来源表不存在；请先用 check_table 获取当前材料的 table_id");
    if (table.message_index >= answer.message_index) throw new Error("来源表必须先于回答表所在消息，不能用回答自证");
    const keys = orderedColumns(spec.key_columns, answer, table), values = orderedColumns(spec.value_columns, answer, table);
    if (keys.some((key) => values.some((value) => key.answer === value.answer || key.source === value.source)))
      throw new Error("对应键与核验值不得使用同一列");
    return { table, keys, values };
  });
  const mapping = ({ keys, values }: typeof sources[number]) => JSON.stringify([
    keys.map((column) => column.answer), values.map((column) => column.answer),
  ]);
  if (sources.some((source) => mapping(source) !== mapping(sources[0])))
    throw new Error("所有来源表必须核验回答中的相同键列和值列");
  const rows: TableRowCheck[] = answer.rows.map((row) => {
    const matches: TableRowCheck["sources"] = [];
    const sourcePairs = new Set<string>();
    let hasDifference = false;
    const expectedKey = tuple(row, sources[0].keys, "answer"), expectedValue = tuple(row, sources[0].values, "answer");
    if (expectedKey !== null && expectedValue !== null) for (const { table, keys, values } of sources) {
      const available: { sourceRow: TraceTableRow; key: string | null; value: string | null }[] = table.rows.map((sourceRow) => ({ sourceRow,
        key: tuple(sourceRow, keys, "source"), value: tuple(sourceRow, values, "source") }))
        .filter((item) => item.key !== null && item.value !== null);
      const byKey: typeof available = available.filter((item) => item.key === expectedKey);
      // A shared value (for example a repeated price) is not a second identity when the declared key resolves.
      const candidates: typeof available = byKey.length ? byKey : available.filter((item) => item.value === expectedValue);
      for (const { sourceRow, key, value } of candidates) {
        matches.push({ ...sourceRow, table_id: table.table_id, matched_by: key === expectedKey ? "key" : "value" });
        sourcePairs.add(JSON.stringify([key, value]));
        if (key !== expectedKey || value !== expectedValue) hasDifference = true;
      }
    }
    const status: TableRowStatus = !matches.length ? "unverified" : sourcePairs.size > 1 ? "ambiguous" :
      hasDifference ? "conflict" : "matched";
    return { row_index: row.row_index, status, answer: { cells: row.cells, evidence: row.evidence }, sources: matches };
  });
  const summary: TableCheckResult["summary"] = { matched: 0, conflict: 0, unverified: 0, ambiguous: 0 };
  for (const row of rows) summary[row.status]++;
  return { answer_table_id: answer.table_id, rows, summary };
}
