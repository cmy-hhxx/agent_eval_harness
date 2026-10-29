import { mkdir, rm } from "node:fs/promises";
import { inspect } from "node:util";
import path from "node:path";
import {
  type AgentBackend,
  type AgentSession,
  type AttemptSpec,
  type AttemptRecord,
  type AttemptStatus,
} from "@eval/contracts";
import { ArtifactStore, exists, readJson, MaterialPool } from "@eval/data";
import { HttpError, canonical, errorText, redact } from "@eval/contracts";
import { createRegistry, type ToolRegistry } from "@eval/tools";
import { AttemptEventLog, readAttemptEvents, replayEventStream } from "./attempt-events.js";
import { serveWorkerHttp } from "./worker-http.js";
import { executeAttempt } from "./attempt-execution.js";
import { bounded } from "./lifecycle.js";

interface Running {
  spec: AttemptSpec;
  status: AttemptStatus;
  controller: AbortController;
  session?: AgentSession;
  events: AttemptEventLog;
  done?: Promise<void>;
  directory: string;
  settled?: boolean;
}
export async function startWorker(
  backend: AgentBackend,
  directory: string,
  registry: ToolRegistry = createRegistry(),
  port = 0,
  execution?: { python: string },
  materials = new MaterialPool(path.join(directory, "materials")),
) {
  await mkdir(directory, { recursive: true });
  const attempts = new Map<string, Running>();
  const released = new Set<string>();
  let active: string | null = null;
  const stop = async (attempt: Running, state: "cancelled" | "timed_out", reason: string) => {
    if (attempt.status.state !== "running") return;
    attempt.status.state = state;
    attempt.status.error = reason;
    attempt.controller.abort(new Error(reason));
    try { await bounded(Promise.resolve().then(() => attempt.session?.abort()),
      (attempt.spec.policy.cleanupTimeoutSeconds ?? 10) * 1000, "Worker cancellation timeout"); }
    catch { attempt.status.workerUnusable = true; }
  };
  const attemptDirectory = (id: string) => path.join(directory, id);
  const requireKnownAttempt = async (id: string, attempt: Running | undefined) => {
    if (!attempt && !(await exists(path.join(attemptDirectory(id), "attempt.json"))))
      throw new HttpError(404, "Unknown attempt");
  };
  const http = await serveWorkerHttp({
    identity: backend.identity,
    tools: registry.names(),
    activeAttempt: () => active,
    async start(spec) {
      const previous = attempts.get(spec.attemptId);
      if (released.has(spec.attemptId)) throw new HttpError(409, "Attempt already released");
      if (previous) {
        if (canonical(previous.spec) !== canonical(spec))
          throw new HttpError(409, "Attempt ID already used with different contents");
        return previous.status;
      }
      if (active) throw new HttpError(409, "Worker busy");
      const attemptDir = attemptDirectory(spec.attemptId);
      if (await exists(attemptDir))
        throw new HttpError(409, "Attempt existed before restart; create a new attempt");
      active = spec.attemptId;
      await mkdir(attemptDir, { recursive: true });
      const status: AttemptStatus = { state: "running", lastSeq: 0 };
      const attempt: Running = {
        spec,
        status,
        controller: new AbortController(),
        events: new AttemptEventLog(attemptDir, spec.attemptId, status,
          process.env[spec.model.apiKeyEnv] || ""),
        directory: attemptDir,
      };
      attempts.set(spec.attemptId, attempt);
      attempt.done = executeAttempt(attempt, {
        backend,
        registry,
        execution,
        materials,
        stop,
        onSettled(attemptId) {
          if (active === attemptId && !attempt.status.workerUnusable) active = null;
        },
      }).catch(async error => {
        Object.assign(attempt.status, {
          state: "failed",
          lastSeq: attempt.events.events.length,
          error: redact(errorText(error), [process.env[spec.model.apiKeyEnv] || ""]),
          errorDetail: redact(inspect(error, { depth: null, maxStringLength: null, maxArrayLength: null }),
            [process.env[spec.model.apiKeyEnv] || ""]),
        });
        attempt.settled = true;
        await attempt.events.end();
        if (active === spec.attemptId) active = null;
      });
      return attempt.status;
    },
    async status(id) {
      const attempt = attempts.get(id);
      await requireKnownAttempt(id, attempt);
      return attempt
        ? { ...attempt.status, state: attempt.settled ? attempt.status.state : "running" }
        : (await readJson<AttemptRecord>(path.join(attemptDirectory(id), "attempt.json"))).status || {
            state: "failed",
            lastSeq: 0,
            error: "Worker restarted",
            retryable: true,
          };
    },
    async cancel(id) {
      const attempt = attempts.get(id);
      if (attempt) await stop(attempt, "cancelled", "Cancelled by host");
    },
    async release(id) {
      if (released.has(id)) return { released: true };
      const attempt = attempts.get(id);
      if (attempt && !attempt.settled) throw new HttpError(409, "Attempt still running");
      if (!attempt) throw new HttpError(404, "Unknown attempt");
      await rm(attemptDirectory(id), { recursive: true, force: true });
      attempts.delete(id);
      released.add(id);
      return { released: true };
    },
    async events(id, res, after) {
      const attempt = attempts.get(id);
      await requireKnownAttempt(id, attempt);
      if (attempt) await attempt.events.stream(res, after);
      else replayEventStream(res, await readAttemptEvents(attemptDirectory(id)), after);
    },
    async record(id) {
      const attempt = attempts.get(id);
      if (attempt && !attempt.settled) throw new HttpError(409, "Attempt still running");
      await requireKnownAttempt(id, attempt);
      return readJson<AttemptRecord>(path.join(attemptDirectory(id), "attempt.json"));
    },
    async artifact(id, artifactId) {
      await requireKnownAttempt(id, attempts.get(id));
      return new ArtifactStore(path.join(attemptDirectory(id), "artifacts")).get(artifactId);
    },
  }, registry, port);
  return {
    ...http,
    async close() {
      try {
        await bounded((async () => {
          await Promise.all([...attempts.values()].map((a) => stop(a, "cancelled", "Worker shutting down")));
          await Promise.all([...attempts.values()].map((a) => a.done));
        })(), 10_000, "Worker shutdown timeout");
      } finally { await http.close(); }
    },
  };
}

/** Independent HTTP/session slots share only the loaded SDK and the Node process. */
export async function startWorkerPool(backend: AgentBackend, directory: string, slots: number, port = 0,
  execution?: { python: string }) {
  if (!Number.isSafeInteger(slots) || slots < 1 || slots > 200) throw new Error("Worker slots must be an integer from 1 to 200");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || port > 0 && port + slots - 1 > 65535)
    throw new Error("Invalid Worker pool port range");
  const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
  const materials = new MaterialPool(path.join(directory, "materials"));
  try {
    for (let index = 0; index < slots; index++) workers.push(await startWorker(backend,
      slots === 1 ? directory : path.join(directory, `slot-${index}`), undefined, port ? port + index : 0, execution, materials));
  } catch (error) {
    await Promise.allSettled(workers.map(worker => worker.close()));
    throw error;
  }
  return { urls: workers.map(worker => worker.url), close: async () => { await Promise.all(workers.map(worker => worker.close())); } };
}
