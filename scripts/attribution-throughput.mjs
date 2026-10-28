import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJson, readJsonlText, exists } from "@eval/data";
import { attributionRepository } from "@eval/workflows/attribution";
import { readRunState } from "@eval/workflows/comparison";

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(fraction * ordered.length) - 1];
};

/** Interrupted tasks observed for less than ten minutes have no SLA verdict yet. */
export function summarizeSubmissionLatency(tasks) {
  const started = tasks.filter(task => Number.isFinite(task.startedAt));
  const failed = task => ["failed", "timed_out"].includes(task.status);
  const accepted = started.filter(task => task.acceptedAt !== undefined && !task.partial);
  const seconds = accepted.map(task => (task.acceptedAt - task.startedAt) / 1000);
  const resolved = tasks.filter(task => task.acceptedAt !== undefined || failed(task) ||
    task.observedUntil - task.startedAt >= 600000);
  const within = seconds.filter(seconds => seconds <= 600).length;
  const faults = tasks.filter(failed).length;
  const settled = tasks.filter(task => task.acceptedAt !== undefined || failed(task)).length;
  return { started_tasks: started.length, valid_within_ten_minutes: within, ten_minute_observed_tasks: resolved.length,
    interrupted_or_running_under_ten_minutes: started.filter(task => task.acceptedAt === undefined && !failed(task) &&
      task.observedUntil - task.startedAt < 600000).length,
    valid_within_ten_minutes_rate: resolved.length ? within / resolved.length : null,
    valid_submission_p50_seconds: percentile(seconds, .5), valid_submission_p95_seconds: percentile(seconds, .95),
    fault_tasks: faults, settled_tasks: settled, fault_rate: settled ? faults / settled : null };
}

/** Attempt categories overlap; repair-attempt cost is not repair-only cost. */
export function summarizeAttemptCosts(attempts, expected, complete) {
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  const sum = rows => {
    const usage = Object.fromEntries(fields.map(key => [key, rows.every(row => Number.isFinite(row.metrics?.usage?.[key]))
      ? rows.reduce((total, row) => total + row.metrics.usage[key], 0) : null]));
    const model_seconds = rows.every(row => Number.isFinite(row.metrics?.timings?.modelMs))
      ? rows.reduce((total, row) => total + row.metrics.timings.modelMs / 1000, 0) : null;
    const model_turns = rows.every(row => Number.isSafeInteger(row.modelRounds))
      ? rows.reduce((total, row) => total + row.modelRounds, 0) : null;
    return { attempts: rows.length, usage, model_seconds, model_turns };
  };
  const measured = attempts.filter(row => row.metrics), total = sum(measured);
  const missing = Math.max(0, expected - measured.length);
  return { expected_attempts: expected, measured_attempts: measured.length, missing_attempt_metrics: missing,
    measured_total: total,
    unsuccessful: sum(measured.filter(row => row.status !== "succeeded")),
    timed_out: sum(measured.filter(row => row.status === "timed_out")),
    retries: sum(measured.filter(row => row.attempt > 1)),
    attempts_with_content_repair: sum(measured.filter(row => row.contentSubmissions > 1)),
    content_submission_count_unknown: attempts.filter(row => row.contentSubmissions === undefined).length,
    complete_results: complete,
    cost_per_complete_result: complete && !missing ? {
      usage: Object.fromEntries(fields.map(key => [key, total.usage[key] === null ? null : total.usage[key] / complete])),
      model_seconds: total.model_seconds === null ? null : total.model_seconds / complete,
      model_turns: total.model_turns === null ? null : total.model_turns / complete,
    } : null };
}

/** Offline only: stream the existing debug archive once, without retaining model text. */
export async function countModelRounds(file) {
  if (await exists(file + ".gz")) file += ".gz";
  if (!await exists(file)) return undefined;
  let rounds = 0;
  for await (const line of readJsonlText(file)) {
    if (!line.includes('"turn_start"')) continue;
    const event = JSON.parse(line);
    if (event.type === "model" && event.data?.type === "turn_start") rounds++;
  }
  return rounds;
}

