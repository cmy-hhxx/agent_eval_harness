import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ROOT} from '../../fixtures/services.js';

test('the language CLI counts null strength fields as inapplicable and reports problem failures at physical JSONL lines',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'attribution-language-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'attribution.jsonl');
  const row=(type:string,trace_id:string,label:unknown=null,definition:unknown=null)=>({trace_id,task_id:trace_id,summary:'回答完成了核心任务。',
    findings:[{type,text:'结果准确。',reason:'原文支持该结果。',problem:type==='strength'?null:{label,definition}}]});
  const source=JSON.stringify(row('strength','strength-trace'))+'\n\n'+JSON.stringify(row('problem','empty-problem'))+'\n'+
    JSON.stringify(row('problem','english-problem','Calculation error','The calculation is wrong.'))+'\n';
  await writeFile(file,source);
  const args=[path.join(ROOT,'dist/apps/host/src/attribution-language-check.js'),'--input',file];
  const valid=JSON.parse((await promisify(execFile)(process.execPath,[...args,'--limit','1'])).stdout);
  assert.equal(valid.checked_rows,1);assert.equal(valid.failed_rows,0);assert.equal(valid.fields.label.not_applicable,1);assert.equal(valid.fields.definition.not_applicable,1);
  let failed:any;try{await promisify(execFile)(process.execPath,args);}catch(error){failed=error;}
  assert.equal(failed?.code,2);const report=JSON.parse(failed.stdout);
  assert.equal(report.checked_rows,3);assert.equal(report.failed_rows,2);
  assert.deepEqual(report.failures.map((f:any)=>[f.line,f.trace_id]),[[3,'empty-problem'],[4,'english-problem']]);
  assert.deepEqual(report.fields.label,{passed:0,failed:2,not_applicable:1});
  assert.equal(await readFile(file,'utf8'),source,'checking does not change results or trigger evaluation');
});
