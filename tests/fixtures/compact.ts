import { emptyUsage, type JsonObject, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { bindAttribution, compactFieldResult, planAttributionUnit, attributionWorkflow, type AttributionTaskData } from "@eval/workflows/attribution";
import { emptyAudit, fakeEvaluatorVersion } from "./comparison.js";
import { attributionSessionSource, processComponents } from "@eval/workflows/review";
import { isComponentLocator } from "@eval/tools";
import { contentText, normalizeInput, type Candidate, type RawInput } from "@eval/workflows/inputs";

export function compactReceipt(turns = 1): SubmissionReceipt {
  return { taskId: "compact", attemptId: "compact", submissionId: "compact", evaluatorVersion: fakeEvaluatorVersion,
    judge: "fixture", status: "succeeded", acceptedAt: 1, usage: emptyUsage(), audit: emptyAudit(),
    evaluation: { session_overview: ["用户问题。", "实际工具调用。", "摘要观察进入归因。"], session_meta: {},
      trace_meta: Array.from({ length: turns }, () => ({})),
      turns: Array.from({ length: turns }, (_, turn_idx) => ({ turn_idx, plans: [], reasoning_chain: [], execution_chain: [],
        reflections: [], tool_errors: [], final_answer: "原始回复。", components: [], key_data: [], artifacts: [] })) } };
}
export function sourceCompactReceipt(candidate: Candidate, session: RawInput): SubmissionReceipt {
  const receipt = compactReceipt(candidate.turns?.length ?? 1), source = attributionSessionSource(session);
  const recorded = processComponents(source.raw, source.original, candidate.input_id, source.positions);
  for (const [index, turn] of (receipt.evaluation as { turns: Record<string, unknown>[] }).turns.entries()) {
    const final = source.positions.findIndex(point => point.trace_index === index && point.message_index === (candidate.turns?.[index]?.final_index ?? candidate.final_index));
    const rows = recorded.filter(actor => actor.positions.some(position => position.trace_index === index)).map((actor, ordinal) => ({
      components_idx: ordinal + 1, components_kind: actor.kind,
      components_name: actor.anonymous || isComponentLocator(actor.name)
        ? actor.positions.some(position => position.source_message_index === final || contentText(source.raw.messages[position.source_message_index]?.output) === contentText(source.raw.messages[final]?.content))
          ? "答案合成" : "规划" : actor.name,
      components_content: "为完成本轮请求执行所记录的动作；实际输出保留在原文中。",
      evidence: actor.source_evidence.filter(proof => source.positions[proof.message_index as number]!.trace_index === index)
        .map(proof => ({ evidence_id: (proof.reference as { evidence_id: string }).evidence_id, quote: proof.quote })),
    }));
    const grouped = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      const key = row.components_kind + ":" + row.components_name, previous = grouped.get(key);
      if (previous) previous.evidence = [...new Map([...previous.evidence, ...row.evidence].map(item => [item.evidence_id, item])).values()];
      else grouped.set(key, row);
    }
    turn.components = [...grouped.values()].map((row, index) => ({ ...row, components_idx: index + 1 }));
  }
  return receipt;
}
export function componentDraft<P>(problems: P[] = [], actor_index = 1) {
  return { content: "已核对该组的调用、原始回执及交付影响。", evidence: [] as number[],
    tool_error_reviews: [] as { tool_error_idx: number; status: string; content: string; evidence: number[] }[],
    problems: problems.map(problem => ({ actor_index, ...problem, tool_error_indices: [] as number[] })) };
}
/** The investigation group task whose program-formed members include the named component. */
export function componentTask(candidate: Candidate, receipt: SubmissionReceipt, inputs: Record<string, unknown>, name: string, traceIndex = 0): PlannedTask {
  const plan = planAttributionUnit(candidate), compact = plan.tasks.find(task => task.stage === "attribution-compact")!;
  // Probe on a cloned record: material caches are keyed by the record and must not see dependency-free bindings.
  const probe = { [candidate.input_id]: structuredClone(inputs[candidate.input_id]) };
  const followups = attributionWorkflow.advance!(compact, receipt, { manifest: { tasks: plan.tasks }, receipts: {} } as never, probe)!;
  const task = followups.tasks.find(task => (task.data as AttributionTaskData).traceIndex === traceIndex &&
    memberIndex(bindAttribution(task, probe, { compact: receipt }).request.input.components as JsonObject[], name) !== undefined);
  if (!task) throw new Error(`Missing fixture component: ${name}`);
  return task;
}
export function memberIndex(members: JsonObject[], name: string): number | undefined {
  return members.find(member => member.name === name)?.component_index as number | undefined;
}
export function bindComponentFixture(candidate: Candidate, raw: RawInput, dependencies: Record<string, SubmissionReceipt> = {}) {
  const compact = sourceCompactReceipt(candidate, normalizeInput(raw)), inputs = { [candidate.input_id]: raw };
  return bindAttribution(componentTask(candidate, compact, inputs, "答案合成·取值"), inputs, { compact, ...dependencies });
}
export function bindAttributionFixture(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined> = {}, options = {}) {
  if (task.stage === "attribution-compact") {
    const receipt = compactReceipt((task.data as AttributionTaskData).candidate.turns?.length ?? 1);
    dependencies = { ...Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => {
      const [index, field] = label.includes(":") ? label.split(":") : [undefined, label];
      return [label, { ...receipt, taskId: id, evaluation: compactFieldResult(receipt.evaluation as Record<string, unknown>, field!, index === undefined ? undefined : Number(index)) }];
    })), ...dependencies };
  }
  const candidate = (task.data as AttributionTaskData).candidate;
  return bindAttribution(task, inputs, { compact: sourceCompactReceipt(candidate, normalizeInput(inputs[candidate.input_id])), ...dependencies }, options);
}
