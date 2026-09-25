import { HttpError, canonical, safeId } from "@eval/contracts";
import { internalPath, writeJson } from "@eval/data";
import type {
  AttemptSpec,
  RunRepository,
  WorkflowDefinition,
  PlannedTask,
  RunManifest,
  RunState,
  Submission,
  SubmissionReceipt,
  FailureContext,
  LogSink,
} from "@eval/contracts";

import { AgentRegistry } from "./agents.js";

export interface EvaluationServices {
  logger?: LogSink;
  repository: RunRepository;
  workflow: WorkflowDefinition;
  agents: AgentRegistry;
}

export class RunStore {
  readonly run: string;
  readonly manifest: RunManifest;
  readonly state: RunState;
  readonly inputs: Record<string, unknown>;
  readonly services: EvaluationServices;
  readonly attempts = new Map<string, AttemptSpec>();
  private writes = Promise.resolve();
  private submissions = Promise.resolve();
  private committedReceipts: Record<string, SubmissionReceipt>;
  private readonly writeResults: (state: RunState) => Promise<void>;
  private readonly logged = new Set<string>();
  constructor(run: string, state: RunState, inputs: Record<string, unknown>, services: EvaluationServices) {
    this.run = run;
    this.state = state;
    this.manifest = state.manifest;
    this.committedReceipts = structuredClone(state.receipts);
    this.inputs = inputs;
    this.services = services;
    this.writeResults = services.repository.createResultWriter(run, inputs);
  }
  save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const next = this.writes.then(async () => {
      const pending = snapshot.manifest.tasks.some(
        (task) => snapshot.receipts[task.id] && !snapshot.receipts[task.id].exported,
      );
      await this.services.repository.writeRun(this.run, snapshot);
      await this.writeResults(snapshot);
      // Drop recovery payloads only after their formal result rows are durable.
      // If this optional compaction fails, the earlier full checkpoint still recovers the accepted result.
      if (pending) await this.services.repository.writeRun(this.run, snapshot).catch(() => {});
      for (const [id, receipt] of Object.entries(snapshot.receipts))
        if (this.state.receipts[id]?.submissionId === receipt.submissionId && receipt.exported)
          this.state.receipts[id].exported = receipt.exported;
      this.committedReceipts = snapshot.receipts;
      if (this.services.logger)
        for (const task of snapshot.manifest.tasks) {
          const receipt = snapshot.receipts[task.id];
          if (!receipt?.exported || this.logged.has(receipt.submissionId)) continue;
          if (
            await this.services.logger.evaluation({
              time: new Date(receipt.acceptedAt).toISOString(),
              workflow: this.services.workflow.id,
              run_id: snapshot.manifest.runId,
              task_id: task.id,
              attempt_id: receipt.attemptId,
              submission_id: receipt.submissionId,
              stage: task.stage,
              result: receipt.exported.row,
            })
          )
            this.logged.add(receipt.submissionId);
        }
    });
    this.writes = next.catch(() => {});
    return next;
  }
  async receipt(taskId: string): Promise<SubmissionReceipt | undefined> {
    await this.writes;
    return this.committedReceipts[taskId];
  }
  async dependencies(task: PlannedTask): Promise<Record<string, SubmissionReceipt>> {
    const dependencies: Record<string, SubmissionReceipt> = {};
    for (const [label, id] of Object.entries(task.dependencies)) {
      const receipt = await this.receipt(id);
      if (!receipt) throw new Error(`Dependency missing: ${id}`);
      dependencies[label] = receipt;
    }
    return dependencies;
  }
  async findSubmission(id: string): Promise<SubmissionReceipt> {
    for (const task of this.manifest.tasks) {
      const receipt = await this.receipt(task.id);
      if (receipt?.submissionId === id) return receipt;
    }
    throw new HttpError(404, "Submission not accepted");
  }
  async activate(spec: AttemptSpec): Promise<void> {
    const operation = this.submissions.then(() => this.activateExclusive(spec));
    this.submissions = operation.catch(() => {});
    return operation;
  }
  private async activateExclusive(spec: AttemptSpec): Promise<void> {
    const state = this.manifest.states[spec.taskId];
    if (!state || (await this.receipt(spec.taskId))) throw new Error("Task already completed or unknown");
    if (spec.inputRevision !== (state.revision || 1)) throw new HttpError(409, "Input revision superseded");
    state.status = "running";
    state.attemptId = spec.attemptId;
    state.attempts++;
    state.reason = undefined;
    this.attempts.set(spec.attemptId, spec);
    if (this.manifest.debug)
      await writeJson(
        internalPath(
          this.run,
          "tasks",
          spec.taskId,
          `attempt-${state.attempts.toString().padStart(3, "0")}`,
          "attempt.json",
        ),
        { spec },
      );
    await this.save();
  }
  async endAttempt(
    spec: AttemptSpec,
    status: "failed" | "timed_out" | "cancelled",
    reason: string,
  ): Promise<void> {
    const operation = this.submissions.then(async () => {
      const state = this.manifest.states[spec.taskId];
      if (state.attemptId !== spec.attemptId || (await this.receipt(spec.taskId))) return;
      state.status = status;
      state.reason = reason;
      await this.save();
    });
    this.submissions = operation.catch(() => {});
    return operation;
  }
  async accept(value: Submission): Promise<SubmissionReceipt> {
    const result = this.submissions.then(() => this.acceptExclusive(value));
    this.submissions = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async checkpoint(taskId: string, failure: FailureContext): Promise<void> {
    const operation = this.submissions.then(async () => {
      const state = this.manifest.states[taskId];
      if (!state || state.attemptId !== failure.attemptId || state.status !== "running")
        throw new HttpError(409, "Attempt is cancelled or superseded");
      state.failure = failure;
      await this.save();
    });
    this.submissions = operation.catch(() => {});
    return operation;
  }
  private async acceptExclusive(value: Submission): Promise<SubmissionReceipt> {
    const task = this.manifest.tasks.find((t) => t.id === value.taskId);
    if (!task) throw new HttpError(404, "Unknown task");
    safeId(value.submissionId);
    for (const [id, receipt] of Object.entries(this.committedReceipts))
      if (id !== task.id && receipt.submissionId === value.submissionId)
        throw new HttpError(409, "Submission ID already belongs to another task");
    const old = await this.receipt(task.id);
    if (old) {
      if (
        old.submissionId === value.submissionId &&
        old.attemptId === value.attemptId &&
        canonical(old.audit) === canonical(value.audit) &&
        canonical(old.usage) === canonical(value.usage) &&
        canonical(old.submissionStats) === canonical(value.submissionStats) &&
        canonical(old.submitted ?? old.evaluation) === canonical(value.evaluation)
      )
        return old;
      throw new HttpError(409, "Task already has a committed receipt");
    }
    const state = this.manifest.states[task.id],
      spec = this.attempts.get(value.attemptId);
    if (
      state.status !== "running" ||
      state.attemptId !== value.attemptId ||
      !spec ||
      spec.inputRevision !== (state.revision || 1) ||
      spec.deadline < Date.now()
    )
      throw new HttpError(409, "Attempt is cancelled, expired, or superseded");
    if (
      !value.audit ||
      !Number.isInteger(value.audit.calls) ||
      value.audit.calls < 0 ||
      value.audit.calls > spec.policy.maxToolCalls + spec.policy.repairAttempts ||
      !Array.isArray(value.audit.viewedImages) ||
      !Array.isArray(value.audit.artifacts)
    )
      throw new HttpError(400, "Invalid tool audit");
    let evaluation: unknown;
    try {
      const binding = this.services.workflow.bind(task, this.inputs, await this.dependencies(task));
      evaluation = this.services.agents.resolve(binding, value.evaluation, value.audit);
      this.services.agents.validate(binding, evaluation, value.audit);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
    const receipt: SubmissionReceipt = {
      ...value,
      evaluation,
      submitted: structuredClone(value.evaluation),
      status: "succeeded",
      acceptedAt: Date.now(),
    };
    const failure = state.failure,
      repeatedErrors = state.repeatedErrors;
    this.state.receipts[task.id] = receipt;
    state.status = "succeeded";
    state.reason = undefined;
    state.repeatedErrors = failure?.repeatedErrors || undefined;
    state.failure = undefined;
    try {
      await this.save();
    } catch (error) {
      delete this.state.receipts[task.id];
      state.status = "running";
      state.failure = failure;
      state.repeatedErrors = repeatedErrors;
      throw error;
    }
    return receipt;
  }
}
