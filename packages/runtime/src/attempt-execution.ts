import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  emptyUsage,
  presentSource,
  SUBMISSION_FILE_SCHEMA,
  SUBMISSION_JSON_SCHEMA,
  validationRequiredReads,
  type AgentBackend,
  type AgentSession,
  type AttemptSpec,
  type AttemptRecord,
  type AttemptStatus,
  type Submission,
  type SubmissionReceipt,
  type ToolAudit,
  type TraceRead,
  type ToolDefinition,
  type Usage,
  type FailureContext,
  type InspectionCheckpoint,
  type JsonObject,
  type ValidationIssue,
} from "@eval/contracts";
import { ArtifactStore, exists, writeJson } from "@eval/data";
import { HttpError, ValidationError, canonical, errorText, evidenceSources, redact, safeId, validateEvidenceBank, type EvidenceBank } from "@eval/contracts";
import { request } from "./http.js";
import { textResult, ToolRuntime, traceReadCoverage, type ToolRegistry, type ExecutableTool } from "@eval/tools";
import { contentToolName, modelEventForLog, isModelQuotaExhausted } from "./sdk-utils.js";
import { decodeJsonSubmission } from "./attempt-json.js";
import type { AttemptEventLog } from "./attempt-events.js";
import { createContentQueue, invalidSubmissionFile, loadSubmissionFile } from "./attempt-submission.js";

export interface AttemptExecution {
  spec: AttemptSpec;
  status: AttemptStatus;
  controller: AbortController;
  session?: AgentSession;
  events: AttemptEventLog;
  directory: string;
  settled?: boolean;
}

export interface AttemptExecutionDeps {
  backend: AgentBackend;
  registry: ToolRegistry;
  execution?: { python: string };
  stop(attempt: AttemptExecution, state: "cancelled" | "timed_out", reason: string): Promise<void>;
  onSettled(attemptId: string): void;
}

