import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { RemoteInputNotReadyError, type RemoteDay } from "@eval/contracts";
import { runPipeline, sameRows, nextPublicationAt, PUBLICATION_INTERVAL_MS, type AutomationState, type PipelineServices, type EvaluationSummary } from "./index.js";

test("input refresh compares every configured model and detects additions and removals", () => {
  const four = { a_fast: 1, b_fast: 1, a_expert: 1, b_expert: 1 };
  const six = { ...four, "6_luna": 1, "6.1sol": 1 };
  assert.equal(sameRows(four, six), false);
  assert.equal(sameRows(six, four), false);
  const changed = { ...six, "6.1sol": 2 };
  assert.equal(sameRows(six, changed), false);
  assert.equal(sameRows(six, { ...six }), true);
});

const REMOTE_MODELS = ["a_fast", "b_fast", "a_expert", "b_expert"];

const day = (date: string, rows = 1): RemoteDay => ({ date, rows: Object.fromEntries(REMOTE_MODELS.map((model) => [model, rows])) as RemoteDay["rows"] });
const fresh = (): AutomationState => ({ id: "test", sourceUrl: "http://test", status: "stopped", startedAt: 0, updatedAt: 0, jobs: {} });
const summary: EvaluationSummary = { stages: { rewrite: { total: 2, completed: 2, failed: 0, pending: 0, running: 0, cancelled: 0, blocked: 0 } }, skipped: 0, issues: 0, readyComparisons: 1 };
const options = { fromDate: "2026-09-01", pollMs: 100, refreshMs: 100_000, retryMs: 10, maxEvaluationAttempts: 2,
  mongoTarget: "test-collection" };

test("disabled refresh keeps collected inputs while evaluation continues and still downloads missing rows", async t => {
  const state = fresh(), date = "2026-10-19";
  await runPipeline(state, { ...options, once: true }, services({ discover: async () => [day(date)] }), t.signal);
  const job = state.jobs[date]; job.checkedAt = 0; job.downloadError = "previous redundant refresh failed";
  job.evaluation = "pending";
  let downloads = 0, evaluations = 0;
  const deps = services({ discover: async () => [day(date)],
    sync: async job => { downloads++; return { changed: true, bytes: 20, rows: job.observed }; },
    evaluate: async () => { evaluations++; return { status: "completed", summary }; },
  });
  const controller = new AbortController();
  await runPipeline(state, { ...options, refreshMs: Infinity }, { ...deps,
    event: async name => { if (name === "evaluation_completed") controller.abort(); },
  }, AbortSignal.any([t.signal, controller.signal]));
  assert.equal(downloads, 0); assert.equal(evaluations, 1);
  delete job.downloadError;
  await runPipeline(state, { ...options, refreshMs: Infinity, once: true }, {
    ...deps, discover: async () => [day(date, 2)],
  }, t.signal);
  assert.equal(downloads, 1);
  assert.equal(job.downloaded?.b_fast, 2);
});

test("date boundaries preserve saved history across recovery, polling and every delivery lane", async (t) => {
  const state = fresh(), historical = "2026-10-07", current = "2026-10-08", future = "2026-10-09";
  await runPipeline(state, { ...options, once: true }, services({
    discover: async () => [day(historical), day(current), day(future)],
  }), t.signal);
  for (const date of [historical, future]) {
    const job = state.jobs[date];
    job.evaluation = "pending";
    job.download = "installing";
    job.mongo = { status: "running", attempts: 1, nextAt: 0 };
    job.evaluationError = "saved failure";
  }
  state.jobs[current].evaluation = "pending";
  state.statistics = { attempts: 0, nextAt: 0 };
  const preserved = [historical, future].map(date => structuredClone(state.jobs[date]));
  const recovered: string[] = [], downloaded: string[] = [], evaluated: string[] = [], uploaded: string[] = [];
  let published = 0;
  await runPipeline(state, { ...options, fromDate: current, throughDate: current, once: true }, services({
    discover: async () => [day("2026-10-06"), day(historical, 2), day(current, 2), day(future, 2)],
    recover: async job => { recovered.push(job.date); return "interrupted"; },
    sync: async job => { downloaded.push(job.date); return { changed: true, bytes: 10, rows: job.observed }; },
    evaluate: async job => { evaluated.push(job.date); return { status: "completed", summary }; },
    syncMongo: async job => { uploaded.push(job.date); return { inputs: 8, comparisons: 1, inserted: 1, updated: 0 }; },
    publish: async snapshot => {
      published++;
      assert.deepEqual([historical, future].map(date => snapshot.jobs[date]), preserved,
        "cumulative statistics still receive the unchanged history");
      return { traceId: "history", generatedAt: Date.now() };
    },
  }), t.signal);
  for (const calls of [recovered, downloaded, evaluated, uploaded]) assert.deepEqual([...new Set(calls)], [current]);
  assert.equal(published, 1);
  assert.equal(state.jobs["2026-10-06"], undefined, "out-of-range discoveries are not registered");
  assert.deepEqual([historical, future].map(date => state.jobs[date]), preserved);
});

