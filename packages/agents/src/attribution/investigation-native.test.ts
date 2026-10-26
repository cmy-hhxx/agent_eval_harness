import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseEvidenceCoordinates, type ToolAudit } from "@eval/contracts";
import { evidenceSources } from "@eval/tools";
import { bindAttributionMaterial } from "@eval/workflows/review";
import type { Candidate, RawInput } from "@eval/workflows/inputs";
import type { AttributionTransition } from "./transitions.js";
import { responsibilityDisplay, transferChanged } from "./responsibility.js";
import { attributionSubmissionSchema } from "./submission-schema.js";
import { resolveModelSubmission } from "./submission.js";

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
test('responsibility identifiers cannot be confused with valid numeric node indices',()=>{
 const f=nativeFixture(),s=attributionSubmissionSchema(f.binding.request);
 const p=s.properties.Problem.items.properties;
 const field=new Ajv2020({strict:false}).compile(p.responsibility_boundary);
 assert(field('boundary:1'));assert(!field(1));assert(!field('1'));assert(!field('node:1'));
 const validate=new Ajv2020({strict:false}).compile(s);
 assert(!validate({summary:'检查完成。',Problem:[{text:'问题',reason:'依据',evidence_status:'已确认',evidence:[{index:1,purposes:['问题']}],responsibility_boundary:f.transitions.length+1,attribution_reason:'定位依据'}]}));
});

test('shell scripts are split by the actual command on the tool dimension',()=>{
  const run = (command: string) => material([
    { role: 'user', type: 'user_question', content: '执行脚本' },
    { type: 'llm_turn', name: 'llm-call-0', input_messages: [{ role: 'user', content: '执行脚本' }],
      output: [{ role: 'assistant', content: '', tool_calls: [{ id: 'script-call', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command }) } }] }] },
    { type: 'tool_call', name: 'shell', call_id: 'script-call', input: { command } },
    { type: 'tool_result', name: 'shell', call_id: 'script-call', output: { stdout: 'ok', action_id: 'script' } },
    { type: 'llm_turn', name: 'llm-call-1', input_messages: [{ role: 'tool', tool_call_id: 'script-call', content: '{"stdout":"ok"}' }],
      output: [{ role: 'assistant', content: '完成。' }] },
    { type: 'final_answer', role: 'assistant', content: '完成。' },
  ], '执行脚本');
  const component = (command: string) => {
    const f = run(command), edge = f.transitions.find(t => t.kind === 'execution')!;
    return responsibilityDisplay(f.binding.request, edge.transition_index).component;
  };
  assert.equal(component('cd /opt/skills-aime/aime-finquery && python scripts/finquery.py "Stock: XOM"'), 'finquery.py 脚本（经 shell）');
  assert.equal(component('cd /opt/skills-aime/data-visualizer && python render.py chart.json'), 'data-visualizer 图表渲染');
  assert.equal(component('cd /tmp && python calc.py'), 'shell 代码解释器');
});

test('a truncated transfer is selectable while a verbatim transfer is not',()=>{
  const returned = { serial_number: 'long-return', payload: 'x'.repeat(4000) };
  const f = material([
    { role: 'user', type: 'user_question', content: '核对材料' },
    { type: 'tool_call', name: 'finquery', call_id: 'data-call', input: { query: 'X' } },
    { type: 'tool_result', name: 'finquery', call_id: 'data-call', output: returned },
    { type: 'llm_turn', name: 'llm-call-0', input_messages: [{ role: 'tool', tool_call_id: 'data-call', content: JSON.stringify({ serial_number: returned.serial_number, payload: 'x'.repeat(100) }) }],
      output: [{ role: 'assistant', content: '材料完整。' }] },
    { type: 'final_answer', role: 'assistant', content: '材料完整。' },
  ], '核对材料');
  const transfer = f.transitions.find(t => t.kind === 'transfer')!;
  assert.equal(transferChanged(f.binding.request.input.answer as any, f.binding.request.sources.answer.value as any, transfer), true);
  const full = material([
    { role: 'user', type: 'user_question', content: '核对材料' },
    { type: 'tool_call', name: 'finquery', call_id: 'data-call', input: { query: 'X' } },
    { type: 'tool_result', name: 'finquery', call_id: 'data-call', output: returned },
    { type: 'llm_turn', name: 'llm-call-0', input_messages: [{ role: 'tool', tool_call_id: 'data-call', content: JSON.stringify(returned) }],
      output: [{ role: 'assistant', content: '材料完整。' }] },
    { type: 'final_answer', role: 'assistant', content: '材料完整。' },
  ], '核对材料');
  const verbatim = full.transitions.find(t => t.kind === 'transfer')!;
  assert.equal(transferChanged(full.binding.request.input.answer as any, full.binding.request.sources.answer.value as any, verbatim), false);
});

test('an observed truncation can be the primary context-transfer responsibility',()=>{
  const returned = { serial_number: 'ctx-return', payload: 'y'.repeat(4000) };
  const f = material([
    { role: 'user', type: 'user_question', content: '核对材料' },
    { type: 'tool_call', name: 'finquery', call_id: 'ctx-call', input: { query: 'Y' } },
    { type: 'tool_result', name: 'finquery', call_id: 'ctx-call', output: returned },
    { type: 'llm_turn', name: 'llm-call-0', input_messages: [{ role: 'tool', tool_call_id: 'ctx-call', content: JSON.stringify({ serial_number: returned.serial_number, payload: 'y'.repeat(80) }) }],
      output: [{ role: 'assistant', content: '字段不全。' }] },
    { type: 'final_answer', role: 'assistant', content: '字段不全。' },
  ], '核对材料');
  const transfer = f.transitions.find(t => t.kind === 'transfer')!;
  f.audit.evidenceBank = f.evidence.map(item => item.evidence_id);
  const index = 1;
  const draft = { summary: '材料在进入终稿前被截断。', Problem: [{
    text: '终稿称字段不全。', reason: '原始返回完整，实际输入只剩一段。', evidence_status: '已确认',
    evidence: [{ index, purposes: ['问题', '归因'] }], responsibility_boundary: `boundary:${transfer.transition_index}`,
    attribution_reason: '原始返回进入终稿输入时被截断，未能核对完整字段。',
  }] };
  const result = resolveModelSubmission(f.binding.request, draft, f.audit);
  assert.equal(result.Problem[0]!.component, '上下文组装与传递');
  const primary = result.Problem[0]!.responsibility_chain!.find(item => item.role === 'primary')!;
  assert.equal(primary.component, '上下文组装与传递');
  assert.equal(primary.message_index, null);
});
