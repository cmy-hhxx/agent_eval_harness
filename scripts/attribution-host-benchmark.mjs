import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadConfig } from "@eval/host-app/config";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { attributionRepository, attributionWorkflow, planAttribution } from "@eval/workflows/attribution";
import { fileSourceReader } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";

// Real Host, HTTP, Worker material IO and submission; synthetic sessions make no model calls.
// There are no session-result tasks, so this never produces an attribution verdict file.
const [configFile, countText, output] = process.argv.slice(2), count = Number(countText);
if (!configFile || !Number.isSafeInteger(count) || count < 1 || count > 200 || !output ||
    !/^\/mnt\/fin_bench\/eval_data\/[^/]+\/eval_output\/test_eval\//u.test(path.resolve(output)))
  throw new Error("node --expose-gc scripts/attribution-host-benchmark.mjs CONFIG 1..200 NEW_SOURCE_TEST_EVAL_DIRECTORY");
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Require a new experiment; never resume synthetic receipts as a new measurement.
const host = await loadConfig(["configs/host.json", configFile]);
const config = { ...host.evaluation, workflow: "attribution", execution: { ...host.evaluation.execution,
  concurrency: count, sessionWindow: count, timeoutSeconds: 180, idleTimeoutSeconds: 180, repairAttempts: 0, retries: 0 } };
const complete = await planAttribution(config), tasks = complete.tasks.filter(task => task.stage === "attribution-component");
if (complete.summary.issues.length || tasks.length < count) throw new Error("Use enough distinct valid component tasks.");
const groups = new Map();
for (let index = 0; index < count; index++) {
  const task = tasks[Math.floor(index * tasks.length / count)], id = task.inputIds.answer;
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(task);
}
const selected = [];
while (selected.length < count) for (const group of groups.values()) if (group.length) selected.push(group.shift());
const plan = { ...complete, tasks: selected, summary: { kind: "synthetic-infrastructure", component_tasks: count } };
let recordReads = 0;
const originalRecord = fileSourceReader.record;
fileSourceReader.record = (...args) => { recordReads++; return originalRecord(...args); };
const identity = { engine: "pi", version: "synthetic", commit: "synthetic", buildId: "synthetic" };
const model = { provider: "synthetic", baseUrl: "http://127.0.0.1:1", api: "openai-completions",
  apiKeyEnv: "INFRASTRUCTURE_TEST_KEY", model: "synthetic-no-model", thinking: "off", contextWindow: 1000000, maxOutputTokens: 1000 };
const barrier = Promise.withResolvers();
let started = 0, active = 0, peakActive = 0, barrierMemory, hostUrl, peakRss = 0, probe, probeFailures = 0;
const latencies = [], errors = [];
const backend = { identity, async createSession(options) {
  return { async run() {
    hostUrl = options.spec.hostUrl;
    started++; active++; peakActive = Math.max(peakActive, active);
    if (started === count) { clearTimeout(deadline); global.gc?.(); barrierMemory = process.memoryUsage(); barrier.resolve(); }
    try {
      await barrier.promise;
      const value = { problems: [] };
      const result = await options.execute("submit_evaluation", options.spec.evaluation.jsonStringSubmission
        ? { json: JSON.stringify(value) } : value);
      if (result.isError) throw new Error("Synthetic legal submission rejected: " + result.content[0]?.text);
    } finally { active--; }
  }, async abort() { barrier.resolve(); }, async dispose() {} };
} };
const temporary = await mkdtemp(path.join(tmpdir(), "eval-host-benchmark-")), workers = [];
const loop = monitorEventLoopDelay({ resolution: 20 });
let sampling, deadline, result;
const baseline = process.memoryUsage(), startedAt = performance.now();
try {
  for (let index = 0; index < count; index++) workers.push(await startWorker(backend, path.join(temporary, String(index))));
  loop.enable();
  deadline = setTimeout(() => { errors.push("The full session barrier was not reached within 120 seconds"); barrier.resolve(); }, 120000);
  sampling = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (!hostUrl || probe) return;
    const before = performance.now();
    probe = fetch(hostUrl + "/api/progress", { signal: AbortSignal.timeout(5000) }).then(async response => {
      await response.arrayBuffer();
      if (!response.ok) throw new Error("Progress HTTP status " + response.status);
      latencies.push(performance.now() - before);
    }).catch(() => { probeFailures++; }).finally(() => { probe = undefined; });
  }, 250);
  result = await runEvaluation({ agents: new AgentRegistry([attributionAgent]), taskSource: attributionWorkflow,
    repository: attributionRepository, runtime: { root: process.cwd(), workerEntry: "unused" },
    runId: "synthetic-host", output: { kind: "directory", path: output }, engine: "pi", identity,
    evaluatorVersion: host.evaluatorVersion, config, plan, policy: config.execution, modelForStage: () => model,
    concurrency: count, taskConcurrency: count, retries: 0, retryDelaySeconds: 0, workerUrls: workers.map(worker => worker.url) });
} catch (error) { errors.push(String(error)); }
finally {
  clearTimeout(deadline); clearInterval(sampling); await probe;
  loop.disable(); await Promise.allSettled(workers.map(worker => worker.close()));
  await rm(temporary, { recursive: true, force: true });
  fileSourceReader.record = originalRecord;
}
global.gc?.();
latencies.sort((a, b) => a - b);
const report = { kind: "host-http-synthetic-sessions", git_revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  evaluator_version: host.evaluatorVersion, sessions_requested: count, sessions_started: started, peak_concurrent_sessions: peakActive,
  record_reads: recordReads, elapsed_ms: performance.now() - startedAt, baseline, at_barrier: barrierMemory ?? null,
  after_close: process.memoryUsage(), peak_rss_bytes: Math.max(peakRss, barrierMemory?.rss ?? 0),
  progress_samples: latencies.length, progress_failures: probeFailures,
  progress_p95_ms: latencies[Math.ceil(latencies.length * .95) - 1] ?? null,
  event_loop_max_ms: loop.max / 1e6, event_loop_p95_ms: loop.percentile(95) / 1e6,
  result, errors, model_requests: 0, semantic_evaluations: 0,
  limits: "Workers share one process with Host. Includes HTTP copies, source IO and live synthetic sessions; excludes Pi SDK histories, real model latency and separate Worker process overhead. No attribution quality claim." };
await writeFile(path.join(output, "benchmark.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (errors.length || started !== count || peakActive !== count || result?.execution_task_statuses?.succeeded !== count) process.exitCode = 1;