test("settled historical dates refresh daily while recent dates and changed counts remain responsive", async (t) => {
  const now = Date.parse("2026-10-08T16:05:00Z"); // October 9 in Beijing.
  t.mock.method(Date, "now", () => now);
  const dates = ["2026-10-06", "2026-10-07", "2026-10-08"];
  const state = fresh(), downloads: string[] = [];
  const deps = services({ discover: async () => dates.map(date => day(date)),
    sync: async (job) => { downloads.push(job.date); return { changed: true, bytes: 10, rows: job.observed }; } });
  await runPipeline(state, { ...options, once: true }, deps, t.signal);
  for (const job of Object.values(state.jobs)) job.checkedAt = now - 60 * 60_000;
  state.jobs[dates[0]].evaluation = "waiting_inputs";
  downloads.length = 0;
  await runPipeline(state, { ...options, once: true }, deps, t.signal);
  assert.deepEqual(downloads, dates.slice(1), "settled history must not compete with recent dates every refresh interval");
  downloads.length = 0;
  await runPipeline(state, { ...options, once: true }, { ...deps,
    discover: async () => dates.map((date, index) => day(date, index ? 1 : 2)),
  }, t.signal);
  assert.deepEqual(downloads, [dates[0]], "new historical rows bypass the daily refresh interval");
  state.jobs[dates[0]].checkedAt = now - 24 * 60 * 60_000;
  downloads.length = 0;
  await runPipeline(state, { ...options, once: true }, { ...deps,
    discover: async () => dates.map((date, index) => day(date, index ? 1 : 2)),
  }, t.signal);
  assert.deepEqual(downloads, [dates[0]], "same-count historical corrections still receive a full daily check");
});

test("a due statistics snapshot runs before the next queued download and records its schedule", async (t) => {
  const state = fresh(), order: string[] = [];
  let generatedAt = Date.now();
  const deps = services({ discover: async () => [day("2026-10-01"), day("2026-10-02")],
    publish: async () => { order.push("publish"); return { traceId: "snapshot-1", generatedAt: generatedAt++ }; },
    sync: async (job) => { order.push(job.date); return { changed: false, bytes: 10, rows: job.observed }; },
  });
  await runPipeline(state, { ...options, once: true }, deps, t.signal);
  state.statistics!.nextAt = 0;
  state.statistics!.lastWindow = Math.floor(Date.now() / PUBLICATION_INTERVAL_MS) * PUBLICATION_INTERVAL_MS - PUBLICATION_INTERVAL_MS;
  for (const job of Object.values(state.jobs)) job.checkedAt = 0;
  order.length = 0;
  await runPipeline(state, { ...options, once: true }, deps, t.signal);
  assert.deepEqual(order, ["publish", "2026-10-01", "2026-10-02"]);
  assert.equal(state.statistics!.lastTraceId, "snapshot-1");
  assert(state.statistics!.nextAt > Date.now());
});

test("statistics generation during a refresh does not wait for queued evaluation", async () => {
  const state = fresh(), date = "2026-09-29", controller = new AbortController();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  state.jobs[date].evaluation = "pending";
  state.statistics = { attempts: 0, nextAt: Date.now() + PUBLICATION_INTERVAL_MS,
    lastWindow: Math.floor(Date.now() / PUBLICATION_INTERVAL_MS) * PUBLICATION_INTERVAL_MS };
  let release!: () => void, publishedDuringRefresh = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = runPipeline(state, options, services({
    discover: async () => [day(date, 2)],
    sync: async (_job, remote, _signal, beforeReplace) => {
      state.statistics!.lastWindow = Math.floor(Date.now() / PUBLICATION_INTERVAL_MS) * PUBLICATION_INTERVAL_MS - PUBLICATION_INTERVAL_MS;
      state.statistics!.nextAt = 0;
      await held;
      await beforeReplace();
      return { changed: true, bytes: 10, rows: remote.rows };
    },
    evaluate: async () => { await held; return { status: "completed", summary }; },
    publish: async current => {
      if (current.jobs[date].download === "downloading") publishedDuringRefresh = true;
      return { traceId: "during-refresh", generatedAt: Date.now() };
    },
  }), controller.signal);
  try { await until(() => publishedDuringRefresh); }
  finally { release(); controller.abort(); await work; }
  assert(publishedDuringRefresh);
});

test("restart generates only one snapshot for the current four-hour window", async () => {
  const state = fresh();
  let publications = 0;
  const deps = services({ publish: async () => ({ traceId: `snapshot-${++publications}`, generatedAt: Date.now() }) });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  const first = structuredClone(state.statistics!);
  const restored = JSON.parse(JSON.stringify(state)) as AutomationState;
  await runPipeline(restored, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(publications, 1);
  assert.deepEqual(restored.statistics, first);
});

test("a failed statistics snapshot records an error and retry without blocking evaluation", async () => {
  const state = fresh();
  let calls = 0, evaluations = 0;
  const deps = services({
    evaluate: async () => { evaluations++; return { status: "completed", summary }; },
    publish: async () => {
      calls++;
      if (calls === 1) throw new Error("Mongo labels unavailable");
      return { traceId: "snapshot-recovered", generatedAt: Date.now() };
    },
  });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(evaluations, 1);
  assert.equal(state.statistics?.error, "Mongo labels unavailable");
  assert(Number.isFinite(state.statistics!.nextAt));
  state.statistics!.nextAt = 0;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(state.statistics?.lastTraceId, "snapshot-recovered");
});

test("a corrected input snapshot retries a paused date, while unchanged input preserves the pause", async () => {
  const state = fresh(); let count = 1, calls = 0;
  const deps = services({ discover: async () => [day("2026-09-29", count)],
    evaluate: async (job) => {
      calls++;
      if (calls === 1) return { status: "blocked", summary, error: "evidence invalid" };
      assert.equal(job.resumePaused, true);
      return { status: "completed", summary };
    },
  });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(calls, 1);
  count = 2;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(calls, 2);
  assert.equal(state.jobs["2026-09-29"].evaluationError, undefined);
});

test("a recoverable Host startup exception stays retryable after the ordinary attempt budget", async () => {
  const state = fresh(), controller = new AbortController();
  await runPipeline(state, { ...options, maxEvaluationAttempts: 1 }, services({
    evaluate: async () => { throw new Error("Worker exited before dispatch"); },
    recover: async () => "interrupted",
    save: async (saved) => {
      if (["retry", "blocked"].includes(saved.jobs["2026-09-29"]?.evaluation)) controller.abort();
    },
  }), controller.signal);
  assert.equal(state.jobs["2026-09-29"].evaluation, "retry");
  assert(state.jobs["2026-09-29"].nextEvaluationAt > Date.now());
});
const services = (overrides: Partial<PipelineServices> = {}): PipelineServices => ({
  discover: async () => [day("2026-09-29")], initialize: async (day) => ({ runIds: ["daily-" + day.date], adopted: false }),
  sync: async (job) => ({ changed: true, bytes: 10, rows: job.observed }), evaluate: async () => ({ status: "completed", summary }),
  save: async () => {}, event: async () => {}, ...overrides,
});

test("once mode records a newer complete response without repeatedly downloading the old catalog observation", async () => {
  const state = fresh();
  let downloads = 0;
  await runPipeline(state, { ...options, once: true }, services({
    sync: async (_job, current) => {
      downloads++;
      return { changed: true, bytes: 20, rows: day(current.date, 2).rows };
    },
  }), AbortSignal.timeout(3000));
  assert.equal(downloads, 1);
  assert.deepEqual(state.jobs["2026-09-29"].downloaded, day("2026-09-29", 2).rows);
  assert.deepEqual(state.jobs["2026-09-29"].observed, day("2026-09-29", 2).rows);
});

async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error("Timed out waiting for pipeline"); await delay(5); }
}

