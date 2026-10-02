import { HttpError, canonical, safeId, requiredReadCallLimit, mergeRequiredReadRanges } from "@eval/contracts";
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
  TaskState,
  TraceRead,
} from "@eval/contracts";

import { AgentRegistry } from "./agents.js";
import { checkpointSnapshot } from "./checkpoint.js";

/** Mandatory calls must be backed by distinct pages advancing declared material. */
function availableRequiredReadCalls(reads: TraceRead[], required: { target: TraceRead; text: string }[]): number {
  if (!Array.isArray(reads)) return 0;
  const previous: TraceRead[] = [];
  let available = 0;
  for (const read of reads) {
    if (!read || read.kind !== "text" || !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end <= read.start) continue;
    const advances = required.some(({ target, text }) => {
      if (read.candidate !== target.candidate || read.message_index !== target.message_index || read.path !== target.path) return false;
      if (read.end > text.length || read.end - read.start > 16000) return false;
      let cursor = target.start;
      const ranges = previous.filter(item => item.candidate === target.candidate && item.message_index === target.message_index && item.path === target.path)
        .sort((a, b) => a.start - b.start);
      for (const range of ranges) {
        if (range.start > cursor || cursor >= target.end) break;
        cursor = Math.max(cursor, range.end);
      }
      return read.start === cursor && cursor < target.end;
    });
    if (advances) available++;
    previous.push(read);
  }
  return available;
}

function requiredReadRanges(spec: AttemptSpec, inputs: Record<string, unknown>) {
  return mergeRequiredReadRanges((spec.evaluation.requiredReads ?? []).map(target => {
    const id = spec.inputs.find(input => input.name === target.candidate)?.id;
    const raw = id === undefined ? undefined : inputs[id] as { messages?: unknown[] } | undefined;
    let text: unknown = raw?.messages?.[target.message_index];
    if (target.path !== "") {
      if (!target.path.startsWith("/")) throw new Error("Invalid required trace path");
      for (const part of target.path.slice(1).split("/")) {
        const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
        text = text && typeof text === "object" && Object.hasOwn(text, key)
          ? (text as Record<string, unknown>)[key] : undefined;
      }
    }
    if (typeof text !== "string") throw new Error("Required trace source is unavailable");
    return { target, text };
  }));
}

function recordWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validTableChecks(value: unknown, inputs: AttemptSpec["inputs"]): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
  const mapping = (value: unknown): value is { answer: number; source: number }[] => {
    if (!Array.isArray(value) || !value.length) return false;
    const answers = new Set<number>(), sources = new Set<number>();
    for (const item of value) {
      if (!recordWithKeys(item, ["answer", "source"]) ||
        !Number.isSafeInteger(item.answer) || (item.answer as number) < 0 ||
        !Number.isSafeInteger(item.source) || (item.source as number) < 0 ||
        answers.has(item.answer as number) || sources.has(item.source as number)) return false;
      answers.add(item.answer as number);
      sources.add(item.source as number);
    }
    return true;
  };
  return value.every((check) => {
    if (!recordWithKeys(check, ["candidate", "answer_table_id", "sources"]) ||
      !inputs.some((input) => input.name === check.candidate) || !nonempty(check.answer_table_id) ||
      !Array.isArray(check.sources) || !check.sources.length) return false;
    const ids = new Set<string>();
    let columns: string | undefined;
    return check.sources.every((source: unknown) => {
      if (!recordWithKeys(source, ["table_id", "key_columns", "value_columns"]) || !nonempty(source.table_id) ||
        source.table_id === check.answer_table_id || ids.has(source.table_id) ||
        !mapping(source.key_columns) || !mapping(source.value_columns)) return false;
      ids.add(source.table_id);
      const keys = source.key_columns, values = source.value_columns;
      if (keys.some((key) => values.some((value) => value.answer === key.answer || value.source === key.source))) return false;
      const signature = JSON.stringify([keys.map((item) => item.answer).sort((a, b) => a - b),
        values.map((item) => item.answer).sort((a, b) => a - b)]);
      if (columns !== undefined && columns !== signature) return false;
      columns = signature;
      return true;
    });
  });
}

