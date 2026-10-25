import { canonical, type AgentRequest, type ToolAudit, type TraceRead, type ValidationIssue } from "@eval/contracts";
import { attributionTaxonomy } from "@eval/prompts";
import { cite, evidenceCovers, evidenceSources,isGeneratedCallEvidence, parseEvidenceCoordinates, selectEvidenceSource, traceCallOrigins, traceExchanges, traceReadCoverage } from "@eval/tools";
import type { BusinessChain, Evidence, ProblemProposal } from "./types.js";
import { buildAttributionTransitions, buildAttributionExecutionNodes, type AttributionTransition, type TransitionBoundary } from "./transitions.js";
import { validateDerivations } from "./derivations.js";

export const businessChainDirectory = (request: AgentRequest): BusinessChain[] =>
  (request.input.answer as { business_chains: BusinessChain[] }).business_chains;
const critical = new Set(["查询规划与标的选择", "工具请求参数", "原始返回及字段含义", "返回整理与上下文传递", "模型实际输入"]);
const target = (item: Pick<Evidence,"evidence_id">): TraceRead | undefined => {
  const point = parseEvidenceCoordinates(item.evidence_id);
  return point && point.kind !== "image" ? { candidate: "answer", message_index: point.message_index,
    kind: point.kind, path: point.path, start: point.start, end: point.end } : undefined;
};
export function attributionReadCovered(audit: ToolAudit, read: TraceRead, raw: { messages: unknown[] }): boolean {
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
  const messageSources = new Map<number, ReturnType<typeof evidenceSources>>();
  const sources = (messageIndex: number) => {
    let value = messageSources.get(messageIndex);
    if (!value) { value = evidenceSources(raw.messages[messageIndex]); messageSources.set(messageIndex, value); }
    return value;
  };
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
      const source = point && point.kind !== "image" && sources(item.message_index)
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

export type InvestigationValidator = (problem: ProblemProposal, selected: readonly Evidence[], audit: ToolAudit, path: string) => ValidationIssue[];

/** One synchronous validation pass shares a verified directory; nothing survives the pass. */
export function investigationValidator(request: AgentRequest): InvestigationValidator {
  let validate: InvestigationValidator | undefined;
  return (...args) => {
    validate ??= prepareInvestigation(request);
    return validate(...args);
  };
}

function prepareInvestigation(request: AgentRequest): InvestigationValidator {
  const directoryIssues = businessChainDirectoryIssues(request);
  const raw = request.sources.answer.value as { messages: unknown[] };
  const answer = request.input.answer as { transitions: AttributionTransition[]; execution_nodes: import('./transitions.js').AttributionExecutionNode[]; component_catalog: import('@eval/tools').TraceComponentIdentity[]; final_message_index: number };
  const transitions = answer.transitions;
  const expected = buildAttributionTransitions({ raw, inputId: request.sources.answer.id, finalIndex: answer.final_message_index,
    actors: answer.component_catalog, chains: businessChainDirectory(request) });
  if (canonical(transitions) !== canonical(expected) || canonical(answer.execution_nodes) !== canonical(buildAttributionExecutionNodes(raw, answer.component_catalog)))
    directoryIssues.push({category: 'evidence', code: 'transition_directory',
      path: '/answer/transitions', message: '执行转换须由真实请求、返回与实际输入重新构建，不能改写主体或传递关系。'});
  if (directoryIssues.length) return () => [...directoryIssues];
  return (problem, selected, audit, path) => {
  const issues: ValidationIssue[] = [];
  const add = (code: string, location: string, message: string, expected?: unknown) =>
    issues.push({ category: 'evidence', code, path: location, message, ...(expected === undefined ? {} : { expected }) });
  const boundaryText = (boundary: TransitionBoundary) => {
    const point = parseEvidenceCoordinates(boundary.evidence_id);
    if (!point || point.kind === 'image') return undefined;
    return evidenceSources(raw.messages[point.message_index]).find(source => source.kind === point.kind && source.path === point.path)
      ?.text.slice(point.start, point.end);
  };
  const byId = new Map(transitions.map(item => [item.transition_index, item]));
  const proofById = new Map(selected.map(item => [item.evidence_id, item]));
  const checks = new Map<number, ProblemProposal['checks'][number]>();
  const executionRead = (transition_index: number, view: 'before' | 'after' | 'predecessors') =>
    ({ candidate: 'answer', view, transition_index, offset: 0 });
  const navigation = (transition: AttributionTransition) => ({transition_index: transition.transition_index, kind: transition.kind,
    before: {count: transition.before.length, read_execution: executionRead(transition.transition_index, 'before')},
    after: {count: transition.after.length, read_execution: executionRead(transition.transition_index, 'after')}});
  const matches = (item: Evidence, boundaries: TransitionBoundary[]) => !item.source && boundaries.some(boundary => overlaps(item, boundary, raw));
  const evidenceNavigation = (proof: Evidence, transition: AttributionTransition) => {
    const candidates = transitions.flatMap(item => {
      const matched_sides = (['before', 'after'] as const).filter(side => matches(proof, item[side]));
      return matched_sides.length ? [{ transition_index: item.transition_index, kind: item.kind, matched_sides,
        read_execution: { candidate: 'answer', view: 'boundaries', transition_index: item.transition_index } }] : [];
    });
    const position = audit.evidenceBank?.indexOf(proof.evidence_id) ?? -1;
    return { ...navigation(transition), mismatched_reference: { evidence_id: proof.evidence_id },
      matching_boundaries: { total: candidates.length, candidates: candidates.slice(0, 4), has_more: candidates.length > 4,
        ...(position < 0 ? {} : { read_execution: { candidate: 'answer', view: 'boundaries', evidence_index: position + 1, offset: 0 } }) } };
  };
  for (const [index, check] of problem.checks.entries()) {
    const location = `${path}/checks/${index}`, transition = byId.get(check.transition_index);
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
          add('investigation_boundary_evidence', location, '引用必须属于本问题及所选转换的这一侧；按该证据实际关联的候选边界核查，候选关联不代表责任判定。',
            proof ? evidenceNavigation(proof, transition) : navigation(transition)); continue;
        }
        const point = parseEvidenceCoordinates(proof.evidence_id);
        if (point?.kind === 'image' && !audit.viewedImages.includes(`answer:${point.message_index}`))
          add('investigation_image_required', location, '图片边界必须实际view_image，文字引用或目录坐标不代表已查看。',
            {view_request:{candidate:'answer',message_index:point.message_index}});
        const read = target(proof);
        if (read && !attributionReadCovered(audit, read, raw)) add('investigation_read_required', location,
          '核查引用的原文尚未实际读取；按受保护必读补齐本段后继续判断。', read);
      }
    }
  }
  const coverage = new Map<string, boolean>();
  const contains = (boundary: TransitionBoundary, proof: Evidence) => {
    const key = `${boundary.evidence_id}:${proof.evidence_id}`;
    if (!coverage.has(key)) coverage.set(key, evidenceCovers(raw, request.sources.answer.id, boundary.evidence_id, proof.evidence_id));
    return coverage.get(key)!;
  };
  for (const [index, cause] of problem.causes.entries()) {
    const location = `${path}/causes/${index}`, transition = byId.get(cause.transition_index);
    if (!transition) { add('responsibility_transition', location, '责任须选择本方已登记的真实执行转换。'); continue; }
    if (cause.actor_index !== transition.actor_index)
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
    if (transition.kind === 'delivery' && cause.role === 'primary' && transition.before.some(before => transition.after.some(after => boundaryText(before) !== undefined && boundaryText(before) === boundaryText(after))))
      add('responsibility_formation', location, '实际生成与交付内容相同，不能把已存在的错误归为交付时形成。');
    if (cause.role !== 'primary' || transition.kind !== 'generation') continue;
    if (!check.before_evidence_ids.length || !check.after_evidence_ids.length || !['input_deviation','independent_addition'].includes(cause.basis))
      add('responsibility_generation_boundary', location, '生成主责须引用实际输入和实际生成输出，证明输入后首次偏离或生成独立新增无据事实。');
    // Follow the claim's paired boundary evidence. A model's whole input history is
    // not a dependency declaration for every fact it later emits.
    const relevantPredecessors = (current: AttributionTransition, evidence: Evidence[]) => {
      const candidates = current.predecessors.map(id => byId.get(id)!);
      const related = new Set<number>();
      for (const proof of evidence) {
        const overlapping = candidates.filter(item => matches(proof, item.after));
        const exact = overlapping.filter(item => item.after.some(boundary => contains(boundary, proof)));
        if (overlapping.length && !exact.length) add('responsibility_evidence_scope', location,
          '所引整块材料跨过来源边界；请按当前问题的对象、字段、单位、期间或执行状态收窄原文引用，再关联实际传递。不能用整段历史触发全部前驱核查。',
          { transition_index: current.transition_index, read_execution: executionRead(current.transition_index, 'before') });
        for (const item of exact) related.add(item.transition_index);
      }
      return [...related];
    };
    const beforeProof = (row: ProblemProposal['checks'][number] | undefined) =>
      row?.before_evidence_ids.flatMap(id => proofById.has(id) ? [proofById.get(id)!] : []) ?? [];
    const inputProof = beforeProof(check);
    const roots = relevantPredecessors(transition, inputProof);
    const required = new Set<number>(), queue = [...roots];
    while (queue.length) {
      const id = queue.pop()!;
      if (required.has(id)) continue;
      required.add(id);
      const upstream = byId.get(id)!, upstreamCheck = checks.get(id);
      // A tool return is audited against its real request. Earlier model inputs
      // are followed only when the corresponding check identifies their evidence.
      const previous = upstream.kind === 'execution' || upstream.kind === 'transfer' && !upstreamCheck ? upstream.predecessors
        : upstreamCheck ? relevantPredecessors(upstream, beforeProof(upstreamCheck)) : [];
      queue.push(...previous);
    }
    // A captured upstream path cannot be bypassed by citing only an unrelated user sentence and the output.
    if (transition.predecessors.length && !roots.length)
      add('responsibility_upstream_required', location, '本问题所引实际输入尚未关联可核查的上游来源；核对该段的来源与传递，缺失关联须保留真实断点，不能用其他无关前驱凑核查或直接归生成主责。',
        {transition_index:transition.transition_index, upstream_choices:{count:transition.predecessors.length,
          read_execution:executionRead(transition.transition_index, 'predecessors')}});
    for (const id of required) {
      const upstream = byId.get(id)!;
      if (!checks.has(id)) add('responsibility_upstream_required', location,
        '所引事实的上游转换尚未核查。检查对象、字段、单位、期间和执行状态，分别说明保持、偏离、恢复或真实断点；不能从最后错误位置直接归责。', navigation(upstream));
    }
    for (const id of transition.predecessors.filter(id => required.has(id))) {
      const incoming = byId.get(id)!;
      if (!inputProof.some(item => matches(item, incoming.after))) add('responsibility_generation_boundary', location,
        '生成主责的实际输入证据须包含所追查来源进入本调用的对应材料，不能用无关用户问题替代。', navigation(incoming));
    }
    const unrecovered = (): boolean => {
      const visited = new Set<number>(), pending = [...transition.predecessors];
      while (pending.length) {
        const id = pending.pop()!;
        if (!required.has(id) || visited.has(id)) continue;
        visited.add(id);
        const outcome = checks.get(id)?.outcome;
        if (outcome === 'recovered') continue;
        if (outcome === 'changed' || outcome === 'unresolved') return true;
        pending.push(...(byId.get(id)?.predecessors ?? []));
      }
      return false;
    };
    if (cause.basis === 'input_deviation' && unrecovered())
      add('responsibility_generation_formation', location, '相关上游已存在改变或尚未解决的断点，不能声称完整正确输入后首次偏离。核对因果关系；若生成有独立新增错误，应明确该独立作用和替代解释。');
  }
  issues.push(...validateDerivations(problem.calculations ?? [], id => proofById.get(id), path + '/calculations'));
  return issues;
  };
}

/** Standalone checks also verify their directory against original source records. */
export function investigationIssues(request: AgentRequest, problem: ProblemProposal, selected: readonly Evidence[], audit: ToolAudit, path: string): ValidationIssue[] {
  return investigationValidator(request)(problem, selected, audit, path);
}