test("polling and next-date download continue during evaluation; active inputs cannot be replaced", async () => {
  const state = fresh(), controller = new AbortController();
  const first = "2026-09-28", second = "2026-09-29";
  let rows = 1, runningFirst = false, secondDownloaded = false, polls = 0, firstRuns = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const work = runPipeline(state, options, services({
    discover: async () => { polls++; return [day(first, rows), day(second)]; },
    sync: async (job, downloadedDay, _signal, beforeReplace) => {
      await beforeReplace();
      if (job.date === first) assert(!runningFirst);
      else secondDownloaded = true;
      return { changed: true, bytes: 10, rows: downloadedDay.rows };
    },
    evaluate: async (job) => {
      if (job.date === first && firstRuns++ === 0) { runningFirst = true; await gate; runningFirst = false; }
      return { status: "completed", summary };
    },
  }), AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
  try {
    await until(() => runningFirst);
    rows = 2;
    await until(() => secondDownloaded && polls >= 3);
    assert.equal(state.jobs[first].downloaded!.a_fast, 1);
    release();
    await until(() => firstRuns === 2 && state.jobs[second].evaluation === "completed");
    assert.equal(state.jobs[first].downloaded!.a_fast, 2);
  } finally { release(); controller.abort(); await work; }
});

test("explicit historical adoption skips downloads and evaluations across restart", async () => {
  const state = fresh(); let calls = 0;
  const deps = services({ initialize: async () => ({ runIds: ["existing"], adopted: true, summary }),
    sync: async () => { calls++; throw new Error("Must not download"); },
    evaluate: async () => { calls++; throw new Error("Must not re-evaluate"); } });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  state.jobs["2026-09-29"].checkedAt = 0;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(calls, 0);
  assert.equal(state.jobs["2026-09-29"].evaluation, "completed");
});

test("multiple dates evaluate concurrently while a failed date retries and completed dates stay accepted", async () => {
  const state = fresh(), controller = new AbortController();
  const first = "2026-09-27", retry = "2026-09-28", other = "2026-09-29";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: Record<string, number> = {};
  const work = runPipeline(state, options, services({
    discover: async () => [day(first), day(retry), day(other)],
    evaluationConcurrency: () => 3,
    evaluate: async current => {
      calls[current.date] = (calls[current.date] ?? 0) + 1;
      if (current.date === first) await gate;
      if (current.date === retry && calls[retry] === 1) return { status: "retry", summary, transient: true };
      return { status: "completed", summary };
    },
  }), AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
  try {
    await until(() => state.jobs[retry]?.evaluation === "completed" && state.jobs[other]?.evaluation === "completed");
    assert.equal(state.jobs[first].evaluation, "evaluating");
    assert.deepEqual(calls, { [first]: 1, [retry]: 2, [other]: 1 });
  } finally { release(); controller.abort(); await work; }
});

test("recovery resynchronizes interrupted promotion and resumes the same run ID", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.download = "installing"; job.evaluation = "evaluating";
  const order: string[] = [];
  await runPipeline(state, { ...options, once: true }, services({
    sync: async (job) => { order.push("sync"); return { changed: false, bytes: 10, rows: job.observed }; },
    evaluate: async (job) => { order.push(job.runIds[0]); return { status: "completed", summary }; },
  }), AbortSignal.timeout(3000));
  assert.deepEqual(order, ["sync", "daily-2026-09-29"]);
});

test("interrupted installed inputs recover before routine refreshes can delay statistics", async () => {
  const state = fresh(), dates = ["2026-09-28", "2026-09-29"], order: string[] = [];
  const deps = services({ discover: async () => dates.map(date => day(date)) });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  state.jobs[dates[1]].download = "pending";
  for (const job of Object.values(state.jobs)) job.checkedAt = 0;
  await runPipeline(state, { ...options, once: true }, { ...deps,
    sync: async job => { order.push(job.date); return { changed: false, bytes: 10, rows: job.observed }; },
  }, AbortSignal.timeout(3000));
  assert.deepEqual(order, [...dates].reverse());
});

test("interrupted refresh retains the installed snapshot for startup statistics", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.download = "downloading";
  let published = false;
  await runPipeline(state, { ...options, once: true }, services({
    sync: async () => { throw new Error("Unchanged installed inputs should remain usable"); },
    publish: async () => { assert.equal(job.download, "ready"); published = true;
      return { traceId: "recovered", generatedAt: Date.now() }; },
  }), AbortSignal.timeout(3000));
  assert(published);
});

