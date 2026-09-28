import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import type { ClusteringRequest, ClusteringResult } from "./types.js";
import schema from "../../../../schemas/clustering/submission.schema.json" with { type: "json" };

const validate = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);

/** References are local to this immutable request, never persisted as class identities. */
export function references(input: ClusteringRequest) {
  const classes = input.library.components.flatMap((component) => component.classes);
  const classIds = new Map(classes.map((entry, index) => [`C${index + 1}`, entry.id]));
  const itemIds = new Map(input.items.map((entry, index) => [`O${index + 1}`, entry.id]));
  const display = new Map([...classIds, ...itemIds].map(([ref, id]) => [id, ref]));
  input.library.components.forEach((component, index) => display.set(component.id, `P${index + 1}`));
  const project = <T>(value: T): T => {
    if (typeof value === "string") return (display.get(value) ?? value) as T;
    if (Array.isArray(value)) return value.map(project) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, project(child)])) as T;
    return value;
  };
  return { classIds, itemIds, project };
}

export function resolveSubmission(request: AgentRequest, draft: unknown): ClusteringResult {
  if (!validate(draft)) throw new ValidationError(schemaIssues(validate.errors, draft));
  const input = request.input as unknown as ClusteringRequest;
  const refs = references(input);
  const errors: ValidationIssue[] = [];
  const resolve = (value: string, choices: Map<string, string>, path: string): string => {
    const id = choices.get(value);
    if (id !== undefined) return id;
    errors.push({ category: "decision", code: "clustering_reference_unknown", path,
      message: "编号不在本次材料中，请选择本次给出的编号", actual: value, expected: [...choices.keys()] });
    return value;
  };
  const value = draft as ClusteringResult;
  const result: ClusteringResult = {
    assignments: value.assignments.map((entry, index) => ({
      ...entry,
      item_id: resolve(entry.item_id, refs.itemIds, `/assignments/${index}/item_id`),
      ...(entry.class_id === undefined ? {} : {
        class_id: resolve(entry.class_id, refs.classIds, `/assignments/${index}/class_id`),
      }),
    })),
    new_classes: value.new_classes.map((entry, index) => ({
      ...entry,
      closest_existing: entry.closest_existing === null ? null
        : resolve(entry.closest_existing, refs.classIds, `/new_classes/${index}/closest_existing`),
    })),
    merges: value.merges.map((entry, index) => ({
      ...entry,
      into: resolve(entry.into, refs.classIds, `/merges/${index}/into`),
      from: entry.from.map((ref, offset) => resolve(ref, refs.classIds, `/merges/${index}/from/${offset}`)),
    })),
  };
  if (errors.length) throw new ValidationError(errors);
  return result;
}
