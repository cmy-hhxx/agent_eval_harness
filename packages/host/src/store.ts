import { ValidationError, HttpError, canonical, safeId, evidenceSources, requiredReadCallLimit, mergeRequiredReadRanges, extendRequiredReadRanges, toolBudgetMetadataChars, validationRequiredReads, validateEvidenceBank, validateEvidenceBankSources, type EvidenceBankUpdate, type EvidenceBank } from "@eval/contracts";
import {
  appendProgressJournal,
  compactProgressJournal,
  RunHotStore,
  runJournalIdentity,
  type RunJournalDelta,
} from "@eval/data";
import type {
  AttemptSpec,
  RunRepository,
  WorkflowDefinition,
  PlannedTask,
  RunManifest,
  RunState,
  Submission,
  SubmissionReceipt,
  TaskState,
  FailureContext,
  LogSink,
  TraceRead,
  ToolAudit,
  MaterialInspection,
  JsonObject,
  AgentBinding,
} from "@eval/contracts";

import { AgentRegistry } from "./agents.js";
import { checkpointSnapshot } from "./checkpoint.js";
import { cumulativeAttempts, executionStopReason } from "./run-limits.js";
import { dependencyReady } from "./scheduling.js";

/** Mandatory calls must be backed by distinct pages advancing declared material. */
function availableRequiredReadCalls(reads: TraceRead[], required: { target: TraceRead; text: string }[]): number {
  if (!Array.isArray(reads)) return 0;
  const previous: TraceRead[] = [];
  let available = 0;
  for (const read of reads) {
    if (!read || !["text", "json"].includes(read.kind) || !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end <= read.start) continue;
    const advances = required.some(({ target, text }) => {
      if (read.candidate !== target.candidate || read.message_index !== target.message_index || read.kind !== target.kind || read.path !== target.path) return false;
      if (read.end > text.length || read.end - read.start > 16000) return false;
      let cursor = target.start;
      const ranges = previous.filter(item => item.candidate === target.candidate && item.message_index === target.message_index && item.kind === target.kind && item.path === target.path)
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

function requiredReadRanges(spec: AttemptSpec, sources: ReadonlyMap<string, unknown>) {
  return (spec.evaluation.requiredReads ?? []).flatMap(target => {
    const id = spec.inputs.find(input => input.name === target.candidate)?.id;
    const raw = id === undefined ? undefined : sources.get(id) as { messages?: unknown[] } | undefined;
    const message = raw?.messages?.[target.message_index];
    const text = message === undefined ? undefined : evidenceSources(message).find(source => source.kind === target.kind && source.path === target.path)?.text;
    if (typeof text !== "string") throw new Error("Required trace source is unavailable");
    if (!id) throw new Error("Required trace input identity is unavailable");
    return mergeRequiredReadRanges([{ target, inputId: id, text }]);
  });
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
  taskSource: Pick<WorkflowDefinition, "id" | "bind" | "reconcile" | "advance" | "blockedReason" | "canStart" | "observesFailures" | "scheduling" | "isComputedTask" | "shards" | "release">;
  agents: AgentRegistry;
}

interface SaveOptions {
  all?: boolean;
  stateIds?: readonly string[];
  tasks?: readonly PlannedTask[];
  taskOrder?: string[];
  manifest?: boolean;
  usage?: boolean;
}

export class RunStore {
  readonly run: string;
  readonly manifest: RunManifest;
  readonly state: RunState;
  readonly inputs: Record<string, unknown>;
  readonly services: EvaluationServices;
  readonly attempts = new Map<string, AttemptSpec>();
  private readonly bindings = new Map<string, AgentBinding>();
  readonly checkpointMetrics = { count: 0, snapshotMs: 0, writeMs: 0, bytes: 0, savedAt: 0,
    failures: 0, failedSince: 0, lastError: undefined as string | undefined };
  readonly outboxMetrics = { delivered: 0, failures: 0, lastError: undefined as string | undefined };
  private readonly evidenceSources = new Map<string, ReadonlyMap<string, unknown>>();
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly journal: RunHotStore;
  private readonly directMode: boolean;
  private committedReceipts: Record<string, SubmissionReceipt>;
  private readonly writeResults: (state: RunState) => Promise<void>;
  private readonly logged = new Set<string>();
  private outboxTimer?: ReturnType<typeof setInterval>;
  private outboxFlush?: Promise<void>;
  private receiptLogs?: Promise<void>;
  private checkpointRun?: Promise<void>;
  private fallbackSave?: Promise<void>;
  private outboxStarted = false;
  private admissionBlocked = false;
  private lastDeliveredSequence = 0;
  constructor(run: string, state: RunState, inputs: Record<string, unknown>, services: EvaluationServices,
    private readonly deadline: (spec: AttemptSpec) => number = spec => spec.deadline,
    journal?: RunHotStore) {
    this.run = run;
    this.state = state;
    this.manifest = state.manifest;
    // Accepted bodies are immutable; isolate mutable receipt wrappers without duplicating the full run's results.
    this.committedReceipts = Object.fromEntries(Object.entries(state.receipts).map(([id, receipt]) => [id, { ...receipt }]));
    this.inputs = inputs;
    this.services = services;
    this.directMode = !journal;
    this.journal = journal ?? new RunHotStore(":memory:", runJournalIdentity(state));
    this.lastDeliveredSequence = Math.max(state.manifest.journalSequence ?? 0, this.journal.lastDeliveredSequence());
    this.writeResults = services.repository.createResultWriter(run, inputs);
  }
  /** Persist a compact local delta. Ceph projection runs through the outbox. */
  async save(taskId?: string, options: SaveOptions = {}): Promise<void> {
    const states: Record<string, TaskState> = {};
    if (options.all) {
      for (const id of Object.keys(this.manifest.states)) states[id] = structuredClone(this.manifest.states[id]);
    } else if (options.stateIds) {
      for (const id of options.stateIds) if (this.manifest.states[id]) states[id] = structuredClone(this.manifest.states[id]);
    } else if (taskId && this.manifest.states[taskId]) {
      states[taskId] = structuredClone(this.manifest.states[taskId]);
    }
    const { tasks: _tasks, states: _states, inputCatalog, ...manifest } = this.manifest;
    const includeManifest = options.manifest === true || (!taskId && options.manifest !== false);
    const delta: RunJournalDelta = {
      at: Date.now(),
      ...(includeManifest ? { manifest: { ...manifest, ...(inputCatalog === undefined ? {} : { inputCatalog }) } } : {}),
      ...(options.taskOrder ? { taskOrder: [...options.taskOrder] } : {}),
      ...(options.tasks?.length ? { tasks: options.tasks.map(task => structuredClone(task)) } : {}),
      ...(Object.keys(states).length ? { states } : {}),
      ...(options.usage ? { usage: structuredClone(this.state.usage), recordedAttempts: this.state.recordedAttempts } : {}),
    };
    this.journal.append(delta);
    if (this.outboxStarted) void this.flushOutbox();
    else if ((this.directMode || !taskId) && !this.fallbackSave) {
      this.fallbackSave = Promise.resolve().then(() => this.persistCheckpoint());
      void this.fallbackSave.then(() => { this.fallbackSave = undefined; },
        () => { this.fallbackSave = undefined; });
      return this.fallbackSave;
    }
  }

  startOutbox(): void {
    if (this.outboxStarted) return;
    this.outboxStarted = true;
    this.outboxTimer = setInterval(() => void this.flushOutbox(), 1000);
    void this.flushOutbox();
  }

  admissionPaused(): boolean {
    return this.admissionBlocked || !!this.checkpointMetrics.failedSince && Date.now() - this.checkpointMetrics.failedSince >= 5 * 60_000;
  }

  outboxStatus() { return { ...this.journal.outboxStats(), admissionPaused: this.admissionBlocked, ...this.outboxMetrics }; }

  private outboxStats() { return this.journal.outboxStats(); }

  private updateAdmission(): void {
    const stats = this.outboxStats();
    const oldestMs = stats.oldestAt === undefined ? 0 : Date.now() - stats.oldestAt;
    this.admissionBlocked = stats.oldestAt !== undefined && (oldestMs > 5 * 60 * 1000 || stats.bytes > 10 * 1024 ** 3);
  }

  async flushOutbox(force = false): Promise<void> {
    if ((!this.outboxStarted && !force) || this.outboxFlush) return this.outboxFlush;
    this.outboxFlush = (async () => {
      try {
        while (true) {
          // Publication costs one durable append per touched delivery file, not per row;
          // a wider batch amortizes those appends instead of paying them every few hundred events.
          const pending = this.journal.pending(2000);
          if (!pending.length) break;
          if (pending.some(event => Object.keys(event.event.receipts ?? {}).length))
            await this.writeResults(this.resultView());
          const projected = pending.map(({ seq, event }) => {
            const receipts = event.receipts && Object.fromEntries(Object.entries(event.receipts).map(([id, receipt]) => {
              const exported = this.state.receipts[id]?.exported;
              return [id, exported ? { ...receipt, exported } : receipt];
            }));
            return { seq, event: receipts ? { ...event, receipts } : event };
          });
          await appendProgressJournal(this.run, projected);
          this.journal.markDelivered(pending.map(event => event.seq));
          this.lastDeliveredSequence = pending.at(-1)!.seq;
          this.outboxMetrics.delivered += pending.length;
          // Sustained overload never empties the queue, so capacity must be re-evaluated per batch.
          this.updateAdmission();
        }
        this.outboxMetrics.lastError = undefined;
        this.updateAdmission();
        // Shared log IO must not hold up the next projection of accepted results.
        if (!this.receiptLogs) {
          this.receiptLogs = this.logExportedReceipts().catch(async error => {
            await this.services.logger?.error(error, {
              component: "host", event: "receipt_log_failed", run_id: this.manifest.runId,
            });
          }).finally(() => { this.receiptLogs = undefined; });
        }
        // Finished inputs leave the checkpoint only after their results reached the
        // journal, the log and the delivery files; a pending receipt keeps its shard.
        if (this.services.taskSource.release && !this.receiptLogs && this.outboxStats().count === 0)
          this.services.taskSource.release(this.state, this.inputs);
      } catch (error) {
        this.outboxMetrics.failures++;
        this.outboxMetrics.lastError = error instanceof Error ? error.message : String(error);
        this.updateAdmission();
        if (this.outboxMetrics.failures === 1 || this.outboxMetrics.failures % 30 === 0)
          await this.services.logger?.error(error, {
            component: "host", event: "outbox_projection_failed", run_id: this.manifest.runId,
            detail: JSON.stringify({ ...this.outboxStats(), admission_paused: this.admissionBlocked }),
          });
      }
    })().finally(() => { this.outboxFlush = undefined; });
    return this.outboxFlush;
  }

  persistCheckpoint(): Promise<void> {
    const next = (this.checkpointRun ?? Promise.resolve()).catch(() => {}).then(() => this.checkpointNow()).catch(error => {
      this.checkpointMetrics.failures++;
      this.checkpointMetrics.failedSince ||= Date.now();
      this.checkpointMetrics.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });
    this.checkpointRun = next;
    void next.then(() => { if (this.checkpointRun === next) this.checkpointRun = undefined; },
      () => { if (this.checkpointRun === next) this.checkpointRun = undefined; });
    return next;
  }

  private async checkpointNow(): Promise<void> {
    if (this.outboxStarted) {
      await this.flushOutbox(true);
      // The projection starts the receipt log after clearing the outbox; finishing it here
      // releases finished inputs before the snapshot instead of one flush later.
      await this.receiptLogs;
      if (this.services.taskSource.release && !this.receiptLogs && !this.outboxStats().count)
        this.services.taskSource.release(this.state, this.inputs);
    }
    const snapshotStarted = performance.now();
    this.manifest.journalSequence = this.lastDeliveredSequence;
    const snapshot = checkpointSnapshot(this.state);
    this.checkpointMetrics.snapshotMs += performance.now() - snapshotStarted;
    const writeStarted = performance.now();
    await this.writeResults(snapshot);
    const bytes = await this.services.repository.writeRun(this.run, snapshot);
    if (typeof bytes === "number") this.checkpointMetrics.bytes = bytes;
    await compactProgressJournal(this.run, snapshot.manifest.journalSequence ?? 0);
    for (const [id, receipt] of Object.entries(snapshot.receipts))
      if (this.state.receipts[id]?.submissionId === receipt.submissionId && receipt.exported)
        this.state.receipts[id].exported = receipt.exported;
    this.checkpointMetrics.writeMs += performance.now() - writeStarted;
    this.checkpointMetrics.count++;
    this.checkpointMetrics.savedAt = Date.now();
    this.checkpointMetrics.failedSince = 0;
    this.checkpointMetrics.lastError = undefined;
  }

  async close(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    try {
      if (this.outboxStarted) await this.flushOutbox(true);
      await this.fallbackSave;
      await this.checkpointRun;
      await this.receiptLogs;
    } finally {
      this.outboxTimer = undefined;
      this.journal.close();
    }
  }

  private resultView(): RunState {
    return { ...this.state, manifest: { ...this.manifest, tasks: this.manifest.tasks } };
  }

  private async logExportedReceipts(): Promise<void> {
    if (!this.services.logger) return;
    for (const task of this.manifest.tasks) {
      const receipt = this.state.receipts[task.id];
      if (!receipt?.exported || receipt.exported.auxiliary || this.logged.has(receipt.submissionId)) continue;
      if (await this.services.logger.evaluation({
        time: new Date(receipt.acceptedAt).toISOString(), workflow: this.services.taskSource.id,
        run_id: this.manifest.runId, task_id: task.id, attempt_id: receipt.attemptId,
        submission_id: receipt.submissionId, stage: task.stage, result: receipt.exported.row,
      })) this.logged.add(receipt.submissionId);
    }
  }
  async receipt(taskId: string): Promise<SubmissionReceipt | undefined> {
    return this.committedReceipts[taskId];
  }
  async dependencies(task: PlannedTask): Promise<Record<string, SubmissionReceipt>> {
    const dependencies: Record<string, SubmissionReceipt> = {};
    for (const [label, id] of Object.entries(task.dependencies)) {
      const receipt = await this.receipt(id);
      if (!receipt) {
        if (dependencyReady(task, label, this.manifest.states) && this.manifest.states[id]?.status !== "succeeded") continue;
        throw new Error(`Dependency missing: ${id}`);
      }
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
  async activate(spec: AttemptSpec, binding?: AgentBinding): Promise<boolean> {
    return this.exclusive(spec.taskId, () => this.activateExclusive(spec, binding));
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
  private async activateExclusive(spec: AttemptSpec, preparedBinding?: AgentBinding): Promise<boolean> {
    const state = this.manifest.states[spec.taskId];
    if (!state || (await this.receipt(spec.taskId))) throw new Error("Task already completed or unknown");
    if (spec.inputRevision !== (state.revision || 1)) throw new HttpError(409, "Input revision superseded");
    const task = this.manifest.tasks.find(task => task.id === spec.taskId)!;
    const binding = preparedBinding ?? this.services.taskSource.bind(task, this.inputs, await this.dependencies(task), { tasks: this.manifest.tasks });
    const sources = new Map(spec.inputs.map(input => {
      const source = binding.request.sources[input.name];
      if (!source || source.id !== input.id) throw new HttpError(400, "Evidence bank source does not match the active task binding");
      return [input.id, source.value] as const;
    }));
    this.validateBank(spec, spec.evidenceBank, state.failure?.evidenceBank ?? [], sources);
    spec.evaluation = { ...spec.evaluation, requiredReads: [
      ...spec.evaluation.requiredReads ?? [], ...validationRequiredReads(spec.recovery?.errors ?? []),
    ] };
    spec.evaluation.requiredReads = mergeRequiredReadRanges(requiredReadRanges(spec, sources)).map(range => range.target);
    if (executionStopReason(this.manifest) || this.admissionBlocked) return false;
    if (state.attemptId) { this.attempts.delete(state.attemptId); this.evidenceSources.delete(state.attemptId); this.bindings.delete(state.attemptId); }
    state.startedAt = state.lastProgressAt = Date.now();
    state.status = "running";
    delete state.phase;
    delete state.timeoutPhase;
    state.attemptId = spec.attemptId;
    this.manifest.cumulativeAttempts = cumulativeAttempts(this.manifest) + 1;
    state.attempts++;
    state.reason = undefined;
    state.failure = { errors: [], contentSubmissions: 0, fileErrors: 0, repeatedErrors: 0, stopped: false,
      ...(state.failure ?? {}), attemptId: spec.attemptId, evidenceBank: [...spec.evidenceBank] };
    this.evidenceSources.set(spec.attemptId, sources);
    this.attempts.set(spec.attemptId, spec);
    this.bindings.set(spec.attemptId, binding);
    await this.save(spec.taskId);
    return true;
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
      await this.save(spec.taskId);
      this.attempts.delete(spec.attemptId);
      this.evidenceSources.delete(spec.attemptId);
      this.bindings.delete(spec.attemptId);
    });
  }
  async accept(value: Submission): Promise<SubmissionReceipt> {
    return this.exclusive(value.taskId, () => this.acceptExclusive(value));
  }
  private validateBank(spec: AttemptSpec, bank: unknown, prefix: readonly string[] = spec.evidenceBank,
    sources = this.evidenceSources.get(spec.attemptId)): asserts bank is EvidenceBank {
    validateEvidenceBank(bank, prefix);
    if (!sources) throw new HttpError(409, "Evidence bank requires an active trusted task binding");
    validateEvidenceBankSources(bank, sources, prefix.length);
  }
  registerEvidenceBank(value: EvidenceBankUpdate): Promise<{ evidenceBank: EvidenceBank }> {
    return this.exclusive(value.taskId, async () => {
      const state = this.manifest.states[value.taskId], spec = this.attempts.get(value.attemptId);
      if (!state || state.status !== "running" || state.attemptId !== value.attemptId || !spec || this.deadline(spec) < Date.now())
        throw new HttpError(409, "Attempt is cancelled, expired, or superseded");
      const previous = state.failure?.evidenceBank ?? spec.evidenceBank;
      const next = value.append ? [...previous, ...value.append] : value.evidenceBank ?? [];
      this.validateBank(spec, next, previous);
      if (canonical(previous) !== canonical(next)) {
        state.failure = { errors: [], contentSubmissions: 0, fileErrors: 0, repeatedErrors: 0, stopped: false,
          ...(state.failure ?? {}), attemptId: value.attemptId, evidenceBank: [...next] };
        await this.save(value.taskId);
      }
      return { evidenceBank: [...next] };
    });
  }
  async checkpoint(taskId: string, failure: FailureContext): Promise<void> {
    return this.exclusive(taskId, async () => {
      const state = this.manifest.states[taskId];
      if (!state || state.attemptId !== failure.attemptId || state.status !== "running")
        throw new HttpError(409, "Attempt is cancelled or superseded");
      if (failure.inspection && (!state.failure?.inspection || canonical(state.failure.inspection) !== canonical(failure.inspection)))
        throw new HttpError(409, "Only a successful Host inspection can create its checkpoint");
      if (!Number.isSafeInteger(failure.contentSubmissions) || failure.contentSubmissions < 0)
        throw new HttpError(400, "Invalid content submission count");
      const spec = this.attempts.get(failure.attemptId);
      if (!spec) throw new HttpError(409, "Unknown attempt");
      this.validateBank(spec, failure.evidenceBank, state.failure?.evidenceBank ?? spec.evidenceBank);
      state.failure = { ...failure, evidenceBank: [...failure.evidenceBank], contentSubmissions: Math.max(failure.contentSubmissions, state.failure?.contentSubmissions ?? 0),
        ...(state.failure?.inspection ? { inspection: state.failure.inspection } : {}) };
      await this.save(taskId);
    });
  }
  inspect(value: MaterialInspection) {
    return this.exclusive(value.taskId, async () => {
      const task = this.manifest.tasks.find(item => item.id === value.taskId);
      const state = this.manifest.states[value.taskId], spec = this.attempts.get(value.attemptId);
      safeId(value.inspectionId);
      if (!task || !state || state.status !== "running" || state.attemptId !== value.attemptId || !spec ||
        spec.inputRevision !== (state.revision || 1) || this.deadline(spec) < Date.now())
        throw new HttpError(409, "Attempt is cancelled, expired, or superseded");
      if (!Number.isSafeInteger(value.contentSubmissions) || value.contentSubmissions <= (spec.recovery?.contentSubmissions ?? 0) ||
        value.contentSubmissions > (spec.recovery?.contentSubmissions ?? 0) + 1 + spec.policy.repairAttempts)
        throw new HttpError(400, "Invalid shared content submission count");
      this.validateAudit(spec, value.audit);
      const binding = this.bindings.get(spec.attemptId)!;
      let canonicalValue: JsonObject;
      try { canonicalValue = this.services.agents.resolveInspection(binding, value.value, value.audit); }
      catch (error) { this.registerValidationReads(spec, error); throw error; }
      const checkpoint = { id: value.inspectionId, value: canonicalValue,
        proof: { traceReads: structuredClone(value.audit.traceReads), viewedImages: [...value.audit.viewedImages] } };
      const previous = state.failure?.inspection;
      if (!previous && value.contentSubmissions <= Math.max(spec.recovery?.contentSubmissions ?? 0, state.failure?.contentSubmissions ?? 0))
        throw new HttpError(400, "Inspection must advance the shared content submission count");
      if (previous && canonical(previous) !== canonical(checkpoint))
        throw new HttpError(409, "A successful inspection cannot be replaced after revealing conclusions");
      if (!previous) this.validateBank(spec, value.audit.evidenceBank, state.failure?.evidenceBank ?? spec.evidenceBank);
      const evidenceBank = [...(previous ? state.failure!.evidenceBank! : value.audit.evidenceBank!)];
      const revealed = this.services.agents.inspectCanonical(binding, checkpoint.value, value.audit);
      const material = this.services.agents.projectMaterial(binding, revealed, evidenceBank);
      this.validateBank(spec, evidenceBank, previous ? state.failure!.evidenceBank! : value.audit.evidenceBank!);
      if (!previous) {
        state.failure = { errors: [], contentSubmissions: value.contentSubmissions, fileErrors: state.failure?.fileErrors ?? 0,
          repeatedErrors: 0, stopped: false, attemptId: value.attemptId, inspection: checkpoint, evidenceBank };
        await this.save(value.taskId);
      }
      return { inspection: checkpoint, material, evidenceBank };
    });
  }
  private registerValidationReads(spec: AttemptSpec, error: unknown): void {
    if (!(error instanceof ValidationError)) return;
    const reads = validationRequiredReads(error.issues ?? []);
    if (!reads.length) return;
    const updated = { ...spec, evaluation: { ...spec.evaluation, requiredReads: reads } };
    const sources = this.evidenceSources.get(spec.attemptId)!;
    const ranges = extendRequiredReadRanges(requiredReadRanges(spec, sources), requiredReadRanges(updated, sources));
    spec.evaluation = { ...spec.evaluation, requiredReads: ranges.map(range => range.target) };
  }
  private validateAudit(spec: AttemptSpec, audit: ToolAudit): void {
    this.validateBank(spec, audit?.evidenceBank);
    const required = requiredReadRanges(spec, this.evidenceSources.get(spec.attemptId)!);
    if (
      !audit ||
      !Number.isSafeInteger(audit.calls) ||
      audit.calls < 0 ||
      !Number.isSafeInteger(audit.requiredReadCalls) || audit.requiredReadCalls < 0 ||
      audit.requiredReadCalls > audit.calls ||
      audit.requiredReadCalls > availableRequiredReadCalls(audit.traceReads, required) ||
      audit.requiredReadCalls > required.reduce((sum, range) => sum + requiredReadCallLimit([range], spec.policy.maxOutputChars, toolBudgetMetadataChars(spec.evaluation.toolNames)), 0) ||
      audit.calls - audit.requiredReadCalls > spec.policy.maxToolCalls + 3 * spec.policy.repairAttempts +
        Number(spec.evaluation.fileSubmission || Boolean(spec.evaluation.inspectionSchema)) * (1 + spec.policy.repairAttempts) ||
      !Array.isArray(audit.viewedImages) ||
      !Array.isArray(audit.traceReads) ||
      audit.traceReads.some((read) => !read ||
        typeof read.candidate !== "string" || !spec.inputs.some((input) => input.name === read.candidate) ||
        !Number.isSafeInteger(read.message_index) || read.message_index < 0 ||
        (read.kind !== "text" && read.kind !== "json") || typeof read.path !== "string" ||
        (read.kind === "json" && read.path !== "") ||
        !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end <= read.start) ||
      !Array.isArray(audit.calculations) ||
      !Array.isArray(audit.artifacts) ||
      !validTableChecks(audit.tableChecks, spec.inputs)
    )
      throw new HttpError(400, "Invalid tool audit");
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
      this.deadline(spec) < Date.now()
    )
      throw new HttpError(409, "Attempt is cancelled, expired, or superseded");
    this.validateAudit(spec, value.audit);
    this.validateBank(spec, value.audit.evidenceBank, state.failure?.evidenceBank ?? spec.evidenceBank);
    if (spec.evaluation.inspectionSchema && !state.failure?.inspection)
      throw new ValidationError([{ category: "decision", code: "inspection_required", path: "/",
        message: "先调用 inspect_material 独立核查当前原材料；成功揭示判词后再提交最终核验。",
        expected: { next_action: "inspect_material" } }]);
    if (spec.evaluation.inspectionSchema && canonical(state.failure!.inspection) !== canonical(value.audit.inspection))
      throw new ValidationError([{ category: "interruption", code: "inspection_checkpoint_mismatch", path: "/audit/inspection",
        message: "Worker 未保留已经成功的原材料核查 checkpoint；须从 Host 已保存状态恢复，模型不需复制或修补 checkpoint。" }]);
    if (spec.evaluation.inspectionSchema && (!Number.isSafeInteger(value.submissionStats?.contentSubmissions) ||
      value.submissionStats!.contentSubmissions <= (state.failure?.contentSubmissions ?? 0) ||
      value.submissionStats!.contentSubmissions > (spec.recovery?.contentSubmissions ?? 0) + 1 + spec.policy.repairAttempts))
      throw new HttpError(422, "材料核查与最终提交必须共用本次剩余内容预算，最终提交仍计一稿");
    let evaluation: unknown;
    const validationStarted = performance.now(), validationCpu = process.cpuUsage();
    try {
      const binding = this.bindings.get(spec.attemptId)!;
      evaluation = this.services.agents.resolve(binding, value.evaluation, value.audit);
      this.services.agents.validate(binding, evaluation, value.audit,{rules:!spec.evaluation.resolveValidatesResult});
    } catch (error) {
      this.registerValidationReads(spec, error);
      throw error;
    } finally {
      const cpu = process.cpuUsage(validationCpu);
      void this.services.logger?.event?.("submission_validation", { component: "host", run_id: this.manifest.runId,
        task_id: value.taskId, attempt_id: value.attemptId, submission_id: value.submissionId,
        message: value.submissionId,
        validationMs: performance.now() - validationStarted, validationCpuMs: (cpu.user + cpu.system) / 1000 });
    }
    const incompleteDependencies = [...new Set(Object.values(task.dependencies).flatMap(id =>
      this.committedReceipts[id] ? this.committedReceipts[id].incompleteDependencies ?? [] : [id]))];
    const receipt: SubmissionReceipt = {
      ...value,
      evaluation,
      submitted: structuredClone(value.evaluation),
      evaluatorVersion: this.manifest.evaluatorVersion,
      judge: spec.model.model,
      status: "succeeded",
      acceptedAt: Date.now(),
      ...(incompleteDependencies.length ? { incompleteDependencies } : {}),
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
    const addedIds: string[] = [], changedTasks: PlannedTask[] = [];
    let scopeChanged = false;
    try {
      const advance = this.services.taskSource.advance?.(task, receipt, this.state, this.inputs);
      for (const replacement of advance?.replace ?? []) {
        const index = this.manifest.tasks.findIndex((item) => item.id === replacement.id);
        if (index < 0 || this.manifest.states[replacement.id].status === "running")
          throw new Error("Cannot replace an unknown or running task");
        this.manifest.tasks[index] = replacement;
        changedTasks.push(replacement);
      }
      for (const next of advance?.tasks ?? []) {
        if (this.manifest.states[next.id]) throw new Error("Duplicate follow-up task");
        this.manifest.tasks.push(next);
        changedTasks.push(next);
        addedIds.push(next.id);
        this.manifest.states[next.id] = { status: "pending", attempts: 0, revision: 1 };
        if (this.manifest.executionScope?.includes(task.id)) {
          this.manifest.executionScope.push(next.id);
          scopeChanged = true;
        }
      }
      const states: Record<string, TaskState> = { [task.id]: structuredClone(state) };
      for (const id of addedIds) states[id] = structuredClone(this.manifest.states[id]);
      try {
        // The manifest is already durable in the checkpoint; a receipt only owns
        // the scope extension it made. Never copy immutable config or plan indexes
        // into every acceptance.
        this.journal.append({
          at: Date.now(),
          ...(scopeChanged ? { manifest: { executionScope: [...this.manifest.executionScope!] } } : {}),
          ...(changedTasks.length ? { tasks: changedTasks } : {}),
          states, receipts: { [task.id]: structuredClone(receipt) },
        });
        if (this.directMode) await this.persistCheckpoint();
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint/i.test(error.message))
          throw new HttpError(409, "Submission ID already belongs to another task");
        throw error;
      }
    } catch (error) {
      delete this.state.receipts[task.id];
      state.status = "running";
      state.failure = failure;
      state.repeatedErrors = repeatedErrors;
      this.manifest.tasks = previousTasks;
      this.manifest.executionScope = previousScope;
      for (const id of addedIds) delete this.manifest.states[id];
      throw error;
    }
    this.committedReceipts[task.id] = receipt;
    if (this.outboxStarted) void this.flushOutbox();
    this.attempts.delete(value.attemptId);
    this.evidenceSources.delete(value.attemptId);
    this.bindings.delete(value.attemptId);
    return receipt;
  }
}
