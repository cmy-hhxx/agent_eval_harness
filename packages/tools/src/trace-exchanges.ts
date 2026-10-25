import {canonical} from '@eval/contracts';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
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
          (typeof id!=='string'||generated.id===id)?[{request_index,planner_index:i,input_path,arguments_path:`/output/${oi}/tool_calls/${ci}/function/arguments`}]:[];});
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
