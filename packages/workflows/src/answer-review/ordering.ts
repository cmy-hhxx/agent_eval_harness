import type { Candidate } from '@eval/workflows/inputs';

/** Keep a small quick cohort, then start the longest captured traces before the tail. */
export function reviewExecutionOrder(candidates:Candidate[],concurrency:number,stageCount:number):Candidate[]{
  if(candidates.length<2)return [...candidates];
  const modes=new Map<string,Candidate[]>();
  for(const candidate of candidates)modes.set(candidate.version,[...modes.get(candidate.version)??[],candidate]);
  if(modes.size>1){
    const groups=[...modes.values()].map(group=>reviewExecutionOrder(group,Math.max(1,Math.floor(concurrency/modes.size)),stageCount));
    return Array.from({length:Math.max(...groups.map(group=>group.length))},(_,index)=>groups.flatMap(group=>group[index]?[group[index]]:[])).flat();
  }
  const ranked=[...candidates].sort((a,b)=>b.final_index-a.final_index);
  const quickCount=Math.min(Math.ceil(candidates.length/4),Math.max(1,Math.ceil(concurrency/(stageCount*4))));
  const quick=ranked.splice(-quickCount).sort((a,b)=>a.final_index-b.final_index);
  return [...quick,...ranked];
}
