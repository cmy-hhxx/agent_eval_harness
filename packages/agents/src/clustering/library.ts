import { randomUUID } from "node:crypto";
import type {
  JsonObject,
  ProblemClass,
  ProblemComponent,
  ProblemEventType,
  ProblemLibrary,
  ProblemOrigin,
  ProblemProjection,
} from "@eval/contracts";
import type { ClusteringResult } from "./types.js";

export const normalizeLabel = (label: string): string =>
  label.trim().replace(/\s+/gu, " ").toLowerCase();

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
  const counts = new Map<string, number>();
  for (const occurrence of library.occurrences)
    counts.set(occurrence.class_id, (counts.get(occurrence.class_id) ?? 0) + 1);
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
          occurrences: counts.get(problem.id) ?? 0,
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
  finding_id: string;
  message_index: number;
  quote: string;
}
/** One deduplicated proposal plus the finding coordinates needed to record occurrences. */
export interface ClusteringObservation {
  id: string;
  component: string;
  label: string;
  definition: string;
  count: number;
  examples: {
    finding: string;
    reason: string;
    dimension: string;
    importance: string;
    stage: string;
  }[];
  refs: ClusteringObservationRef[];
}
export interface ApplyClusteringInput {
  run_id: string;
  task_id: string;
  submission_id: string;
  version: string;
  batch_id: string;
  observations: ClusteringObservation[];
  result: ClusteringResult;
  at?: string;
}

function originFor(input: ApplyClusteringInput, ref: ClusteringObservationRef | undefined, at: string): ProblemOrigin {
  return {
    run_id: input.run_id,
    batch_id: input.batch_id,
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
        { ...problem, aliases: [...problem.aliases] },
      ]),
    ),
    occurrences: library.occurrences.map((occurrence) => ({ ...occurrence })),
    events: [...library.events],
  };
  let changed = false;
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
  const createClass = (componentId: string, label: string, definition: string, origin: ProblemOrigin): ProblemClass => {
    const created: ProblemClass = {
      id: randomUUID(),
      component_id: componentId,
      label,
      definition,
      aliases: [],
      status: "active",
      merged_into: null,
      first_seen: origin,
    };
    next.classes[created.id] = created;
    event("class_created", { class_id: created.id, component_id: componentId, kind: "class" });
    return created;
  };

  for (const merge of input.result.merges) {
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
      for (const occurrence of next.occurrences)
        if (occurrence.class_id === source.id) {
          occurrence.previous_class_id = source.id;
          occurrence.class_id = target.id;
        }
      event("class_merged", { from: source.id, into: target.id, reason: merge.reason });
      event("occurrence_moved", { from: source.id, into: target.id });
    }
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
  for (const entry of input.result.new_classes) {
    const origin = originFor(input, firstObservation.get(entry.key)?.refs[0], at);
    const component = componentFor(entry.component, origin);
    const existing = Object.values(next.classes).find(
      (problem) => problem.status === "active" && problem.component_id === component.id && matchesLabel(problem, entry.label),
    );
    const problem = existing ?? createClass(component.id, entry.label, entry.definition, origin);
    createdClasses.set(entry.key, { problem, created: !existing });
  }

  const seen = new Set(
    next.occurrences.map(
      (occurrence) => `${occurrence.class_id}\u0000${occurrence.input_id}\u0000${occurrence.finding_id}`,
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
      const key = `${problem.id}\u0000${ref.input_id}\u0000${ref.finding_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      changed = true;
      next.occurrences.push({
        id: randomUUID(),
        class_id: problem.id,
        version: input.version,
        batch_id: input.batch_id,
        case_id: ref.case_id,
        input_id: ref.input_id,
        run_id: input.run_id,
        task_id: input.task_id,
        submission_id: input.submission_id,
        finding_id: ref.finding_id,
        message_index: ref.message_index,
        quote: ref.quote,
        source: ref.source,
        classification,
        previous_class_id: null,
        at,
      });
    }
  }
  if (!changed) return library;
  next.updated_at = at;
  return next;
}
