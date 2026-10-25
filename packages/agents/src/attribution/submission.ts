import { Ajv2020 } from "ajv/dist/2020.js";
import { resolveEvidenceSelection, parseEvidenceCoordinates, schemaIssues, ValidationError, type AgentRequest, type ToolAudit, type TaskAnalysis, type ValidationIssue } from "@eval/contracts";
import schema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import { resolveJudgment } from "./resolve.js";
import { validateJudgment, validateEvaluation } from "./validate.js";
import { attributionFindingBasis } from "./finding-basis.js";
import { responsibilityFunctions, responsibilityIdentities,responsibilityComponentName } from "./responsibility.js";
import { attributionTaxonomy } from "@eval/prompts";
import { businessChainDirectory, investigationIssues } from "./investigation.js";
import type { ProblemProposal, Evidence } from "./types.js";
import { resolveAttributionEvidence } from "./source-evidence.js";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
const validateShape = new Ajv2020({allErrors:true,strict:false}).compile(schema);
const validateFactShape = new Ajv2020({allErrors:true,strict:false}).compile(schema.properties.investigation_facts.items);

/** Bind the shallow model choices once. All evidence and judgment checks use the bound representation. */
function bindSubmission(request: AgentRequest, submitted: unknown, audit: ToolAudit) {
  const value = object(submitted), bank = audit.evidenceBank ?? [], issues: ValidationIssue[] = [];
  const standard=(request.input.ground_truth as {available:boolean}).available;
  if (value.standard_conflict === true && request.input.allow_standard_conflict !== true)
    issues.push({ category: "decision", code: "standard_conflict_disabled", path: "/standard_conflict",
      message: "本次未开启标准答案复核，按提供的标准核对结果，不提交标准冲突。" });
  if(!standard)for(const field of ["is_correct","correctness_reason","correctness_evidence_indices"])
    if(Object.hasOwn(value,field))
      issues.push({category:"decision",code:"correctness_without_standard",path:`/${field}`,actual:value[field],
        message:"没有标准答案时不提交正确性包装字段，由程序填充；仍须独立核验实际事实和交付。"});
  if(value.standard_conflict===true&&!standard)
    issues.push({category:"decision",code:"standard_conflict_without_standard",path:"/standard_conflict",actual:true,
      message:"没有标准答案时不能声明标准冲突；事实和交付按实际核验结果记录。"});
  if(value.standard_conflict===true&&standard&&value.is_correct!==false)
    issues.push({category:"decision",code:"standard_conflict_correctness",path:"/standard_conflict",actual:value.is_correct,
      message:"声明标准冲突时，is_correct=false 仅表示与标准答案不一致；若与标准答案一致，则 standard_conflict=false。"});
  const task = request.input.task_analysis as unknown as TaskAnalysis;
  const criteria = [...task.requirements, ...task.scoring_points, ...task.red_flags]
    .filter(item => !item.applies_to.length || item.applies_to.includes(request.input.candidate_id as string));
  const basis = attributionFindingBasis(request.input);
  const rows = (["strengths", "problems"] as const).flatMap(section => list(value[section]).map(object).map((row,index) => ({
    row, path: `/${section}/${index}`, type: section === "strengths" ? "strength" : "problem",
  })));
  const observations = new Map<number, string>();
  const imageIndexes = bank.flatMap((id, index) => parseEvidenceCoordinates(id)?.kind === "image" ? [index + 1] : []);
  // view_image returns the directory number; a draft that wrote the 1-based ordinal of the
  // image evidence is also accepted when that ordinal identifies exactly one image.
  const imageNumber = (value: unknown): number | undefined => {
    if (!Number.isSafeInteger(value) || (value as number) < 1) return undefined;
    return imageIndexes.includes(value as number) ? value as number : imageIndexes[(value as number) - 1];
  };
  for (const [index, row] of list(value.image_observations).map(object).entries()) {
    const selected = imageNumber(row.image_number);
    if (selected === undefined) {
      issues.push({category:"evidence",code:"image_observation_source",path:`/image_observations/${index}/image_number`,
        message:`图像观察只选择本任务证据目录中的真实图片编号（view_image 返回的 image_number）；可用编号：${imageIndexes.join("、") || "无"}。`,
        actual:row.image_number,expected:{image_numbers:imageIndexes}});
      continue;
    }
    if (observations.has(selected)) issues.push({ category: "evidence", code: "image_observation_duplicate",
      path: `/image_observations/${index}/image_number`, message: "同一图像只提交一条观察。" });
    observations.set(selected, row.text);
  }
  const reference = (number: unknown, path: string) => {
    try { return resolveEvidenceSelection(bank, { evidence_index: number,
      ...(observations.has(Number(number)) ? { observation: observations.get(Number(number)) } : {}) }, path); }
    catch (error) { if (!(error instanceof ValidationError)) throw error; issues.push(...error.issues!); return { evidence_id: "" }; }
  };
  const references = (numbers: unknown, path: string) => list(numbers).map((number,index) => reference(number,`${path}/${index}`));
  const actors = responsibilityIdentities(request), chains = businessChainDirectory(request);
  const facts = list(value.investigation_facts).map(object).map((fact, index):Record<string,any> => {
    const path = `/investigation_facts/${index}`;
    if(!validateFactShape(fact))return {...fact,step:undefined,evidence_ids:[],source_proofs:[]};
    const evidence = references(fact.evidence_indices, `${path}/evidence_indices`);
    const proofs = evidence.flatMap(ref => {
      try { return [resolveAttributionEvidence(request, ref, audit, path)]; }
      catch (error) { if (!(error instanceof ValidationError)) throw error; issues.push(...error.issues!); return []; }
    });
    const step = attributionTaxonomy.investigation_steps[Number(fact.step_index) - 1];
    const chain = chains.find(chain => chain.chain_index === fact.chain_index);
    const checkpoint = chain?.checkpoints.find(point => point.step === step);
    if (!chain || !step || checkpoint?.availability !== "available")
      issues.push({category:"evidence",code:"investigation_fact_boundary",path,
        message:"调查事实只能关联本方已采集的真实链路边界；未采集环节由程序说明，不用其他环节替代。"});
    if (list(fact.field_names).some(field => !proofs.some(proof => {
      const point = parseEvidenceCoordinates(proof.evidence_id);
      return !proof.source && checkpoint?.evidence.some(boundary=>boundary.message_index===proof.message_index) &&
        (proof.quote.includes(field) || point && point.kind !== "image" && point.path.includes(field));
    })))
      issues.push({category:"evidence",code:"investigation_fact_fields",path:`${path}/field_names`,
        message:"共享事实的字段必须分别出现在本事实引用的原文或坐标中，不能借用另一事实的字段。"});
    return {...fact, chain_index:fact.chain_index,field_names:fact.field_names,observation:fact.observation,
      source_proofs:proofs.filter(proof=>!proof.source&&checkpoint?.evidence.some(boundary=>boundary.message_index===proof.message_index)),
      evidence_indices:fact.evidence_indices,step,evidence_ids:evidence.map(ref=>ref.evidence_id)};
  });
  const numericRows=list(value.numeric_checks).map(object);
  const correctnessNumbers = [...new Set([...list(value.correctness_evidence_indices), ...numericRows.filter(row=>Object.hasOwn(row,"evidence_index")).map(row => row.evidence_index)])];
  const correctness = correctnessNumbers.map(number => reference(number, list(value.correctness_evidence_indices).includes(number)
    ? `/correctness_evidence_indices/${list(value.correctness_evidence_indices).indexOf(number)}` : `/numeric_checks/${numericRows.findIndex(row => row.evidence_index === number)}/evidence_index`));
  if (Array.isArray(value.criterion_assessments) && value.criterion_assessments.length !== criteria.length)
    issues.push({ category: "decision", code: "criterion_slot_count", path: "/criterion_assessments", actual: value.criterion_assessments.length,
      expected: { count: criteria.length, checks: criteria.map(item => item.text) }, message: "按本方检查项目录顺序逐项返回，数量必须一致，不填写判据 ID。" });
  const judgment = {
    summary: value.summary,
    ...(standard ? {is_correct:value.is_correct,correctness_reason:value.correctness_reason,correctness_evidence:correctness,
      standard_conflict:value.standard_conflict===true} : {}),
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
      const component = type === "problem" ? list(row.component).map(object).map((cause, index) => {
        const { evidence_indices, function_index, step_index, failure_stage_index, ...fields } = cause;
        return { ...fields, actor_index:cause.actor_index,chain_index:cause.chain_index,field_names:list(cause.field_names),
          role:index === 0 ? "primary" : "contributing",
          component:responsibilityComponentName(actors[Number(cause.actor_index)-1],cause.business_component),
          ...responsibilityFunctions[Number(function_index)-1],
          chain_step:attributionTaxonomy.investigation_steps[Number(step_index)-1],
          failure_stage:attributionTaxonomy.stages[Number(failure_stage_index)-1], reason:cause.mechanism,
          evidence_gap:cause.certainty === "confirmed" ? null : cause.evidence_gap,
          alternatives:cause.certainty === "confirmed" ? [] : cause.alternatives,
          evidence_ids: references(evidence_indices, `${path}/component/${index}/evidence_indices`).map(ref => ref.evidence_id) };
      }) : [];
      const investigationReady = type === 'problem' && ['entity_or_unit','source_absence','context_loss','other'].includes(row.diagnosis) && Array.isArray(row.investigation_fact_indices);
      const linkedFacts = investigationReady ? list(row.investigation_fact_indices).flatMap((number, index) => {
        const fact = Number.isSafeInteger(number) ? facts[Number(number)-1] : undefined;
        if (fact) return [fact];
        issues.push({category:"evidence",code:"investigation_fact_reference",path:`${path}/investigation_fact_indices/${index}`,
          message:"选择 investigation_facts 中已有事实的正整数序号，不能引用缺失行或另一张目录。",actual:number});
        return [];
      }) : [];
      const investigation = [...new Set(linkedFacts.map(fact=>fact.chain_index))].map(chain_index => ({
        chain_index, steps: attributionTaxonomy.investigation_steps.flatMap(step => {
          const checked = linkedFacts.filter(fact=>fact.chain_index === chain_index && fact.step === step);
          const checkpoint = chains.find(chain=>chain.chain_index === chain_index)?.checkpoints.find(point=>point.step === step);
          if (checked.length) return [{step,status:"checked",observation:checked.map(fact=>fact.observation).join("；"),
            evidence_ids:[...new Set(checked.flatMap(fact=>fact.evidence_ids))]}];
          return checkpoint?.availability === "not_collected" ? [{step,status:"not_collected",observation:checkpoint.note,evidence_ids:[]}] : [];
        }),
      }));
      const evidence = references([...new Set([...list(row.evidence_indices), ...list(row.component).flatMap(cause => list(object(cause).evidence_indices)),
        ...linkedFacts.flatMap(fact=>list(fact.evidence_indices))])], `${path}/evidence_indices`);
      if(investigationReady) {
        const selected:Evidence[]=evidence.flatMap(ref=>{try{return [resolveAttributionEvidence(request,ref,audit,path)];}
          catch(error){if(!(error instanceof ValidationError))throw error;issues.push(...error.issues!);return [];}});
        issues.push(...investigationIssues(request,{component,diagnosis:row.diagnosis,investigation,label:row.label,definition:row.reason} as ProblemProposal,selected,audit,path)
          .map(issue=>({...issue,path:issue.path.replace(/\/investigation(?:\/.*)?$/u,"/investigation_fact_indices")})));
      }
      return { type, dimension: row.dimension, stage: row.stage, importance: row.importance, text: row.text, reason: row.reason, evidence,
        ...(ruleBound ? {norm_index:selected?.norm_index ?? null} : {}),
        assessment: { observation: row.text, evidence_status: row.evidence_status, impact: type === "strength" ? row.reason : row.impact,
          ...(ruleBound ? {} : {requirement_index:selected?.requirement_index ?? null}) },
        ...(type === "problem" ? {problem: {component,diagnosis:row.diagnosis,investigation,label:row.label,definition:row.reason}} : {}),
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
function modelIssues(issues: ValidationIssue[], bound: ReturnType<typeof bindSubmission>): ValidationIssue[] {
  const positiveChoices=(entry:unknown):unknown => {
    if(Array.isArray(entry))return entry.map(positiveChoices);
    if(!entry||typeof entry!=="object")return entry;
    return Object.fromEntries(Object.entries(entry).map(([key,item])=>[key,
      ["norm_index","requirement_index","reference_index"].includes(key)&&typeof item==="number"?item+1:positiveChoices(item)]));
  };
  const mapped=issues.filter(issue=>issue.code!=="schema_if").map(issue => {
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
    if(issue.code==="finding_requirement_conflict")message="本条问题关联的检查项同时被判为已确认 met。核对实际缺口后修正该项状态；确属错误关联才重选 basis_index，不能用 null 隐藏已确认问题。";
    if(issue.code.startsWith("core_requirement_"))message="core_requirements 只选择本方 requirements 目录提供的正整数编号；从 expected 选择，不按过滤后位置重新编号。";
    if(issue.code==="core_requirement_private")message="core_requirements 只选择共同要求的正整数编号（见 expected）；本方专有要求的逐项评审和真实问题照常保留，不能用私规判共同核心失败或成功。";
    if(issue.code==="numeric_answer_missing"){
      const candidates=list(object(issue.expected)?.evidence_indices).filter((item):item is number=>typeof item==="number");
      message="numeric_checks.evidence_index 直接选择证据目录中包含 actual 原值的本方最终回答；actual 保留原数值，不先换算、补零或使用自行推导值。"+
        (candidates.length?`当前证据目录中编号 ${candidates.join("、")} 的引文包含该原值，直接改选其中之一；截断的搜索片段或分页不足时，先用 read_trace 读取包含该值的完整片段再选择。`:"搜索片段只覆盖匹配附近窗口，表格行可能被截断；请先 read_trace 读取包含该原值的完整片段，再选择其证据编号。");
    }
    if(/^correctness(?:_reason|_evidence)?_(?:required|forbidden)$/u.test(issue.code)) {
      message=message.replaceAll("correctness_evidence","correctness_evidence_indices");
      const fields=object(expected);
      expected={...fields,...(fields.required_field==="correctness_evidence"?{required_field:"correctness_evidence_indices"}:{}),
        ...(Array.isArray(fields.remove_fields)?{remove_fields:fields.remove_fields.map((field:unknown)=>field==="correctness_evidence"?"correctness_evidence_indices":field)}:{})};
    }
    const path=addressed ? addressed.path+finding![2]
      .replace(/\/(?:assessment\/requirement_index|norm_index)$/u,"/basis_index")
      .replace(/\/(?:assessment|problem)\//u,"/").replace(/\/problem$/u,"") : issue.path;
    return {...issue,expected,actual,message,path:path
      .replace(/^\/core_assessment\/meets_core/u,"/meets_core").replace(/^\/core_assessment\/reason/u,"/core_reason")
      .replace(/^\/core_assessment\/(?:requirement_indices|criterion_ids)/u,"/core_requirements")
      .replace(/^\/core_assessment$/u,"/core_requirements")
      .replace(/^\/correctness_evidence/u,"/correctness_evidence_indices")
      .replace(/\/investigation(?:\/.*)?$/u,"/investigation_fact_indices")
      .replace(/\/component\/(\d+)\/(?:technical_domain|functional_component)$/u,"/component/$1/function_index")
      .replace(/\/component\/(\d+)\/chain_step$/u,"/component/$1/step_index")
      .replace(/\/component\/(\d+)\/failure_stage$/u,"/component/$1/failure_stage_index")
      .replace(/(\/findings\/\d+)\/(?:assessment|problem)\//u,"$1/")
      .replace(/\/evidence(?=\/|$)/u,"/evidence_indices").replace(/\/criterion_id$/u,"")
      .replace(/\/observation$/u,"/text").replace(/\/problem$/u,"")};
  });
  return compactIssues(mapped);
}
function compactIssues(mapped:ValidationIssue[]):ValidationIssue[]{
  const reads=new Map<number,ValidationIssue>(),unique=new Map<string,ValidationIssue>();
  for(const issue of mapped){
    const source=object(issue.expected),requestsToMerge=Array.isArray(source.read_requests)?source.read_requests:[source];
    if(issue.code!=='investigation_read_required'||!requestsToMerge.some(read=>Number.isSafeInteger(read.message_index))){
      unique.set(JSON.stringify([issue.code,issue.path,issue.actual,issue.expected]),issue);continue;
    }
    for(const read of requestsToMerge){
    if(!Number.isSafeInteger(read.message_index))continue;
    let grouped=reads.get(read.message_index);
    if(!grouped){grouped={...issue,expected:{read_requests:[],affected_fields:[]}};reads.set(read.message_index,grouped);}
    const expected=object(grouped.expected),requests=expected.read_requests as Record<string,any>[];
    const overlap=requests.find(item=>item.kind===read.kind&&item.path===read.path&&item.start<=read.end&&read.start<=item.end);
    if(overlap){overlap.start=Math.min(overlap.start,read.start);overlap.end=Math.max(overlap.end,read.end);}
    else requests.push({...read});
    for(const path of Array.isArray(source.affected_fields)?source.affected_fields:[issue.path])
      if(!expected.affected_fields.includes(path))expected.affected_fields.push(path);
    }
  }
  return [...unique.values(),...reads.values()];
}

export function validateModelSubmission(request: AgentRequest, value: unknown, audit: ToolAudit): ValidationIssue[] {
  const bound = bindSubmission(request,value,audit);
  return compactIssues([...bound.issues, ...modelIssues(validateJudgment(request,bound.judgment,audit),bound)]);
}

export function resolveModelSubmission(request: AgentRequest, value: unknown, audit: ToolAudit): unknown {
  if (!validateShape(value)) throw new ValidationError([...schemaIssues(validateShape.errors,value),...validateModelSubmission(request,value,audit)]);
  const bound = bindSubmission(request,value,audit);
  if (bound.issues.length) throw new ValidationError(compactIssues(bound.issues));
  try {
    const result=resolveJudgment(request,bound.judgment,audit);
    validateEvaluation(request,result,audit);
    return result;
  }
  catch (error) { if (!(error instanceof ValidationError)) throw error; throw new ValidationError(modelIssues(error.issues!,bound)); }
}
