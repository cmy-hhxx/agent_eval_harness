import { containsNumber, matchesReference } from "./numeric.js";
import { evidenceSources, maskCitationMarkup, parseEvidenceCoordinates, parseTraceTables } from "@eval/tools";
import type { JsonObject } from "@eval/contracts";

interface Unit { dimension: string; power: number; }
const units = new Map<string, Unit>();
function register(dimension: string, aliases: Record<string, number>): void {
  for (const [name, power] of Object.entries(aliases)) units.set(name, { dimension, power });
}
register("mass", { 克: 0, 千克: 3, 公斤: 3, 吨: 6, 千吨: 9, 万吨: 10, 亿吨: 14, g: 0, kg: 3 });
register("volume", { 毫升: -3, 升: 0, 千升: 3, 万升: 4, 万千升: 7, 亿升: 8, mL: -3, L: 0, kL: 3 });
register("currency:CNY", { 元: 0, 千元: 3, 万元: 4, 百万元: 6, 千万元: 7, 亿元: 8 });
register("currency:USD", { 美元: 0, 万美元: 4, 百万美元: 6, 亿美元: 8 });
register("currency:HKD", { 港元: 0, 万港元: 4, 百万港元: 6, 亿港元: 8 });
register("ratio", { "%": -2, "％": -2, "‰": -3 });
register("percentage-point", { 百分点: 0, 个百分点: 0, 基点: -2, 个基点: -2 });
register("count:day", { 天: 0, 交易日: 0, 个交易日: 0 });
for (const name of ["个", "家", "只", "条", "项", "份", "次", "人", "户", "股", "辆", "台"])
  register(`count:${name}`, { [name]: 0, [`万${name}`]: 4, [`亿${name}`]: 8 });
const names = [...units.keys()].sort((a, b) => b.length - a.length);
const numberPattern = "[+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d{1,3})?";
const normalize = (text: string) => maskCitationMarkup(text).replaceAll(",", "").replace(/[−﹣－]/gu, "-").replace(/([+-])\s+(?=\d)/gu, "$1");

function adjacentUnit(text: string): { name: string; unit: Unit; remaining: string } | null {
  const suffix = text.replace(/^[\s*]+/u, "");
  const name = names.find((item) => suffix.startsWith(item));
  if (!name) return null;
  const remaining = suffix.slice(name.length);
  // Do not reduce a compound unit (元/吨, kg/m³) or an English word to a simple one.
  if (/^\s*[/／·⋅^]/u.test(remaining) || /[a-z]$/iu.test(name) && /^[a-z]/iu.test(remaining)) return null;
  return { name, unit: units.get(name)!, remaining };
}

/** Extract reference units without changing the reference's numeric precision. */
function numberUnits(text: string, value: string, preservePrecision: boolean): { name: string; unit: Unit }[] {
  const normalized = normalize(text);
  const found = new Map<string, { name: string; unit: Unit }>();
  for (const match of normalized.matchAll(new RegExp(numberPattern, "gu"))) {
    const before = normalized.slice(0, match.index);
    if (/[\d.eE]$/u.test(before) || /[\d.eE]/u.test(normalized[match.index + match[0].length] ?? "")) continue;
    const direction = before.match(/[^\d]*$/u)?.[0] ?? "";
    if (!containsNumber(direction + match[0], value, preservePrecision)) continue;
    const parsed = adjacentUnit(normalized.slice(match.index + match[0].length));
    if (parsed) found.set(`${parsed.unit.dimension}:${parsed.unit.power}`, parsed);
  }
  return [...found.values()];
}

function headerUnit(header: string): { name: string; unit: Unit } | null {
  const text = header.trim();
  const unitText = /[（(]\s*([^()（）]+)\s*[）)]$/u.exec(text)?.[1] ?? text;
  const parsed = adjacentUnit(unitText);
  return parsed && !parsed.remaining.trim() ? parsed : null;
}

function tableUnit(text: string, start: number): { name: string; unit: Unit } | null {
  const paragraph = text.slice(0, start).trimEnd().split(/\n[ \t]*\n/u).at(-1) ?? "";
  if (paragraph.includes("|")) return null;
  const declaration = /单位\s*[:：]\s*([^()（）\n]+?)\s*(?:[)）]\s*)?[:：]?\s*$/u.exec(paragraph);
  return declaration ? headerUnit(declaration[1]) : null;
}

