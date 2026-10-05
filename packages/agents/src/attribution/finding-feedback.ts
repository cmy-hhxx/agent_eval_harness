import type { AgentRequest, JsonObject, ValidationIssue } from "@eval/contracts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Locate the exact submitted item; an ID or index supplies repair context, never evidence. */
export function findingIssueContext(_request: AgentRequest, value: unknown, issue: ValidationIssue): JsonObject | undefined {
  const match = /^\/findings\/(0|[1-9]\d*)(?:\/|$)/u.exec(issue.path) ??
    /^findings\[(0|[1-9]\d*)\](?:\.|$)/u.exec(issue.path);
  if (!match) return undefined;
  const index = Number(match[1]), findings = object(value)?.findings;
  if (!Number.isSafeInteger(index) || !Array.isArray(findings) || index >= findings.length) return undefined;
  const finding = object(findings[index]);
  const text = typeof finding?.text === "string" ? Array.from(finding.text) : undefined;
  return { target: { finding_index: index, index_base: 0, path: issue.path,
    ...(typeof finding?.finding_id === "string" ? { finding_id: finding.finding_id } : {}),
    ...(text ? { text: text.slice(0, 160).join("") + (text.length > 160 ? "…" : "") } : {}),
  } };
}
