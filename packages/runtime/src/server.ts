import { appendFile, mkdir, readFile, realpath, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  emptyUsage,
  SUBMISSION_FILE_SCHEMA,
  submissionToolNames,
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
  type InspectionCheckpoint,
  type JsonObject,
  type ValidationIssue,
} from "@eval/contracts";
import { ArtifactStore, exists, readJson, writeJson } from "@eval/data";
import { HttpError, canonical, errorText, redact, safeId, validateEvidenceBank, type EvidenceBank } from "@eval/contracts";
import { body, json, listen, request } from "./http.js";
import { createRegistry, textResult, ToolRuntime, type ToolRegistry, type ExecutableTool } from "@eval/tools";
import { contentToolName, modelEventForLog } from "./sdk-utils.js";

interface Running {
  spec: AttemptSpec;
  status: AttemptStatus;
  controller: AbortController;
  session?: AgentSession;
  events: WorkerEvent[];
  clients: Map<ServerResponse, number>;
  saved: Promise<void>;
  persistedEvents: number;
  flushQueued?: boolean;
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
    if (attempt.flushQueued) return;
    attempt.flushQueued = true;
    attempt.saved = attempt.saved.then(async () => {
      attempt.flushQueued = false;
      const batch = attempt.events.slice(attempt.persistedEvents);
      await appendFile(path.join(attempt.directory, "events.jsonl"), batch.map((item) => JSON.stringify(item)).join("\n") + "\n");
      attempt.persistedEvents += batch.length;
      for (const [client, cursor] of attempt.clients)
        for (const event of batch)
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
        evidenceBank: [...spec.evidenceBank],
        calls: 0,
        requiredReadCalls: 0,
        viewedImages: [],
        traceReads: [],
        calculations: [],
        artifacts: [],
      },
      usage = emptyUsage();
    const record: AttemptRecord = { spec, evidenceBank: [...audit.evidenceBank!] };
    const saveRecord = () => writeJson(path.join(attempt.directory, "attempt.json"), record);
    let accepted: SubmissionReceipt | undefined,
      submissions = 0,
      modelError: string | undefined,
      malformedCompletedResponse = false;
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
          `${spec.hostUrl}/api/inputs/${safeId(ref.id)}?attempt=${safeId(spec.attemptId)}`,
          "GET",
          undefined,
          controller.signal,
        );
        inputs.set(ref.name, value);
        await writeJson(path.join(attempt.directory, "workspace/inputs", `${safeId(ref.name)}.json`), value);
      }
      const artifacts = new ArtifactStore(path.join(attempt.directory, "artifacts"));
      const definitions = registry.select(spec.evaluation.toolNames).map(tool =>
        tool.name === "inspect_material" && !spec.evaluation.fileSubmission && spec.evaluation.inspectionSchema
          ? { ...tool, inputSchema: spec.evaluation.inspectionSchema }
          : tool);
      const runtime = new ToolRuntime(
        {
          attemptId: spec.attemptId,
          execution,
          workdir: path.join(attempt.directory, "workspace"),
          inputs,
          inputIds: new Map(spec.inputs.map(ref => [ref.name, ref.id])),
          sourcePresentations: new Map(Object.entries(spec.evaluation.sourcePresentations ?? {})),
          audit,
          policy: spec.policy,
          requiredReads: spec.evaluation.requiredReads,
          artifacts,
        },
        definitions,
      );
      const explorationLimit = () => spec.policy.maxToolCalls + 3 * Math.min(submissions, spec.policy.repairAttempts);
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      const draftPath = path.join(runtime.context.workdir, "submission-rejected.json");
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
      validateEvidenceBank(audit.evidenceBank, spec.recovery?.evidenceBank ?? []);
      failure.evidenceBank = [...audit.evidenceBank!];
      runtime.context.persistEvidenceBank = async bank => {
        // The tool's reference-bearing operations share one queue. Save a directory before exposing any new choice.
        validateEvidenceBank(bank, failure.evidenceBank ?? []);
        for (let retry = 0; retry < 3; retry++) {
          try {
            const saved = await request<{ evidenceBank: EvidenceBank }>(`${spec.hostUrl}/api/evidence-bank`, "POST",
              { taskId: spec.taskId, attemptId: spec.attemptId, evidenceBank: bank }, controller.signal);
            validateEvidenceBank(saved.evidenceBank, bank);
            failure.evidenceBank = [...saved.evidenceBank];
            record.evidenceBank = [...saved.evidenceBank];
            if (record.failure) record.failure.evidenceBank = [...saved.evidenceBank];
            await saveRecord();
            return;
          } catch (error) {
            if ((error instanceof HttpError && error.status < 500) || controller.signal.aborted || retry === 2) throw error;
          }
        }
      };
      if (failure.stopped) delete failure.draft;
      failure.attemptId = spec.attemptId;
      failure.stopped = false;
      failure.repeatedErrors = 0;
      if (failure.inspection) {
        audit.inspection = structuredClone(failure.inspection);
        audit.traceReads.push(...structuredClone(failure.inspection.proof.traceReads));
        audit.viewedImages.push(...failure.inspection.proof.viewedImages);
      }
      if (failure.draft !== undefined) await writeJson(draftPath, failure.draft);
      const errorSet = (errors: ValidationIssue[]) => canonical(errors.map((error) => canonical(error)).sort());
      const nextContentTool = () => contentToolName(spec.evaluation, Boolean(audit.inspection));
      const reserveFileDraft = () => {
        if (spec.evaluation.fileSubmission && submissions < 1 + spec.policy.repairAttempts)
          runtime.reserveDraftWrite();
      };
      reserveFileDraft();
      const rejected = async (errors: ValidationIssue[], draft = failure.draft, content = true, compareDraft = true) => {
        const repeatedErrors = !compareDraft ? 0 :
          content && errorSet(errors) === errorSet(failure.errors) && canonical(draft) === canonical(failure.draft)
            ? failure.repeatedErrors + 1
            : 1;
        failure = {
          evidenceBank: [...audit.evidenceBank!],
          ...(failure.inspection ? { inspection: failure.inspection } : {}),
          draft: structuredClone(draft),
          errors,
          contentSubmissions: (spec.recovery?.contentSubmissions || 0) + submissions,
          fileErrors: (spec.recovery?.fileErrors || 0) + fileErrors,
          repeatedErrors,
          // Repeated drafts remain diagnostic. The shared content cap owns repair
          // termination; stopping after two identical drafts discards valid repairs.
          stopped: fileErrors >= 3,
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
          runtime.clearDraftWrite();
          controller.abort(new Error("File loading budget exhausted: " + errors.map((e) => e.message).join("; ")));
          void attempt.session?.abort();
        }
        if (content && !failure.stopped) reserveFileDraft();
        const fileRepair = spec.evaluation.fileSubmission && draft !== undefined && await exists(draftPath);
        const nextTool = nextContentTool(), inspectionPending = nextTool === "inspect_material";
        return {
          ...textResult({
            accepted: false,
            next_tool: nextTool,
            ...(inspectionPending ? { instructions: spec.evaluation.toolDescriptions.inspect_material } : {}),
            errors,
            ...(fileRepair ? { draft_file: "submission-rejected.json" } : {}),
            budget: {
              content_remaining: Math.max(0, 1 + spec.policy.repairAttempts - submissions),
              file_errors_remaining: Math.max(0, 3 - fileErrors),
            },
            message: inspectionPending ? spec.evaluation.toolDescriptions.inspect_material : (content && repeatedErrors > 1
              ? "本次完整 JSON 与上一稿相同，报错字段尚未修正；改变对象键顺序不算修改。请逐一修正 errors 指向的字段后再提交，累计内容预算不会重置。"
              : "") + (fileRepair
              ? "未通过草稿已保存为 submission-rejected.json。按具体字段修复，保留其他内容；" + spec.evaluation.toolDescriptions[nextTool]
              : draft === undefined
                ? "未读取到提交内容，未生成草稿。" + spec.evaluation.toolDescriptions[nextTool]
                : "按具体字段修正完整 JSON，保留其他内容。" + spec.evaluation.toolDescriptions[nextTool]),
          }),
          isError: true,
        };
      };
      const submitExclusive = async (load: () => Promise<unknown>) => {
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
          return rejectedFile(error);
        }
        submissions++;
        runtime.clearDraftWrite();
        emit(attempt, "submission", { accepted: false, content_loaded: true, evaluation: result,
          contentSubmissions: (spec.recovery?.contentSubmissions || 0) + submissions });
        await writeJson(draftPath, result);
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
      let submissionQueue = Promise.resolve();
      const enqueueContent = (operation: () => Promise<import("@eval/contracts").ToolResult>) => {
        const pending = submissionQueue.then(operation);
        submissionQueue = pending.then(() => undefined, () => undefined);
        return pending;
      };
      const validateFile = ajv.compile(SUBMISSION_FILE_SCHEMA);
      const loadFileContent = async (args: unknown) => {
        if (!validateFile(args)) throw new Error("文件提交参数必须是 {path: 文件路径}");
        const root = await realpath(runtime.context.workdir);
        const file = await realpath(path.resolve(root, (args as { path: string }).path));
        const relative = path.relative(root, file);
        if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
          throw new Error("提交文件必须位于本任务工作目录内");
        return readJson(file);
      };
      const rejectedFile = async (error: unknown) => {
        fileErrors++;
        const feedback = await rejected([{ category: "file", code: "submission_file_invalid", path: "/path",
          actual: errorText(error), message: errorText(error) }], failure.draft, false);
        // A failed load leaves content untouched. Reoffer one writer within its existing total cap.
        if (!failure.stopped) reserveFileDraft();
        return feedback;
      };
      runtime.context.inspectMaterial = (args, signal) => enqueueContent(async () => {
        signal.throwIfAborted();
        if (!spec.evaluation.inspectionSchema) throw new Error("当前任务未配置材料核查");
        if (submissions >= 1 + spec.policy.repairAttempts) throw new Error("提交修正次数已耗尽");
        let value: unknown = args;
        if (spec.evaluation.fileSubmission) {
          try { value = await loadFileContent(args); }
          catch (error) { return rejectedFile(error); }
        }
        submissions++;
        runtime.clearDraftWrite();
        emit(attempt, "submission", { accepted: false, content_loaded: true, inspection: true, evaluation: value,
          contentSubmissions: (spec.recovery?.contentSubmissions ?? 0) + submissions });
        await writeJson(draftPath, value);
        if (audit.inspection) return rejected([{ category: "decision", code: "inspection_already_revealed", path: "/",
          message: "既有判词已揭示，不能覆盖原盲核查；请继续最终提交。" }], value);
        const payload = { inspectionId: randomUUID(), attemptId: spec.attemptId, taskId: spec.taskId,
          value: value as JsonObject, audit: structuredClone(audit),
          contentSubmissions: (spec.recovery?.contentSubmissions ?? 0) + submissions };
        for (let retry = 0; retry < 3; retry++) {
          try {
            const result = await request<{ inspection: InspectionCheckpoint; material: JsonObject; evidenceBank: EvidenceBank }>(
              `${spec.hostUrl}/api/inspections`, "POST", payload, signal);
            validateEvidenceBank(result.evidenceBank, audit.evidenceBank!);
            audit.evidenceBank!.splice(0, audit.evidenceBank!.length, ...result.evidenceBank);
            audit.inspection = structuredClone(result.inspection);
            failure = { evidenceBank: [...audit.evidenceBank!], errors: [], contentSubmissions: payload.contentSubmissions, fileErrors: (spec.recovery?.fileErrors ?? 0) + fileErrors,
              repeatedErrors: 0, stopped: false, attemptId: spec.attemptId, inspection: audit.inspection };
            record.failure = failure;
            await saveRecord();
            reserveFileDraft();
            // This is Host-prepared task context, so the model must receive the complete revealed material.
            return textResult({ accepted: true, material: result.material, budget: {
              content_remaining: Math.max(0, 1 + spec.policy.repairAttempts - submissions) } });
          } catch (error) {
            if (error instanceof HttpError && error.status < 500)
              return rejected(error.issues ?? [{ category: "decision", code: "inspection_rejected", path: "/", message: error.message }], value);
            if (signal.aborted || retry === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 100 * 2 ** retry));
          }
        }
        throw new Error("Host did not acknowledge material inspection");
      });
      const submitResult = (load: () => Promise<unknown>) => {
        // Inspection and final submissions reserve, load and validate under one attempt-local queue.
        return enqueueContent(() => submitExclusive(load));
      };
      const submit: ExecutableTool = {
        name: "submit_evaluation",
        inputSchema: spec.evaluation.outputSchema,
        execute: (_context, result) => submitResult(async () => result),
      };
      const submitFile: ExecutableTool = {
        name: "submit_evaluation_file",
        inputSchema: SUBMISSION_FILE_SCHEMA,
        execute: (_context, value) =>
          submitResult(() => loadFileContent(value)),
      };
      const submissionTools = spec.evaluation.fileSubmission ? [submitFile] : [submit];
      emit(attempt, "started", {
        engine: backend.identity,
        policy: spec.policy,
      });
      const modelTools: ToolDefinition[] = [...definitions, ...submissionTools].map((tool) => ({
        ...tool,
        description: spec.evaluation.toolDescriptions[tool.name] + (tool.name === "inspect_material" && spec.evaluation.fileSubmission && spec.evaluation.inspectionSchema
          ? "\n" + JSON.stringify({ file_content_schema: spec.evaluation.inspectionSchema }) :
          tool.name === "submit_evaluation_file" ? "\n" + JSON.stringify({ file_content_schema: spec.evaluation.outputSchema }) : ""),
      }));
      attempt.session = await backend.createSession({
        spec,
        workdir: runtime.context.workdir,
        tools: modelTools,
        async execute(name, args, signal) {
          activity();
          if (accepted) return runtime.withBudget({ ...textResult({ accepted: true }), terminate: true }, explorationLimit());
          if (controller.signal.aborted) throw controller.signal.reason;
          emit(attempt, "tool_start", { name, args });
          const submissionTool = submissionTools.find((tool) => tool.name === name) ??
            (name === "inspect_material" ? definitions.find(tool => tool.name === name) : undefined);
          let result;
          try {
            result = submissionTool
              ? await submissionTool.execute(runtime.context, args, controller.signal)
              : await runtime.execute(
                  name,
                  args,
                  signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
                  explorationLimit(),
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
          result = runtime.withBudget({ ...result, details: {
            ...(result.details && typeof result.details === "object" ? result.details : {}), next_tool: nextContentTool(),
          } }, explorationLimit());
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
              rawStopReason?: string;
              stopReasonRaw?: string;
              errorMessage?: string;
            };
          };
          if (event.type === "message_end" && event.message?.role === "assistant") {
            for (const key of Object.keys(usage) as (keyof Usage)[])
              usage[key] += event.message.usage?.[key] || 0;
            emit(attempt, "usage", usage);
            if (event.message.stopReason === "error") {
              modelError = event.message.errorMessage || "Model request failed";
              malformedCompletedResponse =
                (event.message.rawStopReason ?? event.message.stopReasonRaw) === "completed";
            }
            if (spec.policy.maxTokens && usage.totalTokens >= spec.policy.maxTokens) {
              controller.abort(new Error("Token budget reached at model boundary"));
              void attempt.session?.abort();
            }
          }
        },
      });
      controller.signal.throwIfAborted();
      const runModel = async (initialPrompt: string) => {
        let prompt = initialPrompt;
        while (!accepted && !controller.signal.aborted && attempt.status.state === "running") {
          modelError = undefined;
          malformedCompletedResponse = false;
          try { await attempt.session!.run(prompt); }
          catch (error) { if (modelError === undefined || modelError !== errorText(error)) throw error; }
          if (!modelError || accepted || controller.signal.aborted) return;
          // Only a real completed SDK assistant failure can enter argument repair.
          // Identity/stream/length errors remain distinct and no invalid JSON is dispatched.
          const match = /^Invalid OpenAI Responses tool arguments: ([A-Za-z_][A-Za-z0-9_.-]*) \([A-Za-z0-9_|.-]+\); (expected (?:complete )?JSON object)$/u.exec(modelError);
          const tool = spec.model.api === "openai-responses" && malformedCompletedResponse && match
            ? modelTools.find(tool => tool.name === match[1]) : undefined;
          if (!tool) return;
          const errors: ValidationIssue[] = [{ category: "structure", code: "tool_arguments_invalid", path: "/",
            message: match![2], actual: { tool: tool.name, argument_object_available: false } }];
          const content = submissionTools.some(item => item.name === tool.name) || tool.name === "inspect_material";
          emit(attempt, "tool_start", { name: tool.name, malformed_arguments: true, argument_object_available: false });
          if (content) {
            await enqueueContent(async () => {
              if (submissions >= 1 + spec.policy.repairAttempts) throw new Error("Submission repair budget exhausted");
              submissions++;
              runtime.clearDraftWrite();
              // Count and persist the failed call without manufacturing an object or a receipt.
              return rejected(errors, failure.draft, true, false);
            });
          } else {
            try {
              const { draftWrite } = runtime.chargeCall(tool.name, explorationLimit());
              if (draftWrite) runtime.reserveDraftWrite();
            }
            catch (error) {
              emit(attempt, "tool_end", { name: tool.name, malformed_arguments: true,
                result: runtime.withBudget({ ...textResult({ accepted: false, errors }), isError: true }, explorationLimit()) });
              throw new Error("Tool argument repair exploration budget exhausted", { cause: error });
            }
            await rejected(errors, failure.draft, false, false);
          }
          const nextTool = content ? nextContentTool() : tool.name;
          // Tool instructions are the profile's central prompt resources. The next phase
          // and remaining budgets are program-owned; a malformed call cannot reveal decisions.
          const feedback = { accepted: false, failed_tool: tool.name, next_tool: nextTool, errors,
            malformed_arguments: true, argument_object_available: false,
            instructions: spec.evaluation.toolDescriptions[nextTool],
            budget: { content_remaining: Math.max(0, 1 + spec.policy.repairAttempts - submissions),
              ...runtime.budget(explorationLimit()) } };
          emit(attempt, "tool_end", { name: tool.name, malformed_arguments: true,
            result: { ...textResult(feedback), isError: true } });
          if (content && submissions >= 1 + spec.policy.repairAttempts) {
            controller.abort(new Error("Submission repair budget exhausted"));
            void attempt.session?.abort();
            return;
          }
          prompt = JSON.stringify(feedback);
        }
      };
      await runModel(spec.prompt);
      if (
        !accepted &&
        (submissions === 0 || (audit.inspection && failure.draft === undefined && !record.pendingSubmission)) &&
        !modelError &&
        !controller.signal.aborted &&
        attempt.status.state === "running"
      )
        // A model that stopped before ever submitting still gets one bounded follow-up.
        await runModel(spec.evaluation.submissionNudge);
      if (accepted) attempt.status.state = "succeeded";
      else if (attempt.status.state === "running")
        throw new Error(modelError || "Agent ended without an accepted submission");
    } catch (error) {
      if (accepted) attempt.status.state = "succeeded";
      else if (attempt.status.state === "running") {
        attempt.status.state = "failed";
        const original = controller.signal.aborted ? controller.signal.reason : error;
        attempt.status.error = redact(
          errorText(original),
          [process.env[spec.model.apiKeyEnv] || ""],
        );
        attempt.status.errorDetail = redact(inspect(original, { depth: null, maxStringLength: null, maxArrayLength: null }),
          [process.env[spec.model.apiKeyEnv] || ""]);
        attempt.status.retryable =
          !controller.signal.aborted &&
          !attempt.status.error.startsWith("Invalid OpenAI Responses tool arguments:") &&
          (/fetch|network|connection|terminated|ECONN|429|overloaded|timeout|timed\s+out|Stream ended without finish_reason/i.test(
            attempt.status.error,
          ) || /\b(?:HTTP(?:\/\d+(?:\.\d+)?)?(?:\s+(?:error|status(?:\s+code)?))?|API\s+error)\s*[:(]?\s*5\d{2}\b/i.test(
            attempt.status.error,
          ));
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(idle!);
      controller.abort();
      if (!accepted) {
        const retryableInterruption = submissions === 0 && !record.failure &&
          (spec.recovery?.draft === undefined || spec.recovery.stopped) &&
          ((attempt.status.state === "failed" && attempt.status.error === "Agent ended without an accepted submission") ||
            (attempt.status.state === "timed_out" && attempt.status.error === "Model/tool idle timeout"));
        if (retryableInterruption) attempt.status.retryable = true;
        const recoveryDraft = spec.recovery?.stopped ? undefined : spec.recovery?.draft;
        record.failure ??= {
          evidenceBank: [...audit.evidenceBank!],
          ...(spec.recovery?.inspection ? { inspection: structuredClone(spec.recovery.inspection) } : {}),
          ...(recoveryDraft === undefined ? {} : { draft: recoveryDraft }),
          errors: [
            {
              category: attempt.status.retryable && !retryableInterruption ? "transport" : "interruption",
              code: attempt.status.retryable && !retryableInterruption ? "transport_failed" : "attempt_interrupted",
              path: "/",
              message: attempt.status.error || "No accepted submission",
            },
            ...(recoveryDraft === undefined ? [] : spec.recovery!.errors.filter(
              ({ category }) => category !== "transport" && category !== "interruption",
            )),
          ],
          contentSubmissions: (spec.recovery?.contentSubmissions || 0) + submissions,
          fileErrors: spec.recovery?.fileErrors || 0,
          repeatedErrors: 0,
          stopped: false,
          attemptId: spec.attemptId,
        };
        // A later complete submission may fail in transport without creating a new
        // validation failure; its cost still belongs in the cumulative ledger.
        record.failure.evidenceBank = [...audit.evidenceBank!];
        record.failure.contentSubmissions = (spec.recovery?.contentSubmissions || 0) + submissions;
        attempt.status.failure = record.failure;
      }
      record.evidenceBank = [...audit.evidenceBank!];
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
      record.evidenceBank = [...audit.evidenceBank!];
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
      if (!spec.evaluation || !Array.isArray(spec.evaluation.toolNames) || !spec.evaluation.outputSchema ||
        typeof spec.evaluation.fileSubmission !== "boolean" ||
        typeof spec.evaluation.submissionNudge !== "string" || !spec.evaluation.submissionNudge.trim())
        throw new HttpError(400, "Invalid evaluation spec");
      if (!Array.isArray(spec.inputs) || spec.inputs.some(ref => !ref || typeof ref.id !== "string" || typeof ref.name !== "string") ||
        new Set(spec.inputs.map(ref => ref.name)).size !== spec.inputs.length)
        throw new HttpError(400, "Invalid input refs");
      registry.select(spec.evaluation.toolNames);
      if (spec.evaluation.requiredReads !== undefined && (!Array.isArray(spec.evaluation.requiredReads) ||
        spec.evaluation.requiredReads.some(read => !read || read.kind !== "text" || typeof read.path !== "string" ||
          !spec.inputs.some(input => input.name === read.candidate) ||
          !Number.isSafeInteger(read.message_index) || read.message_index < 0 ||
          !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end <= read.start) ||
        (spec.evaluation.requiredReads.length > 0 && !spec.evaluation.toolNames.includes("read_trace"))))
        throw new HttpError(400, "Invalid required material ranges");
      const names = [...spec.evaluation.toolNames, ...submissionToolNames(spec.evaluation.fileSubmission)];
      const descriptions = spec.evaluation.toolDescriptions;
      if (!descriptions || typeof descriptions !== "object" || Array.isArray(descriptions) ||
        new Set(names).size !== names.length || Object.keys(descriptions).length !== names.length ||
        names.some((name) => typeof descriptions[name] !== "string" || !descriptions[name].trim()))
        throw new HttpError(400, "Invalid evaluation tool descriptions");
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
      spec.inputs.forEach((ref) => {
        safeId(ref.id);
        safeId(ref.name);
      });
      if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(spec.hostUrl))
        throw new HttpError(400, "Worker requires a loopback host URL");
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
        persistedEvents: 0,
        directory: attemptDir,
      };
      attempts.set(spec.attemptId, attempt);
      attempt.done = execute(attempt).catch((error) => {
        attempt.status = {
          state: "failed",
          lastSeq: attempt.events.length,
          error: redact(errorText(error), [process.env[spec.model.apiKeyEnv] || ""]),
          errorDetail: redact(inspect(error, { depth: null, maxStringLength: null, maxArrayLength: null }),
            [process.env[spec.model.apiKeyEnv] || ""]),
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
