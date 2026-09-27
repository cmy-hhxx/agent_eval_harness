import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantContent,AssistantContentStream} from './assistant-content.js';
import type {JsonObject} from '@eval/contracts';
for(const size of [1,2,3,7,19,100]) test(`provider thinking envelope survives ${size}-character transport fragments`,()=>{
 const text='\n<think>核对引用。\n检查结果。</think>## 结论\n已确认。',stream=new AssistantContentStream(),events:JsonObject[]=[];
 for(let i=0;i<text.length;i+=size)events.push(...stream.push({type:'text_delta',contentIndex:0,delta:text.slice(i,i+size)}));
 events.push(...stream.finish());
 assert.deepEqual(events.filter(e=>e.type==='block-end').map(e=>e.block),assistantContent([{type:'text',text}]));
 assert.deepEqual(events.filter(e=>e.type==='block-start').map(e=>e.index),[0,1]);
});
test('literal tags in code and ordinary text are preserved; unclosed provider thinking stays reasoning',()=>{
 for(const text of ['```xml\n<think>x</think>\n```','例子 <think>x</think>'])assert.deepEqual(assistantContent([{type:'text',text}]),[{type:'text',text}]);
 assert.deepEqual(assistantContent([{type:'text',text:'<think>未完成'}]),[{type:'reasoning',text:'未完成'}]);
});

test('SDK control events reserve no block indices and an empty thinking envelope settles in place',()=>{
 const stream=new AssistantContentStream();
 assert.deepEqual(stream.push({type:'start',contentIndex:0}),[]);
 const events=stream.push({type:'text_delta',contentIndex:0,delta:'<think></think>回答'}).concat(stream.finish());
 assert.deepEqual(events.filter(e=>e.type==='block-end').map(e=>e.block),assistantContent([{type:'text',text:'<think></think>回答'}]));
 assert.deepEqual(events.filter(e=>e.type==='block-start').map(e=>e.index),[0,1]);
 const tool=stream.push({type:'toolcall_start',contentIndex:1});assert.equal(tool[0].index,2);
});
