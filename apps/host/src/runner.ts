import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  emptyUsage,
  type AttemptSpec,
  type AttemptRecord,
  type Artifact,
  type AttemptStatus,
  type Engine,
  type EngineIdentity,
  type EvaluationPack,
  type ModelConfig,
  type PlannedTask,
  type Policy,
  type RunState,
  type Submission,
  type TaskPlan,
  type WorkerStatus,
} from "../../../packages/contracts/src/index.js";
import {
  HttpError,
  body,
  canonical,
  compressFile,
  errorText,
  exists,
  internalPath,
  json,
  listen,
  redact,
  request,
  runLock,
  readJson,
  safeId,
  writeJson,
} from "../../../packages/contracts/src/io.js";
import { loadIdentity } from "../../../packages/worker/src/identity.js";
import type { FailureContext } from "../../../packages/contracts/src/index.js";
import { loadRunInputs, writeRunInputs } from "../../../packages/pairwise-eval/src/run-data.js";
import { progressSnapshot } from "./progress.js";
import { RunStore } from "./store.js";
import { consumeEvents, spawnWorker } from "./worker-client.js";

export interface RunOptions {
  runId: string;
  outputDir: string;
  engine: Engine;
  config: unknown;
  pack: EvaluationPack;
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
  const run = path.join(options.outputDir, options.runId),
    unlock = await runLock(run);
  const owned: Awaited<ReturnType<typeof spawnWorker>>[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new Error("Interrupted"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let store: RunStore | undefined, http: Awaited<ReturnType<typeof listen>> | undefined;
  let temporary: string | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let wake: () => void = () => {};
  let changed = new Promise<void>((resolve) => { wake = resolve; });
  let desiredConcurrency = options.concurrency;
  const busy = new Set<{ url: string }>();
  try {
    const identity = options.identity || (await loadIdentity(options.engine));
    const engineForTask = options.engineForTask || (() => options.engine);
    const identities: Partial<Record<Engine, EngineIdentity>> = {
      ...options.identities,
      [options.engine]: identity,
    };
    for (const engine of new Set(options.plan.tasks.map(engineForTask)))
      identities[engine] ??= await loadIdentity(engine);
    let saved: RunState;
    let inputs = options.plan.inputs;
    if (await exists(path.join(run, "state.json"))) {
      saved = await options.pack.readRun(run);
      if (options.pack.reconcile) inputs = (await options.pack.reconcile(run, saved, options.config)).inputs;
      else inputs = await loadRunInputs(run, saved.manifest);
      saved.manifest.engine = identity;
      if (options.debug !== undefined) saved.manifest.debug = options.debug;
    } else {
      if ((await readdir(run)).some((name) => name !== ".run-lock"))
        throw new Error("运行目录缺少 state.json，无法读取已有进度");
      saved = {
        receipts: {},
        usage: emptyUsage(),
        recordedAttempts: 0,
        manifest: {
          format: "dual-agent-eval/5",
          debug: options.debug ?? false,
          runId: options.runId,
          status: "running",
          engine: identity,
          config: options.config,
          tasks: options.plan.tasks,
          inputCatalog: options.plan.catalog,
          inputs: Object.fromEntries(
            Object.keys(inputs).map((id) => [id, { id, name: id }]),
          ),
          states: Object.fromEntries(options.plan.tasks.map((t) => [t.id, { status: "pending", attempts: 0 }])),
          preflight: options.plan.summary,
          startedAt: Date.now(),
        },
      };
    }
    const manifest = saved.manifest;
    manifest.concurrency = desiredConcurrency;
    await writeRunInputs(run, inputs);
    for (const engine of new Set(manifest.tasks.map(engineForTask))) identities[engine] ??= await loadIdentity(engine);
    const working = manifest.debug ? internalPath(run) : (temporary = await mkdtemp(path.join(tmpdir(), "eval-run-")));
    if (manifest.debug) {
      for (const [name, value] of Object.entries(options.pack.snapshots?.() || {}))
        await writeJson(internalPath(run, safeId(name)), value);
    }
    store = new RunStore(run, saved, inputs, options.pack);
    manifest.status = "running";
    delete manifest.finishedAt;
    await rm(path.join(run, "stats.json"), { force: true });
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
    const lock = await readJson<{ pid: number; token: string }>(path.join(run, ".run-lock"));
    http = await listen(async (req, res, url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/v1/control/concurrency" && req.method === "POST") {
        if (req.headers["x-run-token"] !== lock.token) throw new HttpError(403, "Invalid run control token");
        const value = ((await body(req)) as { concurrency?: unknown }).concurrency;
        if (!Number.isInteger(value) || Number(value) < 1) throw new HttpError(400, "concurrency must be positive");
        desiredConcurrency = Number(value); manifest.concurrency = desiredConcurrency;
        await current.save(); wake();
        return json(res, progressSnapshot(saved));
      }
      if (url.pathname === "/v1/progress" && req.method === "GET") return json(res, progressSnapshot(saved));
      if (req.method === "GET" && parts[0] === "v1" && parts[1] === "inputs" && parts[2]) {
        const value = inputs[safeId(parts[2])];
        if (!value) throw new HttpError(404, "Unknown input");
        return json(res, value);
      }
      if (req.method === "POST" && parts[0] === "v1" && parts[1] === "tasks" && parts[3] === "checkpoint") {
        await current.checkpoint(safeId(parts[2]), await body(req) as unknown as FailureContext);
        return json(res, { saved: true });
      }
      if (req.method === "POST" && url.pathname === "/v1/submissions") {
        const value = (await body(req)) as Submission;
        return json(res, await current.accept(value));
      }
      if (req.method === "GET" && parts[0] === "v1" && parts[1] === "submissions" && parts[2])
        return json(res, await current.findSubmission(safeId(parts[2])));
      throw new HttpError(404, "Not found");
    });
    await writeJson(path.join(run, ".run-lock"), { ...lock, url: http.url });
    progressTimer = setInterval(() => options.onProgress?.("progress " + JSON.stringify(progressSnapshot(saved))), 10000);
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
          owned.push(await spawnWorker(engine, path.join(working, "workers", `${engine}-${i}-${randomUUID()}`)));
      workerUrls = owned.map((w) => w.url);
    }
    const workers = await Promise.all(
      workerUrls.map(async (url) => ({ url, health: await request<WorkerStatus>(`${url}/v1/health`) })),
    );
    const eligible = workers.filter(
      (w) =>
        w.health.protocolVersion === PROTOCOL_VERSION &&
        canonical(w.health.identity) === canonical(identities[w.health.identity.engine]) &&
        !w.health.activeAttempt,
    );
    if (pending.length && !eligible.length)
      throw new Error("No idle worker matches the selected build and protocol");
    for (const task of pending) {
      const prepared = options.pack.prepare(task, inputs, {});
      if (
        !eligible.some(
          (w) =>
            w.health.identity.engine === engineForTask(task) &&
            prepared.evaluation.toolNames.every((name) => w.health.tools.includes(name)),
        )
      )
        throw new Error("Required engine or tools not available");
    }
    const hostUrl = http.url;
    async function copyArtifacts(
      workerUrl: string,
      spec: AttemptSpec,
      artifacts: Artifact[],
      destination: string,
    ): Promise<void> {
      for (const artifact of artifacts) {
        safeId(artifact.id);
        const response = await fetch(
          `${workerUrl}/v1/attempts/${spec.attemptId}/artifacts/${artifact.id}`,
          { signal: AbortSignal.timeout(10000) },
        );
        if (!response.ok) throw new Error("Artifact unavailable");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== artifact.bytes) throw new Error("Artifact length mismatch");
        await mkdir(destination, { recursive: true });
        await writeFile(path.join(destination, artifact.id), bytes);
      }
    }
    async function execute(task: PlannedTask, worker: (typeof workers)[number]): Promise<void> {
      let workerUrl = worker.url;
      const identity = identities[engineForTask(task)]!;
      const state = manifest.states[task.id],
        dependencies = await current.dependencies(task);
      const prepared = options.pack.prepare(task, inputs, dependencies);
      const model = options.modelForStage(task.stage);
      let transportRetries = 0, contentRetries = 0;
      for (;;) {
        if (controller.signal.aborted) {
          state.status = "cancelled";
          await current.save();
          return;
        }
        let ready = false;
        try {
          const health = await request<WorkerStatus>(
            `${workerUrl}/v1/health`,
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
          );
          owned.push(replacement);
          workerUrl = replacement.url;
          worker.url = workerUrl;
        }
        const spec: AttemptSpec = {
          protocolVersion: PROTOCOL_VERSION,
          runId: options.runId,
          taskId: task.id,
          attemptId: randomUUID(),
          inputRevision: state.revision || 1,
          engine: identity,
          evaluation: prepared.evaluation,
          model,
          policy: options.policy,
          prompt: prepared.prompt,
          recovery: state.failure,
          inputs: Object.entries(task.inputIds).map(([name, id]) => ({ ...manifest.inputs[id], name })),
          hostUrl,
          deadline: Date.now() + options.policy.timeoutSeconds * 1000,
        };
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
            await request(`${workerUrl}/v1/attempts`, "POST", spec, controller.signal);
          } catch (error) {
            try {
              await request(`${workerUrl}/v1/attempts/${spec.attemptId}`);
            } catch {
              throw error;
            }
          }
          if (manifest.debug) stream = consumeEvents(
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
              await request(`${workerUrl}/v1/attempts/${spec.attemptId}/cancel`, "POST", {}).catch(() => {});
              break;
            }
            status = await request<AttemptStatus>(
              `${workerUrl}/v1/attempts/${spec.attemptId}`,
              "GET",
              undefined,
              AbortSignal.timeout(10000),
            );
            if (status.lastSeq !== lastSeq) { state.lastProgressAt = Date.now(); lastSeq = status.lastSeq; }
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
            `${workerUrl}/v1/attempts/${spec.attemptId}/cancel`,
            "POST",
            {},
            AbortSignal.timeout(5000),
          ).catch(() => {});
          const until = Date.now() + 10000;
          while (Date.now() < until) {
            try {
              const health = await request<WorkerStatus>(
                `${workerUrl}/v1/health`,
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
        if (manifest.debug && await exists(eventsFile)) await compressFile(eventsFile);
        let record: AttemptRecord = { spec, status };
        try {
          const archived = await request<AttemptRecord>(
            `${workerUrl}/v1/attempts/${spec.attemptId}/record`,
            "GET",
            undefined,
            AbortSignal.timeout(1000),
          );
          if (canonical(archived.spec) !== canonical(spec)) throw new Error("Attempt record identity mismatch");
          record = archived;
        } catch {
          /* A crashed worker may not have finalized its usage ledger. Events remain available. */
        }
        let copied = false;
        try {
          const artifacts = [...new Map([
            ...(record.metrics?.audit.artifacts || []), ...(receipt?.audit.artifacts || []),
          ].map((artifact) => [artifact.id, artifact])).values()];
          const retained = manifest.debug ? artifacts : [];
          await copyArtifacts(workerUrl, spec, retained, path.join(working, "tasks", task.id, "artifacts"));
          copied = true;
          state.artifactStatus = { status: manifest.debug ? "available" : "not_retained", source: manifest.debug ? "run" : "worker-temporary" };
        } catch (error) {
          record.artifactError = errorText(error);
          state.artifactStatus = { status: "missing", source: workerUrl, error: record.artifactError };
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
        if ((!manifest.debug || (copied && eventsSaved && record.metrics)) && record.status && record.status.state !== "running")
          await request(`${workerUrl}/v1/attempts/${spec.attemptId}`, "DELETE").catch((error) => {
            options.onProgress?.(`Worker 副本未释放：${errorText(error)}`);
          });
        if (receipt) {
          options.onProgress?.(`succeeded ${task.stage} ${task.id}`);
          return;
        }
        if (controller.signal.aborted || state.failure?.stopped) return;
        if (status?.retryable) { if (transportRetries++ >= options.retries) return; }
        else if (state.failure?.draft && state.failure.errors.some((e) => ["structure", "evidence", "decision"].includes(e.category))) {
          if (contentRetries++ >= 1) return;
        } else return;
        // Cancel the old attempt before authorizing a replacement.
        await request(`${workerUrl}/v1/attempts/${spec.attemptId}/cancel`, "POST", {}).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, status?.retryable ? options.retryDelaySeconds * 1000 * 2 ** Math.max(0, transportRetries - 1) : 0));
      }
    }
    const running = new Map<string, Promise<void>>();
    while (true) {
      if (controller.signal.aborted) break;
      changed = new Promise<void>((resolve) => { wake = resolve; });
      if (!options.workerUrls?.length) {
        const waiting = manifest.tasks.filter((task) => manifest.states[task.id].status === "pending" &&
          Object.values(task.dependencies).every((id) => manifest.states[id]?.status === "succeeded"));
        let slots = Math.max(0, desiredConcurrency - running.size);
        for (const engine of new Set(waiting.map(engineForTask))) {
          const target = Math.min(slots, waiting.filter((task) => engineForTask(task) === engine).length);
          const idle = eligible.filter((worker) => !busy.has(worker) && worker.health.identity.engine === engine).length;
          for (let i = idle; i < target && !controller.signal.aborted; i++) {
            const worker = await spawnWorker(engine, path.join(working, "workers", `${engine}-${randomUUID()}`));
            owned.push(worker);
            const health = await request<WorkerStatus>(`${worker.url}/v1/health`);
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
        const required = options.pack.prepare(task, inputs, {}).evaluation.toolNames;
        const worker = eligible.find(
          (w) =>
            !busy.has(w) &&
            w.health.identity.engine === engineForTask(task) &&
            required.every((name) => w.health.tools.includes(name)),
        );
        if (!worker || running.size >= desiredConcurrency) continue;
        busy.add(worker);
        scheduled = true;
        const promise = execute(task, worker)
          .catch(async (error) => {
            manifest.states[task.id].status = "failed";
            manifest.states[task.id].reason = errorText(error);
            await current.save();
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
    return await options.pack.report(run);
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
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await unlock();
  }
}
