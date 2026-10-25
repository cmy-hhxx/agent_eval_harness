import test from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceBankSources } from "@eval/contracts";
import { cite, evidenceSources, selectEvidenceSource } from "@eval/tools";
import { businessChains } from "./business-chains.js";

test("financial return navigation retains failure status and execution identity beside rows",()=>{
  const id="19b0f4da-601f-46d2-83bc-1adec8758217";
  for(const [status_code,status_msg]of [[0,'ok'],[-2601,'SQL取数异常']] as const){
    const raw={messages:[{role:'user',content:'查询 FIX 持仓权重'},
      {type:'tool_call',name:'finquery',call_id:'q',input:{query:'FIX holding weight'}},
      {type:'tool_result',name:'finquery',call_id:'q',output:{query:'FIX holding weight',columns:[],datas:[],row_count:0,
        status_code,status_msg,model_sql:"holding_code='FIX.N'",data_sql:"holding_ticker='FIX.N'"}},
      {type:'llm_turn',name:'llm-call-0',input_messages:[{role:'user',content:'FIX: row_count=0'}],output:[{role:'assistant',content:'未查到权重。'}]},
      {type:'final_answer',content:'未查到权重。'}]};
    const chain=businessChains(raw,id,4)[0],returned=chain.checkpoints[3].evidence;
    for(const field of ['status_code','status_msg','row_count','model_sql','data_sql']){
      const range=selectEvidenceSource(evidenceSources(raw.messages[2]),'/output/'+field)!;
      const expected=cite(id,2,range.source,range.start,Math.min(range.end,range.start+1600));
      assert(returned.some(item=>item.evidence_id===expected.evidence_id),field);
    }
    assert(returned.some(item=>item.quote.includes(status_msg)));
    const actual=chain.checkpoints[5].evidence.map(item=>item.quote).join('\n');
    assert(actual.includes('row_count=0'));assert(!actual.includes(status_msg));
    validateEvidenceBankSources(returned.map(item=>item.evidence_id),new Map([[id,raw]]));
  }
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
  assert(returned.reduce((total, item) => total + item.quote.length, 0) <= 4800);
  validateEvidenceBankSources(chains.flatMap(chain => chain.checkpoints.flatMap(point =>
    point.evidence.map(item => item.evidence_id))), new Map([[id, raw]]));
  assert.deepEqual(raw, before);
});
