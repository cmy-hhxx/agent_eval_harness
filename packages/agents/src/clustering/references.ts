import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import type { ClusteringRequest, ClusteringResult, ClusteringSubmission } from "./types.js";
import { normalizeLabel } from "./library.js";
import schema from "../../../../schemas/clustering/submission.schema.json" with { type: "json" };

const validate = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);

/** References are local to this immutable request, never persisted as class identities. */
export function references(input: ClusteringRequest) {
  const classes = input.library.components.flatMap((component) => component.classes);
  const classIds = new Map(classes.map((entry, index) => [`C${index + 1}`, entry.id]));
  const itemIds = new Map(input.items.map((entry, index) => [`O${index + 1}`, entry.id]));
  const display = new Map([...classIds, ...itemIds].map(([ref, id]) => [id, ref]));
  input.library.components.forEach((component, index) => display.set(component.id, `P${index + 1}`));
  const answers = [...new Set([...input.items.flatMap(item => item.established_answer_ids),
    ...classes.flatMap(problem => problem.examples.map(example => example.input_id))])].sort();
  const answerIds = new Map(answers.map((id, index) => [`A${index + 1}`, id]));
  answerIds.forEach((id, ref) => display.set(id, ref));
  const project = <T>(value: T): T => {
    if (typeof value === "string") return (display.get(value) ?? value) as T;
    if (Array.isArray(value)) return value.map(project) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, project(child)])) as T;
    return value;
  };
  return { classIds, itemIds, answerIds, project };
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
  const value = draft as ClusteringSubmission;
  const newClassKey = (index: number) => `n${index + 1}`;
  const componentIds = new Map(input.library.components.flatMap(component =>
    [component.label, ...component.aliases].map(label => [normalizeLabel(label), component.id] as const)));
  const classChoices = (component: string) => input.library.components
    .filter(entry => entry.id === componentIds.get(normalizeLabel(component)))
    .flatMap(entry => entry.classes.map(({ id, label }) => ({ id, label, component: entry.label })));
  const result: ClusteringResult = {
    assignments: value.assignments.map(({ new_class_index, class_label, ...entry }, index) => {
      if (new_class_index !== undefined && new_class_index >= value.new_classes.length)
        errors.push({ category: "decision", code: "clustering_new_class_index", path: `/assignments/${index}/new_class_index`,
          message: "请选择本次 new_classes 数组中实际存在的位置，位置从 0 开始。", actual: new_class_index,
          expected: { available_new_classes: value.new_classes.map(({ component, label }, index) => ({ index, component, label })) } });
      const itemId = resolve(entry.item_id, refs.itemIds, `/assignments/${index}/item_id`);
      const item = input.items.find(item => item.id === itemId);
      const choices = item ? classChoices(item.component) : [];
      const selected = class_label === undefined ? undefined : choices.find(choice => choice.label === class_label);
      if (class_label !== undefined && !selected)
        errors.push({ category: "decision", code: "clustering_class_label_unknown", path: `/assignments/${index}/class_label`,
          message: "请选择当前观察所属组件中的完整类名；没有适用类时新建或说明待观察原因，不猜测编号或相近名称。",
          actual: class_label, expected: choices.map(choice => choice.label) });
      return {
        ...entry,
        item_id: itemId,
        ...(selected === undefined ? {} : { class_id: selected.id }),
        ...(new_class_index === undefined ? {} : { new_class_key: newClassKey(new_class_index) }),
      };
    }),
    new_classes: value.new_classes.map((entry, index) => {
      const choices = classChoices(entry.component);
      if (entry.closest_existing === undefined && choices.length)
        errors.push({ category: "decision", code: "clustering_new_class_uncompared", path: `/new_classes/${index}/closest_existing`,
          message: "同组件已有问题类，必须选择最接近的已有类并说明实质差异。",
          expected: { available_classes: refs.project(choices) } });
      return {
        ...entry,
        key: newClassKey(index),
        closest_existing: entry.closest_existing == null ? null
          : resolve(entry.closest_existing, refs.classIds, `/new_classes/${index}/closest_existing`),
      };
    }),
    merges: value.merges.map((entry, index) => ({
      ...entry,
      into: resolve(entry.into, refs.classIds, `/merges/${index}/into`),
      from: entry.from.map((ref, offset) => resolve(ref, refs.classIds, `/merges/${index}/from/${offset}`)),
    })),
    ...(value.class_updates ? { class_updates: value.class_updates.map((entry, index) => ({ ...entry,
      class_id: resolve(entry.class_id, refs.classIds, `/class_updates/${index}/class_id`),
    })) } : {}),
  };
  if (errors.length) throw new ValidationError(errors);
  return result;
}
