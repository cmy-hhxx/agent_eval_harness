import { setTimeout as delay } from "node:timers/promises";
import { errorText, RemoteInputNotReadyError, type PublicationCounts, type RemoteDay } from "@eval/contracts";
import { nextPublicationAt, PUBLICATION_INTERVAL_MS, type MongoPublicationState, type MongoReceipt, type PublicationState } from "./publication.js";
export * from "./publication.js";

export interface StageCounts {
  total: number; completed: number; failed: number; pending: number; running: number; cancelled: number; blocked: number;
}
export interface EvaluationSummary {
  stages: Record<string, StageCounts>;
  skipped: number;
  issues: number;
  readyComparisons: number;
}
export interface EvaluationOutcome {
  status: "completed" | "waiting_inputs" | "retry" | "blocked";
  summary: EvaluationSummary;
  error?: string;
  /** Transport/outage failures continue with a cooldown after the normal retry budget. */
  transient?: boolean;
}
export interface AutomationJob {
  date: string;
  runIds: string[];
  observed: RemoteDay["rows"];
  downloaded?: RemoteDay["rows"];
  /** Last successful catalog check; unknown until the first poll of this process. */
  sourceReady?: boolean;
  /** Explicitly adopted historical delivery. No backfill while its counts are unchanged. */
  adopted: boolean;
  download: "pending" | "downloading" | "installing" | "ready" | "retry";
  evaluation: "pending" | "evaluating" | "completed" | "waiting_inputs" | "retry" | "blocked";
  checkedAt: number;
  inputsUpdatedAt?: number;
  downloadAttempts: number;
  evaluationAttempts: number;
  nextDownloadAt: number;
  nextEvaluationAt: number;
  bytes?: number;
  downloadError?: string;
  evaluationError?: string;
  summary?: EvaluationSummary;
  resumePaused?: boolean;
  mongo?: MongoPublicationState;
  mongoHistory?: MongoReceipt[];
}
export interface AutomationState {
  id: string;
  sourceUrl: string;
  status: "running" | "stopped";
  startedAt: number;
  updatedAt: number;
  lastPollAt?: number;
  pollError?: string;
  reportError?: string;
  publication?: PublicationState;
  publicationHistory?: PublicationState[];
  jobs: Record<string, AutomationJob>;
}
export interface PipelineOptions {
  fromDate: string;
  throughDate?: string;
  pollMs: number;
  refreshMs: number;
  retryMs: number;
  maxEvaluationAttempts: number;
  once?: boolean;
}
export interface PipelineServices {
  discover(signal: AbortSignal): Promise<RemoteDay[]>;
  initialize(day: RemoteDay): Promise<Pick<AutomationJob, "runIds" | "adopted" | "summary">>;
  sync(job: AutomationJob, day: RemoteDay, signal: AbortSignal, beforeReplace: () => Promise<void>): Promise<{ changed: boolean; bytes: number }>;
  evaluate(job: AutomationJob, signal: AbortSignal): Promise<EvaluationOutcome>;
  recover?(job: AutomationJob): Promise<"interrupted" | "transient" | undefined>;
  save(state: AutomationState): Promise<void>;
  event(name: string, job?: AutomationJob, detail?: string): Promise<void>;
  observe?(state: AutomationState, signal: AbortSignal): Promise<void>;
  publish?(state: AutomationState, save: () => Promise<void>, signal: AbortSignal): Promise<void>;
  syncMongo?(job: AutomationJob, signal: AbortSignal): Promise<PublicationCounts>;
}
export const sameRows = (a: RemoteDay["rows"] | undefined, b: RemoteDay["rows"]) =>
  !!a && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((model) => a[model] === b[model]);

export const automationDateSelected = (options: Pick<PipelineOptions, "fromDate" | "throughDate">, date: string) =>
  date >= options.fromDate && (!options.throughDate || date <= options.throughDate);

