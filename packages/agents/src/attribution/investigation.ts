import { canonical, type AgentRequest, type ToolAudit, type TraceRead, type ValidationIssue } from "@eval/contracts";
import { attributionTaxonomy } from "@eval/prompts";
import { cite, evidenceSources,isGeneratedCallEvidence, isComponentLocator, parseEvidenceCoordinates, selectEvidenceSource, traceCallOrigins, traceExchanges, traceReadCoverage } from "@eval/tools";
import type { BusinessChain, Evidence, ProblemProposal } from "./types.js";
import { buildAttributionTransitions, type AttributionTransition, type TransitionBoundary } from "./transitions.js";
import { validateDerivations } from "./derivations.js";

export const businessChainDirectory = (request: AgentRequest): BusinessChain[] =>
  (request.input.answer as { business_chains: BusinessChain[] }).business_chains;
const critical = new Set(["查询规划与标的选择", "工具请求参数", "原始返回及字段含义", "返回整理与上下文传递", "模型实际输入"]);
const target = (item: Pick<Evidence,"evidence_id">): TraceRead | undefined => {
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
const overlaps = (a: Pick<Evidence,"evidence_id">, b: Pick<Evidence,"evidence_id">, raw: { messages: unknown[] }) => {
  const x = parseEvidenceCoordinates(a.evidence_id), y = parseEvidenceCoordinates(b.evidence_id);
  if (!x || !y || x.input_id !== y.input_id || x.message_index !== y.message_index) return false;
  if (x.kind === "image" || y.kind === "image") return x.kind === "image" && y.kind === "image";
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
      !source.path.startsWith("/input_messages/") && /\/(?:reasoning_content|reasoning|analysis|thinking|calculation(?:s|_steps)?)(?:\/|$)/u.test(source.path) &&
      overlaps(item, cite(request.sources.answer.id, item.message_index, source, 0, source.text.length), raw))));
}

