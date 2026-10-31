import { randomUUID } from "node:crypto";
import { ValidationError } from "@eval/contracts";
import type {
  JsonObject,
  ProblemClass,
  ProblemComponent,
  ProblemEventType,
  ProblemLibrary,
  ProblemOrigin,
  ProblemProjection,
  AttributionSource,
} from "@eval/contracts";
import type { ClusteringResult, ClusteringExample } from "./types.js";
import { categoryIssues, unionCategories } from "./organization.js";
import { effectiveProblemOccurrences } from "./occurrence-review.js";
import { representativeSamples } from "./samples.js";

export const normalizeLabel = (label: string): string =>
  label.trim().replace(/\s+/gu, " ").toLowerCase();

/** One finding may have several responsible components or appear under several topics. */
export const problemSampleKey = (sample: { input_id: string; problem_path: string; attribution?: { submission_id: string } }): string =>
  JSON.stringify([sample.attribution?.submission_id ?? null, sample.input_id, sample.problem_path]);

export function countProblemSamples(samples: Iterable<{ input_id: string; problem_path: string }>): number {
  return new Set(Array.from(samples, problemSampleKey)).size;
}

export function emptyLibrary(model: string): ProblemLibrary {
  return {
    model,
    updated_at: new Date(0).toISOString(),
    components: {},
    classes: {},
    occurrences: [],
    events: [],
  };
}

/** Active component directory with active classes and how many samples each class has. */
export function projectLibrary(library: ProblemLibrary): ProblemProjection {
  const counts = new Map<string, Set<string>>();
  const occurrences = effectiveProblemOccurrences(library);
  for (const occurrence of occurrences) {
    const samples = counts.get(occurrence.class_id) ?? new Set<string>();
    samples.add(problemSampleKey(occurrence));
    counts.set(occurrence.class_id, samples);
  }
  const active = Object.values(library.classes).filter((problem) => problem.status === "active");
  return {
    components: Object.values(library.components).map((component) => ({
      id: component.id,
      label: component.label,
      definition: component.definition,
      aliases: component.aliases,
      classes: active
        .filter((problem) => problem.component_id === component.id)
        .map((problem) => ({
          id: problem.id,
          label: problem.label,
          definition: problem.definition,
          aliases: problem.aliases,
          ...(problem.category === undefined ? {} : { category: problem.category }),
          occurrences: counts.get(problem.id)?.size ?? 0,
          examples: representativeSamples(occurrences.filter(item => item.class_id === problem.id), item => ({
            answer: item.input_id, date: item.batch_id, certainty: item.evidence_status, scene: item.case_id,
            key: `${item.batch_id}\u0000${item.case_id}\u0000${item.problem_path}`,
          })).map(({ input_id, batch_id, case_id, problem_path, evidence_status, run_id, task_id, submission_id, attribution }) => ({
            input_id, batch_id, case_id, problem_path, evidence_status, run_id, task_id, submission_id,
            ...(attribution ? { attribution: { ...attribution } } : {}),
          })),
        })),
    })),
  };
}

/** Follow `merged_into` until an active class is reached. */
export function resolveActiveClass(library: ProblemLibrary, id: string): ProblemClass | undefined {
  let current = library.classes[id];
  const seen = new Set<string>();
  while (current && current.status === "merged" && current.merged_into && !seen.has(current.id)) {
    seen.add(current.id);
    current = library.classes[current.merged_into];
  }
  return current && current.status === "active" ? current : undefined;
}

function matchesLabel(node: { label: string; aliases: string[] }, label: string): boolean {
  const target = normalizeLabel(label);
  return normalizeLabel(node.label) === target || node.aliases.some((alias) => normalizeLabel(alias) === target);
}

export interface ClusteringObservationRef {
  input_id: string;
  case_id: string;
  source: { file: string; line: number };
  problem_path: string;
  message_index: number;
  quote: string;
  evidence_status: "已确认" | "待核实";
  /** Cross-run observations retain the individual source date and accepted receipt. */
  batch_id?: string;
  attribution?: AttributionSource;
}
/** One deduplicated proposal plus the finding coordinates needed to record occurrences. */
export interface ClusteringObservation {
  id: string;
  component: string;
  label: string;
  definition: string;
  count: number;
  established_count: number;
  uncertain_count: number;
  established_answer_ids: string[];
  examples: ClusteringExample[];
  refs: ClusteringObservationRef[];
}
export interface ApplyClusteringInput {
  run_id: string;
  evaluator_version: string;
  task_id: string;
  submission_id: string;
  version: string;
  batch_id: string;
  run_path?: string;
  observations: ClusteringObservation[];
  result: ClusteringResult;
  /** Replace this finding's current class within its original component, retaining history. */
  replace_assignments?: boolean;
  at?: string;
}

function originFor(input: ApplyClusteringInput, ref: ClusteringObservationRef | undefined, at: string): ProblemOrigin {
  return {
    run_id: input.run_id,
    evaluator_version: input.evaluator_version,
    batch_id: ref?.batch_id ?? input.batch_id,
    case_id: ref?.case_id ?? "",
    input_id: ref?.input_id ?? "",
    at,
  };
}

