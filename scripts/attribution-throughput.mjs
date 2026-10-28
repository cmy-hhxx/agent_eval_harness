import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJson, exists } from "@eval/data";
import { attributionRepository } from "@eval/workflows/attribution";
import { readRunState } from "@eval/workflows/comparison";

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(fraction * ordered.length) - 1];
};

/** Completed and censored work stay separate; components never stand in for sessions. */
export async function measureAttributionRun(run) {
  const checkpoint = await readJson(path.join(run, "state.json"));
  const state = await (checkpoint.workflow === "attribution" ? attributionRepository.readRun(run) : readRunState(run));
  const { manifest, receipts } = state;
  const end = manifest.finishedAt ?? Date.now(), stages = {};
  for (const task of manifest.tasks) {
    const progress = manifest.states[task.id], receipt = receipts[task.id];
    const group = stages[task.stage] ??= { planned: 0, accepted: 0, statuses: {}, completed_seconds: [],
      accepted_at: [], attempts: 0, tool_calls: 0, model_seconds: 0, measured_attempts: 0,
      attempt_statuses: {}, output_tokens: 0 };
    group.planned++;
    group.statuses[progress.status] = (group.statuses[progress.status] ?? 0) + 1;
    group.attempts += progress.attempts;
    if (receipt?.status === "succeeded") {
      group.accepted++; group.accepted_at.push(receipt.acceptedAt);
      if (progress.durationMs !== undefined) group.completed_seconds.push(progress.durationMs / 1000);
    }
    const directory = path.join(run, "_internal/tasks", task.id);
    if (!await exists(directory)) continue;
    for (const attempt of await readdir(directory)) {
      if (!attempt.startsWith("attempt-")) continue;
      const record = await readJson(path.join(directory, attempt, "attempt.json"));
      if (!record.metrics) continue;
      group.measured_attempts++;
      group.attempt_statuses[record.status.state] = (group.attempt_statuses[record.status.state] ?? 0) + 1;
      group.tool_calls += record.metrics.audit.calls;
      group.model_seconds += record.metrics.timings.modelMs / 1000;
      group.output_tokens += record.metrics.usage.output;
    }
  }
  const elapsed = (end - manifest.startedAt) / 1000;
  return { run_id: manifest.runId, evaluator_version: manifest.evaluatorVersion, status: manifest.status,
    elapsed_seconds: elapsed, concurrency: manifest.config.execution.concurrency,
    stages: Object.fromEntries(Object.entries(stages).map(([stage, group]) => {
      const { completed_seconds, accepted_at, ...counts } = group;
      return [stage, { ...counts, coverage: group.accepted / group.planned,
        accepted_per_minute: group.accepted / (elapsed / 60),
        first_accept_seconds: accepted_at.length ? (Math.min(...accepted_at) - manifest.startedAt) / 1000 : null,
        completed_task_p50_seconds: percentile(completed_seconds, .5), completed_task_p95_seconds: percentile(completed_seconds, .95),
        incomplete: group.planned - group.accepted,
        ...(group.measured_attempts ? {} : { tool_calls: null, model_seconds: null, output_tokens: null }) }];
    })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  if (process.argv.length < 3) throw new Error("node scripts/attribution-throughput.mjs RUN [RUN ...]");
  for (const run of process.argv.slice(2)) console.log(JSON.stringify(await measureAttributionRun(path.resolve(run)), null, 2));
}
