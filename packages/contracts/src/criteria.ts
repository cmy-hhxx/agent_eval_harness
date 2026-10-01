/** One independently checkable task criterion. An empty scope applies to every candidate. */
export interface TaskCriterion {
  id: string;
  text: string;
  applies_to: string[];
  acceptance_rule: string;
}

/** Shared task requirements fixed before assessing any candidate's answer. */
export interface TaskAnalysis {
  task_type: string;
  goal: string;
  requirements: TaskCriterion[];
  scoring_points: TaskCriterion[];
  red_flags: TaskCriterion[];
}

/** Only the task, reference and candidate-specific instructions are supplied to criteria preparation. */
export interface CriteriaInput {
  question: string;
  ground_truth: { available: boolean; value: unknown };
  candidates: {
    candidate_id: string;
    instructions: { message_index: number; role: "system" | "developer"; content: unknown }[];
    context: { message_index: number; role: "user"; content: unknown }[];
  }[];
}
