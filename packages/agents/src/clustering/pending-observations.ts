import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type ProblemLibrary, type ProblemObservationRef } from "@eval/contracts";
import schema from "../../../../schemas/clustering/pending-observations.schema.json" with { type: "json" };
import { problemSampleKey } from "./library.js";

const validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** Replace per-model pending references without creating or changing formal classes. */
export function replacePendingObservations(
  library: ProblemLibrary,
  pending: ProblemObservationRef[],
  options: { at: string; run: string },
): ProblemLibrary {
  const request = { ...options, pending };
  if (!validator(request)) throw new ValidationError(schemaIssues(validator.errors, request));
  if (!Number.isFinite(Date.parse(options.at))) throw new Error("待观察引用更新时间无效");
  const problems = new Set<string>();
  for (const ref of pending) {
    if (ref.version !== library.model) throw new Error("待观察来源与问题库模型不一致：" + ref.version);
    const coordinate = problemSampleKey(ref);
    if (problems.has(coordinate)) throw new Error("待观察问题引用重复：" + coordinate);
    problems.add(coordinate);
  }
  return { ...library, updated_at: options.at,
    pending_observations: structuredClone(pending),
    events: [...library.events, { id: randomUUID(), type: "pending_observations_replaced", at: options.at,
      detail: { pending: pending.length, sourceRun: options.run } }],
  };
}
