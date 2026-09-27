import type { AttributionResult } from "@eval/agents/attribution";
import type { Candidate, RawInput } from "./types.js";

// A comparison receives a view of its dependencies, never their identity-bearing source.
// Top-level message provenance is removed; known identity strings are masked in both
// the trace and findings so that the comparison can check quotes against its trace.
const provenance = new Set([
  "model", "model_id", "model_name", "model_parameters", "version", "version_id",
  "provider", "trace_id", "input_messages", "source", "source_file",
]);

export function blindMaterials(candidates: Record<string, Candidate>) {
  const identities = [...new Set(Object.values(candidates).flatMap((candidate) => [
    candidate.version, candidate.name, candidate.llm,
  ]).filter((value): value is string => !!value && (
    value.length >= 3 || (value.length === 2 && /\p{L}/u.test(value) && /\p{N}/u.test(value))
  )))]
    .sort((a, b) => b.length - a.length);
  const replacements = new Map(identities.map((name, index) => [name, `[身份已隐去${index + 1}]`]));
  const matcher = identities.length
    ? new RegExp(identities.map((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return name.length < 3 ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
    }).join("|"), "gu")
    : null;
  const redact = (value: string) => matcher ? value.replace(matcher, (name) => replacements.get(name)!) : value;
  const scrub = (value: unknown): unknown => {
    // Image data is opaque binary, not model-visible text. Changing its bytes breaks view_image.
    if (typeof value === "string") return value.startsWith("data:image/") ? value : redact(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), scrub(item)]));
  };
  return {
    value<T>(value: T): T {
      return scrub(value) as T;
    },
    trace(raw: RawInput): RawInput {
      return {
        messages: raw.messages.map((message) => scrub(Object.fromEntries(
          Object.entries(message).filter(([key]) => !provenance.has(key)),
        )) as RawInput["messages"][number]),
      };
    },
    attribution(result: AttributionResult): AttributionResult {
      return scrub(result) as AttributionResult;
    },
  };
}
