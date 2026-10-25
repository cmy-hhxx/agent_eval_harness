import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseEvidenceCoordinates, type ToolAudit } from "@eval/contracts";
import { evidenceSources } from "@eval/tools";
import { bindAttributionMaterial } from "@eval/workflows/review";
import type { Candidate, RawInput } from "@eval/workflows/inputs";
import type { AttributionTransition } from "./transitions.js";
import { responsibilityDisplay } from "./responsibility.js";
import { attributionSubmissionSchema } from "./submission-schema.js";
import { responsibilityBindingIssues, finalResponsibilityReview } from './responsibility-binding.js';

function nativeFixture(loss = false, unrelated = false) {
  const question = "核对XOM的MA50支撑，并给出结论。";
  const query = "XOM MA50 support resistance", returned = { serial_number: "xom-source", query, MA50: 165.7899, support: 162, resistance: 170 };
  const delivered = "XOM的MA50支撑为170–172。";
  const args = { query }, call = { id: "xom-call", type: "function", function: { name: "finquery", arguments: JSON.stringify(args) } };
  const messages: RawInput["messages"] = [{ type: "user_question", role: "user", content: question }];
  if (unrelated) messages.push(
    { type: "llm_turn", name: "天气参数", input_messages: [{ role: "user", content: "查询北京天气。" }], output: [{ role: "assistant", content: "", tool_calls: [{ id: "weather-call", type: "function", function: { name: "weather", arguments: '{"city":"Beijing"}' } }] }] },
    { type: "tool_call", name: "weather", call_id: "weather-call", input: { city: "Beijing" } },
    { type: "tool_result", name: "weather", call_id: "weather-call", output: { city: "Beijing", temperature: 20 } },
  );
  messages.push(
    { type: "llm_turn", name: "XOM取数参数", input_messages: [{ role: "user", content: question }], output: [{ role: "assistant", content: "", tool_calls: [call] }] },
    { type: "tool_call", name: "finquery", call_id: "xom-call", input: args },
    { type: "tool_result", name: "finquery", call_id: "xom-call", output: returned },
    { type: "llm_turn", name: "XOM技术位分析", input_messages: [{ role: "user", content: question }, { role: "tool", tool_call_id: "xom-call", content: JSON.stringify(loss ? { serial_number: returned.serial_number, query, resistance: 170 } : returned) }], output: [{ role: "assistant", content: delivered }] },
    { type: "final_answer", role: "assistant", content: delivered },
  );
  return material(messages, question);
}
function material(messages: RawInput["messages"], question: string) {
  const candidate: Candidate = { batch_id: "native", case_id: "native", version: "aime", name: "aime", input_id: randomUUID(), trace_id: null,
    source: "test", line: 1, question, answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null, source_unit: "s", source_values: {}, source_fields: {} },
    final_index: messages.length - 1, reference: null, llm: null };
  const binding = bindAttributionMaterial(candidate, { messages });
  const transitions = (binding.request.input.answer as { transitions: AttributionTransition[] }).transitions;
  const evidence = [...new Map(transitions.flatMap(item => [...item.before, ...item.after])
    .flatMap(item => {
      const point = parseEvidenceCoordinates(item.evidence_id)!;
      if (point.kind === "image") return [];
      const source = evidenceSources(messages[point.message_index]).find(source => source.kind === point.kind && source.path === point.path)!;
      return [{ ...item, purposes: ['问题','归因'] as ('问题'|'归因')[], quote: source.text.slice(point.start, point.end) }];
    }).map(item => [item.evidence_id, item])).values()];
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], calculations: [], artifacts: [], traceReads: evidence.flatMap(item => {
    const coordinate = parseEvidenceCoordinates(item.evidence_id)!;
    return coordinate.kind === "image" ? [] : [{ candidate: "answer", message_index: coordinate.message_index, kind: coordinate.kind,
      path: coordinate.path, start: coordinate.start, end: coordinate.end }];
  }) };
  return { binding, transitions, evidence, audit };
}

test('parameter creator remains identifiable without prose or hidden reasoning',()=>{
 const f=nativeFixture(),edge=f.transitions.find(t=>t.kind==='request_formation')!;
 const display=responsibilityDisplay(f.binding.request,edge.transition_index);
 assert.equal(display.component,'Expert 推理轮');assert(!Object.hasOwn(display,'responsibility_boundary'));
 assert(!display.component.includes('责任主体未确定'));
});
test('final responsibility recall reads the existing Problem and offers only captured calls',()=>{
 const f=nativeFixture(true,true),edge=f.transitions.find(t=>responsibilityDisplay(f.binding.request,t.transition_index).component==='终稿生成轮')!;
 const problem={text:'均线支撑无依据',reason:'原始返回有均线，实际输入丢失。',attribution_reason:'材料传递中丢失均线字段。',responsibility_boundary:'boundary:'+edge.transition_index};
 const context=finalResponsibilityReview(f.binding.request,{Problem:[problem]},{Problem:[{component:'终稿生成轮',evidence:f.evidence.filter(e=>e.message_index===6)}]},f.audit)!;
 assert.deepEqual((context.problems as any[])[0].Problem,problem);
 const reads=context.read_requests as any[];
 assert(reads?.some(r=>r.message_index===6),'the actual finquery return is mandatory, not the attribution explanation');
 const original=(f.binding.request.sources.answer.value as RawInput).messages;
 assert(reads.filter(r=>r.message_index===6).some(r=>evidenceSources(original[r.message_index]).find(s=>s.kind===r.kind&&s.path===r.path)?.text.slice(r.start,r.end).includes('165.7899')));
 assert(!reads.some(r=>[1,2,3].includes(r.message_index)),'unrelated weather ancestors stay outside the review');
 assert((context.choices as any[]).some(c=>c.component==='finquery 取数服务'));
 assert(!(context.choices as any[]).some(c=>c.component.includes('web_fetch')));
 assert.equal(finalResponsibilityReview(f.binding.request,{Problem:[problem]},{Problem:[{component:'finquery 取数服务'}]},f.audit),undefined);
 assert(responsibilityBindingIssues(f.binding.request,null,f.evidence,f.audit,'/Problem/0').some(i=>i.code==='responsibility_unresolved'));
});
test('responsibility identifiers cannot be confused with valid numeric node indices',()=>{
 const f=nativeFixture(),s=attributionSubmissionSchema(f.binding.request);
 const p=s.properties.Problem.items.properties;
 const field=new Ajv2020({strict:false}).compile(p.responsibility_boundary);
 assert(field('boundary:1'));assert(!field(1));assert(!field('1'));assert(!field('node:1'));
 const validate=new Ajv2020({strict:false}).compile(s);
 assert(!validate({summary:'检查完成。',Problem:[{text:'问题',reason:'依据',evidence_status:'已确认',evidence:[{index:1,purposes:['问题']}],responsibility_boundary:f.transitions.length+1,attribution_reason:'定位依据'}]}));
});
