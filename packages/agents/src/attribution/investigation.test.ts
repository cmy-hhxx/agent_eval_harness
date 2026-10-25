import test from "node:test";
import assert from "node:assert/strict";
import { attributionAgent } from "./index.js";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { businessChainDirectoryIssues, investigationIssues } from "./investigation.js";
import { bindAttributionMaterial } from "@eval/workflows/review";

test('generation responsibility requires actual input/output and relevant source evidence, without checks forms',()=>{
 const f=businessChainFixture(),p=f.result.Problem[0];
 assert.deepEqual(investigationIssues(f.binding.request,p,p.evidence,f.audit,'/Problem/0'),[]);
 const outputOnly=p.evidence.filter(e=>f.generated.after.some(b=>b.evidence_id===e.evidence_id));
 assert(investigationIssues(f.binding.request,p,outputOnly,f.audit,'/Problem/0').some(i=>i.code==='investigation_boundary_evidence'));
 assert(investigationIssues(f.binding.request,p,p.evidence,{...f.audit,traceReads:[]},'/Problem/0').some(i=>i.code==='investigation_read_required'));
});
test('full serialized reads cover decoded text without duplicate reading',()=>{
 const f=businessChainFixture(),p=f.result.Problem[0];
 const audit={...f.audit,traceReads:f.raw.messages.map((m,message_index)=>({candidate:'answer',message_index,kind:'json' as const,path:'',start:0,end:JSON.stringify(m,null,2).length}))};
 assert.deepEqual(investigationIssues(f.binding.request,p,p.evidence,audit,'/Problem/0'),[]);
});
test("English renderer finance sources retain identity, price and exact coordinates without indexing private metadata", () => {
  const f = businessChainFixture(), answer = f.binding.request.input.answer as any;
  const source = answer.citation_inventory.references.find((item: any) => item.reference === "pfJtupL");
  assert.equal(source.status, "resolved"); assert(source.sources.some((s: any) => s.origin === "model_visible" && s.quote.includes("SPDR Gold Shares") && s.quote.includes("369")));
  assert(!JSON.stringify(answer.business_chains).includes("SYS_PRIVATE"));
  assert(!JSON.stringify(answer.citation_inventory).includes("PRIVATE_NOT_A_SOURCE"));
  const shown = JSON.stringify(f.binding.modelInput);
  assert(shown.includes("read_request"));
  // The same query in a second request has no unique return link; never pair by adjacency.
  f.raw.messages.splice(3, 0, structuredClone(f.raw.messages[2]));
  (f.raw.messages[3] as any).call_id = "another-call";
  const rebuilt = bindAttributionMaterial({ ...f.candidate, final_index: f.candidate.final_index + 1 }, f.raw);
  assert.deepEqual((rebuilt.request.input.answer as any).business_chains[0].return_indices, [4]);
});

test("wide financial rows navigate identity and the declared latest price field instead of an arbitrary serialized prefix", () => {
  const f = businessChainFixture(), returned = f.raw.messages[3].output as any;
  returned.datas[0] = { ...Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`A-padding-${index}`, index])), ...returned.datas[0] };
  const binding = bindAttributionMaterial(f.candidate, f.raw);
  const chain = (binding.request.input.answer as any).business_chains[0];
  const proof = chain.checkpoints.find((point: any) => point.step === "原始返回及字段含义").evidence;
  assert(proof.some((item: any) => item.quote === "GLD.P"));
  assert(proof.some((item: any) => item.quote === "SPDR Gold Shares"));
  assert(proof.some((item: any) => /"Closing Price\[20261022\]":\s*369/u.test(item.quote)));
});

test("a nameless tool keeps its catalog identity gap instead of displaying an invented name", () => {
  const f = businessChainFixture();
  delete f.raw.messages[2].name; delete f.raw.messages[3].name;
  const binding = bindAttributionMaterial(f.candidate, f.raw), answer = binding.request.input.answer as any;
  const actor = answer.component_catalog.find((actor: any) => actor.kind === "tool" && actor.message_indices.includes(2));
  assert.equal(answer.business_chains[0].tool_component, actor.component);
  assert(!["undefined", "query-call"].includes(actor.component));
  assert.deepEqual(businessChainDirectoryIssues(binding.request), []);
  answer.business_chains[0].tool_component = "finquery";
  assert(businessChainDirectoryIssues(binding.request).length);
});

test("an explicitly empty return remains readable process evidence instead of an invalid zero-length mandatory range", () => {
  const f = businessChainFixture(); f.raw.messages[3].output = "";
  const binding = bindAttributionMaterial(f.candidate, f.raw), chain = (binding.request.input.answer as any).business_chains[0];
  const returned = chain.checkpoints.find((point: any) => point.step === "原始返回及字段含义");
  assert.equal(returned.availability, "available");
  assert(returned.evidence.some((item: any) => /"output":\s*""/u.test(item.quote)));
  assert(attributionAgent.profiles.default.requiredReads!(binding.request).every(read => read.end > read.start));
  assert.deepEqual(businessChainDirectoryIssues(binding.request), []);
});
