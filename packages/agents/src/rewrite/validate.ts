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
    if (input.kind === "comparison") {
      const limit = 160;
      if ([...item.text].length > limit)
        issue("rewrite_too_long", `/rewrites/${index}/text`, `对比点评最多${limit}字，请保留决定性事实并压缩表达`, [...item.text].length);
    }
  }
  for (const id of expected)
    if (!seen.has(id)) issue("rewrite_missing_id", "/rewrites", "每个槽位都必须返回改写文本", id);
  if (errors.length) throw new ValidationError(errors);
}
