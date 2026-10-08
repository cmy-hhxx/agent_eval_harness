import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import type { RewriteRequest, RewriteResult } from "./types.js";
import schema from "../../../../schemas/rewrite/result.schema.json" with { type: "json" };

const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
/** Rewrites are pure text slots: exactly the requested ids, once each, nothing else. */
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  void audit;
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as RewriteRequest;
  const value = result as RewriteResult;
  const expected = new Set(input.items.map((item) => item.id));
  const forbiddenPrefixes = new Map(input.items.map((item) => [item.id, item.forbiddenPrefixes ?? []]));
  const preferences = new Map(input.items.filter((item) => item.preference).map((item) => [item.id, item.preference!]));
  const errors: ValidationIssue[] = [];
  const seen = new Set<string>();
  const issue = (code: string, path: string, message: string, actual: unknown) =>
    errors.push({ category: "structure", code, path, message, actual });
  for (const [index, item] of value.rewrites.entries()) {
    if (!expected.has(item.id))
      issue("rewrite_unknown_id", `/rewrites/${index}/id`, "改写条目必须对应请求中的槽位", item.id);
    else if (seen.has(item.id))
      issue("rewrite_duplicate_id", `/rewrites/${index}/id`, "同一槽位只能改写一次", item.id);
    seen.add(item.id);
    if (forbiddenPrefixes.get(item.id)?.some((prefix) => item.text.trimStart().startsWith(prefix)))
      issue("rewrite_context_prefix", `/rewrites/${index}/text`, "不要把对照信息或优势标签复制为点评前缀；直接写该槽位本身的事实，保持事实主体不变", item.text);
    const preference = preferences.get(item.id);
    if (preference && (!item.text.startsWith(preference + "：") || !item.text.slice(preference.length + 1).trim()))
      issue("rewrite_preference_missing", `/rewrites/${index}/text`, `必须以“${preference}：”开头，随后给出本场对局的具体理由；不能丢掉或改变已确定偏好`, item.text);
  }
  for (const id of expected)
    if (!seen.has(id)) issue("rewrite_missing_id", "/rewrites", "每个槽位都必须返回改写文本", id);
  if (errors.length) throw new ValidationError(errors);
}
