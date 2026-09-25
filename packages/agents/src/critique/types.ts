export interface CorrectnessResult {
  is_correct: boolean | null;
  correctness_reason: string;
  evidence: { message_index: number; quote: string }[];
}
