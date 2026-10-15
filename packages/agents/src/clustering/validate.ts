import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import type { ClusteringRequest, ClusteringResult } from "./types.js";
import { normalizeLabel } from "./library.js";
import { categoryPathIssues, temporaryReferenceInDescription, unionCategoryPaths } from "./organization.js";
import { references } from "./references.js";
import schema from "../../../../schemas/clustering/result.schema.json" with { type: "json" };

const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
/**
 * Clustering is capped by the request budget: every observation is assigned once, assignments
 * only target active classes, and new classes must respect per-task and per-model limits.
 */
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  void audit;
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as ClusteringRequest;
  const value = result as ClusteringResult;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, actual?: unknown, expected?: unknown) =>
    errors.push({ category: "decision", code, path, message, actual, expected });
  if (input.budget.assignment_only && (value.new_classes.length || value.merges.length || value.class_updates?.length))
    issue("clustering_directory_frozen", "/", "回捞只允许归入现有类或保留待观察，不能新建、合并或修改目录。");

  const items = new Map(input.items.map((item) => [item.id, item]));
  const classes = input.library.components.flatMap((component) => component.classes);
  const classIds = new Set(classes.map((problem) => problem.id));
  const componentIds = new Map(
    input.library.components.flatMap((component) =>
      [component.label, ...component.aliases].map((label) => [normalizeLabel(label), component.id] as const),
    ),
  );
  const componentKey = (label: string) => componentIds.get(normalizeLabel(label)) ?? normalizeLabel(label);
  const classComponents = new Map(
    input.library.components.flatMap((component) =>
      component.classes.map((problem) => [problem.id, component.id] as const),
    ),
  );
  const classChoices = (component: string | undefined) => input.library.components
    .filter((entry) => component !== undefined && entry.id === componentKey(component))
    .flatMap((entry) => entry.classes.map(({ id, label }) => ({ id, label, component: entry.label })));
  const directoryRefs = references(input);
  const temporaryRefs = new Set([...directoryRefs.classIds.keys(), ...directoryRefs.itemIds.keys(), ...directoryRefs.answerIds.keys(),
    ...input.library.components.map((_, index) => `P${index + 1}`)]);
  const description = (text: string | undefined, path: string) => {
    if (text === undefined) return;
    if (!text.trim()) issue("clustering_description_empty", path, "类名称、定义和维护理由不能为空。", text);
    const reference = temporaryReferenceInDescription(text, temporaryRefs);
    if (reference) issue("clustering_temporary_reference", path,
      "长期类名称和定义不能使用本次请求的临时编号来解释含义；请直接描述现象及边界。", reference);
  };

  const intoIds = new Set(value.merges.map((merge) => merge.into));
  const fromIds = new Set<string>();
  for (const [index, merge] of value.merges.entries()) {
    if (!classIds.has(merge.into))
      issue("clustering_merge_unknown", `/merges/${index}/into`, "into 必须是库中活跃问题类", merge.into);
    for (const from of merge.from) {
      if (!classIds.has(from))
        issue("clustering_merge_unknown", `/merges/${index}/from`, "from 必须是库中活跃问题类", from);
      if (classComponents.has(from) && classComponents.has(merge.into) && classComponents.get(from) !== classComponents.get(merge.into))
        issue("clustering_merge_component", `/merges/${index}/from`, "合并的类必须属于同一组件", from);
      if (from === merge.into)
        issue("clustering_merge_target", `/merges/${index}/from`, "不能把类合并到自己", from);
      if (fromIds.has(from))
        issue("clustering_merge_overlap", `/merges/${index}/from`, "一个类只能作为一次合并的源", from);
      fromIds.add(from);
    }
  }
  for (const id of intoIds)
    if (fromIds.has(id))
      issue("clustering_merge_target", "/merges", "into 不能同时是其他合并的源", id);

  const updated = new Set<string>();
  for (const [index, update] of (value.class_updates ?? []).entries()) {
    const path = `/class_updates/${index}`, current = classes.find(item => item.id === update.class_id);
    if (!current) issue("clustering_update_unknown", `${path}/class_id`, "只能维护本次库中的活跃问题类。", update.class_id);
    if (fromIds.has(update.class_id)) issue("clustering_update_merged", `${path}/class_id`, "请维护合并后的 into 类，不能同时维护 from 类。", update.class_id);
    if (updated.has(update.class_id)) issue("clustering_update_duplicate", `${path}/class_id`, "同一问题类只能维护一次。", update.class_id);
    updated.add(update.class_id);
    description(update.label, `${path}/label`);
    description(update.definition, `${path}/definition`);
    if (!update.reason.trim()) issue("clustering_update_reason_empty", `${path}/reason`, "维护理由不能为空。", update.reason);
    errors.push(...categoryPathIssues(update.category_paths, `${path}/category_paths`));
    if (update.label && current) {
      const name = normalizeLabel(update.label);
      const collision = classes.find(item => item.id !== current.id && !fromIds.has(item.id) &&
        classComponents.get(item.id) === classComponents.get(current.id) &&
        [item.label, ...item.aliases, value.class_updates?.find(update => update.class_id === item.id)?.label ?? ""]
          .some(label => normalizeLabel(label) === name));
      if (collision) issue("clustering_update_label_existing", `${path}/label`, "该名称已属于同组件的其他活跃类；同义类应明确合并。", update.label, collision.id);
    }
  }
  for (const into of intoIds) {
    const index = value.merges.findIndex(merge => merge.into === into);
    const explicit = value.class_updates?.find(update => update.class_id === into)?.category_paths;
    const from = value.merges.filter(merge => merge.into === into).flatMap(merge => merge.from);
    const paths = explicit ?? unionCategoryPaths(...[into, ...from].map(id => classes.find(item => item.id === id)?.category_paths));
    if (paths.length > 1) issue("clustering_merge_category_budget", `/merges/${index}`,
      "合并后只能保留一条主要主题路径；请在 class_updates 中明确整理 into 类的 category_paths。", paths);
  }
  if (input.budget.consolidate) for (const problem of classes.filter(problem => !fromIds.has(problem.id))) {
    const paths = value.class_updates?.find(update => update.class_id === problem.id)?.category_paths ?? problem.category_paths;
    if (paths?.length !== 1 || paths[0].length !== 1)
      issue("clustering_direction_missing", "/class_updates",
        "全目录整理须为每个保留类指定一个问题方向；请用 class_updates.category_paths 填写一条一级路径。", problem.id);
  }

  const assigned = new Set<string>();
  for (const [index, assignment] of value.assignments.entries()) {
    const item = items.get(assignment.item_id);
    if (!items.has(assignment.item_id))
      issue("clustering_item_unknown", `/assignments/${index}/item_id`, "归类必须对应请求中的观察", assignment.item_id);
    else if (assigned.has(assignment.item_id))
      issue("clustering_item_duplicate", `/assignments/${index}/item_id`, "同一观察只能归类一次", assignment.item_id);
    assigned.add(assignment.item_id);
    if (assignment.class_id && !classIds.has(assignment.class_id))
      issue("clustering_class_unknown", `/assignments/${index}/class_id`,
        "class_id 必须是库中活跃问题类；核对同组件候选的含义后选择编号，没有合适类时按预算新建。",
        assignment.class_id, { available_classes: classChoices(item?.component) });
    if (assignment.class_id && fromIds.has(assignment.class_id))
      issue(
        "clustering_class_merged",
        `/assignments/${index}/class_id`,
        "已合并的类不能作为归类目标，请使用 into 的目标类",
        assignment.class_id,
      );
    const assignedComponent = assignment.class_id
      ? classComponents.get(assignment.class_id)
      : value.new_classes.find((entry) => entry.key === assignment.new_class_key)?.component;
    if (item && assignedComponent && componentKey(item.component) !==
      (assignment.class_id ? assignedComponent : componentKey(assignedComponent)))
      issue("clustering_component_mismatch", `/assignments/${index}`, "观察与目标问题类的组件不一致；只能归入同组件的类，不能改变观察的责任组件",
        item.component, { available_classes: classChoices(item.component) });
    if (assignment.new_class_key && !value.new_classes.some((entry) => entry.key === assignment.new_class_key))
      issue(
        "clustering_new_key_unknown",
        `/assignments/${index}/new_class_key`,
        "new_class_key 必须已在 new_classes 中声明",
        assignment.new_class_key,
      );
  }
  for (const item of input.items)
    if (!assigned.has(item.id))
      issue("clustering_item_missing", "/assignments", "每个观察都必须归类或明确延期", item.id);

  const usedKeys = new Set(
    value.assignments.flatMap((assignment) => (assignment.new_class_key ? [assignment.new_class_key] : [])),
  );
  const keys = new Set<string>();
  const labels = new Set<string>();
  for (const [index, entry] of value.new_classes.entries()) {
    if (keys.has(entry.key))
      issue("clustering_new_class_duplicate", `/new_classes/${index}/key`, "新类 key 必须唯一", entry.key);
    keys.add(entry.key);
    if (!usedKeys.has(entry.key))
      issue("clustering_new_class_unused", `/new_classes/${index}`, "每个新类至少覆盖一个观察", entry.key);
    const label = normalizeLabel(entry.label);
    if (!label)
      issue("clustering_new_label_empty", `/new_classes/${index}/label`, "问题名称不能为空");
    if (!normalizeLabel(entry.component))
      issue("clustering_new_component_empty", `/new_classes/${index}/component`, "问题组件不能为空");
    if (!entry.definition.trim())
      issue("clustering_new_definition_empty", `/new_classes/${index}/definition`, "问题定义不能为空");
    description(entry.label, `/new_classes/${index}/label`);
    description(entry.definition, `/new_classes/${index}/definition`);
    errors.push(...categoryPathIssues(entry.category_paths, `/new_classes/${index}/category_paths`));
    const key = `${componentKey(entry.component)}\u0000${label}`;
    if (labels.has(key))
      issue("clustering_new_class_duplicate", `/new_classes/${index}/label`, "同一组件内的新类 label 不能重复", entry.label);
    labels.add(key);
    const existing = classes.find(
      (problem) =>
        classComponents.get(problem.id) === componentKey(entry.component) &&
        (normalizeLabel(problem.label) === label || normalizeLabel(value.class_updates?.find(update => update.class_id === problem.id)?.label ?? "") === label ||
          problem.aliases.some((alias) => normalizeLabel(alias) === label)),
    );
    if (existing)
      issue(
        "clustering_new_class_existing",
        `/new_classes/${index}/label`,
        "库中已有同义类，必须把观察归入该 class_id",
        entry.label,
        existing.id,
      );
    if (classChoices(entry.component).length > 0 && !entry.closest_existing)
      issue(
        "clustering_new_class_uncompared",
        `/new_classes/${index}/closest_existing`,
        "同组件已有活跃类时必须给出最接近的已有问题类",
        entry.label,
      );
    if (entry.closest_existing && !classIds.has(entry.closest_existing))
      issue(
        "clustering_new_class_comparison",
        `/new_classes/${index}/closest_existing`,
        "closest_existing 必须是库中活跃问题类",
        entry.closest_existing,
      );
    if (entry.closest_existing && classIds.has(entry.closest_existing) &&
      classComponents.get(entry.closest_existing) !== componentKey(entry.component))
      issue("clustering_new_class_component_comparison", `/new_classes/${index}/closest_existing`,
        "closest_existing 只能比较同组件的活跃类；该组件没有已有类时填 null。",
        entry.closest_existing, { available_classes: classChoices(entry.component) });
  }
  if (value.new_classes.length > input.budget.max_new_classes)
    issue(
      "clustering_new_class_budget",
      "/new_classes",
      "new_classes 数量超过 budget.max_new_classes；合并不提高该上限。请复用合适的已有类，无法归类的观察填写 deferred_reason 说明本次限制。",
      value.new_classes.length,
      input.budget.max_new_classes,
    );
  const expectedClasses = input.budget.active_classes - fromIds.size + value.new_classes.length;
  if (expectedClasses > input.budget.max_classes)
    issue(
      "clustering_class_cap",
      "/new_classes",
      "合并后保留的活跃类数加 new_classes 数量超过 budget.max_classes。请复用合适类、合并同组件近义类，或对受上限限制的观察填写 deferred_reason。",
      expectedClasses,
      input.budget.max_classes,
    );
  const newComponents = new Set(
    value.new_classes
      .map((entry) => normalizeLabel(entry.component))
      .filter((label) => !componentIds.has(label)),
  );
  if (newComponents.size > input.budget.max_new_components)
    issue(
      "clustering_component_budget",
      "/new_classes",
      "new_classes 涉及的新增组件数超过 budget.max_new_components；已有组件应使用目录名称或别名，不改动观察的责任组件。",
      newComponents.size,
      input.budget.max_new_components,
    );
  if (input.budget.active_components + newComponents.size > input.budget.max_components)
    issue(
      "clustering_component_cap",
      "/new_classes",
      "已有组件数加新增组件数超过 budget.max_components；对无法归入已有组件且受上限限制的观察填写 deferred_reason。",
      input.budget.active_components + newComponents.size,
      input.budget.max_components,
    );

  const support = new Map<string, Set<string>>();
  for (const assignment of value.assignments)
    if (assignment.new_class_key) {
      const answers = support.get(assignment.new_class_key) ?? new Set<string>();
      for (const answer of items.get(assignment.item_id)?.established_answer_ids ?? []) answers.add(answer);
      support.set(assignment.new_class_key, answers);
    }
  for (const entry of value.new_classes)
    if ((support.get(entry.key)?.size ?? 0) < input.budget.min_support)
      issue(
        "clustering_new_support",
        "/new_classes",
        "该新类的已确认独立回答数低于 budget.min_support；同一回答多个发现只算一次，疑似样本不计支持。请复用合适类或填写 deferred_reason，不能用不同现象凑数。",
        { key: entry.key, support: support.get(entry.key)?.size ?? 0 },
        input.budget.min_support,
      );

  for (const [index, assignment] of value.assignments.entries()) {
    if (assignment.deferred_reason === undefined) continue;
    const item = items.get(assignment.item_id);
    if (!assignment.deferred_reason.trim()) issue("clustering_deferred_reason_empty", `/assignments/${index}/deferred_reason`, "延期归类必须说明实际预算或支持数量限制。");
    if (!item) continue;
    const existing = classes.find(problem => classComponents.get(problem.id) === componentKey(item.component) &&
      problem.definition === item.definition &&
      [problem.label, ...problem.aliases].some(label => normalizeLabel(label) === normalizeLabel(item.label)));
    if (existing) issue("clustering_deferred_existing", `/assignments/${index}`,
      "同组件已有同名或别名且定义完全相同的活跃类，应选择该类而非延期。", assignment.item_id, existing.id);
    const newComponent = !componentIds.has(normalizeLabel(item.component));
    const limited = value.new_classes.length >= input.budget.max_new_classes || expectedClasses >= input.budget.max_classes ||
      (newComponent && (newComponents.size >= input.budget.max_new_components ||
        input.budget.active_components + newComponents.size >= input.budget.max_components)) || item.established_answer_ids.length < input.budget.min_support;
    if (!limited) issue("clustering_deferred_unjustified", `/assignments/${index}`,
      "创建预算和支持数量充足时不能延期；请复用合适类或声明符合预算的新类。", assignment.item_id);
  }

  if (errors.length) throw new ValidationError(errors);
}
