import { finalIndices } from "./final-indices.js";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, resolveEvidenceSelections, evidenceSelectionSchema, ValidationError, type AgentRequest, type EvidenceReference, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import inspectionSchema from "../../../../schemas/comparison/inspection.schema.json" with { type: "json" };
import schema from "../../../../schemas/comparison/verification-submission.schema.json" with { type: "json" };
import { answerTurnContexts, evidenceCovers, evidenceId, evidenceSources, images, hasSourceTextBlock, normativeSources, parseEvidenceCoordinates, resolveEvidence, selectEvidenceSource, sourceContentBlocks } from "@eval/tools";
import { criterionAppliesToPair, findingCriterion } from "./pair-scope.js";
import type { ComparisonResult, ComparisonVerificationInput, ComparisonVerificationSubmission, ComparisonMaterialInspection, Finding } from "./types.js";
import { pendingComparison } from "./resolve.js";
import { comparisonSlots, resolveSourceReviews } from "./slots.js";
import { comparisonFinalImageIssues, comparisonDeferredFinalIssues, validateEvaluation } from "./validate.js";
import { actualAnswerEvidenceShares } from "./proof-matching.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validator = ajv.compile(schema), inspectionValidator = ajv.compile(inspectionSchema);
export { inspectionSchema };

/** Stable source order and global requirement order bind each submitted check by position. */
function verificationCheckSlots(request: Pick<AgentRequest, "input">) {
  const input = request.input as unknown as ComparisonVerificationInput;
  return Object.entries(input.candidates).flatMap(([candidate, material]) => input.task_analysis.requirements.flatMap((criterion, requirement_index) =>
    !criterion.applies_to.length || criterion.applies_to.includes(material.candidate_id)
      ? [{ candidate, requirement_index, criterion_id: criterion.id }] : []));
}

/** Each original rule is inspected for its deliverable and its governing constraints. */
export const verificationCheckAspects = ["delivery", "constraints"] as const;

/** Only discoveries from this task's accepted blind inspection participate in matching. */
function verificationConcerns(audit: Pick<ToolAudit, "inspection">): ComparisonMaterialInspection["concerns"] {
  return (audit.inspection?.value as unknown as ComparisonMaterialInspection | undefined)?.concerns ?? [];
}

/** Fixed checks bind the inspected actual scope; only specific concerns select answer counterevidence. */
const rawInspectionSchema = structuredClone(inspectionSchema);
const rawCheck = rawInspectionSchema.properties.checks.items;
rawCheck.required = rawCheck.required.filter(key => key !== "candidate" && key !== "criterion_id" && key !== "answer_evidence");
delete (rawCheck.properties as Record<string, unknown>).candidate;
delete (rawCheck.properties as Record<string, unknown>).criterion_id;
delete (rawCheck.properties as Record<string, unknown>).answer_evidence;
const rawConcern = rawInspectionSchema.properties.concerns.items;
rawConcern.required = rawConcern.required.map(key => key === "criterion_ids" ? "requirement_indices" : key);
delete (rawConcern.properties as Record<string, unknown>).criterion_ids;
(rawConcern.properties as Record<string, unknown>).requirement_indices = { type: "array", uniqueItems: true,
  items: { type: "integer", minimum: 0 } };
export const modelInspectionSchema = evidenceSelectionSchema(rawInspectionSchema);

export function resolveMaterialInspection(request: AgentRequest, draft: unknown, audit: ToolAudit): ComparisonMaterialInspection {
  const selected = resolveEvidenceSelections(draft, audit.evidenceBank ?? []) as {
    checks: Omit<ComparisonMaterialInspection["checks"][number], "candidate" | "criterion_id" | "answer_evidence">[];
    concerns: (Omit<ComparisonMaterialInspection["concerns"][number], "criterion_ids"> & { requirement_indices: number[] })[];
  };
  const input = request.input as unknown as ComparisonVerificationInput, slots = verificationCheckSlots(request), issues: ValidationIssue[] = [];
  const width = verificationCheckAspects.length;
  if (selected.checks.length !== slots.length * width) issues.push({ category: "decision", code: "verification_check_coverage", path: "/checks",
    message: "核对数组须按 verification_check_slots 顺序完整覆盖每条适用要求的 delivery 和 constraints 两个固定槽。",
    actual: { expected: slots.length * width, actual: selected.checks.length } });
  for (const [index, check] of selected.checks.entries()) {
    const slot = slots[Math.floor(index / width)];
    if (!slot) continue;
    // Validate every submitted source before selecting the decisive subchecks.
    issues.push(...sourceEvidenceIssues(request, check.source_evidence, audit, `/checks/${index}/source_evidence`));
  }
  const unique = <T>(values: T[]): T[] => values.filter((item, index) => !values.slice(0, index).some(previous => isDeepStrictEqual(previous, item)));
  const value: ComparisonMaterialInspection = { checks: slots.flatMap((slot, index) => {
    const parts = selected.checks.slice(index * width, (index + 1) * width);
    if (!parts.length) return [];
    const result = (["contradicted", "unverified", "supported", "not_applicable"] as const).find(result => parts.some(part => part.result === result))!;
    const decisive = parts.filter(part => part.result === result);
    return [{ candidate: slot.candidate, criterion_id: slot.criterion_id, result,
      answer_evidence: unique(parts.flatMap(part => actualAnswerScope(request, slot.candidate, part.observation))),
      source_evidence: unique(decisive.flatMap(part => part.source_evidence)),
      observation: [...new Set(parts.map(part => part.observation))].join("\n\n") }];
  }),
    concerns: selected.concerns.map(({ requirement_indices, ...concern }, index) => ({ ...concern,
      criterion_ids: requirement_indices.map((requirementIndex, selectionIndex) => {
        const criterion = input.task_analysis.requirements[requirementIndex], material = input.candidates[concern.candidate];
        if (!criterion || !material || criterion.applies_to.length && !criterion.applies_to.includes(material.candidate_id)) {
          issues.push({ category: "decision", code: "inspection_concern_scope", path: `/concerns/${index}/requirement_indices/${selectionIndex}`,
            message: "发现只选择本方适用的全局 requirements 索引，不能借用他方私规或新增标准。", actual: requirementIndex });
        }
        return criterion?.id ?? "unbound";
      }) })),
  };
  for (const [index, concern] of value.concerns.entries()) if (!concern.criterion_ids.length) {
    const { blocks } = privateNormAnchors(request, concern, audit, `/concerns/${index}/source_evidence`);
    for (const reference of blocks.flat()) if (!concern.source_evidence.some(item => item.evidence_id === reference.evidence_id))
      concern.source_evidence.push(reference);
  }
  try { validateMaterialInspection(request, value, audit); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    issues.push(...error.issues!.filter(issue => issue.code !== "inspection_concern_scope" ||
      !issues.some(mapped => mapped.code === "inspection_concern_scope" && mapped.path.startsWith(issue.path + "/requirement_indices/"))));
  }
  if (issues.length) throw new ValidationError(issues);
  return value;
}


