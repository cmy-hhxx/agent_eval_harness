import { Ajv2020 } from "ajv/dist/2020.js";
import { resolveEvidenceSelection, parseEvidenceCoordinates, schemaIssues, ValidationError, type AgentRequest, type ToolAudit, type TaskAnalysis, type ValidationIssue } from "@eval/contracts";
import schema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import { resolveJudgment } from "./resolve.js";
import { validateJudgment, validateEvaluation } from "./validate.js";
import { attributionFindingBasis } from "./finding-basis.js";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const validateShape = new Ajv2020({allErrors:true,strict:false}).compile(schema);

/** Bind the shallow model choices once. All evidence and judgment checks use the bound representation. */
function bindSubmission(request: AgentRequest, submitted: unknown, audit: ToolAudit) {
  const value = object(submitted), bank = audit.evidenceBank ?? [], issues: ValidationIssue[] = [];
  const standard=(request.input.ground_truth as {available:boolean}).available;
  if(!standard)for(const [field,empty]of [["is_correct",null],["correctness_reason",""],["correctness_evidence_indices",[]]] as const)
    if(Object.hasOwn(value,field) && (Array.isArray(empty)?!Array.isArray(value[field])||value[field].length>0:value[field]!==empty))
      issues.push({category:"decision",code:"correctness_without_standard",path:`/${field}`,actual:value[field],expected:empty,
        message:"没有标准答案时，is_correct=null、correctness_reason=空字符串、correctness_evidence_indices=[]；仍须独立核验实际事实和交付。"});
  const task = request.input.task_analysis as unknown as TaskAnalysis;
  const criteria = [...task.requirements, ...task.scoring_points, ...task.red_flags]
    .filter(item => !item.applies_to.length || item.applies_to.includes(request.input.candidate_id as string));
  const basis = attributionFindingBasis(request.input);
  const rows = (["strengths", "problems"] as const).flatMap(section => list(value[section]).map(object).map((row,index) => ({
    row, path: `/${section}/${index}`, type: section === "strengths" ? "strength" : "problem",
  })));
  const observations = new Map<number, string>();
  for (const [index, row] of list(value.image_observations).map(object).entries()) {
    if (observations.has(row.image_number)) issues.push({ category: "evidence", code: "image_observation_duplicate",
      path: `/image_observations/${index}/image_number`, message: "同一图像只提交一条观察。" });
    observations.set(row.image_number, row.text);
    if (!Number.isSafeInteger(row.image_number) || parseEvidenceCoordinates(bank[row.image_number-1] ?? "")?.kind !== "image")
      issues.push({category:"evidence",code:"image_observation_source",path:`/image_observations/${index}/image_number`,
        message:"图像观察只选择本任务证据目录中的真实图片编号。",actual:row.image_number});
  }
  const reference = (number: unknown, path: string) => {
    try { return resolveEvidenceSelection(bank, { evidence_index: number,
      ...(observations.has(Number(number)) ? { observation: observations.get(Number(number)) } : {}) }, path); }
    catch (error) { if (!(error instanceof ValidationError)) throw error; issues.push(...error.issues!); return { evidence_id: "" }; }
  };
  const references = (numbers: unknown, path: string) => list(numbers).map((number,index) => reference(number,`${path}/${index}`));
  const numericRows=list(value.numeric_checks).map(object);
  const correctnessNumbers = [...new Set([...list(value.correctness_evidence_indices), ...numericRows.filter(row=>Object.hasOwn(row,"evidence_index")).map(row => row.evidence_index)])];
  const correctness = correctnessNumbers.map(number => reference(number, list(value.correctness_evidence_indices).includes(number)
    ? `/correctness_evidence_indices/${list(value.correctness_evidence_indices).indexOf(number)}` : `/numeric_checks/${numericRows.findIndex(row => row.evidence_index === number)}/evidence_index`));
  if (Array.isArray(value.criterion_assessments) && value.criterion_assessments.length !== criteria.length)
    issues.push({ category: "decision", code: "criterion_slot_count", path: "/criterion_assessments", actual: value.criterion_assessments.length,
      expected: { count: criteria.length, checks: criteria.map(item => item.text) }, message: "按本方检查项目录顺序逐项返回，数量必须一致，不填写判据 ID。" });
  const judgment = {
    summary: value.summary,
    ...(standard ? {is_correct:value.is_correct,correctness_reason:value.correctness_reason,correctness_evidence:correctness} : {}),
    criterion_assessments: list(value.criterion_assessments).map(object).map((row,index) => ({ criterion_id: criteria[index]?.id,
      status: row.status, evidence_status: row.evidence_status, summary: row.summary,
      evidence: references(row.evidence_indices,`/criterion_assessments/${index}/evidence_indices`) })),
    core_assessment: { meets_core: value.meets_core, reason: value.core_reason,
      requirement_indices: list(value.core_requirements).map(number => typeof number === "number" ? number - 1 : number) },
    numeric_checks: numericRows.map(row => ({ ...row,
      reference_index: typeof row.reference_index === "number" ? row.reference_index - 1 : row.reference_index,
      evidence_index: correctnessNumbers.indexOf(row.evidence_index) })),
    findings: rows.map(({row,path,type}) => {
      const selected = row.basis_index === null ? undefined : basis.find(item => item.basis_index === row.basis_index);
      if (row.basis_index !== null && !selected) issues.push({category:"decision",code:"finding_basis_invalid",path:`${path}/basis_index`,
        actual:row.basis_index,expected:basis.map(item=>item.basis_index),message:"basis_index 只选 finding_basis 中已有的正整数；确实没有关联时填 null。"});
      if (selected && row.dimension === "instruction_following" && selected.norm_index === null)
        issues.push({category:"decision",code:"finding_basis_scope",path:`${path}/basis_index`,actual:row.basis_index,
          expected:basis.filter(item=>item.norm_index !== null).map(item=>item.basis_index),
          message:"指令遵循须选择有真实规范来源的依据。"});
      const ruleBound=row.dimension === "instruction_following" || selected?.kind === "own_rule";
      const numbers = [...new Set([...list(row.evidence_indices), ...list(row.tool_evidence_indices)])];
      const evidence = numbers.map(number => reference(number, list(row.evidence_indices).includes(number)
        ? `${path}/evidence_indices/${list(row.evidence_indices).indexOf(number)}`
        : `${path}/tool_evidence_indices/${list(row.tool_evidence_indices).indexOf(number)}`));
      return { type, dimension: row.dimension, stage: row.stage, importance: row.importance, text: row.text, reason: row.reason, evidence,
        ...(ruleBound ? {norm_index:selected?.norm_index ?? null} : {}),
        assessment: { observation: row.text, evidence_status: row.evidence_status, impact: type === "strength" ? row.reason : row.impact,
          ...(ruleBound ? {} : {requirement_index:selected?.requirement_index ?? null}) },
        ...(type === "problem" ? {problem: {model_responsible:row.model_responsible,
          tool_evidence_indices:[...new Set(list(row.tool_evidence_indices).map(number=>numbers.indexOf(number)))],label:row.label,definition:row.definition}} : {}),
      };
    }),
    ...(Object.hasOwn(value,"table_resolutions") ? { table_resolutions: list(value.table_resolutions).map(object).map((row,index) => ({
      table_index: row.table_index, row_index: row.row_index, outcome: row.outcome, reason: row.reason,
      evidence: references(row.evidence_indices,`/table_resolutions/${index}/evidence_indices`),
    })) } : {}),
  };
  return { judgment, issues, criteria, correctnessNumbers, rows, basis };
}

