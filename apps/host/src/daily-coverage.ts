import path from 'node:path';
import {HttpError,safeId} from '@eval/contracts';
import type {AutomationState} from '@eval/automations';
import {answerReviewRepository,type AimeIncrementalState} from '@eval/workflows/answer-review';
import {publishableComparisons,type Candidate,type Checkpoint} from '@eval/workflows/comparison';
import {exists,readJson} from '@eval/data';
import {checkpoint,isAutomationTask} from './automation-evaluation.js';
import {dataRequest,type CatalogPage} from './daily-ingestion.js';
import type {AimeWorkbench} from './aime-workbench.js';

interface CoverageRecord {date:string;model:string;batch_id:string;case_id:string;trace_id?:string;[key:string]:unknown}
interface Counts {total:number;completed:number;failed:number;pending:number;running:number}
interface Coverage {runIds:string[];stages:Record<string,Counts>;mongoStatus?:'completed'|'pending'|'retry'}
export interface DailyCoverageSource {sourceUrl:string;source:'wencai'|'aime';output:string;automationState?:AutomationState;aime?:AimeWorkbench}
const matching=(record:CoverageRecord,candidate:Pick<Candidate,'version'|'batch_id'|'case_id'|'trace_id'>)=>
  record.model===candidate.version&&record.batch_id===candidate.batch_id&&record.case_id===candidate.case_id&&
  (record.trace_id===undefined||record.trace_id===candidate.trace_id);
function count(coverage:Coverage,stage:string,status:string){
  const counts=coverage.stages[stage]??={total:0,completed:0,failed:0,pending:0,running:0};counts.total++;
  if(status==='succeeded')counts.completed++;
  else if(status==='running')counts.running++;
  else if(['failed','timed_out','cancelled','blocked'].includes(status))counts.failed++;
  else counts.pending++;
}
function inputIds(state:Checkpoint,taskId:string,visited=new Set<string>()):Set<string>{
  if(visited.has(taskId))return new Set();visited.add(taskId);
  const task=state.tasks[taskId];if(!task)return new Set();
  const ids=new Set(Object.values(task.inputIds));
  if(task.data.rewriteOf)for(const id of inputIds(state,task.data.rewriteOf.taskId,visited))ids.add(id);
  return ids;
}
/** Join one report page to the authoritative day runs; no result bodies or cross-run cache. */
export async function dailyPackageReport(options:DailyCoverageSource,packageId:string,params:URLSearchParams){
  const section=params.get('section')??'records',page=Number(params.get('page')??1);
  if(!['records','exclusions','metadata_issues'].includes(section)||!Number.isSafeInteger(page)||page<1)throw new HttpError(400,'报告分页参数无效');
  const query=new URLSearchParams({section,page:String(page)}),identifier=safeId(packageId);
  const report=await dataRequest(options,`/data/workbench/batches/${encodeURIComponent(identifier)}/report?${query}`);
  const catalog=await dataRequest(options,'/data/workbench/catalog') as CatalogPage;
  if(!catalog.tasks.some(task=>task.dataset===new URL(options.sourceUrl).pathname&&path.resolve(task.archive_dir)===path.dirname(path.resolve(report.archive_path))))
    throw new HttpError(404,'批次不属于此日常来源');
  if(section!=='records')return report;
  const records=report.items as CoverageRecord[],dates=new Set(records.map(row=>row.date));
  const runs=new Map<string,Checkpoint[]>();
  const publishable=new Map<Checkpoint,Map<string,number>>();
  if(options.source==='wencai')for(const date of dates){
    const job=options.automationState?.jobs[date],states:Checkpoint[]=[];
    for(const runId of job?.runIds??[]){const state=await checkpoint(options.output,safeId(runId));if(state)states.push(state);}
    runs.set(date,states);for(const state of states)publishable.set(state,publishableComparisons(state));
  }
  const aimeRuns=new Map<string,Awaited<ReturnType<typeof answerReviewRepository.readTasks>>[]>();
  if(options.source==='aime'){
    const stateFile=options.aime&&path.join(options.aime.configuration.stateDirectory,'state.json');
    const saved=stateFile&&await exists(stateFile)?await readJson<AimeIncrementalState>(stateFile):undefined;
    for(const date of dates){
      const ids=saved?.jobs.filter(job=>job.date===date).map(job=>job.id)??[date.slice(5).replace('-','')],states=[];
      for(const runId of ids){const run=path.join(options.output,safeId(runId));if(await exists(path.join(run,'state.json')))states.push(await answerReviewRepository.readTasks(run,[]));}
      aimeRuns.set(date,states);
    }
  }
  const items=records.map(record=>{
    const coverage:Coverage={runIds:[],stages:{}};
    if(options.source==='aime'){
      for(const state of aimeRuns.get(record.date)??[]){
        const tasks=state.manifest.tasks.filter(task=>matching(record,(task.data as {candidate:Candidate}).candidate));
        if(tasks.length)coverage.runIds.push(state.manifest.runId);
        for(const task of tasks)if(['score','attribution'].includes(task.stage))count(coverage,task.stage,state.manifest.states[task.id].status);
      }
      for(const stage of ['score','attribution'])if(!coverage.stages[stage])count(coverage,stage,'pending');
    }else{
      let comparisonAccepted=false;
      const states=runs.get(record.date)??[],readyCount=states.reduce((n,state)=>n+publishable.get(state)!.size,0);
      for(const state of states){
        const matched=new Set(Object.entries(state.inputs).filter(([,candidate])=>matching(record,candidate)).map(([id])=>id));
        if(!matched.size)continue;
        coverage.runIds.push(state.runId);
        const ready=publishable.get(state)!;
        for(const [taskId,task]of Object.entries(state.tasks)){
          if(!isAutomationTask(task))continue;
          if(![...inputIds(state,taskId)].some(id=>matched.has(id)))continue;
          count(coverage,task.stage,task.status==='succeeded'&&!task.receipt?'failed':task.status);
          if(task.stage==='comparison'&&task.data.comparisonId&&ready.has(task.data.comparisonId))comparisonAccepted=true;
        }
      }
      const job=options.automationState?.jobs[record.date],mongo=job?.mongo;
      coverage.mongoStatus=comparisonAccepted&&mongo?.status==='completed'&&mongo.synced&&mongo.synced.inputsUpdatedAt===(job?.inputsUpdatedAt??0)&&
        mongo.synced.comparisons===readyCount&&job?.summary?.readyComparisons===readyCount?'completed':comparisonAccepted&&mongo?.status==='retry'?'retry':'pending';
    }
    return {...record,coverage};
  });
  return {...report,items};
}
