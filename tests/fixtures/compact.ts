import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { bindAttribution, compactFieldResult, type AttributionTaskData } from "@eval/workflows/attribution";
import { emptyAudit, fakeEvaluatorVersion } from "./comparison.js";

export function compactReceipt(turns = 1): SubmissionReceipt {
  return { taskId: "compact", attemptId: "compact", submissionId: "compact", evaluatorVersion: fakeEvaluatorVersion,
    judge: "fixture", status: "succeeded", acceptedAt: 1, usage: emptyUsage(), audit: emptyAudit(),
    evaluation: { session_overview: { observation: "摘要观察进入归因。" }, meta: {},
      turns: Array.from({ length: turns }, (_, turn_index) => ({ turn_index, key_data: { value: 4, unit: "元" } })) } };
}
export function bindAttributionFixture(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined> = {}, options = {}) {
  if (task.stage === "attribution-compact") {
    const receipt = compactReceipt((task.data as AttributionTaskData).candidate.turns?.length ?? 1);
    dependencies = { ...Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => {
      const [index, field] = label.includes(":") ? label.split(":") : [undefined, label];
      return [label, { ...receipt, taskId: id, evaluation: compactFieldResult(receipt.evaluation as Record<string, unknown>, field!, index === undefined ? undefined : Number(index)) }];
    })), ...dependencies };
  }
  return bindAttribution(task, inputs, { compact: compactReceipt((task.data as AttributionTaskData).candidate.turns?.length ?? 1), ...dependencies }, options);
}