/** Repair addresses always name fields the model can actually submit. */
function modelIssues(issues: ValidationIssue[], bound: ReturnType<typeof bindSubmission>, _submitted: unknown, audit: ToolAudit): ValidationIssue[] {
  const positiveChoices=(entry:unknown):unknown => {
    if(Array.isArray(entry))return entry.map(positiveChoices);
    if(!entry||typeof entry!=="object")return entry;
    return Object.fromEntries(Object.entries(entry).map(([key,item])=>[key,
      ["norm_index","requirement_index","reference_index"].includes(key)&&typeof item==="number"?item+1:positiveChoices(item)]));
  };
  return issues.filter(issue=>issue.code!=="schema_if").map(issue => {
    let expected=positiveChoices(issue.expected),actual=issue.actual,message=issue.message;
    const selector=/(?:norm_index|reference_index|requirement_index|requirement_indices)(?:\/\d+)?$/u.test(issue.path);
    if(selector && typeof actual==="number")actual++;
    if(selector && Array.isArray(expected))expected=expected.map(n=>typeof n==="number"?n+1:n);
    const finding=/^\/findings\/(\d+)(.*)$/u.exec(issue.path);
    const addressed=finding ? bound.rows[Number(finding[1])] : undefined;
    if(addressed && finding![2]==="")actual=addressed.row;
    if(addressed && /(?:norm_index|requirement_index)$/u.test(issue.path)) {
      actual=addressed.row.basis_index;
      if(Array.isArray(issue.expected)){const available=issue.expected;expected=bound.basis.filter(item=>available.includes(
        issue.path.endsWith("norm_index")?item.norm_index:item.requirement_index)).map(item=>item.basis_index);}
      else if(expected && typeof expected === "object") {
        const {norm_index:_norm,requirement_index:_requirement,...rest}=object(expected);
        expected={...rest,basis_index:addressed.row.basis_index};
      }
    }
    if(issue.code==="finding_norm_unknown")message="未确认规范时 basis_index=null，并保留 evidence_status=uncertain；不能宣称已确认遵守或违反。";
    if(issue.code==="finding_requirement_conflict")message="本条问题关联的检查项同时被判为已确认 met。核对实际缺口后修正该项状态；确属错误关联才重选 basis_index，不能用 null 隐藏已确认问题。";
    if(issue.code.startsWith("core_requirement_"))message="core_requirements 只选择本方 requirements 目录提供的正整数编号；从 expected 选择，不按过滤后位置重新编号。";
    if(issue.code==="core_requirement_private")message="core_requirements 只选择共同要求的正整数编号（见 expected）；本方专有要求的逐项评审和真实问题照常保留，不能用私规判共同核心失败或成功。";
    if(issue.code==="numeric_answer_missing")message="numeric_checks.evidence_index 直接选择证据目录中包含 actual 原值的本方最终回答；actual 保留原数值，不先换算、补零或使用自行推导值。";
    if(/^correctness(?:_reason|_evidence)?_(?:required|forbidden)$/u.test(issue.code)) {
      message=message.replaceAll("correctness_evidence","correctness_evidence_indices");
      const fields=object(expected);
      expected={...fields,...(fields.required_field==="correctness_evidence"?{required_field:"correctness_evidence_indices"}:{}),
        ...(Array.isArray(fields.remove_fields)?{remove_fields:fields.remove_fields.map((field:unknown)=>field==="correctness_evidence"?"correctness_evidence_indices":field)}:{})};
    }
    const responsibility=/^\/findings\/(\d+)\/problem\/tool_evidence_indices\/(\d+)$/u.exec(issue.path);
    if(responsibility) {
      const row=Number(responsibility[1]),position=Number(responsibility[2]);
      actual=bound.rows[row]?.row.tool_evidence_indices?.[position];
      const choices=list(object(issue.expected).tool_evidence_choices).map(choice=>({
        evidence_index:(audit.evidenceBank??[]).indexOf(bound.judgment.findings[row]?.evidence[choice.finding_evidence_index]?.evidence_id)+1,
        tool_name:choice.tool_name,
      })).filter(choice=>choice.evidence_index>0);
      expected={tool_evidence_choices:choices};
      message="tool_evidence_indices 直接选择证据目录中证明本方工具自身失误的编号；不填写本条 evidence 数组的位置，不把最终回答、规范或对方工具归为本方工具责任。";
    }
    const path=addressed ? addressed.path+finding![2]
      .replace(/\/(?:assessment\/requirement_index|norm_index)$/u,"/basis_index")
      .replace(/\/(?:assessment|problem)\//u,"/").replace(/\/problem$/u,"") : issue.path;
    return {...issue,expected,actual,message,path:path
      .replace(/^\/core_assessment\/meets_core/u,"/meets_core").replace(/^\/core_assessment\/reason/u,"/core_reason")
      .replace(/^\/core_assessment\/(?:requirement_indices|criterion_ids)/u,"/core_requirements")
      .replace(/^\/core_assessment$/u,"/core_requirements")
      .replace(/^\/correctness_evidence/u,"/correctness_evidence_indices")
      .replace(/(\/findings\/\d+)\/(?:assessment|problem)\//u,"$1/")
      .replace(/\/evidence(?=\/|$)/u,"/evidence_indices").replace(/\/criterion_id$/u,"")
      .replace(/\/observation$/u,"/text").replace(/\/problem$/u,"")};
  });
}

export function validateModelSubmission(request: AgentRequest, value: unknown, audit: ToolAudit): ValidationIssue[] {
  const bound = bindSubmission(request,value,audit);
  return [...bound.issues, ...modelIssues(validateJudgment(request,bound.judgment,audit),bound,value,audit)];
}

export function resolveModelSubmission(request: AgentRequest, value: unknown, audit: ToolAudit): unknown {
  if (!validateShape(value)) throw new ValidationError([...schemaIssues(validateShape.errors,value),...validateModelSubmission(request,value,audit)]);
  const bound = bindSubmission(request,value,audit);
  if (bound.issues.length) throw new ValidationError(bound.issues);
  try {
    const result=resolveJudgment(request,bound.judgment,audit);
    validateEvaluation(request,result,audit);
    return result;
  }
  catch (error) { if (!(error instanceof ValidationError)) throw error; throw new ValidationError(modelIssues(error.issues!,bound,value,audit)); }
}
