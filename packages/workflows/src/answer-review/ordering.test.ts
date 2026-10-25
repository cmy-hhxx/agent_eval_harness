import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '@eval/workflows/inputs';
import { reviewExecutionOrder } from './ordering.js';

const candidates=(depths:number[])=>depths.map((final_index,index)=>({input_id:String(index),final_index}) as Candidate);
test('a quick result and the longest trace start together instead of leaving the longest for last',()=>{
  const input=candidates([2,4,8,16,32,64,128,256]),before=[...input];
  const ordered=reviewExecutionOrder(input,8,2);
  assert.deepEqual(ordered.slice(0,2).map(row=>row.final_index),[2,256]);
  assert.deepEqual(ordered.slice(1).map(row=>row.final_index),[256,128,64,32,16,8,4]);
  assert.deepEqual(new Set(ordered),new Set(input));assert.deepEqual(input,before);
});
test('a 200-slot two-stage run reserves a quarter of its first cohort for quick answers',()=>{
  const input=candidates(Array.from({length:1000},(_,i)=>i+1)),ordered=reviewExecutionOrder(input,200,2);
  assert(ordered.slice(0,25).every(row=>row.final_index<=25));
  assert(ordered.slice(25,100).every(row=>row.final_index>=926));
  assert.equal(new Set(ordered.map(row=>row.input_id)).size,1000);
});
test('a small or empty cohort retains identities and still brings its longest answer forward',()=>{
  const input=candidates([1,5,10,100]);
  assert.deepEqual(reviewExecutionOrder(input,200,2).map(row=>row.final_index),[1,100,10,5]);
  assert.deepEqual(reviewExecutionOrder([],200,2),[]);
  assert.deepEqual(reviewExecutionOrder(input.slice(0,1),200,1),input.slice(0,1));
});
