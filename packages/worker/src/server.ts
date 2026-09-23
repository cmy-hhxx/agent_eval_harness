import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  PROTOCOL_VERSION,
  emptyUsage,
  type AgentBackend,
  type AgentSession,
  type AttemptSpec,
  type AttemptStatus,
  type Submission,
  type SubmissionReceipt,
  type ToolAudit,
  type ToolDefinition,
  type Usage,
  type WorkerEvent,
} from "../../contracts/src/index.js";
import {
  ArtifactStore,
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
  safeId,
  writeJson,
} from "../../contracts/src/io.js";
import { createRegistry, textResult, ToolRuntime, type ToolRegistry } from "../../tools/src/index.js";

interface Running {
  spec: AttemptSpec;
  status: AttemptStatus;
  controller: AbortController;
  session?: AgentSession;
  events: WorkerEvent[];
  clients: Map<ServerResponse, number>;
  saved: Promise<void>;
  done?: Promise<void>;
  directory: string;
  settled?: boolean;
}
export async function startWorker(
  backend: AgentBackend,
  directory: string,
  registry: ToolRegistry = createRegistry(),
  port = 0,
) {
  await mkdir(directory, { recursive: true });
  const attempts = new Map<string, Running>();
  let active: string | null = null;
  const emit = (attempt: Running, type: WorkerEvent["type"], value: unknown) => {
    const secret = process.env[attempt.spec.model.apiKeyEnv] || "";
    const data = JSON.parse(redact(JSON.stringify(value) ?? "null", [secret]));
    const event: WorkerEvent = {
      seq: attempt.events.length + 1,
      attemptId: attempt.spec.attemptId,
      time: Date.now(),
      type,
      data,
    };
    attempt.events.push(event);
    attempt.status.lastSeq = event.seq;
    attempt.saved = attempt.saved.then(async () => {
      await appendFile(path.join(attempt.directory, "events.jsonl"), JSON.stringify(event) + "\n");
      for (const [client, cursor] of attempt.clients)
        if (!client.destroyed && event.seq > cursor) {
          client.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          attempt.clients.set(client, event.seq);
        }
    });
  };
  const stop = async (attempt: Running, state: "cancelled" | "timed_out", reason: string) => {
    if (attempt.status.state !== "running") return;
    attempt.status.state = state;
    attempt.status.error = reason;
    attempt.controller.abort(new Error(reason));
    await attempt.session?.abort();
  };
  const execute = async (attempt: Running) => {
    const { spec, controller } = attempt,
      audit: ToolAudit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] },
      usage = emptyUsage();
    let accepted: SubmissionReceipt | undefined,
      submissions = 0,
      modelError: string | undefined;
    const deadline = setTimeout(
      () => {
        void stop(attempt, "timed_out", "Task deadline exceeded");
      },
      Math.max(1, spec.deadline - Date.now()),
    );
    let idle: NodeJS.Timeout;
    const activity = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        void stop(attempt, "timed_out", "Model/tool idle timeout");
      }, spec.policy.idleTimeoutSeconds * 1000);
    };
    activity();
    try {
      await writeJson(path.join(attempt.directory, "spec.json"), spec);
      await mkdir(path.join(attempt.directory, "workspace/inputs"), { recursive: true });
      const inputs = new Map<string, unknown>();
      for (const ref of spec.inputs) {
        const value = await request<unknown>(
          `${spec.hostUrl}/v1/inputs/${safeId(ref.id)}`,
          "GET",
          undefined,
          controller.signal,
        );
        if (digest(value) !== ref.digest) throw new Error("Input snapshot digest mismatch");
        inputs.set(ref.name, value);
        await writeJson(path.join(attempt.directory, "workspace/inputs", `${safeId(ref.name)}.json`), value);
      }
      const artifacts = new ArtifactStore(path.join(attempt.directory, "artifacts"));
      const definitions = registry.select(spec.evaluation.toolNames);
      const runtime = new ToolRuntime(
        {
          attemptId: spec.attemptId,
          workdir: path.join(attempt.directory, "workspace"),
          inputs,
          audit,
          policy: spec.policy,
          artifacts,
        },
        definitions,
      );
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      const validate = ajv.compile(spec.evaluation.outputSchema);
      const submit: ToolDefinition = {
        name: "submit_evaluation",
        description: "向 Host 提交评测结果。Host 校验并保存后结束任务；拒绝时返回可修正的问题。",
        inputSchema: spec.evaluation.outputSchema,
        async execute(_context, result) {
          if (accepted)
            return {
              ...textResult({ accepted: true, submissionId: accepted.submissionId }),
              terminate: true,
            };
          controller.signal.throwIfAborted();
          if (++submissions > 1 + spec.policy.repairAttempts) throw new Error("提交修正次数已耗尽");
          if (!validate(result))
            return {
              content: [{ type: "text", text: "输出格式错误：" + ajv.errorsText(validate.errors) }],
              isError: true,
            };
          const submission: Submission = {
            submissionId: digest([spec.attemptId, result]),
            attemptId: spec.attemptId,
            taskId: spec.taskId,
            evaluation: result,
            audit: structuredClone(audit),
            usage: { ...usage },
          };
          await writeJson(path.join(attempt.directory, "pending-submission.json"), submission);
          for (let i = 0; i < 3; i++) {
            try {
              accepted = await request<SubmissionReceipt>(
                `${spec.hostUrl}/v1/submissions`,
                "POST",
                submission,
                controller.signal,
              );
              break;
            } catch (error) {
              if (error instanceof HttpError && error.status < 500)
                return { content: [{ type: "text", text: error.message }], isError: true };
              try {
                accepted = await request<SubmissionReceipt>(
                  `${spec.hostUrl}/v1/submissions/${submission.submissionId}`,
                  "GET",
                  undefined,
                  controller.signal,
                );
                break;
              } catch (lookup) {
                if (controller.signal.aborted || i === 2) throw error;
              }
            }
          }
          if (!accepted) throw new Error("Host did not acknowledge submission");
          await writeJson(path.join(attempt.directory, "receipt.json"), accepted);
          emit(attempt, "submission", { accepted: true, submissionId: accepted.submissionId });
          return { ...textResult({ accepted: true, submissionId: accepted.submissionId }), terminate: true };
        },
      };
      emit(attempt, "started", { engine: backend.identity, policy: spec.policy });
      attempt.session = await backend.createSession({
        spec,
        workdir: runtime.context.workdir,
        tools: [...definitions, submit],
        async execute(name, args, signal) {
          activity();
          if (accepted) return { ...textResult({ accepted: true }), terminate: true };
          if (controller.signal.aborted) throw controller.signal.reason;
          emit(attempt, "tool_start", { name, args });
          let result;
          try {
            result =
              name === submit.name
                ? await submit.execute(runtime.context, args, controller.signal)
                : await runtime.execute(
                    name,
                    args,
                    signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
                  );
          } catch (error) {
            result = { content: [{ type: "text" as const, text: errorText(error) }], isError: true };
          }
          if (name === submit.name && !accepted && submissions >= 1 + spec.policy.repairAttempts) {
            controller.abort(new Error("Submission repair budget exhausted"));
            void attempt.session?.abort();
          }
          emit(attempt, "tool_end", { name, result });
          activity();
          return result;
        },
        onEvent(value) {
          activity();
          emit(attempt, "model", value);
          if (!value || typeof value !== "object") return;
          const event = value as {
            type?: string;
            message?: { role?: string; usage?: Partial<Usage>; stopReason?: string; errorMessage?: string };
          };
          if (event.type === "message_end" && event.message?.role === "assistant") {
            for (const key of Object.keys(usage) as (keyof Usage)[])
              usage[key] += event.message.usage?.[key] || 0;
            emit(attempt, "usage", usage);
            if (event.message.stopReason === "error")
              modelError = event.message.errorMessage || "Model request failed";
            if (spec.policy.maxTokens && usage.totalTokens >= spec.policy.maxTokens) {
              controller.abort(new Error("Token budget reached at model boundary"));
              void attempt.session?.abort();
            }
          }
        },
      });
      controller.signal.throwIfAborted();
      await attempt.session.run(spec.prompt + `\n\n执行预算：${JSON.stringify(spec.policy)}。`);
      if (accepted) attempt.status.state = "succeeded";
      else if (attempt.status.state === "running")
        throw new Error(modelError || "Agent ended without an accepted submission");
    } catch (error) {
      if (accepted) attempt.status.state = "succeeded";
      else if (attempt.status.state === "running") {
        attempt.status.state = "failed";
        attempt.status.error = redact(errorText(error), [process.env[spec.model.apiKeyEnv] || ""]);
        attempt.status.retryable = /fetch|network|ECONN|429|50[234]|overloaded|timeout/i.test(
          attempt.status.error,
        );
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(idle!);
      controller.abort();
      try {
        await attempt.session?.dispose();
      } catch (error) {
        attempt.status.error ??= `Cleanup: ${errorText(error)}`;
      }
      await writeJson(path.join(attempt.directory, "metrics.json"), { usage, audit });
      emit(attempt, "finished", attempt.status);
      await attempt.saved;
      await writeJson(path.join(attempt.directory, "status.json"), attempt.status);
      for (const client of attempt.clients.keys()) client.end();
      attempt.clients.clear();
      attempt.settled = true;
      if (active === spec.attemptId) active = null;
    }
  };
  const http = await listen(async (req, res, url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/v1/health")
      return json(res, {
        protocolVersion: PROTOCOL_VERSION,
        identity: backend.identity,
        tools: registry.names(),
        activeAttempt: active,
      });
    if (req.method === "POST" && url.pathname === "/v1/attempts") {
      const spec = (await body(req)) as AttemptSpec;
      if (spec.protocolVersion !== PROTOCOL_VERSION) throw new HttpError(400, "Unsupported protocol");
      safeId(spec.runId);
      safeId(spec.taskId);
      safeId(spec.attemptId);
      if (canonical(spec.engine) !== canonical(backend.identity))
        throw new HttpError(409, "Worker engine fingerprint mismatch");
      if (!spec.evaluation || !Array.isArray(spec.evaluation.toolNames) || !spec.evaluation.outputSchema)
        throw new HttpError(400, "Invalid evaluation spec");
      registry.select(spec.evaluation.toolNames);
      if (!Number.isFinite(spec.deadline) || spec.deadline <= Date.now())
        throw new HttpError(409, "Attempt already expired");
      for (const key of [
        "timeoutSeconds",
        "idleTimeoutSeconds",
        "maxToolCalls",
        "codeTimeoutSeconds",
        "maxOutputChars",
      ] as const)
        if (!Number.isInteger(spec.policy?.[key]) || spec.policy[key] <= 0)
          throw new HttpError(400, "Invalid policy");
      if (!Number.isInteger(spec.policy.repairAttempts) || spec.policy.repairAttempts < 0)
        throw new HttpError(400, "Invalid repair budget");
      if (
        spec.policy.maxTokens !== undefined &&
        (!Number.isInteger(spec.policy.maxTokens) || spec.policy.maxTokens < 1)
      )
        throw new HttpError(400, "Invalid token budget");
      if (!Array.isArray(spec.inputs) || new Set(spec.inputs.map((r) => r.name)).size !== spec.inputs.length)
        throw new HttpError(400, "Invalid input refs");
      spec.inputs.forEach((ref) => {
        safeId(ref.id);
        safeId(ref.name);
      });
      if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(spec.hostUrl))
        throw new HttpError(400, "V1 requires a loopback host URL");
      if (!spec.model || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.model.apiKeyEnv))
        throw new HttpError(400, "Invalid model credential reference");
      const previous = attempts.get(spec.attemptId);
      if (previous) {
        if (canonical(previous.spec) !== canonical(spec))
          throw new HttpError(409, "Attempt ID already used with different contents");
        return json(res, previous.status);
      }
      if (active) throw new HttpError(409, "Worker busy");
      const attemptDir = path.join(directory, spec.attemptId);
      if (await exists(attemptDir))
        throw new HttpError(409, "Attempt existed before restart; create a new attempt");
      active = spec.attemptId;
      await mkdir(attemptDir, { recursive: true });
      const attempt: Running = {
        spec,
        status: { state: "running", lastSeq: 0 },
        controller: new AbortController(),
        events: [],
        clients: new Map(),
        saved: Promise.resolve(),
        directory: attemptDir,
      };
      attempts.set(spec.attemptId, attempt);
      attempt.done = execute(attempt).catch((error) => {
        attempt.status = { state: "failed", lastSeq: attempt.events.length, error: errorText(error) };
        attempt.settled = true;
        for (const client of attempt.clients.keys()) client.end();
        attempt.clients.clear();
        if (active === spec.attemptId) active = null;
      });
      return json(res, attempt.status, 202);
    }
    if (parts[0] === "v1" && parts[1] === "attempts" && parts[2]) {
      const id = safeId(parts[2]),
        attempt = attempts.get(id),
        attemptDir = path.join(directory, id);
      if (!attempt && !(await exists(path.join(attemptDir, "spec.json"))))
        throw new HttpError(404, "Unknown attempt");
      if (req.method === "GET" && parts.length === 3)
        return json(
          res,
          attempt
            ? { ...attempt.status, state: attempt.settled ? attempt.status.state : "running" }
            : await readJson(path.join(attemptDir, "status.json")).catch(() => ({
                state: "failed",
                lastSeq: 0,
                error: "Worker restarted",
                retryable: true,
              })),
        );
      if (req.method === "POST" && parts[3] === "cancel") {
        if (attempt) await stop(attempt, "cancelled", "Cancelled by host");
        return json(res, { cancelled: true });
      }
      if (req.method === "GET" && parts[3] === "events") {
        const after = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "Invalid event cursor");
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.flushHeaders();
        const events = attempt
          ? attempt.events
          : (await readFile(path.join(attemptDir, "events.jsonl"), "utf8"))
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as WorkerEvent);
        if (attempt) await attempt.saved;
        for (const event of events)
          if (event.seq > after) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        if (!attempt || attempt.settled) {
          res.end();
          return;
        }
        attempt.clients.set(res, Math.max(after, events.at(-1)?.seq || 0));
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 10000);
        res.on("close", () => {
          clearInterval(heartbeat);
          attempt.clients.delete(res);
        });
        return;
      }
      if (req.method === "GET" && parts[3] === "artifacts" && parts[4]) {
        const bytes = await new ArtifactStore(path.join(attemptDir, "artifacts")).get(parts[4]);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(bytes);
        return;
      }
      if (req.method === "GET" && parts[3] === "metrics")
        return json(res, await readJson(path.join(attemptDir, "metrics.json")));
    }
    throw new HttpError(404, "Not found");
  }, port);
  return {
    ...http,
    async close() {
      await Promise.all([...attempts.values()].map((a) => stop(a, "cancelled", "Worker shutting down")));
      await Promise.all([...attempts.values()].map((a) => a.done));
      await http.close();
    },
  };
}
