import { object, parseEvidenceCoordinates, resolveEvidenceSelection, type ToolDefinition } from "@eval/contracts";
import { evidenceOverlaps } from "./evidence-coverage.js";
import { cite, evidenceSources } from "./evidence.js";

type View = "nodes" | "boundaries" | "before" | "after" | "predecessors" | "successors" | "table_checks";
interface NavigationArgs {
  candidate: string; view: View; execution_node_index?: number; transition_index?: number;
  message_index?: number; evidence_index?: number; query?: string; kind?: string; path?: string; offset?: number; limit?: number; max_chars?: number;
}
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const indexes = (value: unknown): number[] => Array.isArray(value) ? value as number[] : [];
const positive = { type: "integer", minimum: 1 };
const nonnegative = { type: "integer", minimum: 0 };

/** Count the serialized navigation page, including the count itself (UTF-16 units). */
export function countNavigationPage(page: Record<string, unknown>): void {
  page.returned_chars = 0;
  let chars = JSON.stringify(page).length;
  while (page.returned_chars !== chars) {
    page.returned_chars = chars;
    chars = JSON.stringify(page).length;
  }
}

export const readExecutionTool: Omit<ToolDefinition, "description"> = {
  name: "read_execution",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["candidate", "view"],
    properties: {
      candidate: { type: "string", minLength: 1 },
      view: { enum: ["nodes", "boundaries", "before", "after", "predecessors", "successors", "table_checks"] },
      execution_node_index: positive, transition_index: positive, message_index: nonnegative, evidence_index: positive,
      kind: { enum: ["request_formation", "execution", "transfer", "generation", "delivery"] },
      path: { type: "string" },
      query: { type: "string", minLength: 1, maxLength: 200 }, offset: nonnegative,
      limit: { type: "integer", minimum: 1, maximum: 20 },
      max_chars: { type: "integer", minimum: 1, maximum: 16000 },
    },
  },
  async execute(ctx, value) {
    const args = value as NavigationArgs;
    const inputId = ctx.inputIds.get(args.candidate);
    if (!ctx.inputs.has(args.candidate) || !inputId || !ctx.materialNavigation?.[args.candidate])
      throw new Error("candidate 必须选择本任务已登记的执行导航材料");
    const material = object(ctx.materialNavigation[args.candidate]);
    const nodes = rows(material.nodes), boundaries = rows(material.boundaries);
    const choices = rows(material.responsibility_choices);
    const choiceByIndex = new Map(choices.map(choice=>[choice.transition_index,choice]));
    const nodeByIndex = new Map(nodes.map(node => [node.execution_node_index, node]));
    const action = (boundary: Record<string, unknown>) => ({ request_formation: '生成工具调用参数', execution: '执行工具请求',
      generation: '生成回答正文', transfer: '传递上下文', delivery: '交付最终回答' })[String(boundary.kind) as 'generation'];
    const related = (boundary: Record<string, unknown>, node: number) =>
      [boundary.execution_node_index, boundary.source_node_index, boundary.target_node_index].includes(node);
    const request = (view: View, selectors: Partial<NavigationArgs>) => ({
      tool: "read_execution", arguments: { candidate: args.candidate, view, ...selectors },
    });
    const nodeIds = args.message_index === undefined ? [] : nodes.filter(node => node.message_index === args.message_index)
      .map(node => node.execution_node_index as number);
    if (args.execution_node_index !== undefined && !nodes.some(node => node.execution_node_index === args.execution_node_index))
      throw new Error("execution_node_index 不在当前候选的执行目录中");
    const selected = args.transition_index === undefined ? undefined : boundaries.find(boundary => boundary.transition_index === args.transition_index);
    if (args.transition_index !== undefined && !selected) throw new Error("transition_index 不在当前候选的边界目录中");
    const adjacent = ["before", "after", "predecessors", "successors"].includes(args.view);
    if (adjacent && !selected) throw new Error("此 view 必须指定 transition_index");
    if (args.query !== undefined && args.view !== "nodes") throw new Error("query 仅搜索 nodes 的短名称和摘要；正文请用 search_trace");
    if ((adjacent || args.view === "table_checks") && args.execution_node_index !== undefined)
      throw new Error("此 view 不接受执行节点或消息筛选；请使用对应边界入口");
    if (["predecessors", "successors", "table_checks"].includes(args.view) && args.message_index !== undefined)
      throw new Error("此 view 不接受 message_index 筛选");
    if (args.kind !== undefined && !["boundaries", "predecessors", "successors"].includes(args.view))
      throw new Error("kind 仅筛选 boundaries / predecessors / successors");
    if (args.path !== undefined && !["before", "after"].includes(args.view))
      throw new Error("path 仅筛选 before / after 的精确证据路径");
    if (args.evidence_index !== undefined && args.view !== "boundaries")
      throw new Error("evidence_index 仅筛选 boundaries 的真实关联证据");
    if (["nodes", "table_checks"].includes(args.view) && args.transition_index !== undefined)
      throw new Error("此 view 不接受 transition_index");
    const selectedEvidence = args.evidence_index === undefined ? undefined : resolveEvidenceSelection(ctx.audit.evidenceBank ?? [],
      { evidence_index: args.evidence_index }, "/evidence_index").evidence_id;
    const point = selectedEvidence === undefined ? undefined : parseEvidenceCoordinates(selectedEvidence)!;
    if (point && point.input_id !== inputId) throw new Error("evidence_index 不属于当前 candidate");
    const overlapCache = new Map<string, boolean>();
    const matchesEvidence = (item: Record<string, unknown>) => {
      if (!point || !selectedEvidence || typeof item.evidence_id !== "string") return false;
      const cached = overlapCache.get(item.evidence_id);
      if (cached !== undefined) return cached;
      const other = parseEvidenceCoordinates(item.evidence_id);
      const sameSource = other && other.input_id === inputId && other.message_index === point.message_index;
      const matches = !!sameSource && (point.kind === "image" || other.kind === "image"
        ? point.kind === other.kind
        : (point.kind !== other.kind || point.path === other.path) &&
          evidenceOverlaps(ctx.inputs.get(args.candidate) as { messages: unknown[] }, inputId, selectedEvidence, item.evidence_id));
      overlapCache.set(item.evidence_id, matches);
      return matches;
    };
    const matchedSides = (boundary: Record<string, unknown>) => (["before", "after"] as const)
      .filter(side => rows(boundary[side]).some(matchesEvidence));
    const summary = (boundary: Record<string, unknown>) => ({
      transition_index: boundary.transition_index, responsibility_boundary:`boundary:${boundary.transition_index}`, kind: boundary.kind, actor_index: boundary.actor_index,
      action: action(boundary), component: choiceByIndex.get(boundary.transition_index)?.component ?? nodeByIndex.get(boundary.execution_node_index)?.component ?? null,
      message_index: nodeByIndex.get(boundary.execution_node_index)?.message_index ?? null,
      execution_node_index: boundary.execution_node_index, source_node_index: boundary.source_node_index,
      target_node_index: boundary.target_node_index, input_path: boundary.input_path, relation: boundary.relation,
      ...(selectedEvidence === undefined ? {} : { matched_sides: matchedSides(boundary) }),
      before_count: rows(boundary.before).length, after_count: rows(boundary.after).length,
      predecessor_count: indexes(boundary.predecessors).length,
      successor_count: boundaries.filter(other => indexes(other.predecessors).includes(boundary.transition_index as number)).length,
      requests: Object.fromEntries((["before", "after", "predecessors", "successors"] as const)
        .map(view => [view, request(view, { transition_index: boundary.transition_index as number })])),
    });
    const evidence = (boundary: Record<string, unknown>) => {
      const id = boundary.evidence_id;
      const point = typeof id === "string" ? parseEvidenceCoordinates(id) : undefined;
      if (!point || point.input_id !== inputId || point.message_index !== boundary.message_index ||
        (point.kind !== "image" && point.end <= point.start)) throw new Error("执行目录含无效或跨候选的证据坐标");
      const base = { message_index: point.message_index, reference: { evidence_id: id } };
      return point.kind === "image" ? { ...base,
        read_request: { tool: "view_image", arguments: { candidate: args.candidate, message_index: point.message_index } } } : {
        ...base, kind: point.kind, path: point.path, start_offset: point.start, end_offset: point.end,
        read_request: { tool: "read_trace", arguments: { candidate: args.candidate, message_index: point.message_index,
          path: point.path, offset: point.start, max_chars: Math.min(16000, point.end - point.start) } },
      };
    };
    let items: Record<string, unknown>[], render: (item: Record<string, unknown>) => unknown = item => item;
    if (args.view === "nodes") {
      const query = args.query?.toLocaleLowerCase();
      items = nodes.filter(node => (args.execution_node_index === undefined || node.execution_node_index === args.execution_node_index) &&
        (args.message_index === undefined || node.message_index === args.message_index) &&
        (query === undefined || [node.component, node.summary].some(text => typeof text === "string" && text.toLocaleLowerCase().includes(query))));
      render = node => ({ execution_node_index: node.execution_node_index, kind: node.kind, actor_index: node.actor_index,
          message_index: node.message_index, component: node.component, ...(node.summary === undefined ? {} : { summary: node.summary }),
          responsibility_choices: boundaries.filter(boundary => boundary.execution_node_index === node.execution_node_index)
            .map(boundary => ({ transition_index: boundary.transition_index, responsibility_boundary:`boundary:${boundary.transition_index}`, action: action(boundary), ...(choiceByIndex.has(boundary.transition_index)?{component:choiceByIndex.get(boundary.transition_index)!.component}:{}) })),
          boundary_count: boundaries.filter(boundary => related(boundary, node.execution_node_index as number)).length,
          read_request: request("boundaries", { execution_node_index: node.execution_node_index as number }),
        });
    } else if (args.view === "boundaries") {
      items = boundaries.filter(boundary => (!selected || boundary === selected) &&
        (selectedEvidence === undefined || matchedSides(boundary).length > 0) &&
        (args.kind === undefined || boundary.kind === args.kind) &&
        (args.execution_node_index === undefined || related(boundary, args.execution_node_index)) &&
        (args.message_index === undefined || nodeIds.some(node => related(boundary, node)) ||
          [...rows(boundary.before), ...rows(boundary.after)].some(item => item.message_index === args.message_index)));
      render = summary;
    } else if (args.view === "before" || args.view === "after") {
      items = rows(selected![args.view]).filter(item => (args.message_index === undefined || item.message_index === args.message_index) &&
        (args.path === undefined || (() => {
          const point = typeof item.evidence_id === "string" ? parseEvidenceCoordinates(item.evidence_id) : undefined;
          return point && point.kind !== "image" && point.path === args.path;
        })())); render = evidence;
    } else if (args.view === "predecessors") {
      items = boundaries.filter(boundary => indexes(selected!.predecessors).includes(boundary.transition_index as number) &&
        (args.kind === undefined || boundary.kind === args.kind)); render = summary;
    } else if (args.view === "successors") {
      items = boundaries.filter(boundary => indexes(boundary.predecessors).includes(args.transition_index!) &&
        (args.kind === undefined || boundary.kind === args.kind)); render = summary;
    } else items = rows(material.table_checks);
    const offset = args.offset ?? 0, limit = args.limit ?? 8;
    if (offset > items.length) throw new Error(`offset 超出当前目录范围 0—${items.length}`);
    const cap = Math.min(args.max_chars ?? 8000, ctx.policy.maxOutputChars);
    const shown = items.slice(offset, offset + limit).map(render);
    const page = (end: number) => {
      const hasMore = end < items.length;
      const result = { candidate: args.candidate, view: args.view, total: items.length, offset,
        next_offset: hasMore ? end : null, has_more: hasMore,
        next_request: hasMore ? request(args.view, { ...args, offset: end }) : null,
        items: shown.slice(0, end - offset), returned_chars: 0 };
      countNavigationPage(result);
      return result;
    };
    let end = Math.min(items.length, offset + limit), result = page(end);
    while (result.returned_chars > cap && end > offset) result = page(--end);
    if (result.returned_chars > cap || (end === offset && offset < items.length))
      throw new Error("本次 max_chars 无法容纳一个完整导航项；请增大 max_chars（最多 16000）或缩小筛选范围");
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  },
};

