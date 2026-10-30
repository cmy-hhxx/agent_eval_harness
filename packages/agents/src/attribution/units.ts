import { maskCitationMarkup } from "@eval/tools";

const numberPattern = "[+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d{1,3})?";
const normalize = (text: string) => maskCitationMarkup(text).replaceAll(",", "").replace(/[−﹣－]/gu, "-").replace(/([+-])\s+(?=\d)/gu, "$1");

function identifierColumn(header: string): boolean {
  const name = header.trim().replace(/\s*[（(][^()（）]*[）)]\s*$/u, "");
  return /^(?:日期|月份|年月|年份|年度|交易日期|时间|股票代码|证券代码|基金代码|代码|编号|序号|id)$/iu.test(name);
}

export interface NumericReference { reference_index: number; expected: string; context: string; }

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
