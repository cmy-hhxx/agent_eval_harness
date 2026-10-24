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
  const section=params.get('section')??'records',page=Number(params.get('page')??1),pageSize=Number(params.get('page_size')??50);
  if(!['records','exclusions','metadata_issues'].includes(section)||!Number.isSafeInteger(page)||page<1||
    !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new HttpError(400,'报告分页参数无效');
  const query=new URLSearchParams({section,page:String(page),page_size:String(pageSize)}),identifier=safeId(packageId);
  const report=await dataRequest(options,`/data/workbench/batches/${encodeURIComponent(identifier)}/report?${query}`);
  const catalog=await dataRequest(options,'/data/workbench/catalog?page_size=1') as CatalogPage;
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
  const selected=records.map(record=>({record,coverage:{runIds:[],stages:{}} as Coverage,comparisonAccepted:false}));
  const identities=new Map<string,typeof selected>();
  const identity=(date:string,model:string,batchId:string,caseId:string)=>JSON.stringify([date,model,batchId,caseId]);
  for(const item of selected){
    const key=identity(item.record.date,item.record.model,item.record.batch_id,item.record.case_id),group=identities.get(key)??[];
    group.push(item);identities.set(key,group);
  }
  const select=(date:string,candidate:Pick<Candidate,'version'|'batch_id'|'case_id'|'trace_id'>)=>
    (identities.get(identity(date,candidate.version,candidate.batch_id,candidate.case_id))??[]).filter(item=>matching(item.record,candidate));
  if(options.source==='aime'){
    for(const [date,states]of aimeRuns)for(const state of states){
      const matched=new Set<typeof selected[number]>();
      for(const task of state.manifest.tasks)for(const item of select(date,(task.data as {candidate:Candidate}).candidate)){
        matched.add(item);
        if(['score','attribution'].includes(task.stage))count(item.coverage,task.stage,state.manifest.states[task.id].status);
      }
      for(const item of matched)item.coverage.runIds.push(state.manifest.runId);
    }
    for(const item of selected)for(const stage of ['score','attribution'])if(!item.coverage.stages[stage])count(item.coverage,stage,'pending');
  }else for(const [date,states]of runs){
    const readyCount=states.reduce((n,state)=>n+publishable.get(state)!.size,0);
    for(const state of states){
      const matched=new Map<string,typeof selected>(),included=new Set<typeof selected[number]>();
      for(const [id,candidate]of Object.entries(state.inputs)){
        const rows=select(date,candidate);if(!rows.length)continue;
        matched.set(id,rows);for(const item of rows)included.add(item);
      }
      for(const item of included)item.coverage.runIds.push(state.runId);
      if(!matched.size)continue;
      const ready=publishable.get(state)!;
      for(const [taskId,task]of Object.entries(state.tasks)){
        if(!isAutomationTask(task))continue;
        const rows=new Set<typeof selected[number]>();
        for(const id of inputIds(state,taskId))for(const item of matched.get(id)??[])rows.add(item);
        for(const item of rows){
          count(item.coverage,task.stage,task.status==='succeeded'&&!task.receipt?'failed':task.status);
          if(task.stage==='comparison'&&task.data.comparisonId&&ready.has(task.data.comparisonId))item.comparisonAccepted=true;
        }
      }
    }
    const job=options.automationState?.jobs[date],mongo=job?.mongo;
    for(const item of selected)if(item.record.date===date)item.coverage.mongoStatus=item.comparisonAccepted&&mongo?.status==='completed'&&mongo.synced&&
      mongo.synced.inputsUpdatedAt===(job?.inputsUpdatedAt??0)&&mongo.synced.comparisons===readyCount&&job?.summary?.readyComparisons===readyCount
        ?'completed':item.comparisonAccepted&&mongo?.status==='retry'?'retry':'pending';
  }
  const items=selected.map(({record,coverage})=>({...record,coverage}));
  return {...report,items};
}
