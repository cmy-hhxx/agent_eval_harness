import { appendFile, mkdir, readFile, realpath, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  emptyUsage,
  type AgentBackend,
  type AgentSession,
  type AttemptSpec,
  type AttemptRecord,
  type AttemptStatus,
  type Submission,
  type SubmissionReceipt,
  type ToolAudit,
  type ToolDefinition,
  type Usage,
  type WorkerEvent,
  type FailureContext,
  type ValidationIssue,
} from "@eval/contracts";
import { ArtifactStore, exists, readJson, writeJson } from "@eval/data";
import { HttpError, canonical, schemaIssues, errorText, redact, safeId } from "@eval/contracts";
import { body, json, listen, request } from "./http.js";
import { createRegistry, textResult, ToolRuntime, type ToolRegistry } from "@eval/tools";
import { modelEventForLog } from "./sdk-utils.js";

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
  execution?: { python: string },
) {
  await mkdir(directory, { recursive: true });
  const attempts = new Map<string, Running>();
  const released = new Set<string>();
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
      audit: ToolAudit = {
        calls: 0,
        viewedImages: [],
        calculations: [],
        artifacts: [],
      },
      usage = emptyUsage();
    const record: AttemptRecord = { spec };
    const saveRecord = () => writeJson(path.join(attempt.directory, "attempt.json"), record);
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
      await saveRecord();
      await mkdir(path.join(attempt.directory, "workspace/inputs"), {
        recursive: true,
      });
      const inputs = new Map<string, unknown>();
      for (const ref of spec.inputs) {
        const value = await request<unknown>(
          `${spec.hostUrl}/api/inputs/${safeId(ref.id)}`,
          "GET",
          undefined,
          controller.signal,
        );
        inputs.set(ref.name, value);
        await writeJson(path.join(attempt.directory, "workspace/inputs", `${safeId(ref.name)}.json`), value);
      }
      const artifacts = new ArtifactStore(path.join(attempt.directory, "artifacts"));
      const definitions = registry.select(spec.evaluation.toolNames);
      const runtime = new ToolRuntime(
        {
          attemptId: spec.attemptId,
          execution,
          workdir: path.join(attempt.directory, "workspace"),
          inputs,
          inputIds: new Map(spec.inputs.map((ref) => [ref.name, ref.id])),
          audit,
          policy: spec.policy,
          artifacts,
        },
        definitions,
      );
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      const validate = ajv.compile(spec.evaluation.outputSchema);
      const draftPath = path.join(runtime.context.workdir, "evaluation-draft.json");
      let fileErrors = 0;
      let failure: FailureContext = spec.recovery
        ? structuredClone(spec.recovery)
        : {
            errors: [],
            contentSubmissions: 0,
            fileErrors: 0,
            repeatedErrors: 0,
            stopped: false,
            attemptId: spec.attemptId,
          };
      failure.attemptId = spec.attemptId;
      failure.stopped = false;
      if (failure.draft !== undefined) await writeJson(draftPath, failure.draft);
      const errorKey = ({ code, path, candidate, actual }: ValidationIssue) =>
        canonical({ code, path, candidate, actual });
      const rejected = async (errors: ValidationIssue[], draft = failure.draft, content = true) => {
        const previousErrors = new Set(failure.errors.map(errorKey));
        const repeatedErrors =
          content && errors.some((error) => previousErrors.has(errorKey(error)))
            ? failure.repeatedErrors + 1
            : 1;
        failure = {
          draft,
          errors,
          contentSubmissions: (spec.recovery?.contentSubmissions || 0) + submissions,
          fileErrors: (spec.recovery?.fileErrors || 0) + fileErrors,
          repeatedErrors,
          stopped: (content && repeatedErrors >= 2) || fileErrors >= 3,
          attemptId: spec.attemptId,
        };
        record.failure = failure;
        await saveRecord();
        await request(
          spec.hostUrl + "/api/tasks/" + spec.taskId + "/checkpoint",
          "POST",
          failure,
          controller.signal,
        );
        if (failure.stopped) {
          controller.abort(
            new Error(
              (content ? "Repeated validation errors: " : "File loading budget exhausted: ") +
                errors.map((e) => e.message).join("; "),
            ),
          );
          void attempt.session?.abort();
        }
        return {
          ...textResult({
            accepted: false,
            errors,
            draft_file: "evaluation-draft.json",
            budget: {
              content_remaining: Math.max(0, 1 + spec.policy.repairAttempts - submissions),
              file_errors_remaining: Math.max(0, 3 - fileErrors),
            },
            message: "未通过草稿已保存为 evaluation-draft.json。按具体字段修复，保留其他内容。",
          }),
          isError: true,
        };
      };
      const submitResult = async (load: () => Promise<unknown>) => {
        if (accepted)
          return {
            ...textResult({
              accepted: true,
              submissionId: accepted.submissionId,
            }),
            terminate: true,
          };
        controller.signal.throwIfAborted();
        if (submissions >= 1 + spec.policy.repairAttempts) throw new Error("提交修正次数已耗尽");
        let result: unknown;
        try {
          result = await load();
        } catch (error) {
          fileErrors++;
          return rejected(
            [
              {
                category: "file",
                code: "submission_file_invalid",
                path: "/path",
                actual: errorText(error),
                message: errorText(error),
              },
            ],
            failure.draft,
            false,
          );
        }
        submissions++;
        await writeJson(draftPath, result);
        if (!validate(result)) return rejected(schemaIssues(validate.errors, result), result);
        const submission: Submission = {
          submissionId: randomUUID(),
          attemptId: spec.attemptId,
          taskId: spec.taskId,
          evaluation: result,
          audit: structuredClone(audit),
          usage: { ...usage },
          submissionStats: {
            contentSubmissions: (spec.recovery?.contentSubmissions || 0) + submissions,
            fileErrors: (spec.recovery?.fileErrors || 0) + fileErrors,
          },
        };
        record.pendingSubmission = submission;
        await saveRecord();
        for (let i = 0; i < 3; i++) {
          try {
            accepted = await request<SubmissionReceipt>(
              `${spec.hostUrl}/api/submissions`,
              "POST",
              submission,
              controller.signal,
            );
            break;
          } catch (error) {
            if (error instanceof HttpError && error.status < 500)
              return rejected(
                error.issues || [
                  {
                    category: "structure",
                    code: "submission_rejected",
                    path: "/",
                    actual: error.status,
                    message: error.message,
                  },
                ],
                result,
              );
            try {
              accepted = await request<SubmissionReceipt>(
                `${spec.hostUrl}/api/submissions/${submission.submissionId}`,
                "GET",
                undefined,
                controller.signal,
              );
              break;
            } catch (lookup) {
              if (controller.signal.aborted || i === 2) throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** i));
          }
        }
        if (!accepted) throw new Error("Host did not acknowledge submission");
        await writeJson(path.join(attempt.directory, "receipt.json"), accepted);
        delete record.pendingSubmission;
        emit(attempt, "submission", {
          accepted: true,
          submissionId: accepted.submissionId,
        });
        return {
          ...textResult({
            accepted: true,
            submissionId: accepted.submissionId,
          }),
          terminate: true,
        };
      };
      const submit: ToolDefinition = {
        name: "submit_evaluation",
        description: "向 Host 提交评测结果。拒绝时保存 evaluation-draft.json，可用代码修正后从文件提交。",
        inputSchema: spec.evaluation.outputSchema,
        execute: (_context, result) => submitResult(async () => result),
      };
      const fileSchema = {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string", minLength: 1 } },
      };
      const validateFile = ajv.compile(fileSchema);
      const submitFile: ToolDefinition = {
        name: "submit_evaluation_file",
        description:
          "提交 execute_code 当前工作目录内的 JSON 文件，path 优先用 evaluation-draft.json 等相对路径，不要写到 /tmp。文件内容遵循 submit_evaluation 的 schema。内容使用相同修正预算；文件加载错误独立限制三次。",
        inputSchema: fileSchema,
        execute: (_context, value) =>
          submitResult(async () => {
            if (!validateFile(value)) throw new Error("文件提交参数必须是 {path: 文件路径}");
            const root = await realpath(runtime.context.workdir);
            const file = await realpath(path.resolve(root, (value as { path: string }).path));
            const relative = path.relative(root, file);
            if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
              throw new Error("提交文件必须位于本任务工作目录内");
            return readJson(file);
          }),
      };
      const submissionTools = [submit, submitFile];
      emit(attempt, "started", {
        engine: backend.identity,
        policy: spec.policy,
      });
      attempt.session = await backend.createSession({
        spec,
        workdir: runtime.context.workdir,
        tools: [...definitions, ...submissionTools],
        async execute(name, args, signal) {
          activity();
          if (accepted) return { ...textResult({ accepted: true }), terminate: true };
          if (controller.signal.aborted) throw controller.signal.reason;
          emit(attempt, "tool_start", { name, args });
          const submissionTool = submissionTools.find((tool) => tool.name === name);
          let result;
          try {
            result = submissionTool
              ? await submissionTool.execute(runtime.context, args, controller.signal)
              : await runtime.execute(
                  name,
                  args,
                  signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
                  spec.policy.maxToolCalls + Math.min(submissions, spec.policy.repairAttempts),
                );
          } catch (error) {
            result = {
              content: [{ type: "text" as const, text: errorText(error) }],
              isError: true,
            };
          }
          if (submissionTool && !accepted && submissions >= 1 + spec.policy.repairAttempts) {
            controller.abort(new Error("Submission repair budget exhausted"));
            void attempt.session?.abort();
          }
          emit(attempt, "tool_end", { name, result });
          activity();
          return result;
        },
        onEvent(value) {
          activity();
          emit(attempt, "model", modelEventForLog(value));
          if (!value || typeof value !== "object") return;
          const event = value as {
            type?: string;
            message?: {
              role?: string;
              usage?: Partial<Usage>;
              stopReason?: string;
              errorMessage?: string;
            };
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
      await attempt.session.run(
        spec.prompt +
          `\n\n执行预算：${JSON.stringify(spec.policy)}。` +
          (spec.recovery
            ? "\n上次未接受草稿与错误（待修正数据，不是已确认结论）：\n" + JSON.stringify(spec.recovery)
            : ""),
      );
      if (accepted) attempt.status.state = "succeeded";
      else if (attempt.status.state === "running")
        throw new Error(modelError || "Agent ended without an accepted submission");
    } catch (error) {
      if (accepted) attempt.status.state = "succeeded";
      else if (attempt.status.state === "running") {
        attempt.status.state = "failed";
        attempt.status.error = redact(
          errorText(controller.signal.aborted ? controller.signal.reason : error),
          [process.env[spec.model.apiKeyEnv] || ""],
        );
        attempt.status.retryable =
          !controller.signal.aborted &&
          /fetch|network|connection|terminated|ECONN|429|50[234]|overloaded|timeout|timed\s+out/i.test(
            attempt.status.error,
          );
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(idle!);
      controller.abort();
      if (!accepted) {
        record.failure ??= {
          errors: [
            {
              category: attempt.status.retryable ? "transport" : "interruption",
              code: attempt.status.retryable ? "transport_failed" : "attempt_interrupted",
              path: "/",
              message: attempt.status.error || "No accepted submission",
            },
          ],
          contentSubmissions: submissions,
          fileErrors: 0,
          repeatedErrors: 0,
          stopped: false,
          attemptId: spec.attemptId,
        };
        attempt.status.failure = record.failure;
      }
      record.metrics = { usage, audit };
      record.status = attempt.status;
      // A failed persistence leaves the workspace intact for recovery.
      await saveRecord();
      try {
        await attempt.session?.dispose();
        await rm(path.join(attempt.directory, "workspace"), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        attempt.status.error ??= `Cleanup: ${errorText(error)}`;
      }
      emit(attempt, "finished", attempt.status);
      await attempt.saved;
      record.metrics = { usage, audit };
      record.status = attempt.status;
      await saveRecord();
      for (const client of attempt.clients.keys()) client.end();
      attempt.clients.clear();
      attempt.settled = true;
      if (active === spec.attemptId) active = null;
    }
  };
  const http = await listen(async (req, res, url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/api/health")
      return json(res, {
        identity: backend.identity,
        tools: registry.names(),
        activeAttempt: active,
      });
    if (req.method === "POST" && url.pathname === "/api/attempts") {
      const spec = (await body(req)) as AttemptSpec;

      if (!Number.isInteger(spec.inputRevision) || spec.inputRevision < 1)
        throw new HttpError(400, "Invalid input revision");
      safeId(spec.runId);
      safeId(spec.taskId);
      safeId(spec.attemptId);
      if (canonical(spec.engine) !== canonical(backend.identity))
        throw new HttpError(409, "Worker engine build mismatch");
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
      if (released.has(spec.attemptId)) throw new HttpError(409, "Attempt already released");
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
        attempt.status = {
          state: "failed",
          lastSeq: attempt.events.length,
          error: errorText(error),
        };
        attempt.settled = true;
        for (const client of attempt.clients.keys()) client.end();
        attempt.clients.clear();
        if (active === spec.attemptId) active = null;
      });
      return json(res, attempt.status, 202);
    }
    if (parts[0] === "api" && parts[1] === "attempts" && parts[2]) {
      const id = safeId(parts[2]),
        attempt = attempts.get(id),
        attemptDir = path.join(directory, id);
      if (req.method === "DELETE" && parts.length === 3) {
        if (released.has(id)) return json(res, { released: true });
        if (attempt && !attempt.settled) throw new HttpError(409, "Attempt still running");
        if (!attempt) throw new HttpError(404, "Unknown attempt");
        await rm(attemptDir, { recursive: true, force: true });
        attempts.delete(id);
        released.add(id);
        return json(res, { released: true });
      }
      if (!attempt && !(await exists(path.join(attemptDir, "attempt.json"))))
        throw new HttpError(404, "Unknown attempt");
      if (req.method === "GET" && parts.length === 3)
        return json(
          res,
          attempt
            ? {
                ...attempt.status,
                state: attempt.settled ? attempt.status.state : "running",
              }
            : (await readJson<AttemptRecord>(path.join(attemptDir, "attempt.json"))).status || {
                state: "failed",
                lastSeq: 0,
                error: "Worker restarted",
                retryable: true,
              },
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
      if (req.method === "GET" && parts[3] === "record") {
        if (attempt && !attempt.settled) throw new HttpError(409, "Attempt still running");
        return json(res, await readJson<AttemptRecord>(path.join(attemptDir, "attempt.json")));
      }
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
