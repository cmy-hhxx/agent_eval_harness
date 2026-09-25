import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import { validateTraceEvidence } from "@eval/tools";
import type { CorrectnessResult } from "./types.js";
import schema from "./profiles/correctness/resolved.schema.json" with { type: "json" };
interface Input {
  ground_truth: { available: boolean; value: unknown };
  candidates: Record<
    string,
    {
      final_message_index: number;
      original_answer_timing: { finish_seconds: number | null };
    }
  >;
  correctness?: Record<string, { is_correct: boolean | null; correctness_reason?: string }>;
}

const validator = new Ajv2020({
  allErrors: true,
  strict: false,
}).compile<unknown>(schema);
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as Input;
  const repairErrors: ValidationIssue[] = [];

  for (const [label, candidate] of Object.entries(input.candidates)) {
    const raw = request.sources[label].value as {
      messages: Record<string, unknown>[];
    };
    const evidence = (result as CorrectnessResult).evidence.map((item, i) => ({
      item,
      location: `evidence[${i}]`,
    }));
    repairErrors.push(...validateTraceEvidence(raw, evidence, label, audit, candidate.final_message_index));
  }
  if (repairErrors.length) throw new ValidationError(repairErrors);
}
