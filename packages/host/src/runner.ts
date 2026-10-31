import {
  applyRunJournalDelta,
  isRunJournalProjection,
  atomicWrite,
  localFiles,
  readProgressJournal,
  RunHotStore,
  runHotFile,
  runJournalIdentity,
} from "@eval/data";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { inspect } from "node:util";
import { setImmediate as yieldToIO } from "node:timers/promises";
import {
  emptyUsage,
  type AttemptSpec,
  type AgentBinding,
  type AttemptRecord,
  type Artifact,
  type AttemptStatus,
  type Engine,
  type EngineIdentity,
  type ModelConfig,
  type OutputTarget,
  type PlannedTask,
  type Policy,
  type RunState,
  type Submission,
  type TaskPlan,
  type WorkerStatus,
  type FailureGuardPolicy,
  type StagePause,
} from "@eval/contracts";
import { HttpError, canonical, errorText, redact, safeId, validateEvidenceBank, validateEvidenceBankSources } from "@eval/contracts";
import { body, json, listen, request } from "@eval/runtime/http";
import { compressFile, exists, internalPath, runLayout, runLock, readJson, writeJson } from "@eval/data";
import { loadIdentity } from "@eval/runtime/client";
import type { FailureContext } from "@eval/contracts";
import { progressSnapshot, inputDiagnostics } from "./progress.js";
import { RunStore, type EvaluationServices } from "./store.js";
import { createScopeMembership, dependencyReady, scheduleTasks, sessionAdmissionSnapshot } from "./scheduling.js";
import { FailureGuard } from "./failure-guard.js";
import { cumulativeAttempts, executionStopReason } from "./run-limits.js";
import { consumeEvents, createRunWorkspace } from "@eval/runtime/client";
import { createModelRequests, type ModelRequestControl } from "./model-requests.js";
import { WorkerSupervisor, type WorkerSlot } from "./worker-supervisor.js";
import type { TaskLimit } from "./batch.js";
export type { ModelRequestControl, ModelRequestContext } from "./model-requests.js";