function refreshInterval(job: AutomationJob, now: number, recentInterval: number): number {
  const day = 24 * 60 * 60_000;
  const oldestRecentDate = new Date(now + 8 * 60 * 60_000 - 2 * day).toISOString().slice(0, 10);
  const settled = ["completed", "waiting_inputs"].includes(job.evaluation) && job.summary &&
    !job.summary.issues && Object.values(job.summary.stages).every(stage => stage.completed === stage.total);
  return settled && job.date < oldestRecentDate ? Math.max(recentInterval, day) : recentInterval;
}

/** Independent download, evaluation, Mongo and log lanes. Each run uses Host task concurrency.
 * Polling continues independently; a date's sources never change while it is evaluated. */
export async function runPipeline(
  state: AutomationState, options: PipelineOptions, services: PipelineServices, signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController(), activeSignal = AbortSignal.any([signal, controller.signal]);
  let writes = Promise.resolve();
  const save = () => {
    state.updatedAt = Date.now();
    const snapshot = structuredClone(state);
    const next = writes.then(() => services.save(snapshot));
    writes = next;
    return next;
  };
  const backoff = (attempt: number) => Math.min(options.retryMs * 2 ** Math.min(attempt - 1, 10), 30 * 60_000);
  const activeJobs = () => Object.values(state.jobs).filter(job => automationDateSelected(options, job.date));
  for (const job of activeJobs()) {
    delete job.sourceReady;
    if (!job.adopted && services.recover) {
      try {
        const recovery = await services.recover(job);
        if (recovery === "interrupted") job.evaluation = "pending";
        else if (recovery === "transient" && job.evaluation === "blocked") {
          job.evaluation = "retry";
          job.nextEvaluationAt = Math.max(job.nextEvaluationAt, Date.now() +
            (job.evaluationAttempts >= options.maxEvaluationAttempts ? 30 * 60_000 : backoff(job.evaluationAttempts)));
        }
      } catch (error) {
        job.evaluation = "blocked";
        job.evaluationError = errorText(error);
      }
    }
    if (job.download === "downloading" || job.download === "installing") {
      // A crash may have interrupted the multi-file promotion; force resync and reconciliation.
      job.download = "pending";
      if (job.evaluation !== "blocked") job.evaluation = "pending";
    }
    if (job.evaluation === "evaluating" || job.evaluation === "pending") {
      job.evaluation = "pending";
      job.evaluationAttempts = 0;
      job.nextEvaluationAt = 0;
      delete job.evaluationError;
    }
    if (job.mongo?.status === "running") {
      job.mongo.status = "pending";
      job.mongo.nextAt = 0;
      job.mongo.attempts = 0;
      delete job.mongo.error;
    }
  }
  if (state.publication?.log?.status === "sending") {
    state.publication.log.status = "uncertain";
    state.publication.status = "uncertain";
    state.publication.error = "Interrupted log upload: verify the server receipt before resolving";
  } else if (state.publication?.status === "running") state.publication.status = "retry";
  state.status = "running";
  state.startedAt = Date.now();
  await save();
  await services.event("pipeline_started");
  let nextPoll = 0, nextObserve = 0, polls = 0, pollFailures = 0;
  let polling: Promise<void> | undefined, downloading: Promise<void> | undefined;
  let evaluating: Promise<void> | undefined, observing: Promise<void> | undefined;
  let publishing: Promise<void> | undefined, syncingMongo: Promise<void> | undefined;
  let fatal: unknown;
  const guarded = (operation: Promise<void>, done: () => void) =>
    operation.catch((error) => { fatal = error; controller.abort(error); }).finally(done);

  async function poll() {
    try {
      const days = (await services.discover(activeSignal)).filter(day => automationDateSelected(options, day.date));
      const ready = new Set(days.map((day) => day.date));
      for (const job of activeJobs()) job.sourceReady = ready.has(job.date);
      const failures: string[] = [];
      for (const day of days) {
        let job = state.jobs[day.date];
        if (!job) {
          let initial: Awaited<ReturnType<PipelineServices["initialize"]>>;
          try { initial = await services.initialize(day); }
          catch (error) {
            failures.push(`${day.date}: ${errorText(error)}`);
            continue;
          }
          job = state.jobs[day.date] = {
            ...initial, date: day.date, observed: day.rows, sourceReady: true,
            download: initial.adopted ? "ready" : "pending",
            evaluation: initial.adopted ? "completed" : "pending",
            ...(initial.adopted ? { downloaded: day.rows } : {}),
            checkedAt: initial.adopted ? Date.now() : 0,
            downloadAttempts: 0, evaluationAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0,
          };
          await services.event(initial.adopted ? "historical_adopted" : "input_discovered", job);
        } else job.observed = day.rows;
      }
      state.lastPollAt = Date.now();
      if (failures.length) {
        state.pollError = failures.join("\n");
        nextPoll = Date.now() + backoff(++pollFailures);
        await services.event("discovery_failed", undefined, state.pollError);
      } else {
        delete state.pollError;
        pollFailures = 0;
        nextPoll = Date.now() + options.pollMs;
      }
    } catch (error) {
      if (!activeSignal.aborted) {
        state.pollError = errorText(error);
        nextPoll = Date.now() + backoff(++pollFailures);
        await services.event("poll_failed", undefined, state.pollError);
      }
    }
    polls++;
    await save();
  }

  async function sync(job: AutomationJob) {
    const day: RemoteDay = { date: job.date, rows: { ...job.observed } };
    const hadReadySnapshot = job.download === "ready";
    let replacing = false;
    job.download = "downloading";
    job.downloadAttempts++;
    delete job.downloadError;
    job.nextDownloadAt = 0;
    await save();
    await services.event("download_started", job);
    try {
      const result = await services.sync(job, day, activeSignal, async () => {
        replacing = true;
        job.download = "installing";
        await save();
      });
      job.downloaded = day.rows;
      job.download = "ready";
      job.checkedAt = Date.now();
      job.bytes = result.bytes;
      job.downloadAttempts = 0;
      job.nextDownloadAt = 0;
      delete job.downloadError;
      if (result.changed) {
        job.inputsUpdatedAt = Date.now();
        job.adopted = false;
        if (job.evaluation === "blocked") job.resumePaused = true;
        job.evaluation = "pending";
        job.evaluationAttempts = 0;
        job.nextEvaluationAt = 0;
        delete job.evaluationError;
      }
      await save();
      await services.event(result.changed ? "input_updated" : "input_unchanged", job);
    } catch (error) {
      job.download = hadReadySnapshot && !replacing ? "ready" : activeSignal.aborted ? "pending" : "retry";
      if (activeSignal.aborted) {
        job.downloadAttempts = 0; job.nextDownloadAt = 0;
        delete job.downloadError;
      } else if (error instanceof RemoteInputNotReadyError) {
        job.sourceReady = false;
        job.download = hadReadySnapshot ? "ready" : "pending";
        job.downloadAttempts = 0;
        job.nextDownloadAt = Date.now() + options.pollMs;
        delete job.downloadError;
      } else {
        job.downloadError = errorText(error);
        job.nextDownloadAt = Date.now() + backoff(job.downloadAttempts);
      }
      await save();
      if (!activeSignal.aborted) await services.event(error instanceof RemoteInputNotReadyError ? "source_waiting" : "download_failed", job, job.downloadError);
    }
  }

  async function evaluate(job: AutomationJob) {
    const acceptedBefore = Object.values(job.summary?.stages ?? {}).reduce((count, stage) => count + stage.completed, 0);
    job.evaluation = "evaluating";
    job.evaluationAttempts++;
    delete job.evaluationError;
    await save();
    await services.event("evaluation_started", job);
    let transient = false;
    try {
      const result = await services.evaluate(job, activeSignal);
      job.summary = result.summary;
      job.evaluation = result.status;
      job.evaluationError = result.error;
      transient = result.transient === true;
      const acceptedNow = Object.values(result.summary.stages).reduce((count, stage) => count + stage.completed, 0);
      if (acceptedNow > acceptedBefore) job.evaluationAttempts = 1;
    } catch (error) {
      job.evaluation = "retry";
      job.evaluationError = errorText(error);
      if (!activeSignal.aborted && services.recover) {
        try { transient = (await services.recover(job)) !== undefined; }
        catch (error) { job.evaluationError += "; checkpoint: " + errorText(error); }
      }
    }
    if (activeSignal.aborted) {
      job.evaluation = "pending";
      job.evaluationAttempts = 0;
      job.nextEvaluationAt = 0;
      delete job.evaluationError;
    } else if (job.evaluation === "retry") {
      const exhausted = job.evaluationAttempts >= options.maxEvaluationAttempts;
      if (exhausted && !transient) job.evaluation = "blocked";
      job.nextEvaluationAt = Date.now() + (exhausted && transient ? 30 * 60_000 : backoff(job.evaluationAttempts));
    } else if (job.evaluation === "completed" || job.evaluation === "waiting_inputs") {
      job.evaluationAttempts = 0; job.nextEvaluationAt = 0;
      delete job.evaluationError;
    }
    await save();
    await services.event(`evaluation_${job.evaluation}`, job, job.evaluationError);
  }

  async function observe() {
    try { await services.observe?.(state, activeSignal); delete state.reportError; }
    catch (error) {
      if (!activeSignal.aborted) {
        state.reportError = errorText(error);
        await services.event("progress_failed", undefined, state.reportError);
      }
    }
    await save();
  }

  async function publish() {
    let delivery = state.publication!;
    if (delivery.window === undefined || delivery.status === "completed") {
      if (delivery.status === "completed") (state.publicationHistory ??= []).push(structuredClone(delivery));
      delivery = state.publication = { status: "pending", attempts: 0, nextAt: delivery.nextAt, startedAt: Date.now() };
      delivery.window = Math.floor(Date.now() / PUBLICATION_INTERVAL_MS) * PUBLICATION_INTERVAL_MS;
      delivery.traceId = `comparison-snapshot-${state.id}-${delivery.window}`;
    }
    delivery.status = "running";
    delivery.attempts++;
    await save();
    await services.event("publication_started");
    try {
      await services.publish!(state, save, activeSignal);
      delivery.status = "completed";
      delivery.completedAt = Date.now();
      delivery.nextAt = nextPublicationAt(Date.now());
      delivery.attempts = 0;
      delete delivery.error;
    } catch (error) {
      delivery.error = errorText(error);
      if (delivery.log?.status === "sending" || delivery.log?.status === "uncertain") {
        delivery.log.status = "uncertain";
        delivery.status = "uncertain";
      } else {
        delivery.status = "retry";
        delivery.nextAt = Date.now() + backoff(delivery.attempts);
      }
    }
    await save();
    await services.event(`publication_${delivery.status}`, undefined, delivery.error);
  }

  const mongoSource = (job: AutomationJob) => ({
    inputsUpdatedAt: job.inputsUpdatedAt ?? 0, comparisons: job.summary?.readyComparisons ?? 0,
  });
  async function syncMongo(job: AutomationJob) {
    const previous = job.mongo;
    if (previous?.status === "completed" && previous.counts && (previous.counts.inserted || previous.counts.updated))
      (job.mongoHistory ??= []).push({ startedAt: previous.startedAt!, completedAt: previous.completedAt!, counts: previous.counts });
    const source = mongoSource(job);
    const delivery: MongoPublicationState = job.mongo = { status: "running", attempts: (previous?.attempts ?? 0) + 1, nextAt: 0,
      synced: previous?.synced, verified: previous?.verified, startedAt: Date.now() };
    await save();
    await services.event("mongo_started", job);
    try {
      delivery.counts = await services.syncMongo!(job, activeSignal);
      delivery.completedAt = Date.now();
      delivery.synced = source;
      delivery.status = "completed";
      delivery.attempts = 0;
      delivery.nextAt = Date.now() + options.pollMs;
    } catch (error) {
      if (activeSignal.aborted) {
        delivery.status = "pending"; delivery.attempts = 0;
      } else {
        delivery.status = "retry";
        delivery.error = errorText(error);
        delivery.nextAt = Date.now() + backoff(delivery.attempts);
      }
    }
    await save();
    await services.event(`mongo_${delivery.status}`, job, delivery.error);
  }

  try {
    while (!activeSignal.aborted) {
      const now = Date.now();
      if (!polling && now >= nextPoll && (!options.once || polls === 0))
        polling = guarded(poll(), () => { polling = undefined; });
      // Let the first catalog check settle before an upload can pin stale inputs.
      if (polls === 0) { await polling; continue; }
      const jobs = activeJobs().sort((a, b) => a.date.localeCompare(b.date));
      if (services.publish && !state.publication) {
        state.publication = { status: "pending", attempts: 0, nextAt: nextPublicationAt(now) };
        await save();
      }
      // Once due, reserve the next idle download slot for the cumulative snapshot.
      if (!publishing && !downloading && services.publish && state.publication && state.publication.status !== "uncertain" &&
          now >= state.publication.nextAt && (!options.once || state.publication.status !== "retry"))
        publishing = guarded(publish(), () => { publishing = undefined; });
      if (!downloading && !publishing) {
        const job = [...jobs].sort((a, b) => Number(sameRows(a.downloaded, a.observed)) - Number(sameRows(b.downloaded, b.observed)) || a.checkedAt - b.checkedAt)
          .find((job) => job.sourceReady === true && job.mongo?.status !== "running" && job.evaluation !== "evaluating" && now >= job.nextDownloadAt &&
          ((!sameRows(job.downloaded, job.observed)) || job.download !== "ready" ||
            (!job.adopted && (job.downloadError || now - job.checkedAt >= refreshInterval(job, now, options.refreshMs)))) &&
          (!options.once || (job.download !== "retry" && !job.downloadError)));
        if (job) downloading = guarded(sync(job), () => { downloading = undefined; });
      }
      if (!evaluating) {
        const job = jobs.find((job) => job.download === "ready" &&
          (job.evaluation === "pending" || (!options.once && job.evaluation === "retry")) && now >= job.nextEvaluationAt);
        if (job) evaluating = guarded(evaluate(job), () => { evaluating = undefined; });
      }
      if (!observing && services.observe && now >= nextObserve) {
        nextObserve = now + 10_000;
        observing = guarded(observe(), () => { observing = undefined; });
      }
      if (!syncingMongo && services.syncMongo) {
        const job = jobs.find((job) => {
          if (job.adopted || job.download !== "ready" || now < (job.mongo?.nextAt ?? 0) ||
              (options.once && job.mongo?.status === "retry")) return false;
          const source = mongoSource(job), synced = job.mongo?.synced;
          return job.mongo?.status !== "completed" || !synced || source.inputsUpdatedAt !== synced.inputsUpdatedAt ||
            source.comparisons !== synced.comparisons;
        });
        if (job) syncingMongo = guarded(syncMongo(job), () => { syncingMongo = undefined; });
      }
      if (options.once && polls > 0 && !polling && !downloading && !evaluating && !publishing && !syncingMongo) break;
      await delay(100, undefined, { signal: activeSignal }).catch(() => {});
    }
  } finally {
    controller.abort();
    await Promise.all([polling, downloading, evaluating, observing, publishing, syncingMongo]);
    state.status = "stopped";
    await save();
    await services.event("pipeline_stopped");
  }
  if (fatal) throw fatal;
}
