export interface StringPageOptions<T> {
  totalChars: number;
  offset?: number;
  maxChars: number;
  maxOutputChars: number;
  /** Build a complete page, including its range metadata, for this UTF-16 end. */
  build: (end: number) => T;
}

export interface StringPage<T> {
  value: T;
  serialized: string;
  end: number;
}

/**
 * Fit a complete JSON page without truncating its serialization. The builder must
 * be pure and retain the same page shape as the text range grows. Binary search
 * fills the budget; adjacent probes also handle JSON's shorter encoding when a
 * trailing UTF-16 high surrogate becomes a complete pair. Coordinates remain
 * UTF-16 offsets, including when a requested page ends inside a surrogate pair.
 * The caller includes budget metadata in build or reserves its space separately.
 */
export function fitStringPage<T>(options: StringPageOptions<T>): StringPage<T> {
  const { totalChars, maxChars, maxOutputChars, build } = options;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(totalChars) || totalChars < 0)
    throw new RangeError("totalChars 必须为非负安全整数");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalChars)
    throw new RangeError(`offset 超出当前来源范围 0—${totalChars}`);
  if (!Number.isSafeInteger(maxChars) || maxChars < 1)
    throw new RangeError("maxChars 必须为正安全整数");
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1)
    throw new RangeError("maxOutputChars 必须为正安全整数");

  const encode = (end: number): StringPage<T> => {
    const value = build(end);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("分页结果必须可序列化为 JSON");
    return { value, serialized, end };
  };
  const limit = offset + Math.min(maxChars, totalChars - offset);
  const full = encode(limit);
  if (full.serialized.length <= maxOutputChars) return full;
  const tooSmall = () => new RangeError("本次工具输出上限无法容纳一个完整页面");
  if (offset === totalChars) throw tooSmall();

  let best = encode(offset + 1);
  if (best.serialized.length > maxOutputChars) {
    // A lone high surrogate requires six escaped characters; its complete pair
    // only needs two. Do not reject an otherwise readable first character pair.
    if (offset + 2 > limit) throw tooSmall();
    best = encode(offset + 2);
    if (best.serialized.length > maxOutputChars) throw tooSmall();
  }
  let low = best.end + 1, high = limit - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const page = encode(middle);
    if (page.serialized.length <= maxOutputChars) {
      best = page;
      low = middle + 1;
    } else high = middle - 1;
  }

  // A surrogate pair can briefly reduce serialized length. Inspect both next
  // coordinates rather than requiring every intermediate prefix to fit.
  let advanced: boolean;
  do {
    advanced = false;
    const probeEnd = Math.min(limit, best.end + 2);
    for (let end = best.end + 1; end <= probeEnd; end++) {
      const page = encode(end);
      if (page.serialized.length <= maxOutputChars) {
        best = page;
        advanced = true;
      }
    }
  } while (advanced && best.end < limit);
  return best;
}
