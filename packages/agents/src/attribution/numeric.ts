/** Decimal arithmetic, avoiding binary floating-point errors at rounding boundaries. */
function decimal(value: string): { coefficient: bigint; places: number } {
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(value) || value.length > 80)
    throw new Error("数值须为最多80字符的十进制字符串，不含单位或千位分隔符");
  return { coefficient: BigInt(value.replace(".", "")), places: value.split(".")[1]?.length ?? 0 };
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
  return (text.replaceAll(",", "").replace(/[−﹣－]/gu, "-").match(/[+-]?\d+(?:\.\d+)?/gu) ?? []).filter((token) => token.length <= 80).some((token) => {
    const a = decimal(token), b = decimal(value);
    if (preservePrecision && a.places !== b.places) return false;
    const places = Math.max(a.places, b.places);
    return a.coefficient * 10n ** BigInt(places - a.places) === b.coefficient * 10n ** BigInt(places - b.places);
  });
}
