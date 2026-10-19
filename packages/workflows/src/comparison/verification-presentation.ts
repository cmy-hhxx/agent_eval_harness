import { comparisonSlotChoices } from "@eval/agents/comparison";
import type { AgentRequest, TaskAnalysis } from "@eval/contracts";
import { cite, displayEvidence, evidenceSources, hasSourceTextBlock, images, messageContentSources, instructionSources, originalUserTimestamp, parseEvidenceCoordinates, visualCaptureMarkers } from "@eval/tools";
import type { AttributionResult } from "@eval/agents/attribution";
import { verificationCheckAspects } from "@eval/agents/comparison";
import type { ComparisonResult, RawInput } from "./types.js";
import { contentText } from "./input.js";
import { attributionPresentation } from "./attribution-presentation.js";

/** Convert only valid native calendar instants with an explicit offset; Date's invalid-day rollover is not evidence. */
function timestampUTC(timestamp: string | null): string | null {
  const fields = timestamp?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u);
  if (!fields) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = fields;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(hourText) > 23 ||
    Number(minuteText) > 59 || Number(secondText ?? 0) > 59 || (offset !== "Z" &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) return null;
  const instant = new Date(timestamp!);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function criterionPresentation(criterion: TaskAnalysis["requirements"][number]) {
  const { acceptance_rule, ...original } = structuredClone(criterion);
  return acceptance_rule === criterion.text ? original : { ...original, acceptance_rule };
}

function criterionMeaning(criterion: TaskAnalysis["requirements"][number]) {
  const { id: _id, applies_to: _scope, ...meaning } = criterionPresentation(criterion);
  return meaning;
}

