import { agentPrompt } from "@eval/prompts";
import { ValidationError, resolveEvidenceSelection, type AgentDefinition, type AgentProfile, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import submissionSchema from "../../../../schemas/rubric/submission.schema.json" with {type:"json"};
import resultSchema from "../../../../schemas/rubric/result.schema.json" with {type:"json"};
import caseSchema from "../../../../schemas/rubric/case.schema.json" with {type:"json"};
import requestSchema from "../../../../schemas/rubric/request.schema.json" with {type:"json"};
import caseRequestSchema from "../../../../schemas/rubric/case-request.schema.json" with {type:"json"};
import { rubricCase, validateRubric, validateRubricCase } from "./validate.js";
import type { RubricResult, RubricState, RubricVerdict } from "./types.js";

const tools = ["read_trace", "search_trace"];
const prompt = agentPrompt("rubric", tools, { fileSubmission: false });

interface SubmittedVerdict {
  item_index: number;
  state: RubricState;
  reason: string;
  na_reason?: string;
  evidence: number[];
}

/** One trace is judged once; the Host fixes the checklist, the label and the trace budget. */
export const rubricProfile: AgentProfile = {
  id: "default", ...prompt, toolNames: tools, evidenceSelections: true, maxEvidenceQuoteChars: 400, maxToolCalls: 12,
  requestSchema, submissionSchema, resultSchema,
  resolve(request: AgentRequest, draft: unknown, audit: ToolAudit) {
    const material = rubricCase(request);
    const source = request.sources.answer;
    if (!source) throw new ValidationError([{category:"decision",code:"rubric_contract",path:"/sources/answer",message:"本题缺少可调查的会话材料。"}]);
    const raw = source.value as { messages: unknown[] };
    const value = draft as { case_id: string; verdicts: SubmittedVerdict[] };
    if (value.case_id !== material.case_id)
      throw new ValidationError([{category:"decision",code:"rubric_contract",path:"/case_id",message:"必须使用执行器提供的本题ID。"}]);
    const verdicts: RubricVerdict[] = [...value.verdicts].sort((a, b) => a.item_index - b.item_index).map((row, index) => {
      const item = material.checklist.find(item => item.index === row.item_index);
      if (!item) throw new ValidationError([{category:"decision",code:"rubric_contract",path:`/verdicts/${index}/item_index`,
        message:"条目编号超出本题清单范围。"}]);
      const evidence = row.evidence.map((selection, position) => {
        const path = `/verdicts/${index}/evidence/${position}`;
        const reference = resolveEvidenceSelection(audit.evidenceBank ?? [], {evidence_index:selection}, path);
        return resolveEvidence(raw, reference, "answer", audit, path, source.id);
      });
      return {
        item_index: row.item_index, item_id: item.item_id, source: item.source, ...(item.kind ? {kind:item.kind} : {}),
        state: row.state, reason: row.reason, ...(row.na_reason !== undefined ? {na_reason:row.na_reason} : {}), evidence,
      } satisfies RubricVerdict;
    });
    const counts: Record<RubricState, number> = {pass:0, partial:0, fail:0, na:0};
    for (const verdict of verdicts) counts[verdict.state] += 1;
    const result: RubricResult = {
      case_id: material.case_id, trace_index: material.trace_index, batch_id: material.batch_id, version: material.version,
      category_id: material.category.id, category_name: material.category.name, checklist_size: material.checklist.length, counts, verdicts,
      l1_id: material.category.l1, l1_name: material.category.l1_name,
    };
    validateRubric(request, result, audit);
    return result;
  },
  validate: validateRubric,
};

/** Case rows are assembled by code from accepted trace batches; they never call a model. */
const mergePrompt = agentPrompt("rubric", [], {fileSubmission: false});
export const rubricMergeProfile: AgentProfile = {
  id: "merge", ...mergePrompt, toolNames: [], requestSchema: caseRequestSchema,
  submissionSchema: caseSchema, resultSchema: caseSchema, validate: validateRubricCase,
};
export const rubricAgent: AgentDefinition = {id: "rubric", profiles: {default: rubricProfile, merge: rubricMergeProfile}};
export * from "./types.js";
export {validateRubric, validateRubricCase, rubricCase} from "./validate.js";
export type {RubricCaseMaterial} from "./validate.js";
