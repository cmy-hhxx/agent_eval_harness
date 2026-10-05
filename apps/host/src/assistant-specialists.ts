import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, ValidationError, type AssistantScope, type SpecialistGateway, type SpecialistRequest, type SpecialistResult, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { assistantDirectory, assistantId, exists, readJson, runLock, writeJson, createRunRepository, hasLiveRunOwner } from "@eval/data";
import { runEvaluation, type RunOptions } from "@eval/host";
import { bindTask, locateAnalysisInput, readAnalysisInput, readRunTasks, comparisonCodec, comparisonWorkflow, encodeResult, type TaskData, type Candidate } from "@eval/workflows/comparison";
import type { HostConfig } from "./config.js";
import { createModelResolver } from "./config.js";
import { agents, logger, services } from "./composition.js";
import { runtimePaths } from "./paths.js";
import { LocalAnalysisData } from "./assistant-data.js";

/** Application composition is the only layer aware of concrete specialists. */
export class LocalSpecialists implements SpecialistGateway {
  constructor(readonly directory: string, readonly source: LocalAnalysisData, readonly config: HostConfig, readonly debug = false, private readonly execution?: Pick<RunOptions, "workerUrls" | "identity">) {}
  private operation(scope: AssistantScope, id: string) { return path.join(assistantDirectory(this.directory, scope), "operations", assistantId(id)); }
  private run(scope: AssistantScope, id: string) { return path.join(this.operation(scope, id), "execution", id); }

  async read(scope: AssistantScope, operationId: string): Promise<SpecialistResult> {
    const directory = this.operation(scope, operationId);
    if (!(await exists(path.join(directory, "request.json")))) throw new Error("当前会话没有这个 operationId。read_specialist 只读取本会话 call_specialist 创建的任务；已有评测运行的 taskId 请用 read_data({reference:{runId,taskId}})。");
    const request = await readJson<SpecialistRequest>(path.join(directory, "request.json"));
    const live = await hasLiveRunOwner(directory);
    const base = { operationId, kind: request.kind, evaluatorVersion: this.config.evaluatorVersion };
    const run = this.run(scope, operationId);
    if (!(await exists(path.join(run, "state.json")))) return { ...base, state: live ? "running" : "failed", ...(live ? {} : { error: "interrupted" }) };
    const metadata = await readRunTasks(run, []);
    const finalTasks = metadata.manifest.tasks.filter((task) => task.stage === request.kind &&
      (request.kind === "comparison" ? !(task.data as TaskData).supersededBy : task.id === operationId));
    const expected = request.kind === "comparison" ? request.inputs.length * (request.inputs.length - 1) / 2 : 1;
    const state = await readRunTasks(run, finalTasks.map((task) => task.id));
    const receipts = finalTasks.map((task) => state.receipts[task.id]);
    if (finalTasks.length === expected && receipts.every(Boolean)) {
      if (request.kind === "comparison" && receipts.some((receipt) => (receipt.evaluation as { status: string }).status !== "decided"))
        return { ...base, evaluatorVersion: state.manifest.evaluatorVersion, state: "failed", error: "independentReviewUnresolved" };
      const results = finalTasks.map((task, index) => {
        const receipt = receipts[index]!;
        return { reference: { runId: operationId, taskId: task.id }, evaluatorVersion: receipt.evaluatorVersion,
          result: receipt.exported?.row ?? receipt.evaluation };
      });
      if (results.length === 1) return { ...base, ...results[0], state: "succeeded" };
      return { ...base, evaluatorVersion: state.manifest.evaluatorVersion, state: "succeeded", result: { comparisons: results } };
    }
    const states = Object.values(state.manifest.states);
    const failed = states.find((task) => ["failed", "blocked", "timed_out"].includes(task.status));
    return { ...base, evaluatorVersion: state.manifest.evaluatorVersion,
      state: live && !failed ? "running" : states.some((task) => task.status === "cancelled") ? "cancelled" : "failed",
      error: failed?.reason ?? (live ? undefined : "interrupted") };
  }

