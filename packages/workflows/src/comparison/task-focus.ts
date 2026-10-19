import type { TaskAnalysis } from "@eval/contracts";
import type { RawInput } from "./types.js";

interface FocusMaterial {
  question: string;
  final_message_index: number;
  final_answer: string;
  deferred_final_material: unknown[];
}

/** Only applicable original rules are shown; indices still address the full trusted arrays. */
export function taskAnalysisPresentation(analysis: TaskAnalysis, candidates: Record<string, string>,
  deferredSources: Record<string, { quote: string }[]> = {}) {
  const present = (criterion: TaskAnalysis["requirements"][number]) => {
    const applicable_candidates = Object.entries(candidates).flatMap(([label,id]) =>
      !criterion.applies_to.length || criterion.applies_to.includes(id) ? [label] : []);
    const { applies_to: _ids, acceptance_rule: original, ...rule } = criterion;
    let acceptance_rule = original;
    for (const [index, source] of (deferredSources[criterion.id] ?? []).entries())
      if (source.quote.length > 1000) acceptance_rule = acceptance_rule.replaceAll(source.quote,
        `⟦answer.criterion_instruction_sources.${criterion.id}[${index}]⟧`);
    return { ...rule, ...(acceptance_rule === criterion.text ? {} : { acceptance_rule }), applicable_candidates };
  };
  const visible = (criterion: TaskAnalysis["requirements"][number]) =>
    !criterion.applies_to.length || Object.values(candidates).some(id => criterion.applies_to.includes(id));
  return { task_type: analysis.task_type, goal: analysis.goal,
    requirements: analysis.requirements.flatMap((criterion, requirement_index) => visible(criterion) ? [{ ...present(criterion), requirement_index }] : []),
    scoring_points: analysis.scoring_points.filter(visible).map(present),
    red_flags: analysis.red_flags.filter(visible).map(present) };
}

/** Repeat complete, bounded task facts before the full view; never summarize source text. */
export function taskFocus(
  materials: Record<string, FocusMaterial>,
  groundTruth: { available: boolean; value: unknown },
  originals: Record<string, RawInput>,
) {
  return {
    question: Object.values(materials)[0]!.question,
    ground_truth: groundTruth,
    answers: Object.fromEntries(Object.entries(materials).map(([label, material]) => {
      const lastUser = originals[label]!.messages.findLast(message => message.role === "user" || message.role === undefined && message.type === "user_question");
      return [label, {
        question_timestamp: typeof lastUser?.timestamp === "string" ? lastUser.timestamp : null,
        final_message_index: material.final_message_index,
        ...(material.final_answer.length <= 16000 ? { final_answer: material.final_answer } : {}),
        deferred_final_material: material.deferred_final_material,
      }];
    })),
  };
}