test("statistics retry immediately after input recovery without reading the interrupted installation", async () => {
  const state = fresh(), date = "2026-09-29", controller = new AbortController();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  state.jobs[date].download = "pending";
  state.statistics = { attempts: 5, nextAt: Date.now() + PUBLICATION_INTERVAL_MS };
  let finishDownload!: () => void;
  const held = new Promise<void>(resolve => { finishDownload = resolve; });
  let transferring = false, recovered = false, publications = 0;
  const work = runPipeline(state, { ...options, retryMs: 60_000 }, services({
    evaluationConcurrency: () => 0,
    sync: async (job, _day, _signal, beforeReplace) => {
      transferring = true; await held; await beforeReplace(); recovered = true;
      return { changed: false, bytes: 10, rows: job.observed };
    },
    publish: async current => {
      publications++;
      if (!recovered) throw new Error("Installed input snapshot requires recovery");
      assert.equal(current.jobs[date].download, "ready");
      return { traceId: "recovered-input", generatedAt: Date.now() };
    },
  }), controller.signal);
  try {
    await until(() => transferring);
    assert.equal(state.jobs[date].download, "installing");
    const before = publications;
    await delay(250);
    assert.equal(publications, before, "do not read old files during recovery transfer");
    finishDownload();
    await until(() => state.statistics?.lastTraceId === "recovered-input");
    assert.equal(publications, before + 1);
  } finally { finishDownload(); controller.abort(); await work; }
});

test("input promotion waits for an already-running statistics snapshot", async () => {
  const state = fresh(), date = "2026-09-29", controller = new AbortController();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  state.statistics = { attempts: 0, nextAt: Date.now() + PUBLICATION_INTERVAL_MS,
    lastWindow: Math.floor(Date.now() / PUBLICATION_INTERVAL_MS) * PUBLICATION_INTERVAL_MS };
  let downloadReady!: () => void, finishLog!: () => void;
  const downloadGate = new Promise<void>(resolve => { downloadReady = resolve; });
  const logGate = new Promise<void>(resolve => { finishLog = resolve; });
  let logRunning = false, promotionAttempted = false, promoted = false;
  const work = runPipeline(state, options, services({
    discover: async () => [day(date, 2)],
    evaluationConcurrency: () => 0,
    sync: async (_job, remote, _signal, beforeReplace) => {
      state.statistics!.lastWindow = Math.floor(Date.now() / PUBLICATION_INTERVAL_MS) * PUBLICATION_INTERVAL_MS - PUBLICATION_INTERVAL_MS;
      state.statistics!.nextAt = 0;
      await downloadGate;
      promotionAttempted = true;
      await beforeReplace(); promoted = true;
      return { changed: true, bytes: 20, rows: remote.rows };
    },
    publish: async current => {
      if (current.jobs[date].download === "downloading") { logRunning = true; await logGate; }
      return { traceId: "promotion", generatedAt: Date.now() };
    },
  }), controller.signal);
  try {
    await until(() => logRunning); downloadReady();
    await until(() => promotionAttempted); await delay(150);
    assert.equal(promoted, false);
    finishLog(); await until(() => promoted);
  } finally { finishLog(); downloadReady(); controller.abort(); await work; }
});

test("failed evaluation is bounded and does not block later dates; rewrite failure is not completion", async () => {
  const state = fresh(), controller = new AbortController(); let attempts = 0;
  await runPipeline(state, options, services({
    discover: async () => [day("2026-09-28"), day("2026-09-29")],
    evaluate: async (job) => {
      if (job.date === "2026-09-28") {
        attempts++;
        return { status: "retry", summary: { ...summary, stages: { rewrite: { ...summary.stages.rewrite, completed: 1, failed: 1 } } }, error: "rewrite failed" };
      }
      return { status: "completed", summary };
    },
    save: async (snapshot) => {
      if (snapshot.jobs["2026-09-28"]?.evaluation === "blocked" && snapshot.jobs["2026-09-29"]?.evaluation === "completed") controller.abort();
    },
  }), AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
  assert.equal(attempts, 2);
  assert.equal(state.jobs["2026-09-28"].evaluation, "blocked");
  assert.equal(state.jobs["2026-09-28"].evaluationError, "rewrite failed");
  assert.equal(state.jobs["2026-09-29"].evaluation, "completed");
});

test("periodic content refresh schedules work even when row counts stay unchanged", async () => {
  const state = fresh(); let evaluations = 0;
  const deps = services({ evaluate: async () => { evaluations++; return { status: "completed", summary }; } });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  state.jobs["2026-09-29"].checkedAt = 0;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(evaluations, 2);
  state.jobs["2026-09-29"].checkedAt = 0;
  await runPipeline(state, { ...options, once: true }, { ...deps, sync: async (job) => ({ changed: false, bytes: 10, rows: job.observed }) }, AbortSignal.timeout(3000));
  assert.equal(evaluations, 2);
});

test("cancelling a refresh keeps the previously installed inputs ready", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"], controller = new AbortController();
  job.checkedAt = 0;
  await runPipeline(state, options, services({ sync: async (job) => {
    controller.abort(new Error("Automation stopped"));
    controller.signal.throwIfAborted();
    return { changed: false, bytes: 0, rows: job.observed };
  } }), controller.signal);
  assert.equal(job.download, "ready");
  assert.equal(job.downloadError, undefined);
  assert.equal(job.downloaded!.a_fast, 1);
  assert.equal(job.evaluation, "completed");
});

