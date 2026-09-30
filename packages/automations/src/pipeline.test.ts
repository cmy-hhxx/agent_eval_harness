import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { REMOTE_MODELS, RemoteInputNotReadyError, type RemoteDay } from "@eval/contracts";
import { runPipeline, nextPublicationAt, PUBLICATION_INTERVAL_MS, type AutomationState, type PipelineServices, type EvaluationSummary } from "./index.js";

const day = (date: string, rows = 1): RemoteDay => ({ date, rows: Object.fromEntries(REMOTE_MODELS.map((model) => [model, rows])) as RemoteDay["rows"] });
const fresh = (): AutomationState => ({ id: "test", sourceUrl: "http://test", status: "stopped", startedAt: 0, updatedAt: 0, jobs: {} });
const summary: EvaluationSummary = { stages: { rewrite: { total: 2, completed: 2, failed: 0, pending: 0, running: 0, cancelled: 0, blocked: 0 } }, skipped: 0, issues: 0, readyComparisons: 1 };
const options = { pollMs: 100, refreshMs: 100_000, retryMs: 10, maxEvaluationAttempts: 2 };

test("a progressing retry resets the consecutive failure budget", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.evaluation = "retry"; job.evaluationAttempts = 10; job.nextEvaluationAt = 0;
  const controller = new AbortController();
  await runPipeline(state, options, services({
    evaluate: async () => ({ status: "retry", transient: true, error: "transport/unavailable", summary: {
      ...summary, stages: { ...summary.stages, rewrite: { ...summary.stages.rewrite, completed: summary.stages.rewrite.completed + 1 } },
    } }),
    save: async (saved) => { if (saved.jobs[job.date].evaluationError === "transport/unavailable") controller.abort(); },
  }), controller.signal);
  assert.equal(job.evaluationAttempts, 1);
  assert(job.nextEvaluationAt - Date.now() < 1000, "newly accepted work must not trigger the outage cooldown");
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
  sync: async () => ({ changed: true, bytes: 10 }), evaluate: async () => ({ status: "completed", summary }),
  save: async () => {}, event: async () => {}, ...overrides,
});

