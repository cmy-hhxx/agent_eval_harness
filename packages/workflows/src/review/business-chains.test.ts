import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceBankSources } from "@eval/contracts";
import { cite, evidenceSources, selectEvidenceSource } from "@eval/tools";
import { businessChains } from "./business-chains.js";
import { getAnswerGeneration } from "./answer-generation.js";

test("financial return navigation retains failure status and execution identity beside rows",()=>{
  const id="19b0f4da-601f-46d2-83bc-1adec8758217";
  for(const [status_code,status_msg]of [[0,'ok'],[-2601,'SQL取数异常'],[-2601,'SQL取数异常'.repeat(400)]] as const){
    const raw={messages:[{role:'user',content:'查询 FIX 持仓权重'},
      {type:'tool_call',name:'finquery',call_id:'q',input:{query:'FIX holding weight'}},
      {type:'tool_result',name:'finquery',call_id:'q',output:{query:'FIX holding weight',columns:[],datas:[],row_count:0,
        status_code,status_msg,model_sql:"holding_code='FIX.N'",data_sql:"holding_ticker='FIX.N'"}},
      {type:'llm_turn',name:'llm-call-0',input_messages:[{role:'user',content:'FIX: row_count=0'}],output:[{role:'assistant',content:'未查到权重。'}]},
      {type:'final_answer',content:'未查到权重。'}]};
    const chain=businessChains(raw,id,4)[0],returned=chain.checkpoints[3].evidence;
    for(const field of ['status_code','status_msg','row_count','model_sql','data_sql']){
      const range=selectEvidenceSource(evidenceSources(raw.messages[2]),'/output/'+field)!;
      const expected=cite(id,2,range.source,range.start,range.end);
      assert(returned.some(item=>item.evidence_id===expected.evidence_id),field);
    }
    assert(returned.some(item=>item.quote.includes(status_msg)));
    assert.deepEqual(chain.checkpoints[5].evidence,[],"a similar summary without a source identity is not a proven transfer");
    assert.deepEqual(chain.context_indices,[]);
    assert.equal(getAnswerGeneration(raw,id,4)?.input_contexts[0].message_index,3,"unlinked actual input remains independently navigable");
    validateEvidenceBankSources(returned.map(item=>item.evidence_id),new Map([[id,raw]]));
  }
});

test("pure generated rendering arguments stay attached to their actual request and return",()=>{
  const id="19b0f4da-601f-46d2-83bc-1adec8758217",command='render --title "P/E vs drawdown" --series "P/E"';
  const generated={role:'assistant',content:'',tool_calls:[{id:'render',type:'function',function:{name:'shell',arguments:JSON.stringify({command})}}]};
  const output={action_id:'draw001',stdout:JSON.stringify({type:'vis-html',id:'chart-1'})};
  const raw={messages:[{role:'user',content:'Compare the stocks'},
    {type:'llm_turn',input_messages:[{role:'user',content:'Compare the stocks'}],output:[generated]},
    {type:'tool_call',name:'shell',call_id:'render',input:{command}},
    {type:'tool_result',name:'shell',call_id:'render',output},
    {type:'llm_turn',input_messages:[generated,{role:'tool',tool_call_id:'render',content:JSON.stringify(output)}],
      output:[{role:'assistant',content:'Chart. <vis-html ref="chart-1"/>'}]},
    {type:'final_answer',content:[{type:'output_text',text:'Chart.'},{type:'output_image',image_url:'data:image/png;base64,AA=='}]}]};
  const chain=businessChains(raw,id,5)[0];
  assert.equal(chain.planner_index,1);assert.equal(chain.request_index,2);assert.deepEqual(chain.return_indices,[3]);
  assert(chain.checkpoints[1].evidence.some(e=>e.message_index===1&&e.evidence_id.endsWith('/output/0/tool_calls/0/function/arguments')&&e.quote.includes(command.replaceAll('"','\\"'))));
  assert.deepEqual(chain.context_indices,[4],"the parameter creator is not a consumer of its later return");
  assert(chain.checkpoints[5].evidence.some(e=>e.message_index===4&&e.quote.includes('chart-1')));
  assert(chain.checkpoints[6].evidence.some(e=>e.message_index===4&&e.quote.includes('<vis-html')));
  validateEvidenceBankSources(chain.checkpoints.flatMap(p=>p.evidence.map(e=>e.evidence_id)),new Map([[id,raw]]));
});