test("refresh failures preserve usable inputs, but interrupted replacement requires resynchronization", async () => {
  for (const replacement of [false, true]) {
    const state = fresh();
    await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
    const job = state.jobs["2026-09-29"];
    job.checkedAt = 0;
    await runPipeline(state, { ...options, once: true }, services({ sync: async (_job, _day, _signal, beforeReplace) => {
      if (replacement) { await beforeReplace(); assert.equal(job.download, "installing"); }
      throw new Error(replacement ? "rename failed" : "connection lost");
    } }), AbortSignal.timeout(3000));
    assert.equal(job.download, replacement ? "retry" : "ready");
    assert.equal(job.downloadError, replacement ? "rename failed" : "connection lost");
    assert.equal(job.downloaded!.a_fast, 1);
  }
});

test("downloads require a fresh ready catalog and clear obsolete retry state when they start", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.checkedAt = 0;
  let downloads = 0;
  const deps = services({ sync: async (active) => {
    downloads++;
    assert.equal(active.downloadError, undefined);
    assert.equal(active.nextDownloadAt, 0);
    return { changed: false, bytes: 10, rows: active.observed };
  } });
  await runPipeline(state, { ...options, once: true }, { ...deps, discover: async () => [] }, AbortSignal.timeout(3000));
  assert.equal(downloads, 0, "an unready date must not download using yesterday's catalog state");
  job.downloadError = "old timeout"; job.nextDownloadAt = 1;
  const controller = new AbortController();
  await runPipeline(state, options, { ...deps, save: async (snapshot) => {
    if (downloads && snapshot.jobs[job.date].download === "ready") controller.abort();
  } }, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
  assert.equal(downloads, 1);
  assert.equal(job.downloadError, undefined);
  assert.equal(job.nextDownloadAt, 0);
});

test("changed input dates download before routine checks, while other local backlogs keep evaluating", async () => {
  const state = fresh(), first = "2026-09-28", second = "2026-09-29";
  await runPipeline(state, { ...options, once: true }, services({
    discover: async () => [day(first), day(second)],
  }), AbortSignal.timeout(3000));
  for (const job of Object.values(state.jobs)) job.checkedAt = 0;
  const downloads: string[] = [];
  await runPipeline(state, { ...options, once: true }, services({
    discover: async () => [day(first), day(second, 2)],
    sync: async (job) => { downloads.push(job.date); return { changed: true, bytes: 20, rows: job.observed }; },
  }), AbortSignal.timeout(3000));
  assert.equal(downloads[0], second, "new input must not wait behind a same-count routine check");

  state.jobs[second].evaluation = "pending";
  let release!: () => void, evaluated = false, downloading = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const work = runPipeline(state, options, services({
    discover: async () => [day(first, 3), day(second, 3)],
    sync: async (job) => { assert.equal(job.date, first); downloading = true; await gate; return { changed: true, bytes: 30, rows: job.observed }; },
    evaluate: async (job) => {
      // Both lanes start independently; let the download enter its held request before checking overlap.
      await until(() => downloading);
      assert.equal(job.date, second);
      assert.equal(job.downloaded!.a_fast, 2);
      assert.equal(job.observed.a_fast, 3);
      evaluated = true; controller.abort();
      return { status: "completed", summary };
    },
  }), controller.signal);
  try { await until(() => evaluated); }
  finally { controller.abort(); release(); await work; }
});

test("a ready-to-unready source race waits for the next catalog and resumes without a stale error", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.checkedAt = 0;
  let downloads = 0, waiting = false;
  const controller = new AbortController();
  await runPipeline(state, options, services({
    sync: async (job) => {
      if (downloads++ === 0) throw new RemoteInputNotReadyError("data not ready");
      return { changed: false, bytes: 10, rows: job.observed };
    },
    save: async (snapshot) => {
      const saved = snapshot.jobs[job.date];
      if (saved.sourceReady === false) {
        waiting = true;
        assert.equal(saved.download, "ready", "keep the installed snapshot usable");
        assert.equal(saved.downloadError, undefined);
        assert.equal(saved.downloadAttempts, 0);
      }
      if (downloads === 2 && saved.download === "ready") controller.abort();
    },
  }), AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
  assert(waiting); assert.equal(downloads, 2); assert.equal(job.sourceReady, true);
});

for (const returnsIncomplete of [false, true])
  test(`repeated shutdowns resume without errors or exhausted retries (returns incomplete: ${returnsIncomplete})`, async () => {
    let state = fresh();
    for (let stop = 0; stop <= options.maxEvaluationAttempts; stop++) {
      const controller = new AbortController(), events: { name: string; detail?: string }[] = [];
      const work = runPipeline(state, options, services({
        evaluate: async (_job, signal) => {
          try { await delay(10_000, undefined, { signal }); }
          catch (error) { if (!returnsIncomplete) throw error; }
          return { status: "retry", summary, error: "Some planned tasks remain incomplete (including rewrite/clustering)" };
        },
        event: async (name, _job, detail) => { events.push({ name, detail }); },
      }), controller.signal);
      try { await until(() => state.jobs["2026-09-29"]?.evaluation === "evaluating"); }
      finally { controller.abort(); await work; }
      const job = state.jobs["2026-09-29"];
      assert.equal(state.status, "stopped");
      assert.equal(job.evaluation, "pending");
      assert.equal(job.evaluationError, undefined);
      assert.equal(job.evaluationAttempts, 0);
      assert.equal(job.nextEvaluationAt, 0);
      assert.deepEqual(events.filter((event) => event.name === "evaluation_pending"), [{ name: "evaluation_pending", detail: undefined }]);
      state = JSON.parse(JSON.stringify(state));
    }
    await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
    assert.equal(state.jobs["2026-09-29"].evaluation, "completed");
    assert.deepEqual(state.jobs["2026-09-29"].runIds, ["daily-2026-09-29"]);
  });

