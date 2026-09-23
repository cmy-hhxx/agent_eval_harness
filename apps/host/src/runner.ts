import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type AttemptSpec,
  type AttemptStatus,
  type Engine,
  type EngineIdentity,
  type EvaluationPack,
  type ModelConfig,
  type PlannedTask,
  type Policy,
  type RunManifest,
  type Submission,
  type SubmissionReceipt,
  type TaskPlan,
  type WorkerStatus,
} from "../../../packages/contracts/src/index.js";
import {
  ROOT,
  HttpError,
  body,
  canonical,
  digest,
  errorText,
  exists,
  json,
  listen,
  readJson,
  redact,
  request,
  runLock,
  safeId,
  sha256,
  writeJson,
} from "../../../packages/contracts/src/io.js";
import { loadIdentity, treeHash } from "../../../packages/worker/src/identity.js";
import { RunStore } from "./store.js";
import { consumeEvents, spawnWorker } from "./worker-client.js";

export interface RunOptions {
  runId: string;
  outputDir: string;
  cacheDir: string;
  engine: Engine;
  config: unknown;
  pack: EvaluationPack;
  plan: TaskPlan;
  policy: Policy;
  modelForStage: (stage: string) => ModelConfig;
  concurrency: number;
  retries: number;
  retryDelaySeconds: number;
  resume?: boolean;
  retryFailed?: boolean;
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
    const program = digest([
      await treeHash(path.join(ROOT, "apps")),
      await treeHash(path.join(ROOT, "packages")),
      await readFile(path.join(ROOT, "package-lock.json"), "utf8"),
      await readFile(path.join(ROOT, "uv.lock"), "utf8"),
      await readFile(path.join(ROOT, "mise.toml"), "utf8"),
      await readFile(path.join(ROOT, "tsconfig.json"), "utf8"),
    ]);
    const fingerprint = digest({
      program,
      identities,
      routing: Object.fromEntries(options.plan.tasks.map((t) => [t.id, engineForTask(t)])),
      pack: [options.pack.id, options.pack.version],
      plan: options.plan,
      policy: options.policy,
      models: Object.fromEntries(
        [...new Set(options.plan.tasks.map((t) => t.stage))].map((stage) => [
          stage,
          options.modelForStage(stage),
        ]),
      ),
    });
    const manifestFile = path.join(run, "manifest.json");
    let manifest: RunManifest;
    if (await exists(manifestFile)) {
      if (!options.resume) throw new Error("Run exists; use --resume or a new --run-id");
      manifest = await readJson<RunManifest>(manifestFile);
      if (manifest.format !== "dual-agent-eval/1" || manifest.fingerprint !== fingerprint)
        throw new Error("输入、底座、代码、模型或评测契约已变化，请使用新 run ID");
      for (const [id, ref] of Object.entries(manifest.inputs))
        if (digest(await readJson(path.join(run, "inputs", `${safeId(id)}.json`))) !== ref.digest)
          throw new Error(`Input snapshot changed: ${id}`);
    } else {
      manifest = {
        format: "dual-agent-eval/1",
        runId: options.runId,
        status: "running",
        fingerprint,
        engine: identity,
        config: options.config,
        tasks: options.plan.tasks,
        inputs: Object.fromEntries(
          Object.entries(options.plan.inputs).map(([id, value]) => [
            id,
            { id, digest: digest(value), name: id },
          ]),
        ),
        states: Object.fromEntries(options.plan.tasks.map((t) => [t.id, { status: "pending", attempts: 0 }])),
        preflight: options.plan.summary,
        startedAt: Date.now(),
      };
      for (const [id, value] of Object.entries(options.plan.inputs))
        await writeJson(path.join(run, "inputs", `${id}.json`), value);
      await writeJson(path.join(run, "preflight.json"), options.plan.summary);
      for (const [name, value] of Object.entries(options.pack.snapshots?.() || {}))
        await writeJson(path.join(run, safeId(name)), value);
    }
    store = new RunStore(run, manifest, options.plan.inputs, options.pack);
    manifest.status = "running";
    delete manifest.finishedAt;
    for (const task of manifest.tasks) {
      const receipt = await store.receipt(task.id),
        state = manifest.states[task.id];
      if (receipt) {
        options.pack.validate(task, options.plan.inputs, receipt.evaluation, receipt.audit);
        state.status = "succeeded";
      } else if (state.status === "succeeded") throw new Error(`Committed receipt missing: ${task.id}`);
      else if (state.status === "running" || state.status === "cancelled" || options.retryFailed) {
        state.status = "pending";
        delete state.attemptId;
      }
    }
    await store.save();
    const current = store;
    http = await listen(async (req, res, url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && parts[0] === "v1" && parts[1] === "inputs" && parts[2]) {
        const value = options.plan.inputs[safeId(parts[2])];
        if (!value) throw new HttpError(404, "Unknown input");
        return json(res, value);
      }
      if (req.method === "POST" && url.pathname === "/v1/submissions") {
        const value = (await body(req)) as Submission;
        return json(res, await current.accept(value));
      }
      if (req.method === "GET" && parts[0] === "v1" && parts[1] === "submissions" && parts[2])
        return json(res, await current.findSubmission(safeId(parts[2])));
      throw new HttpError(404, "Not found");
    });
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
          owned.push(await spawnWorker(engine, path.join(run, "workers", `${engine}-${i}-${randomUUID()}`)));
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
      throw new Error("No idle worker matches the selected engine fingerprint and protocol");
    for (const task of pending) {
      const prepared = options.pack.prepare(task, options.plan.inputs, {});
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
      receipt: SubmissionReceipt,
      destination: string,
    ): Promise<boolean> {
      try {
        for (const artifact of receipt.audit.artifacts) {
          safeId(artifact.id);
          const response = await fetch(
            `${workerUrl}/v1/attempts/${spec.attemptId}/artifacts/${artifact.id}`,
            { signal: AbortSignal.timeout(10000) },
          );
          if (!response.ok) throw new Error("Artifact unavailable");
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (sha256(bytes) !== artifact.digest) throw new Error("Artifact digest mismatch");
          await mkdir(destination, { recursive: true });
          await writeFile(path.join(destination, artifact.id), bytes);
        }
        return true;
      } catch (error) {
        await writeJson(path.join(run, "tasks", spec.taskId, "artifact-error.json"), {
          reason: errorText(error),
        });
        return false;
      }
    }
    async function execute(task: PlannedTask, worker: (typeof workers)[number]): Promise<void> {
      let workerUrl = worker.url;
      const identity = identities[engineForTask(task)]!;
      const state = manifest.states[task.id],
        dependencies: Record<string, SubmissionReceipt> = {};
      for (const [label, id] of Object.entries(task.dependencies)) {
        const receipt = await current.receipt(id);
        if (!receipt) throw new Error("Dependency missing");
        dependencies[label] = receipt;
      }
      const prepared = options.pack.prepare(task, options.plan.inputs, dependencies);
      const model = options.modelForStage(task.stage);
      const cacheKey = digest({
        program,
        identity,
        task: task.id,
        inputs: task.inputIds,
        evaluation: prepared.evaluation,
        prompt: prepared.prompt,
        model,
        policy: options.policy,
        dependencies: Object.fromEntries(
          Object.entries(dependencies).map(([key, value]) => [key, value.evaluation]),
        ),
      });
      state.cacheKey = cacheKey;
      const cache = path.join(options.cacheDir, cacheKey),
        cachedFile = path.join(cache, "receipt.json");
      if (await exists(cachedFile)) {
        try {
          const receipt = await readJson<SubmissionReceipt>(cachedFile);
          options.pack.validate(task, options.plan.inputs, receipt.evaluation, receipt.audit);
          for (const artifact of receipt.audit.artifacts)
            if (
              sha256(await readFile(path.join(cache, "artifacts", safeId(artifact.id)))) !== artifact.digest
            )
              throw new Error("Cached artifact corrupt");
          if (receipt.audit.artifacts.length)
            await cp(path.join(cache, "artifacts"), path.join(run, "tasks", task.id, "artifacts"), {
              recursive: true,
            });
          await writeJson(path.join(run, "tasks", task.id, "result.json"), { ...receipt, cached: true });
          state.status = "succeeded";
          await current.save();
          options.onProgress?.(`cache ${task.stage} ${task.id}`);
          return;
        } catch (error) {
          options.onProgress?.(`忽略无效缓存：${errorText(error)}`);
        }
      }
      for (let retry = 0; retry <= options.retries; retry++) {
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
            path.join(run, "workers", `${identity.engine}-${randomUUID()}`),
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
          engine: identity,
          evaluation: prepared.evaluation,
          model,
          policy: options.policy,
          prompt: prepared.prompt,
          inputs: Object.entries(task.inputIds).map(([name, id]) => ({ ...manifest.inputs[id], name })),
          hostUrl,
          deadline: Date.now() + options.policy.timeoutSeconds * 1000,
        };
        await current.activate(spec);
        const attemptDir = path.join(
          run,
          "tasks",
          task.id,
          `attempt-${state.attempts.toString().padStart(3, "0")}`,
        );
        const eventController = new AbortController();
        let stream: Promise<void> | undefined, status: AttemptStatus | undefined;
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
              await request(`${workerUrl}/v1/attempts/${spec.attemptId}/cancel`, "POST", {}).catch(() => {});
              break;
            }
            status = await request<AttemptStatus>(
              `${workerUrl}/v1/attempts/${spec.attemptId}`,
              "GET",
              undefined,
              AbortSignal.timeout(10000),
            );
            if (status.state !== "running") break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (status) await writeJson(path.join(attemptDir, "status.json"), status);
        } catch (error) {
          status = {
            state: "failed",
            lastSeq: 0,
            error: redact(errorText(error), [process.env[model.apiKeyEnv] || ""]),
            retryable: true,
          };
        } finally {
          // Drain terminal events when available, then close a disconnected stream.
          if (stream) await Promise.race([stream, new Promise((resolve) => setTimeout(resolve, 500))]);
          eventController.abort();
          await stream;
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
        try {
          const metrics = await request(
            `${workerUrl}/v1/attempts/${spec.attemptId}/metrics`,
            "GET",
            undefined,
            AbortSignal.timeout(1000),
          );
          await writeJson(path.join(attemptDir, "metrics.json"), metrics);
        } catch {
          /* A crashed worker may not have finalized its usage ledger. Events remain available. */
        }
        if (receipt) {
          state.status = "succeeded";
          await current.save();
          const copied = await copyArtifacts(
            workerUrl,
            spec,
            receipt,
            path.join(run, "tasks", task.id, "artifacts"),
          );
          try {
            if (copied) {
              if (receipt.audit.artifacts.length)
                await cp(path.join(run, "tasks", task.id, "artifacts"), path.join(cache, "artifacts"), {
                  recursive: true,
                });
              await writeJson(cachedFile, receipt);
            }
          } catch (error) {
            options.onProgress?.(`收据已保存，附属产物未完成：${errorText(error)}`);
          }
          options.onProgress?.(`succeeded ${task.stage} ${task.id}`);
          return;
        }
        if (state.status === "running")
          await current.endAttempt(
            spec,
            status?.state === "timed_out"
              ? "timed_out"
              : status?.state === "cancelled"
                ? "cancelled"
                : "failed",
            status?.error || "No committed receipt",
          );
        await writeJson(path.join(attemptDir, "error.json"), { reason: state.reason });
        await current.save();
        if (controller.signal.aborted || !status?.retryable || retry === options.retries) return;
        // Cancel the old attempt before authorizing a replacement.
        await request(`${workerUrl}/v1/attempts/${spec.attemptId}/cancel`, "POST", {}).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, options.retryDelaySeconds * 1000 * 2 ** retry));
      }
    }
    const running = new Map<string, Promise<void>>();
    while (true) {
      if (controller.signal.aborted) break;
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
        const required = options.pack.prepare(task, options.plan.inputs, {}).evaluation.toolNames;
        const worker = eligible.find(
          (w) =>
            !busy.has(w) &&
            w.health.identity.engine === engineForTask(task) &&
            required.every((name) => w.health.tools.includes(name)),
        );
        if (!worker || running.size >= options.concurrency) continue;
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
      if (running.size) await Promise.race(running.values());
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
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    await Promise.all(owned.map((worker) => worker.close()));
    if (store && store.manifest.status === "running") {
      store.manifest.status = "interrupted";
      await store.save();
    }
    await http?.close();
    await unlock();
  }
}
