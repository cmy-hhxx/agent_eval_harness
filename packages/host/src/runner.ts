import {
  applyRunJournalDelta,
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
import { progressSnapshot } from "./progress.js";
import { RunStore, type EvaluationServices } from "./store.js";
import { createScopeMembership, scheduleTasks } from "./scheduling.js";
import { FailureGuard } from "./failure-guard.js";
import { cumulativeAttempts, executionStopReason } from "./run-limits.js";
import { consumeEvents, spawnWorker, createRunWorkspace } from "@eval/runtime/client";
import { createModelRequests, type ModelRequestControl } from "./model-requests.js";
export type { ModelRequestControl, ModelRequestContext } from "./model-requests.js";

export interface RunOptions extends EvaluationServices {
  runtime: { root: string; workerEntry: string };
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
  /** Limit active task attempts per model channel within the total concurrency. */
  channelConcurrency?: Record<string, number>;
  modelRequests?: ModelRequestControl;
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
  engineForTask?: (task: PlannedTask) => Engine;
  identities?: Partial<Record<Engine, EngineIdentity>>;
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
  if (options.maxAttempts !== undefined && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 0))
    throw new Error("maxAttempts must be a non-negative integer");
  if (options.policy.maxTaskAttempts !== undefined && (!Number.isSafeInteger(options.policy.maxTaskAttempts) || options.policy.maxTaskAttempts < 1))
    throw new Error("maxTaskAttempts must be a positive integer");
  if (options.stopStartingAt !== undefined && (!Number.isFinite(options.stopStartingAt) || options.stopStartingAt <= 0))
    throw new Error("stopStartingAt must be an absolute timestamp in milliseconds");
  const layout = runLayout(options.output, options.runId),
    run = layout.directory,
    unlock = await runLock(run);
  const owned: Awaited<ReturnType<typeof spawnWorker>>[] = [];
  const exitedWorkers = new WeakSet<(typeof owned)[number]>();
  const workerExitLogs: Promise<void>[] = [];
  async function launchWorker(engine: Engine, directory: string) {
    const worker = await spawnWorker(engine, directory, options.runtime);
    workerExitLogs.push(worker.exited.then(async (exit) => {
      exitedWorkers.add(worker);
      if (exit.expectedClose) return;
      await options.logger?.error(`Worker ${exit.pid} exited unexpectedly`, {
        component: "host", event: "worker_exited", run_id: options.runId,
        detail: JSON.stringify({ engine, worker_pid: exit.pid, worker_url: exit.url, exit_code: exit.exitCode, signal: exit.signal,
          disconnected_at: exit.disconnectedAt, exited_at: exit.exitedAt,
          shutdown_reason: exit.shutdownReason, stderr: exit.stderr }),
      });
      options.onProgress?.(`worker_exited ${JSON.stringify({ pid: exit.pid, url: exit.url,
        exitCode: exit.exitCode, signal: exit.signal, shutdownReason: exit.shutdownReason })}`);
    }).catch(error => { options.onProgress?.(`Worker 退出记录失败：${errorText(error)}`); }));
    return worker;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new Error("Interrupted"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let store: RunStore | undefined, hot: RunHotStore | undefined, http: Awaited<ReturnType<typeof listen>> | undefined;
  let workspace: Awaited<ReturnType<typeof createRunWorkspace>> | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined, checkpointTimer: ReturnType<typeof setInterval> | undefined;
  let wake: () => void = () => {};
  const pause = () => wake();
  options.pauseSignal?.addEventListener("abort", pause, { once: true });
  let changed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  controller.signal.addEventListener("abort", () => wake(), { once: true });
  let desiredConcurrency = options.concurrency;
  const busy = new Set<{ url: string }>();
  try {
    const identity = options.identity || (await loadIdentity(options.engine, options.runtime.root));
    const engineForTask = options.engineForTask || (() => options.engine);
    const identities: Partial<Record<Engine, EngineIdentity>> = {
      ...options.identities,
      [options.engine]: identity,
    };
    for (const engine of new Set(options.plan.tasks.map(engineForTask)))
      identities[engine] ??= await loadIdentity(engine, options.runtime.root);
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
      saved.manifest.engine = identity;
      saved.manifest.evaluatorVersion = options.evaluatorVersion;
      if (options.debug !== undefined) saved.manifest.debug = options.debug;
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
      if (previous && canonical(previous.event) !== canonical(event.event))
        throw new Error("本地热状态与进度事件流在同一序号上不一致");
      replayed.set(event.seq, event);
    }
    for (const event of [...replayed.values()].sort((a, b) => a.seq - b.seq))
      applyRunJournalDelta(saved, event.event);
    if (replayed.size) hot.setSequenceFloor(Math.max(...replayed.keys()));
    const manifest = saved.manifest;
    cumulativeAttempts(manifest);
    if (options.maxAttempts !== undefined || options.stopStartingAt !== undefined)
      manifest.executionLimits = { ...manifest.executionLimits,
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        ...(options.stopStartingAt === undefined ? {} : { stopStartingAt: options.stopStartingAt }) };
    delete manifest.executionStopReason;
    const contentRemaining = (task: PlannedTask) => 1 + (options.policy.stageRepairAttempts?.[task.stage] ?? options.policy.repairAttempts) -
      (manifest.states[task.id].failure?.contentSubmissions ?? 0);
    if (options.taskIds) {
      if (!options.taskIds.length) throw new Error("Task selection must not be empty");
      manifest.executionScope = [...new Set(options.taskIds)];
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
      const boundedTimeout = options.policy.maxTaskAttempts !== undefined && state.status === "timed_out" &&
        /^(Task deadline exceeded|Model\/tool idle timeout)(；|$)/.test(state.reason ?? "");
      return !attemptsExhausted(task) && !boundedTimeout && options.taskSource.observesFailures?.(task) !== false;
    };
    const paused = (task: PlannedTask) => observesFailures(task) && guard.paused(task.stage);
    const dispatchable = (task: PlannedTask) => inScope(task) && !paused(task);
    manifest.concurrency = desiredConcurrency;
    for (const engine of new Set(manifest.tasks.map(engineForTask)))
      identities[engine] ??= await loadIdentity(engine, options.runtime.root);
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
      if (receipt) {
        state.status = "succeeded";
      } else if (attemptsExhausted(task)) {
        state.status = "failed";
        state.reason ??= `Task attempt limit reached: ${state.attempts}/${options.policy.maxTaskAttempts}`;
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
      void store?.persistCheckpoint().catch(error => options.logger?.error(error, {
        component: "host", event: "periodic_checkpoint_failed", run_id: options.runId,
      }));
    }, 5 * 60 * 1000);
    const current = store;
    const preparing = new Set<string>();
    const snapshot = () => ({ ...progressSnapshot(saved, Date.now(), preparing), in_flight_tasks: busy.size,
      checkpoint: { ...current.checkpointMetrics }, outbox: current.outboxStatus() });
    // A task may expose a stage-specific view of its source without persisting a second input.
    const attemptSources = new Map<string, Map<string, unknown>>();
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
          try {
            await modelRequests.acquire(attemptId, callId, AbortSignal.any([controller.signal, disconnected.signal]));
            return json(res, { admitted: true });
          } finally { res.off("close", close); }
        }
        throw new HttpError(405, "Method not allowed");
      }
      if (url.pathname === "/api/control/concurrency" && req.method === "POST") {
        if (req.headers["x-run-token"] !== lock.token) throw new HttpError(403, "Invalid run control token");
        const value = ((await body(req)) as { concurrency?: unknown }).concurrency;
        if (!Number.isInteger(value) || Number(value) < 1)
          throw new HttpError(400, "concurrency must be positive");
        desiredConcurrency = Number(value);
        manifest.concurrency = desiredConcurrency;
        await current.save(undefined, { manifest: true });
        wake();
        return json(res, snapshot());
      }
      if (url.pathname === "/api/control/stop" && req.method === "POST") {
        if (req.headers["x-run-token"] !== lock.token) throw new HttpError(403, "Invalid run control token");
        controller.abort(new Error("Stopped from dashboard"));
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
        return json(res, await current.accept(value));
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
    const running = new Map<string, Promise<void>>();
    const taskConcurrency = () => options.modelRequests?.concurrency() ?? desiredConcurrency;
    const runnable = (task: PlannedTask) => !current.admissionPaused() && (running.size === 0 || running.size < taskConcurrency()) &&
      manifest.states[task.id].status === "pending" && !executionStopReason(manifest) && dispatchable(task) &&
      (manifest.states[task.id].nextRetryAt ?? 0) <= Date.now() &&
      Object.values(task.dependencies).every((id) => manifest.states[id]?.status === "succeeded");
    const pending = manifest.tasks.filter(runnable);
    if (!workerUrls.length && pending.length && taskConcurrency() > 0 && !options.pauseSignal?.aborted) {
      // Start incrementally so every successful child remains owned if a later launch fails.
      const engines = [...new Set(pending.map(engineForTask))];
      for (const engine of engines)
        for (
          let i = 0;
          !options.pauseSignal?.aborted && !controller.signal.aborted && i <
          Math.min(
            Math.max(1, Math.floor(taskConcurrency() / engines.length)),
            pending.filter((t) => engineForTask(t) === engine).length,
          );
          i++
        )
          owned.push(
            await launchWorker(
              engine,
              path.join(working, "workers", `${engine}-${i}-${randomUUID()}`),
            ),
          );
      workerUrls = owned.map((w) => w.url);
    }
    const workers = await Promise.all(
      workerUrls.map(async (url) => ({
        url,
        health: await request<WorkerStatus>(`${url}/api/health`),
        owner: owned.findLast(worker => worker.url === url),
      })),
    );
    const eligible = workers.filter(
      (w) =>
        canonical(w.health.identity) === canonical(identities[w.health.identity.engine]),
    );
    if (pending.length && !eligible.length && taskConcurrency() > 0 && !options.pauseSignal?.aborted) throw new Error("No worker matches the selected build");
    const unavailable = new Map<(typeof workers)[number], { since: number; checkAt: number }>();
    const deferWorker = (worker: (typeof workers)[number]) => unavailable.set(worker, {
      since: unavailable.get(worker)?.since ?? Date.now(), checkAt: Date.now() + 1000,
    });
    async function replaceExitedWorker(worker: (typeof workers)[number]): Promise<boolean> {
      // Bind capacity to its process, not a port that another child may later reuse.
      if (!worker.owner || !exitedWorkers.has(worker.owner)) return false;
      const replacement = await launchWorker(worker.health.identity.engine,
        path.join(working, "workers", `${worker.health.identity.engine}-${randomUUID()}`));
      owned.push(replacement);
      worker.owner = replacement;
      worker.url = replacement.url;
      worker.health = await request<WorkerStatus>(`${worker.url}/api/health`);
      return true;
    }
    for (const worker of eligible) if (worker.health.activeAttempt) deferWorker(worker);
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
    const retryBudgets = new Map<string, { transport: number; content: number }>();
    async function execute(
      task: PlannedTask,
      worker: (typeof workers)[number],
      prepared: ReturnType<typeof options.agents.prepare>,
      binding: AgentBinding,
      timing: Record<string, number>,
    ): Promise<void> {
      const sources = binding.request.sources;
      let workerUrl = worker.url;
      const identity = identities[engineForTask(task)]!;
      const state = manifest.states[task.id];
      const taskModel = () => options.modelForTask?.(task, state.channel) ?? options.modelForStage(task.stage);
      const model = taskModel();
      const retries = retryBudgets.get(task.id) ?? {
        transport: 0, content: 0,
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
        ready = (!worker.owner || !exitedWorkers.has(worker.owner)) &&
          !health.activeAttempt && canonical(health.identity) === canonical(identity);
      } catch {}
      if (!ready) {
        if (!await replaceExitedWorker(worker)) {
          // Capacity loss is not an evaluation failure. Requeue before creating
          // an attempt; a failed observation must not terminate a live process.
          deferWorker(worker);
          state.status = "pending";
          await current.save(task.id);
          return;
        }
        workerUrl = worker.url;
      }
      if (paused(task)) return;
      // Automatic retries and explicit resume share the task's cumulative content cap.
      state.channel = model.provider;
      const policy = { ...options.policy, repairAttempts: contentRemaining(task) - 1 };
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
        bound.set(ref.id, source.value);
      }
      attemptSources.set(spec.attemptId, bound);
      modelRequests.register(spec, task);
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
            await request(`${workerUrl}/api/attempts/${spec.attemptId}/cancel`, "POST", {}).catch(() => {});
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
          if (status.state !== "running") {
            observedTerminal = status;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } catch (error) {
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
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          try {
            const health = await request<WorkerStatus>(
              `${workerUrl}/api/health`,
              "GET",
              undefined,
              AbortSignal.timeout(1000),
            );
            if (!health.activeAttempt) break;
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
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
      const rerouted = !receipt && !controller.signal.aborted && !paused(task) && !state.failure?.stopped &&
        contentLedgerConfirmed && contentRemaining(task) > 0 &&
        (record.status ?? status)?.modelQuotaExhausted === true && options.onModelQuotaExhausted?.(model, task) === true &&
        taskModel().provider !== model.provider;
      const retryingTransport = !receipt && status?.retryable && contentLedgerConfirmed &&
        !state.failure?.stopped && !attemptsExhausted(task) && contentRemaining(task) > 0 &&
        retries.transport < options.retries;
      // Count a transport outage only after this task's bounded retries. At high
      // concurrency, one brief outage must not preempt every task's first retry.
      const pause = controller.signal.aborted || rerouted || retryingTransport || !observesFailures(task)
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
        await request(`${workerUrl}/api/attempts/${spec.attemptId}`, "DELETE").catch(async (error) => {
          await options.logger?.error(error, {
            component: "host",
            event: "worker_cleanup_failed",
            run_id: options.runId,
            task_id: task.id,
            attempt_id: spec.attemptId,
          });
          options.onProgress?.(`Worker 副本未释放：${errorText(error)}`);
        });
      if (receipt) {
        options.onProgress?.(`succeeded ${task.stage} ${task.id}`);
        return;
      }
      if (controller.signal.aborted || paused(task) || attemptsExhausted(task) || state.failure?.stopped ||
        !contentLedgerConfirmed || contentRemaining(task) <= 0) return;
      if (rerouted) {
        // A new channel has its own transport budget; content accounting remains unchanged.
        retries.transport = 0;
      } else if (status?.retryable) {
        if (retries.transport++ >= options.retries) return;
      } else if (
        state.failure?.draft &&
        state.failure.errors.some((e) => ["structure", "evidence", "decision"].includes(e.category))
      ) {
        if (retries.content++ >= 1) return;
      } else return;
      const retryDelay = !rerouted && status?.retryable ? options.retryDelaySeconds * 1000 * 2 ** Math.max(0, retries.transport - 1) : 0;
      state.status = "pending";
      state.nextRetryAt = Date.now() + retryDelay;
      await current.save(task.id);
      // Return the worker and concurrency slot while this task backs off.
      } finally {
        modelRequests.remove(spec.attemptId);
        attemptSources.delete(spec.attemptId);
      }
    }
    const runningChannels = new Map<string, string>();
    while (true) {
      if (controller.signal.aborted) break;
      if (options.pauseSignal?.aborted) {
        await Promise.all(running.values());
        break;
      }
      if (executionStopReason(manifest) && running.size === 0) break;
      changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      await Promise.all([...unavailable].filter(([, value]) => value.checkAt <= Date.now()).map(async ([worker]) => {
        try {
          await replaceExitedWorker(worker);
          const health = await request<WorkerStatus>(worker.url + "/api/health", "GET", undefined, AbortSignal.timeout(1000));
          if ((!worker.owner || !exitedWorkers.has(worker.owner)) && !health.activeAttempt &&
              canonical(health.identity) === canonical(identities[health.identity.engine])) {
            worker.health = health;
            unavailable.delete(worker);
            return;
          }
        } catch { /* Retry capacity observation without spending a task attempt. */ }
        deferWorker(worker);
      }));
      if (!options.workerUrls?.length && running.size < taskConcurrency() && !options.pauseSignal?.aborted) {
        const waiting = manifest.tasks.filter(runnable);
        let slots = Math.max(0, taskConcurrency() - running.size);
        for (const engine of new Set(waiting.map(engineForTask))) {
          if (options.pauseSignal?.aborted) break;
          const target = Math.min(slots, waiting.filter((task) => engineForTask(task) === engine).length);
          const idle = eligible.filter(
            (worker) => !busy.has(worker) && worker.health.identity.engine === engine,
          ).length;
          for (let i = idle; i < target && !controller.signal.aborted && !options.pauseSignal?.aborted; i++) {
            const worker = await launchWorker(
              engine,
              path.join(working, "workers", `${engine}-${randomUUID()}`),
            );
            owned.push(worker);
            const health = await request<WorkerStatus>(`${worker.url}/api/health`);
            eligible.push({ url: worker.url, health, owner: worker });
          }
          slots -= target;
        }
      }
      let scheduled = false, blocked = false;
      for (const task of scheduleTasks(manifest.tasks.filter(dispatchable), manifest.states)) {
        if (controller.signal.aborted || options.pauseSignal?.aborted || executionStopReason(manifest)) break;
        if (!dispatchable(task)) continue;
        if (manifest.states[task.id].status !== "pending" || running.has(task.id) ||
            (manifest.states[task.id].nextRetryAt ?? 0) > Date.now()) continue;
        const dependencies = Object.values(task.dependencies);
        if (dependencies.some((id) => !running.has(id) && manifest.states[id]?.status &&
          !["pending", "running", "succeeded"].includes(manifest.states[id].status))) {
          manifest.states[task.id].status = "blocked";
          manifest.states[task.id].reason = "Dependency did not succeed";
          blocked = true;
          continue;
        }
        if (dependencies.some((id) => manifest.states[id]?.status !== "succeeded")) continue;
        if (options.taskSource.canStart?.(task, manifest) === false) continue;
        if (running.size >= taskConcurrency() || eligible.every((worker) => busy.has(worker) || unavailable.has(worker))) break;
        const acceptedDependencies = await current.dependencies(task);
        const reason = options.taskSource.blockedReason?.(task, acceptedDependencies);
        if (reason) {
          manifest.states[task.id].status = "blocked";
          manifest.states[task.id].reason = reason;
          blocked = true;
          continue;
        }
        preparing.add(task.id);
        options.onProgress?.(`preparing ${task.stage} ${task.id}`);
        await yieldToIO();
        const preparationStarted = performance.now(), cpuStarted = process.cpuUsage();
        const binding = options.taskSource.bind(task, inputs, acceptedDependencies, { tasks: manifest.tasks });
        const bindingMs = performance.now() - preparationStarted;
        if (paused(task)) { preparing.delete(task.id); continue; }
        const prepared = options.agents.prepare(binding);
        const cpu = process.cpuUsage(cpuStarted);
        const timing = { queuedMs: Math.max(0, Date.now() - (manifest.states[task.id].nextRetryAt ?? manifest.startedAt)),
          bindingMs, profileMs: performance.now() - preparationStarted - bindingMs,
          preparationCpuMs: (cpu.user + cpu.system) / 1000, ...binding.preparationTimings };
        const capable = eligible.filter(
          (w) =>
            w.health.identity.engine === engineForTask(task) &&
            prepared.evaluation.toolNames.every((name) => w.health.tools.includes(name)),
        );
        if (!capable.length) throw new Error("Required engine or tools not available");
        const worker = capable.find((w) => !busy.has(w) && !unavailable.has(w));
        if (!worker) { preparing.delete(task.id); continue; }
        if (options.channelConcurrency) {
          const channel = (options.modelForTask?.(task, manifest.states[task.id].channel) ?? options.modelForStage(task.stage)).provider;
          const limit = options.channelConcurrency[channel];
          if (limit !== undefined && [...runningChannels.values()].filter(value => value === channel).length >= limit) { preparing.delete(task.id); continue; }
          runningChannels.set(task.id, channel);
        }
        delete manifest.states[task.id].nextRetryAt;
        busy.add(worker);
        scheduled = true;
        const promise = execute(task, worker, prepared, binding, timing)
          .catch(async (error) => {
            if (await current.receipt(task.id)) return;
            manifest.states[task.id].status = controller.signal.aborted ? "cancelled" : "failed";
            manifest.states[task.id].reason = errorText(error);
            const pause = controller.signal.aborted || !observesFailures(task) ? undefined : guard.observe(task.stage, task.id, [{ category: "interruption", code: "host_execution_failed", path: "/" }]);
            if (pause) options.onProgress?.("stage_paused " + JSON.stringify(pause));
            await current.save(task.id, { manifest: true });
            if (!controller.signal.aborted)
              await options.logger?.error(error, {
                component: "host",
                event: "task_failed",
                run_id: options.runId,
                task_id: task.id,
                attempt_id: manifest.states[task.id].attemptId,
                stage: task.stage,
              });
          })
          .finally(() => {
            preparing.delete(task.id);
            running.delete(task.id);
            runningChannels.delete(task.id);
            busy.delete(worker);
          });
        running.set(task.id, promise);
        // Binding can be CPU-heavy. Let dispatched Workers, permits and checkpoints
        // make progress before preparing the next task in a large cohort.
        await yieldToIO();
      }
      if (blocked) await current.save(undefined, { manifest: true, all: true });
      const retryDeadlines = manifest.tasks.filter(task => !executionStopReason(manifest) && dispatchable(task) &&
        manifest.states[task.id].status === "pending" && (manifest.states[task.id].nextRetryAt ?? 0) > Date.now())
        .map(task => manifest.states[task.id].nextRetryAt!);
      if (running.size || retryDeadlines.length) {
        const dispatchWait = !executionStopReason(manifest) && manifest.executionLimits?.stopStartingAt !== undefined
          ? Math.max(0, manifest.executionLimits.stopStartingAt - Date.now()) : Infinity;
        const waitMs = Math.min(options.modelRequests ? 100 : Infinity, dispatchWait, unavailable.size ? 1000 : Infinity, ...retryDeadlines.map(at => Math.max(0, at - Date.now())));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([...running.values(), changed,
          ...(Number.isFinite(waitMs) ? [new Promise(resolve => { timer = setTimeout(resolve, waitMs); })] : [])]); }
        finally { clearTimeout(timer); }
      }
      else if (taskConcurrency() === 0 && manifest.tasks.some(runnable)) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      else if (unavailable.size && manifest.tasks.some(runnable)) {
        if ([...unavailable.values()].every(({ since }) => Date.now() - since >= options.policy.timeoutSeconds * 1000))
          throw new Error("External workers remained unavailable; pending tasks were preserved for resume");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      else if (!scheduled) break;
    }
    await Promise.all(running.values());
    for (const state of Object.values(manifest.states)) delete state.nextRetryAt;
    if (controller.signal.aborted)
      for (const task of manifest.tasks)
        if (inScope(task) && manifest.states[task.id].status === "pending") manifest.states[task.id].status = "cancelled";
    if (manifest.tasks.some(task => inScope(task) && manifest.states[task.id].status === "pending"))
      manifest.executionStopReason = executionStopReason(manifest);
    manifest.status = controller.signal.aborted || options.pauseSignal?.aborted || manifest.pausedStages.length || manifest.executionStopReason ? "interrupted" : "finished";
    manifest.finishedAt = Date.now();
    await current.save(undefined, { manifest: true, usage: true, all: true });
    await current.persistCheckpoint();
    const executionTaskStatuses: Record<string, number> = {};
    for (const task of manifest.tasks.filter(inScope)) {
      const status = manifest.states[task.id].status;
      executionTaskStatuses[status] = (executionTaskStatuses[status] ?? 0) + 1;
    }
    return { ...(options.report ? await options.report(run) : { run_id: manifest.runId, status: manifest.status }),
      execution_task_statuses: executionTaskStatuses, paused_stages: manifest.pausedStages,
      ...(manifest.executionStopReason ? { execution_stop_reason: manifest.executionStopReason } : {}) };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (checkpointTimer) clearInterval(checkpointTimer);
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    options.pauseSignal?.removeEventListener("abort", pause);
    try {
      await Promise.all(owned.map((worker) => worker.close()));
      await Promise.all(workerExitLogs);
      try {
        if (store && store.manifest.status === "running") {
          store.manifest.status = "interrupted";
          await store.save(undefined, { manifest: true, usage: true, all: true });
          await store.persistCheckpoint();
        }
      } finally {
        if (store) await store.close();
        else hot?.close();
      }
    } finally {
      // A failed checkpoint must not keep this date locked for the lifetime of the automation.
      try { await http?.close(); }
      finally {
        try { await workspace?.close(); }
        finally { await unlock(); }
      }
    }
  }
}
