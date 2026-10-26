import { evidenceMessageIndex, sessionProblems, type SessionAttributionResult, type SessionProblem } from "@eval/agents/attribution";
import { canonical } from "@eval/contracts";
import type { PlannedTask, SubmissionReceipt } from "@eval/contracts";
import {
  normalizeLabel,
  representativeSamples,
  type ClusteringItem,
  type ClusteringObservation,
  type ClusteringObservationRef,
} from "@eval/agents/clustering";
import type { ClusteringScope, TaskData } from "./types.js";

type AcceptedObservation = { evaluation?: unknown } & Partial<Pick<SubmissionReceipt, "submissionId" | "evaluatorVersion" | "taskId">>;
type ReceiptLookup = (taskId: string) => AcceptedObservation | undefined;

export interface ProblemSource {
  input_id: string;
  case_id: string;
  source: { file: string; line: number };
  problems: SessionProblem[];
  batch_id?: string;
  attribution?: ClusteringObservationRef["attribution"];
}

/**
 * Collapse identical proposal descriptions per `(component, label, definition)`. The agent
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
    for (const finding of source.problems) {
      const component = finding.component;
      {
        const key = canonical([normalizeLabel(component), normalizeLabel(finding.label), finding.definition]);
        const group = groups.get(key) ?? {
          component: component,
          label: finding.label,
          definition: finding.definition,
          entries: [],
        };
        const evidence = finding.evidence[0];
        if (!evidence) throw new Error(`问题样本缺少本方证据：${source.input_id}/${finding.problem_id}`);
        group.entries.push({
          ref: {
            ...(source.batch_id ? { batch_id: source.batch_id } : {}),
            ...(source.attribution ? { attribution: source.attribution } : {}),
            input_id: source.input_id,
            case_id: source.case_id,
            source: source.source,
            finding_id: finding.problem_id,
            evidence_status: "已确认",
            message_index: evidenceMessageIndex(evidence.position) ?? 0,
            quote: evidence.quote,
          },
          example: {
            finding: finding.problem_phenomena,
            reason: finding.reason,
            evidence_status: "已确认",
            responsibilities: [{ component, attribution_reason: finding.reason }],
          },
        });
        groups.set(key, group);
      }
    }
  return [...groups.values()]
    .sort((a, b) => (canonical([a.component, a.label, a.definition]) < canonical([b.component, b.label, b.definition]) ? -1 : 1))
    .map((group, index) => {
      const entries = group.entries.sort((a, b) =>
        canonical([a.ref.case_id, a.ref.finding_id]) < canonical([b.ref.case_id, b.ref.finding_id]) ? -1 : 1,
      );
      const examples = representativeSamples(entries, ({ ref, example }) => ({
        answer: ref.input_id, date: ref.batch_id ?? "", certainty: ref.evidence_status,
        scene: canonical(example.responsibilities?.map(cause=>cause.component)??[]),
        content: canonical(example),
        key: canonical([ref.case_id, ref.finding_id]),
      })).map(entry => entry.example);
      return {
        id: `o${index + 1}`,
        component: group.component,
        label: group.label,
        definition: group.definition,
        count: entries.length,
        established_count: entries.filter((entry) => entry.ref.evidence_status === "已确认").length,
        uncertain_count: entries.filter((entry) => entry.ref.evidence_status === "待核实").length,
        established_answer_ids: [...new Set(entries.filter(entry => entry.ref.evidence_status === "已确认")
          .map(entry => entry.ref.input_id))].sort(),
        examples,
        refs: entries.map((entry) => entry.ref),
      };
    });
}

function observationsFor(
  scope: ClusteringScope,
  receipt: (inputId: string) => AcceptedObservation | undefined,
  origin?: { run: string; run_id: string },
): ClusteringObservation[] {
  return groupObservations(
    Object.entries(scope.cases).map(([input_id, entry]) => {
      const accepted = receipt(input_id);
      if (origin && (!accepted?.taskId || !accepted.submissionId || !accepted.evaluatorVersion))
        throw new Error("问题样本缺少已接受归因身份：" + input_id);
      return {
        input_id,
        case_id: entry.case_id,
        batch_id: scope.batch_id,
        source: entry.source,
        ...(origin ? { attribution: { ...origin, task_id: accepted!.taskId!,
          submission_id: accepted!.submissionId!, evaluator_version: accepted!.evaluatorVersion! } } : {}),
        problems: accepted?.evaluation ? sessionProblems(accepted.evaluation as SessionAttributionResult) : [],
      };
    }),
  );
}

/** Rebuild the observations of a clustering task from its accepted attribution dependencies. */
export function taskObservations(task: PlannedTask, receipt: ReceiptLookup, origin?: { run: string; run_id: string }): ClusteringObservation[] {
  const scope = (task.data as TaskData).scope;
  if (!scope) throw new Error("clustering task is missing its scope");
  const observations = observationsFor(scope, (inputId) => receipt(task.dependencies[inputId]!), origin);
  const selected = (task.data as TaskData).reclassifyOf?.item_ids;
  return selected ? observations.filter(item => selected.includes(item.id)) : observations;
}

/** Request items are observations without the local occurrence coordinates. */
export function requestItems(observations: ClusteringObservation[]): ClusteringItem[] {
  return observations.map(({ refs: _refs, ...item }) => item);
}
