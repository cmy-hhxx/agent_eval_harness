import path from "node:path";
import { readJson, runLayout, runLock, exists } from "@eval/data";
import { runBatch, runEvaluation, WorkerSupervisor, inputDiagnostics, type BatchJob } from "@eval/host";
import { loadIdentity, createRunWorkspace } from "@eval/runtime/client";
import { comparisonWorkflow } from "@eval/workflows/comparison";
import { attributionWorkflow } from "@eval/workflows/attribution";
import { loadConfig, readSettings } from "./config.js";
import { createBalancedModels } from "./balanced-models.js";
import { services, logger } from "./composition.js";
import { preflightHost } from "./preflight.js";
import { businessAttributionRepository, businessComparisonRepository } from "./business-results.js";

interface BatchConfig {
  stateDirectory: string;
  channels: Record<string, number>;
  equivalentChannels: string[];
  taskConcurrency: number;
  workers?: { slots?: number; retries?: number; retryDelaySeconds?: number };
  runs: { runId: string; configs: string[]; priority: number }[];
}

export async function runBatchCommand(file: string, signal: AbortSignal) {
  const config = await readJson<BatchConfig>(file), directory = path.dirname(path.resolve(file));
  if (!config || typeof config.stateDirectory !== "string" || !config.stateDirectory.trim() ||
    !Array.isArray(config.equivalentChannels) || !config.equivalentChannels.length ||
    new Set(config.equivalentChannels).size !== config.equivalentChannels.length ||
    !config.channels || Array.isArray(config.channels) || !Object.keys(config.channels).length ||
    Object.values(config.channels).some(limit => !Number.isSafeInteger(limit) || limit < 1) ||
    config.equivalentChannels.some(channel => typeof channel !== "string" || !Object.hasOwn(config.channels, channel)) ||
    Object.keys(config.channels).some(channel => !config.equivalentChannels.includes(channel)) ||
    !Array.isArray(config.runs) || !config.runs.length ||
    config.runs.some(run => !run || typeof run.runId !== "string" || !Array.isArray(run.configs) || !run.configs.length ||
      run.configs.some(source => typeof source !== "string" || !source.trim()) || !Number.isSafeInteger(run.priority)))
    throw new Error("Invalid batch configuration");
  const workers = { slots: 4, retries: 3, retryDelaySeconds: 10, ...config.workers };
  if (!Number.isSafeInteger(config.taskConcurrency) || config.taskConcurrency < config.runs.length ||
    !Number.isSafeInteger(workers.slots) || workers.slots < 1 || workers.slots > 200 ||
    !Number.isSafeInteger(workers.retries) || workers.retries < 0 ||
    !Number.isSafeInteger(workers.retryDelaySeconds) || workers.retryDelaySeconds < 0)
    throw new Error("Invalid batch capacity or Worker policy");
  const settings = await readSettings();
  for (const id of config.equivalentChannels) {
    const channel = settings.channels[id];
    if (!channel || channel.api !== "openai-responses") throw new Error("Batch requires a declared Responses channel: " + id);
    if (!settings.environment[channel.apiKeyEnv]) throw new Error("Missing batch model credential: " + channel.apiKeyEnv);
  }
  const identity = await loadIdentity("pi", services.runtime.root);
  const unlock = await runLock(path.resolve(directory, config.stateDirectory));
  let workspace: Awaited<ReturnType<typeof createRunWorkspace>> | undefined;
  let supervisor: WorkerSupervisor | undefined;
  const eventWrites: Promise<unknown>[] = [];
  try {
    workspace = await createRunWorkspace(path.resolve(directory, config.stateDirectory), false);
    supervisor = new WorkerSupervisor({ identity,
      runtime: { ...services.runtime, workerSlots: workers.slots }, directory: workspace.directory, maxSlots: config.taskConcurrency,
      retries: workers.retries, retryDelaySeconds: workers.retryDelaySeconds, wake() {}, event: (event, detail) => {
        console.log(JSON.stringify({ event, ...detail }));
        eventWrites.push(logger.event(event, { component: "batch", ...detail }));
      } });
    const hosts = new Map<string, Awaited<ReturnType<typeof loadConfig>>>();
    for (const entry of config.runs)
      hosts.set(entry.runId, await loadConfig(entry.configs.map(source => path.resolve(directory, source)), settings));
    // One run owns one business root; sharing it would mix daily and lost rows in the same delivery tree.
    // Isolated run layouts keep their own directory under the shared path.
    const roots = new Map<string, string>();
    for (const [runId, host] of hosts) {
      if (host.evaluation.output.layout !== "business") continue;
      const target = path.resolve(host.evaluation.output.path), owner = roots.get(target);
      if (owner) throw new Error("Runs " + owner + " and " + runId + " share output.path: " + target);
      roots.set(target, runId);
    }
    const jobs: BatchJob[] = [];
    for (const entry of config.runs) {
      jobs.push({ id: entry.runId, priority: entry.priority, run: async (control, taskLimit, cancelled) => {
        const host = hosts.get(entry.runId)!;
        supervisor!.retryQuarantined();
        const issues = await preflightHost(host, entry.runId);
        if (issues.length) throw new Error("Run startup preflight failed: " + JSON.stringify(issues));
        const workflow = host.workflow === "attribution" ? attributionWorkflow : comparisonWorkflow;
        const repository = host.workflow === "attribution" ? businessAttributionRepository : businessComparisonRepository;
        const run = runLayout(host.evaluation.output, entry.runId).directory;
        const resuming = await exists(runLayout(host.evaluation.output, entry.runId).stateFile);
        if (resuming) {
          const saved = await repository.readTasks(run, []);
          if (saved.manifest.status === "finished") return { status: "finished", resumed_terminal: true,
            outcome: saved.manifest.outcome,
            ...inputDiagnostics(saved.manifest.preflight),
            failed_tasks: Object.values(saved.manifest.states).filter(state => state.status !== "succeeded").length };
        }
        const routing = createBalancedModels(host.models, config.equivalentChannels);
        for (const stage of Object.keys(host.models.bindings)) routing.modelRoutesForTask({ stage });
        const plan = resuming ? { tasks: [], inputs: {}, summary: {} } : await workflow.plan(host.evaluation);
        // Sharded workflows plan their inputs one physical file at a time while the run proceeds.
        if (!resuming && !plan.tasks.length && !plan.summary.sharded) throw new Error("No evaluable records; inspect input preflight");
        return runEvaluation({ ...services, ...routing, report: undefined, taskSource: workflow, repository,
          workerSupervisor: supervisor,
          runtime: { ...services.runtime, workerSlots: workers.slots },
          runId: entry.runId, output: host.evaluation.output, engine: "pi", evaluatorVersion: host.evaluatorVersion,
          config: host.evaluation, plan, policy: host.evaluation.execution,
          concurrency: host.evaluation.execution.concurrency, taskConcurrency: config.taskConcurrency, taskLimit,
          modelRequests: control, trafficGroup: entry.runId, skipFailed: true,
          retries: host.evaluation.execution.retries, retryDelaySeconds: host.evaluation.execution.retryDelaySeconds,
          failureGuard: host.evaluation.execution.failureGuard, signal: cancelled,
          onProgress: message => console.log(JSON.stringify({ run_id: entry.runId, message })) });
      } });
    }
    const results = await runBatch(jobs, config.channels, config.taskConcurrency, signal, event => {
      console.log(JSON.stringify(event));
      eventWrites.push(logger.event("batch_progress", { component: "batch", ...event }));
    });
    console.log(JSON.stringify({ runs: results }, null, 2));
    return signal.aborted ? 130 : Object.values(results).some(result => result.error || result.outcome === "partial" || result.input_issue_count || result.input_rejected ||
      result.failed_tasks || result.resource_pause || (result.paused_stages as unknown[] | undefined)?.length ||
      Object.entries(result.execution_task_statuses as Record<string, number> ?? {}).some(([status, count]) => status !== "succeeded" && count)) ? 2 : 0;
  } finally {
    try { await supervisor?.close(); }
    finally {
      await Promise.allSettled(eventWrites);
      try { await workspace?.close(); } finally { await unlock(); }
    }
  }
}