export interface RunOptions extends EvaluationServices {
  runtime: { root: string; workerEntry: string; workerSlots?: number };
  workerSupervisor?: WorkerSupervisor;
  snapshots?: Record<string, unknown>;
  report?: (run: string) => Promise<Record<string, unknown>>;
  runId: string;
  output: OutputTarget;
  engine: Engine;
  evaluatorVersion: string;
  config: unknown;
  plan: TaskPlan;
  policy: Policy;
  modelForStage: (stage: string) => ModelConfig;
  /** Select a channel for a complete task, retaining its saved route when available. */
  modelForTask?: (task: PlannedTask, previousChannel?: string) => ModelConfig;
  /** Return true only after selecting a different channel for subsequent attempts. */
  onModelQuotaExhausted?: (model: ModelConfig, task: PlannedTask) => boolean;
  concurrency: number;
  /** Task slots may exceed model permits so tool reads and material assembly do not idle the model gate. */
  taskConcurrency?: number;
  taskLimit?: TaskLimit;
  /** Limit active task attempts per model channel within the total concurrency. */
  channelConcurrency?: Record<string, number>;
  modelRequests?: ModelRequestControl;
  modelRoutesForTask?: (task: PlannedTask) => ModelConfig[];
  trafficGroup?: string;
  /** Cumulative stage attempts, including failures and retries, persisted on the run. */
  maxAttempts?: number;
  /** Absolute time in milliseconds after which no new attempts are admitted. */
  stopStartingAt?: number;
  retries: number;
  skipFailed?: boolean;
  discoverInputs?: boolean;
  resumeStages?: string[];
  failureGuard?: FailureGuardPolicy;
  taskIds?: string[];
  retryDelaySeconds: number;
  debug?: boolean;
  signal?: AbortSignal;
  /** Drain active tasks without cancelling their model requests or pending work. */
  pauseSignal?: AbortSignal;
  workerUrls?: string[];
  identity?: EngineIdentity;
  onProgress?: (message: string) => void;
  onEvent?: (event: unknown) => void;
}
export async function runEvaluation(options: RunOptions): Promise<Record<string, unknown> & {
  execution_task_statuses: Record<string, number>; paused_stages: StagePause[];
}> {
  safeId(options.runId);
  if (typeof options.evaluatorVersion !== "string" || !options.evaluatorVersion.trim())
    throw new Error("evaluatorVersion must be a non-empty string");
  if (Object.values(options.channelConcurrency ?? {}).some(limit => !Number.isSafeInteger(limit) || limit <= 0))
    throw new Error("channelConcurrency requires positive integer limits");
  if (options.taskConcurrency !== undefined && (!Number.isSafeInteger(options.taskConcurrency) || options.taskConcurrency < 1))
    throw new Error("taskConcurrency must be a positive integer");
  if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 0))
    throw new Error("maxAttempts must be a non-negative integer");
  if (options.policy.maxTaskAttempts !== undefined && (!Number.isSafeInteger(options.policy.maxTaskAttempts) || options.policy.maxTaskAttempts < 1))
    throw new Error("maxTaskAttempts must be a positive integer");
  if (options.stopStartingAt !== undefined && (!Number.isFinite(options.stopStartingAt) || options.stopStartingAt <= 0))
    throw new Error("stopStartingAt must be an absolute timestamp in milliseconds");
  const layout = runLayout(options.output, options.runId),
    run = layout.directory,
    unlock = await runLock(run);
  const materialIds = new WeakMap<object, string>();
  let supervisor: WorkerSupervisor | undefined = options.workerSupervisor;
  let resourcePause: string | undefined, fatalError: { error: unknown } | undefined;
  let runFailure: { error: unknown } | undefined;
  const running = new Map<string, Promise<void>>();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new Error("Interrupted"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let store: RunStore | undefined, hot: RunHotStore | undefined, http: Awaited<ReturnType<typeof listen>> | undefined;
  let workspace: Awaited<ReturnType<typeof createRunWorkspace>> | undefined;
  let releaseBusiness: (() => Promise<void>) | undefined;
  const selectedTaskIds = options.taskIds?.slice();
  let progressTimer: ReturnType<typeof setInterval> | undefined, checkpointTimer: ReturnType<typeof setInterval> | undefined;
  let wake: () => void = () => {};
  const pause = () => wake();
  options.pauseSignal?.addEventListener("abort", pause, { once: true });
  let changed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  controller.signal.addEventListener("abort", () => wake(), { once: true });
  let concurrencyOverride: number | undefined;
  const desiredConcurrency = () => options.modelRequests
    ? Math.min(concurrencyOverride ?? Infinity, options.modelRequests.concurrency())
    : concurrencyOverride ?? options.concurrency;
  const busy = new Set<{ url: string }>();
  try {
    const identity = options.identity || (await loadIdentity(options.engine, options.runtime.root));
    let saved: RunState;
    let inputs = options.plan.inputs;
    if (await exists(layout.stateFile)) {
      if (options.taskIds) throw new Error("Use a prepared repair scope to select tasks in an existing run");
      saved = await options.repository.readRun(run);
      cumulativeAttempts(saved.manifest);
      if (options.discoverInputs) delete saved.manifest.executionScope;
      if (options.taskSource.reconcile)
        inputs = (await options.taskSource.reconcile(run, saved, options.config)).inputs;
      else inputs = options.plan.inputs;
    } else {
      if ((await localFiles.list(run)).some((name) => name !== ".run-lock"))
        throw new Error("运行目录缺少 state.json，无法读取已有进度");
      saved = {
        receipts: {},
        usage: emptyUsage(),
        recordedAttempts: 0,
        manifest: {
          format: "evaluation-run",
          debug: options.debug ?? false,
          runId: options.runId,
          status: "running",
          engine: identity,
          evaluatorVersion: options.evaluatorVersion,
          config: options.config,
          tasks: options.plan.tasks,
          inputCatalog: options.plan.catalog,
          inputs: Object.fromEntries(Object.keys(inputs).map((id) => [id, { id, name: id }])),
          states: Object.fromEntries(
            options.plan.tasks.map((t) => [t.id, { status: "pending", attempts: 0 }]),
          ),
          preflight: options.plan.summary,
          startedAt: Date.now(),
        },
      };
    }
    hot = new RunHotStore(
      runHotFile(process.env.EVAL_HOT_STATE_ROOT || path.join(os.homedir(), ".cache", "eval-agent-harness", "hot"), run),
      runJournalIdentity(saved),
    );
    const snapshotSequence = saved.manifest.journalSequence ?? 0;
    const replayed = new Map<number, { seq: number; event: import("@eval/data").RunJournalDelta }>();
    for (const event of hot.eventsAfter(snapshotSequence)) replayed.set(event.seq, event);
    for (const event of await readProgressJournal(run, snapshotSequence)) {
      const previous = replayed.get(event.seq);
      if (previous && !isRunJournalProjection(previous.event, event.event))
        throw new Error("本地热状态与进度事件流在同一序号上不一致");
      replayed.set(event.seq, event);
    }
    for (const event of [...replayed.values()].sort((a, b) => a.seq - b.seq))
      applyRunJournalDelta(saved, event.event);
    hot.setSequenceFloor(Math.max(snapshotSequence, ...replayed.keys()));
    const manifest = saved.manifest;
    // Replay historical progress before recording the policy used by this execution.
    manifest.engine = identity;
    manifest.evaluatorVersion = options.evaluatorVersion;
    manifest.config = options.config;
    if (options.repository.prepareRun)
      releaseBusiness = await options.repository.prepareRun(run, saved, inputs, selectedTaskIds);
    if (options.debug !== undefined) manifest.debug = options.debug;
    cumulativeAttempts(manifest);
    if (options.maxAttempts !== undefined || options.stopStartingAt !== undefined)
      manifest.executionLimits = { ...manifest.executionLimits,
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        ...(options.stopStartingAt === undefined ? {} : { stopStartingAt: options.stopStartingAt }) };
    delete manifest.executionStopReason;
    delete manifest.resourcePause;
    delete manifest.outcome;
    const contentRemaining = (task: PlannedTask) => 1 + (options.policy.stageRepairAttempts?.[task.stage] ?? options.policy.repairAttempts) -
      (manifest.states[task.id].failure?.contentSubmissions ?? 0);
    if (selectedTaskIds) {
      if (!selectedTaskIds.length) throw new Error("Task selection must not be empty");
      manifest.executionScope = [...new Set(selectedTaskIds)];
    }
    const selected = manifest.executionScope && new Set(manifest.executionScope);
    const taskIds = new Set(manifest.tasks.map(task => task.id));
    for (const id of selected ?? [])
      if (!taskIds.has(id)) throw new Error("Unknown task in execution scope: " + id);
    for (const stage of options.resumeStages ?? [])
      if (!manifest.pausedStages?.some((pause) => pause.stage === stage)) throw new Error("Stage is not paused: " + stage);
    manifest.pausedStages = (manifest.pausedStages ?? []).filter((pause) => !options.resumeStages?.includes(pause.stage));
    const guard = new FailureGuard(manifest.pausedStages, options.failureGuard);
    const includesTask = createScopeMembership(manifest);
    const inScope = (task: PlannedTask) => includesTask(task.id);
    const attemptsExhausted = (task: PlannedTask) => options.policy.maxTaskAttempts !== undefined &&
      !saved.receipts[task.id] && manifest.states[task.id]!.attempts >= options.policy.maxTaskAttempts;
    const observesFailures = (task: PlannedTask) => {
      const state = manifest.states[task.id]!;
      // A bounded slow sample must not stop fresh samples; other failure classes retain the guard.
      const boundedTimeout = state.status === "timed_out";
      return !attemptsExhausted(task) && !boundedTimeout && options.taskSource.observesFailures?.(task) !== false;
    };
    const paused = (task: PlannedTask) => observesFailures(task) && guard.paused(task.stage);
    const resourceAvailable = (task: PlannedTask) => options.taskSource.isComputedTask?.(task) || options.modelRequests?.available?.(
      (options.modelRoutesForTask?.(task) ?? [options.modelForStage(task.stage)]).map(model => model.provider)) !== false;
    const dispatchable = (task: PlannedTask) => inScope(task) && !paused(task) &&
      (manifest.states[task.id].status !== "pending" || resourceAvailable(task));
    manifest.concurrency = desiredConcurrency();
    workspace = await createRunWorkspace(run, manifest.debug);
    const working = workspace.directory;
    if (manifest.debug) {
      for (const [name, value] of Object.entries(options.snapshots || {}))
        await writeJson(internalPath(run, safeId(name)), value);
    }
    const modelRequests = createModelRequests(options.modelRequests);
    store = new RunStore(run, saved, inputs, options, modelRequests.deadline, hot);
    manifest.status = "running";
    delete manifest.finishedAt;
    await localFiles.remove(layout.stats, { force: true });
    for (const task of manifest.tasks) {
      delete manifest.states[task.id].nextRetryAt;
      if (!dispatchable(task)) continue;
      const receipt = await store.receipt(task.id),
        state = manifest.states[task.id];
      if (state.admissionBlock && !receipt) {
        state.status = "blocked";
        state.reason = state.admissionBlock;
      } else if (receipt) {
        state.status = "succeeded";
      } else if (attemptsExhausted(task)) {
        state.status = "failed";
        state.reason ??= `Task attempt limit reached: ${state.attempts}/${options.policy.maxTaskAttempts}`;
      } else if ((state.transportFailures ?? 0) > options.retries) {
        state.status = "failed";
        state.reason ??= `Network retry limit reached: ${options.retries}`;
      } else if (options.skipFailed && ["failed", "timed_out", "blocked"].includes(state.status)) {
        continue;
      } else if (contentRemaining(task) <= 0) {
        state.status = "failed";
        state.reason ??= "Content submission budget exhausted";
      } else {
        state.status = "pending";
        delete state.attemptId;
        delete state.reason;
      }
    }
    await store.persistCheckpoint();
    store.startOutbox();
    checkpointTimer = setInterval(() => {
      if (store && !store.checkpointMetrics.failedSince && Date.now() - store.checkpointMetrics.savedAt < 5 * 60_000) return;
      void store?.persistCheckpoint().catch(error => options.logger?.error(error, {
        component: "host", event: "periodic_checkpoint_failed", run_id: options.runId,
      }));
    }, 30_000);
    const current = store;
    const preparing = new Set<string>();
    let readyDemand = 0;
    const taskConcurrency = () => Math.min(options.taskConcurrency ?? Math.max(1, desiredConcurrency()),
      options.taskLimit?.({ running: running.size, ready: current.admissionPaused() || fatalError || options.pauseSignal?.aborted ? 0 : readyDemand }) ?? Infinity);
    const snapshot = () => ({ ...progressSnapshot(saved, Date.now(), preparing, options.taskSource.scheduling?.sessionAdmission), run_id: manifest.runId, in_flight_tasks: busy.size,
      host: { pid: process.pid, live: true }, task_concurrency: taskConcurrency(),
      admission_paused: current.admissionPaused(), workers: supervisor?.snapshot(), model_requests: options.modelRequests?.snapshot?.(),
      checkpoint: { ...current.checkpointMetrics }, outbox: current.outboxStatus() });
    // A task may expose a stage-specific view of its source without persisting a second input.
    const attemptSources = new Map<string, Map<string, unknown>>();
    const materialSources = new Map<string, { value: unknown; users: number }>();
    const lock = await readJson<{ pid: number; token: string }>(layout.lockFile);
    http = await listen(async (req, res, url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "api" && parts[1] === "model-requests" && parts.length === 4) {
        const attemptId = safeId(parts[2]), callId = safeId(parts[3]);
        if (req.method === "DELETE") {
          modelRequests.release(attemptId, callId);
          return json(res, { released: true });
        }
        if (req.method === "POST") {
          const disconnected = new AbortController();
          const close = () => { if (!res.writableEnded) disconnected.abort(new Error("Model permit connection closed")); };
          res.once("close", close);
          // A low-weight lane can legitimately wait beyond the HTTP idle timeout.
          // JSON whitespace keeps the control connection alive without granting a permit.
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.write(" ");
          const keepAlive = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write(" ");
          }, 15_000);
          keepAlive.unref();
          try {
            const model = await modelRequests.acquire(attemptId, callId, AbortSignal.any([controller.signal, disconnected.signal]));
            res.end(JSON.stringify({ model }));
            return;
          } catch (error) {
            const capacity = errorText(error).startsWith("Model capacity unavailable:");
            const clientFault = error instanceof HttpError && error.status < 500;
            if (!capacity && !clientFault && !controller.signal.aborted && !disconnected.signal.aborted) { fatalError ??= { error }; wake(); }
            if (!res.destroyed && !res.writableEnded)
              res.end(JSON.stringify({ error: errorText(error), scope: capacity ? "capacity" : "run" }));
            return;
          } finally { clearInterval(keepAlive); res.off("close", close); }
        }
        throw new HttpError(405, "Method not allowed");
      }
      if (url.pathname === "/api/control/concurrency" && req.method === "POST") {
        if (req.headers["x-run-token"] !== lock.token) throw new HttpError(403, "Invalid run control token");
        const value = ((await body(req)) as { concurrency?: unknown }).concurrency;
        if (!Number.isInteger(value) || Number(value) < 1)
          throw new HttpError(400, "concurrency must be positive");
        concurrencyOverride = Number(value);
        options.modelRequests?.setRunLimit?.(options.runId, concurrencyOverride);
        manifest.concurrency = desiredConcurrency();
        await current.save(undefined, { manifest: true });
        wake();
        return json(res, snapshot());
      }
      if (url.pathname === "/api/control/stop" && req.method === "POST") {
        if (req.headers["x-run-token"] !== lock.token) throw new HttpError(403, "Invalid run control token");
        controller.abort(new Error("Stopped by run control"));
        wake();
        return json(res, { stopping: true });
      }
      if (url.pathname === "/api/progress" && req.method === "GET") return json(res, snapshot());
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "inputs" && parts[2]) {
        const attempt = url.searchParams.get("attempt");
        const value = attempt && attemptSources.get(safeId(attempt))?.get(safeId(parts[2]));
        if (value === undefined || value === null) throw new HttpError(404, "Unknown attempt input");
        return json(res, value);
      }
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "materials" && parts[2]) {
        const material = materialSources.get(safeId(parts[2]));
        if (!material) throw new HttpError(404, "Unknown active material");
        return json(res, material.value);
      }
      if (req.method === "POST" && parts[0] === "api" && parts[1] === "tasks" && parts[3] === "checkpoint") {
        await current.checkpoint(safeId(parts[2]), (await body(req)) as unknown as FailureContext);
        return json(res, { saved: true });
      }
      if (req.method === "POST" && url.pathname === "/api/evidence-bank")
        return json(res, await current.registerEvidenceBank((await body(req)) as unknown as import("@eval/contracts").EvidenceBankUpdate));
      if (req.method === "POST" && url.pathname === "/api/inspections")
        return json(res, await current.inspect((await body(req)) as unknown as import("@eval/contracts").MaterialInspection));
      if (req.method === "POST" && url.pathname === "/api/submissions") {
        const value = (await body(req)) as Submission;
        const receipt = await current.accept(value);
        completions++;
        wake();
        return json(res, receipt);
      }
      if (req.method === "GET" && parts[0] === "api" && parts[1] === "submissions" && parts[2])
        return json(res, await current.findSubmission(safeId(parts[2])));
      throw new HttpError(404, "Not found");
    });
    await writeJson(layout.lockFile, { ...lock, url: http.url });
    progressTimer = setInterval(
      () => options.onProgress?.("progress " + JSON.stringify(snapshot())),
      10000,
    );
    let workerUrls = options.workerUrls || [];
    const sessionAdmission = options.taskSource.scheduling?.sessionAdmission;
    let admission: ReturnType<typeof sessionAdmissionSnapshot> | undefined;
    const admitted = (task: PlannedTask) => {
      const id = sessionAdmission?.id(task);
      return !id || admission?.admitted.has(id);
    };
    const runnable = (task: PlannedTask) => !current.admissionPaused() &&
      manifest.states[task.id].status === "pending" && !running.has(task.id) && !executionStopReason(manifest) && dispatchable(task) &&
      (manifest.states[task.id].nextRetryAt ?? 0) <= Date.now() &&
      Object.keys(task.dependencies).every(label => dependencyReady(task, label, manifest.states, running)) &&
      admitted(task) && options.taskSource.canStart?.(task, manifest) !== false;
    const initialHealth = await Promise.allSettled(workerUrls.map(url => request<WorkerStatus>(`${url}/api/health`)));
    const initiallyUnavailable = new Set<WorkerSlot>();
    const workers: WorkerSlot[] = workerUrls.map((url, index) => {
      const observed = initialHealth[index];
      const slot: WorkerSlot = { url, health: observed.status === "fulfilled" ? observed.value : { identity, tools: [], activeAttempt: null } };
      if (observed.status === "rejected") initiallyUnavailable.add(slot);
      return slot;
    });
    let eligible = workers.filter((w) => canonical(w.health.identity) === canonical(identity));
    if (workerUrls.length && !eligible.length && taskConcurrency() > 0 && !options.pauseSignal?.aborted) throw new Error("No worker matches the selected build");
    const unavailable = new Map<(typeof workers)[number], { since: number; checkAt: number }>();
    const deferWorker = (worker: (typeof workers)[number]) => unavailable.set(worker, {
      since: unavailable.get(worker)?.since ?? Date.now(), checkAt: Date.now() + 1000,
    });
    if (!workerUrls.length && !supervisor) {
      supervisor = new WorkerSupervisor({ identity, runtime: options.runtime,
        directory: path.join(working, "workers"), retries: options.retries,
        retryDelaySeconds: options.retryDelaySeconds, wake: () => wake(),
        event: (event, detail) => {
          options.onProgress?.(event + " " + JSON.stringify(detail));
          void options.logger?.event?.(event, { component: "host", run_id: options.runId, ...detail });
        } });
    }
    for (const worker of eligible) if (worker.health.activeAttempt || initiallyUnavailable.has(worker)) deferWorker(worker);
    const hostUrl = http.url;
    async function copyArtifacts(
      workerUrl: string,
      spec: AttemptSpec,
      artifacts: Artifact[],
      destination: string,
    ): Promise<void> {
      for (const artifact of artifacts) {
        safeId(artifact.id);
        const response = await fetch(`${workerUrl}/api/attempts/${spec.attemptId}/artifacts/${artifact.id}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Artifact unavailable");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== artifact.bytes) throw new Error("Artifact length mismatch");
        await atomicWrite(path.join(destination, artifact.id), bytes);
      }
    }
    const retryBudgets = new Map<string, { content: number }>();
    async function execute(
      task: PlannedTask,
      worker: (typeof workers)[number],
      prepared: ReturnType<typeof options.agents.prepare>,
      binding: AgentBinding,
      timing: Record<string, number>,
    ): Promise<void> {
      const sources = binding.request.sources;
      const workerUrl = worker.url;
      const state = manifest.states[task.id];
      const taskModel = () => options.modelForTask?.(task, state.channel) ?? options.modelForStage(task.stage);
      const model = taskModel();
      const retries = retryBudgets.get(task.id) ?? {
        content: 0,
      };
      retryBudgets.set(task.id, retries);
      if (paused(task)) return;
      if (contentRemaining(task) <= 0) {
        state.status = "failed";
        state.reason ??= "Content submission budget exhausted";
        await current.save(task.id);
        return;
      }
      if (controller.signal.aborted) {
        state.status = "cancelled";
        await current.save(task.id);
        return;
      }
      let ready = false;
      try {
        const health = await request<WorkerStatus>(
          `${workerUrl}/api/health`,
          "GET",
          undefined,
          AbortSignal.timeout(10000),
        );
        ready = !supervisor?.exited(worker.owner) &&
          !health.activeAttempt && canonical(health.identity) === canonical(identity);
      } catch {}
      if (!ready) {
        deferWorker(worker);
        state.status = "pending";
        await current.save(task.id);
        return;
      }
      if (paused(task)) return;
      // Automatic retries and explicit resume share the task's cumulative content cap.
      state.channel = model.provider;
      const policy = { ...options.policy, maxToolCalls: Math.min(options.policy.maxToolCalls, prepared.maxToolCalls ?? Infinity),
        repairAttempts: contentRemaining(task) - 1 };
      const renderStarted = performance.now();
      const spec: AttemptSpec = {
        runId: options.runId,
        debug: manifest.debug,
        taskId: task.id,
        attemptId: randomUUID(),
        inputRevision: state.revision || 1,
        engine: identity,
        evaluation: prepared.evaluation,
        model,
        policy,
        prompt: prepared.renderAttempt(policy, state.failure),
        evidenceBank: [...prepared.evidenceBank],
        recovery: state.failure,
        inputs: Object.entries(task.inputIds).map(([name, id]) => ({
          ...manifest.inputs[id],
          id,
          name,
        })),
        hostUrl,
        deadline: Date.now() + options.policy.timeoutSeconds * 1000,
        ...(options.modelRequests ? { controlModelRequests: true } : {}),
      };
      timing.renderMs = performance.now() - renderStarted;
      const bound = new Map<string, unknown>();
      for (const ref of spec.inputs) {
        const source = sources[ref.name];
        if (!source || source.id !== ref.id) throw new Error(`Task source mismatch: ${ref.name}`);
        if (source.value && typeof source.value === "object") {
          let materialId = materialIds.get(source.value);
          if (!materialId) materialIds.set(source.value, materialId = randomUUID());
          ref.materialId = materialId;
        }
        bound.set(ref.id, source.value);
      }
      attemptSources.set(spec.attemptId, bound);
      modelRequests.register(spec, task, options.modelRoutesForTask?.(task), options.trafficGroup);
      for (const ref of spec.inputs) if (ref.materialId) {
        const material = materialSources.get(ref.materialId);
        if (material) material.users++;
        else materialSources.set(ref.materialId, { value: bound.get(ref.id), users: 1 });
      }
      try {
      let lastSeq = -1;
      const activateStarted = performance.now();
      if (!await current.activate(spec, binding)) return;
      timing.activateMs = performance.now() - activateStarted;
      const attemptDir = internalPath(
        run,
        "tasks",
        task.id,
        `attempt-${state.attempts.toString().padStart(3, "0")}`,
      );
      const eventController = new AbortController();
      let stream: Promise<boolean> | undefined, status: AttemptStatus | undefined;
      let observedTerminal: AttemptStatus | undefined;
      let eventCursor = 0, eventType: string | undefined, terminalSeq: number | undefined;
      let drainingEvents = false, eventIdle: NodeJS.Timeout | undefined, eventArchiveError: string | undefined;
      const resetEventIdle = () => {
        clearTimeout(eventIdle);
        eventIdle = setTimeout(() => eventController.abort(new Error("Terminal event stream made no progress")),
          spec.policy.idleTimeoutSeconds * 1000);
      };
      let eventsSaved = false;
      let attemptDidNotStart = false;
      try {
        const dispatchStarted = performance.now();
        for (let dispatch = 0; ; dispatch++) {
          try {
            await request(`${workerUrl}/api/attempts`, "POST", spec, controller.signal);
            break;
          } catch (error) {
            try {
              await request(`${workerUrl}/api/attempts/${spec.attemptId}`);
              break;
            } catch (lookup) {
              const absent = lookup instanceof HttpError && lookup.status === 404;
              const code = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
                ? error.cause.code : undefined;
              const transient = error instanceof Error && (error.name === "TimeoutError" ||
                ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(String(code)));
              // Worker creation is idempotent for this exact attempt/spec. Reconnect
              // before a missing dispatch consumes a new attempt or pauses the stage.
              if (absent && transient && dispatch < 2 && !controller.signal.aborted) continue;
              // An explicit pre-execution rejection and an absent attempt prove
              // that this dispatch cannot have spent content submissions.
              attemptDidNotStart = error instanceof HttpError && error.status >= 400 && error.status < 500 && absent;
              throw error;
            }
          }
        }
        timing.dispatchMs = performance.now() - dispatchStarted;
        preparing.delete(task.id);
        options.onProgress?.(`running ${task.stage} ${task.id} attempt ${state.attempts}`);
        void options.logger?.event?.("task_prepared", { component: "host", run_id: options.runId,
          task_id: task.id, attempt_id: spec.attemptId, channel: model.provider, timings: timing });
        if (manifest.debug || options.onEvent)
          stream = consumeEvents(
            workerUrl,
            spec.attemptId,
            manifest.debug ? path.join(attemptDir, "events.jsonl") : undefined,
            eventController.signal,
            (event) => {
              // consumeEvents invokes this only after its completed local append.
              eventCursor = event.seq;
              eventType = event.type;
              if (drainingEvents) resetEventIdle();
              if (terminalSeq !== undefined && event.seq >= terminalSeq &&
                  (event.seq !== terminalSeq || event.type !== "finished"))
                eventController.abort(new Error("Event stream does not match the terminal sequence"));
              try { options.onEvent?.(event); }
              catch (error) { eventController.abort(error); }
            },
          );
        // Observe an active attempt promptly, then back off so a quiet model turn
        // keeps the documented one-request-per-second cadence.
        let pollMs = 25;
        while (true) {
          if (controller.signal.aborted || Date.now() > modelRequests.deadline(spec)) {
            const receipt = await current.receipt(task.id);
            if (!receipt)
              await current.endAttempt(
                spec,
                controller.signal.aborted ? "cancelled" : "timed_out",
                controller.signal.aborted ? "Interrupted" : "Task deadline exceeded",
              );
            await request(`${workerUrl}/api/attempts/${spec.attemptId}/cancel`, "POST", {}, AbortSignal.timeout(5000)).catch(() => {});
            break;
          }
          try {
            status = await request<AttemptStatus>(
              `${workerUrl}/api/attempts/${spec.attemptId}`,
              "GET",
              undefined,
              AbortSignal.timeout(10000),
            );
          } catch (error) {
            // Observation may fail transiently while the worker computes or submits.
            // Keep this attempt; the loop still enforces cancellation and its deadline.
            const code = error instanceof Error && error.cause && typeof error.cause === "object" && "code" in error.cause
              ? error.cause.code : undefined;
            if (!(error instanceof Error) || (error.name !== "TimeoutError" &&
                !["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(String(code)))) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          if (status.lastSeq !== lastSeq) {
            state.lastProgressAt = Date.now();
            lastSeq = status.lastSeq;
            pollMs = 25;
          } else pollMs = Math.min(1000, pollMs * 2);
          state.phase = status.phase;
          state.timeoutPhase = status.timeoutPhase;
          if (status.modelChannel) state.channel = status.modelChannel;
          if (status.state !== "running") {
            observedTerminal = status;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } catch (error) {
        if (worker.owner && !controller.signal.aborted) supervisor?.retire(worker, "Worker attempt transport failed: " + errorText(error));
        status = {
          state: "failed",
          lastSeq: 0,
          error: redact(errorText(error), [process.env[model.apiKeyEnv] || ""]),
          errorDetail: redact(inspect(error, { depth: null, maxStringLength: null, maxArrayLength: null }),
            [process.env[model.apiKeyEnv] || ""]),
          retryable: true,
        };
      }
      let receipt = await current.receipt(task.id);
      // A failed connection does not imply the old session has stopped. Settle it before reuse.
      if (!status || status.state === "running" || status.retryable) {
        if (!receipt)
          await current.endAttempt(
            spec,
            controller.signal.aborted ? "cancelled" : state.status === "timed_out" || status?.state === "timed_out" ? "timed_out" : "failed",
            state.reason || status?.error || "Worker disconnected",
          );
        await request(
          `${workerUrl}/api/attempts/${spec.attemptId}/cancel`,
          "POST",
          {},
          AbortSignal.timeout(5000),
        ).catch(() => {});
        deferWorker(worker);
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          try {
            const health = await request<WorkerStatus>(
              `${workerUrl}/api/health`,
              "GET",
              undefined,
              AbortSignal.timeout(1000),
            );
            if (!health.activeAttempt) { unavailable.delete(worker); break; }
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (worker.owner && unavailable.has(worker)) supervisor?.retire(worker, "Attempt failed to settle");
      let record: AttemptRecord = { spec, status };
      try {
        const archived = await request<AttemptRecord>(
          `${workerUrl}/api/attempts/${spec.attemptId}/record`,
          "GET",
          undefined,
          AbortSignal.timeout(1000),
        );
        if (canonical(archived.spec) !== canonical(spec))
          throw new Error("Attempt record identity mismatch");
        record = archived;
        if (archived.status && archived.status.state !== "running") observedTerminal = archived.status;
      } catch {
        /* A crashed worker may not have finalized its usage ledger. Events remain available. */
      }
      // A terminal worker can outrun the Host's durable SSE sink. Drain the exact
      // published boundary, with an idle limit reset by actual local write progress.
      terminalSeq = observedTerminal?.lastSeq;
      if (stream) {
        drainingEvents = true;
        resetEventIdle();
        if (typeof terminalSeq !== "number" || !Number.isSafeInteger(terminalSeq) || terminalSeq < 0 ||
            eventCursor >= terminalSeq && (eventCursor !== terminalSeq || eventType !== "finished")) eventController.abort();
        try {
          eventsSaved = await stream && Number.isSafeInteger(terminalSeq) &&
            eventCursor === terminalSeq && eventType === "finished";
        } finally {
          clearTimeout(eventIdle);
          eventController.abort();
        }
        if (!eventsSaved) eventArchiveError = `Terminal event archive incomplete: persisted seq ${eventCursor}, ` +
          `worker terminal seq ${terminalSeq ?? "unavailable"}.` +
          (manifest.debug ? " Local prefix retained; Worker cleanup skipped." : "");
      }
      if (!record.metrics && observedTerminal) {
        try {
          const finalized = await request<AttemptRecord>(`${workerUrl}/api/attempts/${spec.attemptId}/record`,
            "GET", undefined, AbortSignal.timeout(1000));
          if (canonical(finalized.spec) === canonical(spec)) record = finalized;
        } catch { /* Missing accounting stays visible; do not invent zero consumption. */ }
      }
      const eventsFile = path.join(attemptDir, "events.jsonl");
      if (manifest.debug && eventsSaved && (await exists(eventsFile))) await compressFile(eventsFile);
      // A submission can commit while terminal records/events are being collected.
      // Serialize termination with acceptance, then use the durable receipt for
      // artifacts, failure accounting and retries rather than the earlier poll.
      if (!receipt && state.status === "running")
        await current.endAttempt(
          spec,
          controller.signal.aborted
            ? "cancelled"
            : status?.state === "timed_out"
              ? "timed_out"
              : status?.state === "cancelled"
                ? "cancelled"
                : "failed",
          status?.error || "No committed receipt",
        );
      receipt = await current.receipt(task.id);
      const finalFailure = (record.status && record.status.state !== "running"
        ? record.failure ?? record.status.failure : undefined) ??
        (status && status.state !== "running" ? status.failure : undefined);
      const recoveredContent = spec.recovery?.contentSubmissions ?? 0;
      const knownContent = Math.max(recoveredContent, state.failure?.contentSubmissions ?? 0);
      const contentLedgerConfirmed = (attemptDidNotStart && knownContent === recoveredContent) || (finalFailure?.attemptId === spec.attemptId &&
        Number.isSafeInteger(finalFailure.contentSubmissions) &&
        finalFailure.contentSubmissions >= knownContent);
      let copied = false;
      try {
        const artifacts = [
          ...new Map(
            [...(record.metrics?.audit.artifacts || []), ...(receipt?.audit.artifacts || [])].map(
              (artifact) => [artifact.id, artifact],
            ),
          ).values(),
        ];
        const retained = manifest.debug ? artifacts : [];
        await copyArtifacts(workerUrl, spec, retained, path.join(working, "tasks", task.id, "artifacts"));
        copied = true;
        state.artifactStatus = {
          status: manifest.debug ? "available" : "not_retained",
          source: manifest.debug ? "run" : "worker-temporary",
        };
      } catch (error) {
        record.artifactError = errorText(error);
        await options.logger?.error(error, {
          component: "host",
          event: "artifact_copy_failed",
          run_id: options.runId,
          task_id: task.id,
          attempt_id: spec.attemptId,
        });
        state.artifactStatus = {
          status: "missing",
          source: workerUrl,
          error: record.artifactError,
        };
      }
      if (eventArchiveError) {
        record.artifactError = [record.artifactError, eventArchiveError].filter(Boolean).join("; ");
        if (manifest.debug) state.artifactStatus = { status: "missing", source: workerUrl, error: record.artifactError };
        await options.logger?.error(eventArchiveError, {
          component: "host", event: "event_archive_incomplete", run_id: options.runId,
          task_id: task.id, attempt_id: spec.attemptId,
        });
      }
      if (receipt) {
        state.status = "succeeded";
        await current.save(task.id);
      }
      if (!receipt) {
        record.error = state.reason;
        if (finalFailure || record.failure || status?.failure) {
          const failure = finalFailure || record.failure || status?.failure;
          if (failure) {
            const { inspection: _workerInspection, ...reported } = failure;
            const persistedBank = state.failure?.evidenceBank ?? spec.evidenceBank;
            const workerBank = reported.evidenceBank ?? record.evidenceBank ?? spec.evidenceBank;
            const shorter = persistedBank.length <= workerBank.length ? persistedBank : workerBank;
            const evidenceBank = persistedBank.length <= workerBank.length ? workerBank : persistedBank;
            validateEvidenceBank(evidenceBank, shorter);
            validateEvidenceBankSources(evidenceBank, new Map(spec.inputs.map(input => [input.id, sources[input.name]?.value])), persistedBank.length);
            state.failure = { ...reported, evidenceBank: [...evidenceBank], contentSubmissions: Math.max(knownContent,
              Number.isSafeInteger(failure.contentSubmissions) && failure.contentSubmissions >= 0 ? failure.contentSubmissions : 0),
              ...(state.failure?.inspection ? { inspection: state.failure.inspection } : {}) };
          }
        }
        if (!contentLedgerConfirmed) {
          const message = "Worker 最终提交账本不可用，无法确认剩余内容额度；已保留已确认计数并结束本轮尝试，等待同一 run 续跑。";
          state.reason = state.reason ? `${state.reason}；${message}` : message;
          const previous = state.failure;
          state.failure = {
            ...previous,
            errors: [...(previous?.errors ?? []), {
              category: "transport", code: "submission_ledger_unavailable", path: "/", message,
            }],
            contentSubmissions: previous?.contentSubmissions ?? spec.recovery?.contentSubmissions ?? 0,
            fileErrors: previous?.fileErrors ?? spec.recovery?.fileErrors ?? 0,
            repeatedErrors: previous?.repeatedErrors ?? 0,
            stopped: previous?.stopped ?? false,
            attemptId: spec.attemptId,
          };
          record.failure = state.failure;
          record.error = state.reason;
        }
      }
      const errors: FailureContext["errors"] = receipt ? [] :
        (state.failure?.attemptId === spec.attemptId && state.failure.errors.length ? state.failure.errors : [{
          category: status?.retryable ? "transport" : "interruption",
          code: status?.retryable ? "transport_failed" : state.status === "timed_out" ? "attempt_timeout" : "attempt_failed",
          path: "/",
          message: state.reason || "No committed receipt",
        }]);
      const terminal = record.status ?? status;
      const effectiveModel = { ...model, provider: terminal?.modelChannel ?? model.provider };
      if (!receipt && (terminal?.modelQuotaExhausted || terminal?.modelConfigurationError))
        options.modelRequests?.disable?.(effectiveModel.provider, terminal.error ?? "Model channel unavailable");
      const rerouted = !receipt && !controller.signal.aborted && !paused(task) && !state.failure?.stopped &&
        contentLedgerConfirmed && contentRemaining(task) > 0 &&
        terminal?.modelQuotaExhausted === true && options.onModelQuotaExhausted?.(effectiveModel, task) === true &&
        taskModel().provider !== effectiveModel.provider;
      const infrastructureLoss = !receipt && (supervisor?.exited(worker.owner) && !terminal?.timeoutPhase ||
        terminal?.capacityUnavailable || terminal?.modelConfigurationError || terminal?.modelQuotaExhausted && !rerouted);
      if (!receipt && !infrastructureLoss && status?.retryable && status.state !== "timed_out" && !controller.signal.aborted && !rerouted)
        state.transportFailures = (state.transportFailures ?? 0) + 1;
      const timedOut = !receipt && (status?.state === "timed_out" || state.status === "timed_out");
      if (timedOut) state.timeoutFailures = (state.timeoutFailures ?? 0) + 1;
      const retryingTimeout = timedOut && ["model_first_response", "model_stream"].includes(terminal?.timeoutPhase ?? "") &&
        state.timeoutFailures! <= 1 && contentLedgerConfirmed && !state.failure?.stopped;
      const retryingTransport = !receipt && status?.retryable && contentLedgerConfirmed &&
        !state.failure?.stopped && !attemptsExhausted(task) && contentRemaining(task) > 0 &&
        (state.transportFailures ?? 0) <= options.retries;
      // Count a transport outage only after this task's bounded retries. At high
      // concurrency, one brief outage must not preempt every task's first retry.
      const pause = controller.signal.aborted || infrastructureLoss || rerouted || retryingTransport || retryingTimeout || !observesFailures(task)
        ? undefined : guard.observe(task.stage, task.id, errors);
      if (!receipt && !controller.signal.aborted) await options.logger?.error(state.reason || "No committed receipt", {
        component: "host", event: rerouted ? "model_channel_switched" : "attempt_failed", run_id: options.runId, task_id: task.id,
        ...(rerouted ? { from_channel: model.provider, to_channel: taskModel().provider,
          reason: "model_quota_exhausted" } : {}),
        attempt_id: spec.attemptId, stage: task.stage, errors,
        evaluator_model: model.model, evaluator_version: options.evaluatorVersion, channel: model.provider, attempt: state.attempts,
        detail: status?.errorDetail ?? record.status?.errorDetail,
      });
      if (pause) {
        await current.save(task.id, { manifest: true });
        options.onProgress?.("stage_paused " + JSON.stringify(pause));
        await options.logger?.error(`同类失败达到阈值，暂停 ${pause.stage}: ${pause.code} ${pause.path}`, {
          component: "host", event: "stage_paused", run_id: options.runId, task_id: task.id,
        });
        wake();
      }
      if (manifest.debug) await writeJson(path.join(attemptDir, "attempt.json"), record);
      state.durationMs = (state.durationMs || 0) + Date.now() - state.startedAt!;
      if (record.metrics) {
        await options.logger?.event?.("attempt_metrics", { component: "host", run_id: options.runId,
          task_id: task.id, attempt_id: spec.attemptId, channel: model.provider,
          timings: record.metrics.timings ?? {}, usage: record.metrics.usage,
          calls: record.metrics.audit.calls, requiredReadCalls: record.metrics.audit.requiredReadCalls,
          contentSubmissions: receipt?.submissionStats?.contentSubmissions ?? state.failure?.contentSubmissions ?? 0,
          confirmed: Boolean(receipt), status: state.status });
        for (const key of Object.keys(saved.usage) as (keyof typeof saved.usage)[])
          saved.usage[key] += record.metrics.usage[key] || 0;
        saved.recordedAttempts++;
      }
      await current.save(task.id, { usage: true });
      if (
        (!manifest.debug || (copied && eventsSaved && record.metrics)) &&
        record.status &&
        record.status.state !== "running"
      )
        await request(`${workerUrl}/api/attempts/${spec.attemptId}`, "DELETE", undefined, AbortSignal.timeout(10_000)).catch(async (error) => {
          await options.logger?.error(error, {
            component: "host",
            event: "worker_cleanup_failed",
            run_id: options.runId,
            task_id: task.id,
            attempt_id: spec.attemptId,
          });
          supervisor?.retire(worker, "Worker cleanup failed: " + errorText(error));
          if (!worker.owner) deferWorker(worker);
          options.onProgress?.(`Worker 副本未释放：${errorText(error)}`);
        });
      if ((record.status ?? status)?.workerUnusable) supervisor?.retire(worker, "Worker reported unusable after cleanup");
      if (receipt) {
        options.onProgress?.(`succeeded ${task.stage} ${task.id}`);
        return;
      }
      if (infrastructureLoss || supervisor?.exited(worker.owner) && !timedOut) {
        state.status = "pending";
        state.reason = terminal?.capacityUnavailable || terminal?.modelQuotaExhausted || terminal?.modelConfigurationError
          ? terminal.error ?? "Model request admission unavailable" : "Worker process lost; awaiting healthy capacity";
        await current.save(task.id);
        return;
      }
      if (controller.signal.aborted || paused(task) || attemptsExhausted(task) || state.failure?.stopped ||
        !contentLedgerConfirmed || contentRemaining(task) <= 0) return;
      if (timedOut) {
        if (!retryingTimeout) return;
      } else if (status?.retryable && !rerouted) {
        if ((state.transportFailures ?? 0) > options.retries) return;
      } else if (!rerouted &&
        state.failure?.draft &&
        state.failure.errors.some((e) => ["structure", "evidence", "decision"].includes(e.category))
      ) {
        if (retries.content++ >= 1) return;
      } else if (!rerouted) return;
      const retryDelay = !rerouted && status?.retryable ? options.retryDelaySeconds * 1000 * 2 ** Math.max(0, (state.transportFailures ?? 1) - 1) : 0;
      state.status = "pending";
      state.nextRetryAt = Date.now() + retryDelay;
      await current.save(task.id);
      // Return the worker and concurrency slot while this task backs off.
      } finally {
        modelRequests.remove(spec.attemptId);
        attemptSources.delete(spec.attemptId);
        for (const ref of spec.inputs) if (ref.materialId) {
          const material = materialSources.get(ref.materialId)!;
          if (--material.users === 0) materialSources.delete(ref.materialId);
        }
      }
    }
    const runningChannels = new Map<string, string>();
    let completions = 0, persistencePaused = false;
    while (true) {
      if (controller.signal.aborted) break;
      if (fatalError) {
        const error = fatalError.error;
        modelRequests.stopAdmission(error);
        await Promise.all(running.values());
        throw error;
      }
      admission = sessionAdmission ? sessionAdmissionSnapshot(manifest.tasks, manifest.states, sessionAdmission, manifest) : undefined;
      readyDemand = manifest.tasks.filter(runnable).length;
      taskConcurrency();
      manifest.concurrency = desiredConcurrency();
      if (supervisor) {
        const demand = running.size + readyDemand;
        supervisor.setDemand(options.runId, demand ? Math.min(taskConcurrency(), Math.max(options.runtime.workerSlots ?? 1, demand)) : 0);
        eligible = supervisor.slots;
        for (const slot of unavailable.keys()) if (supervisor.exited(slot.owner)) unavailable.delete(slot);
        if (supervisor.exhausted() && !running.size && manifest.tasks.some(runnable)) { resourcePause = "worker_capacity_unavailable"; break; }
      }
      if (options.pauseSignal?.aborted) {
        await Promise.all(running.values());
        break;
      }
      if (current.admissionPaused()) {
        if (!persistencePaused) {
          persistencePaused = true;
          options.onProgress?.("run_paused persistence_unavailable");
          await options.logger?.error("Persistence recovery window exceeded; new tasks are paused", {
            component: "host", event: "persistence_paused", run_id: options.runId });
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      if (persistencePaused) { persistencePaused = false; options.onProgress?.("run_resumed persistence_recovered"); }
      if (executionStopReason(manifest) && running.size === 0) break;
      changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      await Promise.all([...unavailable].filter(([, value]) => value.checkAt <= Date.now()).map(async ([worker]) => {
        try {
          const health = await request<WorkerStatus>(worker.url + "/api/health", "GET", undefined, AbortSignal.timeout(1000));
          if (!supervisor?.exited(worker.owner) && !health.activeAttempt &&
              canonical(health.identity) === canonical(identity)) {
            worker.health = health;
            unavailable.delete(worker);
            return;
          }
        } catch { /* Health observations do not spend task attempts. */ }
        if (worker.owner && Date.now() - unavailable.get(worker)!.since >= 10_000)
          supervisor?.retire(worker, "Worker did not become reusable");
        deferWorker(worker);
      }));
      let scheduled = false;
      const blockedStates = new Set<string>();
      const scheduledAtCompletion = completions;
      let reschedule = false;
      for (const task of scheduleTasks(manifest.tasks.filter(dispatchable), manifest.states, options.taskSource.scheduling?.stagePriority)) {
        if (controller.signal.aborted || options.pauseSignal?.aborted || fatalError || current.admissionPaused() || executionStopReason(manifest)) break;
        // Worker startup and preparation yield while dependencies finish. Refresh
        // the stage order before admitting more of the old upstream backlog.
        if (completions !== scheduledAtCompletion) { reschedule = true; break; }
        if (!dispatchable(task)) continue;
        if (manifest.states[task.id].status !== "pending" || running.has(task.id) ||
            (manifest.states[task.id].nextRetryAt ?? 0) > Date.now()) continue;
        const dependencies = Object.entries(task.dependencies);
        if (dependencies.some(([label, id]) => !dependencyReady(task, label, manifest.states, running) && !running.has(id) && manifest.states[id]?.status &&
          !["pending", "running", "succeeded"].includes(manifest.states[id].status))) {
          manifest.states[task.id].status = "blocked";
          manifest.states[task.id].reason = "Dependency did not succeed";
          blockedStates.add(task.id);
          continue;
        }
        if (dependencies.some(([label]) => !dependencyReady(task, label, manifest.states, running))) continue;
        if (!admitted(task)) continue;
        if (options.taskSource.canStart?.(task, manifest) === false) continue;
        if (!options.taskSource.isComputedTask?.(task)) {
          if (running.size >= taskConcurrency()) break;
          if (eligible.every((worker) => busy.has(worker) || worker.reserved || unavailable.has(worker))) break;
        }
        let binding: AgentBinding, prepared: ReturnType<typeof options.agents.prepare>,
          timing: Record<string, number>, capable: typeof eligible;
        try {
          const acceptedDependencies = await current.dependencies(task);
          const reason = options.taskSource.blockedReason?.(task, acceptedDependencies);
          if (reason) {
            manifest.states[task.id].status = "blocked";
            manifest.states[task.id].reason = reason;
            blockedStates.add(task.id);
            continue;
          }
          preparing.add(task.id);
          options.onProgress?.(`preparing ${task.stage} ${task.id}`);
          await yieldToIO();
          // A pool can exit during the yield; wait for replacement before loading task materials.
          if (!eligible.length && !options.taskSource.isComputedTask?.(task)) { preparing.delete(task.id); break; }
          const preparationStarted = performance.now(), cpuStarted = process.cpuUsage();
          binding = options.taskSource.bind(task, inputs, acceptedDependencies, { tasks: manifest.tasks });
          const bindingMs = performance.now() - preparationStarted;
          if (paused(task)) { preparing.delete(task.id); continue; }
          prepared = options.agents.prepare(binding);
          if (Object.hasOwn(binding, "computedResult")) {
            const started = Date.now(), model = options.modelForStage(task.stage);
            const spec: AttemptSpec = { runId: options.runId, taskId: task.id, attemptId: randomUUID(),
              inputRevision: manifest.states[task.id].revision || 1, engine: identity,
              evaluation: prepared.evaluation, model: { ...model, model: "code", thinking: "off" },
              policy: { ...options.policy, maxToolCalls: 0 }, prompt: "", evidenceBank: [],
              inputs: Object.entries(task.inputIds).map(([name, id]) => ({ ...manifest.inputs[id], id, name })),
              hostUrl, deadline: started + options.policy.timeoutSeconds * 1000 };
            if (!await current.activate(spec, binding)) { preparing.delete(task.id); continue; }
            manifest.states[task.id].durationMs = Date.now() - started;
            await current.accept({ taskId: task.id, attemptId: spec.attemptId, submissionId: randomUUID(),
              evaluation: binding.computedResult, usage: emptyUsage(),
              audit: { evidenceBank: [], calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] } });
            preparing.delete(task.id); scheduled = true; completions++;
            options.onProgress?.(`computed ${task.stage} ${task.id}`);
            continue;
          }
          const cpu = process.cpuUsage(cpuStarted);
          timing = { queuedMs: Math.max(0, Date.now() - (manifest.states[task.id].nextRetryAt ?? manifest.startedAt)),
            bindingMs, profileMs: performance.now() - preparationStarted - bindingMs,
            preparationCpuMs: (cpu.user + cpu.system) / 1000, ...binding.preparationTimings };
          capable = eligible.filter(w => prepared.evaluation.toolNames.every(name => w.health.tools.includes(name)));
          if (!capable.length) throw new Error("Required tools not available");
        } catch (error) {
          preparing.delete(task.id);
          const state = manifest.states[task.id];
          state.status = controller.signal.aborted ? "cancelled" : "failed";
          state.reason = "Task preparation failed: " + errorText(error);
          delete state.nextRetryAt;
          await current.save(task.id);
          await options.logger?.error(error, { component: "host", event: "task_preparation_failed",
            run_id: options.runId, task_id: task.id, stage: task.stage });
          scheduled = true;
          continue;
        }
        if (controller.signal.aborted || options.pauseSignal?.aborted || fatalError || current.admissionPaused() || executionStopReason(manifest)) {
          preparing.delete(task.id); break;
        }
        const worker = capable.find((w) => !busy.has(w) && !w.reserved && !unavailable.has(w));
        if (!worker) { preparing.delete(task.id); continue; }
        if (running.size >= taskConcurrency()) { preparing.delete(task.id); break; }
        if (options.channelConcurrency) {
          const channel = (options.modelForTask?.(task, manifest.states[task.id].channel) ?? options.modelForStage(task.stage)).provider;
          const limit = options.channelConcurrency[channel];
          if (limit !== undefined && [...runningChannels.values()].filter(value => value === channel).length >= limit) { preparing.delete(task.id); continue; }
          runningChannels.set(task.id, channel);
        }
        delete manifest.states[task.id].nextRetryAt;
        busy.add(worker);
        worker.reserved = true;
        scheduled = true;
        const promise = execute(task, worker, prepared, binding, timing)
          .catch(error => { fatalError ??= { error }; })
          .finally(() => {
            preparing.delete(task.id);
            running.delete(task.id);
            taskConcurrency();
            runningChannels.delete(task.id);
            busy.delete(worker);
            worker.reserved = false;
            completions++;
            wake();
          });
        running.set(task.id, promise);
        readyDemand = Math.max(0, readyDemand - 1);
        taskConcurrency();
        // Binding can be CPU-heavy. Let dispatched Workers, permits and checkpoints
        // make progress before preparing the next task in a large cohort.
        await yieldToIO();
      }
      if (blockedStates.size) {
        const ids = [...blockedStates];
        await current.save(undefined, { manifest: false, stateIds: ids });
        blockedStates.clear();
      }
      if (reschedule) continue;
      const retryDeadlines = manifest.tasks.filter(task => !executionStopReason(manifest) && dispatchable(task) &&
        manifest.states[task.id].status === "pending" && (manifest.states[task.id].nextRetryAt ?? 0) > Date.now())
        .map(task => manifest.states[task.id].nextRetryAt!);
      if (running.size || retryDeadlines.length || supervisor && manifest.tasks.some(runnable) && !supervisor.exhausted()) {
        const dispatchWait = !executionStopReason(manifest) && manifest.executionLimits?.stopStartingAt !== undefined
          ? Math.max(0, manifest.executionLimits.stopStartingAt - Date.now()) : Infinity;
        const waitMs = Math.min(options.modelRequests ? 100 : Infinity, dispatchWait, unavailable.size || supervisor ? 1000 : Infinity, ...retryDeadlines.map(at => Math.max(0, at - Date.now())));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([changed,
          ...(Number.isFinite(waitMs) ? [new Promise(resolve => { timer = setTimeout(resolve, waitMs); })] : [])]); }
        finally { clearTimeout(timer); }
      }
      else if (taskConcurrency() === 0 && manifest.tasks.some(runnable)) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      else if (unavailable.size && manifest.tasks.some(runnable)) {
        if ([...unavailable.values()].every(({ since }) => Date.now() - since >= options.policy.timeoutSeconds * 1000))
          { resourcePause = "external_worker_capacity_unavailable"; break; }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      else if (!scheduled) {
        if (manifest.tasks.some(task => inScope(task) && manifest.states[task.id].status === "pending" && !resourceAvailable(task)))
          resourcePause = "model_channels_unavailable";
        break;
      }
    }
    await Promise.all(running.values());
    readyDemand = 0;
    taskConcurrency();
    for (const state of Object.values(manifest.states)) delete state.nextRetryAt;
    if (controller.signal.aborted)
      for (const task of manifest.tasks)
        if (inScope(task) && manifest.states[task.id].status === "pending") manifest.states[task.id].status = "cancelled";
    if (manifest.tasks.some(task => inScope(task) && manifest.states[task.id].status === "pending"))
      manifest.executionStopReason = executionStopReason(manifest);
    manifest.status = controller.signal.aborted || options.pauseSignal?.aborted || manifest.pausedStages.length || manifest.executionStopReason || resourcePause ? "interrupted" : "finished";
    manifest.finishedAt = Date.now();
    manifest.resourcePause = resourcePause;
    if (resourcePause) {
      options.onProgress?.("run_paused " + resourcePause);
      await options.logger?.error("Run paused: " + resourcePause, {
        component: "host", event: "run_resource_paused", run_id: options.runId,
      });
    }
    if (manifest.status === "finished") manifest.outcome = inputDiagnostics(manifest.preflight).input_issue_count ||
      manifest.tasks.some(task => inScope(task) && (manifest.states[task.id].status !== "succeeded" || saved.receipts[task.id]?.incompleteDependencies?.length))
      ? "partial" : "complete";
    await current.save(undefined, { manifest: true, usage: true, all: true });
    await current.persistCheckpoint();
    const executionTaskStatuses: Record<string, number> = {};
    for (const task of manifest.tasks.filter(inScope)) {
      const status = manifest.states[task.id].status;
      executionTaskStatuses[status] = (executionTaskStatuses[status] ?? 0) + 1;
    }
    return { ...(options.report ? await options.report(run) : { run_id: manifest.runId, status: manifest.status }),
      execution_task_statuses: executionTaskStatuses, paused_stages: manifest.pausedStages,
      ...inputDiagnostics(manifest.preflight),
      outcome: manifest.outcome,
      ...(resourcePause ? { resource_pause: resourcePause } : {}),
      ...(manifest.executionStopReason ? { execution_stop_reason: manifest.executionStopReason } : {}) };
  } catch (error) {
    runFailure = { error };
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (checkpointTimer) clearInterval(checkpointTimer);
    controller.abort();
    await Promise.allSettled(running.values());
    options.signal?.removeEventListener("abort", abort);
    options.pauseSignal?.removeEventListener("abort", pause);
    const cleanupErrors: unknown[] = [];
    const finish = async (action: () => unknown) => {
      try { await action(); } catch (error) { cleanupErrors.push(error); }
    };
    await finish(() => supervisor?.setDemand(options.runId, 0));
    await finish(() => options.taskLimit?.({ running: 0, ready: 0 }));
    await finish(() => options.modelRequests?.setRunLimit?.(options.runId, undefined));
    await finish(() => !options.workerSupervisor && supervisor?.close());
    if (store && store.manifest.status === "running") {
      store.manifest.status = "interrupted";
      await finish(() => store!.save(undefined, { manifest: true, usage: true, all: true }));
      await finish(() => store!.persistCheckpoint());
    }
    await finish(() => store ? store.close() : hot?.close());
    await finish(() => http?.close());
    await finish(() => workspace?.close());
    if (releaseBusiness) await finish(releaseBusiness);
    await finish(unlock);
    if (cleanupErrors.length) {
      const errors = [...(runFailure ? [runFailure.error] : []), ...cleanupErrors];
      throw new AggregateError(errors, errors.map(errorText).join("; "));
    }
  }
}
