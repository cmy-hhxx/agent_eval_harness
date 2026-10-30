import {canonical} from '@eval/contracts';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
/** Execution locators are not business actor names. */
export function isComponentLocator(value: string): boolean {
  return /^llm[-_]?call[-_: /]/iu.test(value) ||
    /^(?:span|trace|call|request|invocation|session|run|node|agent)[-_: /](?:\d+|[a-f\d-]{8,})$/iu.test(value) ||
    /^\d+$/u.test(value) ||
    /^(?:[a-f\d]{8,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu.test(value) ||
    /^ev_/u.test(value);
}
const isReturn = (message: Row) => ["tool_result", "function_call_output"].includes(String(message.type)) || message.role === "tool" ||
  message.type === "span" && String(message.name).startsWith("tool-");
export interface TraceExchange {
  request_index: number;
  return_indices: number[];
  planner_index: number | null;
  link_basis: "call_id" | "returned_query" | "end_time";
}

/** Actual generated arguments, not a nearby model or a copy in its input history. */
export function traceCallOrigins(messages:unknown[]){
  const decode=(value:unknown)=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return undefined;}};
  return messages.flatMap((value,request_index)=>{
    const call=row(value);if(!['tool_call','function_call'].includes(String(call.type)))return [];
    const id=call.call_id??call.id,parents=messages.flatMap((value,i)=>{
      const model=row(value);return i<request_index&&model.type==='llm_turn'&&
        (typeof call.parent_span==='string'?model.parent_span===call.parent_span:typeof id==='string')?[{model,i}]:[];
    });
    if(typeof id!=='string'&&parents.length!==1)return [];
    const input_path=Object.hasOwn(call,'input')?'/input':'/arguments',input=decode(call.input??call.arguments);
    if(input===undefined)return [];
    const matches=parents.flatMap(({model,i})=>(Array.isArray(model.output)?model.output:[]).flatMap((value,oi)=>{
      const output=row(value),calls=Array.isArray(output.tool_calls)?output.tool_calls:[];
      return calls.flatMap((value,ci)=>{const generated=row(value),fn=row(generated.function),arguments_=decode(fn.arguments);
        return fn.name===call.name&&arguments_!==undefined&&canonical(arguments_)===canonical(input)&&
          (typeof id!=='string'||generated.id===id)?[{request_index,planner_index:i,input_path,arguments_path:`/output/${oi}/tool_calls/${ci}/function/arguments`,
            call_id:typeof generated.id==='string'?generated.id:undefined}]:[];});
    }));
    return matches.length===1?matches:[];
  });
}

/** Correlate actual invocations; adjacency and a shared tool name alone are not links. */
export function traceExchanges(messages: unknown[]): TraceExchange[] {
  const calls = messages.flatMap((value, index) => {
    const m = row(value);
    return ["tool_call", "function_call"].includes(String(m.type)) ? [{ index, m }] : [];
  });
  const found = new Map<number, TraceExchange>();
  const returnEvents = new Map<string, number>();
  for(const value of messages){
    const message=row(value);
    if(isReturn(message)&&typeof message.name==='string'&&typeof message.end==='string'&&message.end.trim()){
      const key=canonical([message.name,message.end]);returnEvents.set(key,(returnEvents.get(key)??0)+1);
    }
  }
  messages.forEach((value, index) => {
    const m = row(value);
    if (!isReturn(m)) return;
    const id = m.call_id ?? m.tool_call_id, returned = row(m.output ?? m.result);
    if(typeof id!=='string'&&typeof returned.query!=='string'&&
      (typeof m.end!=='string'||!m.end.trim()||typeof m.name!=='string'||returnEvents.get(canonical([m.name,m.end]))!==1))return;
    const matches = calls.filter(call => call.index < index && (!m.name || call.m.name === m.name) &&
      (typeof id === "string" ? [call.m.call_id, call.m.id].includes(id)
        : typeof returned.query === "string" ? row(call.m.input ?? call.m.arguments).query === returned.query
        : typeof m.end==='string'&&typeof m.name==='string'&&call.m.end===m.end));
    if (matches.length !== 1) return;
    const call = matches[0], parents = typeof call.m.parent_span === "string" ? messages.flatMap((v, i) => {
      const p = row(v); return i < call.index && p.type === "llm_turn" && p.parent_span === call.m.parent_span ? [i] : [];
    }) : [];
    const exchange = found.get(call.index) ?? { request_index: call.index, return_indices: [],
      planner_index: parents.length === 1 ? parents[0] : null, link_basis: typeof id === "string" ? "call_id" : typeof returned.query==='string'?"returned_query":"end_time" };
    exchange.return_indices.push(index); found.set(call.index, exchange);
  });
  return [...found.values()].sort((a, b) => a.request_index - b.request_index);
}

