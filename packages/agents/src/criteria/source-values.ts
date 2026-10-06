import type { ValidationIssue } from "@eval/contracts";

/** Compare written values without calculating answers or changing submitted text. */
function literals(text: string): { written: string; key: string }[] {
  let normalized = text.normalize("NFKC").replace(/[−–—]/gu, "-")
    .replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)/gu, value => value.replaceAll(",", ""));
  // MMDD following an explicit year is another spelling of the same date, not a computed answer.
  const dateParts = [...normalized.matchAll(/\d{4}年\s*(\d{2})(\d{2})(?!\d)/gu)]
    .filter(match => Number(match[1]) >= 1 && Number(match[1]) <= 12 && Number(match[2]) >= 1 && Number(match[2]) <= 31)
    .flatMap(match => [match[1], match[2]]);
  normalized += dateParts.length ? " " + dateParts.join(" ") : "";
  return [...normalized.matchAll(/(?<![A-Za-z0-9.])[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu)].map(match => {
    const written = match[0], parts = /^([+-]?)(\d+)(?:\.(\d+))?([eE][+-]?\d+)?$/u.exec(written)!;
    const integer = parts[2].replace(/^0+(?=\d)/u, ""), fraction = (parts[3] ?? "").replace(/0+$/u, "");
    const decline = !parts[1] && /(?:减少|下降|下跌|下滑|降低|收窄|净流出)[约近了为达\s]*$/u.test(normalized.slice(0, match.index));
    const sign = (parts[1] === "-" || decline) && (integer !== "0" || fraction) ? "-" : "";
    return { written, key: `${sign}${integer}${fraction ? "." + fraction : ""}${(parts[4] ?? "").toLowerCase()}` };
  });
}

export function criterionValueIssues(text: string, sources: readonly { text: string }[], path: string): ValidationIssue[] {
  const allowed = new Set(sources.flatMap(source => literals(source.text).map(value => value.key)));
  const unsupported = [...new Set(literals(text).filter(value => !allowed.has(value.key)).map(value => value.written))];
  return unsupported.length ? [{ category: "decision", code: "criterion_value_not_in_source", path,
    actual: unsupported, message: "检查项新增了所选原文中没有的数值或日期。共同标准只拆解原题与已给参考答案，不自行计算交割日、补答案、阈值或容差；删除新增值，按原题描述待核目标，计算与事实核验留给归因阶段。" }] : [];
}
