import {setTimeout as delay} from 'node:timers/promises';

export interface AimeWatchStatus {
  status:'running'|'waiting'|'stopped';cycles:number;startedAt:number;updatedAt:number;nextScanAt:number|null;lastError:string|null;
}

/** Each scan/evaluation cycle settles before the next one; cancellation also wakes the idle wait. */
export async function runAimeWatch(options:{pollMs:number;signal:AbortSignal},deps:{
  run():Promise<unknown>;status(value:AimeWatchStatus):Promise<void>;error(error:unknown):Promise<void>;
}){
  if(!Number.isSafeInteger(options.pollMs)||options.pollMs<1)throw Error('Invalid AIME poll interval');
  const state:AimeWatchStatus={status:'running',cycles:0,startedAt:Date.now(),updatedAt:Date.now(),nextScanAt:null,lastError:null};
  const publish=async()=>{state.updatedAt=Date.now();await deps.status({...state});};
  try{
    while(!options.signal.aborted){
      state.status='running';state.cycles++;state.nextScanAt=null;await publish();
      try{await deps.run();state.lastError=null;}
      catch(error){if(options.signal.aborted)break;state.lastError=String(error);await deps.error(error);}
      if(options.signal.aborted)break;
      state.status='waiting';state.nextScanAt=Date.now()+options.pollMs;await publish();
      await delay(options.pollMs,undefined,{signal:options.signal}).catch(error=>{if(!options.signal.aborted)throw error;});
    }
  }finally{state.status='stopped';state.nextScanAt=null;await publish();}
}