/** Input edges locate associated tool messages, without asserting unchanged content or model uptake. */
export function traceExecutionLinks(messages: unknown[]) {
  const origins = traceCallOrigins(messages);
  const callIds = new Map<number, Set<string>>();
  messages.forEach((value, index) => {
    const call = row(value);
    if (["tool_call", "function_call"].includes(String(call.type)))
      callIds.set(index, new Set([call.call_id, call.id].filter((id): id is string => typeof id === "string")));
  });
  for (const origin of origins) if (origin.call_id) callIds.get(origin.request_index)?.add(origin.call_id);
  const owners = new Map<string, Set<number>>();
  for (const [index, ids] of callIds) for (const id of ids) {
    const indices = owners.get(id) ?? new Set<number>(); indices.add(index); owners.set(id, indices);
  }
  type Input = { message_index: number; path: string };
  type Group = Input & { additional_input_locations?: Input[] };
  const byId = new Map<string, (Input & { name?: unknown; content: unknown; recipient: string })[]>();
  messages.forEach((value, message_index) => {
    const message = row(value), input = message.input_messages;
    const context = Array.isArray(input) ? input : row(input).messages;
    if (message.type !== "llm_turn" || !Array.isArray(context)) return;
    const nameKey = ["agent_name", "node_name", "service_name", "tool_name", "name"].find(key =>
      typeof message[key] === "string" && !isComponentLocator(String(message[key])));
    const recipient = canonical([nameKey ? message[nameKey] : null, message.model ?? null,
      nameKey || typeof message.model === "string" ? null : message_index]);
    context.forEach((value, index) => {
      const returned = row(value), id = returned.tool_call_id ?? returned.call_id;
      if (returned.role !== "tool" || typeof id !== "string" || !owners.has(id) || !Object.hasOwn(returned, "content")) return;
      const entries = byId.get(id) ?? [];
      entries.push({ message_index, path: `/input_messages${Array.isArray(input) ? "" : "/messages"}/${index}/content`,
        name: returned.name, content: returned.content, recipient });
      byId.set(id, entries);
    });
  });
  return traceExchanges(messages).map(exchange => {
    const call = row(messages[exchange.request_index]);
    const entries = [...callIds.get(exchange.request_index) ?? []].filter(id => owners.get(id)?.size === 1)
      .flatMap(id => byId.get(id) ?? []).filter(input => input.message_index > Math.max(...exchange.return_indices) &&
        (!input.name || input.name === call.name)).sort((a, b) => a.message_index - b.message_index);
    const groups = new Map<string, Map<unknown, Group>>(), inputs: Group[] = [];
    for (const entry of entries) {
      const contents = groups.get(entry.recipient) ?? new Map<unknown, Group>(); groups.set(entry.recipient, contents);
      const location = { message_index: entry.message_index, path: entry.path }, existing = contents.get(entry.content);
      if (existing) (existing.additional_input_locations ??= []).push(location);
      else { contents.set(entry.content, location); inputs.push(location); }
    }
    return { ...exchange, model_inputs: inputs };
  });
}
