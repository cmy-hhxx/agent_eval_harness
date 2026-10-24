import { randomUUID } from "node:crypto";
import type { ToolDefinition, ToolContext, ReviewCase, ReviewAudit, ReviewQuote } from "@eval/contracts";
import { calculateExpression } from "./decimal.js";
import { createWebReader } from "./web-reader.js";

const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
const text = { type: "string", minLength: 1 };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
export function reviewCase(context: Pick<ToolContext,"inputs">): ReviewCase {
  const value = context.inputs.get("case") as ReviewCase;
  if (!value?.case_id || !value.evidence) throw new Error("当前任务没有评审材料");
  return value;
}
export function reviewAudit(context: Pick<ToolContext,"audit">): ReviewAudit {
  return context.audit.review ??= { quotes: [], sources: [], actions: [], viewed: [], searches: [] };
}
export function reviewSources(value: ReviewCase, audit?: ReviewAudit) {
  return { ...value.evidence, ...Object.fromEntries((audit?.sources ?? []).map(row => [row.id, row.content])) };
}
function exactQuote(context: ToolContext, sourceId: string, quote: string): ReviewQuote {
  const audit = reviewAudit(context), source = reviewSources(reviewCase(context), audit)[sourceId];
  if (!source || !quote) throw new Error("引用来源或原文为空");
  const index = source.indexOf(quote);
  if (index < 0 || source.indexOf(quote, index + 1) !== -1) throw new Error("引文须在来源中唯一且连续；扩大引文以消歧");
  const start = Array.from(source.slice(0, index)).length, end = start + Array.from(quote).length;
  const existing = audit.quotes.find(row => row.source_id === sourceId && row.start === start && row.end === end);
  if (existing) return existing;
  const row = { evidence_id: `EV_${audit.quotes.length + 1}`, source_id: sourceId, start, end, quote };
  audit.quotes.push(row); return row;
}
function admit(context: ToolContext, content: string, record: Record<string, unknown>, prefix: string) {
  const row = { id: `${prefix}_${randomUUID()}`, content, record };
  reviewAudit(context).sources.push(row);
  return { source_id: row.id, content, record };
}
const roles = { enum: ["as_of_information", "retrospective_fact_check", "normative_reference"] };
const materialProperties={action:{enum:["inspect","read","search","quote"]},source_id:text,text,
  start:{type:"integer",minimum:0},length:{type:"integer",minimum:1,maximum:12000}};
