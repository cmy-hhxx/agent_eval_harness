import { evidenceSelectionSchema, type AgentRequest, type JsonObject, type ValidationIssue } from "@eval/contracts";
import { attributionSubmissionSchema } from "./submission-schema.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const shapeKeys = ["type", "enum", "const", "required", "additionalProperties", "minimum", "minItems", "maxItems", "minLength", "description"];
function typedShape(schema: unknown, shallow = false): unknown {
  const node = object(schema);
  if (!node) return schema;
  const shape: JsonObject = {};
  for (const key of shapeKeys) if (node[key] !== undefined && (!shallow || key === "type")) shape[key] = node[key];
  if (!shallow && object(node.properties))
    shape.properties = Object.fromEntries(Object.entries(node.properties as JsonObject).map(([key, value]) => [key, typedShape(value)]));
  if (node.items !== undefined) shape.items = typedShape(node.items, shallow);
  if (!shallow && Array.isArray(node.allOf)) shape.allOf = node.allOf.map(typed => {
    const branch = object(typed)!;
    return Object.fromEntries(Object.entries(branch).map(([key, value]) => [key, typedShape(value)]));
  });
  return shape;
}

function structureContext(request: AgentRequest, issue: ValidationIssue, findingIndex?: number): JsonObject | undefined {
  if (issue.category !== "structure" || !issue.code.startsWith("schema_") || issue.code === "schema_if") return undefined;
  const schema = evidenceSelectionSchema(attributionSubmissionSchema(request));
  const segments = issue.path.split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let node: unknown = schema, path = "";
  for (const segment of segments) {
    const current = object(node), properties = object(current?.properties);
    const next = current?.type === "array" && /^(?:0|[1-9]\d*)$/u.test(segment)
      ? current.items : properties?.[segment];
    if (next === undefined) break;
    node = next;
    path += "/" + segment;
  }
  const fieldLocations: string[] = [], fieldName = segments.at(-1);
  const locate = (value: unknown, path: string) => {
    const schema = object(value);
    if (!schema) return;
    for (const [key, child] of Object.entries(object(schema.properties) ?? {})) {
      const childPath = path + "/" + key;
      if (key === fieldName) fieldLocations.push(childPath);
      locate(child, childPath);
    }
    if (schema.items !== undefined) locate(schema.items, path + "/*");
  };
  if (path !== issue.path) locate(schema, "");
  const forbidden = issue.code === "schema_false schema";
  const findingSchema = findingIndex === undefined ? undefined : object(object(object(schema.properties)?.findings)?.items);
  return { submission_shape: {
    root_fields: Object.fromEntries(Object.entries(object(schema.properties) ?? {}).map(([key, value]) => [key, typedShape(value, true)])),
    // AJV has already proved an active false constraint; the base property shape cannot override it.
    ...(path ? { field: { path, schema: forbidden ? false : typedShape(node) } } : {}),
    ...(forbidden && findingSchema ? { container: { path: `/findings/${findingIndex}`, schema: {
      type: findingSchema.type, allOf: (typedShape(findingSchema) as JsonObject).allOf,
    } } } : {}),
    ...(fieldLocations.length ? { field_locations: fieldLocations.map(path => findingIndex === undefined
      ? path : path.replace("/findings/*/", `/findings/${findingIndex}/`)) } : {}),
  } };
}

/** Locate the exact submitted item; an ID or index supplies repair context, never evidence. */
export function findingIssueContext(request: AgentRequest, value: unknown, issue: ValidationIssue): JsonObject | undefined {
  const match = /^\/findings\/(0|[1-9]\d*)(?:\/|$)/u.exec(issue.path) ??
    /^findings\[(0|[1-9]\d*)\](?:\.|$)/u.exec(issue.path);
  if (!match) return structureContext(request, issue);
  const index = Number(match[1]), findings = object(value)?.findings;
  if (!Number.isSafeInteger(index) || !Array.isArray(findings) || index >= findings.length) return undefined;
  const finding = object(findings[index]);
  const text = typeof finding?.text === "string" ? Array.from(finding.text) : undefined;
  return { ...structureContext(request, issue, index), target: { finding_index: index, index_base: 0, path: issue.path,
    ...(typeof finding?.finding_id === "string" ? { finding_id: finding.finding_id } : {}),
    ...(text ? { text: text.slice(0, 160).join("") + (text.length > 160 ? "…" : "") } : {}),
  } };
}
