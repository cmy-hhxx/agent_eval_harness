import { canonical, type AgentRequest, type ToolAudit, type TraceRead, type ValidationIssue } from "@eval/contracts";
import { attributionTaxonomy } from "@eval/prompts";
import { cite, evidenceSources, isComponentLocator, parseEvidenceCoordinates, selectEvidenceSource, traceExchanges, traceReadCoverage } from "@eval/tools";
import type { BusinessChain, Evidence, ProblemProposal } from "./types.js";

export const businessChainDirectory = (request: AgentRequest): BusinessChain[] =>
  (request.input.answer as { business_chains: BusinessChain[] }).business_chains;
const critical = new Set(["查询规划与标的选择", "工具请求参数", "原始返回及字段含义", "返回整理与上下文传递", "模型实际输入"]);
const target = (item: Evidence): TraceRead | undefined => {
  const point = parseEvidenceCoordinates(item.evidence_id);
  return point && point.kind !== "image" ? { candidate: "answer", message_index: point.message_index,
    kind: point.kind, path: point.path, start: point.start, end: point.end } : undefined;
};
export function businessChainReads(request: AgentRequest): TraceRead[] {
  return [...new Map(businessChainDirectory(request).filter(chain => chain.references.length).flatMap(chain => chain.checkpoints
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
  return proof.some(item => !item.source && actor.message_indices.includes(item.message_index) &&
    evidenceSources(raw.messages[item.message_index]).some(source => source.kind === "text" && source.text.length > 0 &&
      !source.path.startsWith("/input_messages/") && /\/(?:reasoning_content|reasoning|thinking|calculation(?:s|_steps)?)(?:\/|$)/u.test(source.path) &&
      overlaps(item, cite(request.sources.answer.id, item.message_index, source, 0, source.text.length), raw)));
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
    chain.final_evidence.some(item => selected.some(proof => !proof.source && overlaps(item, proof, raw))));
  for (const chain of related) {
    const entries = problem.investigation.filter(entry => entry.chain_index === chain.chain_index);
    const where = `${path}/investigation`;
    if (entries.length !== 1 || canonical(entries[0].steps.map(row => row.step).sort()) !== canonical([...attributionTaxonomy.investigation_steps].sort())) {
      add("investigation_incomplete", where, `相关链路 ${chain.chain_index} 必须沿八个环节追查，每步填写观察、证据或明确未采集的材料；不能在最终生成节点结束。`, chain.checkpoints.map(point => ({ step: point.step, availability: point.availability })));
      continue;
    }
    const returned = chain.checkpoints.find(point => point.step === "原始返回及字段含义")!.evidence;
    const inputs = chain.checkpoints.find(point => point.step === "模型实际输入")!.evidence;
    const finalInputs = inputs.filter(item => item.message_index === chain.context_indices.at(-1));
    const actualInput = finalInputs.length ? finalInputs : inputs;
    const generated = chain.checkpoints.find(point => point.step === "数据解释与计算")!.evidence
      .filter(item => !inputs.some(input => input.evidence_id === item.evidence_id));
    const intermediates = chain.checkpoints.find(point => point.step === "返回整理与上下文传递")!.evidence
      .filter(item => ![...returned, ...inputs].some(boundary => boundary.evidence_id === item.evidence_id));
    for (const checkpoint of chain.checkpoints) {
      const step = entries[0].steps.find(row => row.step === checkpoint.step)!;
      if (checkpoint.availability === "available" && step.status === "not_collected")
        add("investigation_available", where, `${checkpoint.step} 已有材料，未读取不能写成未采集或来源不存在。`, checkpoint.evidence.map(item => target(item)));
      if (checkpoint.availability === "not_collected" && step.status === "checked")
        add("investigation_missing_boundary", where, `${checkpoint.step} 未有该边界的记录，不能用其他环节证据声称已核实；明确未采集及其影响。`);
      if (step.status === "checked" && (!step.evidence_ids.length || step.evidence_ids.some(id => !selected.some(item => item.evidence_id === id))))
        add("investigation_evidence", where, `${checkpoint.step} 已检查须引用本条 finding 的真实证据。`);
      const groups = checkpoint.step === "返回整理与上下文传递" ? [returned, intermediates, actualInput]
        : checkpoint.step === "数据解释与计算" ? [actualInput, generated.length ? generated : chain.final_evidence]
        : checkpoint.step === "核验与最终交付" ? [generated, chain.final_evidence]
        : checkpoint.step === "模型实际输入" ? [actualInput] : [checkpoint.evidence];
      if (step.status === "checked") for (const group of groups.filter(group => group.length)) {
        if (!group.some(point => selected.some(item => !item.source && step.evidence_ids.includes(item.evidence_id) && overlaps(item, point, raw))))
          add("investigation_stage_evidence", where, `${checkpoint.step} 必须引用该环节的真实来源；传递、解释和交付分别对照前后边界，不能用后续输入代替原始返回，或用最终交付代替生成过程。`,
            group.map(({evidence_id,message_index}) => ({evidence_id,message_index})));
      }
      if (critical.has(checkpoint.step)) for (const item of checkpoint.evidence) {
        const read = target(item);
        if (read && !traceReadCoverage(audit, read).covered)
          add("investigation_read_required", where, `继续读取链路 ${chain.chain_index} 的${checkpoint.step}；材料存在但尚未完整读取，不能据此形成来源缺失、上下文丢失或标的口径结论。`, read);
      }
    }
  }
  for (const [index, cause] of problem.component.entries()) {
    const location = `${path}/component/${index}`, chain = chains.find(chain => chain.chain_index === cause.chain_index);
    if (cause.chain_index !== null && !chain) add("responsibility_chain", location, "责任须关联实际登记的业务调用链路。特定调用不能填写空关联。");
    if (related.length && !chain) add("responsibility_chain", location, "本问题已有相关业务链路，责任不能只落在通用最终节点；选择故障形成、传播或恢复所在的调用和业务步骤。");
    if (isComponentLocator(cause.business_component) || [cause.component, ...Object.keys(attributionTaxonomy.domains),
      ...Object.values(attributionTaxonomy.domains).flat(), ...attributionTaxonomy.stages, ...attributionTaxonomy.investigation_steps,
      "模型推理错误", "最终作答节点", "回答模型"].includes(cause.business_component))
      add("responsibility_business_location", location, "business_component 须说明具体业务处理位置，不能复述主体名称或技术分类。");
    if (chain && !cause.field_names.length && ["entity_or_unit", "context_loss"].includes(problem.diagnosis))
      add("responsibility_fields", location, "标的、单位或上下文问题须列明受影响的实际字段。");
    const proof = selected.filter(item => cause.evidence_ids.includes(item.evidence_id));
    if (chain) {
      const actor = (request.input.answer as { component_catalog: { kind: string; component: string; message_indices: number[] }[] })
        .component_catalog.find(actor => actor.component === cause.component);
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
    for (const field of cause.field_names) if (!proof.some(item => item.quote.includes(field) || (() => { const point = parseEvidenceCoordinates(item.evidence_id); return point && point.kind !== "image" && point.path.includes(field); })()))
      add("responsibility_fields", `${location}/field_names`, `字段 ${field} 未见于该责任所选原文或坐标。`);
    if (cause.mechanism_source === "boundary_comparison" && cause.certainty !== "inferred")
      add("responsibility_mechanism_inferred", location, "输入输出边界可确证缺陷，但不能确证隐藏计算或转换机制；标 inferred 并给出缺口及替代解释。");
    if (chain?.delivery_changed === false && cause.role === "primary" && ["核验与最终交付"].includes(cause.chain_step) && problem.diagnosis === "entity_or_unit")
      add("responsibility_formation", location, "模型生成已包含相同错误，交付没有改变该内容；主责应定位此前形成标的或价格口径错误的步骤。");
    if (chain && cause.technical_domain === "上下文工程" && cause.certainty === "confirmed") {
      const actor = (request.input.answer as { component_catalog: { component: string; message_indices: number[] }[] })
        .component_catalog.find(actor => actor.component === cause.component);
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