for (const interrupted of ["pending", "evaluating"] as const)
  test(`restart clears interrupted ${interrupted} errors before saving or starting work`, async () => {
    const state = fresh();
    await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
    const job = state.jobs["2026-09-29"];
    job.evaluation = interrupted;
    job.evaluationError = "Some planned tasks remain incomplete (including rewrite/clustering)";
    job.evaluationAttempts = options.maxEvaluationAttempts;
    job.nextEvaluationAt = Date.now() + 60_000;
    const snapshots: AutomationState[] = [];
    let attempts = 0;
    await runPipeline(state, { ...options, once: true }, services({
      save: async (snapshot) => { snapshots.push(snapshot); },
      evaluate: async (current) => {
        attempts++;
        assert.equal(current.evaluationError, undefined);
        assert.equal(current.evaluationAttempts, 1);
        return { status: "completed", summary };
      },
    }), AbortSignal.timeout(3000));
    assert.equal(snapshots[0].jobs[job.date].evaluationError, undefined);
    assert.equal(snapshots[0].jobs[job.date].evaluationAttempts, 0);
    assert.equal(snapshots[0].jobs[job.date].nextEvaluationAt, 0);
    assert.equal(attempts, 1);
    assert.equal(job.evaluation, "completed");
  });

test("real evaluation failures retain their retry budget and blocked status across restarts", async () => {
  const state = fresh(); let attempts = 0;
  const deps = services({ evaluate: async (job) => {
    attempts++;
    assert.equal(job.evaluationError, undefined, "a new attempt must not display the previous error");
    return { status: "retry", summary, error: "rewrite failed" };
  } });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  assert.equal(job.evaluation, "retry");
  assert.equal(job.evaluationAttempts, 1);
  const controller = new AbortController();
  await runPipeline(state, options, services({ ...deps, save: async (snapshot) => {
    if (snapshot.jobs[job.date].evaluation === "blocked") controller.abort();
  } }), AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
  assert.equal(job.evaluation, "blocked");
  assert.equal(job.evaluationError, "rewrite failed");
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(job.evaluation, "blocked");
  assert.equal(attempts, options.maxEvaluationAttempts);
});

test("startup reconciles interrupted checkpoints even when the pipeline previously saved blocked", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.evaluation = "blocked"; job.evaluationAttempts = 3; job.evaluationError = "Host stage paused";
  let resumed = 0;
  const deps = { ...services({ evaluate: async (current) => {
    resumed++; assert.equal(current.evaluationAttempts, 1); assert.equal(current.evaluationError, undefined);
    return { status: "completed" as const, summary };
  } }), recover: async () => "interrupted" as const };
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(resumed, 1);
  assert.equal(job.evaluation, "completed");
});

test("temporary outages cool down instead of requiring manual recovery and retain the retry deadline on restart", async () => {
  const state = fresh(), controller = new AbortController();
  await runPipeline(state, { ...options, maxEvaluationAttempts: 1 }, services({
    evaluate: async () => ({ status: "retry", transient: true, summary, error: "transport/unavailable" }),
    save: async (snapshot) => { if (snapshot.jobs["2026-09-29"]?.evaluation === "retry") controller.abort(); },
  }), AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
  const job = state.jobs["2026-09-29"];
  assert.equal(job.evaluation, "retry");
  assert(job.nextEvaluationAt > Date.now() + 29 * 60_000);
  const deadline = job.nextEvaluationAt;
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  assert.equal(job.nextEvaluationAt, deadline);
  assert.equal(job.evaluationAttempts, 1);
  job.nextEvaluationAt = 0;
  const controller2 = new AbortController();
  await runPipeline(state, options, services({ save: async (snapshot) => {
    if (snapshot.jobs[job.date].evaluation === "completed") controller2.abort();
  } }), AbortSignal.any([controller2.signal, AbortSignal.timeout(3000)]));
  assert.equal(job.evaluation, "completed");
});

test("persisted outage pauses become scheduled retries without resetting their failure budget", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.evaluation = "blocked"; job.evaluationAttempts = 3;
  await runPipeline(state, { ...options, once: true }, services({ recover: async () => "transient",
    evaluate: async () => { throw new Error("Must wait for cooldown"); },
  }), AbortSignal.timeout(3000));
  assert.equal(job.evaluation, "retry");
  assert.equal(job.evaluationAttempts, 3);
  assert(job.nextEvaluationAt > Date.now() + 29 * 60_000);
});

test("one broken historical registration does not prevent discovery of later dates", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services({
    discover: async () => [day("2026-09-22"), day("2026-09-29")],
    initialize: async (day) => {
      if (day.date === "2026-09-22") throw new Error("Historical results are incomplete");
      return { runIds: ["daily-" + day.date], adopted: false };
    },
  }), AbortSignal.timeout(3000));
  assert.match(state.pollError!, /2026-09-22.*incomplete/);
  assert.equal(state.jobs["2026-09-29"].evaluation, "completed");
});