function identifierColumn(header: string): boolean {
  const name = header.trim().replace(/\s*[（(][^()（）]*[）)]\s*$/u, "");
  return /^(?:日期|月份|年月|年份|年度|交易日期|时间|股票代码|证券代码|基金代码|代码|编号|序号|id)$/iu.test(name);
}

/** Recover the cited token's real surroundings, even when its quote omits the unit. */
function finalNumberUnits(message: unknown, inputId: string, quote: string, value: string): {
  found: boolean; units: { name: string; unit: Unit }[]; ambiguous: boolean;
} {
  const material = message && typeof message === "object" ? { content: (message as Record<string, unknown>).content } : {};
  const sources = evidenceSources(material).filter((source) => source.kind === "text");
  const json = evidenceSources(message).find((source) => source.kind === "json")!.text;
  const occurrences = (text: string, part: string): { start: number; end: number }[] => {
    if (!part) return [];
    const ranges: { start: number; end: number }[] = [];
    for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) ranges.push({ start: at, end: at + part.length });
    return ranges;
  };
  const jsonQuotes = occurrences(json, quote);
  const tables = parseTraceTables({ messages: [message] }, inputId);
  const found = new Map<string, { name: string; unit: Unit }>();
  let matched = false, unknownUnit = false;
  for (const source of sources) {
    const semanticText = maskCitationMarkup(source.text);
    const ranges = occurrences(source.text, quote);
    // JSON evidence is another view of the same content. Map its escaped coordinates
    // back to this exact content leaf; do not inspect numeric metadata as answer text.
    const jsonLeaves = jsonQuotes.length ? occurrences(json, JSON.stringify(source.text)) : [];
    if (!ranges.length && !jsonLeaves.length) continue;
    const dates = [...semanticText.matchAll(/(?<!\d)(?:\d{4}\s*年\s*)?\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?|(?<!\d)\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?(?!\d)/gu)]
      .map((match) => ({ start: match.index, end: match.index + match[0].length }));
    const tokens = /(?:[+−﹣－-]\s*)?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][+-]?\d{1,3})?|(?<![零〇一二两三四五六七八九十百千万亿])[一二两三四五六七八九十](?=[只条家个项份次天]|交易日)/gu;
    for (const token of semanticText.matchAll(tokens)) {
      const start = token.index, end = start + token[0].length;
      const quoted = ranges.some((range) => start < range.end && end > range.start) || jsonLeaves.some((leaf) => {
        const from = leaf.start + 1 + JSON.stringify(source.text.slice(0, start)).length - 2;
        const to = leaf.start + 1 + JSON.stringify(source.text.slice(0, end)).length - 2;
        return jsonQuotes.some((range) => from < range.end && to > range.start);
      });
      if (!quoted ||
        /[\d.eE]$/u.test(source.text.slice(0, start)) || /[\d.eE]/u.test(source.text[end] ?? "") ||
        dates.some((date) => start < date.end && end > date.start)) continue;
      const tail = semanticText.slice(end);
      const adjacent = adjacentUnit(tail);
      const direction = semanticText.slice(0, start).match(/[^\d]*$/u)?.[0] ?? "";
      const direct = containsNumber(direction + token[0] + (/^[一二两三四五六七八九十]$/u.test(token[0]) ? adjacent?.name ?? "" : ""), value);
      let candidates: { name: string; unit: Unit }[] = adjacent ? [adjacent] : [];
      let identifier = false;
      for (const table of tables.filter((table) => table.path === source.path)) for (const row of table.rows) {
        const coordinate = parseEvidenceCoordinates(row.evidence.evidence_id);
        if (coordinate?.kind !== "text" || coordinate.input_id !== inputId || start < coordinate.start || end > coordinate.end) continue;
        let cursor = 0;
        for (const [column, cell] of row.cells.entries()) {
          // The parser supplies column order; only cells locatable verbatim get header units.
          // Never borrow a unit from another column or infer a cell from its value alone.
          const at = row.evidence.quote.indexOf(cell, cursor);
          if (at < 0) break;
          cursor = at + cell.length;
          const cellStart = coordinate.start + at, cellEnd = cellStart + cell.length;
          if (start >= cellStart && end <= cellEnd) {
            if (identifierColumn(table.headers[column] ?? "")) {
              identifier = true;
              break;
            }
            const tableStart = parseEvidenceCoordinates(table.evidence.evidence_id);
            const unit = headerUnit(table.headers[column] ?? "") ??
              (!adjacent && tableStart?.kind === "text" && tableStart.input_id === inputId ? tableUnit(source.text, tableStart.start) : null);
            if (unit) candidates.push(unit);
          }
        }
      }
      if (identifier) continue;
      if (!direct) {
        // 万辆/亿股 are explicit count magnitudes, including a cell's own table header.
        // Expanding them is another spelling of the delivered count, never a guessed conversion.
        candidates = candidates.filter(candidate => candidate.unit.dimension.startsWith("count:") && candidate.unit.power > 0 &&
          matchesReference(normalize(token[0]), value, `1e${candidate.unit.power}`, "exact"))
          .map(candidate => ({name:candidate.unit.dimension.slice("count:".length),unit:{...candidate.unit,power:0}}));
        if (!candidates.length) continue;
      }
      matched = true;
      if (!candidates.length) unknownUnit = true;
      for (const candidate of candidates) found.set(`${candidate.unit.dimension}:${candidate.unit.power}`, candidate);
    }
  }
  return { found: matched, units: [...found.values()], ambiguous: found.size > 1 || found.size > 0 && unknownUnit };
}

