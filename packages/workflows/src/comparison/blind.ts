import { presentSource, type SourcePresentation } from "@eval/contracts";
import type { Candidate, RawInput } from "../inputs/types.js";

// A comparison receives a view of its dependencies, never their identity-bearing source.
// Top-level message provenance is removed; known identity strings are masked in both
// the trace and findings so that the comparison can check quotes against its trace.
const provenance = new Set([
  "model", "model_id", "model_name", "model_parameters", "version", "version_id",
  "provider", "trace_id", "source", "source_file",
]);

export function blindMaterials(candidates: Record<string, Candidate>) {
  const identities = [...new Set(Object.values(candidates).flatMap((candidate) => [
    candidate.version, candidate.name, candidate.llm, ...(candidate.identity_names ?? []),
  ]).filter((value): value is string => !!value && (
    value.length >= 3 || (value.length === 2 && /\p{L}/u.test(value) && /\p{N}/u.test(value))
  )))]
    .sort((a, b) => b.length - a.length);
  const presentation: SourcePresentation = { redactions: identities.map((text, index) => ({ text, replacement: `[身份已隐去${index + 1}]` })), omitMessageKeys: [...provenance] };
  const scrub = <T>(value: T) => presentSource(value, { ...presentation, omitMessageKeys: [] });
  return {
    value<T>(value: T): T {
      return scrub(value) as T;
    },
    presentation,
    trace(raw: RawInput): RawInput {
      return presentSource(raw, presentation);
    },
  };
}
