import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, type AttributionResult } from "./index.js";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { attributionSubmission } from "../../../../tests/fixtures/attribution-submission.js";
import { businessChainDirectoryIssues, investigationIssues } from "./investigation.js";
import { bindAttributionMaterial } from "@eval/workflows/review";
import { evidenceSources } from "@eval/tools";
const codes = (f: ReturnType<typeof businessChainFixture>) => investigationIssues(f.binding.request, f.problem, f.evidence, f.audit, "/problem").map(issue => issue.code);

test('generation primary requires its own boundary check and every relevant upstream check',()=>{
 const f=businessChainFixture(); assert.deepEqual(codes(f),[]);
 const complete=structuredClone(f.problem.investigation);
 f.problem.investigation=[]; assert(codes(f).includes('responsibility_check_required'));
 f.problem.investigation=complete.filter(check=>check.transition_index===f.generated.transition_index);
 assert(codes(f).includes('responsibility_upstream_required'));
 f.problem.investigation=complete;
 assert.deepEqual(codes(f),[]);
});
test('a correct source and execution are checked without assigning them responsibility',()=>{
 const f=businessChainFixture(), registry=new AgentRegistry([attributionAgent]);
 const result=registry.resolve(f.binding,attributionSubmission(f.binding.request,f.result,f.audit),f.audit) as AttributionResult;
 registry.validate(f.binding,result,f.audit);
 assert.equal(result.findings[0].problem!.component.length,1);
 assert.equal(result.findings[0].problem!.component[0].transition_index,f.generated.transition_index);
 assert.equal(result.findings[0].problem!.component[0].certainty,'inferred');
 assert(result.findings[0].problem!.investigation.some(check=>check.kind==='execution'&&check.outcome==='preserved'));
});
test('boundary differences do not certify a hidden model action',()=>{
 const f=businessChainFixture(); f.cause.certainty='confirmed';
 assert(codes(f).includes('responsibility_mechanism_inferred'));
 f.cause.mechanism_source='explicit_process';
 assert(codes(f).includes('responsibility_mechanism_source'));
});
test('available unread boundaries request real protected reads',()=>{
 const f=businessChainFixture(); f.audit.traceReads=[];
 const issues=investigationIssues(f.binding.request,f.problem,f.evidence,f.audit,'/problem');
 assert(issues.some(issue=>issue.code==='investigation_read_required'));
 for(const issue of issues.filter(issue=>issue.code==='investigation_read_required')) {
  const target=issue.expected as {start:number;end:number}; assert(target.end>target.start);
 }
});
test('read coverage cannot let an input quote impersonate the actual return',()=>{
 const f=businessChainFixture(), execution=f.problem.investigation.find(check=>check.kind==='execution')!;
 execution.after_evidence_ids=f.problem.investigation.find(check=>check.transition_index===f.generated.transition_index)!.before_evidence_ids;
 assert(codes(f).includes('investigation_boundary_evidence'));
});
test('serialized complete source reads cover decoded text without duplicate mandatory reading',()=>{
 const f=businessChainFixture();
 f.audit.traceReads=f.raw.messages.map((message,message_index)=>{
  const source=evidenceSources(message).find(source=>source.kind==='json'&&source.path==='')!;
  return {candidate:'answer',message_index,kind:'json' as const,path:'',start:0,end:source.text.length};
 });
 assert.deepEqual(codes(f),[]);
});
test('preserved and recovered transitions cannot be relabeled as causes without a defect',()=>{
 for(const outcome of ['preserved','recovered'] as const){
  const f=businessChainFixture();f.problem.investigation.find(check=>check.transition_index===f.generated.transition_index)!.outcome=outcome;
  assert(codes(f).includes('responsibility_formation'));
 }
});
test('mechanical transition identity cannot be forged in the formal result',()=>{
 const f=businessChainFixture(); f.cause.actor_index=null;
 assert(codes(f).includes('responsibility_transition_actor'));
 Object.assign(f.binding.request.input.answer as object,{transitions:[]});
 assert(codes(f).includes('transition_directory'));
});
test('changed upstream material prevents a claim of first deviation after intact input',()=>{
 const f=businessChainFixture();f.problem.investigation.find(check=>check.kind==='transfer')!.outcome='changed';
 assert(codes(f).includes('responsibility_generation_formation'));
 f.cause.basis='independent_addition';assert(!codes(f).includes('responsibility_generation_formation'));
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
