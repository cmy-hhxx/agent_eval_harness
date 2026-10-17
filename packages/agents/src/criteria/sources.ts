import { canonical, type CriteriaInput } from "@eval/contracts";
import { criteriaText } from "@eval/prompts";
import { sourceTextBlocks } from "@eval/tools";

/** Positive indices select entries in this request's fixed source catalogue. */
export interface CriterionSource {
  source_index: number;
  kind: "question" | "reference" | "instruction" | "context" | "quality";
  text: string;
  applies_to: string[];
  paths: string[];
  role?: "system" | "developer" | "user";
}

function sourceText(value: unknown, messageContent = false): string {
  if (typeof value === "string") return value;
  if (messageContent) {
    const textParts = (part: unknown): string[] => {
      if (typeof part === "string") return [part];
      if (Array.isArray(part)) return part.flatMap(textParts);
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return [part.text];
      return [];
    };
    const parts = textParts(value);
    if (parts.length) return parts.join("\n");
  }
  return canonical(value);
}

/** Keep complete original blocks: Markdown headings retain their governing prose and exceptions. */
export function criteriaSources(input: CriteriaInput): CriterionSource[] {
  const sources: CriterionSource[] = [{ source_index: 1, kind: "question", text: input.question, applies_to: [], paths: ["/question"] }];
  if (input.ground_truth.available) sources.push({
    source_index: sources.length + 1, kind: "reference", text: sourceText(input.ground_truth.value), applies_to: [], paths: ["/ground_truth/value"],
  });
  input.candidates.forEach((candidate, candidateIndex) => {
    for (const field of ["instructions", "context"] as const) candidate[field].forEach((message, messageIndex) => {
      const text = sourceText(message.content, true);
      const paragraphs = sourceTextBlocks(text).map(block => block.quote);
      paragraphs.forEach((paragraph, paragraphIndex) => {
        const kind = field === "instructions" ? "instruction" : "context";
        const path = `/candidates/${candidateIndex}/${field}/${messageIndex}/content#block=${paragraphIndex}`;
        const same = sources.find((source) => source.kind === kind && source.role === message.role && source.text === paragraph);
        if (same) {
          if (!same.applies_to.includes(candidate.candidate_id)) same.applies_to.push(candidate.candidate_id);
          same.paths.push(path);
        } else sources.push({ source_index: sources.length + 1, kind, role: message.role, text: paragraph,
          applies_to: [candidate.candidate_id], paths: [path] });
      });
    });
  });
  for (const source of sources) if (source.applies_to.length === input.candidates.length) source.applies_to = [];
  sources.push({ source_index: sources.length + 1, kind: "quality", text: criteriaText("model_quality"), applies_to: [], paths: [] });
  return sources;
}

/** Shared task, model quality and any reference must all have common checks. */
export function requiredCriterionSource(source: CriterionSource): boolean {
  return source.kind === "question" || source.kind === "quality" || source.kind === "reference";
}

/** Automatic context wrappers are material, not additional delivery requirements. */
export function eligibleCriterionSource(source: CriterionSource): boolean {
  return !(source.kind === "context" && /^(?:# 上下文[（(]内部信息|# 本轮提供的附件和 URL 内容|---用户提问结束---|NER 抽取结果|下文为系统自动生成的元数据)/u.test(source.text.trimStart()));
}