test("financial truncated projection remains a boundary without importing unrelated final inputs",()=>{
  const id="19b0f4da-601f-46d2-83bc-1adec8758217",query='XOM MA50 support resistance';
  const projection='Financial data you fetched:\nfinquery_result:\nserial_number: xom0001\nquery: '+query+'\nrow_count: 1\nis_truncated: true\n\n|Closing Price|\n|183.22|\n';
  const raw={messages:[{role:'user',content:'XOM outlook'},
    {type:'tool_call',name:'finquery',call_id:'q',input:{query}},
    {type:'tool_result',name:'finquery',call_id:'q',output:{query,columns:[{key:'MA50'}],datas:[{MA50:165.7899,Support:157.95,Resistance:169.635}]}},
    {type:'llm_turn',input_messages:[{role:'user',content:projection},{role:'tool',content:'unrelated sector data'}],
      output:[{role:'assistant',content:'170–172 is MA50 support. <trace ref="xom0001"/>'}]},
    {type:'final_answer',content:'170–172 is MA50 support. <trace ref="xom0001"/>'}]};
  const chain=businessChains(raw,id,4)[0];
  assert.deepEqual(chain.context_indices,[3]);
  assert(chain.checkpoints[3].evidence.some(e=>e.quote.includes('165.7899')));
  assert(chain.checkpoints[5].evidence.some(e=>e.quote.includes('is_truncated: true')));
  assert(chain.checkpoints[5].evidence.every(e=>!e.quote.includes('165.7899')&&!e.quote.includes('unrelated sector data')));
});

test("separate return consumers and their verbatim summaries do not mix sibling chains",()=>{
  const id="19b0f4da-601f-46d2-83bc-1adec8758217";
  const a={role:'assistant',content:'Alpha summary'},b={role:'assistant',content:'Beta summary'};
  const raw={messages:[{role:'user',content:'Compare'},
    {type:'tool_call',name:'lookup',call_id:'a',input:{}},
    {type:'tool_result',name:'lookup',call_id:'a',output:{action_id:'alpha01',stdout:'Alpha return'}},
    {type:'tool_call',name:'lookup',call_id:'b',input:{}},
    {type:'tool_result',name:'lookup',call_id:'b',output:{action_id:'beta001',stdout:'Beta return'}},
    {type:'llm_turn',input_messages:[{role:'tool',content:JSON.stringify({action_id:'alpha01',stdout:'Alpha return'})}],output:[a]},
    {type:'llm_turn',input_messages:[{role:'tool',content:'Beta return'}],output:[b]},
    {type:'llm_turn',input_messages:[a,b],output:[{role:'assistant',content:'Compared'}]},
    {type:'final_answer',content:'Compared'}]};
  const chains=businessChains(raw,id,8);
  assert.deepEqual(chains.map(c=>c.context_indices),[[5,7],[6,7]]);
  for(const [index,excluded]of [[0,'Beta'],[1,'Alpha']] as const){
    assert(chains[index].checkpoints[4].evidence.every(e=>!e.quote.includes(excluded)));
    assert(chains[index].checkpoints[5].evidence.every(e=>!e.quote.includes(excluded)));
  }
});

test("identical unlabelled tool bodies do not guess which return was consumed",()=>{
  const id="19b0f4da-601f-46d2-83bc-1adec8758217";
  const raw={messages:[{role:'user',content:'Check'},
    {type:'tool_call',name:'lookup',call_id:'a',input:{}},{type:'tool_result',name:'lookup',call_id:'a',output:'ok'},
    {type:'tool_call',name:'lookup',call_id:'b',input:{}},{type:'tool_result',name:'lookup',call_id:'b',output:'ok'},
    {type:'llm_turn',input_messages:[{role:'tool',content:'ok'}],output:[{role:'assistant',content:'Done'}]},
    {type:'final_answer',content:'Done'}]};
  assert(businessChains(raw,id,6).every(chain=>!chain.context_indices.length&&!chain.checkpoints[5].evidence.length));
});

test("multimodal tool returns expose original text without citing image placeholders", () => {
  const id = "19b0f4da-601f-46d2-83bc-1adec8758217";
  const raw = { messages: [
    { role: "user", content: "查看图表" },
    { type: "tool_call", name: "chart", call_id: "chart-call", arguments: {} },
    { type: "tool_result", name: "chart", call_id: "chart-call", output: [
      { text: "<referencable-result>\nID: 30\n", type: "input_text" },
      { text: "<image width=700 height=720>", type: "input_text" },
      { detail: "low", image_url: "data:image/png;base64,AA==", type: "input_image" },
      { text: "</image width=700 height=720>", type: "input_text" },
      { text: "原始图表说明。".repeat(1000), type: "input_text" },
      { text: "</referencable-result>", type: "input_text" },
    ] },
    { role: "assistant", content: "图表已展示。" },
  ] };
  const before = structuredClone(raw), chains = businessChains(raw, id, 3);
  const returned = chains[0]!.checkpoints[3]!.evidence;
  assert(returned.length > 0, "captured return text remains available");
  assert(returned.some(item => item.quote.includes("ID: 30")));
  assert(returned.some(item => item.quote.includes("原始图表说明")));
  assert(returned.some(item => item.quote === raw.messages[2].output![4].text), "navigation limits must not truncate the boundary used by validation");
  validateEvidenceBankSources(chains.flatMap(chain => chain.checkpoints.flatMap(point =>
    point.evidence.map(item => item.evidence_id))), new Map([[id, raw]]));
  assert.deepEqual(raw, before);
});
