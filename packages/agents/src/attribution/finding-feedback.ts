import type { AgentRequest, JsonObject, ValidationIssue } from "@eval/contracts";
import { attributionSubmissionShape } from "./submission-schema.js";
/** Repair context describes the current shallow tool field, never an internal judgment container. */
export function findingIssueContext(request: AgentRequest, _value: unknown, issue: ValidationIssue): JsonObject | undefined {
  if (issue.category !== "structure") return undefined;
  const path = issue.path;
  const schema = attributionSubmissionShape(request) as any;
  if(issue.code==="schema_additionalProperties"){
    const parts=path.split('/').filter(Boolean),field=parts.pop();
    let parent=schema;
    for(const part of parts)parent=/^\d+$/u.test(part)?parent?.items:parent?.properties?.[part];
    if(parent?.properties)return {target:{path},object_path:'/'+parts.join('/'),remove_field:field,
      ...(path==='/candidate'?{repair_action:'删除 /candidate，保留其余判断字段和证据编号，重新提交完整判断；无需重新调查或重写其他归因。'}:{}),
      allowed_fields:Object.keys(parent.properties),required_fields:parent.required??[],additionalProperties:false};
  }
  let current = schema;
  for (const part of path.split('/').filter(Boolean)) current = /^\d+$/u.test(part) ? current?.items : current?.properties?.[part];
  if (current===undefined) return undefined;
  const decimal = /\/calculations\/\d+\/(?:scale|factor|operands\/[^/]+\/value)$/u.test(path);
  return { target: {path},submission_shape:current,
    ...(decimal && typeof issue.actual === 'number' ? {
      repair_action: `仅把 ${path} 的数字改成带双引号的十进制字符串：${JSON.stringify(String(issue.actual))}。数字内容不变；不要重新计算、删除问题或重写其他字段。修正后的完整结果仍会重新验收。`,
    } : {}) };
}
