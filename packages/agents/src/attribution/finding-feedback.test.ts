import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError, type ToolAudit } from "@eval/contracts";
import { attributionAgent,type AttributionResult } from "./index.js";
import { attributionSubmission,setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { prepareFixtureEvidence } from "../../../../tests/fixtures/evidence.js";
import example from "./fixtures/example.json" with {type:"json"};
function fixture(){const request=structuredClone(example.request);setFixtureNormDirectory(request);const audit:ToolAudit={calls:0,requiredReadCalls:0,viewedImages:[],traceReads:[],calculations:[],artifacts:[],evidenceBank:[]};
 return {request,audit,registry:new AgentRegistry([attributionAgent]),binding:{agent:"attribution",profile:"default",request},
 draft:attributionSubmission(request,example.result as AttributionResult,audit)};}
test("saved draft submission keeps a shallow schema with numeric directory selections",()=>{
 const f=fixture(),prepared=prepareFixtureEvidence(f.registry,f.binding),schema=prepared.evaluation.outputSchema as any;
 assert.equal(prepared.evaluation.fileSubmission,false);assert(schema.properties.strengths.items.properties.evidence_indices);
 assert(!schema.properties.strengths.items.properties.assessment);assert(!schema.properties.strengths.items.properties.problem);
});
test("missing flat fields receive the exact current writable field shape",()=>{
 const f=fixture();Reflect.deleteProperty(f.draft.strengths[0],"reason");
 assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>{
  assert(error instanceof ValidationError);const issue=error.issues!.find(item=>item.path==='/strengths/0/reason'&&item.code==='schema_required')!;
  assert.deepEqual((issue.expected as any).target,{path:'/strengths/0/reason'});
  assert.equal((issue.expected as any).submission_shape.type,'string');return true;
 });
});
test("an unavailable evidence number reports the submitted field and available directory range",()=>{
 const f=fixture();f.draft.strengths[0].evidence_indices=[99999];
 assert.throws(()=>f.registry.resolve(f.binding,f.draft,f.audit),error=>{
  assert(error instanceof ValidationError);assert(error.issues!.some(item=>item.path==='/strengths/0/evidence_indices/0'&&item.code==='evidence_selection_invalid'));return true;
 });
});
test("a malformed numeric row returns structural feedback without crashing independent checks",()=>{
 const f=fixture(),draft={...f.draft,numeric_checks:[null]},before=structuredClone(draft);
 assert.throws(()=>f.registry.resolve(f.binding,draft,f.audit),error=>{
  assert(error instanceof ValidationError);
  assert(error.issues!.some(issue=>issue.code==="schema_type"&&issue.path==="/numeric_checks/0"));
  return true;
 });
 assert.deepEqual(draft,before);
});
