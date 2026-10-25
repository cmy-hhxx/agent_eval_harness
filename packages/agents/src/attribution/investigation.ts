import { canonical, type AgentRequest, type ToolAudit, type TraceRead, type ValidationIssue } from "@eval/contracts";
import { attributionTaxonomy } from "@eval/prompts";
import { evidenceCovers, evidenceSources, parseEvidenceCoordinates, selectEvidenceSource, traceCallOrigins, traceExchanges, traceReadCoverage } from "@eval/tools";
import type { BusinessChain, Evidence, ProblemEvidence, ProblemProposal } from "./types.js";
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

export type InvestigationValidator = (problem: ProblemProposal, selected: readonly ProblemEvidence[], audit: ToolAudit, path: string) => ValidationIssue[];

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
  const byId = new Map(transitions.map(item => [item.transition_index, item]));
  const proofById = new Map(selected.map(item => [item.evidence_id, item]));
  for (const item of selected) {
    const point=parseEvidenceCoordinates(item.evidence_id), read=target(item);
    if(point?.kind==='image'&&!audit.viewedImages.includes(`answer:${point.message_index}`))
      add('investigation_image_required',path+'/evidence','图片证据须实际查看，文字观察不能代替查看记录。');
    if(read&&!item.source&&!attributionReadCovered(audit,read,raw))
      add('investigation_read_required',path+'/evidence','所选证据可读但未读取，使用受保护补读。',{read_requests:[read]});
  }
  const evidenceRows = selected;
  const matches = (proof: Evidence, boundaries: TransitionBoundary[]) => !proof.source &&
    boundaries.some(boundary => boundary.evidence_id === proof.evidence_id || evidenceCovers(raw, request.sources.answer.id, boundary.evidence_id, proof.evidence_id));
  const navigation = (transition: AttributionTransition, side: 'before'|'after'|'predecessors' = 'before') => ({
    transition_index:transition.transition_index,
    read_execution:{candidate:'answer',view:side,transition_index:transition.transition_index,offset:0},
  });
  if(!evidenceRows.some(e=>e.purposes.includes('问题')))
    add('problem_evidence_required',path+'/evidence','至少选择证明被评主张或行为缺陷的原始证据，用途为问题。');
  const rows=[{...problem,evidence_ids:evidenceRows.filter(e=>e.purposes.includes('归因')).map(e=>e.evidence_id)},
    ...(problem.related_responsibilities??[])];
  for(const [index,responsibility] of rows.entries()){
    if(responsibility.responsibility_boundary===null)continue;
    const location=index?path+'/related_responsibilities/'+(index-1):path;
    const transition=byId.get(responsibility.responsibility_boundary);
    if(!transition)continue; // identity validation reports this once
    const proof=responsibility.evidence_ids.flatMap(id=>proofById.has(id)?[proofById.get(id)!]:[]);
    const before=proof.filter(e=>matches(e,transition.before)),after=proof.filter(e=>matches(e,transition.after));
    for(const side of ['before','after'] as const){
      const chosen=side==='before'?before:after;
      if(transition[side].length&&!chosen.length)add('investigation_boundary_evidence',location+'/evidence',
        '归责须引用本问题相关的实际输入和输出；已采集侧不能写成未知。选择对应原文证据并标记归因用途。',navigation(transition,side));
      if(!transition[side].length&&!responsibility.uncertainties?.length)
        add('investigation_missing_boundary',location+'/uncertainties','该侧过程未采集，保留真实断点；不能把机制推测写成已证实。',navigation(transition,side));
    }
    if(transition.kind==='delivery'&&before.some(b=>after.some(a=>b.quote===a.quote)))
      add('responsibility_formation',location,'生成内容与交付相同；正常交付不能成为该问题的形成责任。请定位实际参数或正文生成边界。');
    if(!['generation','request_formation'].includes(transition.kind))continue;
    // Check only the selected input's immediate provenance. We do not demand a
    // per-ancestor checklist or infer preserved/changed/recovered judgments.
    for(const input of before){
      const related=transition.predecessors.flatMap(id=>{
        const incoming=byId.get(id);return incoming&&matches(input,incoming.after)?[incoming]:[];
      });
      if(!related.length){
        const overlapping=transition.predecessors.some(id=>byId.get(id)?.after.some(b=>overlaps(input,b,raw)));
        if(overlapping)add('responsibility_evidence_scope',location+'/evidence',
          '输入引用跨越多个来源；收窄到本问题的对象、字段、期间或执行状态，不调查无关历史。',navigation(transition));
        continue; // directly supplied user material has no upstream tool boundary
      }
      for(const incoming of related){
        if(incoming.before.length&&!proof.some(e=>matches(e,incoming.before))){
          add('responsibility_upstream_required',location+'/evidence',
            '实际输入已关联到上游来源；补充本问题对应的原始来源证据，不重复填写逐节点检查表。',navigation(incoming));
        }
      }
    }
  }
  issues.push(...validateDerivations(problem.calculations ?? [], id => proofById.get(id), path + '/calculations'));
  return issues;
  };
}

/** Standalone checks also verify their directory against original source records. */
export function investigationIssues(request: AgentRequest, problem: ProblemProposal, selected: readonly ProblemEvidence[], audit: ToolAudit, path: string): ValidationIssue[] {
  return investigationValidator(request)(problem, selected, audit, path);
}
