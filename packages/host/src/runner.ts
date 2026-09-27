import { localFiles, atomicWrite } from "@eval/data";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
} from "@eval/contracts";
import { HttpError, canonical, errorText, redact, safeId } from "@eval/contracts";
import { body, json, listen, request } from "@eval/runtime/http";
import { compressFile, exists, internalPath, runLayout, runLock, readJson, writeJson } from "@eval/data";
import { loadIdentity } from "@eval/runtime/client";
import type { FailureContext } from "@eval/contracts";
import { progressSnapshot } from "./progress.js";
import { RunStore, type EvaluationServices } from "./store.js";
import { consumeEvents, spawnWorker, createRunWorkspace } from "@eval/runtime/client";

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
  concurrency: number;
  retries: number;
  retryDelaySeconds: number;
  debug?: boolean;
  signal?: AbortSignal;
  workerUrls?: string[];
  identity?: EngineIdentity;
  engineForTask?: (task: PlannedTask) => Engine;
  identities?: Partial<Record<Engine, EngineIdentity>>;
  onProgress?: (message: string) => void;
}
export async function runEvaluation(options: RunOptions) {
  safeId(options.runId);
  if (typeof options.evaluatorVersion !== "string" || !options.evaluatorVersion.trim())
    throw new Error("evaluatorVersion must be a non-empty string");
  const layout = runLayout(options.output, options.runId),
    run = layout.directory,
    unlock = await runLock(run);
  const owned: Awaited<ReturnType<typeof spawnWorker>>[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new Error("Interrupted"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let store: RunStore | undefined, http: Awaited<ReturnType<typeof listen>> | undefined;
  let workspace: Awaited<ReturnType<typeof createRunWorkspace>> | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let wake: () => void = () => {};
  let changed = new Promise<void>((resolve) => {
    wake = resolve;
  });
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
      saved = await options.repository.readRun(run);
      if (options.workflow.reconcile)
        inputs = (await options.workflow.reconcile(run, saved, options.config)).inputs;
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
    const manifest = saved.manifest;
    manifest.concurrency = desiredConcurrency;
    for (const engine of new Set(manifest.tasks.map(engineForTask)))
      identities[engine] ??= await loadIdentity(engine, options.runtime.root);
    workspace = await createRunWorkspace(run, manifest.debug);
    const working = workspace.directory;
    if (manifest.debug) {
      for (const [name, value] of Object.entries(options.snapshots || {}))
        await writeJson(internalPath(run, safeId(name)), value);
    }
    store = new RunStore(run, saved, inputs, options);
    manifest.status = "running";
    delete manifest.finishedAt;
    await localFiles.remove(layout.stats, { force: true });
    for (const task of manifest.tasks) {
      const receipt = await store.receipt(task.id),
        state = manifest.states[task.id];
      if (receipt) {
        state.status = "succeeded";
      } else {
        state.status = "pending";
        delete state.attemptId;
        delete state.reason;
      }
    }
    await store.save();
    const current = store;
    // A task may expose a stage-specific view of its source without persisting a second input.
    const attemptSources = new Map<string, Map<string, unknown>>();
    const lock = await readJson<{ pid: number; token: string }>(layout.lockFile);
    http = await listen(async (req, res, url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/api/control/concurrency" && req.method === "POST") {
        if (req.headers["x-run-token"] !== lock.token) throw new HttpError(403, "Invalid run control token");
        const value = ((await body(req)) as { concurrency?: unknown }).concurrency;
        if (!Number.isInteger(value) || Number(value) < 1)
          throw new HttpError(400, "concurrency must be positive");
        desiredConcurrency = Number(value);
        manifest.concurrency = desiredConcurrency;
        await current.save();
        wake();
        return json(res, progressSnapshot(saved));
      }
      if (url.pathname === "/api/control/stop" && req.method === "POST") {
        if (req.headers["x-run-token"] !== lock.token) throw new HttpError(403, "Invalid run control token");
        controller.abort(new Error("Stopped from dashboard"));
        wake();
        return json(res, { stopping: true });
      }
      if (url.pathname === "/api/progress" && req.method === "GET") return json(res, progressSnapshot(saved));
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
      () => options.onProgress?.("progress " + JSON.stringify(progressSnapshot(saved))),
      10000,
    );
    let workerUrls = options.workerUrls || [];
    const pending = manifest.tasks.filter((t) => manifest.states[t.id].status === "pending");
    if (!workerUrls.length && pending.length) {
      // Start incrementally so every successful child remains owned if a later launch fails.
      const engines = [...new Set(pending.map(engineForTask))];
      for (const engine of engines)
        for (
          let i = 0;
          i <
          Math.min(
            Math.max(1, Math.floor(options.concurrency / engines.length)),
            pending.filter((t) => engineForTask(t) === engine).length,
          );
          i++
        )
          owned.push(
            await spawnWorker(
              engine,
              path.join(working, "workers", `${engine}-${i}-${randomUUID()}`),
              options.runtime,
            ),
          );
      workerUrls = owned.map((w) => w.url);
    }
    const workers = await Promise.all(
      workerUrls.map(async (url) => ({
        url,
        health: await request<WorkerStatus>(`${url}/api/health`),
      })),
    );
    const eligible = workers.filter(
      (w) =>
        canonical(w.health.identity) === canonical(identities[w.health.identity.engine]) &&
        !w.health.activeAttempt,
    );
    if (pending.length && !eligible.length) throw new Error("No idle worker matches the selected build");
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
    async function execute(
      task: PlannedTask,
      worker: (typeof workers)[number],
      prepared: ReturnType<typeof options.agents.prepare>,
      sources: AgentBinding["request"]["sources"],
    ): Promise<void> {
      let workerUrl = worker.url;
      const identity = identities[engineForTask(task)]!;
      const state = manifest.states[task.id];
      const model = options.modelForStage(task.stage);
      let transportRetries = 0,
        contentRetries = 0;
      for (;;) {
        if (controller.signal.aborted) {
          state.status = "cancelled";
          await current.save();
          return;
        }
        let ready = false;
        try {
          const health = await request<WorkerStatus>(
            `${workerUrl}/api/health`,
            "GET",
            undefined,
            AbortSignal.timeout(1000),
          );
          ready = !health.activeAttempt && canonical(health.identity) === canonical(identity);
        } catch {}
        if (!ready) {
          const previous = owned.find((w) => w.url === workerUrl);
          if (!previous)
            throw new Error("External worker unavailable or still busy; restart it and resume the run");
          await previous.close();
          const replacement = await spawnWorker(
            identity.engine,
            path.join(working, "workers", `${identity.engine}-${randomUUID()}`),
            options.runtime,
          );
          owned.push(replacement);
          workerUrl = replacement.url;
          worker.url = workerUrl;
        }
        const spec: AttemptSpec = {
          runId: options.runId,
          taskId: task.id,
          attemptId: randomUUID(),
          inputRevision: state.revision || 1,
          engine: identity,
          evaluation: prepared.evaluation,
          model,
          policy: options.policy,
          prompt: prepared.renderAttempt(options.policy, state.failure),
          recovery: state.failure,
          inputs: Object.entries(task.inputIds).map(([name, id]) => ({
            ...manifest.inputs[id],
            name,
          })),
          hostUrl,
          deadline: Date.now() + options.policy.timeoutSeconds * 1000,
        };
        const bound = new Map<string, unknown>();
        for (const ref of spec.inputs) {
          const source = sources[ref.name];
          if (!source || source.id !== ref.id) throw new Error(`Task source mismatch: ${ref.name}`);
          bound.set(ref.id, source.value);
        }
        attemptSources.set(spec.attemptId, bound);
        try {
        state.startedAt = state.lastProgressAt = Date.now();
        let lastSeq = -1;
        await current.activate(spec);
        const attemptDir = internalPath(
          run,
          "tasks",
          task.id,
          `attempt-${state.attempts.toString().padStart(3, "0")}`,
        );
        const eventController = new AbortController();
        let stream: Promise<boolean> | undefined, status: AttemptStatus | undefined;
        let eventsSaved = false;
        try {
          options.onProgress?.(`running ${task.stage} ${task.id} attempt ${state.attempts}`);
          try {
            await request(`${workerUrl}/api/attempts`, "POST", spec, controller.signal);
          } catch (error) {
            try {
              await request(`${workerUrl}/api/attempts/${spec.attemptId}`);
            } catch {
              throw error;
            }
          }
          if (manifest.debug)
            stream = consumeEvents(
              workerUrl,
              spec.attemptId,
              path.join(attemptDir, "events.jsonl"),
              eventController.signal,
            );
          while (true) {
            if (controller.signal.aborted || Date.now() > spec.deadline) {
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
            status = await request<AttemptStatus>(
              `${workerUrl}/api/attempts/${spec.attemptId}`,
              "GET",
              undefined,
              AbortSignal.timeout(10000),
            );
            if (status.lastSeq !== lastSeq) {
              state.lastProgressAt = Date.now();
              lastSeq = status.lastSeq;
            }
            if (status.state !== "running") break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          status = {
            state: "failed",
            lastSeq: 0,
            error: redact(errorText(error), [process.env[model.apiKeyEnv] || ""]),
            retryable: true,
          };
        }
        const receipt = await current.receipt(task.id);
        // A failed connection does not imply the old session has stopped. Settle it before reuse.
        if (!status || status.state === "running" || status.retryable) {
          if (!receipt)
            await current.endAttempt(
              spec,
              controller.signal.aborted ? "cancelled" : state.status === "timed_out" ? "timed_out" : "failed",
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
        // Wait for cancellation and cleanup before closing the terminal event stream.
        if (stream) await Promise.race([stream, new Promise((resolve) => setTimeout(resolve, 500))]);
        eventController.abort();
        eventsSaved = (await stream) ?? false;
        const eventsFile = path.join(attemptDir, "events.jsonl");
        if (manifest.debug && (await exists(eventsFile))) await compressFile(eventsFile);
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
        } catch {
          /* A crashed worker may not have finalized its usage ledger. Events remain available. */
        }
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
        if (receipt) {
          state.status = "succeeded";
          await current.save();
        } else if (state.status === "running")
          await current.endAttempt(
            spec,
            status?.state === "timed_out"
              ? "timed_out"
              : status?.state === "cancelled"
                ? "cancelled"
                : "failed",
            status?.error || "No committed receipt",
          );
        if (!receipt) {
          record.error = state.reason;
          if (record.failure || status?.failure) state.failure = record.failure || status?.failure;
        }
        if (manifest.debug) await writeJson(path.join(attemptDir, "attempt.json"), record);
        state.durationMs = (state.durationMs || 0) + Date.now() - state.startedAt!;
        if (record.metrics) {
          for (const key of Object.keys(saved.usage) as (keyof typeof saved.usage)[])
            saved.usage[key] += record.metrics.usage[key] || 0;
          saved.recordedAttempts++;
        }
        await current.save();
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
        if (controller.signal.aborted || state.failure?.stopped) return;
        if (status?.retryable) {
          if (transportRetries++ >= options.retries) return;
        } else if (
          state.failure?.draft &&
          state.failure.errors.some((e) => ["structure", "evidence", "decision"].includes(e.category))
        ) {
          if (contentRetries++ >= 1) return;
        } else return;
        // Cancel the old attempt before authorizing a replacement.
        await request(`${workerUrl}/api/attempts/${spec.attemptId}/cancel`, "POST", {}).catch(() => {});
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            status?.retryable ? options.retryDelaySeconds * 1000 * 2 ** Math.max(0, transportRetries - 1) : 0,
          ),
        );
        } finally {
          attemptSources.delete(spec.attemptId);
        }
      }
    }
    const running = new Map<string, Promise<void>>();
    while (true) {
      if (controller.signal.aborted) break;
      changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      if (!options.workerUrls?.length) {
        const waiting = manifest.tasks.filter(
          (task) =>
            manifest.states[task.id].status === "pending" &&
            Object.values(task.dependencies).every((id) => manifest.states[id]?.status === "succeeded"),
        );
        let slots = Math.max(0, desiredConcurrency - running.size);
        for (const engine of new Set(waiting.map(engineForTask))) {
          const target = Math.min(slots, waiting.filter((task) => engineForTask(task) === engine).length);
          const idle = eligible.filter(
            (worker) => !busy.has(worker) && worker.health.identity.engine === engine,
          ).length;
          for (let i = idle; i < target && !controller.signal.aborted; i++) {
            const worker = await spawnWorker(
              engine,
              path.join(working, "workers", `${engine}-${randomUUID()}`),
              options.runtime,
            );
            owned.push(worker);
            const health = await request<WorkerStatus>(`${worker.url}/api/health`);
            eligible.push({ url: worker.url, health });
          }
          slots -= target;
        }
      }
      let scheduled = false;
      for (const task of manifest.tasks) {
        if (manifest.states[task.id].status !== "pending" || running.has(task.id)) continue;
        const dependencies = Object.values(task.dependencies).map((id) => manifest.states[id]?.status);
        if (dependencies.some((s) => s && !["pending", "running", "succeeded"].includes(s))) {
          manifest.states[task.id].status = "blocked";
          manifest.states[task.id].reason = "Dependency did not succeed";
          await current.save();
          continue;
        }
        if (dependencies.some((s) => s !== "succeeded")) continue;
        const binding = options.workflow.bind(task, inputs, await current.dependencies(task));
        const prepared = options.agents.prepare(binding);
        const capable = eligible.filter(
          (w) =>
            w.health.identity.engine === engineForTask(task) &&
            prepared.evaluation.toolNames.every((name) => w.health.tools.includes(name)),
        );
        if (!capable.length) throw new Error("Required engine or tools not available");
        const worker = capable.find((w) => !busy.has(w));
        if (!worker || running.size >= desiredConcurrency) continue;
        busy.add(worker);
        scheduled = true;
        const promise = execute(task, worker, prepared, binding.request.sources)
          .catch(async (error) => {
            manifest.states[task.id].status = "failed";
            manifest.states[task.id].reason = errorText(error);
            await current.save();
          })
          .then(async () => {
            const state = manifest.states[task.id];
            if (["failed", "timed_out"].includes(state.status))
              await options.logger?.error(state.reason || "Task failed without a committed result", {
                component: "host",
                event: "task_failed",
                run_id: options.runId,
                task_id: task.id,
                attempt_id: state.attemptId,
              });
          })
          .finally(() => {
            running.delete(task.id);
            busy.delete(worker);
          });
        running.set(task.id, promise);
      }
      if (running.size) await Promise.race([...running.values(), changed]);
      else if (!scheduled) break;
    }
    await Promise.all(running.values());
    if (controller.signal.aborted)
      for (const state of Object.values(manifest.states))
        if (state.status === "pending") state.status = "cancelled";
    manifest.status = controller.signal.aborted ? "interrupted" : "finished";
    manifest.finishedAt = Date.now();
    await current.save();
    return options.report ? await options.report(run) : { run_id: manifest.runId, status: manifest.status };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    await Promise.all(owned.map((worker) => worker.close()));
    if (store && store.manifest.status === "running") {
      store.manifest.status = "interrupted";
      await store.save();
    }
    await http?.close();
    await workspace?.close();
    await unlock();
  }
}