test("startup appends cumulative history and schedules the next four-hour snapshot", async () => {
  const state = fresh(); let publications = 0, evaluations = 0;
  const deps = services({
    discover: async () => [day("2026-09-22"), day("2026-09-30")],
    initialize: async (day) => ({ runIds: ["daily-" + day.date], adopted: day.date === "2026-09-22" }),
    evaluate: async () => { evaluations++; return { status: "completed", summary }; },
    publish: async () => ({ traceId: `snapshot-${++publications}`, generatedAt: Date.now() }),
  });
  assert.equal(nextPublicationAt(0), PUBLICATION_INTERVAL_MS);
  assert.equal(nextPublicationAt(PUBLICATION_INTERVAL_MS), PUBLICATION_INTERVAL_MS * 2);
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(publications, 1); assert.equal(state.jobs["2026-09-22"].evaluation, "completed");
  const deadline = state.statistics!.nextAt;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(state.statistics!.nextAt, deadline);
  assert.equal(publications, 1);
  state.statistics!.lastWindow! -= PUBLICATION_INTERVAL_MS; state.statistics!.nextAt = 0;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(publications, 2); assert.equal(evaluations, 1);
  assert.equal(state.statistics!.lastTraceId, "snapshot-2");
});

test("Mongo delivers inputs and newly settled outputs during evaluation without waiting for logs or resending unchanged work", async () => {
  const state = fresh(), controller = new AbortController(), date = "2026-09-29";
  let release = () => {}, mongoCalls = 0, logs = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps = services({
    discover: async () => [day("2026-09-22"), day(date)],
    initialize: async (item) => ({ runIds: ["daily-" + item.date], adopted: item.date === "2026-09-22" }),
    evaluate: async () => { await gate; return { status: "completed", summary }; },
    syncMongo: async (job) => {
      assert.equal(job.date, date);
      mongoCalls++;
      return { inputs: 4, comparisons: job.summary?.readyComparisons ?? 0, inserted: mongoCalls === 1 ? 4 : 1, updated: 0 };
    },
    publish: async () => { logs++; return { traceId: "mongo-cycle", generatedAt: Date.now() }; },
  });
  const work = runPipeline(state, options, deps, controller.signal);
  try {
    await until(() => state.jobs[date]?.mongo?.status === "completed");
    const job = state.jobs[date];
    assert.equal(job.evaluation, "evaluating");
    assert.equal(job.mongo!.counts!.comparisons, 0);
    job.summary = structuredClone(summary);
    await until(() => job.mongo?.counts?.comparisons === 1 && job.mongo.status === "completed");
    await delay(options.pollMs * 3);
    assert.equal(mongoCalls, 2);
    assert.equal(logs, 1);
    assert.equal(job.evaluation, "evaluating");
    assert.equal(job.mongoHistory!.length, 1);
    release();
    await until(() => job.evaluation === "completed");
  } finally { release(); controller.abort(); await work; }
  const restored = JSON.parse(JSON.stringify(state)) as AutomationState;
  await runPipeline(restored, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(mongoCalls, 2);
  assert.equal(restored.jobs[date].mongoHistory!.length, 1);
  assert.equal(restored.jobs["2026-09-22"].mongo, undefined);
});

test("Mongo timeout during refresh does not block input promotion or evaluation of new answers", async () => {
  const state = fresh(), controller = new AbortController(), date = "2026-09-29";
  let rows = 1, release!: () => void, uploading = false, finishUpload!: () => void;
  const transfer = new Promise<void>(resolve => { release = resolve; });
  const upload = new Promise<void>(resolve => { finishUpload = resolve; });
  const evaluated: number[] = [];
  const deps = services({
    discover: async () => [day(date, rows)],
    sync: async (_job, current, _signal, beforeReplace) => {
      if (current.rows.a_fast === 2) await transfer;
      await beforeReplace();
      return { changed: true, bytes: 10, rows: current.rows };
    },
    syncMongo: async job => {
      if (job.summary?.readyComparisons === 2) { uploading = true; await upload; throw new Error("Mongo network timeout"); }
      return { inputs: 4, comparisons: job.summary?.readyComparisons ?? 0, inserted: 0, updated: 0 };
    },
    evaluate: async job => { evaluated.push(job.downloaded!.a_fast); return { status: "completed", summary }; },
  });
  const work = runPipeline(state, options, deps, controller.signal);
  try {
    await until(() => state.jobs[date]?.mongo?.counts?.comparisons === 1);
    rows = 2;
    await until(() => state.jobs[date]?.download === "downloading");
    const job = state.jobs[date];
    job.summary = { ...summary, readyComparisons: 2 };
    await until(() => uploading);
    release();
    await until(() => job.downloaded?.a_fast === 2 && job.evaluation === "completed");
    assert.equal(job.mongo!.status, "running");
    assert.deepEqual(evaluated, [1, 2]);
    finishUpload();
    await until(() => job.mongo?.status === "retry");
    assert.match(job.mongo!.error!, /Mongo network timeout/);
    assert.deepEqual(evaluated, [1, 2], "delivery failure never replays successful evaluations");
  } finally { release(); finishUpload(); controller.abort(); await work; }
});

test("a slow Mongo date does not block settled results on another date or duplicate an active upload", async () => {
  const state = fresh(), controller = new AbortController(), dates = ["2026-09-28", "2026-09-29"];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), calls: string[] = [];
  const work = runPipeline(state, options, services({
    discover: async () => dates.map(date => day(date)),
    syncMongo: async job => {
      calls.push(job.date);
      if (job.date === dates[0]) await held;
      return { inputs: 4, comparisons: job.summary?.readyComparisons ?? 0, inserted: 0, updated: 0 };
    },
  }), controller.signal);
  try {
    await until(() => state.jobs[dates[1]]?.mongo?.status === "completed");
    assert.equal(state.jobs[dates[0]].mongo?.status, "running");
    await delay(200);
    assert.equal(calls.filter(date => date === dates[0]).length, 1);
  } finally { release(); controller.abort(); await work; }
});

