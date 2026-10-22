import { clusteringJobRepository, loadClusteringJobInputs } from "./clustering-job.js";
import { allClusteringJobSources, jobObservations, type ClusteringJobConfig, type ClusteringJobTask } from "./clustering-job-types.js";
import { locateRun, readJson } from "@eval/data";
import type { Checkpoint } from "./checkpoint.js";
import type { EvalConfig } from "./types.js";

/** Business coordinates for pending/failed work; no raw answers or draft outputs leave the server. */
export async function runErrorTasks(run: string) {
  const saved = await readJson<Checkpoint>(locateRun(run).stateFile);
  if ((saved as unknown as {kind:string}).kind === "clustering-job") {
    const state = await clusteringJobRepository.readRun(run), config = state.manifest.config as ClusteringJobConfig;
    let inputs: Record<string,unknown> | undefined, locationError: string | undefined;
    try { inputs = await loadClusteringJobInputs(config); }
    catch(error) { locationError = error instanceof Error ? error.message : String(error); }
    return state.manifest.tasks.map(task => {
      const current = state.manifest.states[task.id], data = task.data as ClusteringJobTask;
      const refs = inputs ? jobObservations(inputs,data).flatMap(item=>item.refs) :
        allClusteringJobSources(config).filter(source=>source.model===data.model).map(source=>({...source,attribution:source}));
      return {task_id:task.id,stage:task.stage,status:current.status,attempts:current.attempts,recovered:!!state.receipts[task.id],
        location_error:locationError,location_scope:inputs ? "task" : "model",
        reason:current.reason,errors:current.failure?.errors ?? [],attempt_id:current.attemptId,channel:current.channel,next_retry_at:current.nextRetryAt,
        paused:state.manifest.pausedStages?.find(pause=>pause.stage===task.stage),
        dependencies:Object.values(task.dependencies).map(task_id=>({task_id,status:state.manifest.states[task_id]?.status})),task:undefined,
        locations:[...new Map(refs.map(ref=>[ref.input_id,{input_id:ref.input_id,model:data.model,batch_id:ref.batch_id,case_id:ref.case_id,
          input_file:ref.source.file,input_line:ref.source.line,source_run:ref.attribution?.run_id,
          package_id:undefined,package_name:undefined,original_file:undefined,original_line:undefined,original_item:undefined}])).values()]};
    });
  }
  if (saved.format !== "evaluation-run") throw new Error("Invalid run state");
  const config = saved.config as EvalConfig;
  const coordinates = new Map(config.inputs.workbench?.records.map(row => [JSON.stringify([row.model,row.batch_id,row.case_id]),row]));
  return Object.entries(saved.tasks).map(([id, task]) => {
    const visited = new Set<string>(), inputIds = new Set<string>();
    const visit = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const item = saved.tasks[key];
      if (!item) return;
      Object.values(item.inputIds).forEach(inputId => inputIds.add(inputId));
      if (!Object.keys(item.inputIds).length) Object.values(item.dependencies).forEach(visit);
    };
    visit(id);
    const locations = [...inputIds].flatMap(inputId => {
      const candidate = saved.inputs[inputId];
      if (!candidate) return [];
      const original = coordinates.get(JSON.stringify([candidate.version,candidate.batch_id,candidate.case_id]));
      return [{ input_id: inputId, model: candidate.version, batch_id: candidate.batch_id, case_id: candidate.case_id,
        input_file: candidate.source, input_line: candidate.line,
        ...(original ? { package_id: original.package_id, package_name: original.package_name,
          original_file: original.original_file, original_line: original.original_line, original_item: original.original_item } : {}) }];
    });
    return { task_id: id, stage: task.stage, status: task.status, attempts: task.attempts,
      recovered: !!task.receipt, reason: task.reason, errors: task.failure?.errors ?? [],
      attempt_id: task.attemptId, channel: task.channel, next_retry_at: task.nextRetryAt,
      paused: saved.pausedStages?.find(pause => pause.stage === task.stage),
      dependencies: Object.values(task.dependencies).map(task_id => ({ task_id, status: saved.tasks[task_id]?.status })),
      task: config.inputs.workbench?.task, locations };
  });
}