/**
 * Apply one accepted clustering receipt to a model library. Merges first, then new classes,
 * then occurrences; idempotent by component + class label/alias and `(class, input, finding)`.
 */
export function applyClustering(library: ProblemLibrary, input: ApplyClusteringInput): ProblemLibrary {
  if (input.replace_assignments && library.events.some(event => event.type === "assignments_replaced" &&
    event.detail.submission_id === input.submission_id)) return library;
  const at = input.at ?? new Date().toISOString();
  const next: ProblemLibrary = {
    ...library,
    components: Object.fromEntries(
      Object.entries(library.components).map(([id, component]) => [
        id,
        { ...component, aliases: [...component.aliases] },
      ]),
    ),
    classes: Object.fromEntries(
      Object.entries(library.classes).map(([id, problem]) => [
        id,
        { ...problem, aliases: [...problem.aliases],
          ...(problem.category === undefined ? {} : { category: problem.category }) },
      ]),
    ),
    occurrences: library.occurrences.map((occurrence) => ({ ...occurrence })),
    events: [...library.events],
  };
  let changed = false;
  const updateApplied = (classId: string) => next.events.some(event => event.type === "class_updated" &&
    event.detail.submission_id === input.submission_id && event.detail.class_id === classId);
  const event = (type: ProblemEventType, detail: JsonObject) => {
    changed = true;
    next.events.push({ id: randomUUID(), type, at, detail });
  };
  const componentFor = (label: string, origin: ProblemOrigin): ProblemComponent =>
    Object.values(next.components).find((component) => matchesLabel(component, label)) ??
    (() => {
      const created: ProblemComponent = {
        id: randomUUID(),
        label,
        definition: "",
        aliases: [],
        first_seen: origin,
      };
      next.components[created.id] = created;
      event("class_created", { component_id: created.id, kind: "component" });
      return created;
    })();
  const createClass = (componentId: string, label: string, definition: string, origin: ProblemOrigin, category?: string): ProblemClass => {
    const created: ProblemClass = {
      id: randomUUID(),
      component_id: componentId,
      label,
      definition,
      aliases: [],
      status: "active",
      merged_into: null,
      first_seen: origin,
      ...(category === undefined ? {} : { category }),
    };
    next.classes[created.id] = created;
    event("class_created", { class_id: created.id, component_id: componentId, kind: "class" });
    return created;
  };

  for (const [mergeIndex, merge] of input.result.merges.entries()) {
    const target = resolveActiveClass(next, merge.into);
    if (!target) continue;
    for (const fromId of merge.from) {
      const source = next.classes[fromId];
      if (!source || source.status === "merged") continue;
      if (source.component_id !== target.component_id)
        throw new Error(`不能跨组件合并问题类：${source.id} → ${target.id}`);
      source.status = "merged";
      source.merged_into = target.id;
      target.aliases = [...new Set([...target.aliases, source.label, ...source.aliases])];
      const explicitCategory = updateApplied(target.id) ? undefined :
        input.result.class_updates?.find(update => update.class_id === target.id)?.category;
      const categories = unionCategories(target.category, source.category);
      const issues = explicitCategory === undefined
        ? categories.flatMap(category => categoryIssues(category, `/merges/${mergeIndex}/category`))
        : categoryIssues(explicitCategory, `/merges/${mergeIndex}/category`);
      if (issues.length) throw new ValidationError(issues);
      if (categories.length > 1 && explicitCategory === undefined)
        throw new Error("合并后只能保留一个问题方向；需要明确维护目标类的 category");
      if (explicitCategory === undefined && (target.category !== undefined || source.category !== undefined))
        target.category = categories[0];
      for (const occurrence of next.occurrences)
        if (occurrence.class_id === source.id) {
          occurrence.previous_class_id = source.id;
          occurrence.class_id = target.id;
        }
      event("class_merged", { from: source.id, into: target.id, reason: merge.reason,
        run_id: input.run_id, task_id: input.task_id, submission_id: input.submission_id,
        ...(input.run_path ? { run: input.run_path } : {}) });
      event("occurrence_moved", { from: source.id, into: target.id });
    }
  }

  for (const [updateIndex, update] of (input.result.class_updates ?? []).entries()) {
    // Replaying an old accepted receipt must never roll back later directory maintenance.
    if (updateApplied(update.class_id)) continue;
    const issues = categoryIssues(update.category, `/class_updates/${updateIndex}/category`);
    if (issues.length) throw new ValidationError(issues);
    const problem = next.classes[update.class_id];
    if (!problem || problem.status !== "active") throw new Error("维护目标必须仍是活跃问题类：" + update.class_id);
    const before: JsonObject = { label: problem.label, definition: problem.definition,
      category: problem.category ?? null };
    if (update.label !== undefined && update.label !== problem.label) {
      const collision = Object.values(next.classes).find(other => other.id !== problem.id &&
        other.status === "active" && other.component_id === problem.component_id && matchesLabel(other, update.label!));
      if (collision) throw new Error("维护名称与同组件活跃问题类冲突：" + collision.id);
      problem.aliases = [...new Set([...problem.aliases, problem.label])].filter(alias => normalizeLabel(alias) !== normalizeLabel(update.label!));
      problem.label = update.label;
    }
    if (update.definition !== undefined) problem.definition = update.definition;
    if (update.category !== undefined) problem.category = update.category;
    event("class_updated", { class_id: problem.id, submission_id: input.submission_id,
      task_id: input.task_id, run_id: input.run_id, reason: update.reason, before,
      ...(input.run_path ? { run: input.run_path } : {}),
      after: { label: problem.label, definition: problem.definition, category: problem.category ?? null } });
  }

  const observations = new Map(input.observations.map((observation) => [observation.id, observation]));
  const firstObservation = new Map<string, ClusteringObservation>();
  for (const assignment of input.result.assignments) {
    const key = assignment.new_class_key;
    if (!key || firstObservation.has(key)) continue;
    const observation = observations.get(assignment.item_id);
    if (observation) firstObservation.set(key, observation);
  }
  const createdClasses = new Map<string, { problem: ProblemClass; created: boolean }>();
  for (const [newClassIndex, entry] of input.result.new_classes.entries()) {
    const origin = originFor(input, firstObservation.get(entry.key)?.refs[0], at);
    const component = componentFor(entry.component, origin);
    const existing = Object.values(next.classes).find(
      (problem) => problem.status === "active" && problem.component_id === component.id && matchesLabel(problem, entry.label),
    );
    if (!existing) {
      const issues = categoryIssues(entry.category, `/new_classes/${newClassIndex}/category`);
      if (issues.length) throw new ValidationError(issues);
    }
    const problem = existing ?? createClass(component.id, entry.label, entry.definition, origin, entry.category);
    createdClasses.set(entry.key, { problem, created: !existing });
  }

  const seen = new Set(
    next.occurrences.map(
      (occurrence) => `${occurrence.class_id}\u0000${problemSampleKey(occurrence)}`,
    ),
  );
  for (const assignment of input.result.assignments) {
    const observation = observations.get(assignment.item_id);
    if (!observation) continue;
    const entry = assignment.new_class_key ? createdClasses.get(assignment.new_class_key) : undefined;
    const problem = assignment.class_id
      ? resolveActiveClass(next, assignment.class_id)
      : entry?.problem;
    if (!problem) continue;
    const classification = entry?.created ? "created" : "assigned";
    for (const ref of observation.refs) {
      const key = `${problem.id}\u0000${problemSampleKey(ref)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changed = true;
      next.occurrences.push({
        id: randomUUID(),
        class_id: problem.id,
        version: input.version,
        evaluator_version: input.evaluator_version,
        batch_id: ref.batch_id ?? input.batch_id,
        case_id: ref.case_id,
        input_id: ref.input_id,
        run_id: input.run_id,
        ...(input.run_path ? { clustering_run: input.run_path } : {}),
        ...(ref.attribution ? { attribution: ref.attribution } : {}),
        task_id: input.task_id,
        submission_id: input.submission_id,
        problem_path: ref.problem_path,
        evidence_status: ref.evidence_status,
        message_index: ref.message_index,
        source: ref.source,
        classification,
        previous_class_id: null,
        at,
      });
    }
  }
  if (input.replace_assignments) {
    const targets: JsonObject[] = [];
    for (const assignment of input.result.assignments) {
      const observation = observations.get(assignment.item_id);
      if (!observation) throw new Error("重新归类缺少原观察：" + assignment.item_id);
      const component = Object.values(next.components).find(item => matchesLabel(item, observation.component));
      const problem = assignment.class_id ? resolveActiveClass(next, assignment.class_id) :
        assignment.new_class_key ? createdClasses.get(assignment.new_class_key)?.problem : undefined;
      if (problem && problem.component_id !== component?.id) throw new Error("重新归类不能改变责任组件");
      if (!component) continue; // An unclassified component has no previous class to supersede.
      for (const ref of observation.refs) {
        const occurrence = problem && next.occurrences.find(item => item.class_id === problem.id &&
          problemSampleKey(item) === problemSampleKey(ref));
        if (problem && !occurrence) throw new Error("重新归类缺少已保存的样本关联");
        targets.push({ input_id: ref.input_id, problem_path: ref.problem_path, component_id: component.id,
          ...(ref.attribution ? { attribution: { submission_id: ref.attribution.submission_id } } : {}),
          occurrence_id: occurrence ? occurrence.id : null });
      }
    }
    event("assignments_replaced", { run_id: input.run_id, task_id: input.task_id,
      submission_id: input.submission_id, targets, ...(input.run_path ? { run: input.run_path } : {}) });
  }
  if (!changed) return library;
  next.updated_at = at;
  return next;
}
