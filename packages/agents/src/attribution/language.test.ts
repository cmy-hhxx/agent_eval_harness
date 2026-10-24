import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAttributionLanguage} from './language.js';

const finding=(type='strength',label:unknown=null,definition:unknown=null)=>({type,problem:type==='strength'?null:{label,definition},text:'回答给出了正确结果。',reason:'计算过程与结果相符。'});
const result=(value:unknown)=>checkAttributionLanguage({summary:'本条回答已完成任务。',findings:[value]});

test('strength null descriptors are explicitly inapplicable, while its prose is still checked',()=>{
  const checked=result(finding());assert.deepEqual(checked.issues,[]);
  assert.deepEqual(checked.checks.filter(c=>c.status==='not_applicable').map(c=>c.path),['/findings/0/problem/label','/findings/0/problem/definition']);
  assert.equal(result({...finding(),text:'The answer is correct.'}).issues[0].path,'/findings/0/text');
});
test('problem descriptors must be nonempty Chinese; null is not a language exemption',()=>{
  assert.deepEqual(result(finding('problem','计算错误','计算中使用了错误数值。')).issues,[]);
  for(const value of [null,undefined,'','   ','Calculation error']){
    const checked=result({...finding('problem'),problem:{label:value,definition:value}});assert.equal(checked.issues.length,2);
    assert.equal(checked.checks.filter(c=>c.status==='not_applicable').length,0);
  }
});
test('missing problem shape is invalid instead of implicitly becoming an applicable descriptor',()=>{
  assert.equal(result({...finding(),problem:undefined}).issues.length,2);
  assert(checkAttributionLanguage({summary:null,findings:[]}).issues.length);
  assert(checkAttributionLanguage({summary:'中文说明',findings:null}).issues.length);
});
