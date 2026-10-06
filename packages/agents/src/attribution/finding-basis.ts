import type { JsonObject } from "@eval/contracts";

export interface FindingBasis {
  basis_index: number;
  kind: "requirement" | "own_rule";
  text: string;
  requirement_index: number | null;
  norm_index: number | null;
  roles: string[];
  evidence: unknown[];
}

/** One fixed selector covers task requirements and genuine own instructions. */
export function attributionFindingBasis(input: JsonObject): FindingBasis[] {
  const analysis = input.task_analysis as { requirements: {
    text: string; requirement_index?: number; applies_to?: string[];
  }[] };
  const norms = (input.answer as { norm_directory: {
    norm_index: number; requirement_index: number | null; roles: string[]; evidence: unknown[];
  }[] }).norm_directory;
  const requirements = analysis.requirements.flatMap((item, position) =>
    item.applies_to?.length && !item.applies_to.includes(String(input.candidate_id)) ? [] : [{
      item, index: item.requirement_index ?? position,
    }]);
  const boundary = Math.max(0, ...requirements.map(({ index }) => index + 1));
  return [
    ...requirements.map(({ item, index }): FindingBasis => {
      const norm = norms.find(entry => entry.requirement_index === index);
      return { basis_index: index + 1, kind: "requirement", text: item.text,
        requirement_index: index, norm_index: norm?.norm_index ?? null,
        roles: norm?.roles ?? [], evidence: norm?.evidence ?? [] };
    }),
    ...norms.filter(norm => norm.requirement_index === null).map((norm): FindingBasis => ({
      basis_index: boundary + norm.norm_index + 1, kind: "own_rule",
      text: norm.evidence.map(item => {
        const source = item as { quote?: string; quote_preview?: string };
        return source.quote ?? source.quote_preview ?? "";
      }).join("\n").slice(0, 160),
      requirement_index: null, norm_index: norm.norm_index, roles: norm.roles, evidence: norm.evidence,
    })),
  ];
}
