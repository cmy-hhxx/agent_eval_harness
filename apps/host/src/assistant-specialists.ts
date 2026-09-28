import path from "node:path";
import { canonical, type AssistantScope, type SpecialistGateway, type SpecialistRequest, type SpecialistResult, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { assistantDirectory, assistantId, exists, readJson, runLock, writeJson, createRunRepository, hasLiveRunOwner } from "@eval/data";
import { runAgentTask, type SingleTaskOptions } from "@eval/host";
import { bindTask, locateAnalysisInput, readAnalysisInput, readRunTasks, comparisonCodec, encodeResult, type TaskData, type Candidate } from "@eval/workflows/comparison";
import type { HostConfig } from "./config.js";
import { createModelResolver } from "./config.js";
import { agents, logger, services } from "./composition.js";
import { runtimePaths } from "./paths.js";
import { LocalAnalysisData } from "./assistant-data.js";

/** Application composition is the only layer aware of concrete specialists. */
export class LocalSpecialists implements SpecialistGateway {
  constructor(readonly directory: string, readonly source: LocalAnalysisData, readonly config: HostConfig, readonly debug = false, private readonly execution?: Pick<SingleTaskOptions, "workerUrls" | "identity">) {}
  private operation(scope: AssistantScope, id: string) { return path.join(assistantDirectory(this.directory, scope), "operations", assistantId(id)); }
  private run(scope: AssistantScope, id: string) { return path.join(this.operation(scope, id), "execution", id); }
  async read(scope: AssistantScope, operationId: string): Promise<SpecialistResult> {
    const directory = this.operation(scope, operationId);
    if (!(await exists(path.join(directory, "request.json")))) throw new Error("当前会话没有这个 operationId。read_specialist 只读取本会话 call_specialist 创建的任务；已有评测运行的 taskId 请用 read_data({reference:{runId,taskId}})。");
    const request = await readJson<SpecialistRequest>(path.join(directory, "request.json"));
    if (await exists(path.join(this.run(scope, operationId), "state.json"))) {
      const state = await readRunTasks(this.run(scope, operationId), [operationId]);
      const receipt = state.receipts[operationId];
      if (receipt) return { operationId, kind: request.kind, state: "succeeded", evaluatorVersion: receipt.evaluatorVersion, result: receipt.exported?.row ?? receipt.evaluation, reference: { runId: operationId, taskId: operationId } };
      const task = state.manifest.states[operationId];
      const live = await hasLiveRunOwner(directory);
      return { operationId, kind: request.kind, state: task?.status === "running" && live ? "running" : task?.status === "cancelled" ? "cancelled" : "failed", evaluatorVersion: state.manifest.evaluatorVersion, error: task?.reason ?? (live ? undefined : "interrupted") };
    }
    const live = await hasLiveRunOwner(directory);
    return { operationId, kind: request.kind, state: live ? "running" : "failed", evaluatorVersion: this.config.evaluatorVersion, ...(live ? {} : { error: "interrupted" }) };
  }
  async invoke(scope: AssistantScope, request: SpecialistRequest, signal: AbortSignal, progress?: (value: unknown) => void): Promise<SpecialistResult> {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(request.operationId)) throw new Error("operationId must be a UUID");
    if (!request.inputs.length || (request.kind === "attribution" ? request.inputs.length !== 1 : request.inputs.length < 2 || request.inputs.length > 26)) throw new Error("Invalid specialist inputs");
    const directory = this.operation(scope, request.operationId), unlock = await runLock(directory);
    try {
      const file = path.join(directory, "request.json");
      if (await exists(file)) {
        if (canonical(await readJson(file)) !== canonical(request)) throw new Error("Operation ID already identifies a different request");
        const previous = await this.read(scope, request.operationId);
        if (previous.state === "succeeded") return previous;
      }
      const loaded = await Promise.all(request.inputs.map(async (reference) => {
        if (!reference.inputId) throw new Error("Specialists require inputId references");
        const locator = await locateAnalysisInput(this.source.run(reference.runId), reference.inputId);
        return { locator, raw: await readAnalysisInput(locator) };
      }));
      if (new Set(loaded.map(({ locator }) => locator.inputId)).size !== loaded.length) throw new Error("Duplicate comparison inputs");
      if (request.kind === "comparison" && new Set(loaded.map(({ locator }) => locator.candidate.version)).size !== loaded.length) throw new Error("Comparison requires distinct model versions");
      if (new Set(request.attributions?.map((item) => item.inputId)).size !== (request.attributions?.length ?? 0)) throw new Error("Duplicate attribution references");
      const first = loaded[0].locator.candidate;
      if (loaded.some(({ locator: { candidate } }) => candidate.case_id !== first.case_id || candidate.batch_id !== first.batch_id || canonical(candidate.reference) !== canonical(first.reference))) throw new Error("Comparison inputs must share case, batch and reference answer");
      const candidates: Record<string, Candidate> = {}, inputIds: Record<string, string> = {}, dependencies: Record<string, SubmissionReceipt> = {};
      const missing: unknown[] = [];
      for (let index = 0; index < loaded.length; index++) {
        const { locator } = loaded[index], label = String.fromCharCode(65 + index);
        candidates[label] = locator.candidate;
        inputIds[request.kind === "attribution" ? "answer" : label] = locator.inputId;
        if (request.kind === "attribution") continue;
        const reference = request.attributions?.find((ref) => ref.inputId === locator.inputId);
        if (!reference) { missing.push(request.inputs[index]); continue; }
        const run = reference.operationId ? this.run(scope, reference.operationId) : reference.runId ? this.source.run(reference.runId) : undefined;
        const taskId = reference.operationId ?? reference.taskId;
        if (!run || !taskId) throw new Error("Attribution result requires an operationId or runId/taskId");
        const accepted = await readRunTasks(run, [taskId]);
        const task = accepted.manifest.tasks.find((item) => item.id === taskId), receipt = accepted.receipts[taskId];
        if (!receipt || task?.stage !== "attribution" || !Object.values(task.inputIds).includes(locator.inputId)) throw new Error("Attribution reference is not an accepted result for this input");
        dependencies[label] = receipt;
      }
      if (missing.length) {
        return { operationId: request.operationId, kind: request.kind, state: "failed", evaluatorVersion: this.config.evaluatorVersion, error: "missingAttributions", result: { missingAttributions: missing } };
      }
      const data: TaskData = { stage: request.kind, candidates, reference: first.reference, initialContextChars: this.config.evaluation.execution.initialContextChars,
        ...(request.kind === "comparison" ? { group: loaded.map((item) => item.locator.candidate.version), comparisonId: request.operationId } : {}) };
      const task: PlannedTask = { id: request.operationId, stage: request.kind, inputIds, dependencies: Object.fromEntries(Object.entries(dependencies).map(([label, receipt]) => [label, receipt.taskId])), data };
      const inputs = Object.fromEntries(loaded.map(({ locator, raw }) => [locator.inputId, raw]));
      const binding = bindTask(task, inputs, dependencies);
      // Dependencies are resolved before admission; no batch workflow is scheduled.
      await writeJson(file, request);
      const admitted = { ...task, dependencies: {} };
      const repository = createRunRepository(comparisonCodec, (_task, state, input) => encodeResult(task, { ...state, receipts: { ...Object.fromEntries(Object.values(dependencies).map((receipt) => [receipt.taskId, receipt])), ...state.receipts } }, input));
      const sourceConfig = loaded[0].locator.config;
      await runAgentTask({ task: admitted, binding, catalog: loaded.map((entry) => entry.locator.candidate), runId: request.operationId, ...this.execution,
        output: { kind: "directory", path: path.join(directory, "execution") }, engine: "pi", evaluatorVersion: this.config.evaluatorVersion,
        config: sourceConfig, agents, repository, logger, snapshots: services.snapshots, runtime: runtimePaths,
        policy: this.config.evaluation.execution, modelForStage: createModelResolver(this.config.models), retries: this.config.evaluation.execution.retries,
        retryDelaySeconds: this.config.evaluation.execution.retryDelaySeconds, debug: this.debug, signal,
        onProgress: (message) => progress?.({ operationId: request.operationId, message }), onEvent: (event) => progress?.({ operationId: request.operationId, event }),
      });
      return this.read(scope, request.operationId);
    } finally { await unlock(); }
  }
}