export interface NumericReference { reference_index: number; expected: string; context: string; }

/** Relative-return shorthand needs a definition check; it is not an unambiguous point-unit comparison. */
export function numericReferenceMaterials(input: JsonObject) {
  const truth=input.ground_truth as {available:boolean;value:unknown};
  const directory=truth.available?numericReferenceDirectory(truth.value):[];
  const answer=input.answer as {final_answer?:string};
  const text=answer.final_answer ?? "";
  const interpreted=directory.filter(entry=>
    /相对[^。；;\n]{0,40}(?:涨幅|涨跌|收益)|(?:涨幅|涨跌|收益)[^。；;\n]{0,40}相对/u.test(entry.context) &&
    numberUnits(entry.context,entry.expected,true).some(item=>item.unit.dimension==="ratio") &&
    typeof input.candidate_id==="string" &&
    finalNumberUnits({content:text},input.candidate_id,text,entry.expected).units.some(item=>item.unit.dimension==="percentage-point"));
  return {direct:directory.filter(entry=>!interpreted.includes(entry)),interpreted};
}

/** Quantities from the standard only; identifiers and calendar coordinates are not targets. */
export function numericReferenceDirectory(reference: unknown): NumericReference[] {
  const found: Omit<NumericReference, "reference_index">[] = [];
  const read = (value: unknown, key = "") => {
    if (identifierColumn(key)) return;
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        const number = Object.is(value, -0) ? "-0" : String(value);
        found.push({ expected: number, context: key ? `${key}: ${number}` : number });
      }
      return;
    }
    if (typeof value !== "string") {
      if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) read(item, name);
      return;
    }
    const text = normalize(value);
    const dates = [...text.matchAll(/(?<!\d)(?:\d{4}\s*年\s*)?\d{1,2}\s*(?:月\s*)?[-—–~～至到]\s*\d{1,2}\s*月|(?<!\d)(?:\d{4}\s*年\s*)?\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?|(?<!\d)\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?(?!\d)|(?<!\d)\d{4}\s*年/gu)];
    const originalLines = value.split("\n");
    let headers: string[] = [], originalHeaders = "", previous = "", lineStart = 0;
    for (const [lineIndex, line] of text.split("\n").entries()) {
      const cells = line.trim().replace(/^\||\|$/gu, "").split("|").map(cell => cell.trim());
      if (line.includes("|") && cells.every(cell => /^:?-{3,}:?$/u.test(cell))) {
        headers = previous.trim().replace(/^\||\|$/gu, "").split("|").map(cell => cell.trim());
        originalHeaders = originalLines[lineIndex - 1] ?? previous;
      } else {
        const tableRow = headers.length > 1 && cells.length === headers.length && line.includes("|");
        for (const match of line.matchAll(new RegExp(numberPattern, "gu"))) {
          const before = line.slice(0, match.index), tail = line.slice(match.index + match[0].length);
          const offset = lineStart + match.index;
          if (/[\d.eE]$/u.test(before) || /^[\d.eE]/u.test(tail) || /^\.(?:SH|SZ|HK|US|BJ)\b/iu.test(tail) ||
            dates.some(date => offset < date.index + date[0].length && offset + match[0].length > date.index) ||
            /(?:代码|编号|序号|证券|股票|基金|\bid)\s*[:：=]?\s*$/iu.test(before) ||
            /^\d+$/u.test(match[0]) && !/^\s*[%％‰]/u.test(tail) &&
              /(?:上证|深证|中证|沪深|国证|科创|北证)\s*$/u.test(before)) continue;
          const column = tableRow ? before.split("|").length - (line.trimStart().startsWith("|") ? 2 : 1) : -1;
          if (column >= 0 && identifierColumn(headers[column] ?? "")) continue;
          const decline = !/^[+-]/u.test(match[0]) && /(?:下降|下跌|下滑|下挫|减少|降低|收窄|净流出|流出)[约近了为达\s*]*$/u.test(before);
          found.push({ expected: `${decline ? "-" : ""}${match[0]}`, context: `${key ? `${key}: ` : ""}${tableRow ? originalHeaders + "\n" : ""}${originalLines[lineIndex]}` });
        }
        if (!line.includes("|")) headers = [];
      }
      previous = line; lineStart += line.length + 1;
    }
  };
  read(reference);
  return found.map((item, reference_index) => ({ reference_index, ...item }));
}