test("Mongo retry and statistics generation fail independently and both recover", async () => {
  const state = fresh(), date = "2026-09-29";
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs[date];
  state.statistics = { attempts: 0, nextAt: 0 };
  let failedMongo = true, failedStatistics = true, logAttempts = 0;
  const deps = services({
    syncMongo: async () => {
      if (failedMongo) throw new Error("Mongo offline");
      return { inputs: 4, comparisons: 1, inserted: 5, updated: 0 };
    },
    publish: async () => {
      logAttempts++;
      if (failedStatistics) throw new Error("statistics offline");
      return { traceId: "statistics-recovered", generatedAt: Date.now() };
    },
  });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(job.mongo!.status, "retry");
  assert.match(job.mongo!.error!, /Mongo offline/);
  assert.equal(state.statistics?.error, "statistics offline");
  assert.equal(job.evaluationAttempts, 0);
  failedMongo = false; failedStatistics = false; job.mongo!.nextAt = 0; state.statistics!.nextAt = 0;
  const controller = new AbortController();
  await runPipeline(state, options, { ...deps, save: async (snapshot) => {
    if (snapshot.jobs[date].mongo?.status === "completed" && snapshot.statistics?.lastTraceId) controller.abort();
  } }, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
  assert.equal(job.mongo!.status, "completed");
  assert.equal(state.statistics?.lastTraceId, "statistics-recovered");
  assert.equal(logAttempts, 2);
});

for (const previousTarget of [undefined, "another-task"] as const)
test(`Mongo receipts for ${previousTarget ?? "an unconfirmed task"} do not suppress delivery or cause reevaluation`, async t => {
  const state = fresh(), date = "2026-09-29";
  let evaluations = 0, uploads = 0;
  const deps = services({
    evaluate: async () => { evaluations++; return { status: "completed", summary }; },
    syncMongo: async () => { uploads++; return { inputs: 4, comparisons: 1, inserted: 5, updated: 0 }; },
  });
  await runPipeline(state, { ...options, once: true }, { ...deps, syncMongo: undefined }, t.signal);
  await runPipeline(state, { ...options, once: true }, deps, t.signal);
  const job = state.jobs[date], accepted = structuredClone(job.summary);
  job.mongo!.target = previousTarget;
  job.mongo!.nextAt = Date.now() + 60_000;
  await runPipeline(state, { ...options, once: true }, {
    ...deps, syncMongo: async current => {
      assert.equal(current.mongo?.synced, undefined);
      assert.equal(current.mongo?.counts, undefined);
      return deps.syncMongo!(current, t.signal);
    },
  }, t.signal);
  assert.equal(uploads, 2);
  assert.equal(evaluations, 1);
  assert.deepEqual(job.summary, accepted);
  assert.equal(job.mongo?.status, "completed");
  assert.equal(job.mongoHistory?.length, 1, "retain the previous target's receipt");
  await runPipeline(state, { ...options, once: true }, deps, t.signal);
  assert.equal(uploads, 2, "the current target's receipt remains resumable");
});

test("Mongo delivery permits input promotion and an interrupted upload resumes immediately", async () => {
  const state = fresh(), date = "2026-09-29", controller = new AbortController();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs[date]; let count = 1, downloads = 0, started = false;
  const work = runPipeline(state, options, services({
    discover: async () => [day(date, count)],
    sync: async (_job, currentDay, _signal, beforeReplace) => { downloads++; await beforeReplace(); return { changed: true, bytes: 20, rows: currentDay.rows }; },
    syncMongo: async (_job, signal) => {
      started = true;
      await delay(10_000, undefined, { signal });
      return { inputs: 4, comparisons: 1, inserted: 5, updated: 0 };
    },
  }), controller.signal);
  try {
    await until(() => started);
    count = 2;
    await until(() => job.observed.a_fast === 2);
    await until(() => downloads === 1 && job.downloaded?.a_fast === 2);
    assert.equal(job.mongo!.status, "running", "promotion is independent of network delivery");
  } finally { controller.abort(); await work; }
  assert.equal(job.mongo!.status, "pending");
  assert.equal(job.mongo!.error, undefined);
  assert.equal(job.mongo!.nextAt, 0);
  let resumed = 0;
  await runPipeline(state, { ...options, once: true }, services({
    discover: async () => [day(date, 2)],
    syncMongo: async (current) => {
      resumed++; assert.equal(current.downloaded!.a_fast, 2);
      return { inputs: 8, comparisons: 1, inserted: 9, updated: 0 };
    },
  }), AbortSignal.timeout(3000));
  assert(resumed > 0);
  assert.equal(job.mongo!.status, "completed");
});

test("a statistics snapshot pins input promotion while catalog polling keeps advancing", async () => {
  const state = fresh(), controller = new AbortController();
  const first = "2026-09-28", second = "2026-09-29";
  let count = 1, publishing = false, nextDateAdvanced = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps = services({
    discover: async () => [day(first, count), day(second, count)],
    sync: async (job) => {
      if (count === 2) nextDateAdvanced = true;
      return { changed: true, bytes: count, rows: job.observed };
    },
    publish: async () => { publishing = true; await gate; publishing = false;
      return { traceId: "pinned-input-snapshot", generatedAt: Date.now() }; },
  });
  await runPipeline(state, { ...options, once: true }, { ...deps, publish: undefined }, AbortSignal.timeout(3000));
  const work = runPipeline(state, options, deps, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
  try {
    await until(() => publishing);
    count = 2;
    await until(() => state.jobs[first].observed.a_fast === 2);
    assert.equal(nextDateAdvanced, false);
    assert.equal(state.jobs[first].observed.a_fast, 2);
    assert.equal(state.jobs[first].downloaded!.a_fast, 1);
    release();
    await until(() => state.jobs[first].downloaded!.a_fast === 2);
  } finally { release(); controller.abort(); await work; }
});