/** Only actual assistant prose from the proven answer chain can be generation evidence. */
function generatedTextPaths(raw: { messages: unknown[] }, index: number | undefined): string[] {
  const turn = index === undefined ? undefined : raw.messages[index] as { type?: unknown; output?: unknown };
  if (turn?.type !== "llm_turn" || !Array.isArray(turn.output) || turn.output.length !== 1) return [];
  const output = turn.output[0] as { role?: unknown; content?: unknown; function_call?: unknown; tool_calls?: unknown };
  if (output?.role !== "assistant" || output.function_call ||
    (output.tool_calls != null && (!Array.isArray(output.tool_calls) || output.tool_calls.length))) return [];
  if (typeof output.content === "string") return output.content.length ? ["/output/0/content"] : [];
  if (!Array.isArray(output.content) || !output.content.length) return [];
  const blocks = output.content as { type?: unknown; text?: unknown }[];
  if (!blocks.every(block => block && typeof block.type === "string" && ["text", "output_text"].includes(block.type) && typeof block.text === "string")) return [];
  return blocks.flatMap((block, blockIndex) => block.text ? [`/output/0/content/${blockIndex}/text`] : []);
}

function finalTextPaths(content: unknown): string[] {
  return typeof content === "string" ? ["/content"] : Array.isArray(content)
    ? content.flatMap((block, index) => block && typeof block === "object" &&
      ["text", "output_text"].includes(String(block.type)) && typeof block.text === "string" ? [`/content/${index}/text`] : [])
    : content && typeof content === "object" && ["text", "output_text"].includes(String((content as { type?: unknown }).type)) &&
      typeof (content as { text?: unknown }).text === "string" ? ["/content/text"] : [];
}

/** Whole actual material is a review scope, never an automatically localized counterexample. */
function actualAnswerScope(request: AgentRequest, candidate: string, observation: string): EvidenceReference[] {
  const source = request.sources[candidate], material = (request.input as unknown as ComparisonVerificationInput).candidates[candidate];
  const raw = source?.value as { messages: unknown[] } | undefined;
  const final = raw?.messages[material.final_message_index] as { role?: unknown; type?: unknown; content?: unknown } | undefined;
  const fail = (code: string, message: string): never => { throw new ValidationError([{ category: "evidence", code,
    path: `/candidates/${candidate}`, candidate, message }]); };
  if (!raw || !Array.isArray(raw.messages) || !final || final.role !== "assistant" && !(final.role === undefined && final.type === "final_answer"))
    return fail("verification_check_source_missing", "核对范围必须来自本方登记的实际最终回答，不能以原问题、工具或规划器替代。");
  const bind = (index: number, paths: string[]) => evidenceSources(raw.messages[index]).flatMap(leaf =>
    leaf.kind === "text" && paths.includes(leaf.path) && leaf.text.length
      ? [{ evidence_id: evidenceId(source.id, index, "text", leaf.path, 0, leaf.text.length) }] : []);
  const references: EvidenceReference[] = finalIndices(material).flatMap(index => {
    const content = (raw.messages[index] as { content?: unknown }).content;
    return [...bind(index, finalTextPaths(content)), ...(images(content).length ? [{ evidence_id: evidenceId(source.id, index, "image"), observation }] : [])];
  }); // Preserve the model's own inspection observation; never manufacture a visual fact.
  const generation = material.answer_generation;
  if (generation) {
    const index = answerTurnContexts(raw, material.final_message_index).at(-1)?.message_index;
    const paths = generatedTextPaths(raw, index), leaves = index === undefined ? [] : evidenceSources(raw.messages[index]);
    if (!generation.available || generation.captured_final_message_index !== material.final_message_index || generation.message_index !== index ||
      raw.messages.slice(generation.message_index + 1, material.final_message_index).some(message => {
        const item = message as { role?: unknown; type?: unknown }; return item.role === "user" || item.type === "user_question";
      }) || !paths.length || paths.some(path => !generation.blocks.some(block => block.path === path &&
        leaves.some(leaf => leaf.kind === "text" && leaf.path === path && leaf.text.length === block.total_chars))))
      return fail("verification_check_generation_source", "模型生成核对范围须是确证的最后回答生成及全部真实正文叶子；不能以元数据、任意旧生成或截断目录替代。");
    references.push(...bind(generation.message_index, paths));
  }
  if (!references.length) return fail("verification_check_source_missing", "未找到完整实际回答正文或可查看图片，不能虚构核对证据。");
  return references;
}

