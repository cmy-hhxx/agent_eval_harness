import { canonical, type CriteriaInput } from "@eval/contracts";

/** Source IDs address this request's source catalogue, never generated requirements. */
export interface CriterionSource {
  id: string;
  kind: "question" | "reference" | "instruction" | "context";
  text: string;
  applies_to: string[];
  paths: string[];
  role?: "system" | "developer" | "user";
}

function sourceText(value: unknown): string {
  return typeof value === "string" ? value : canonical(value);
}

/** Keep complete paragraphs: a model cannot select a substring that drops a condition or negation. */
export function criteriaSources(input: CriteriaInput): CriterionSource[] {
  const sources: CriterionSource[] = [{ id: "question", kind: "question", text: input.question, applies_to: [], paths: ["/question"] }];
  if (input.ground_truth.available) sources.push({
    id: "reference", kind: "reference", text: sourceText(input.ground_truth.value), applies_to: [], paths: ["/ground_truth/value"],
  });
  input.candidates.forEach((candidate, candidateIndex) => {
    for (const field of ["instructions", "context"] as const) candidate[field].forEach((message, messageIndex) => {
      const text = sourceText(message.content);
      const paragraphs = text.split(/\n[\t ]*\n+/u).map((paragraph) => paragraph.trim()).filter(Boolean);
      paragraphs.forEach((paragraph, paragraphIndex) => {
        const kind = field === "instructions" ? "instruction" : "context";
        const path = `/candidates/${candidateIndex}/${field}/${messageIndex}/content#paragraph=${paragraphIndex}`;
        const same = sources.find((source) => source.kind === kind && source.role === message.role && source.text === paragraph);
        if (same) {
          if (!same.applies_to.includes(candidate.candidate_id)) same.applies_to.push(candidate.candidate_id);
          same.paths.push(path);
        } else sources.push({ id: `source${sources.length + 1}`, kind, role: message.role, text: paragraph,
          applies_to: [candidate.candidate_id], paths: [path] });
      });
    });
  });
  for (const source of sources) if (source.applies_to.length === input.candidates.length) source.applies_to = [];
  return sources;
}
