import {
  HttpError,
  canonical,
  digest,
  internalPath,
  writeJson,
} from "../../../packages/contracts/src/io.js";
import type {
  AttemptSpec,
  EvaluationPack,
  PlannedTask,
  RunManifest,
  RunState,
  Submission,
  SubmissionReceipt,
} from "../../../packages/contracts/src/index.js";

export class RunStore {
  readonly run: string;
  readonly manifest: RunManifest;
  readonly state: RunState;
  readonly inputs: Record<string, unknown>;
  readonly pack: EvaluationPack;
  readonly attempts = new Map<string, AttemptSpec>();
  private writes = Promise.resolve();
  private submissions = Promise.resolve();
  private committedReceipts: Record<string, SubmissionReceipt>;
  constructor(run: string, state: RunState, inputs: Record<string, unknown>, pack: EvaluationPack) {
    this.run = run;
    this.state = state;
    this.manifest = state.manifest;
    this.committedReceipts = structuredClone(state.receipts);
    this.inputs = inputs;
    this.pack = pack;
  }
  save(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const next = this.writes.then(async () => {
      await this.pack.writeRun(this.run, snapshot);
      this.committedReceipts = snapshot.receipts;
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
    state.status = "running";
    state.attemptId = spec.attemptId;
    state.attempts++;
    state.reason = undefined;
    this.attempts.set(spec.attemptId, spec);
    if (this.manifest.debug) await writeJson(
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
  private async acceptExclusive(value: Submission): Promise<SubmissionReceipt> {
    const task = this.manifest.tasks.find((t) => t.id === value.taskId);
    if (!task) throw new HttpError(404, "Unknown task");
    if (value.submissionId !== digest([value.attemptId, value.evaluation]))
      throw new HttpError(400, "Invalid submission ID");
    const old = await this.receipt(task.id);
    if (old) {
      if (
        old.submissionId === value.submissionId &&
        old.attemptId === value.attemptId &&
        (old.exported || canonical(old.evaluation) === canonical(value.evaluation))
      )
        return { ...old, evaluation: value.evaluation };
      throw new HttpError(409, "Task already has a committed receipt");
    }
    const state = this.manifest.states[task.id],
      spec = this.attempts.get(value.attemptId);
    if (
      state.status !== "running" ||
      state.attemptId !== value.attemptId ||
      !spec ||
      spec.deadline < Date.now()
    )
      throw new HttpError(409, "Attempt is cancelled, expired, or superseded");
    if (
      !value.audit ||
      !Number.isInteger(value.audit.calls) ||
      value.audit.calls < 0 ||
      value.audit.calls > spec.policy.maxToolCalls ||
      !Array.isArray(value.audit.viewedImages) ||
      !Array.isArray(value.audit.artifacts)
    )
      throw new HttpError(400, "Invalid tool audit");
    try {
      this.pack.validate(task, this.inputs, value.evaluation, value.audit, await this.dependencies(task));
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error));
    }
    const receipt: SubmissionReceipt = {
      ...value,
      status: "succeeded",
      cached: false,
      acceptedAt: Date.now(),
    };
    this.state.receipts[task.id] = receipt;
    state.status = "succeeded";
    state.reason = undefined;
    try {
      await this.save();
    } catch (error) {
      delete this.state.receipts[task.id];
      state.status = "running";
      throw error;
    }
    return receipt;
  }
}