function answerEvidenceIssues(request: AgentRequest, candidate: string, references: EvidenceReference[], audit: ToolAudit, path: string): ValidationIssue[] {
  const input = request.input as unknown as ComparisonVerificationInput, issues: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, actual?: unknown) =>
    issues.push({ category: "decision", code, path, message, ...(actual !== undefined ? { actual } : {}) });
  const source = request.sources[candidate], material = input.candidates[candidate];
  const raw = source?.value as { messages: unknown[] } | undefined;
  if (!raw || !Array.isArray(raw.messages)) {
    issue("verification_check_source_missing", path, "核对项缺少本方真实回答来源。");
    return issues;
  }
  const generation = material.answer_generation;
  const actualGenerationIndex = generation && generation.captured_final_message_index === material.final_message_index
    ? answerTurnContexts(raw, material.final_message_index).at(-1)?.message_index : undefined;
  const generationPaths = generatedTextPaths(raw, actualGenerationIndex);
  for (const [evidenceIndex, reference] of references.entries()) {
    const evidencePath = `${path}/${evidenceIndex}`;
    // The public resolver owns UUID/source/range/image validation; its coordinate parser only locates the answer layer.
    try { resolveEvidence(raw, reference, candidate, audit, evidencePath, source.id); }
    catch (error) { if (!(error instanceof ValidationError)) throw error; issues.push(...error.issues!); continue; }
    const coordinates = parseEvidenceCoordinates(reference.evidence_id)!;
    const isFinal = finalIndices(material).includes(coordinates.message_index);
    const finalPaths = finalTextPaths((raw.messages[coordinates.message_index] as { content?: unknown })?.content);
    const isGeneration = generation?.available === true && actualGenerationIndex === generation.message_index &&
      coordinates.message_index === generation.message_index;
    let isAnswer = isFinal && coordinates.kind === "image";
    if (coordinates.kind === "text") isAnswer = (isFinal && finalPaths.includes(coordinates.path)) ||
      (isGeneration && generation!.blocks.some(block => generationPaths.includes(block.path) && block.path === coordinates.path && coordinates.start >= 0 && coordinates.end <= block.total_chars));
    if (coordinates.kind === "json" && (isFinal || isGeneration)) {
      const ranges = isFinal ? finalPaths : generation!.blocks.filter(block => generationPaths.includes(block.path)).map(block => block.path);
      const sources = evidenceSources(raw.messages[coordinates.message_index]).filter(leaf => leaf.kind === "json");
      isAnswer = ranges.some(answerPath => {
        const selected = selectEvidenceSource(sources, answerPath);
        const leaf = evidenceSources(raw.messages[coordinates.message_index]).find(source => source.kind === "text" && source.path === answerPath);
        return selected && (coordinates.start >= selected.start && coordinates.end <= selected.end ||
          leaf && evidenceCovers(raw, source.id, reference.evidence_id,
            evidenceId(source.id, coordinates.message_index, "text", leaf.path, 0, leaf.text.length)));
      });
    }
    if (!isAnswer) issue("verification_check_answer_source", evidencePath,
      "answer_evidence 须引用本方最终交付内容或确证的最后模型生成内容；原问题、工具输出、规划器、元数据或他方内容不能替代实际回答。", reference);
  }
  return issues;
}

function sourceEvidenceIssues(request: AgentRequest, references: EvidenceReference[], audit: ToolAudit, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [index, reference] of references.entries()) {
    const location = `${path}/${index}`, coordinates = parseEvidenceCoordinates(reference.evidence_id);
    const source = coordinates && Object.entries(request.sources).find(([, source]) => source.id === coordinates.input_id);
    if (!source) issues.push({ category: "evidence", code: "inspection_concern_source", path: location,
      message: "核对来源须来自本任务真实登记的原材料。", actual: reference });
    else {
      try { resolveEvidence(source[1].value as { messages: unknown[] }, reference, source[0], audit, location, source[1].id); }
      catch (error) { if (!(error instanceof ValidationError)) throw error; issues.push(...error.issues!); }
    }
  }
  return issues;
}

/** Select real governing blocks from verified own SYS/DEV text anchors. */
function privateNormAnchors(request: AgentRequest, concern: ComparisonMaterialInspection["concerns"][number], audit: ToolAudit, path: string) {
  const source = request.sources[concern.candidate], input = request.input as unknown as ComparisonVerificationInput;
  const raw = source?.value as { messages: unknown[] } | undefined;
  const material = input.candidates[concern.candidate], issues: ValidationIssue[] = [];
  const fail = (message: string, actual?: unknown) => issues.push({ category: "evidence", code: "inspection_private_norm_required", path,
    message, ...(actual !== undefined ? { actual } : {}) });
  const blocks: EvidenceReference[][] = [];
  if (!raw || !material) return { issues, blocks, ranges: [] };
  const norms = normativeSources(raw, source.id, material.final_message_index).filter(norm => norm.role !== "user");
  const ranges = concern.source_evidence.flatMap(reference => {
    const coordinates = parseEvidenceCoordinates(reference.evidence_id);
    // Other registered sources may prove trigger facts; the normal resolver validates them below.
    // They cannot provide this candidate's governing norm or close its conditions.
    if (!coordinates || coordinates.input_id !== source.id || coordinates.kind !== "text") return [];
    const norm = norms.find(norm => norm.message_index === coordinates.message_index && norm.evidence.some(original => {
      const own = parseEvidenceCoordinates(original.evidence_id)!;
      return own.kind === "text" && own.path === coordinates.path && coordinates.start >= own.start &&
        coordinates.end <= own.end && coordinates.start < coordinates.end;
    }));
    if (!norm) return [];
    try { resolveEvidence(raw, reference, concern.candidate, audit, path, source.id); }
    catch (error) { if (!(error instanceof ValidationError)) throw error; issues.push(...error.issues!); return []; }
    return [coordinates];
  });

  for (const norm of norms) for (const block of sourceContentBlocks(norm.content, norm.path)) {
    if (!block.origins.some(origin => ranges.some(range => range.message_index === norm.message_index && range.path === origin.path &&
      range.start < origin.end && origin.start < range.end))) continue;
    blocks.push(block.origins.map(origin => ({ evidence_id: evidenceId(source.id, norm.message_index, "text", origin.path, origin.start, origin.end) })));
  }
  if (!blocks.length && !issues.length) fail("局部发现缺少本方完整 SYS/DEV 规范证据；不能借共同标准 ID 表达未选入的私规。");
  return { issues, blocks, ranges };
}