/** Ordered sections keep primary materials ahead of the upstream verdict even under canonical JSON serialization. */
export function verificationPresentation(input: Record<string, unknown>, sources: NonNullable<AgentRequest["sources"]>,
  analysis: TaskAnalysis) {
  const materials = input.candidates as Record<string, { question: string; final_message_index: number;
    catalog: unknown; citation_inventory: unknown; answer_generation: unknown;
    original_answer_timing: { finish_seconds: number | null };
    original_answer_usage: { total_tokens: number | null; issues: string[] };
    criterion_instruction_sources?: Record<string, { evidence_id: string; message_index: number; path: string; quote: string }[]> }>;
  const attributions = input.attributions as Record<string, AttributionResult>;
  const rawSources = Object.fromEntries(Object.entries(sources).map(([label, source]) => [label, source.value as RawInput]));
  const sourceIds = Object.fromEntries(Object.entries(sources).map(([label, source]) => [label, source.id]));
  const common = (criterion: TaskAnalysis["requirements"][number]) => !criterion.applies_to.length ||
    Object.values(sources).every(source => criterion.applies_to.includes(source.id));
  const sourceReference = (label: string, entry: { evidence_id: string; message_index: number; path: string; quote: string }) => {
    const raw = rawSources[label];
    const leaf = evidenceSources(raw.messages[entry.message_index]).find(source => source.kind === "text" && source.path === entry.path);
    if (!leaf) throw new Error("复核规范原文不可定位：" + label);
    const location = parseEvidenceCoordinates(entry.evidence_id);
    if (!location || location.kind !== "text" || location.input_id !== sourceIds[label] ||
      location.message_index !== entry.message_index || location.path !== entry.path ||
      location.end > leaf.text.length || leaf.text.slice(location.start, location.end) !== entry.quote)
      throw new Error("复核规范完整坐标与原文不一致：" + label);
    const start = location.start, end = location.end;
    const full = cite(sourceIds[label], entry.message_index, leaf, start, end);
    return { ...displayEvidence(full.quote.length <= 200 ? full : {
      ...full, quote: undefined, quote_preview: full.quote.slice(0, 200), has_more: true,
    }), read_request: { candidate: label, message_index: entry.message_index, path: leaf.path,
      offset: start, max_chars: Math.min(16000, end - start) }, end_offset: end };
  };
  const candidates = Object.fromEntries(Object.entries(materials).map(([label, material]) => {
    const raw = rawSources[label], timestamp = originalUserTimestamp(raw);
    const imageCount = images(raw.messages[material.final_message_index]).length;
    const captureGaps = visualCaptureMarkers(raw.messages[material.final_message_index]).map(({ path, status, resource_ref }) => ({
      message_index: material.final_message_index, path, status, resource_ref, user_visible_rendering: "unknown",
    }));
    // No offset, unavailable precision or malformed native dates remain unknown; originals stay unchanged.
    return [label, { question: material.question, original_user_timestamp: timestamp,
      original_user_timestamp_utc: timestampUTC(timestamp),
      question_evidence: (material.criterion_instruction_sources ?? {})[analysis.requirements.find(criterion =>
        common(criterion) && hasSourceTextBlock(criterion.acceptance_rule, material.question))?.id ?? ""]?.map(entry => sourceReference(label, entry)) ?? [],
      final_message_index: material.final_message_index, final_answer: contentText(raw.messages[material.final_message_index].content),
      ...(captureGaps.length ? { capture_gaps: captureGaps } : {}),
      ...(imageCount ? { final_images: { image_count: imageCount,
        view_request: { candidate: label, message_index: material.final_message_index } } } : {}),
      final_evidence: messageContentSources(raw.messages[material.final_message_index])
        .map(source => { const full = cite(sourceIds[label], material.final_message_index, source, 0, source.text.length);
          return displayEvidence(source.text.length <= 200 ? full : { ...full, quote: undefined,
            quote_preview: source.text.slice(0, 200), has_more: true }); }),
      answer_generation: material.answer_generation,
      original_answer_timing: structuredClone(material.original_answer_timing),
      original_answer_usage: structuredClone(material.original_answer_usage),
      deferred_final_material: [] }];
  }));
  const requirementCatalog = Object.fromEntries(Object.entries(materials).map(([label, material]) => [label,
    (["requirements", "scoring_points", "red_flags"] as const).flatMap(kind => analysis[kind].flatMap((criterion, criterion_index) => {
      if (criterion.applies_to.length && !criterion.applies_to.includes(sourceIds[label])) return [];
      return [{ criterion_id: criterion.id, kind, criterion_index,
        ...(kind === "requirements" ? { requirement_index: criterion_index } : {}),
        scope: common(criterion) ? "common" : "source_only",
        evidence: (material.criterion_instruction_sources?.[criterion.id] ?? []).map(entry => sourceReference(label, entry)) }];
    }))]));
  const findingCatalog = Object.fromEntries(Object.entries(attributions).map(([label, result]) => {
    const shown = attributionPresentation(result, label, rawSources[label], sourceIds[label], rawSources, sourceIds);
    return [label, shown.findings.map((finding, finding_index) => {
      const index = finding.assessment.requirement_index;
      const criterionId = index !== null ? result.task_analysis.requirements[index]?.id : undefined;
      const globalIndex = criterionId ? analysis.requirements.findIndex(criterion => criterion.id === criterionId) : -1;
      return { ...finding, finding_index, assessment: { ...finding.assessment,
        requirement_index: globalIndex >= 0 ? globalIndex : null, source_requirement_index: index, criterion_id: criterionId ?? null } };
    })];
  }));
  const { task_analysis: _analysis, ranking, ...draft } = structuredClone(input.comparison_draft as ComparisonResult);
  return { sections: [
    { kind: "original_materials", materials: [
      { kind: "task" as const, question: Object.values(materials)[0].question, ground_truth: input.ground_truth,
        task: { task_type: analysis.task_type, goal: analysis.goal,
          requirements: analysis.requirements.flatMap((criterion, requirement_index) => common(criterion) ? [{ ...criterionPresentation(criterion), requirement_index }] : []),
          scoring_points: analysis.scoring_points.filter(common), red_flags: analysis.red_flags.filter(common) } },
      ...Object.entries(candidates).map(([candidate, material]) => ({ kind: "answer" as const, candidate, ...material })),
    ] as const },
    { kind: "source_directory", candidate_sources: Object.fromEntries(Object.entries(materials).map(([label, material]) =>
      [label, { catalog: material.catalog, citation_inventory: material.citation_inventory,
        instruction_sources: instructionSources(rawSources[label], sourceIds[label], material.final_message_index).map(source => ({
          message_index: source.message_index, path: source.path, role: source.role,
          evidence: source.evidence.map(evidence => {
            const coordinates = parseEvidenceCoordinates(evidence.evidence_id)!;
            if (coordinates.kind !== "text") throw new Error("规范来源必须为真实文本");
            return sourceReference(label, { evidence_id: evidence.evidence_id, message_index: source.message_index, path: coordinates.path, quote: evidence.quote });
          }),
        })) }])),
      requirement_catalog: requirementCatalog, findings: findingCatalog,
      source_review: input.source_review,
      comparison_slots: comparisonSlotChoices({ input, sources }) },
    { kind: "proposed_comparison", comparison_draft: { ...draft,
      ranking_tiers: ranking.map((labels, index) => ({ tier: index + 1, candidates: labels, relation: "same_tier" })) },
      source_assessments: Object.fromEntries(Object.entries(attributions).map(([label, result]) => [label, {
        summary: result.summary, core_assessment: result.core_assessment,
        criterion_assessments: result.criterion_assessments.map(({ evidence: _evidence, ...assessment }) => assessment),
      }])) },
  ] as const };
}

/** Independent initial material: no findings, assessments, review reasons, draft or ranking. */
export function verificationInspectionPresentation(presentation: ReturnType<typeof verificationPresentation>, analysis: TaskAnalysis) {
  const [original, directory] = presentation.sections;
  if (!original.materials || !directory.candidate_sources || !directory.requirement_catalog)
    throw new Error("Invalid ordered verification material");
  const answers = original.materials.filter(material => material.kind === "answer");
  const verificationCheckSlots = answers.flatMap(answer => directory.requirement_catalog![answer.candidate]
    .filter(entry => entry.kind === "requirements").flatMap(entry => verificationCheckAspects.map(aspect => ({ candidate: answer.candidate,
      aspect,
      requirement_index: entry.requirement_index!, criterion: criterionMeaning(analysis.requirements[entry.criterion_index]),
      evidence: structuredClone(entry.evidence) }))));
  return { sections: [structuredClone(original), { kind: "source_directory", verification_check_slots: verificationCheckSlots,
    candidate_sources: structuredClone(directory.candidate_sources),
    requirement_catalog: Object.fromEntries(Object.entries(directory.requirement_catalog).map(([candidate, entries]) =>
      [candidate, entries.map(entry => ({ ...structuredClone(entry),
        criterion: criterionPresentation(analysis[entry.kind][entry.criterion_index]) }))])),
  }] as const };
}
