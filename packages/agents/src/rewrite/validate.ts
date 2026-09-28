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
  const noWinner = new Set(input.items.filter((item) => item.constraint === "no_winner").map((item) => item.id));
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
    if (noWinner.has(item.id) && /更好|更优|更可用|更值得|更可靠|胜出|略胜|占优|居前|优于|优先选|排(?:在)?前|列(?:在)?前/u.test(item.text))
      issue("rewrite_winner_contradiction", `/rewrites/${index}/text`, "此槽位没有整体胜者，只写共同失败；相对优势保留在逐项对比，不得写某方更好或居前", item.text);
  }
  for (const id of expected)
    if (!seen.has(id)) issue("rewrite_missing_id", "/rewrites", "每个槽位都必须返回改写文本", id);
  if (errors.length) throw new ValidationError(errors);
}
