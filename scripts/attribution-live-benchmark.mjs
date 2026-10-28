import { execFileSync } from "node:child_process";
import { mkdir, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadConfig, createModelResolver } from "@eval/host-app/config";
import { services } from "@eval/host-app/composition";
import { createChannelRequests, runEvaluation } from "@eval/host";
import { attributionRepository, attributionWorkflow, planAttribution } from "@eval/workflows/attribution";
import { writeJson, runHotFile } from "@eval/data";
import { measureAttributionRun } from "./attribution-throughput.mjs";
import { sampleProcessTree } from "./process-tree-usage.mjs";

// Complete Pi sessions and independent Worker processes, with exactly 20 provider permits.
// Run alone: this process cannot limit unrelated Hosts sharing the model gateway.
const [configFile, countText, runId] = process.argv.slice(2), count = Number(countText);
if (!configFile || !Number.isSafeInteger(count) || count < 1 || count > 200 || !/^[a-z0-9][a-z0-9-]+$/u.test(runId ?? ""))
  throw new Error("node scripts/attribution-live-benchmark.mjs CONFIG 1..200 NEW_RUN_ID");
if (process.platform !== "linux") throw new Error("Process-tree measurements require Linux /proc.");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const host = await loadConfig(["configs/host.json", configFile]);
if (host.workflow !== "attribution" || host.evaluation.output.kind !== "directory" ||
    !/^\/mnt\/fin_bench\/eval_data\/[^/]+\/eval_output\/test_eval(?:\/|$)/u.test(path.resolve(host.evaluation.output.path)))
  throw new Error("Use an attribution configuration in the source test_eval directory.");
const config = { ...host.evaluation, execution: { ...host.evaluation.execution, concurrency: 20,
  taskConcurrency: count, sessionWindow: Math.max(count, host.evaluation.execution.sessionWindow) } };
const plan = await planAttribution(config), modelForStage = createModelResolver(host.models);
if (plan.summary.issues.length || plan.tasks.filter(task => task.stage === "attribution-component").length < count)
  throw new Error("The fixed sample must contain enough valid distinct component tasks.");
const channels = new Set(plan.tasks.map(task => modelForStage(task.stage).provider));
if (channels.size !== 1) throw new Error("This experiment requires one model channel with a total limit of 20.");
const run = path.join(config.output.path, runId);
await mkdir(run); // New run only; measurements must not silently merge independent trials.
const gate = createChannelRequests({ [[...channels][0]]: 20 }, { default: 1 },
  context => attributionWorkflow.scheduling.stagePriority(context.stage));
const requests = new Map();
let peakRequests = 0, requestCount = 0, peakRequestSessions = 0, activeRequests = 0;
let quotaUpdatedAt = performance.now(), activeRequestMs = 0, queuedRequestMs = 0, underusedWhileQueuedMs = 0;
function updateQuotaTime() {
  const now = performance.now(), elapsed = now - quotaUpdatedAt, queued = requests.size - activeRequests;
  activeRequestMs += elapsed * activeRequests; queuedRequestMs += elapsed * queued;
  if (queued > 0 && activeRequests < 20) underusedWhileQueuedMs += elapsed;
  quotaUpdatedAt = now;
}
const modelRequests = { concurrency: gate.concurrency, async acquire(context, signal) {
  updateQuotaTime();
  requests.set(context.callId, context.taskId);
  peakRequestSessions = Math.max(peakRequestSessions, new Set(requests.values()).size);
  let release;
  try { release = await gate.acquire(context, signal); }
  catch (error) { updateQuotaTime(); requests.delete(context.callId); throw error; }
  updateQuotaTime();
  requestCount++; activeRequests++; peakRequests = Math.max(peakRequests, activeRequests);
  let released = false;
  return () => { if (released) return; updateQuotaTime(); released = true; activeRequests--; requests.delete(context.callId); release(); };
} };
const loop = monitorEventLoopDelay({ resolution: 20 }), controller = new AbortController();
const stop = () => controller.abort(new Error("Experiment interrupted"));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
let sampling, samplePending, samples = 0, sampleFailures = 0, peakRss = 0, peakProcesses = 0, progress;
const processUsage = new Map();
const peakMemory = { host: {}, workers: {} }, outboxPeak = { count: 0, bytes: 0, age_ms: 0 };
let systemMemory, survivingProcesses = [];
const hotFile = runHotFile(process.env.EVAL_HOT_STATE_ROOT || path.join(os.homedir(), ".cache", "eval-agent-harness", "hot"), run);
const fileSizes = Object.fromEntries(["state.json", "progress.jsonl", "results/attribution.jsonl"].map(file => [file, { file: path.join(run, file) }]));
for (const suffix of ["", "-wal", "-shm"]) fileSizes["hot.sqlite" + suffix] = { file: hotFile + suffix };
async function sampleFiles() {
  await Promise.all(Object.values(fileSizes).map(async row => {
    try { row.current_bytes = (await stat(row.file)).size; row.peak_bytes = Math.max(row.peak_bytes ?? 0, row.current_bytes); }
    catch (error) { if (error.code !== "ENOENT") throw error; row.current_bytes = 0; }
  }));
}
const before = process.resourceUsage(), startedAt = Date.now();
const report = result => ({ kind: "pi-live-sessions", git_revision: revision,
  evaluator_version: host.evaluatorVersion, run_id: runId, elapsed_seconds: (Date.now() - startedAt) / 1000,
  task_slots: count, worker_slots_per_process: 8, model_concurrency_limit: 20, peak_model_requests: peakRequests,
  provider_requests: requestCount, peak_sessions_with_active_or_queued_model_request: peakRequestSessions,
  quota: { active_request_seconds: activeRequestMs / 1000, queued_request_seconds: queuedRequestMs / 1000,
    utilization: activeRequestMs / (20 * (Date.now() - startedAt)), underused_while_queued_seconds: underusedWhileQueuedMs / 1000 },
  process_samples: samples, process_sample_failures: sampleFailures, peak_process_tree_rss_bytes: peakRss,
  peak_process_count: peakProcesses, peak_memory: peakMemory, system_memory_latest: systemMemory,
  surviving_observed_descendants: survivingProcesses, files: fileSizes, peak_outbox: outboxPeak,
  host_memory: process.memoryUsage(), host_resource_usage: process.resourceUsage(),
  initial_host_resource_usage: before, observed_process_io_and_cpu: [...processUsage.values()].reduce((total, counters) => {
    for (const [key, value] of Object.entries(counters)) total[key] = (total[key] ?? 0) + value; return total;
  }, {}), event_loop_max_ms: loop.max / 1e6, event_loop_p95_ms: loop.percentile(95) / 1e6,
  progress, result, limits: "Linux process-tree RSS sums shared pages and samples every second; short-lived processes may be missed. Workers includes all Host descendants. RssFile is mapped file memory, not the machine-wide page cache, which is reported separately and cannot be attributed to this run. File sizes sample every 30 seconds and at exit; no directory scans. Queued/active model requests prove SDK sessions exist, but omit sessions between requests. No semantic effect review." });
