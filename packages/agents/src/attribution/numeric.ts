import { maskCitationMarkup } from "@eval/tools";

/** Decimal arithmetic, avoiding binary floating-point errors at rounding boundaries. */
function decimal(value: string): { coefficient: bigint; places: number } {
  const match = /^([+-]?\d+(?:\.\d+)?)(?:[eE]([+-]?\d{1,3}))?$/u.exec(value);
  if (!match || value.length > 80)
    throw new Error("数值须为最多80字符的十进制或科学计数法字符串，指数最多3位，不含单位或千位分隔符");
  return {
    coefficient: BigInt(match[1].replace(".", "")),
    places: (match[1].split(".")[1]?.length ?? 0) - Number(match[2] ?? 0),
  };
}

export function matchesReference(actual: string, expected: string, scale: string, mode: "rounded" | "exact"): boolean {
  const a = decimal(actual), e = decimal(expected), s = decimal(scale);
  if (s.coefficient <= 0n) throw new Error("单位换算比例必须大于零");
  let coefficient = a.coefficient * s.coefficient;
  const extra = a.places + s.places - e.places;
  if (mode === "exact") return extra <= 0
    ? coefficient * 10n ** BigInt(-extra) === e.coefficient
    : coefficient === e.coefficient * 10n ** BigInt(extra);
  if (extra <= 0) coefficient *= 10n ** BigInt(-extra);
  else {
    const divisor = 10n ** BigInt(extra);
    const sign = coefficient < 0n ? -1n : 1n;
    const magnitude = coefficient * sign;
    coefficient = sign * (magnitude / divisor + (magnitude % divisor * 2n >= divisor ? 1n : 0n));
  }
  return coefficient === e.coefficient;
}

/** Match a complete numeric token, not a substring in a year, code or larger value. */
export function containsNumber(text: string, value: string, preservePrecision = false): boolean {
  const normalized = maskCitationMarkup(text).replaceAll(",", "").replace(/[−﹣－]/gu, "-")
    // Count words are literal quantities; do not match inside a compound numeral.
    .replace(/(?<![零〇一二两三四五六七八九十百千万亿])([一二两三四五六七八九十])(?=[只条家个项份次天]|交易日)/gu,
      (_, digit: string) => String({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[digit]))
    // A missing separator before a calendar heading must not extend a decimal.
    .replace(/(\d+\.\d+)(20\d{2})(?=\s*年\s*(?:[上下]半年|第[一二三四1-4]季度|\d{1,2}月))/gu, "$1 $2")
    // In a complete formula/cell, subtraction has a positive right-hand operand.
    .replace(/(^|[|=])(\s*[+-]?\d+(?:\.\d+)?\s*)-\s*(?=\d+(?:\.\d+)?\s*(?:[|=]|$))/gmu, "$1$2 ")
    .replace(/([+-])\s+(?=\d)/gu, "$1");
  return [...normalized.matchAll(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu)].some((match) => {
    let token = match[0];
    // Only adjacent bounds form a range; date labels and spaced table cells do not.
    if (token.startsWith("-") && /\d(?:\.\d+)?[万亿千百十元股家人户吨%％]*$/u.test(normalized.slice(0, match.index)))
      token = token.slice(1);
    if (token.length > 80 || !/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/u.test(token)) return false;
    const a = decimal(token), b = decimal(value);
    if (preservePrecision && a.places !== b.places) return false;
    const places = Math.max(a.places, b.places);
    const actual = a.coefficient * 10n ** BigInt(places - a.places);
    const expected = b.coefficient * 10n ** BigInt(places - b.places);
    if (actual === expected) return true;
    // The magnitude remains literal; an explicit decline also states its signed rate.
    return !/^[+-]/u.test(token) && actual > 0n && -actual === expected &&
      /(?:下降|下跌|下滑|下挫|微跌|平均跌|(?<![止不未])跌|跌幅|减少|降低|收窄|净流出|流出)[约近了为达\s*]*$/u.test(normalized.slice(0, match.index));
  });
}
