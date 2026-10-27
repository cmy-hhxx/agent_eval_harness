import path from "node:path";
import { exists, fileSourceReader, runLayout } from "@eval/data";
import { createChannelRequests, runEvaluation, type ModelRequestControl } from "@eval/host";
import { attributionWorkflow, attributionRepository } from "@eval/workflows/attribution";
import { collectInputs, type EvaluationInputs } from "@eval/workflows/inputs";
import { loadConfig } from "./config.js";
import { createBalancedModels } from "./balanced-models.js";
import { configurationSecrets } from "./settings.js";

export { createChannelRequests };

/** Freeze coordinates and file revisions, never copy source bodies into a run. */
export async function freezeNightInputs(configs: string[], workflow: "comparison" | "attribution") {
  const host = await loadConfig(configs);
  if (host.workflow !== workflow) throw new Error("Unexpected night workflow: " + host.workflow);
  const inputs = structuredClone(host.evaluation.inputs);
  if (inputs.workbench) throw new Error("夜间管线使用显式输入，不能混用工作台范围");
  const revisions: Record<string, string> = {};
  for (const version of inputs.versions) {
    const files = (await fileSourceReader.files(version.sources)).filter(file =>
      !file.split(path.sep).includes(".archive") && !path.basename(file).startsWith("."));
    if (!files.length) throw new Error("No prepared inputs: " + version.id);
    version.sources = files.map(file => ({ kind: "file", path: file }));
    for (const file of files) revisions[file] = await fileSourceReader.revision(file);
  }
  const scan = await collectInputs({ inputs }, undefined, { materializeInputs: false });
  const blocking = scan.issues.filter(issue => !Number.isInteger(issue.line) ||
    !(issue.errors as { code: string }[] | undefined)?.every(error => ["input_invalid", "input_json_invalid"].includes(error.code)));
  if (blocking.length) throw new Error("Input preflight failed: " + JSON.stringify(blocking));
  const excludedCases = new Set(workflow === "comparison"
    ? scan.issues.map(issue => JSON.stringify([issue.batch_id, issue.case_id])) : []);
  const excludedInputs = [...scan.issues];
  const catalog = scan.catalog.filter(row => {
    if (!excludedCases.has(JSON.stringify([row.batch_id, row.case_id]))) return true;
    excludedInputs.push({ source: row.source, line: row.line, batch_id: row.batch_id, case_id: row.case_id,
      version: row.version, reason: "比较组存在无效输入，无法形成完整对局" });
    return false;
  });
  if (!catalog.length) throw new Error("No prepared evaluation records");
  inputs.records = catalog.map(row => ({ model: row.version, batch_id: row.batch_id, case_id: row.case_id,
    input_file: row.source, input_index: row.line - 1, ...(row.trace_id ? { trace_id: row.trace_id } : {}) }));
  for (const [file, revision] of Object.entries(revisions))
    if (await fileSourceReader.revision(file) !== revision) throw new Error("Input changed while freezing: " + file);
  return { inputs, revisions, excludedInputs };
}

export async function runNightBatch(options: {
  configs: string[]; workflow: "comparison" | "attribution"; inputs: EvaluationInputs;
  revisions: Record<string, string>; output: string; runId: string; channels: string[];
  requests: ModelRequestControl; signal: AbortSignal; pauseSignal: AbortSignal;
  retryFailed?: boolean;
}) {
  const host = await loadConfig(options.configs);
  if (host.workflow !== options.workflow) throw new Error("Unexpected night workflow");
  for (const [file, revision] of Object.entries(options.revisions))
    if (await fileSourceReader.revision(file) !== revision) throw new Error("Frozen input changed: " + file);
  const evaluation = host.evaluation;
  evaluation.inputs = options.inputs;
  evaluation.output = { kind: "directory", path: options.output };
  evaluation.execution = { ...evaluation.execution, concurrency: options.requests.concurrency(),
    taskConcurrency: options.requests.concurrency(), sessionWindow: options.requests.concurrency() };
  // Import after the entry point has selected runtime logging and INI settings.
  const { services, logger } = await import("./composition.js");
  logger.addSecrets(...configurationSecrets());
  const selected = host.workflow === "attribution"
    ? { ...services, report: undefined, taskSource: attributionWorkflow, repository: attributionRepository }
    : services;
  const saved = await exists(runLayout(evaluation.output, options.runId).stateFile);
  const resumeStages = saved && options.retryFailed
    ? (await selected.repository.readRun(runLayout(evaluation.output, options.runId).directory)).manifest.pausedStages?.map(pause => pause.stage)
    : undefined;
  const plan = saved ? { tasks: [], inputs: {}, summary: {} } : await selected.taskSource.plan(evaluation);
  if (!saved && Array.isArray(plan.summary.issues) && plan.summary.issues.length)
    throw new Error("Evaluation preflight failed: " + JSON.stringify(plan.summary.issues));
  if (!saved && !plan.tasks.length) throw new Error("No evaluation tasks");
  const result = await runEvaluation({ ...selected, ...createBalancedModels(host.models, options.channels),
    runId: options.runId, output: evaluation.output, engine: "pi", evaluatorVersion: host.evaluatorVersion,
    config: evaluation, plan, policy: evaluation.execution, concurrency: evaluation.execution.concurrency,
    taskConcurrency: evaluation.execution.taskConcurrency, modelRequests: options.requests,
    retries: evaluation.execution.retries, retryDelaySeconds: evaluation.execution.retryDelaySeconds,
    failureGuard: evaluation.execution.failureGuard, resumeStages, signal: options.signal, pauseSignal: options.pauseSignal });
  const unfinished = ["pending", "running", "failed", "blocked", "timed_out", "cancelled"]
    .some(status => result.execution_task_statuses[status]);
  return { complete: !unfinished && !result.paused_stages.length, result };
}