const chainSchema = {
  type: "object", additionalProperties: false, required: ["candidate", "transition_index"],
  properties: { candidate: { type: "string", minLength: 1 }, transition_index: positive, max_chars: { type: "integer", minimum: 1, maximum: 16000 } },
} as const;

/** One call returns the request, return, actual input and output around a boundary. */
export const readResponsibilityChainTool: Omit<ToolDefinition, "description"> = {
  name: "read_responsibility_chain",
  inputSchema: chainSchema,
  async execute(ctx, value) {
    const args = value as { candidate: string; transition_index: number; max_chars?: number };
    const inputId = ctx.inputIds.get(args.candidate);
    if (!ctx.inputs.has(args.candidate) || !inputId || !ctx.materialNavigation?.[args.candidate])
      throw new Error("candidate 必须选择本任务已登记的执行导航材料");
    const material = object(ctx.materialNavigation[args.candidate]);
    const boundaries = rows(material.boundaries), nodes = rows(material.nodes), choices = rows(material.responsibility_choices);
    const selected = boundaries.find(item => item.transition_index === args.transition_index);
    if (!selected) throw new Error("transition_index 不在当前候选的边界目录中");
    const records = ctx.inputs.get(args.candidate) as { messages: unknown[] };
    const choice = choices.find(item => item.transition_index === args.transition_index);
    const bank = ctx.audit.evidenceBank ?? (ctx.audit.evidenceBank = []);
    const register = (id: string) => {
      const existing = bank.indexOf(id);
      if (existing >= 0) return existing + 1;
      bank.push(id);
      return bank.length;
    };
    const items = (value: unknown, chars: { used: number; limit: number }): Record<string, unknown>[] => rows(value).flatMap((item): Record<string, unknown>[] => {
      if (typeof item.evidence_id !== "string" || !Number.isSafeInteger(item.message_index)) return [];
      const point = parseEvidenceCoordinates(item.evidence_id);
      if (!point || point.kind === "image") return [];
      const source = evidenceSources(records.messages[point.message_index]).find(source => source.kind === point.kind && source.path === point.path);
      if (!source) return [];
      const quoteEnd = Math.min(point.end, point.start + (ctx.maxEvidenceQuoteChars ?? point.end - point.start));
      const excerpt = cite(inputId, point.message_index, source, point.start, quoteEnd);
      const quote = excerpt.quote;
      const remaining = Math.max(0, chars.limit - chars.used);
      const repair = point.end > quoteEnd ? { next_read_request: { tool: "read_trace", arguments: {
        candidate: args.candidate, message_index: point.message_index, path: point.path, offset: quoteEnd, max_chars: 400 } } } : {};
      if (!remaining) return [{ evidence_index: register(excerpt.evidence_id), message_index: point.message_index, kind: point.kind, path: point.path,
        start: point.start, end: quoteEnd, quote_chars: quote.length, ...(point.end > quoteEnd ? { total_quote_chars: point.end - point.start } : {}),
        truncated: true, ...repair }];
      const shown = quote.slice(0, remaining);
      chars.used += shown.length;
      return [{ evidence_index: register(excerpt.evidence_id), message_index: point.message_index, kind: point.kind, path: point.path,
        start: point.start, end: quoteEnd, quote_chars: quote.length, quote: shown,
        ...(shown.length < quote.length || point.end > quoteEnd ? { truncated: true } : {}),
        ...(point.end > quoteEnd ? { total_quote_chars: point.end - point.start, ...repair } : {}) }];
    });
    const limit = args.max_chars ?? 16000, chars = { used: 0, limit };
    const chainIndex = selected.chain_index;
    const sameChain = chainIndex === null || chainIndex === undefined ? [selected] : boundaries.filter(item => item.chain_index === chainIndex);
    const ofKind = (kind: string) => sameChain.find(item => item.kind === kind);
    const nodeOf = (item: Record<string, unknown> | undefined) => nodes.find(node => node.execution_node_index === item?.execution_node_index);
    const requestFormation = ofKind("request_formation"), execution = ofKind("execution"), transfer = ofKind("transfer"), generation = ofKind("generation");
    const result = {
      transition_index: args.transition_index, kind: selected.kind, chain_index: chainIndex,
      component: choice?.component ?? null, message_index: nodeOf(selected)?.message_index ?? null,
      request: items((requestFormation ?? execution)?.before, chars),
      original_return: items(execution?.after, chars),
      actual_input: items((transfer?.after ?? generation?.before), chars),
      output: items(generation?.after, chars),
      responsibility_choices: choices.filter(item => item.chain_index === chainIndex),
      returned_chars: chars.used,
    };
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  },
};