/** Validate the program directory against actual invocations and original source coordinates. */
export function businessChainDirectoryIssues(request: AgentRequest): ValidationIssue[] {
  const raw = request.sources.answer.value as { messages: unknown[] }, chains = businessChainDirectory(request), issues: ValidationIssue[] = [];
  const exchanges = traceExchanges(raw.messages), origins = traceCallOrigins(raw.messages);
  if (!Array.isArray(chains) || chains.length !== exchanges.length) return [{ category: "evidence", code: "business_chain_directory",
    path: "/answer/business_chains", message: "业务链路目录必须对应实际关联的请求与返回。" }];
  chains.forEach((chain, index) => {
    const exchange = exchanges[index];
    const linked = canonical([chain.chain_index, chain.request_index, chain.return_indices, chain.planner_index, chain.link_basis]) ===
      canonical([index + 1, exchange.request_index, exchange.return_indices, origins.find(origin => origin.request_index === exchange.request_index)?.planner_index ?? exchange.planner_index, exchange.link_basis]);
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

/** Evidence belongs to one observed transition; the program never chooses the causal judgment. */
export function investigationIssues(request: AgentRequest, problem: ProblemProposal, selected: readonly Evidence[], audit: ToolAudit, path: string): ValidationIssue[] {
  const issues = businessChainDirectoryIssues(request);
  const raw = request.sources.answer.value as { messages: unknown[] };
  const answer = request.input.answer as { transitions: AttributionTransition[]; component_catalog: import('@eval/tools').TraceComponentIdentity[]; final_message_index: number };
  const transitions = answer.transitions;
  const expected = buildAttributionTransitions({ raw, inputId: request.sources.answer.id, finalIndex: answer.final_message_index,
    actors: answer.component_catalog, chains: businessChainDirectory(request) });
  if (canonical(transitions) !== canonical(expected)) return [...issues, {category: 'evidence', code: 'transition_directory',
    path: '/answer/transitions', message: '执行转换须由真实请求、返回与实际输入重新构建，不能改写主体或传递关系。'}];
  const add = (code: string, location: string, message: string, expected?: unknown) =>
    issues.push({ category: 'evidence', code, path: location, message, ...(expected === undefined ? {} : { expected }) });
  const byId = new Map(transitions.map(item => [item.transition_index, item]));
  const proofById = new Map(selected.map(item => [item.evidence_id, item]));
  const checks = new Map<number, ProblemProposal['investigation'][number]>();
  const sourceNavigation = (item: TransitionBoundary) => {
    const read = target(item);
    return {reference:{evidence_id:item.evidence_id}, ...(read ? {read_request:read} :
      {view_request:{candidate:'answer',message_index:item.message_index}})};
  };
  const navigation = (transition: AttributionTransition) => ({transition_index: transition.transition_index, kind: transition.kind,
    before: transition.before.map(sourceNavigation), after: transition.after.map(sourceNavigation)});
  const matches = (item: Evidence, boundaries: TransitionBoundary[]) => !item.source && boundaries.some(boundary => overlaps(item, boundary, raw));
  for (const [index, check] of problem.investigation.entries()) {
    const location = `${path}/investigation/${index}`, transition = byId.get(check.transition_index);
    if (!transition || check.kind !== transition.kind) {
      add('investigation_transition', location, '核查须绑定本方执行转换；类型由目录固定。'); continue;
    }
    if (checks.has(check.transition_index)) add('investigation_duplicate', location, '一个问题内每个转换核查一次，合并同边界的相关观察。');
    checks.set(check.transition_index, check);
    for (const side of ['before', 'after'] as const) {
      const ids = check[`${side}_evidence_ids`], boundaries = transition[side];
      if (boundaries.length && !ids.length)
        add('investigation_boundary_evidence', location, '该转换已有可读边界，须定向读取并引用相关事实；不能将未读写成未采集。', navigation(transition));
      if (!boundaries.length && (ids.length || check.outcome !== 'unresolved'))
        add('investigation_missing_boundary', location, '该侧过程记录未采集，只能保留断点和unresolved，不能用其他阶段补成已核实。', navigation(transition));
      for (const id of ids) {
        const proof = proofById.get(id);
        if (!proof || !matches(proof, boundaries)) {
          add('investigation_boundary_evidence', location, '引用必须属于本问题及所选转换的这一侧，最终交付不能替代实际生成或实际输入。', navigation(transition)); continue;
        }
        const point = parseEvidenceCoordinates(proof.evidence_id);
        if (point?.kind === 'image' && !audit.viewedImages.includes(`answer:${point.message_index}`))
          add('investigation_image_required', location, '图片边界必须实际view_image，文字引用或目录坐标不代表已查看。',
            {view_request:{candidate:'answer',message_index:point.message_index}});
        const read = target(proof);
        if (read && !readCovered(audit, read, raw)) add('investigation_read_required', location,
          '核查引用的原文尚未实际读取；按受保护必读补齐本段后继续判断。', read);
      }
    }
  }
  const ancestors = (indices: number[]) => {
    const visited = new Set<number>(), queue = [...indices];
    while (queue.length) {
      const index = queue.pop()!;
      if (visited.has(index)) continue;
      visited.add(index);
      queue.push(...(byId.get(index)?.predecessors ?? []));
    }
    return visited;
  };
  for (const [index, cause] of problem.component.entries()) {
    const location = `${path}/component/${index}`, transition = byId.get(cause.transition_index);
    if (!transition) { add('responsibility_transition', location, '责任须选择本方已登记的真实执行转换。'); continue; }
    if (cause.actor_index !== transition.actor_index || cause.chain_index !== transition.chain_index)
      add('responsibility_transition_actor', location, '责任主体和链路由转换固定绑定；不能把已知参数生成者改成未知主体，也不能用最终节点代替未知整理者。');
    const check = checks.get(transition.transition_index);
    if (!check) { add('responsibility_check_required', location, '每项责任必须有本问题中对应的边界核查，先核查再定位。', navigation(transition)); continue; }
    if (check.outcome === 'preserved' || check.outcome === 'recovered')
      add('responsibility_formation', location, '该边界核查未发现保留至本问题的缺陷，不能仅因经过该节点将其列为形成或传播责任。');
    const ids = [...new Set([...check.before_evidence_ids, ...check.after_evidence_ids])];
    if (canonical([...cause.evidence_ids].sort()) !== canonical(ids.sort()))
      add('responsibility_evidence', location, '责任证据必须从自身边界核查机械绑定，不替换成其他问题或其他阶段的证据。');
    const proof = ids.flatMap(id => proofById.has(id) ? [proofById.get(id)!] : []);
    const actor = answer.component_catalog[Number(transition.actor_index) - 1];
    if (cause.basis === 'unknown_transition' ? transition.actor_index !== null || transition.relation !== 'unresolved'
      : transition.actor_index === null)
      add('responsibility_basis', location, '已捕获主体使用实际偏离或独立新增依据；未采集处理者保留unknown_transition，不能自行替换身份。');
    if (cause.basis === 'independent_addition' && !['generation','request_formation'].includes(transition.kind))
      add('responsibility_basis', location, '独立新增须定位实际生成内容或请求参数的调用；工具承载和最终附带不能代替生成记录。');
    if (cause.mechanism_source === 'boundary_comparison' && cause.certainty !== 'inferred')
      add('responsibility_mechanism_inferred', location, '边界差异可确证缺陷，但不能确证隐藏动作。机制保持推断并给出缺口和替代解释。');
    if (actor?.kind === 'model' && cause.mechanism_source === 'explicit_process' && !explicitModelProcess(request, actor, proof))
      add('responsibility_mechanism_source', location, '该模型的输入输出差异不是直接过程记录；没有实际参数、推理或计算动作记录时使用boundary_comparison + inferred。');
    if (isComponentLocator(cause.business_component) || Object.values(attributionTaxonomy.domains).flat().includes(cause.business_component))
      add('responsibility_business_location', location, '业务位置须说明本问题的具体操作，不能只复述调用ID或功能分类。');
    if (transition.kind === 'delivery' && cause.role === 'primary' && transition.before.some(before => transition.after.some(after => before.quote !== undefined && before.quote === after.quote)))
      add('responsibility_formation', location, '实际生成与交付内容相同，不能把已存在的错误归为交付时形成。');
    if (cause.role !== 'primary' || transition.kind !== 'generation') continue;
    if (!check.before_evidence_ids.length || !check.after_evidence_ids.length || !['input_deviation','independent_addition'].includes(cause.basis))
      add('responsibility_generation_boundary', location, '生成主责须引用实际输入和实际生成输出，证明输入后首次偏离或生成独立新增无据事实。');
    // Relevant upstream paths are selected by actual quoted source/input coordinates, not by a component quota.
    const reachable = ancestors(transition.predecessors);
    const related = transitions.filter(item => item.transition_index !== transition.transition_index &&
      ['request_formation','execution','transfer'].includes(item.kind) &&
      selected.some(proof => matches(proof, item.after) || item.kind !== 'request_formation' && matches(proof, item.before)));
    const roots = related.filter(item => reachable.has(item.transition_index)).map(item => item.transition_index);
    const required = ancestors(roots);
    // Close both halves of a cited path: source ancestry and its observed transmission to this generation.
    for (const id of reachable) if ([...ancestors([id])].some(parent => roots.includes(parent))) required.add(id);
    // A captured upstream path cannot be bypassed by citing only an unrelated user sentence and the output.
    if (reachable.size && !roots.length)
      add('responsibility_upstream_required', location, '生成调用有已关联上游记录，但本问题尚未定位相关来源或排除它们；先定向核查再归生成主责。',
        {transition_index:transition.transition_index, upstream_choices:transition.predecessors.map(id=>navigation(byId.get(id)!))});
    for (const id of required) {
      const upstream = byId.get(id)!;
      if (!checks.has(id)) add('responsibility_upstream_required', location,
        '所引事实的上游转换尚未核查。检查对象、字段、单位、期间和执行状态，分别说明保持、偏离、恢复或真实断点；不能从最后错误位置直接归责。', navigation(upstream));
    }
    const inputProof = check.before_evidence_ids.flatMap(id => proofById.has(id) ? [proofById.get(id)!] : []);
    for (const id of transition.predecessors.filter(id => required.has(id))) {
      const incoming = byId.get(id)!;
      if (!inputProof.some(item => matches(item, incoming.after))) add('responsibility_generation_boundary', location,
        '生成主责的实际输入证据须包含所追查来源进入本调用的对应材料，不能用无关用户问题替代。', navigation(incoming));
    }
    const unrecovered = (id: number, visited = new Set<number>()): boolean => {
      if (!required.has(id) || visited.has(id)) return false;
      visited.add(id);
      const outcome = checks.get(id)?.outcome;
      if (outcome === 'recovered') return false;
      if (outcome === 'changed' || outcome === 'unresolved') return true;
      return (byId.get(id)?.predecessors ?? []).some(parent => unrecovered(parent, new Set(visited)));
    };
    if (cause.basis === 'input_deviation' && transition.predecessors.some(id => unrecovered(id)))
      add('responsibility_generation_formation', location, '相关上游已存在改变或尚未解决的断点，不能声称完整正确输入后首次偏离。核对因果关系；若生成有独立新增错误，应明确该独立作用和替代解释。');
  }
  issues.push(...validateDerivations(problem.calculations, id => proofById.get(id), path + '/calculations'));
  if (problem.diagnosis === 'source_absence') {
    const inventory = (request.input.answer as { citation_inventory?: {references:{reference:string;status:string;sources:Evidence[]}[]} }).citation_inventory;
    if (inventory?.references.some(reference => reference.status !== 'unknown' && reference.sources.length && selected.some(item=>item.quote.includes(reference.reference))))
      add('source_absence_contradicted', path, '所引来源已有可读原文，不能判为来源不存在；继续核对支持程度与实际输入。');
  }
  return issues;
}