export async function executeAttempt(attempt: AttemptExecution, deps: AttemptExecutionDeps): Promise<void> {
  const { backend, registry, execution, stop } = deps;
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
    const timings = { inputIoMs: 0, modelMs: 0, toolMs: 0, submissionMs: 0, requiredReadMs: 0 };
    let modelStarted: number | undefined;
    const saveRecord = () => writeJson(path.join(attempt.directory, "attempt.json"), record);
    let accepted: SubmissionReceipt | undefined,
      submissions = 0,
      jsonRepairs = 0,
      modelError: string | undefined,
      malformedCompletedResponse = false;
    let deadlineAt = spec.deadline, deadline: NodeJS.Timeout | undefined;
    const armDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => { void stop(attempt, "timed_out", "Task deadline exceeded"); },
        Math.max(1, deadlineAt - Date.now()));
    };
    armDeadline();
    let idle: NodeJS.Timeout, pendingSubmissions = 0;
    const activity = () => {
      clearTimeout(idle);
      if (pendingSubmissions) return;
      idle = setTimeout(() => {
        void stop(attempt, "timed_out", "Model/tool idle timeout");
      }, spec.policy.idleTimeoutSeconds * 1000);
    };
    // Fetching material from Host is preparation, not an idle model. The total
    // deadline remains armed even while Host is busy preparing another task.
    try {
      await saveRecord();
      await mkdir(path.join(attempt.directory, "workspace/inputs"), {
        recursive: true,
      });
      const inputs = new Map<string, unknown>();
      const inputStarted = performance.now();
      for (const ref of spec.inputs) {
        const value = await request<unknown>(
          `${spec.hostUrl}/api/inputs/${safeId(ref.id)}?attempt=${safeId(spec.attemptId)}`,
          "GET",
          undefined,
          controller.signal,
        );
        inputs.set(ref.name, value);
        const presentation = spec.evaluation.sourcePresentations?.[ref.name];
        await writeJson(path.join(attempt.directory, "workspace/inputs", `${safeId(ref.name)}.json`),
          presentation ? presentSource(value, presentation) : value);
      }
      timings.inputIoMs = performance.now() - inputStarted;
      activity();
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
          materialNavigation: spec.evaluation.materialNavigation,
          audit,
          policy: spec.policy,
          requiredReads: spec.evaluation.requiredReads,
          presentedReads: spec.evaluation.presentedReads,
          draftWriteInCallLimit: spec.evaluation.fileSubmission && spec.evaluation.draftWriteInCallLimit,
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
      if (failure.review) audit.review = structuredClone(failure.review);
      runtime.context.persistEvidenceBank = async bank => {
        // The tool's reference-bearing operations share one queue. Save a directory before exposing any new choice.
        const previous = failure.evidenceBank ?? [];
        validateEvidenceBank(bank, previous);
        const append = bank.length >= previous.length && previous.every((id, index) => bank[index] === id)
          ? bank.slice(previous.length) : undefined;
        for (let retry = 0; retry < 3; retry++) {
          try {
            const saved = await request<{ evidenceBank: EvidenceBank }>(`${spec.hostUrl}/api/evidence-bank`, "POST",
              append ? { taskId: spec.taskId, attemptId: spec.attemptId, append } : { taskId: spec.taskId, attemptId: spec.attemptId, evidenceBank: bank },
              controller.signal);
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
      const rejected = async (errors: ValidationIssue[], draft = failure.draft, content = true, compareDraft = true, loadingError = false) => {
        const repeatedErrors = !compareDraft ? 0 :
          content && errorSet(errors) === errorSet(failure.errors) && canonical(draft) === canonical(failure.draft)
            ? failure.repeatedErrors + 1
            : 1;
        failure = {
          evidenceBank: [...audit.evidenceBank!],
          ...(failure.inspection ? { inspection: failure.inspection } : {}),
          ...(audit.review ? { review: audit.review } : {}),
          draft: structuredClone(draft),
          errors,
          contentSubmissions: (spec.recovery?.contentSubmissions || 0) + submissions,
          fileErrors: (spec.recovery?.fileErrors || 0) + fileErrors,
          repeatedErrors,
          // Repeated drafts remain diagnostic. The shared content cap owns repair
          // termination; stopping after two identical drafts discards valid repairs.
          // Historical loading failures do not consume the independent content repairs.
          stopped: loadingError && (spec.recovery?.fileErrors || 0) + fileErrors >= 3,
          attemptId: spec.attemptId,
        };
        if (audit.review) failure.review = audit.review;
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
          controller.abort(new Error("Submission loading budget exhausted: " + errors.map((e) => e.message).join("; ")));
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
              file_errors_remaining: Math.max(0, 3 - (spec.recovery?.fileErrors || 0) - fileErrors),
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
      const materialSources = new Map<string, ReturnType<typeof evidenceSources>>();
      const investigationReads = validationRequiredReads;
      const supplyRequiredMaterial = async (dynamic:TraceRead[] = []) => {
        runtime.registerRequiredReads(dynamic);
        const content: ReturnType<typeof textResult>["content"] = [];
        const read_requests: {candidate:string;message_index:number;path:string;offset:number;max_chars:number}[] = [];
        let used = 0;
        reading: for (const target of [...spec.evaluation.requiredReads ?? [],...dynamic]) {
          for (;;) {
            const missing = traceReadCoverage(audit, target).missing[0];
            if (!missing) break;
            const key = `${target.candidate}:${target.message_index}`;
            if (!materialSources.has(key)) materialSources.set(key,
              evidenceSources((inputs.get(target.candidate) as {messages:unknown[]}).messages[target.message_index]));
            const source = materialSources.get(key)!.find(source => source.kind === target.kind && source.path === target.path);
            if (!source) throw new Error("Required material source is unavailable");
            // Count real escaped text, reserving navigation and budget space.
            // A page larger than the remaining response is delivered on its own.
            const estimate = JSON.stringify(source.text.slice(missing.start,Math.min(target.end,missing.start+16000))).length + 4096;
            if (content.length && used + estimate > spec.policy.maxOutputChars - 2048) break reading;
            const args = { candidate: target.candidate, message_index: target.message_index, path: target.path,
              offset: missing.start, max_chars: Math.min(16000, target.end - missing.start) };
            attempt.events.append("tool_start", { name: "read_trace", args, required_material: true });
            const readStarted = performance.now();
            const read = await runtime.execute("read_trace", args, controller.signal, explorationLimit());
            timings.requiredReadMs += performance.now() - readStarted;
            attempt.events.append("tool_end", { name: "read_trace", result: read, required_material: true });
            if (read.isError) {
              const message=read.content.map(item => item.text ?? "").join("\n");
              controller.abort(new Error(message));void attempt.session?.abort();throw new Error(message);
            }
            if (traceReadCoverage(audit, target).missing[0]?.start === missing.start)
              throw new Error("Required material read made no progress");
            const { budget: _budget, ...page } = read.details as Record<string, unknown>;
            const pageContent = textResult(page).content;
            content.push(...pageContent);
            read_requests.push(args);
            used += pageContent.reduce((total,item)=>total+(item.text?.length??0),0);
          }
        }
        if (!content.length) return undefined;
        reserveFileDraft();
        // Deliver every recorded page before judging the draft or charging a verdict.
        const feedback = textResult({ accepted: false, material_pending: true,
          ...(dynamic.length?{draft_preserved:true,errors:failure.errors}:{}),
          next_tool: nextContentTool(), read_requests, instructions: spec.evaluation.toolDescriptions.read_trace,
          budget: { content_remaining: Math.max(0, 1 + spec.policy.repairAttempts - submissions) },
        });
        return { ...feedback, content: [...feedback.content, ...content] };
      };
      // Inspection and final submission use the same protected, progress-checked repair path.
      const supplyRejectedMaterial = async (errors: ValidationIssue[], draft: unknown, contentCharged = true) => {
        const reads = investigationReads(errors);
        if (!errors.length || !errors.every(issue => issue.code === "investigation_read_required") || !reads.length) return undefined;
        if (contentCharged) submissions--;
        await rejected(errors, draft, false, false);
        const material = await supplyRequiredMaterial(reads);
        if (material) return material;
        const message = "调查补读后同一缺口无进展：原文已被实际读取，但校验仍要求相同坐标，停止循环重提。";
        const feedback = await rejected([{ category: "evidence", code: "investigation_read_no_progress", path: "/", message,
          expected: { read_requests: reads } }], draft, false, false);
        controller.abort(new Error(message)); void attempt.session?.abort(); return feedback;
      };
      const rejectedLoad = async (errors: ValidationIssue[]) => {
        fileErrors++;
        const feedback = await rejected(errors, failure.draft, false, false, true);
        if (!failure.stopped) reserveFileDraft();
        return feedback;
      };
      const submitExclusive = async (load: () => Promise<unknown>, jsonText = false) => {
        if (accepted)
          return {
            ...textResult({
              accepted: true,
              submissionId: accepted.submissionId,
            }),
            terminate: true,
          };
        controller.signal.throwIfAborted();
        const material = await supplyRequiredMaterial(investigationReads(failure.errors));
        if (material) return material;
        if (submissions >= 1 + spec.policy.repairAttempts) throw new Error("提交修正次数已耗尽");
        let result: unknown;
        try {
          result = await load();
        } catch (error) {
          if (jsonText) {
            return rejectedLoad(error instanceof ValidationError ? error.issues! : [{category:"structure",code:"submission_json_invalid",path:"/json",
              message:"json 必须是完整 JSON 对象的文本，不接受 XML、Markdown、数组或标量："+errorText(error)}]);
          }
          return rejectedFile(error);
        }
        submissions++;
        runtime.clearDraftWrite();
        const emitLoaded = () => attempt.events.append("submission", { accepted: false, content_loaded: true, evaluation: result,
          contentSubmissions: (spec.recovery?.contentSubmissions || 0) + submissions,
          ...(jsonRepairs ? { jsonRepairs } : {}) });
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
            ...(jsonRepairs ? { jsonRepairs } : {}),
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
            if (error instanceof HttpError && error.status < 500) {
              // A definitive rejection is no longer an unacknowledged submission.
              delete record.pendingSubmission;
              const errors = error.issues || [
                  {
                    category: "structure",
                    code: "submission_rejected",
                    path: "/",
                    actual: error.status,
                    message: error.message,
                  },
                ];
              if(errors.some(e=>['responsibility_unresolved','submission_unfinished'].includes(e.code))){
                const response=await rejected(errors,result,false,false);
                failure.stopped=true;record.failure=failure;await saveRecord();
                controller.abort(new Error(errors.map(e=>e.message).join('; ')));void attempt.session?.abort();return response;
              }
              const material = await supplyRejectedMaterial(errors, result, true);
              if (material) return material;
              emitLoaded();
              return rejected(errors,result);
            }
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
        emitLoaded();
        await writeJson(path.join(attempt.directory, "receipt.json"), accepted);
        delete record.pendingSubmission;
        attempt.events.append("submission", {
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
      const enqueueContent = createContentQueue();
      const validateFile = ajv.compile(SUBMISSION_FILE_SCHEMA);
      const loadFileContent = (args: unknown) =>
        loadSubmissionFile(args, runtime.context.workdir, validateFile);
      const rejectedFile = (error: unknown) => rejectedLoad(invalidSubmissionFile(error));
      runtime.context.inspectMaterial = (args, signal) => enqueueContent(async () => {
        signal.throwIfAborted();
        if (!spec.evaluation.inspectionSchema) throw new Error("当前任务未配置材料核查");
        const material = await supplyRequiredMaterial(investigationReads(failure.errors));
        if (material) return material;
        if (submissions >= 1 + spec.policy.repairAttempts) throw new Error("提交修正次数已耗尽");
        let value: unknown = args;
        if (spec.evaluation.fileSubmission) {
          try { value = await loadFileContent(args); }
          catch (error) { return rejectedFile(error); }
        }
        submissions++;
        runtime.clearDraftWrite();
        attempt.events.append("submission", { accepted: false, content_loaded: true, inspection: true, evaluation: value,
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
            if (audit.review) failure.review = audit.review;
        record.failure = failure;
            await saveRecord();
            reserveFileDraft();
            // This is Host-prepared task context, so the model must receive the complete revealed material.
            return textResult({ accepted: true, material: result.material, budget: {
              content_remaining: Math.max(0, 1 + spec.policy.repairAttempts - submissions) } });
          } catch (error) {
            if (error instanceof HttpError && error.status < 500) {
              const errors = error.issues ?? [{ category: "decision" as const, code: "inspection_rejected", path: "/", message: error.message }];
              const material = await supplyRejectedMaterial(errors, value);
              if (material) return material;
              return rejected(errors, value);
            }
            if (signal.aborted || retry === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 100 * 2 ** retry));
          }
        }
        throw new Error("Host did not acknowledge material inspection");
      });
      const submitResult = (load: () => Promise<unknown>, jsonText = false) => {
        // Inspection and final submissions reserve, load and validate under one attempt-local queue.
        return enqueueContent(() => submitExclusive(load, jsonText));
      };
      const validateJsonEnvelope = ajv.compile(SUBMISSION_JSON_SCHEMA);
      const submit: ExecutableTool = {
        name: "submit_evaluation",
        inputSchema: spec.evaluation.jsonStringSubmission ? SUBMISSION_JSON_SCHEMA : spec.evaluation.outputSchema,
        execute: (_context, result) => submitResult(async () => {
          if (!spec.evaluation.jsonStringSubmission) return result;
          const decoded = decodeJsonSubmission(result, validateJsonEnvelope);
          jsonRepairs += decoded.repairs;
          return decoded.value;
        },Boolean(spec.evaluation.jsonStringSubmission)),
      };
      const submitFile: ExecutableTool = {
        name: "submit_evaluation_file",
        inputSchema: SUBMISSION_FILE_SCHEMA,
        execute: (_context, value) =>
          submitResult(() => loadFileContent(value)),
      };
      const submissionTools = spec.evaluation.fileSubmission ? [submitFile] : [submit];
      attempt.events.append("started", {
        engine: backend.identity,
        policy: spec.policy,
      });
      const modelTools: ToolDefinition[] = [...definitions, ...submissionTools].map((tool) => ({
        ...tool,
        description: spec.evaluation.toolDescriptions[tool.name] + (tool.name === "inspect_material" && spec.evaluation.fileSubmission && spec.evaluation.inspectionSchema
          ? "\n" + JSON.stringify({ file_content_schema: spec.evaluation.inspectionSchema }) :
          tool.name === "submit_evaluation_file" ? "\n" + JSON.stringify({ file_content_schema: spec.evaluation.outputSchema }) :
          tool.name === "submit_evaluation" && spec.evaluation.jsonStringSubmission
            ? "\n"+JSON.stringify({json_content_schema:spec.evaluation.outputSchema}) : ""),
      }));
      const createSession = (sessionSpec:AttemptSpec) => backend.createSession({
        spec:sessionSpec,
        workdir: runtime.context.workdir,
        tools: modelTools.filter(tool=>submissionTools.some(s=>s.name===tool.name)||sessionSpec.evaluation.toolNames.includes(tool.name)),
        ...(spec.controlModelRequests ? { modelRequest: async (signal?: AbortSignal) => {
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          const callId = randomUUID(), waitingAt = Date.now();
          clearTimeout(idle); clearTimeout(deadline);
          try {
            await request(`${spec.hostUrl}/api/model-requests/${spec.attemptId}/${callId}`, "POST", {}, combined);
          } catch (error) {
            // Fail closed: a missing permit must never fall through to the provider.
            controller.abort(error);
            throw error;
          } finally {
            deadlineAt += Date.now() - waitingAt;
            if (!controller.signal.aborted) { armDeadline(); activity(); }
          }
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            try {
              // A busy Host may acknowledge after serializing its checkpoint. A short
              // control timeout must not discard a successfully completed model turn.
              await request(`${spec.hostUrl}/api/model-requests/${spec.attemptId}/${callId}`, "DELETE", undefined, AbortSignal.timeout(60_000));
            } catch (error) {
              await stop(attempt, "cancelled", "LLM permit release failed: " + errorText(error));
              throw error;
            }
          };
        } } : {}),
        async execute(name, args, signal) {
          activity();
          if (accepted) return runtime.withBudget({ ...textResult({ accepted: true }), terminate: true }, explorationLimit());
          if (controller.signal.aborted) throw controller.signal.reason;
          attempt.events.append("tool_start", { name, args });
          const toolStarted = performance.now();
          const submissionTool = submissionTools.find((tool) => tool.name === name) ??
            (name === "inspect_material" ? definitions.find(tool => tool.name === name) : undefined);
          // Host validation/commit queues are active work. Keep the overall
          // deadline while excluding these waits from model inactivity.
          if (submissionTool) { pendingSubmissions++; activity(); }
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
            if (spec.evaluation.fileSubmission && name === "edit_json" && !result.isError) {
              // Keep the last successfully written draft before workspace cleanup.
              // Writing is not submission: the resumed model must still submit it
              // through the ordinary validation path and content budget.
              const draft = await loadFileContent({ path: (args as { path: string }).path });
              record.failure = { ...failure, draft };
              await saveRecord();
            }
          } catch (error) {
            result = {
              content: [{ type: "text" as const, text: errorText(error) }],
              isError: true,
            };
          } finally {
            timings[submissionTool ? "submissionMs" : "toolMs"] += performance.now() - toolStarted;
            if (submissionTool) pendingSubmissions--;
          }
          if (submissionTool && !accepted && submissions >= 1 + spec.policy.repairAttempts) {
            controller.abort(new Error("Submission repair budget exhausted"));
            void attempt.session?.abort();
          }
          result = runtime.withBudget({ ...result, details: {
            ...(result.details && typeof result.details === "object" ? result.details : {}), next_tool: nextContentTool(),
          } }, explorationLimit());
          attempt.events.append("tool_end", { name, result });
          activity();
          return result;
        },
        onEvent(value) {
          activity();
          attempt.events.append("model", modelEventForLog(value));
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
          if (event.type === "message_start" && event.message?.role === "assistant") modelStarted = performance.now();
          if (event.type === "message_end" && event.message?.role === "assistant") {
            if (modelStarted !== undefined) { timings.modelMs += performance.now() - modelStarted; modelStarted = undefined; }
            for (const key of Object.keys(usage) as (keyof Usage)[])
              usage[key] += event.message.usage?.[key] || 0;
            attempt.events.append("usage", usage);
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
      attempt.session=await createSession(spec);
      controller.signal.throwIfAborted();
      const runModel = async (initialPrompt: string) => {
        let prompt = initialPrompt;
        while (!accepted && !controller.signal.aborted && attempt.status.state === "running") {
          modelError = undefined;
          malformedCompletedResponse = false;
          try { await attempt.session!.run(prompt); }
          catch (error) { if (accepted)return; if (modelError === undefined || modelError !== errorText(error)) throw error; }
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
          attempt.events.append("tool_start", { name: tool.name, malformed_arguments: true, argument_object_available: false });
          if (content) {
            await enqueueContent(async () => {
              if (submissions >= 1 + spec.policy.repairAttempts) throw new Error("Submission repair budget exhausted");
              // Count and persist the failed call without manufacturing an object or a receipt.
              return rejectedLoad(errors);
            });
          } else {
            try {
              const { draftWrite } = runtime.chargeCall(tool.name, explorationLimit());
              if (draftWrite) runtime.reserveDraftWrite();
            }
            catch (error) {
              attempt.events.append("tool_end", { name: tool.name, malformed_arguments: true,
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
              file_errors_remaining: Math.max(0, 3 - (spec.recovery?.fileErrors || 0) - fileErrors),
              ...runtime.budget(explorationLimit()) } };
          attempt.events.append("tool_end", { name: tool.name, malformed_arguments: true,
            result: { ...textResult(feedback), isError: true } });
          if (controller.signal.aborted) return;
          prompt = JSON.stringify(feedback);
        }
      };
      await runModel(spec.prompt);
      if (
        !accepted &&
        submissions < 1 + spec.policy.repairAttempts &&
        !failure.stopped && !record.pendingSubmission &&
        !modelError &&
        !controller.signal.aborted &&
        attempt.status.state === "running"
      )
        // Keep a repairable rejection in the same session; a restart loses the already-read material.
        // Exactly one follow-up, with the original content/tool budgets, also bounds a silent model.
        await runModel(spec.evaluation.submissionNudge + (failure.errors.length ? "\n" + JSON.stringify({
          errors: failure.errors, next_tool: nextContentTool(),
          budget: { content_remaining: Math.max(0, 1 + spec.policy.repairAttempts - submissions),
            file_errors_remaining: Math.max(0, 3 - (spec.recovery?.fileErrors || 0) - fileErrors), ...runtime.budget(explorationLimit()) },
        }) : ""));
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
        attempt.status.modelQuotaExhausted = !controller.signal.aborted && modelError === errorText(original) &&
          isModelQuotaExhausted(modelError);
        attempt.status.retryable =
          !controller.signal.aborted &&
          !attempt.status.modelQuotaExhausted &&
          !attempt.status.error.startsWith("Invalid OpenAI Responses tool arguments:") &&
          // Some SDK failures omit the HTTP status. Recognize provider failures only
          // at the assistant error boundary, not in ordinary tool/validation text.
          (modelError === attempt.status.error && [
            "The server had an error processing your request.", "server_error:", "Error Code server_error:",
          ].some(prefix => modelError!.startsWith(prefix)) || modelError === attempt.status.error &&
            /^(?:litellm\.APIError:\s*)?Responses API stream ended before response\.completed or response\.incomplete/i.test(modelError) ||
            /fetch|network|connection|terminated|ECONN|429|overloaded|timeout|timed\s+out|Stream ended without finish_reason/i.test(
            attempt.status.error,
          ) || /\b(?:HTTP(?:\/\d+(?:\.\d+)?)?(?:\s+(?:error|status(?:\s+code)?))?|API\s+error)\s*[:(]?\s*5\d{2}\b/i.test(
            attempt.status.error,
          ));
      }
    } finally {
      if (modelStarted !== undefined) timings.modelMs += performance.now() - modelStarted;
      clearTimeout(deadline);
      clearTimeout(idle!);
      controller.abort();
      if (!accepted) {
        const recovery = record.failure ?? spec.recovery;
        // Saving an unsubmitted draft is not a validation failure. Keep interruption
        // retries available across attempts, while real rejections retain their budget.
        const retryableInterruption = submissions === 0 && (!recovery || recovery.stopped ||
          recovery.errors.every(({ category }) => category === "transport" || category === "interruption")) &&
          ((attempt.status.state === "failed" && attempt.status.error === "Agent ended without an accepted submission") ||
            (attempt.status.state === "timed_out" && attempt.status.error === "Model/tool idle timeout"));
        if (retryableInterruption) attempt.status.retryable = true;
        const recoveryDraft = recovery?.stopped ? undefined : recovery?.draft;
        if (!record.failure?.errors.length) record.failure = {
          evidenceBank: [...audit.evidenceBank!],
          ...(recovery?.inspection ? { inspection: structuredClone(recovery.inspection) } : {}),
          ...(recoveryDraft === undefined ? {} : { draft: recoveryDraft }),
          errors: [
            {
              category: attempt.status.retryable && !retryableInterruption ? "transport" : "interruption",
              code: attempt.status.retryable && !retryableInterruption ? "transport_failed" : "attempt_interrupted",
              path: "/",
              message: attempt.status.error || "No accepted submission",
            },
            ...(recoveryDraft === undefined ? [] : recovery!.errors.filter(
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
        if (audit.review) record.failure.review = structuredClone(audit.review);
        record.failure.evidenceBank = [...audit.evidenceBank!];
        record.failure.contentSubmissions = (spec.recovery?.contentSubmissions || 0) + submissions;
        attempt.status.failure = record.failure;
      }
      record.evidenceBank = [...audit.evidenceBank!];
      record.metrics = { usage, audit, timings };
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
      attempt.events.append("finished", attempt.status);
      await attempt.events.flush();
      record.evidenceBank = [...audit.evidenceBank!];
      record.metrics = { usage, audit, timings };
      record.status = attempt.status;
      await saveRecord();
      await attempt.events.end();
      attempt.settled = true;
      deps.onSettled(spec.attemptId);
}
}