/** Canonical inspection checkpoints retain the full program-resolved blocks. */
function sourceOnlyNormProof(request: AgentRequest, concern: ComparisonMaterialInspection["concerns"][number], audit: ToolAudit, path: string) {
  const { issues, blocks, ranges } = privateNormAnchors(request, concern, audit, path);
  const covered = (messageIndex: number, origin: { path: string; start: number; end: number }) => {
    let cursor = origin.start;
    for (const range of ranges.filter(range => range.message_index === messageIndex && range.path === origin.path &&
      range.end > origin.start && range.start < origin.end).sort((a, b) => a.start - b.start)) {
      if (range.start > cursor) return false;
      cursor = Math.max(cursor, range.end);
      if (cursor >= origin.end) return true;
    }
    return false;
  };
  const complete = blocks.filter(block => {
    if (block.every(reference => {
      const coordinates = parseEvidenceCoordinates(reference.evidence_id)!;
      return coordinates.kind === "text" && covered(coordinates.message_index, coordinates);
    })) return true;
    issues.push({ category: "evidence", code: "inspection_private_norm_required", path,
      message: "规范证据须保留同一本方完整原始规范，包括全部真实文本来源、条件和例外。", actual: block });
    return false;
  });
  return { issues, blocks: complete };
}

/** A primary index is not the only norm a finding can explicitly cover; keep full original provenance. */
function selectedNormBlocks(request: AgentRequest, concern: ComparisonMaterialInspection["concerns"][number], id: string) {
  const input = request.input as unknown as ComparisonVerificationInput, source = request.sources[concern.candidate]!;
  const criterion = input.task_analysis.requirements.find(criterion => criterion.id === id);
  if (!criterion) return [];
  return normativeSources(source.value as { messages: unknown[] }, source.id, input.candidates[concern.candidate]!.final_message_index)
    .filter(norm => norm.role !== "user").flatMap(norm => sourceContentBlocks(norm.content, norm.path)
      .filter(block => hasSourceTextBlock(criterion.acceptance_rule, block.quote))
      .map(block => block.origins.map(origin => ({ evidence_id: evidenceId(source.id, norm.message_index, "text", origin.path, origin.start, origin.end) }))));
}

function findingSharesActualAnswer(request: AgentRequest, finding: Finding, concern: ComparisonMaterialInspection["concerns"][number],
  audit: ToolAudit, path: string) {
  const own = finding.evidence.filter(evidence => evidence.source === undefined && evidence.source_input_id === undefined);
  const source = request.sources[concern.candidate]!, raw = source.value as { messages: unknown[] },
    material = (request.input as unknown as ComparisonVerificationInput).candidates[concern.candidate]!;
  return concern.answer_evidence.some(reference => {
    resolveEvidence(raw, reference, concern.candidate, audit, path, source.id);
    return own.some(evidence => actualAnswerEvidenceShares(raw, source.id, material, evidence.evidence_id, reference.evidence_id));
  });
}