/** Completed and censored work stay separate; components never stand in for sessions. */
export async function measureAttributionRun(run) {
  const checkpoint = await readJson(path.join(run, "state.json"));
  const state = await (checkpoint.workflow === "attribution" ? attributionRepository.readRun(run) : readRunState(run));
  const { manifest, receipts } = state;
  const end = manifest.finishedAt ?? Date.now(), stages = {};
  for (const task of manifest.tasks) {
    const progress = manifest.states[task.id], receipt = receipts[task.id];
    const group = stages[task.stage] ??= { planned: 0, accepted: 0, accepted_with_incomplete_dependencies: 0, statuses: {}, completed_seconds: [],
      accepted_at: [], attempts: 0, tool_calls: 0, model_seconds: 0, measured_attempts: 0,
      attempt_statuses: {}, output_tokens: 0, first_pass_accepted: 0, accepted_after_content_repair: 0, accepted_submission_count_unknown: 0,
      attempt_costs: [], task_latencies: [] };
    group.planned++;
    group.statuses[progress.status] = (group.statuses[progress.status] ?? 0) + 1;
    group.attempts += progress.attempts;
    if (receipt?.status === "succeeded") {
      group.accepted++; group.accepted_at.push(receipt.acceptedAt);
      const submissions = receipt.submissionStats?.contentSubmissions;
      if (submissions === undefined) group.accepted_submission_count_unknown++;
      else if (submissions > 1) group.accepted_after_content_repair++;
      else if (submissions === 1 && progress.attempts === 1) group.first_pass_accepted++;
      if (receipt.incompleteDependencies?.length) group.accepted_with_incomplete_dependencies++;
      if (progress.durationMs !== undefined) group.completed_seconds.push(progress.durationMs / 1000);
    }
    const latency = { status: progress.status, startedAt: progress.startedAt,
      acceptedAt: receipt?.status === "succeeded" ? receipt.acceptedAt : undefined,
      partial: Boolean(receipt?.incompleteDependencies?.length),
      observedUntil: progress.startedAt !== undefined && progress.durationMs !== undefined
        ? progress.startedAt + progress.durationMs : end };
    group.task_latencies.push(latency);
    const directory = path.join(run, "_internal/tasks", task.id);
    if (!await exists(directory)) continue;
    for (const attempt of await readdir(directory)) {
      if (!attempt.startsWith("attempt-")) continue;
      const file = path.join(directory, attempt, "attempt.json");
      if (!await exists(file)) continue;
      const record = await readJson(file);
      const startedAt = record.spec?.deadline - record.spec?.policy?.timeoutSeconds * 1000;
      if (Number.isFinite(startedAt)) latency.startedAt = Math.min(latency.startedAt ?? Infinity, startedAt);
      const attemptNumber = Number(attempt.slice("attempt-".length));
      group.attempt_costs.push({ attempt: attemptNumber, status: record.status?.state,
        modelRounds: await countModelRounds(path.join(directory, attempt, "events.jsonl")),
        metrics: record.metrics && { usage: record.metrics.usage, timings: record.metrics.timings },
        contentSubmissions: (attemptNumber === progress.attempts ? receipt?.submissionStats?.contentSubmissions : undefined) ??
          record.pendingSubmission?.submissionStats?.contentSubmissions ?? record.failure?.contentSubmissions });
      if (!record.metrics) continue;
      group.measured_attempts++;
      group.attempt_statuses[record.status.state] = (group.attempt_statuses[record.status.state] ?? 0) + 1;
      group.tool_calls += record.metrics.audit.calls;
      group.model_seconds += record.metrics.timings.modelMs / 1000;
      group.output_tokens += record.metrics.usage.output;
    }
  }
  const elapsed = (end - manifest.startedAt) / 1000;
  const attribution = Object.entries(stages).filter(([stage]) => ["criteria", "attribution-component", "attribution-trace", "attribution-session"].includes(stage));
  const session = stages["attribution-session"];
  const complete = session ? session.accepted - session.accepted_with_incomplete_dependencies : 0;
  return { run_id: manifest.runId, evaluator_version: manifest.evaluatorVersion, status: manifest.status,
    elapsed_seconds: elapsed, concurrency: manifest.config.execution.concurrency,
    attribution_cost: summarizeAttemptCosts(attribution.flatMap(([, group]) => group.attempt_costs),
      attribution.reduce((total, [, group]) => total + group.attempts, 0), complete),
    cost_limits: "Primary attribution includes criteria/component/trace/session attempts, including failures and retries; dimensions/comparison are separate stages. Repair category includes whole attempts with cumulative content submissions > 1, not repair-only cost, and overlaps retries/failures. SDK model time measures assistant message_start to message_end; Pi permit waits occur before message_start. It is not provider compute time. Model turns count archived SDK turn_start events, including turns cancelled while queued; hidden HTTP retries and tool calls are not model turns. Missing metrics or event archives are unknown. Tokens are provider-reported; no monetary price is inferred.",
    stages: Object.fromEntries(Object.entries(stages).map(([stage, group]) => {
      const { completed_seconds, accepted_at, attempt_costs, task_latencies, ...counts } = group;
      return [stage, { ...counts, coverage: group.accepted / group.planned,
        submission_latency: summarizeSubmissionLatency(task_latencies),
        attempt_cost: summarizeAttemptCosts(attempt_costs, group.attempts, group.accepted - group.accepted_with_incomplete_dependencies),
        accepted_per_minute: group.accepted / (elapsed / 60),
        complete_review_per_minute: (group.accepted - group.accepted_with_incomplete_dependencies) / (elapsed / 60),
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
