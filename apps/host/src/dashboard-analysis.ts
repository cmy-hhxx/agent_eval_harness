import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HttpError, errorText, safeId } from "@eval/contracts";
import { exists, localFiles, locateRun, readJson, runLock, writeJson } from "@eval/data";
import { clusteringJobRepository, prepareClusteringJob, prepareFrozenClusteringJob, readAnalysisAnswers,
  type ClusteringJobConfig, type ClusteringJobSource, type EvalConfig } from "@eval/workflows/comparison";
import { DashboardBatches } from "./dashboard-batches.js";
import { loadComparisonConfig, createModelResolver } from "./config.js";
import { readLock } from "./dashboard-launch.js";
import type { DashboardModelLoader } from "./dashboard-models.js";

type Selection = ClusteringJobConfig["clusteringJob"];
interface Scope { task_id: string; batch_ids: string[]; run_ids: string[] }
interface AnalysisJob { id: string; created_at: number; scope: Scope; output_dir: string; engine: "pi" | "prime";
  status: "preview" | "reserved"; pid?: number; error?: string; completed_at?: number }
const identity = (source: ClusteringJobSource) => JSON.stringify([source.run, source.task_id, source.submission_id]);
const business = (row: {model: string; batch_id: string; case_id: string}) => JSON.stringify([row.model,row.batch_id,row.case_id]);
function alive(pid?: number) {
  if (!pid) return false;
  try { process.kill(pid,0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function stringIds(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== "string" || !id) || new Set(value).size !== value.length)
    throw new HttpError(400, "无效的 " + name);
  try { (value as string[]).forEach(safeId); } catch { throw new HttpError(400,"无效的 " + name); }
  return value as string[];
}
interface AnalysisProcess { pid: number; onExit: (callback: (code:number|null,signal:NodeJS.Signals|null)=>void) => void }
async function launchAnalysisProcess(args: string[]): Promise<AnalysisProcess> {
  const child=spawn(process.execPath,args,{env:process.env,stdio:'ignore'});
  let exited: {code:number|null;signal:NodeJS.Signals|null}|undefined;
  let listener: ((code:number|null,signal:NodeJS.Signals|null)=>void)|undefined;
  child.once('exit',(code,signal)=>{exited={code,signal};listener?.(code,signal);});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  child.unref();
  return {pid:child.pid!,onExit(callback){listener=callback;if(exited)callback(exited.code,exited.signal);}};
}
export class DashboardAnalysis {
  readonly directory: string;
  constructor(readonly batches: DashboardBatches, readonly configs: string[], readonly models: DashboardModelLoader,
    private readonly launchProcess: (args:string[])=>Promise<AnalysisProcess> = launchAnalysisProcess) {
    this.directory = path.join(path.dirname(batches.directory), "workbench-analysis");
  }
  file(id: string) { return path.join(this.directory, id, "job.json"); }
  selectionFile(id: string) { return path.join(this.directory, id, "selection.json"); }
  async get(id: string) { return await exists(this.file(id)) ? readJson<AnalysisJob>(this.file(id)) : undefined; }
  async jobs() {
    if (!await exists(this.directory)) return [];
    const dirs = await localFiles.list(this.directory,{withFileTypes:true});
    const jobs = await Promise.all(dirs.filter(dir => dir.isDirectory() && !dir.name.startsWith(".")).map(async dir => {
      // A preview publishes its selection before its job record; incomplete previews own nothing.
      try { return await readJson<AnalysisJob>(this.file(dir.name)); }
      catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }));
    return jobs.filter((job): job is AnalysisJob => !!job);
  }
  async progress(job: AnalysisJob) {
    const directory = path.join(job.output_dir,job.id), stateFile = locateRun(directory).stateFile;
    const state = await exists(stateFile) ? await clusteringJobRepository.readRun(directory) : undefined;
    const tasks = state?.manifest.tasks.filter(task => !state.manifest.executionScope || state.manifest.executionScope.includes(task.id)) ?? [];
    const complete = !!state && tasks.every(task => !!state.receipts[task.id]) && !!job.completed_at;
    const running = alive(job.pid) || !!await readLock(directory);
    return { ...job, status: job.status === 'preview' ? 'preview' : running ? 'running' : complete ? 'completed' : 'interrupted',
      accepted: tasks.filter(task => !!state?.receipts[task.id]).length, total:tasks.length,
      errors: tasks.filter(task => !state?.receipts[task.id]).map(task => ({ task_id:task.id,stage:task.stage,
        model:(task.data as {model:string}).model, status:state!.manifest.states[task.id].status,
        attempts:state!.manifest.states[task.id].attempts, reason:state!.manifest.states[task.id].reason,
        errors:state!.manifest.states[task.id].failure?.errors ?? [] })),
      paused_stages: state?.manifest.pausedStages ?? [], output_dir:directory };
  }
  async claims() {
    const claims = new Map<string,{ job_id:string; status:string }>();
    for (const job of await this.jobs()) {
      if (job.status === 'preview') continue;
      const progress = await this.progress(job);
      const selection = await readJson<Selection>(this.selectionFile(job.id));
      for (const source of selection.sources) claims.set(identity(source),{job_id:job.id,status:progress.status === 'completed' ? 'included' : 'reserved'});
    }
    return claims;
  }
  async scope(value: Record<string,unknown>) {
    if (Object.keys(value).some(key => !['task_id','batch_ids','run_ids'].includes(key)) || typeof value.task_id !== 'string' || !value.task_id)
      throw new HttpError(400,'请选择任务与运行范围');
    const scope:Scope = {task_id:value.task_id,batch_ids:stringIds(value.batch_ids ?? [],'batch_ids'),run_ids:stringIds(value.run_ids,'run_ids')};
    if (!scope.run_ids.length) throw new HttpError(400,'至少选择一个运行');
    const entries = await Promise.all(scope.run_ids.map(id => this.batches.get(id)));
    if (entries.some(entry => !entry || entry.scope.task.id !== scope.task_id || ['draft','preview_failed','ready'].includes(entry.status)))
      throw new HttpError(400,'所选运行不存在、尚未启动或不属于该任务');
    const knownBatches = new Set(entries.flatMap(entry => entry!.scope.batch_ids));
    if (scope.batch_ids.some(id => !knownBatches.has(id))) throw new HttpError(400,'批次不在所选运行中');
    const claims = await this.claims();
    const rows: { run_id:string; model:string; batch_id:string; case_id:string; package_id:string; package_name:string;
      original_file:string; original_line:number; status:string; evaluation_status:string; source?:ClusteringJobSource; accepted_at?:number; job_id?:string }[] = [];
    for (const entry of entries) {
      const config = await readJson<{inputs:EvalConfig['inputs']}>(this.batches.config(entry!.runId));
      const run = path.join(entry!.outputDir,entry!.runId);
      const answers = await exists(locateRun(run).stateFile) ? await readAnalysisAnswers(run) : [];
      const byCoordinate = new Map<string,typeof answers[number]>();
      const coordinate = (model:string,file:string,line:number) => JSON.stringify([model,file,line]);
      for (const answer of answers) {
        const key = coordinate(answer.model,answer.file,answer.line), previous = byCoordinate.get(key);
        if (!previous || (answer.accepted_at ?? 0) >= (previous.accepted_at ?? 0)) byCoordinate.set(key,answer);
      }
      for (const row of config.inputs.workbench!.records) {
        if (scope.batch_ids.length && !scope.batch_ids.includes(row.package_id)) continue;
        const answer = byCoordinate.get(coordinate(row.model,row.input_file,row.input_index+1));
        const claim = answer?.source && claims.get(identity(answer.source));
        rows.push({run_id:entry!.runId,model:row.model,batch_id:row.batch_id,case_id:row.case_id,
          package_id:row.package_id,package_name:row.package_name,original_file:row.original_file,original_line:row.original_line,
          status:claim?.status ?? (answer?.source ? 'available' : 'unfinished'),evaluation_status:answer?.status ?? 'not_started',
          source:answer?.source,accepted_at:answer?.accepted_at,job_id:claim?.job_id});
      }
    }
    // Explicitly selected runs can overlap; only the newest accepted receipt is eligible.
    const latest = new Map<string,typeof rows[number]>();
    for (const row of rows.filter(row => row.source)) {
      const previous = latest.get(business(row));
      if (!previous || (row.accepted_at! > previous.accepted_at!) || (row.accepted_at === previous.accepted_at && row.run_id > previous.run_id)) latest.set(business(row),row);
    }
    for (const row of rows) if (row.source && latest.get(business(row)) !== row) row.status = 'superseded';
    const counts = Object.fromEntries(['available','included','reserved','unfinished','superseded'].map(status => [status,rows.filter(row => row.status === status).length]));
    return {scope,rows,counts,output_dir:entries[0]!.outputDir};
  }
  async preview(value: Record<string,unknown>) {
    const scope = await this.scope(value), sources = scope.rows.filter(row => row.status === 'available').map(row => row.source!);
    if (!sources.length) throw new HttpError(409,'当前范围没有新的已接受归因');
    const host = await loadComparisonConfig(this.configs), id = randomUUID();
    const output_dir = path.join(scope.output_dir,'clustering');
    const prepared = await prepareClusteringJob([...new Set(sources.map(source=>source.run))],{...host.evaluation,output:{kind:'directory',path:output_dir}},
      {inputIds:sources.map(source=>source.input_id),acceptedOnly:true});
    if (prepared.config.clusteringJob.sources.some(source => !sources.some(chosen => identity(chosen) === identity(source))))
      throw new HttpError(409,'归因已更新，请重新选择范围');
    const job:AnalysisJob = {id,created_at:Date.now(),scope:scope.scope,output_dir,engine:'pi',status:'preview'};
    await writeJson(this.selectionFile(id),prepared.config.clusteringJob); await writeJson(this.file(id),job);
    return {job_id:id,counts:scope.counts,summary:prepared.plan.summary,output_dir:path.join(output_dir,id)};
  }
  async launch(id: string, value: Record<string,unknown>) {
    if (Object.keys(value).some(key => !['engine','resume_stages'].includes(key))) throw new HttpError(400,'未知聚类启动参数');
    if (value.engine !== undefined && !['pi','prime'].includes(String(value.engine))) throw new HttpError(400,'Invalid engine');
    const resumeStages = stringIds(value.resume_stages ?? [],'resume_stages');
    let release:()=>Promise<void>;
    try { release = await runLock(path.join(this.directory,'.claims')); }
    catch { throw new HttpError(409,'分析范围正在登记，请稍后重试'); }
    try {
      const job = await this.get(id); if (!job) throw new HttpError(404,'分析作业不存在');
      const directory = path.join(job.output_dir,id);
      if (alive(job.pid) || await readLock(directory)) throw new HttpError(409,'分析仍在运行');
      if ((await this.progress(job)).status === 'completed') throw new HttpError(409,'分析已完成');
      const selection = await readJson<Selection>(this.selectionFile(id));
      if (job.status === 'preview') {
        const claims = await this.claims();
        if (selection.sources.some(source=>claims.has(identity(source)))) throw new HttpError(409,'所选归因已纳入其他分析，请刷新范围');
      }
      const host = await loadComparisonConfig(this.configs);
      const prepared = await prepareFrozenClusteringJob(selection,{...host.evaluation,output:{kind:'directory',path:job.output_dir}});
      const saved = await exists(locateRun(directory).stateFile) ? await clusteringJobRepository.readRun(directory) : undefined;
      const remaining = saved ? saved.manifest.tasks.filter(task=>!saved.receipts[task.id] &&
        (!saved.manifest.executionScope || saved.manifest.executionScope.includes(task.id))) : prepared.plan.tasks;
      const available = new Set((remaining.length ? await this.models() : []).map(model=>JSON.stringify([model.channel,model.id])));
      const resolve = createModelResolver(host.models);
      for (const stage of new Set(remaining.map(task=>task.stage))) {
        const model = resolve(stage);
        if (!available.has(JSON.stringify([model.provider,model.model])) || !process.env[model.apiKeyEnv]) throw new HttpError(400,'聚类阶段模型或密钥未配置：'+stage);
      }
      if (resumeStages.length) {
        const state = await clusteringJobRepository.readRun(directory);
        if (resumeStages.some(stage=>!state.manifest.pausedStages?.some(pause=>pause.stage===stage))) throw new HttpError(400,'只能解除当前暂停阶段');
      }
      job.status='reserved'; job.engine=(value.engine as 'pi'|'prime'|undefined) ?? job.engine; delete job.error;
      await writeJson(this.file(id),job);
      const args=[path.join(path.dirname(fileURLToPath(import.meta.url)),'cli.js'),'cluster','--apply','--run-id',id,'--output',job.output_dir,
        '--engine',job.engine,'--clustering-selection',this.selectionFile(id)];
      for (const config of this.configs) args.push('--config',config);
      for (const stage of resumeStages) args.push('--resume-stage',stage);
      let child: AnalysisProcess;
      try { child=await this.launchProcess(args); }
      catch(error) { job.error=errorText(error);await writeJson(this.file(id),job);throw error; }
      job.pid=child.pid; await writeJson(this.file(id),job);
      child.onExit((code,signal)=>{void (async()=>{
        const current=await this.get(id); if (!current || current.pid!==child.pid) return;
        delete current.pid;
        if(code===0)current.completed_at=Date.now();else current.error=`分析进程退出：${signal ?? code}`;
        await writeJson(this.file(id),current);
      })().catch(error=>console.error('保存聚类退出状态失败',error));});
      return {job_id:id,pid:child.pid};
    } finally { await release(); }
  }
  async list() { return Promise.all((await this.jobs()).filter(job=>job.status!=='preview').sort((a,b)=>b.created_at-a.created_at).map(job=>this.progress(job))); }
}