export interface EvaluationServices {
  logger?: LogSink;
  repository: RunRepository;
  taskSource: Pick<WorkflowDefinition, "id" | "bind" | "reconcile" | "advance" | "blockedReason">;
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
  private queuedWrite?: Promise<void>;
  private readonly submissions = new Map<string, Promise<void>>();
  private commits = Promise.resolve();
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
    if (this.queuedWrite) return this.queuedWrite;
    const next = this.writes.then(async () => {
      this.queuedWrite = undefined;
      const snapshot = checkpointSnapshot(this.state);
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
          if (!receipt?.exported || receipt.exported.auxiliary || this.logged.has(receipt.submissionId)) continue;
          if (
            await this.services.logger.evaluation({
              time: new Date(receipt.acceptedAt).toISOString(),
              workflow: this.services.taskSource.id,
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
    this.queuedWrite = next;
    this.writes = next.catch(() => {});
    return next;
  }
  async receipt(taskId: string): Promise<SubmissionReceipt | undefined> {
    // Only this task's uncommitted receipt needs a durability barrier. Waiting
    // on unrelated writes prevents the scheduler from filling free workers.
    if (this.committedReceipts[taskId] || !this.state.receipts[taskId])
      return this.committedReceipts[taskId];
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
    return this.exclusive(spec.taskId, () => this.activateExclusive(spec));
  }
  private exclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.submissions.get(taskId) || Promise.resolve()).then(operation);
    const settled = result.then(() => {}, () => {});
    this.submissions.set(taskId, settled);
    void settled.then(() => {
      if (this.submissions.get(taskId) === settled) this.submissions.delete(taskId);
    });
    return result;
  }
  private async activateExclusive(spec: AttemptSpec): Promise<void> {
    const state = this.manifest.states[spec.taskId];
    if (!state || (await this.receipt(spec.taskId))) throw new Error("Task already completed or unknown");
    if (spec.inputRevision !== (state.revision || 1)) throw new HttpError(409, "Input revision superseded");
    if (state.attemptId) this.attempts.delete(state.attemptId);
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
    return this.exclusive(spec.taskId, async () => {
      const state = this.manifest.states[spec.taskId];
      if (state.attemptId !== spec.attemptId || (await this.receipt(spec.taskId))) return;
      state.status = status;
      state.reason = reason;
      await this.save();
      this.attempts.delete(spec.attemptId);
    });
  }
  async accept(value: Submission): Promise<SubmissionReceipt> {
    return this.exclusive(value.taskId, () => {
      const commit = this.commits.then(() => this.acceptExclusive(value));
      this.commits = commit.then(() => {}, () => {});
      return commit;
    });
  }
  async checkpoint(taskId: string, failure: FailureContext): Promise<void> {
    return this.exclusive(taskId, async () => {
      const state = this.manifest.states[taskId];
      if (!state || state.attemptId !== failure.attemptId || state.status !== "running")
        throw new HttpError(409, "Attempt is cancelled or superseded");
      state.failure = failure;
      await this.save();
    });
  }
  private async acceptExclusive(value: Submission): Promise<SubmissionReceipt> {
    const task = this.manifest.tasks.find((t) => t.id === value.taskId);
    if (!task) throw new HttpError(404, "Unknown task");
    safeId(value.submissionId);
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
    const required = requiredReadRanges(spec, this.inputs);
    if (
      !value.audit ||
      !Number.isSafeInteger(value.audit.calls) ||
      value.audit.calls < 0 ||
      !Number.isSafeInteger(value.audit.requiredReadCalls) || value.audit.requiredReadCalls < 0 ||
      value.audit.requiredReadCalls > value.audit.calls ||
      value.audit.requiredReadCalls > availableRequiredReadCalls(value.audit.traceReads, required) ||
      value.audit.requiredReadCalls > requiredReadCallLimit(required, spec.policy.maxOutputChars) ||
      value.audit.calls - value.audit.requiredReadCalls > spec.policy.maxToolCalls + spec.policy.repairAttempts ||
      !Array.isArray(value.audit.viewedImages) ||
      !Array.isArray(value.audit.traceReads) ||
      value.audit.traceReads.some((read) => !read ||
        typeof read.candidate !== "string" || !spec.inputs.some((input) => input.name === read.candidate) ||
        !Number.isSafeInteger(read.message_index) || read.message_index < 0 ||
        (read.kind !== "text" && read.kind !== "json") || typeof read.path !== "string" ||
        (read.kind === "json" && read.path !== "") ||
        !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end <= read.start) ||
      !Array.isArray(value.audit.calculations) ||
      !Array.isArray(value.audit.artifacts) ||
      !validTableChecks(value.audit.tableChecks, spec.inputs)
    )
      throw new HttpError(400, "Invalid tool audit");
    let evaluation: unknown;
    try {
      const binding = this.services.taskSource.bind(task, this.inputs, await this.dependencies(task));
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
      evaluatorVersion: this.manifest.evaluatorVersion,
      judge: spec.model.model,
      status: "succeeded",
      acceptedAt: Date.now(),
    };
    const failure = state.failure,
      repeatedErrors = state.repeatedErrors;
    // Check and reserve without yielding: other tasks may also be waiting to commit.
    for (const [id, receipt] of Object.entries(this.state.receipts))
      if (id !== task.id && receipt.submissionId === value.submissionId)
        throw new HttpError(409, "Submission ID already belongs to another task");
    this.state.receipts[task.id] = receipt;
    state.status = "succeeded";
    state.reason = undefined;
    state.repeatedErrors = failure?.repeatedErrors || undefined;
    state.failure = undefined;
    const previousTasks = [...this.manifest.tasks];
    const previousScope = this.manifest.executionScope && [...this.manifest.executionScope];
    const changedStates = new Map<string, TaskState>();
    const addedIds: string[] = [];
    try {
      const advance = this.services.taskSource.advance?.(task, receipt, this.state, this.inputs);
      for (const replacement of advance?.replace ?? []) {
        const index = this.manifest.tasks.findIndex((item) => item.id === replacement.id);
        if (index < 0 || this.manifest.states[replacement.id].status === "running")
          throw new Error("Cannot replace an unknown or running task");
        this.manifest.tasks[index] = replacement;
      }
      for (const next of advance?.tasks ?? []) {
        if (this.manifest.states[next.id]) throw new Error("Duplicate follow-up task");
        this.manifest.tasks.push(next);
        addedIds.push(next.id);
        this.manifest.states[next.id] = { status: "pending", attempts: 0, revision: 1 };
        if (this.manifest.executionScope?.includes(task.id)) this.manifest.executionScope.push(next.id);
      }
      for (const id of advance?.blocked ?? []) {
        const current = this.manifest.states[id];
        if (!current || current.status === "running" || this.state.receipts[id]) continue;
        changedStates.set(id, { ...current });
        current.status = "blocked";
        current.reason = "Independent review is unresolved";
      }
      await this.save();
    } catch (error) {
      delete this.state.receipts[task.id];
      state.status = "running";
      state.failure = failure;
      state.repeatedErrors = repeatedErrors;
      this.manifest.tasks = previousTasks;
      this.manifest.executionScope = previousScope;
      for (const id of addedIds) delete this.manifest.states[id];
      for (const [id, previous] of changedStates) this.manifest.states[id] = previous;
      throw error;
    }
    this.attempts.delete(value.attemptId);
    return receipt;
  }
}