/** Only physical values inside a normalized tool return can establish a shared counterfact. */
function returnedFacts(message: unknown): { path: string; value: unknown }[] {
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const value = message as Record<string, unknown>;
  if (["system", "developer", "user", "assistant"].includes(String(value.role)) ||
    value.role !== "tool" && !["tool_result", "function_call_output"].includes(String(value.type))) return [];
  const facts: { path: string; value: unknown }[] = [], requestFields = new Set(["input", "input_messages", "query", "query_list", "arguments", "parameters",
    "function_call", "tool_calls", "role", "type"]);
  const visit = (node: unknown, path: string) => {
    if (node && typeof node === "object") {
      const object = node as Record<string, unknown>;
      if (["system", "developer", "user", "assistant"].includes(String(object.role)) ||
        ["tool_call", "function_call", "user_question", "llm_turn"].includes(String(object.type))) return;
      for (const [key, child] of Object.entries(node)) if (!requestFields.has(key))
        visit(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    } else if (node !== null && node !== undefined && node !== "") facts.push({ path, value: node });
  };
  for (const key of ["content", "output", "result"]) if (Object.hasOwn(value, key)) visit(value[key], `/${key}`);
  return facts;
}

function findingSharesReturnedFact(request: AgentRequest, finding: Finding, concern: ComparisonMaterialInspection["concerns"][number],
  audit: ToolAudit, path: string) {
  const source = request.sources[concern.candidate]!, raw = source.value as { messages: unknown[] },
    material = (request.input as unknown as ComparisonVerificationInput).candidates[concern.candidate]!;
  if (!concern.answer_evidence.length || answerEvidenceIssues(request, concern.candidate, concern.answer_evidence, audit, path).length) return false;
  const own = finding.evidence.filter(evidence => evidence.source === undefined && evidence.source_input_id === undefined);
  return own.some(left => concern.source_evidence.some(right => {
    const a = parseEvidenceCoordinates(left.evidence_id), b = parseEvidenceCoordinates(right.evidence_id);
    if (!a || !b || a.kind === "image" || b.kind === "image" || a.input_id !== source.id || b.input_id !== source.id ||
      a.message_index !== b.message_index || a.message_index >= material.final_message_index ||
      !evidenceCovers(raw, source.id, left.evidence_id, left.evidence_id) ||
      !evidenceCovers(raw, source.id, right.evidence_id, right.evidence_id)) return false;
    const message = raw.messages[a.message_index], sources = evidenceSources(message), json = sources.filter(item => item.kind === "json");
    return returnedFacts(message).some(({ path: factPath, value }) => {
      const leaf = sources.find(item => item.kind === "text" && item.path === factPath), selected = selectEvidenceSource(json, factPath);
      if (!selected) return false;
      if (a.kind === "json" && b.kind === "json") {
        // The locator includes an object's key. Primitive serialization ends at the same exact end;
        // its content alone identifies the value, including escaped strings and array elements.
        const serialized = JSON.stringify(value), quotes = typeof value === "string" ? 1 : 0;
        if (!serialized || typeof value === "string" && !value.trim()) return false;
        const start = Math.max(a.start, b.start, selected.end - serialized.length + quotes),
          end = Math.min(a.end, b.end, selected.end - quotes);
        return a.path === b.path && a.path === selected.source.path && start < end &&
          !!selected.source.text.slice(start, end).trim();
      }
      if (!leaf) return false;
      if (a.kind === "text" && b.kind === "text") return a.path === factPath && b.path === factPath &&
        Math.max(a.start, b.start) < Math.min(a.end, b.end);
      const text = a.kind === "text" ? a : b, container = a.kind === "json" ? left : right;
      return text.path === factPath && evidenceCovers(raw, source.id, container.evidence_id,
        evidenceId(source.id, a.message_index, "text", factPath, text.start, text.end));
    });
  }));
}

function findingSharesProof(request: AgentRequest, finding: Finding, concern: ComparisonMaterialInspection["concerns"][number],
  blocks: EvidenceReference[][], audit: ToolAudit, path: string) {
  const own = finding.evidence.filter(evidence => evidence.source === undefined && evidence.source_input_id === undefined);
  const source = request.sources[concern.candidate]!;
  return blocks.some(block => block.every(norm => own.some(evidence =>
    evidenceCovers(source.value as { messages: unknown[] }, source.id, evidence.evidence_id, norm.evidence_id)))) &&
    findingSharesActualAnswer(request, finding, concern, audit, path);
}

/** A compound USER rule can retain a complete common rule's exact original origins. */
function findingSharesUserNorm(request: AgentRequest, finding: Finding, concern: ComparisonMaterialInspection["concerns"][number],
  primary: ReturnType<typeof findingCriterion>, id: string, audit: ToolAudit, path: string) {
  const input = request.input as unknown as ComparisonVerificationInput, source = request.sources[concern.candidate]!,
    raw = source.value as { messages: unknown[] }, material = input.candidates[concern.candidate]!,
    target = input.task_analysis.requirements.find(criterion => criterion.id === id);
  if (!primary || primary.id === id || !criterionAppliesToPair(input, primary) || !target ||
    target.applies_to.length && !target.applies_to.includes(material.candidate_id) || selectedNormBlocks(request, concern, id).length ||
    !findingSharesActualAnswer(request, finding, concern, audit, path)) return false;
  const own = finding.evidence.filter(evidence => evidence.source === undefined && evidence.source_input_id === undefined);
  return normativeSources(raw, source.id, material.final_message_index).filter(norm => norm.role === "user").some(norm => {
    const blocks = sourceContentBlocks(norm.content, norm.path), targets = blocks.filter(block => hasSourceTextBlock(target.acceptance_rule, block.quote)),
      sources = evidenceSources(raw.messages[norm.message_index]);
    const overlaps = (reference: EvidenceReference, origin: { path: string; start: number; end: number }) => {
      const coordinates = parseEvidenceCoordinates(reference.evidence_id);
      if (!coordinates || coordinates.kind === "image" || coordinates.input_id !== source.id || coordinates.message_index !== norm.message_index) return false;
      if (coordinates.kind === "text") return coordinates.path === origin.path && coordinates.start < origin.end && origin.start < coordinates.end;
      const leaf = sources.find(item => item.kind === "text" && item.path === origin.path),
        selected = selectEvidenceSource(sources.filter(item => item.kind === "json"), origin.path);
      if (!leaf || !selected || coordinates.path !== selected.source.path) return false;
      // Locate the original string content only; the JSON field label is not a norm.
      const valueStart = selected.end - JSON.stringify(leaf.text).length + 1,
        start = valueStart + JSON.stringify(leaf.text.slice(0, origin.start)).length - 2,
        end = valueStart + JSON.stringify(leaf.text.slice(0, origin.end)).length - 2;
      return coordinates.start < end && start < coordinates.end;
    };
    return blocks.filter(block => hasSourceTextBlock(primary.acceptance_rule, block.quote)).some(anchor =>
      anchor.origins.length && anchor.origins.every(origin => own.some(evidence => evidenceCovers(raw, source.id, evidence.evidence_id,
        evidenceId(source.id, norm.message_index, "text", origin.path, origin.start, origin.end)))) &&
      targets.some(block => anchor.origins.every(origin =>
        block.origins.some(actual => actual.path === origin.path && actual.start === origin.start && actual.end === origin.end)) &&
        // An explicitly selected additional USER clause cannot borrow another clause's problem.
        (!concern.source_evidence.some(reference => targets.some(target => target.origins.some(origin => overlaps(reference, origin)))) ||
          concern.source_evidence.some(reference => anchor.origins.some(origin => overlaps(reference, origin))))));
  });
}

/** One mechanical matcher serves submitted selections and the finite repair choices. */
function concernFindingCoverage(request: AgentRequest, concern: ComparisonMaterialInspection["concerns"][number],
  findingIndex: number, audit: ToolAudit, path: string) {
  const input = request.input as unknown as ComparisonVerificationInput, finding = input.attributions[concern.candidate]?.Problem[findingIndex];
  if (!finding || finding.evidence_status !== "已确认") return { eligible: false, covered: [] as string[] };
  if (!concern.criterion_ids.length) return { covered: [] as string[], eligible: findingSharesProof(request, finding, concern,
      sourceOnlyNormProof(request, concern, audit, `${path}/source_evidence`).blocks, audit, path) };
  const criterion = findingCriterion(input, concern.candidate, findingIndex), covered = concern.criterion_ids.filter(id =>
    (findingSharesActualAnswer(request,finding,concern,audit,path) ||
      input.task_analysis.requirements.some(item=>item.id===id&&!item.applies_to.length)&&!selectedNormBlocks(request,concern,id).length&&findingSharesReturnedFact(request,finding,concern,audit,path)) ||
    findingSharesProof(request, finding, concern, selectedNormBlocks(request, concern, id), audit, path) ||
    findingSharesUserNorm(request, finding, concern, criterion, id, audit, path));
  return { eligible: covered.length > 0, covered };
}

function concernMatchChoices(request: AgentRequest, concern: ComparisonMaterialInspection["concerns"][number],
  concernIndex: number, audit: ToolAudit, path: string) {
  const input = request.input as unknown as ComparisonVerificationInput, requirements = input.task_analysis.requirements;
  const choices = input.attributions[concern.candidate]!.Problem.flatMap((_finding, findingIndex) => {
    const coverage = concernFindingCoverage(request, concern, findingIndex, audit, path);
    return coverage.eligible ? [{ finding_index: findingIndex, covered_requirement_indices: coverage.covered.map(id => requirements.findIndex(item => item.id === id)) }] : [];
  });
  const covered = new Set(choices.flatMap(choice => choice.covered_requirement_indices));
  const missing = concern.criterion_ids.map(id => requirements.findIndex(item => item.id === id)).filter(index => !covered.has(index));
  const possible = concern.criterion_ids.length ? !missing.length : !!choices.length;
  return { concern_index: concernIndex, candidate: concern.candidate, eligible_findings: choices, complete_coverage_possible: possible,
    missing_requirement_indices: missing,
    required_proof: concern.criterion_ids.length ? concern.criterion_ids.map(id => ({
      requirement_index: requirements.findIndex(item => item.id === id), full_norm_blocks: selectedNormBlocks(request, concern, id) }))
      : [{ full_norm_blocks: sourceOnlyNormProof(request, concern, audit, `${path}/source_evidence`).blocks }],
    actual_answer_evidence: concern.answer_evidence,
    unmatched_action: "无法确认准确对应时可省略此 concern 的匹配项并保留原发现待核；可选 finding 不证明是同一问题，仍须核查实际行为与责任链。" };
}

/** Reveal finite structural choices after inspection; they never establish semantic equivalence. */
export function inspectionMatchContext(request: AgentRequest, value: unknown, audit: ToolAudit) {
  const inspection = value as ComparisonMaterialInspection;
  const concerns = inspection.concerns;
  return { verification_concerns: concerns,
    eligible_match_choices: concerns.map((concern, concernIndex) => {
    const { concern_index, candidate, eligible_findings, complete_coverage_possible, missing_requirement_indices } =
      concernMatchChoices(request, concern, concernIndex, audit, `/material_inspection/concerns/${concernIndex}`);
    return { concern_index, candidate, eligible_findings, complete_coverage_possible, missing_requirement_indices };
  }) };
}

function localReview(concern: ComparisonMaterialInspection["concerns"][number]) {
  return { candidate: concern.candidate, criterion_ids: concern.criterion_ids, finding_indices: [], reason: concern.reason };
}

function verificationConcernIssues(request: AgentRequest, concerns: ComparisonMaterialInspection["concerns"], audit: ToolAudit,
  basePath: string): ValidationIssue[] {
  const input = request.input as unknown as ComparisonVerificationInput, issues: ValidationIssue[] = [];
  const expected = new Set(verificationCheckSlots(request).map(slot => JSON.stringify([slot.candidate, slot.criterion_id])));
  for (const [index, concern] of concerns.entries()) {
    const path = `${basePath}/${index}`;
    if (!input.candidates[concern.candidate] || concern.criterion_ids.some(id => !expected.has(JSON.stringify([concern.candidate, id])))) {
      issues.push({ category: "decision", code: "inspection_concern_scope", path,
        message: "发现须定位本方适用的已有要求，不能要求归因修改比较排名或新增标准。", actual: concern });
      continue;
    }
    issues.push(...answerEvidenceIssues(request, concern.candidate, concern.answer_evidence, audit, `${path}/answer_evidence`));
    if (!concern.criterion_ids.length) issues.push(...sourceOnlyNormProof(request, concern, audit, `${path}/source_evidence`).issues);
    issues.push(...sourceEvidenceIssues(request, concern.source_evidence, audit, `${path}/source_evidence`));
  }
  return issues;
}

/** The blind inspection covers every applicable requirement; upstream conclusions are never its input. */
export function validateMaterialInspection(request: AgentRequest, draft: unknown, audit: ToolAudit): void {
  const valid = inspectionValidator(draft), independent = [
    ...(valid ? [] : schemaIssues(inspectionValidator.errors, draft)),
    ...comparisonFinalImageIssues(request, audit), ...comparisonDeferredFinalIssues(request, audit),
  ];
  if (!valid) throw new ValidationError(independent);
  const value = draft as unknown as ComparisonMaterialInspection;
  const slots = verificationCheckSlots(request);
  const issues: ValidationIssue[] = [...independent];
  const issue = (code: string, path: string, message: string, actual?: unknown) =>
    issues.push({ category: "decision", code, path, message, ...(actual !== undefined ? { actual } : {}) });
  if (value.checks.length !== slots.length) issue("verification_check_coverage", "/checks",
    "核对数组须按 verification_check_slots 顺序完整覆盖全部适用 requirements。", { expected: slots.length, actual: value.checks.length });
  for (const [index, check] of value.checks.entries()) {
    const path = `/checks/${index}`, slot = slots[index];
    if (!slot || check.candidate !== slot.candidate || check.criterion_id !== slot.criterion_id) {
      issue("verification_check_scope", path, "核对项须按 verification_check_slots 顺序检查本方适用要求，不能调换、重复或借用他方私规。", slot);
      continue;
    }
    issues.push(...answerEvidenceIssues(request, check.candidate, check.answer_evidence, audit, `${path}/answer_evidence`));
    issues.push(...sourceEvidenceIssues(request, check.source_evidence, audit, `${path}/source_evidence`));
  }
  for (const [index, check] of value.checks.entries()) if (check.result === "contradicted" &&
    !value.concerns.some(concern => concern.candidate === check.candidate && concern.criterion_ids.includes(check.criterion_id)))
    issue("inspection_contradiction_removed", `/checks/${index}`, "contradicted 核对项须在 concerns 保留同一本方要求的具体反证；输出违规用 answer_evidence 定位正文，缺项说明完整回答中的缺失范围，过程违规用 source_evidence 引用规范和实际过程，并以 answer_evidence 关联最终交付。");
  issues.push(...verificationConcernIssues(request, value.concerns, audit, "/concerns"));
  if (issues.length) throw new ValidationError(issues);
}

function unmatchedConcerns(request: AgentRequest, submission: ComparisonVerificationSubmission, audit: ToolAudit) {
  if (!audit.inspection) throw new ValidationError([{ category: "decision", code: "inspection_required", path: "/",
    message: "先独立核查原材料，再查看及确认判词。" }]);
  validateMaterialInspection(request, audit.inspection.value, { ...audit, ...audit.inspection.proof });
  const input = request.input as unknown as ComparisonVerificationInput;
  const concerns = verificationConcerns(audit);
  const requestedMatches = new Set<number>();
  const issues: ValidationIssue[] = [];
  for (const [index, match] of submission.concern_matches.entries()) {
    const duplicate = requestedMatches.has(match.concern_index);
    requestedMatches.add(match.concern_index);
    try {
      const concern = concerns[match.concern_index], path = `/concern_matches/${index}`;
      if (!concern || duplicate) throw new ValidationError([{ category: "decision", code: "inspection_match_index", path,
        actual: match.concern_index,
        expected: { available_concern_indices: concerns.map((_, i) => i), concern_count: concerns.length,
          ...(!concerns.length ? { concern_matches: [] } : {}) },
        message: concerns.length ? "每个匹配只指向一个真实、未重复的原材料发现。"
          : "不可改写的 concerns 为空，concern_matches 须为 []；checks 或既有 finding 不是原材料发现索引。" }]);
      const findings = input.attributions[concern.candidate]?.Problem;
      const ids = new Set(match.finding_indices.flatMap(findingIndex => {
        const finding = findings?.[findingIndex];
        if (!finding || finding.evidence_status !== "已确认")
          throw new ValidationError([{ category: "decision", code: "inspection_match_finding", path,
            expected: concernMatchChoices(request, concern, match.concern_index, audit, path),
            message: "原材料发现只能对应本方既有 established problem；准确对应事实与责任链仍须实际核查。" }]);
        const coverage = concernFindingCoverage(request, concern, findingIndex, audit, path);
        if (!concern.criterion_ids.length) {
          if (!coverage.eligible)
            throw new ValidationError([{ category: "decision", code: "inspection_match_private_norm", path,
              expected: concernMatchChoices(request, concern, match.concern_index, audit, path),
              message: "未选入要求的局部发现只能对应本方 requirement_index=null 的 instruction_following established problem；只选择 eligible_findings 中的 finding，并核查同一完整真实规范、实际回答、行为与责任链。" }]);
          return [];
        }
        if (!coverage.eligible) throw new ValidationError([{ category: "decision", code: "inspection_match_finding", path,
          expected: concernMatchChoices(request, concern, match.concern_index, audit, path),
          message: "原材料发现只能对应本方既有 established problem：同一要求下引用同一实际回答证据，或共同非私规要求下引用同一真实工具返回事实；私规匹配仍须同一完整真实 SYS/DEV 与实际回答，跨 USER 要求须完整共享共同原块与同一实际回答，不能借它闭合只引用新增条款的发现。共有题目、查询参数或标签本身不足，具体行为与责任链仍须实际核查。" }]);
        return coverage.covered;
      }));
      if (concern.criterion_ids.some(id => !ids.has(id))) throw new ValidationError([{ category: "decision", code: "inspection_match_coverage", path,
        expected: concernMatchChoices(request, concern, match.concern_index, audit, path),
        message: "匹配须覆盖原发现定位的全部要求，不能因其他问题已存在就跳过当前发现。" }]);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(...error.issues!);
    }
  }
  const refuted = new Set<number>();
  for (const [index, refutation] of (submission.concern_refutations ?? []).entries()) {
    const path = `/concern_refutations/${index}`;
    if (!concerns[refutation.concern_index] || requestedMatches.has(refutation.concern_index) || refuted.has(refutation.concern_index))
      issues.push({ category: "decision", code: "inspection_refutation_index", path,
        message: "反驳只指向一个真实、未匹配且未重复的首查疑点。", actual: refutation.concern_index });
    refuted.add(refutation.concern_index);
    issues.push(...sourceEvidenceIssues(request, refutation.source_evidence, audit, `${path}/source_evidence`));
  }
  if (issues.length) throw new ValidationError(issues);
  return concerns.filter((_concern, index) => !requestedMatches.has(index) && !refuted.has(index)).map(localReview);
}

/** Unknown facts remain unknown; only an upstream definite use of this same requirement needs correction. */
function unverifiedReviews(request: AgentRequest, audit: ToolAudit) {
  const input = request.input as unknown as ComparisonVerificationInput;
  const inspection = audit.inspection!.value as unknown as ComparisonMaterialInspection;
  return inspection.checks.filter(check => check.result === "unverified").flatMap(check => {
    const attribution = input.attributions[check.candidate];
    const met = input.comparison_draft.decision_basis.comparisons.some(row=>row.criterion_ids.includes(check.criterion_id)&&
      row.assessments[check.candidate]?.status==='met'&&row.assessments[check.candidate]?.evidence_status==='已确认');
    const decisive = input.comparison_draft.decision_basis.decisive_findings.flatMap(reference => reference.candidate === check.candidate &&
      findingCriterion(input, check.candidate, reference.finding_index)?.id === check.criterion_id &&
      attribution.Problem[reference.finding_index]?.evidence_status === "已确认" ? [reference.finding_index] : []);
    return met || decisive.length ? [{ candidate: check.candidate, criterion_ids: [check.criterion_id],
      finding_indices: [...new Set(decisive)], reason: check.observation }] : [];
  });
}

/** Opposite source judgments need reconciliation, without treating every local problem as failed satisfaction. */
function checkConflictReviews(request: AgentRequest, audit: ToolAudit) {
  const input = request.input as unknown as ComparisonVerificationInput;
  const inspection = audit.inspection!.value as unknown as ComparisonMaterialInspection;
  return inspection.checks.filter(check => check.result === "supported" || check.result === "not_applicable").flatMap(check => {
    const attribution = input.attributions[check.candidate];
    const failed = input.comparison_draft.decision_basis.comparisons.some(row=>row.criterion_ids.includes(check.criterion_id)&&
      ['unmet','partial'].includes(row.assessments[check.candidate]?.status)&&row.assessments[check.candidate]?.evidence_status==='已确认');
    const problems = check.result === "not_applicable" ? attribution.Problem.flatMap((finding, index) => finding.evidence_status === "已确认" && findingCriterion(input, check.candidate, index)?.id === check.criterion_id ? [index] : []) : [];
    return failed || problems.length ? [{ candidate: check.candidate, criterion_ids: [check.criterion_id],
      finding_indices: problems, reason: check.observation }] : [];
  });
}

/** Sparse choices leave all omitted cells empty without asking the model to copy a table. */
function resolveSelectedSourceReviews(request: AgentRequest, choices: ComparisonVerificationSubmission["source_reviews"]) {
  const input = request.input as unknown as ComparisonVerificationInput;
  const rows = comparisonSlots(request).map(() => Object.fromEntries(Object.keys(input.candidates).map(candidate => [candidate, null as string | null])));
  const seen = new Set<string>(), issues: ValidationIssue[] = [];
  for (const [index, choice] of choices.entries()) {
    const path = `/source_reviews/${index}`, row = rows[choice.slot_index];
    if (!row) { issues.push({ category: "decision", code: "source_review_slot_index", path: `${path}/slot_index`,
      actual: choice.slot_index, expected: { available_slot_indices: rows.map((_, index) => index) },
      message: "只选择 comparison_slots 中真实的零起始 slot_index。" }); continue; }
    const key = `${choice.slot_index}:${choice.candidate}`;
    if (seen.has(key)) { issues.push({ category: "decision", code: "source_review_duplicate", path,
      message: "同一格只提交一个复核理由；多个疑点合并在同一 reason。" }); continue; }
    seen.add(key);
    row[choice.candidate] = choice.reason;
  }
  let resolved: ComparisonResult["review_requests"] = [];
  try { resolved = resolveSourceReviews(request, rows); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    for (const issue of error.issues!) {
      const selection = choices.findIndex(choice => issue.path === `/source_reviews/${choice.slot_index}/${choice.candidate}`);
      issues.push(selection < 0 ? issue : { ...issue, path: `/source_reviews/${selection}/reason` });
    }
  }
  if (issues.length) throw new ValidationError(issues);
  return resolved;
}

/** Immutable unmatched concerns and pending requests determine status; the model never repeats them. */
export function resolveVerification(request: AgentRequest, draft: unknown, audit: ToolAudit): ComparisonResult {
  if (!validator(draft)) throw new ValidationError(schemaIssues(validator.errors, draft));
  const input = request.input as unknown as ComparisonVerificationInput, value = draft as unknown as ComparisonVerificationSubmission;
  const reviews = structuredClone(input.comparison_draft.review_requests);
  const issues: ValidationIssue[] = [];
  const independentlyResolve = (resolve: () => ComparisonResult["review_requests"]) => {
    try { return resolve(); }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(...error.issues!);
      return [];
    }
  };
  // Both inputs have passed the schema. A bad match cannot hide a separately
  // decidable selection/scope error and consume another repair just to reveal it.
  const concerns = independentlyResolve(() => unmatchedConcerns(request, value, audit));
  const sourceReviews = independentlyResolve(() => resolveSelectedSourceReviews(request, value.source_reviews));
  if (issues.length) throw new ValidationError(issues);
  for (const review of [...concerns, ...unverifiedReviews(request, audit), ...checkConflictReviews(request, audit), ...sourceReviews])
    if (!reviews.some(item => isDeepStrictEqual(item, review))) reviews.push(review);
  if (!reviews.length && input.comparison_draft.status === "decided") return structuredClone(input.comparison_draft);
  return pendingComparison(request, Object.fromEntries(Object.entries(input.comparison_draft.assessments)
    .map(([candidate, item]) => [candidate, { summary: item.summary }])), reviews);
}