test("publication rollover preserves receipts and resets current timestamps, including across restart", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  state.publication = { status: "completed", nextAt: 0, attempts: 0, traceId: "previous-window", window: 100,
    startedAt: 101, completedAt: 104,
    log: { status: "uploaded", writtenAt: 102, uploadedAt: 104, requestId: "prior-receipt" } };
  const previous = structuredClone(state.publication);
  let publications = 0;
  const deps = services({ publish: async (current) => {
    publications++;
    assert.equal(current.publication?.log, undefined);
    assert.equal(current.publication?.completedAt, undefined);
    assert(current.publication!.startedAt! > previous.startedAt!);
    current.publication!.log = { status: "uploaded", requestId: "new-receipt" };
  } });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.deepEqual(state.publicationHistory, [previous]);
  const restored = JSON.parse(JSON.stringify(state)) as AutomationState;
  await runPipeline(restored, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(publications, 1);
  assert.deepEqual(restored.publicationHistory, [previous]);
  assert.equal(restored.publication!.log!.requestId, "new-receipt");
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
    sync: async (job) => {
      if (job.date === first) assert(!runningFirst);
      else secondDownloaded = true;
      return { changed: true, bytes: 10 };
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

test("recovery resynchronizes interrupted promotion and resumes the same run ID", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"];
  job.download = "downloading"; job.evaluation = "evaluating";
  const order: string[] = [];
  await runPipeline(state, { ...options, once: true }, services({
    sync: async () => { order.push("sync"); return { changed: false, bytes: 10 }; },
    evaluate: async (job) => { order.push(job.runIds[0]); return { status: "completed", summary }; },
  }), AbortSignal.timeout(3000));
  assert.deepEqual(order, ["sync", "daily-2026-09-29"]);
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
  await runPipeline(state, { ...options, once: true }, { ...deps, sync: async () => ({ changed: false, bytes: 10 }) }, AbortSignal.timeout(3000));
  assert.equal(evaluations, 2);
});

test("cancelling a refresh keeps the previously installed inputs ready", async () => {
  const state = fresh();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs["2026-09-29"], controller = new AbortController();
  job.checkedAt = 0;
  await runPipeline(state, options, services({ sync: async () => {
    controller.abort(new Error("Automation stopped"));
    controller.signal.throwIfAborted();
    return { changed: false, bytes: 0 };
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
    return { changed: false, bytes: 10 };
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
    sync: async (job) => { downloads.push(job.date); return { changed: true, bytes: 20 }; },
  }), AbortSignal.timeout(3000));
  assert.equal(downloads[0], second, "new input must not wait behind a same-count routine check");

  state.jobs[second].evaluation = "pending";
  let release!: () => void, evaluated = false, downloading = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const work = runPipeline(state, options, services({
    discover: async () => [day(first, 3), day(second, 3)],
    sync: async (job) => { assert.equal(job.date, first); downloading = true; await gate; return { changed: true, bytes: 30 }; },
    evaluate: async (job) => {
      assert.equal(job.date, second); assert(downloading);
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
    sync: async () => {
      if (downloads++ === 0) throw new RemoteInputNotReadyError("data not ready");
      return { changed: false, bytes: 10 };
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

test("one global four-hour publication includes historical dates and waits for its persisted deadline across restarts", async () => {
  const state = fresh(); let publications = 0, evaluations = 0;
  const deps = services({
    discover: async () => [day("2026-09-22"), day("2026-09-30")],
    initialize: async (day) => ({ runIds: ["daily-" + day.date], adopted: day.date === "2026-09-22" }),
    evaluate: async () => { evaluations++; return { status: "completed", summary }; },
    publish: async (current, save) => { publications++; current.publication!.log = { status: "uploaded", requestId: "req" }; await save(); },
  });
  assert.equal(nextPublicationAt(0), PUBLICATION_INTERVAL_MS);
  assert.equal(nextPublicationAt(PUBLICATION_INTERVAL_MS), PUBLICATION_INTERVAL_MS * 2);
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(publications, 0); assert.equal(state.jobs["2026-09-22"].evaluation, "completed");
  const delivery = state.publication!;
  const deadline = delivery.nextAt;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(delivery.nextAt, deadline);
  delivery.nextAt = 0;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(publications, 1); assert.equal(evaluations, 1);
  const completed = state.publication!;
  assert.equal(completed.status, "completed"); assert(completed.nextAt > Date.now());
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
    publish: async () => { logs++; },
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
    assert.equal(logs, 0);
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

test("Mongo failures do not delay scheduled logs and uncertain logs do not block Mongo retry", async () => {
  const state = fresh(), date = "2026-09-29";
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs[date];
  state.publication = { status: "pending", nextAt: 0, attempts: 0 };
  let failed = true, logs = 0;
  const deps = services({
    syncMongo: async () => {
      if (failed) throw new Error("Mongo offline");
      return { inputs: 4, comparisons: 1, inserted: 5, updated: 0 };
    },
    publish: async (current) => { logs++; current.publication!.log = { status: "uploaded", requestId: "receipt" }; },
  });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(job.mongo!.status, "retry");
  assert.match(job.mongo!.error!, /Mongo offline/);
  assert.equal(state.publication.status, "completed");
  assert.equal(job.evaluationAttempts, 0);
  failed = false; job.mongo!.nextAt = 0;
  state.publication.status = "uncertain"; state.publication.log!.status = "uncertain";
  const controller = new AbortController();
  await runPipeline(state, options, { ...deps, save: async (snapshot) => {
    if (snapshot.jobs[date].mongo?.status === "completed") controller.abort();
  } }, AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]));
  assert.equal(job.mongo!.status, "completed");
  assert.equal(job.mongo!.error, undefined);
  assert.equal(state.publication.status, "uncertain");
  assert.equal(logs, 1);
});

test("Mongo pins inputs during delivery and an interrupted upload resumes immediately", async () => {
  const state = fresh(), date = "2026-09-29", controller = new AbortController();
  await runPipeline(state, { ...options, once: true }, services(), AbortSignal.timeout(3000));
  const job = state.jobs[date]; let count = 1, downloads = 0, started = false;
  const work = runPipeline(state, options, services({
    discover: async () => [day(date, count)],
    sync: async () => { downloads++; return { changed: true, bytes: 20 }; },
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
    assert.equal(job.downloaded!.a_fast, 1);
    assert.equal(downloads, 0);
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

test("a lost global log response remains uncertain across restarts without blocking evaluation", async () => {
  const state = fresh(); let attempts = 0;
  const deps = services({ discover: async () => [day("2026-09-28"), day("2026-09-29")],
    publish: async (current, save) => {
      attempts++; current.publication!.log = { status: "sending" }; await save();
      throw new Error("Response lost");
    },
  });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  state.publication!.nextAt = 0;
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(state.publication!.status, "uncertain");
  assert(Object.values(state.jobs).every(job => job.evaluation === "completed"));
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(attempts, 1);
  state.publication!.log!.status = "sending";
  state.publication!.status = "running";
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  assert.equal(attempts, 1);
  assert.match(state.publication!.error!, /Interrupted log upload/);
});

test("global log publication pins all inputs while catalog polling keeps advancing", async () => {
  const state = fresh(), controller = new AbortController();
  const first = "2026-09-28", second = "2026-09-29";
  let count = 1, publishing = false, nextDateAdvanced = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const deps = services({
    discover: async () => [day(first, count), day(second, count)],
    sync: async () => {
      if (count === 2) nextDateAdvanced = true;
      return { changed: true, bytes: count };
    },
    publish: async () => { publishing = true; await gate; publishing = false; },
  });
  await runPipeline(state, { ...options, once: true }, deps, AbortSignal.timeout(3000));
  state.publication!.nextAt = 0;
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
