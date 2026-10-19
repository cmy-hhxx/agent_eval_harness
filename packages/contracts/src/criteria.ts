/** One source-derived criterion; complete source paragraphs preserve conditions and exceptions. An empty scope applies to every candidate. */
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

/** Only the task, user context and candidate-specific instructions define delivery requirements. */
export interface CriteriaInput {
  question: string;
  candidates: {
    candidate_id: string;
    instructions: { message_index: number; role: "system" | "developer" | "tool"; content: unknown }[];
    context: { message_index: number; role: "user"; content: unknown }[];
  }[];
}
