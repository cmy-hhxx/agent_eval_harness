import { containsNumber, matchesReference } from "./numeric.js";
import { evidenceSources, parseTraceTables } from "@eval/tools";

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
for (const name of ["个", "家", "只", "条", "项", "份", "次", "人", "户", "股"])
  register(`count:${name}`, { [name]: 0, [`万${name}`]: 4, [`亿${name}`]: 8 });
const names = [...units.keys()].sort((a, b) => b.length - a.length);
const numberPattern = "[+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d{1,3})?";
const normalize = (text: string) => text.replaceAll(",", "").replace(/[−﹣－]/gu, "-").replace(/([+-])\s+(?=\d)/gu, "$1");

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

/** Recover the cited token's real surroundings, even when its quote omits the unit. */
function finalNumberUnits(message: unknown, quote: string, value: string): {
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
  const tables = parseTraceTables({ messages: [message] });
  const found = new Map<string, { name: string; unit: Unit }>();
  let matched = false, unknownUnit = false;
  for (const source of sources) {
    const ranges = occurrences(source.text, quote);
    // JSON evidence is another view of the same content. Map its escaped coordinates
    // back to this exact content leaf; do not inspect numeric metadata as answer text.
    const jsonLeaves = jsonQuotes.length ? occurrences(json, JSON.stringify(source.text)) : [];
    if (!ranges.length && !jsonLeaves.length) continue;
    const tokens = /(?:[+−﹣－-]\s*)?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][+-]?\d{1,3})?|[一二两三四五六七八九十](?=[只条家个项份次])/gu;
    for (const token of source.text.matchAll(tokens)) {
      const start = token.index, end = start + token[0].length;
      const quoted = ranges.some((range) => start < range.end && end > range.start) || jsonLeaves.some((leaf) => {
        const from = leaf.start + 1 + JSON.stringify(source.text.slice(0, start)).length - 2;
        const to = leaf.start + 1 + JSON.stringify(source.text.slice(0, end)).length - 2;
        return jsonQuotes.some((range) => from < range.end && to > range.start);
      });
      if (!quoted ||
        /[\d.eE]$/u.test(source.text.slice(0, start)) || /[\d.eE]/u.test(source.text[end] ?? "")) continue;
      const tail = source.text.slice(end);
      const adjacent = adjacentUnit(tail);
      const direction = source.text.slice(0, start).match(/[^\d]*$/u)?.[0] ?? "";
      if (!containsNumber(direction + token[0] + (/^[一二两三四五六七八九十]$/u.test(token[0]) ? adjacent?.name ?? "" : ""), value)) continue;
      matched = true;
      const candidates: { name: string; unit: Unit }[] = adjacent ? [adjacent] : [];
      for (const table of tables.filter((table) => table.path === source.path)) for (const row of table.rows) {
        const coordinate = /^ev_\d+_text_(\d+)_(\d+)_/u.exec(row.evidence.evidence_id);
        if (!coordinate || start < Number(coordinate[1]) || end > Number(coordinate[2])) continue;
        let cursor = 0;
        for (const [column, cell] of row.cells.entries()) {
          // The parser supplies column order; only cells locatable verbatim get header units.
          // Never borrow a unit from another column or infer a cell from its value alone.
          const at = row.evidence.quote.indexOf(cell, cursor);
          if (at < 0) break;
          cursor = at + cell.length;
          const cellStart = Number(coordinate[1]) + at, cellEnd = cellStart + cell.length;
          if (start >= cellStart && end <= cellEnd) {
            const unit = headerUnit(table.headers[column] ?? "");
            if (unit) candidates.push(unit);
          }
        }
      }
      if (!candidates.length) unknownUnit = true;
      for (const candidate of candidates) found.set(`${candidate.unit.dimension}:${candidate.unit.power}`, candidate);
    }
  }
  return { found: matched, units: [...found.values()], ambiguous: found.size > 1 || found.size > 0 && unknownUnit };
}

/** A bounded scalar grammar, not extraction of every number from natural language. */
export function scalarReference(reference: unknown): string | null {
  if (typeof reference === "number") return Number.isFinite(reference) ? String(reference) : null;
  if (typeof reference !== "string") return null;
  const text = normalize(reference).trim().replace(/[。.]$/u, "");
  const numericOnly = new RegExp(`^(${numberPattern})$`, "u").exec(text);
  // A bare integer string can instead be a year or identifier.
  if (numericOnly) return numericOnly[1].length <= 80 && /[.eE]/u.test(numericOnly[1]) ? numericOnly[1] : null;
  const quantity = new RegExp(`^(?:[\\p{L}]{1,40}(?:为|是|[:：=])\\s*)?(${numberPattern})(.*)$`, "u").exec(text);
  if (!quantity) return null;
  const parsed = adjacentUnit(quantity[2]);
  return parsed && !parsed.remaining.trim() && quantity[1].length <= 80 ? quantity[1] : null;
}

export function numericUnitIssue(reference: unknown, quote: string, check: { expected: string; actual: string | null; scale: string }, finalMessage: unknown):
  { code: string; message: string } | null {
  if (check.actual === null) return null;
  const expected = numberUnits(typeof reference === "string" ? reference : JSON.stringify(reference), check.expected, true);
  const context = finalNumberUnits(finalMessage, quote, check.actual);
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
    message: "非1的scale必须由标准与最终原文中数值紧邻的同维单位，或目标单元格同列的明确单位表头推导；当前单位缺失、不受支持或存在歧义。请补充可定位的完整原文；币种省略、复合单位等语义推导须在correctness_reason说明，不能编造倍率。",
  };
  return null;
}
