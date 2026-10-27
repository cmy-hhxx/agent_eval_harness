import { randomUUID } from "node:crypto";
import type { PlannedTask, RunState } from "@eval/contracts";
import type { Candidate } from "../inputs/types.js";

export function instructionReviewFollowup(task: PlannedTask, state: RunState): PlannedTask[] {
  if (task.stage !== "attribution-session" || state.manifest.tasks.some(item => item.stage === "instruction-review" && item.dependencies.source === task.id)) return [];
  const parent = task.data as { candidate: Candidate; candidates: Record<string, Candidate> };
  const inputId = parent.candidate.input_id;
  if (!inputId) throw new Error("归因后置检查缺少本方原始输入身份。");
  const candidate = Object.values(parent.candidates).find(item => item.input_id === inputId);
  if (!candidate) throw new Error("归因后置检查缺少本方候选坐标。");
  return [{ id: randomUUID(), stage: "instruction-review", inputIds: { case: inputId }, dependencies: { source: task.id },
    data: { stage: "instruction-review", candidates: { A: candidate }, reference: null } }];
}
