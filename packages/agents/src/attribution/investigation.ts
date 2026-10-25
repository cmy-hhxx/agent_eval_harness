import { canonical, type AgentRequest, type ToolAudit, type TraceRead, type ValidationIssue } from "@eval/contracts";
import { attributionTaxonomy } from "@eval/prompts";
import { cite, evidenceSources,isGeneratedCallEvidence, isComponentLocator, parseEvidenceCoordinates, selectEvidenceSource, traceExchanges, traceReadCoverage, traceComponentOwnsEvidence } from "@eval/tools";
import type { BusinessChain, Evidence, ProblemProposal } from "./types.js";

export const businessChainDirectory = (request: AgentRequest): BusinessChain[] =>
  (request.input.answer as { business_chains: BusinessChain[] }).business_chains;
const critical = new Set(["查询规划与标的选择", "工具请求参数", "原始返回及字段含义", "返回整理与上下文传递", "模型实际输入"]);
const target = (item: Evidence): TraceRead | undefined => {
  const point = parseEvidenceCoordinates(item.evidence_id);
  return point && point.kind !== "image" ? { candidate: "answer", message_index: point.message_index,
    kind: point.kind, path: point.path, start: point.start, end: point.end } : undefined;
};
function readCovered(audit: ToolAudit, read: TraceRead, raw: { messages: unknown[] }): boolean {
  if (traceReadCoverage(audit, read).covered) return true;
  if (read.kind !== "text") return false;
  const sources = evidenceSources(raw.messages[read.message_index]);
  if (!sources.some(source => source.kind === "text" && source.path === read.path && read.end <= source.text.length)) return false;
  // A complete physical JSON leaf includes its decoded text. A partial literal,
  // matching value elsewhere or an initially presented preview does not prove a read.
  const leaf = selectEvidenceSource(sources.filter(source => source.kind === "json"), read.path);
  return !!leaf && traceReadCoverage(audit, { ...read, kind: "json", path: leaf.source.path,
    start: leaf.start, end: leaf.end }).covered;
}
export function businessChainReads(request: AgentRequest): TraceRead[] {
  return [...new Map(businessChainDirectory(request).flatMap(chain => chain.checkpoints
    .filter(point => critical.has(point.step)).flatMap(point => point.evidence.flatMap(item => {
      const read = target(item); return read ? [[canonical(read), read] as const] : [];
    })))).values()];
}
const overlaps = (a: Evidence, b: Evidence, raw: { messages: unknown[] }) => {
  const x = parseEvidenceCoordinates(a.evidence_id), y = parseEvidenceCoordinates(b.evidence_id);
  if (!x || !y || x.kind === "image" || y.kind === "image" || x.input_id !== y.input_id || x.message_index !== y.message_index) return false;
  if (x.kind === y.kind) return x.path === y.path && x.start < y.end && y.start < x.end;
  const text = x.kind === "text" ? x : y, json = x.kind === "json" ? x : y;
  const range = selectEvidenceSource(evidenceSources(raw.messages[x.message_index]).filter(source => source.kind === "json"), text.path);
  return !!range && json.path === range.source.path && json.start < range.end && range.start < json.end;
};

/** A quoted boundary is not an intermediate calculation, even when two values have a simple ratio. */
function explicitModelProcess(request: AgentRequest, actor: { message_indices: number[] }, proof: readonly Evidence[]): boolean {
  const raw = request.sources.answer.value as { messages: unknown[] };
  return proof.some(item => !item.source && (isGeneratedCallEvidence(raw,actor,item.evidence_id)||actor.message_indices.includes(item.message_index) &&
    evidenceSources(raw.messages[item.message_index]).some(source => source.kind === "text" && source.text.length > 0 &&
      !source.path.startsWith("/input_messages/") && /\/(?:reasoning_content|reasoning|thinking|calculation(?:s|_steps)?)(?:\/|$)/u.test(source.path) &&
      overlaps(item, cite(request.sources.answer.id, item.message_index, source, 0, source.text.length), raw))));
}

