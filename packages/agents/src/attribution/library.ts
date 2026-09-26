import { randomUUID } from "node:crypto";
import type {
  AttributionEvent,
  AttributionLibrary,
  AttributionNode,
  AttributionOrigin,
} from "@eval/contracts";
import type { AttributionFinding, LibraryProjection, ProblemRef } from "./types.js";

const normalize = (label: string): string => label.trim().replace(/\s+/gu, " ").toLowerCase();

export function emptyLibrary(model: string, previousTree: string | null = null): AttributionLibrary {
  return {
    model,
    tree_version: 1,
    previous_tree: previousTree,
    updated_at: new Date(0).toISOString(),
    nodes: {},
    occurrences: [],
    events: [],
  };
}

/** Recalled node directory: components, their active problems, and how many samples each has. */
export function projectLibrary(library: AttributionLibrary): LibraryProjection {
  const counts = new Map<string, number>();
  for (const occurrence of library.occurrences)
    counts.set(occurrence.node_id, (counts.get(occurrence.node_id) ?? 0) + 1);
  const active = Object.values(library.nodes).filter((node) => node.status === "active");
  return {
    components: active
      .filter((node) => node.kind === "component")
      .map((component) => ({
        id: component.id,
        label: component.label,
        definition: component.definition,
        problems: active
          .filter((node) => node.kind === "problem" && node.parent === component.id)
          .map((problem) => ({
            id: problem.id,
            label: problem.label,
            definition: problem.definition,
            occurrences: counts.get(problem.id) ?? 0,
          })),
      })),
  };
}

export interface ApplyInput {
  run_id: string;
  task_id: string;
  submission_id: string;
  version: string;
  batch_id: string;
  case_id: string;
  input_id: string;
  source: { file: string; line: number };
  findings: AttributionFinding[];
  at?: string;
}

function createNode(
  library: AttributionLibrary,
  node: Omit<AttributionNode, "id">,
  event: Omit<AttributionEvent, "id">,
): AttributionNode {
  const created = { ...node, id: randomUUID() };
  library.nodes[created.id] = created;
  library.events.push({ ...event, id: randomUUID(), detail: { node_id: created.id, ...event.detail } });
  return created;
}

/** Recalled node wins when it exists and is active; otherwise label-match, then create. */
function resolveComponent(
  library: AttributionLibrary,
  component: string,
  origin: AttributionOrigin,
  at: string,
): { node: AttributionNode; classification: "recalled" | "created" } {
  const existing = Object.values(library.nodes).find(
    (node) => node.kind === "component" && node.status === "active" && normalize(node.label) === normalize(component),
  );
  if (existing) return { node: existing, classification: "recalled" };
  return {
    node: createNode(
      library,
      {
        kind: "component",
        parent: null,
        label: component,
        definition: "",
        status: "active",
        merged_into: null,
        aliases: [],
        first_seen: origin,
      },
      { type: "node_created", at, detail: { kind: "component" } },
    ),
    classification: "created",
  };
}

function resolveProblem(
  library: AttributionLibrary,
  component: AttributionNode,
  ref: ProblemRef,
  origin: AttributionOrigin,
  at: string,
): { node: AttributionNode; classification: "recalled" | "created" } {
  const recalled = ref.node_id ? library.nodes[ref.node_id] : undefined;
  if (recalled && recalled.status === "active" && recalled.kind === "problem")
    return { node: recalled, classification: "recalled" };
  const existing = Object.values(library.nodes).find(
    (node) =>
      node.kind === "problem" &&
      node.parent === component.id &&
      node.status === "active" &&
      normalize(node.label) === normalize(ref.label),
  );
  if (existing) return { node: existing, classification: "recalled" };
  return {
    node: createNode(
      library,
      {
        kind: "problem",
        parent: component.id,
        label: ref.label,
        definition: ref.definition,
        status: "active",
        merged_into: null,
        aliases: [],
        first_seen: origin,
      },
      { type: "node_created", at, detail: { kind: "problem", parent: component.id } },
    ),
    classification: "created",
  };
}

/**
 * Attach one accepted attribution receipt to the model's tree. Append-only and idempotent by
 * `(node, input, finding)`; node identity is preserved and every sample keeps its lineage.
 */
export function applyAttribution(library: AttributionLibrary, input: ApplyInput): AttributionLibrary {
  const at = input.at ?? new Date().toISOString();
  const next: AttributionLibrary = {
    ...library,
    nodes: { ...library.nodes },
    occurrences: [...library.occurrences],
    events: [...library.events],
  };
  const origin: AttributionOrigin = {
    run_id: input.run_id,
    batch_id: input.batch_id,
    case_id: input.case_id,
    input_id: input.input_id,
    at,
  };
  const seen = new Set(
    next.occurrences.map((occurrence) => `${occurrence.node_id}\u0000${occurrence.input_id}\u0000${occurrence.finding_id}`),
  );
  input.findings.forEach((finding) => {
    if (!finding.problem) return;
    const findingId = finding.finding_id;
    const component = resolveComponent(next, finding.problem.component, origin, at);
    const problem = resolveProblem(next, component.node, finding.problem, origin, at);
    const key = `${problem.node.id}\u0000${input.input_id}\u0000${findingId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const evidence = finding.evidence[0];
    next.occurrences.push({
      id: randomUUID(),
      node_id: problem.node.id,
      version: input.version,
      batch_id: input.batch_id,
      case_id: input.case_id,
      input_id: input.input_id,
      run_id: input.run_id,
      task_id: input.task_id,
      submission_id: input.submission_id,
      finding_id: findingId,
      message_index: evidence?.message_index ?? -1,
      quote: evidence?.quote ?? "",
      source: input.source,
      classification: problem.classification === "recalled" ? "recalled" : "created",
      previous_node_id: null,
      at,
    });
  });
  next.updated_at = at;
  return next;
}