export function validateVerification(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  const inspection = audit.inspection?.value as unknown as ComparisonMaterialInspection | undefined;
  if (inspection) validateMaterialInspection(request, inspection, { ...audit, ...audit.inspection!.proof });
  const localReviews = verificationConcerns(audit).filter(concern => !concern.criterion_ids.length).map(localReview);
  validateEvaluation(request, result, audit, localReviews);
  const input = request.input as unknown as ComparisonVerificationInput;
  const value = result as ComparisonResult;
  const requiredUnverified = inspection ? unverifiedReviews(request, audit) : [];
  if (requiredUnverified.some(review => !value.review_requests.some(item => isDeepStrictEqual(item, review))))
    throw new ValidationError([{ category: "decision", code: "verification_unverified_removed", path: "/review_requests",
      expected: requiredUnverified, message: "原材料仍未核实的要求已被归因作确定结论使用，该来源复核疑点须保留。" }]);
  const requiredConflicts = inspection ? checkConflictReviews(request, audit) : [];
  if (requiredConflicts.some(review => !value.review_requests.some(item => isDeepStrictEqual(item, review))))
    throw new ValidationError([{ category: "decision", code: "verification_check_conflict_removed", path: "/review_requests",
      expected: requiredConflicts, message: "首查实际满足或条件未触发，与归因同项已确认的失败或问题相矛盾，该来源复核疑点须保留。" }]);
  if (value.status === "decided" && !isDeepStrictEqual(value, input.comparison_draft))
    throw new ValidationError([{ category: "decision", code: "verification_draft_changed", path: "/",
      message: "比较草稿只读；发现归因错误须提出 source_reviews，不得改写排名、点评或来源事实。" }]);
  if (value.status === "needs_review" && input.comparison_draft.review_requests.some(review =>
    !value.review_requests.some(item => isDeepStrictEqual(item, review))))
    throw new ValidationError([{ category: "decision", code: "verification_review_removed", path: "/review_requests",
      expected: input.comparison_draft.review_requests,
      message: "草稿中尚未完成的来源复核请求必须保留；不能通过独立复核删除或跳过。" }]);
  if (value.status === "needs_review" && !isDeepStrictEqual(value, pendingComparison(request, Object.fromEntries(Object.entries(input.comparison_draft.assessments)
      .map(([candidate, assessment]) => [candidate, { summary: assessment.summary }])), value.review_requests))) throw new ValidationError([{ category: "decision", code: "verification_review_changed", path: "/",
    message: "有未解决的来源疑点时保留复核；不能改写草稿点评、核心状态或待核实判决。" }]);
}
