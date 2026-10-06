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

/** Time windows, explicit bounds and dates are the constraints a paraphrase must not drop. */
const constraintPatterns = [
  /(?:近|过去|最近|未来)\s*\d+(?:\.\d+)?\s*(?:分钟|小时|天|日|个?交易日|周|个月|年)/gu,
  /\d+(?:\.\d+)?\s*(?:分钟|小时|天|日|个?交易日|周|个月|年)\s*(?:内|以内|之内|之前|以后)/gu,
  /[≥≤<>]\s*\d+(?:\.\d+)?/gu,
  /(?:大于等于|不低于|至少|小于等于|不高于|至多|大于|高于|超过|多于|小于|低于|少于)\s*\d+(?:\.\d+)?/gu,
  /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]/gu,
  /\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}/gu,
];

/** The union of a source's criteria must retain its time windows, bounds and dates; shortening a requirement cannot delete them. */
export function criterionConstraintIssues(texts: readonly string[], sources: readonly { text: string }[], path: string): ValidationIssue[] {
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s/gu, "");
  // Equivalent writings never count as a dropped constraint: 2026年01月05日 = 2026-1-5,
  // and 大于10 = >10 = 高于10. Operators must stay in their original direction.
  const canonical = (token: string): string => {
    const date = /^(\d{4})年(\d{1,2})月(\d{1,2})[日号]$/u.exec(token) ?? /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u.exec(token);
    if (date) return `${date[1]}-${Number(date[2])}-${Number(date[3])}`;
    const comparison = /^(≥|≤|>|<)(\d+(?:\.\d+)?)$/u.exec(token) ?? /^(大于等于|不低于|至少|小于等于|不高于|至多|大于|高于|超过|多于|小于|低于|少于)(\d+(?:\.\d+)?)$/u.exec(token);
    if (!comparison) return token;
    const operator = comparison[1];
    const normalizedOperator = /^(≥|大于等于|不低于|至少)$/u.test(operator) ? "≥"
      : /^(≤|小于等于|不高于|至多)$/u.test(operator) ? "≤"
        : /^(>|大于|高于|超过|多于)$/u.test(operator) ? ">"
          : /^(<|小于|低于|少于)$/u.test(operator) ? "<" : operator;
    return `${normalizedOperator}${comparison[2]}`;
  };
  const tokens = (value: string) => constraintPatterns.flatMap(pattern =>
    [...normalize(value).matchAll(pattern)].map(match => match[0]));
  const written = new Set(tokens(texts.join("\n")).map(canonical));
  const missing = [...new Set(sources.flatMap(source => tokens(source.text)).filter(token => !written.has(canonical(token))))];
  return missing.length ? [{ category: "decision", code: "criterion_constraint_dropped", path, actual: missing,
    message: "检查项丢了所选原文中的必要限制（时窗、边界或日期）。把会决定交付能否使用的限制放入可独立核查的 requirements，不能只检查“给出结论”，也不能把限制改写或扩宽；保留原值并交给归因核对实际交付。" }] : [];
}