export function numericUnitIssue(reference: unknown, quote: string, check: { expected: string; actual: string | null; scale: string }, finalMessage: unknown, inputId: string):
  { code: string; message: string } | null {
  if (check.actual === null) return null;
  const expected = numberUnits(typeof reference === "string" ? reference : JSON.stringify(reference), check.expected, true);
  const context = finalNumberUnits(finalMessage, inputId, quote, check.actual);
  const actual = context.units;
  if (!context.found) return {
    code: "numeric_answer_context_missing",
    message: "引文中的actual必须对应原最终消息中的完整数值，不能裁出更大数值的一部分；请引用包含目标数值的完整原文片段。",
  };
  if (expected.length > 1 || context.ambiguous) return {
    code: "numeric_unit_ambiguous",
    message: "引文在原最终消息中对应多个不同或未明单位，不能自行选择；扩大引文以唯一定位目标数值及单位，或缩小过宽引文。标准本身存在多个同数值不同口径时，在correctness_reason逐项说明，不提交无法定位单位的表项。",
  };
  if (expected.length === 1 && actual.length === 1) {
    if (expected[0].unit.dimension !== actual[0].unit.dimension) return {
      code: "numeric_unit_mismatch",
      message: `标准的${expected[0].name}与回答的${actual[0].name}维度不同，不能用scale视为等价；质量与体积、百分比与百分点必须分别核对。需要密度等额外依据的推导在correctness_reason说明，不能伪装成单位等价。`,
    };
    const scale = `1e${actual[0].unit.power - expected[0].unit.power}`;
    if (!matchesReference(check.scale, scale, "1", "exact")) return {
      code: "numeric_scale_mismatch",
      message: `由原文单位${actual[0].name}到${expected[0].name}的scale应为${scale}，不能改变倍率让数值凑到标准；同步重算matches与判词。`,
    };
  } else if (!matchesReference(check.scale, "1", "1", "exact")) return {
    code: "numeric_scale_unverified",
    message: "非1的scale必须由标准与最终原文中数值紧邻的同维单位、目标单元格同列的明确单位表头，或该表紧邻前一段落的单一单位声明推导；当前单位缺失、不受支持或存在歧义。请补充可定位的完整原文；币种省略、复合单位等语义推导须在correctness_reason说明，不能编造倍率。",
  };
  return null;
}