/** Validate the program directory against actual invocations and original source coordinates. */
export function businessChainDirectoryIssues(request: AgentRequest): ValidationIssue[] {
  const raw = request.sources.answer.value as { messages: unknown[] }, chains = businessChainDirectory(request), issues: ValidationIssue[] = [];
  const exchanges = traceExchanges(raw.messages);
  if (!Array.isArray(chains) || chains.length !== exchanges.length) return [{ category: "evidence", code: "business_chain_directory",
    path: "/answer/business_chains", message: "业务链路目录必须对应实际关联的请求与返回。" }];
  chains.forEach((chain, index) => {
    const exchange = exchanges[index];
    const linked = canonical([chain.chain_index, chain.request_index, chain.return_indices, chain.planner_index, chain.link_basis]) ===
      canonical([index + 1, exchange.request_index, exchange.return_indices, exchange.planner_index, exchange.link_basis]);
    const actor = (request.input.answer as { component_catalog: { kind: string; component: string; message_indices: number[] }[] })
      .component_catalog.find(actor => actor.kind === "tool" && actor.message_indices.includes(chain.request_index));
    const points = chain.checkpoints.flatMap(point => point.evidence);
    const valid = points.every(item => {
      const point = parseEvidenceCoordinates(item.evidence_id);
      const source = point && point.kind !== "image" && evidenceSources(raw.messages[item.message_index])
        .find(source => source.kind === point.kind && source.path === point.path);
      return point && source && point.input_id === request.sources.answer.id && point.message_index === item.message_index &&
        source.text.slice(point.start, point.end) === item.quote;
    });
    if (!linked || !valid || actor?.component !== chain.tool_component || canonical(chain.checkpoints.map(point => point.step)) !== canonical(attributionTaxonomy.investigation_steps))
      issues.push({ category: "evidence", code: "business_chain_directory", path: `/answer/business_chains/${index}`,
        message: "链路必须保留真实请求、返回、规划者和原始坐标；检查点按固定业务顺序登记。" });
  });
  return issues;
}

