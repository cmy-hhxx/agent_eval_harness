import type { RawInput } from "./types.js";

/** Source answer usage only; never the evaluator's SDK usage or a sum of trace snapshots. */
export function originalAnswerUsage(raw: RawInput) {
  const usage = raw.meta?.usage as Record<string, unknown> | undefined;
  const issues: string[] = [];
  const count = (value: unknown, field: string): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    issues.push(`${field} 不是有效的非负整数`);
    return null;
  };
  const input = count(usage?.input_tokens, "input_tokens");
  const output = count(usage?.output_tokens, "output_tokens");
  let total = count(usage?.total_tokens, "total_tokens");
  let totalBasis: "reported" | "input_plus_output" | null = total === null ? null : "reported";
  if (usage?.total_tokens == null && input !== null && output !== null && Number.isSafeInteger(input + output)) {
    total = input + output;
    totalBasis = "input_plus_output";
  }
  if (total !== null && input !== null && output !== null && total !== input + output) {
    issues.push("total_tokens 与 input_tokens + output_tokens 不一致，不能比较总量");
    total = null;
    totalBasis = null;
  }
  // A records cached input in input_tokens_details; B records cached_read_tokens.
  const cachedField = usage && Object.hasOwn(usage, "input_tokens_details")
    ? "meta.usage.input_tokens_details.cached_tokens" : "meta.usage.cached_read_tokens";
  let cached = count(cachedField.endsWith(".cached_tokens")
    ? (usage?.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens
    : usage?.cached_read_tokens, "cached_input_tokens");
  if (cached !== null && input !== null && cached > input) {
    issues.push("缓存输入 token 超过输入 token，不能比较缓存量");
    cached = null;
  }
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cached_input_tokens: cached,
    total_tokens_basis: totalBasis,
    source_fields: {
      input_tokens: "meta.usage.input_tokens",
      output_tokens: "meta.usage.output_tokens",
      total_tokens: totalBasis === "input_plus_output" ? "meta.usage.input_tokens + meta.usage.output_tokens" : "meta.usage.total_tokens",
      cached_input_tokens: cachedField,
    },
    issues,
  };
}