export const reviewTools: Omit<ToolDefinition,"description">[] = [{
  name: "review_material",
  inputSchema: schema({...materialProperties,action:{enum:["inspect","read","search","quote","batch"]},
    operations:{type:"array",minItems:1,maxItems:32,items:schema(materialProperties,["action"])}},["action"]),
  async execute(context, input, signal) {
    const batch=input as {action:string;operations?:Record<string,unknown>[]};
    if(batch.action==='batch'){
      if(!batch.operations?.length||batch.operations.length>32||batch.operations.some(row=>!['inspect','read','search','quote'].includes(String(row.action))))throw Error('批量操作须为1–32个独立材料操作');
      const results=[];
      for(const operation of batch.operations){
        try{const result=await reviewTools[0].execute(context,operation,signal);results.push({ok:true,...result.details as object});}
        catch(error){results.push({ok:false,action:operation.action,source_id:operation.source_id,error:String(error)});}
      }
      return output({results});
    }
    const args = input as { action: string; source_id?: string; text?: string; start?: number; length?: number };
    const material = reviewCase(context), sources = reviewSources(material, reviewAudit(context));
    if (args.action === "inspect") return output({ case_id: material.case_id, availability: material.availability,external_search_available:Boolean(process.env.SEARCH_API_KEY),
      sources: Object.entries(sources).map(([source_id, content]) => ({ source_id, length: Array.from(content).length })) });
    if (args.action === "quote") return output(exactQuote(context, args.source_id!, args.text!));
    if (args.action === "read") {
      if (!Object.hasOwn(sources, args.source_id!)) throw new Error("来源编号不存在");
      const chars = Array.from(sources[args.source_id!]), start = args.start ?? 0, end = Math.min(chars.length, start + (args.length ?? 6000));
      return output({ source_id: args.source_id, start, end, content: chars.slice(start, end).join(""), next_start: end < chars.length ? end : null });
    }
    if (!args.text) throw new Error("检索词不能为空");
    const matches: unknown[] = [];
    for (const [source_id, value] of Object.entries(sources)) {
      if (args.source_id && args.source_id !== source_id) continue;
      let from = 0;
      while (matches.length < 20) {
        const index = value.indexOf(args.text, from); if (index < 0) break;
        const prefix = Array.from(value.slice(0, index)).length, chars = Array.from(value);
        const start = Math.max(0, prefix - 100), end = Math.min(chars.length, prefix + Array.from(args.text).length + 200);
        matches.push({ source_id, start, end, text: chars.slice(start, end).join("") }); from = index + args.text.length;
      }
    }
    return output({ matches });
  },
}, {
  name: "review_calculate",
  inputSchema: schema({ operation: { enum: ["arithmetic", "range", "suffix"] }, inputs: { type: "object", minProperties: 1,
    additionalProperties: schema({ evidence_id: text, quote: text, number_token: text, text_token: text, role: text, unit: { type: "string" } }, ["evidence_id","quote","role","unit"]) },
    expression: text, result_unit: { type: "string" }, include_lower: { type: "boolean" }, include_upper: { type: "boolean" }, suffix_length: { type: "integer", minimum: 1 } }, ["operation","inputs","result_unit"]),
  async execute(context, value) {
    const args = value as { operation: string; inputs: Record<string,{evidence_id:string;quote:string;number_token?:string;text_token?:string;role:string;unit:string}>; expression?: string; result_unit:string;include_lower?:boolean;include_upper?:boolean;suffix_length?:number };
    const numbers: Record<string,string> = {};
    for (const [name, row] of Object.entries(args.inputs)) {
      exactQuote(context, row.evidence_id, row.quote);
      const token = row.number_token ?? row.text_token;
      if (!token || row.quote.indexOf(token) < 0 || row.quote.indexOf(token, row.quote.indexOf(token)+1) >= 0) throw new Error("输入值须唯一来自所引原文");
      numbers[name] = token;
    }
    let result: unknown;
    if (args.operation === "arithmetic") result = calculateExpression(args.expression!, numbers);
    else if (args.operation === "suffix") result = { text: Array.from(numbers.text).slice(-args.suffix_length!).join("") };
    else {
      if (args.include_lower === undefined || args.include_upper === undefined) throw new Error("区间必须明确两侧是否包含边界");
      const lo = calculateExpression("value-lower", numbers).exact_fraction, hi = calculateExpression("value-upper", numbers).exact_fraction;
      result = { in_range: (args.include_lower ? BigInt(lo.numerator) >= 0n : BigInt(lo.numerator) > 0n) && (args.include_upper ? BigInt(hi.numerator) <= 0n : BigInt(hi.numerator) < 0n) };
    }
    const record = { record_type: "calculation", spec: args, result, result_unit: args.result_unit };
    return output(admit(context, JSON.stringify(record, null, 2), record, "V_CALC"));
  },
}, {
  name: "review_external",
  inputSchema: schema({ action: { enum: ["search", "read", "admit_search"] }, query: text, url: text, search_id: text,
    result_index: {type:"integer",minimum:0}, claim: text, affected_item_ids:{type:"array",items:text,minItems:1}, verification_role:roles,
    start_line: {type:"integer",minimum:1}, page:{type:"integer",minimum:1} }, ["action","claim","affected_item_ids","verification_role"]),
  async execute(context, value, signal) {
    const args = value as Record<string, any>, audit = reviewAudit(context);
    const urls = new Set(audit.sources.flatMap(row => typeof row.record.url === "string" ? [row.record.url] : []));
    const recordAction = (kind: string, parameters: unknown) => {
      if (audit.actions.length >= 6) throw new Error("已用完本题6个外部动作；保留未核实范围");
      const action: ReviewAudit["actions"][number] = { kind, args: parameters, at: new Date().toISOString() }; audit.actions.push(action); return action;
    };
    const register = (url: string, content: string, metadata: Record<string,unknown>) => {
      if (!urls.has(url) && urls.size >= 3) throw new Error("已登记3个关键来源URL；保留未核实范围");
      return admit(context, content, { record_type:"external_source",url,retrieved_at:new Date().toISOString(),
        claim:args.claim,affected_item_ids:args.affected_item_ids,verification_role:args.verification_role,...metadata }, "V_SRC");
    };
    if (args.action === "admit_search") {
      const search = audit.searches.find(row => row.id === args.search_id);
      const rows = search?.result.organic as Record<string,unknown>[] | undefined, row = rows?.[args.result_index];
      if (!row || typeof row.link !== "string") throw new Error("须选择实际搜索返回中的来源");
      return output(register(row.link, JSON.stringify(row,null,2), { obtained_by:"review_external.search", acquisition_ref:search!.id, scope:"search_snippet",publication_date:row.date ?? null }));
    }
    if (args.action === "search") {
      if (!process.env.SEARCH_API_KEY) throw new Error("宿主没有配置搜索工具；相关事实保留unverified");
      const action = recordAction("search",{query:args.query});
      try {
        const response = await fetch("https://google.serper.dev/search",{method:"POST",headers:{"content-type":"application/json","X-API-KEY":process.env.SEARCH_API_KEY},body:JSON.stringify({q:args.query,num:5}),signal});
        if (!response.ok) throw new Error(`搜索返回HTTP ${response.status}`);
        const result = await response.json() as Record<string,unknown>, id = randomUUID(); action.result = result;
        audit.searches.push({id,result}); return output({search_id:id,result,external_actions_used:audit.actions.length});
      } catch(error){action.error=String(error);throw error;}
    }
    if (!args.url || !urls.has(args.url) && urls.size >= 3) throw new Error("读取需要URL且不能超过3个关键来源");
    const actions: ReviewAudit["actions"] = [];
    try {
      const reader = createWebReader({ beforeRequest: url => { actions.push(recordAction("read",{url,request:args})); } });
      const result = await reader.read({url:args.url,startLine:args.start_line,lineCount:120,page:args.page},signal);
      for (const action of actions) action.result = {url:args.url,format:result.format};
      return output(register(args.url, JSON.stringify(result,null,2), {obtained_by:"review_external.read",scope:"actual_tool_return",response:result}));
    } catch(error){for(const action of actions)action.error=String(error);throw error;}
  },
}];