let result, error, failed;
try {
  loop.enable();
  sampling = setInterval(() => {
    if (samplePending) return;
    samplePending = sampleProcessTree(process.pid).then(async sample => {
      sampleFailures += sample.failures;
      for (const { id, ...counters } of sample.counters) processUsage.set(id, counters);
      samples++; peakRss = Math.max(peakRss, sample.rss); peakProcesses = Math.max(peakProcesses, sample.processes);
      for (const group of ["host", "workers"]) for (const [key, value] of Object.entries(sample[group]))
        if (value !== null) peakMemory[group][key] = Math.max(peakMemory[group][key] ?? 0, value);
      systemMemory = sample.system;
      if (samples % 30 === 0) { updateQuotaTime(); await sampleFiles(); await writeJson(path.join(run, "infrastructure-observation.json"), report()); }
    }).catch(() => { sampleFailures++; }).finally(() => { samplePending = undefined; });
  }, 1000);
  const { report: _report, ...baseServices } = services;
  result = await runEvaluation({ ...baseServices, taskSource: attributionWorkflow, repository: attributionRepository,
    runtime: { ...services.runtime, workerSlots: 8 }, runId, output: config.output, engine: "pi",
    evaluatorVersion: host.evaluatorVersion, config, plan, policy: config.execution, modelForStage, modelRequests,
    concurrency: 20, taskConcurrency: count, retries: config.execution.retries, retryDelaySeconds: config.execution.retryDelaySeconds,
    failureGuard: config.execution.failureGuard, signal: controller.signal, debug: true,
    onProgress(message) { if (message.startsWith("progress ")) {
      progress = JSON.parse(message.slice(9));
      const outbox = progress.outbox;
      if (outbox) {
        outboxPeak.count = Math.max(outboxPeak.count, outbox.count); outboxPeak.bytes = Math.max(outboxPeak.bytes, outbox.bytes);
        outboxPeak.age_ms = Math.max(outboxPeak.age_ms, outbox.oldestAt === undefined ? 0 : Date.now() - outbox.oldestAt);
      }
    } } });
} catch (caught) { error = caught; }
finally {
  clearInterval(sampling); await samplePending; loop.disable();
  updateQuotaTime(); await sampleFiles();
  survivingProcesses = (await Promise.all([...processUsage.keys()].map(async id => {
    const [pid, started] = id.split(":");
    if (Number(pid) === process.pid) return null;
    try {
      const text = await readFile(`/proc/${pid}/stat`, "utf8"), fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return fields[19] === started && fields[0] !== "Z" ? id : null;
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) sampleFailures++; return null; }
  }))).filter(Boolean);
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
  failed = Boolean(error) || !samples || !peakRss || sampleFailures > 0 || peakRequests > 20 || peakRequestSessions < count ||
    survivingProcesses.length > 0 || controller.signal.aborted || !result || Object.entries(result.execution_task_statuses).some(([status, amount]) => status !== "succeeded" && amount);
  await writeJson(path.join(run, "infrastructure-observation.json"), { ...report(result), failed: Boolean(failed) });
}
if (error) throw error;
await writeJson(path.join(run, "throughput-observation.json"), await measureAttributionRun(run));
console.log(JSON.stringify(report(result)));
if (failed) process.exitCode = 1;