/** An unread captured boundary is a next investigation action, never a missing-source verdict. */
export function investigationIssues(request: AgentRequest, problem: ProblemProposal, selected: readonly Evidence[], audit: ToolAudit, path: string): ValidationIssue[] {
  const issues = businessChainDirectoryIssues(request), chains = businessChainDirectory(request);
  const raw = request.sources.answer.value as { messages: unknown[] };
  const add = (code: string, location: string, message: string, expected?: unknown) =>
    issues.push({ category: "evidence", code, path: location, message, ...(expected === undefined ? {} : { expected }) });
  const related = chains.filter(chain => problem.component.some(cause => cause.chain_index === chain.chain_index) ||
    problem.investigation.some(entry => entry.chain_index === chain.chain_index));
  const actors = (request.input.answer as {component_catalog:import('@eval/tools').TraceComponentIdentity[]}).component_catalog;
  for (const entry of problem.investigation) {
    const chain=chains.find(chain=>chain.chain_index===entry.chain_index);
    if(!chain){add("responsibility_chain",path+"/investigation","调查事实须关联实际调用。");continue;}
    const seen=new Set<string>();
    const nodes=new Set(problem.component.flatMap(cause=>actors[cause.actor_index-1]?.message_indices??[]));
    const finalContext=chain.context_indices.at(-1);
    const allInputs=chain.checkpoints.find(point=>point.step==="模型实际输入")!.evidence;
    const inputs=allInputs.filter(item=>item.message_index===finalContext||nodes.has(item.message_index));
    const finalInputs=allInputs.filter(item=>item.message_index===finalContext);
    const returned=chain.checkpoints.find(point=>point.step==="原始返回及字段含义")!.evidence;
    const finalIndex=(request.input.answer as {final_message_index:number}).final_message_index;
    const delivered=evidenceSources(raw.messages[finalIndex]).filter(source=>source.kind==='text'&&/^\/content(?:\/|$)/u.test(source.path))
      .map(source=>cite(request.sources.answer.id,finalIndex,source,0,source.text.length));
    const generated=chain.checkpoints.find(point=>point.step==="数据解释与计算")!.evidence
      .filter(item=>!allInputs.some(input=>input.evidence_id===item.evidence_id));
    const intermediates=chain.checkpoints.find(point=>point.step==="返回整理与上下文传递")!.evidence
      .filter(item=>nodes.has(item.message_index)&&!chain.context_indices.includes(item.message_index)&&!chain.return_indices.includes(item.message_index));
    for(const step of entry.steps){
      const checkpoint=chain.checkpoints.find(point=>point.step===step.step);
      if(!checkpoint||seen.has(step.step)){add("investigation_stage",path+"/investigation","调查步骤须存在且不重复。");continue;}
      seen.add(step.step);
      if(checkpoint.availability==="available"&&step.status==="not_collected")
        add("investigation_available",path+"/investigation",step.step+" 已有材料；未读不能声称未采集。",checkpoint.evidence.map(item=>target(item)));
      if(checkpoint.availability==="not_collected"&&step.status==="checked")
        add("investigation_missing_boundary",path+"/investigation",step.step+" 未采集该边界，不能声称已核实。");
      if(step.status!=="checked")continue;
      if(!step.evidence_ids.length||step.evidence_ids.some(id=>!selected.some(item=>item.evidence_id===id)))
        add("investigation_evidence",path+"/investigation","已检查事实须引用本问题的实际证据。");
      for(const item of selected.filter(item=>!item.source&&step.evidence_ids.includes(item.evidence_id))){
        const read=target(item);if(read&&!readCovered(audit,read,raw))
          add("investigation_read_required",path+"/investigation","已检查事实引用的原文尚未完整展示，须补读本段。",read);
      }
      const groups=step.step==="返回整理与上下文传递"?[returned,intermediates,inputs]
        :step.step==="数据解释与计算"?[inputs,generated.length?generated:chain.final_evidence]
        :step.step==="核验与最终交付"?(chain.delivery_changed===false?[[...generated,...delivered]]:[generated,delivered])
        :step.step==="模型实际输入"?[finalInputs.length?finalInputs:inputs]:[checkpoint.evidence];
      for(const group of groups.filter(group=>group.length))if(!group.some(point=>selected.some(item=>!item.source&&step.evidence_ids.includes(item.evidence_id)&&overlaps(item,point,raw))))
        add("investigation_stage_evidence",path+"/investigation",step.step+" 的事实须有对应边界证据，不能用其他阶段替代。",{chain_index:chain.chain_index,step:step.step,
          required_sources:group.map(item=>{
            const point=parseEvidenceCoordinates(item.evidence_id)!;
            return {message_index:item.message_index,reference:{evidence_id:item.evidence_id},
              ...(point.kind!=="image"?{read_request:{candidate:"answer",message_index:point.message_index,kind:point.kind,
                path:point.path,offset:point.start,max_chars:Math.min(16000,point.end-point.start)},end_offset:point.end}:{})};
          })});
    }
  }
  for (const [index, cause] of problem.component.entries()) {
    const location = `${path}/component/${index}`, chain = chains.find(chain => chain.chain_index === cause.chain_index);
    if (cause.chain_index !== null && !chain) add("responsibility_chain", location, "责任须关联实际登记的业务调用链路。特定调用不能填写空关联。");
    if (related.length && !chain) add("responsibility_chain", location, "本问题已有相关业务链路，责任不能只落在通用最终节点；选择故障形成、传播或恢复所在的调用和业务步骤。",
      { chain_index_choices: related.map(chain => chain.chain_index) });
    if (isComponentLocator(cause.business_component) || [(request.input.answer as {component_catalog:{component:string}[]}).component_catalog[cause.actor_index-1]?.component, ...Object.keys(attributionTaxonomy.domains),
      ...Object.values(attributionTaxonomy.domains).flat(), ...attributionTaxonomy.stages, ...attributionTaxonomy.investigation_steps,
      "模型推理错误", "最终作答节点", "回答模型"].includes(cause.business_component))
      add("responsibility_business_location", location, "business_component 须说明具体业务处理位置，不能复述主体名称或技术分类。");
    if (chain && !cause.field_names.length && ["entity_or_unit", "context_loss"].includes(problem.diagnosis))
      add("responsibility_fields", location, "标的、单位或上下文问题须列明受影响的实际字段。");
    const proof = selected.filter(item => cause.evidence_ids.includes(item.evidence_id));
    if(cause.certainty==='confirmed'&&actors[cause.actor_index-1]&&proof.some(item=>!item.source&&traceComponentOwnsEvidence(raw,actors[cause.actor_index-1],item.evidence_id)))
      for(const item of proof.filter(item=>!item.source)) {const read=target(item);if(read&&!readCovered(audit,read,raw))
        add('investigation_read_required',location,'确证责任所引用的材料尚未完整展示；补读本段，或撤回依赖该材料的确证。',read);}
    if (chain) {
      const actor = (request.input.answer as { component_catalog: { kind: string; component: string; message_indices: number[] }[] })
        .component_catalog[cause.actor_index - 1];
      const nodes = cause.chain_step === "查询规划与标的选择" ? [chain.planner_index]
        : cause.chain_step === "工具请求参数" ? [chain.planner_index, chain.request_index]
        : cause.chain_step === "原始返回及字段含义" ? chain.return_indices
        : cause.chain_step === "核验与最终交付" ? [...chain.context_indices, (request.input.answer as {final_message_index:number}).final_message_index]
        : [...chain.context_indices, chain.planner_index];
      if (!actor?.message_indices.some(index => nodes.includes(index)))
        add("responsibility_chain_actor", location, "执行主体与所选业务环节没有实际节点关联；不能把规划、返回或输入处理责任兜底给最终作答者。");
      if (actor?.kind === "model" && cause.chain_step === "数据解释与计算" && cause.mechanism_source === "explicit_process" &&
        !explicitModelProcess(request, actor, proof))
        add("responsibility_mechanism_source", location, "所选证据只有输入、生成或交付边界，没有该模型的推理、计算或转换过程记录。mechanism_source 应为 boundary_comparison，责任机制标 inferred 并列缺口及替代解释；缺陷仍可 established。数值成十倍或其他资料中的价位不能证明内部执行了乘法。");
    }
    const fields = cause.field_names.filter(field => proof.some(item => item.quote.includes(field) || (() => {
      const point = parseEvidenceCoordinates(item.evidence_id); return point && point.kind !== "image" && point.path.includes(field);
    })()));
    if (fields.length !== cause.field_names.length)
      add("responsibility_fields", `${location}/field_names`, "field_names 只保留该责任证据原文或坐标中的实际字段名，不自造概念别名。正文主张或自列计算没有结构化字段时填 []；标的、单位或上下文问题仍须读取并选择实际字段。",
        fields.length || !chain || !["entity_or_unit", "context_loss"].includes(problem.diagnosis) ? fields : undefined);
    if (cause.mechanism_source === "boundary_comparison" && cause.certainty !== "inferred")
      add("responsibility_mechanism_inferred", location, "输入输出边界可确证缺陷，但不能确证隐藏计算或转换机制；标 inferred 并给出缺口及替代解释。");
    if (chain?.delivery_changed === false && cause.role === "primary" && ["核验与最终交付"].includes(cause.chain_step) && problem.diagnosis === "entity_or_unit")
      add("responsibility_formation", location, "模型生成已包含相同错误，交付没有改变该内容；主责应定位此前形成标的或价格口径错误的步骤。");
    if (chain && cause.technical_domain === "上下文工程" && cause.certainty === "confirmed") {
      const actor = (request.input.answer as { component_catalog: { component: string; message_indices: number[] }[] })
        .component_catalog[cause.actor_index - 1];
      if (!actor?.message_indices.some(index => chain.context_indices.includes(index) && index !== chain.context_indices.at(-1)))
        add("responsibility_transfer_actor", location, "接收输入的最终节点本身不能确证为上游整理者；须有实际处理者的输入输出记录，否则责任及机制保留推断并说明缺口。");
    }
  }
  if (problem.diagnosis === "source_absence") {
    const inventory = (request.input.answer as { citation_inventory?: { references: { reference: string; status: string; sources: Evidence[] }[] } }).citation_inventory;
    if (inventory?.references.some(reference => reference.status !== "unknown" && reference.sources.length &&
      selected.some(item => item.quote.includes(reference.reference))) || related.some(chain => chain.references.some(reference => selected.some(item => item.quote.includes(reference)))))
      add("source_absence_contradicted", path, "所引来源已有可读原文，不能判来源不存在或无法追溯；继续核对内容支持、标的口径及实际输入。来源存在不等于支持具体主张。");
  }
  return issues;
}
