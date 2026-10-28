import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "@eval/host-app/config";
import { planAttribution, bindAttribution } from "@eval/workflows/attribution";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { fileSourceReader } from "@eval/data";

// Material preparation and retention only: no model calls, Worker processes or verdicts.
// Each process measures one size, including a separately parsed Worker-side input copy.
const [configFile, countText, output, order = "interleaved"] = process.argv.slice(2), count = Number(countText);
if (!configFile || !Number.isSafeInteger(count) || count < 1 || count > 200 || !output ||
    !["grouped", "interleaved"].includes(order) ||
    !/^\/mnt\/fin_bench\/eval_data\/[^/]+\/eval_output\/test_eval\//u.test(path.resolve(output)))
  throw new Error("node --expose-gc scripts/attribution-material-benchmark.mjs CONFIG 1..200 SOURCE_TEST_EVAL_REPORT.json [grouped|interleaved]");
const host = await loadConfig(["configs/host.json", configFile]);
const started = performance.now(), plan = await planAttribution({ ...host.evaluation, workflow: "attribution" });
if (plan.summary.issues.length) throw new Error(JSON.stringify(plan.summary.issues));
const tasks = plan.tasks.filter(task => task.stage === "attribution-component");
if (tasks.length < count) throw new Error("Use distinct planned tasks; do not duplicate a tiny fixture to imply scale.");
let selected = Array.from({ length: count }, (_, index) => tasks[Math.floor(index * tasks.length / count)]);
if (order === "interleaved") {
  const groups = new Map();
  for (const task of selected) {
    const id = task.inputIds.answer;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(task);
  }
  selected = [];
  while (selected.length < count) for (const group of groups.values()) if (group.length) selected.push(group.shift());
}
let recordReads = 0, inputAccesses = 0;
const readRecord = fileSourceReader.record;
fileSourceReader.record = (...args) => { recordReads++; return readRecord(...args); };
const inputs = {};
for (const [id, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(plan.inputs)))
  Object.defineProperty(inputs, id, { enumerable: true, get() {
    inputAccesses++; return descriptor.get ? descriptor.get.call(plan.inputs) : descriptor.value;
  } });
const registry = new AgentRegistry([attributionAgent]), held = [], bindingTimes = [];
global.gc?.();
const baseline = process.memoryUsage(), preparationStarted = performance.now(), cpuStarted = process.cpuUsage();
let peakRss = baseline.rss, wireBytes = 0, promptChars = 0;
let bindingMs = 0, preparationMs = 0, transferMs = 0, renderingMs = 0, directoryMs = 0;
for (const task of selected) {
  const before = performance.now(), binding = bindAttribution(task, inputs, {});
  const boundAt = performance.now(), prepared = registry.prepare(binding), preparedAt = performance.now();
  bindingMs += boundAt - before; preparationMs += preparedAt - boundAt;
  directoryMs += binding.preparationTimings?.directoryMs ?? 0;
  const workerInputs = Object.fromEntries(Object.entries(binding.request.sources).map(([name, source]) => {
    const text = JSON.stringify(source.value); wireBytes += Buffer.byteLength(text);
    return [name, JSON.parse(text)];
  }));
  const transferredAt = performance.now(); transferMs += transferredAt - preparedAt;
  promptChars += prepared.renderAttempt(host.evaluation.execution).length;
  renderingMs += performance.now() - transferredAt;
  held.push({ binding, prepared, workerInputs });
  bindingTimes.push(performance.now() - before);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (held.length % 20 === 0) console.log(JSON.stringify({ prepared: held.length, rss_bytes: process.memoryUsage().rss }));
  if (process.memoryUsage().heapUsed > 2 * 1024 ** 3) {
    global.gc?.();
    if (process.memoryUsage().heapUsed > 2 * 1024 ** 3) break;
  }
}
global.gc?.();
const retained = process.memoryUsage(), cpu = process.cpuUsage(cpuStarted);
const sorted = [...bindingTimes].sort((a, b) => a - b);
const report = { kind: "material-retention-only", git_revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  evaluator_version: host.evaluatorVersion, order,
  sessions_requested: count, sessions_prepared: held.length, memory_limit_reached: held.length < count,
  distinct_inputs: new Set(selected.slice(0, held.length).flatMap(task => Object.values(task.inputIds))).size,
  plan_ms: preparationStarted - started, preparation_ms: performance.now() - preparationStarted,
  preparation_cpu_ms: (cpu.user + cpu.system) / 1000, record_reads: recordReads, input_accesses: inputAccesses,
  phases_ms: { binding: bindingMs, directory: directoryMs, preparation: preparationMs, transfer: transferMs, rendering: renderingMs },
  serialized_source_bytes: wireBytes, prompt_chars: promptChars,
  binding_p50_ms: sorted[Math.ceil(sorted.length * .5) - 1], binding_p95_ms: sorted[Math.ceil(sorted.length * .95) - 1],
  baseline, retained, peak_rss_bytes: Math.max(peakRss, retained.rss),
  limits: "Excludes SDK histories, HTTP buffers, Worker process overhead, model calls and full Host scheduling. Not a 200-Worker end-to-end test." };
held.length = 0;
global.gc?.();
report.after_release = process.memoryUsage();
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