  async invoke(scope: AssistantScope, request: SpecialistRequest, signal: AbortSignal, progress?: (value: unknown) => void): Promise<SpecialistResult> {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(request.operationId)) throw new Error("operationId must be a UUID");
    if (!request.inputs.length || (request.kind === "attribution" ? request.inputs.length !== 1 : request.inputs.length < 2 || request.inputs.length > 3)) throw new Error("Invalid specialist inputs");
    if (request.kind === "attribution" && request.attributions !== undefined) throw new Error("Attribution does not accept attribution references");
    const directory = this.operation(scope, request.operationId), unlock = await runLock(directory);
    try {
      const file = path.join(directory, "request.json");
      if (await exists(file)) {
        if (canonical(await readJson(file)) !== canonical(request)) throw new Error("Operation ID already identifies a different request");
        const previous = await this.read(scope, request.operationId);
        if (previous.state === "succeeded") return previous;
      } else await writeJson(file, request);
      const loaded = await Promise.all(request.inputs.map(async (reference) => {
        if (!reference.inputId || reference.taskId || reference.messageIndex !== undefined) throw new Error("Specialists require runId/inputId references");
        const locator = await locateAnalysisInput(this.source.run(reference.runId), reference.inputId);
        return { locator, raw: await readAnalysisInput(locator) };
      }));
      if (new Set(loaded.map(({ locator }) => locator.inputId)).size !== loaded.length) throw new Error("Duplicate comparison inputs");
      if (request.kind === "comparison" && new Set(loaded.map(({ locator }) => locator.candidate.version)).size !== loaded.length) throw new Error("Comparison requires distinct model versions");
      if (request.kind === "comparison") {
        const tiers = loaded.map(({ locator }) => locator.config.inputs.versions.find((version) => version.id === locator.candidate.version)?.comparison_tier);
        if (tiers.some((tier) => !tier) || new Set(tiers).size !== 1)
          throw new Error("Comparison inputs must declare the same comparison_tier");
      }
      if (new Set(request.attributions?.map((item) => item.inputId)).size !== (request.attributions?.length ?? 0)) throw new Error("Duplicate attribution references");
      const first = loaded[0].locator.candidate;
      if (loaded.some(({ locator: { candidate } }) => candidate.case_id !== first.case_id || candidate.batch_id !== first.batch_id ||
        canonical(candidate.reference) !== canonical(first.reference) || canonical(candidate.question) !== canonical(first.question)))
        throw new Error("Comparison inputs must share question, case, batch and reference answer");
      const candidates: Record<string, Candidate> = Object.fromEntries(loaded.map(({ locator }, index) => [String.fromCharCode(65 + index), locator.candidate]));
      const inputs = Object.fromEntries(loaded.map(({ locator, raw }) => [locator.inputId, raw]));
      const retained = new Map<string, { receipt: SubmissionReceipt; task: PlannedTask; tasks: PlannedTask[] }>();
      for (const reference of request.attributions ?? []) {
        if (!Object.hasOwn(inputs, reference.inputId)) throw new Error("Attribution reference is outside the selected inputs");
        if (reference.operationId ? !!reference.runId || !!reference.taskId : !reference.runId || !reference.taskId)
          throw new Error("Attribution result requires either operationId or runId/taskId");
        const run = reference.operationId ? this.run(scope, reference.operationId) : this.source.run(reference.runId!);
        const taskId = reference.operationId ?? reference.taskId!;
        const accepted = await readRunTasks(run, [taskId]);
        const task = accepted.manifest.tasks.find((item) => item.id === taskId), receipt = accepted.receipts[taskId];
        if (!receipt || receipt.status !== "succeeded" || task?.stage !== "attribution" || task.inputIds.answer !== reference.inputId)
          throw new Error("Attribution reference is not an accepted result for this input");
        retained.set(reference.inputId, { receipt, task, tasks: accepted.manifest.tasks });
      }
      const sourceTasks = (current: readonly PlannedTask[]) => [...new Map(
        [...retained.values()].flatMap(source => source.tasks).concat([...current]).map(task => [task.id, task]),
      ).values()];
      const reusable = new Map<string, SubmissionReceipt>();
      const context = { reference: first.reference, initialContextChars: this.config.evaluation.execution.initialContextChars, criteriaScope: request.operationId };
      const attributionTask = (candidate: Candidate, criteria: PlannedTask, id: string, original?: SubmissionReceipt): PlannedTask => ({
        id, stage: "attribution", inputIds: { answer: candidate.input_id }, dependencies: { criteria: criteria.id },
        data: { stage: "attribution", candidates: { A: candidate }, ...context,
          ...(original ? { reviewOf: { taskId: original.taskId, round: 1, reasons: ["已有归因与本次共享判据、标准答案或当前验证要求不一致，按本次判据独立重新核验。"] } } : {}),
        } satisfies TaskData,
      });
      const selectReusable = (criteria: PlannedTask, receipt: SubmissionReceipt) => {
        reusable.clear();
        for (const candidate of Object.values(candidates)) {
          const source = retained.get(candidate.input_id), original = source?.receipt;
          if (!source || !original || canonical((source.task.data as TaskData).reference) !== canonical(first.reference) ||
            canonical((original.evaluation as { task_analysis: unknown }).task_analysis) !== canonical(receipt.evaluation)) continue;
          const check = attributionTask(candidate, criteria, randomUUID());
          try { agents.validate(bindTask(check, inputs, { criteria: receipt }, { tasks: [criteria, check] }), original.evaluation, original.audit); }
          catch (error) { if (error instanceof ValidationError) continue; throw error; }
          reusable.set(candidate.input_id, original);
        }
      };
      const injected = (task: PlannedTask, dependencies: Record<string, SubmissionReceipt | undefined>) => {
        const next = { ...task, dependencies: { ...task.dependencies } }, resolved = { ...dependencies };
        if (task.stage === "comparison") for (const [label, candidate] of Object.entries((task.data as TaskData).candidates)) {
          const receipt = reusable.get(candidate.input_id);
          if (receipt && !next.dependencies[label]) { next.dependencies[label] = receipt.taskId; resolved[label] = receipt; }
        }
        return { task: next, dependencies: resolved };
      };
      const stripExternal = (task: PlannedTask): PlannedTask => task.stage !== "comparison" ? task : {
        ...task, dependencies: Object.fromEntries(Object.entries(task.dependencies).filter(([label, id]) => label === "criteria" ||
          ![...reusable.values()].some((receipt) => receipt.taskId === id))),
      };
      const taskSource: RunOptions["taskSource"] = {
        id: "comparison",
        bind(task, input, dependencies, context) {
          const effective = injected(task, dependencies);
          return bindTask(effective.task, input, effective.dependencies, { ...context, tasks: sourceTasks(context.tasks) });
        },
        async reconcile(_run, state) {
          const criteria = state.manifest.tasks.find((task) => task.stage === "criteria");
          if (!criteria) throw new Error("Specialist run is missing its criteria task");
          const replacements = new Map<string, string>();
          // Revalidate retained receipts on resume. If current evidence or validation no longer
          // permits reuse, pending pairs explicitly depend on a new independent assessment.
          for (const task of [...state.manifest.tasks]) {
            if (task.stage !== "comparison" || state.receipts[task.id]) continue;
            for (const [label, candidate] of Object.entries((task.data as TaskData).candidates)) {
              if (task.dependencies[label] || reusable.has(candidate.input_id)) continue;
              let id = replacements.get(candidate.input_id);
              if (!id) {
                const assessment = attributionTask(candidate, criteria, randomUUID(), retained.get(candidate.input_id)?.receipt);
                id = assessment.id; replacements.set(candidate.input_id, id);
                state.manifest.tasks.push(assessment);
                state.manifest.states[id] = { status: "pending", attempts: 0, revision: 1 };
              }
              task.dependencies[label] = id;
            }
          }
          return { tasks: state.manifest.tasks, inputs, catalog: Object.values(candidates), summary: state.manifest.preflight };
        },
        advance: (task, receipt, state, currentInputs) => {
          if (task.stage !== "criteria") {
            const effective = injected(task, Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, state.receipts[id]])));
            const next = comparisonWorkflow.advance?.(effective.task, receipt, state, currentInputs) ?? { tasks: [] };
            return { ...next, tasks: next.tasks.map(stripExternal), ...(next.replace ? { replace: next.replace.map(stripExternal) } : {}) };
          }
          selectReusable(task, receipt);
          const tasks: PlannedTask[] = [], attributes = new Map<string, string>();
          for (const candidate of Object.values(candidates)) {
            if (reusable.has(candidate.input_id)) continue;
            const attribution = attributionTask(candidate, task, request.kind === "attribution" ? request.operationId : randomUUID(), retained.get(candidate.input_id)?.receipt);
            tasks.push(attribution); attributes.set(candidate.input_id, attribution.id);
          }
          if (request.kind === "comparison") for (let i = 0; i < loaded.length; i++) for (let j = i + 1; j < loaded.length; j++) {
            const pair = { A: loaded[i].locator.candidate, B: loaded[j].locator.candidate };
            const id = loaded.length === 2 ? request.operationId : randomUUID();
            tasks.push({ id, stage: "comparison", inputIds: { A: pair.A.input_id, B: pair.B.input_id },
              dependencies: { criteria: task.id, ...Object.fromEntries(Object.entries(pair).flatMap(([label, candidate]) => {
                const id = attributes.get(candidate.input_id); return id ? [[label, id]] : [];
              })) },
              data: { stage: "comparison", candidates: pair, ...context, group: Object.values(pair).map((candidate) => candidate.version), comparisonId: id } satisfies TaskData,
            });
          }
          return { tasks };
        },
      };
      const run = this.run(scope, request.operationId);
      const previous = await exists(path.join(run, "state.json")) ? await readRunTasks(run, []) : undefined;
      if (previous && !previous.manifest.tasks.some((task) => task.stage === "criteria"))
        throw new Error("Specialist run is missing its criteria task");
      const criteria: PlannedTask = previous?.manifest.tasks.find((task) => task.stage === "criteria") ?? {
        id: randomUUID(), stage: "criteria", inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])), dependencies: {},
        data: { stage: "criteria", candidates, ...context } satisfies TaskData,
      };
      if (previous) {
        const accepted = await readRunTasks(run, [criteria.id]);
        if (accepted.receipts[criteria.id]) selectReusable(criteria, accepted.receipts[criteria.id]);
      }
      const repository = createRunRepository(comparisonCodec, (task, state, input) => {
        const effective = injected(task, {});
        const external = Object.fromEntries([...reusable.values()].map((receipt) => [receipt.taskId, receipt]));
        return encodeResult(effective.task, { ...state,
          manifest: { ...state.manifest, tasks: sourceTasks(state.manifest.tasks) },
          receipts: { ...external, ...state.receipts },
        }, input);
      });
      await runEvaluation({ runId: request.operationId, ...this.execution,
        plan: { tasks: [criteria], inputs, catalog: Object.values(candidates), summary: { inputs: loaded.length, comparisons: request.kind === "comparison" ? loaded.length * (loaded.length - 1) / 2 : 0 } },
        taskSource, concurrency: 1,
        output: { kind: "directory", path: path.join(directory, "execution") }, engine: "pi", evaluatorVersion: this.config.evaluatorVersion,
        config: loaded[0].locator.config, agents, repository, logger, snapshots: services.snapshots, runtime: runtimePaths,
        policy: this.config.evaluation.execution, modelForStage: createModelResolver(this.config.models), retries: this.config.evaluation.execution.retries,
        retryDelaySeconds: this.config.evaluation.execution.retryDelaySeconds, debug: this.debug, signal,
        onProgress: (message) => progress?.({ operationId: request.operationId, message }), onEvent: (event) => progress?.({ operationId: request.operationId, event }),
      });
      return this.read(scope, request.operationId);
    } finally { await unlock(); }
  }
}
