import test from 'node:test';
import assert from 'node:assert/strict';
import {runAimeWatch,type AimeWatchStatus} from './watch.js';

test('watch waits for the active cycle and starts the next without overlap',async()=>{
  const controller=new AbortController(),states:AimeWatchStatus[]=[];
  let calls=0,active=0,peak=0,finish!:()=>void,started!:()=>void;
  const began=new Promise<void>(r=>started=r),held=new Promise<void>(r=>finish=r);
  const promise=runAimeWatch({pollMs:1,signal:controller.signal},{
    async run(){calls++;peak=Math.max(peak,++active);if(calls===1){started();await held;}active--;if(calls===2)controller.abort();},
    async status(value){states.push(value);},async error(error){throw error;},
  });
  await began;assert.equal(calls,1);finish();await promise;
  assert.equal(calls,2);assert.equal(peak,1);assert.equal(states.at(-1)?.status,'stopped');
  assert(states.some(s=>s.status==='waiting'&&s.nextScanAt!==null));
});

test('a failed cycle is reported and the next scan can recover',async()=>{
  const controller=new AbortController(),errors:unknown[]=[],states:AimeWatchStatus[]=[];let calls=0;
  await runAimeWatch({pollMs:1,signal:controller.signal},{
    async run(){if(++calls===1)throw Error('archive changed while scanning');controller.abort();},
    async status(value){states.push(value);},async error(error){errors.push(error);},
  });
  assert.equal(calls,2);assert.equal(errors.length,1);assert.match(states.find(s=>s.status==='waiting')!.lastError!,/archive changed/);
});

test('stop during the idle interval exits without another scan',async()=>{
  const controller=new AbortController();let calls=0;
  await runAimeWatch({pollMs:60_000,signal:controller.signal},{
    async run(){calls++;},async status(state){if(state.status==='waiting')controller.abort();},async error(error){throw error;},
  });
  assert.equal(calls,1);
});
