import { canonical } from "@eval/contracts";
import type { PlannedTask } from "@eval/contracts";
import {
  normalizeLabel,
  type ClusteringItem,
  type ClusteringObservation,
  type ClusteringObservationRef,
} from "@eval/agents/clustering";
import type { AttributionResult, ClusteringScope, TaskData } from "./types.js";

type ReceiptLookup = (taskId: string) => { evaluation?: unknown } | undefined;

export interface ProblemSource {
  input_id: string;
  case_id: string;
  source: { file: string; line: number };
  findings: AttributionResult["findings"];
}

/**
 * Collapse problem findings into one observation per normalized `(component, label)`. The agent
 * sees how often the problem occurred; each occurrence keeps its exact finding coordinates so the
 * workflow can expand assignments back after acceptance.
 */
export function groupObservations(sources: ProblemSource[]): ClusteringObservation[] {
  const groups = new Map<
    string,
    {
      component: string;
      label: string;
      definition: string;
      entries: { ref: ClusteringObservationRef; example: ClusteringItem["examples"][number] }[];
    }
  >();
  for (const source of sources)
    for (const finding of source.findings) {
      if (finding.type !== "problem" || !finding.problem) continue;
      const key = `${normalizeLabel(finding.problem.component)}\u0000${normalizeLabel(finding.problem.label)}`;
      const group = groups.get(key) ?? {
        component: finding.problem.component,
        label: finding.problem.label,
        definition: "",
        entries: [],
      };
      if (!group.definition && finding.problem.definition.trim())
        group.definition = finding.problem.definition;
      const evidence = finding.evidence[0];
      group.entries.push({
        ref: {
          input_id: source.input_id,
          case_id: source.case_id,
          source: source.source,
          finding_id: finding.finding_id,
          message_index: evidence?.message_index ?? -1,
          quote: evidence?.quote ?? "",
        },
        example: {
          finding: finding.text,
          reason: finding.reason,
          dimension: finding.dimension,
          importance: finding.importance,
          stage: finding.stage,
        },
      });
      groups.set(key, group);
    }
  return [...groups.values()]
    .sort((a, b) => (canonical([a.component, a.label]) < canonical([b.component, b.label]) ? -1 : 1))
    .map((group, index) => {
      const entries = group.entries.sort((a, b) =>
        canonical([a.ref.case_id, a.ref.finding_id]) < canonical([b.ref.case_id, b.ref.finding_id]) ? -1 : 1,
      );
      const examples: ClusteringItem["examples"] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.example.finding)) continue;
        seen.add(entry.example.finding);
        examples.push(entry.example);
        if (examples.length >= 3) break;
      }
      return {
        id: `o${index + 1}`,
        component: group.component,
        label: group.label,
        definition: group.definition,
        count: entries.length,
        examples,
        refs: entries.map((entry) => entry.ref),
      };
    });
}

export function observationsFor(
  scope: ClusteringScope,
  receipt: (inputId: string) => { evaluation?: unknown } | undefined,
): ClusteringObservation[] {
  return groupObservations(
    Object.entries(scope.cases).map(([input_id, entry]) => ({
      input_id,
      case_id: entry.case_id,
      source: entry.source,
      findings:
        ((receipt(input_id)?.evaluation as AttributionResult | undefined)?.findings) ?? [],
    })),
  );
}

/** Rebuild the observations of a clustering task from its accepted attribution dependencies. */
export function taskObservations(task: PlannedTask, receipt: ReceiptLookup): ClusteringObservation[] {
  const scope = (task.data as TaskData).scope;
  if (!scope) throw new Error("clustering task is missing its scope");
  return observationsFor(scope, (inputId) => receipt(task.dependencies[inputId]!));
}

/** Request items are observations without the local occurrence coordinates. */
export function requestItems(observations: ClusteringObservation[]): ClusteringItem[] {
  return observations.map(({ refs: _refs, ...item }) => item);
}
