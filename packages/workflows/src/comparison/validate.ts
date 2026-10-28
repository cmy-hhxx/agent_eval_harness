import { localFiles } from "@eval/data";
import path from "node:path";
import type { SubmissionReceipt, ValidationIssue } from "@eval/contracts";
import { canonical, errorText } from "@eval/contracts";
import { exists, internalPath, locateRun, readJson, writeJson } from "@eval/data";
import { bindTask } from "./workflow.js";
import type { AgentBinding, ToolAudit } from "@eval/contracts";
import { writeOverview } from "./report.js";
import { loadRunInputs } from "../inputs/load.js";
import { readRunState } from "./run-data.js";
import { loadAttributionJobInputs, type AttributionJobConfig } from "./attribution-job.js";
import type { Candidate } from "../inputs/types.js";
import type { EvalConfig, ComparisonResult, TaskData } from "./types.js";
import { candidateKey } from "../inputs/records.js";
import { taskCase } from "./input.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { clusteringSchema, rewrittenSchema, outputSchema } from "./schema.js";
import { stageResult,stageRewritten, originalResultRow, comparisonRow, attributionRow, rewrittenResult, clusteringRow, encodeResult, acceptedRewriteProjection } from "./results.js";
import { taskObservations } from "./observations.js";
import { deliveryCoverage, type DeliveryRequirements } from "./delivery.js";
import { modelBehavior } from "./model-behavior.js";
import { sessionAttributionResultSchema } from "@eval/agents/attribution";

export async function validateRun(
  run: string,
  validate: (binding: AgentBinding, result: unknown, audit: ToolAudit) => void,
  requirements: DeliveryRequirements = {},
) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const outputValidator = ajv.compile(outputSchema),
    attributionValidator = ajv.compile(sessionAttributionResultSchema),
    rewrittenValidator = ajv.compile(rewrittenSchema),
    clusteringValidator = ajv.compile(clusteringSchema);
  const state = await readRunState(run),
    manifest = state.manifest;
  const delivery = deliveryCoverage(state, requirements);
  const errors: string[] = [],
    evidenceErrors: string[] = [],
    rewriteErrors: string[] = [],
    artifactErrors: string[] = [],
    receipts = new Map<string, SubmissionReceipt>();
  const inputIssues: ValidationIssue[] = [];
  const selectedTasks = requirements.selectedOnly && manifest.executionScope ? new Set(manifest.executionScope) : undefined;
  const config = manifest.config as EvalConfig;
  const records = new Map<string, Candidate>();
  const inputs = (config as AttributionJobConfig).attributionJob
    ? await loadAttributionJobInputs(manifest, selectedTasks, records)
    : await loadRunInputs(manifest, inputIssues, selectedTasks, records);
  evidenceErrors.push(...inputIssues.map((issue) => issue.message));
  const catalog =
    (manifest.inputCatalog as Candidate[]) ||
    manifest.tasks.flatMap((task) => Object.values((task.data as TaskData).candidates));
  for (const candidate of new Map(
    catalog.map((candidate) => [candidateKey(candidate), candidate]),
  ).values()) {
    if (!Object.hasOwn(inputs, candidate.input_id)) continue;
    try {
      // Compare the candidate parsed from the source, not its normalized material view.
      const actual = records.get(candidate.input_id)!;
      if (
        candidateKey(actual) !== candidateKey(candidate) ||
        actual.question !== candidate.question ||
        actual.final_index !== candidate.final_index
      )
        throw new Error(
          "Input snapshot business identity or message structure differs from its registered candidate",
        );
    } catch (error) {
      evidenceErrors.push(`${candidate.input_id}: ${errorText(error)}`);
    }
  }
  for (const task of manifest.tasks) {
    const receipt = state.receipts[task.id];
    if (!receipt) {
      if (manifest.states[task.id]?.status === "succeeded") errors.push(`${task.id}: missing receipt`);
      continue;
    }
    try {
      if (receipt.taskId !== task.id || receipt.status !== "succeeded")
        throw new Error("Receipt identity mismatch");
      if (typeof receipt.evaluatorVersion !== "string" || !receipt.evaluatorVersion)
        throw new Error("Receipt is missing its evaluator version");
      if (typeof receipt.judge !== "string" || !receipt.judge.trim())
        throw new Error("Receipt is missing its judge model");
      receipts.set(task.id, receipt);
    } catch (error) {
      errors.push(`${task.id}: ${errorText(error)}`);
    }
  }
  for (const task of manifest.tasks) {
    const receipt = receipts.get(task.id);
    if (!receipt) continue;
    try {
      if (Object.values(task.inputIds).every((id) => Object.hasOwn(inputs, id))) {
        const dependencies = Object.fromEntries(
          Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)]),
        );
        const binding = bindTask(task, inputs, dependencies, { tasks: manifest.tasks });
        validate(binding, receipt.evaluation, receipt.audit);
      }
    } catch (error) {
      (task.stage === "rewrite" ? rewriteErrors : evidenceErrors).push(`${task.id}: ${errorText(error)}`);
    }
    if (manifest.debug)
      for (const artifact of receipt.audit.artifacts) {
        try {
          const file = internalPath(run, "tasks", task.id, "artifacts", artifact.id);
          if ((await localFiles.stat(file)).size !== artifact.bytes)
            throw new Error("Artifact length mismatch");
        } catch (error) {
          artifactErrors.push(`${task.id}/${artifact.id}: ${errorText(error)}`);
        }
      }
  }
  const names = Object.fromEntries(
      (manifest.config as EvalConfig).inputs.versions.map((v) => [v.id, v.display_name || v.name]),
    ),
    expected = new Map<string, string[]>();
  const executionScope = new Set(manifest.executionScope);
  const selectedSources = requirements.selectedOnly && new Set(manifest.tasks.filter((task) => executionScope.has(task.id))
    .map((task) => (task.data as TaskData).rewriteOf?.taskId ?? task.id));
  for (const task of manifest.tasks) {
    const receipt = receipts.get(task.id);
    if (task.stage !== "comparison" || (task.data as TaskData).verificationAudit || !receipt?.exported) continue;
    if (selectedSources && !selectedSources.has(task.id)) continue;
    const data = task.data as TaskData;
    const stored = stageResult("comparison", receipt.exported.row).rewritten as { rewrites: { id: string; text: string }[] } | undefined;
    for (const scope of new Set(requirements.rewriteScopes ?? [])) {
      const binding = bindTask({ ...task, stage: "rewrite", inputIds: {}, dependencies: { source: task.id }, data: {
        stage: "rewrite", candidates: {}, reference: null, case: { ...taskCase(data), question: "" },
        comparisonRewriteScope: scope as "items" | "verdicts",
        rewriteOf: { stage: "comparison", taskId: task.id, resultId: data.comparisonId! },
        rewriteNames: Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => [label, names[candidate.version]!])),
      } satisfies TaskData }, {}, { source: receipt }, { tasks: manifest.tasks });
      const ids = new Set((binding.request.input.items as { id: string }[]).map((item) => item.id));
      try {
        validate(binding, { rewrites: stored?.rewrites.filter((item) => ids.has(item.id)) ?? [] }, receipt.audit);
      } catch (error) { rewriteErrors.push(`${task.id}/${scope}: ${errorText(error)}`); }
    }
  }
  for (const task of manifest.tasks)
    if (receipts.has(task.id)) {
      try {
        const receipt = receipts.get(task.id)!;
        if (task.stage === "instruction-review") {
          const exported = encodeResult(task, state, inputs);
          if (!exported) throw new Error("指令遵循归因没有正式结果：" + task.id);
          if (exported.row.source_attribution_task_id !== task.dependencies.source ||
            canonical(exported.row.instruction_review) !== canonical(receipt.evaluation))
            throw new Error("指令遵循归因与原归因或已接受收据不一致");
          if (!expected.has(exported.file!)) expected.set(exported.file!, []);
          expected.get(exported.file!)!.push(canonical(exported.row));
          continue;
        }
        if (task.stage === "criteria" || (task.data as TaskData).verificationAudit || (receipt.evaluation as ComparisonResult).status === "needs_review") {
          const exported = encodeResult(task, state, inputs);
          if (!exported) throw new Error("阶段没有正式结果：" + task.id);
          if (!expected.has(exported.file!)) expected.set(exported.file!, []);
          expected.get(exported.file!)!.push(canonical(exported.row));
          continue;
        }
        if (task.stage === "attribution-session") {
          const row = receipt.exported?.row || attributionRow(task, receipt);
          const session = row.session_meta as Record<string, unknown>;
          const id = String(session.session_id ?? session.case_id);
          if (
            (!receipt.exported && !attributionValidator(row)) ||
            canonical(originalResultRow(task.stage, row)) !== canonical(attributionRow(task, receipt)) ||
            (receipt.exported && receipt.exported.id !== id)
          )
            throw new Error("归因结果结构或收据不一致");
          const name = "attribution.jsonl";
          if (!expected.has(name)) expected.set(name, []);
          expected.get(name)!.push(canonical(row));
          continue;
        }
        if (task.stage === "rewrite") {
          const source = (task.data as TaskData).rewriteOf!, owned = rewrittenResult(receipt);
          const projection = acceptedRewriteProjection(state, source.taskId)!;
          const row = receipt.exported ? stageRewritten(source.stage,receipt.exported.row) : projection.rewritten;
          if (!rewrittenValidator(owned) || !rewrittenValidator(row))
            throw new Error("改写结果结构或收据不一致");
          const stored = row as { evaluator_version: string; rewrites: { id: string; text: string }[] };
          if (new Set(stored.rewrites.map((item) => item.id)).size !== stored.rewrites.length ||
            stored.rewrites.length !== projection.owners.size || stored.rewrites.some(item => !projection.owners.has(item.id)) ||
            stored.evaluator_version !== projection.rewritten.evaluator_version ||
            (owned as typeof stored).rewrites.some(item => projection.owners.get(item.id) === task.id &&
              canonical(stored.rewrites.find(saved => saved.id === item.id)) !== canonical(item)))
            throw new Error("改写结果结构或收据不一致");
          continue;
        }
        if (task.stage === "clustering") {
          const row = receipt.exported?.row || clusteringRow(task, receipt, taskObservations(task, (id) => receipts.get(id))),
            name = "clustering.jsonl";
          if (
            !clusteringValidator(row) ||
            canonical(originalResultRow(task.stage, row)) !==
              canonical(clusteringRow(task, receipt, taskObservations(task, (id) => receipts.get(id))))
          )
            throw new Error("聚类结果结构或收据不一致");
          if (!expected.has(name)) expected.set(name, []);
          expected.get(name)!.push(canonical(row));
          continue;
        }
        const value = receipt.evaluation as ComparisonResult;
        const row = receipt.exported?.row || comparisonRow(inputs, task, value, receipts, names, receipt.evaluatorVersion),
          name = "comparison.jsonl";
        if (!outputValidator(row))
          throw new Error("正式结果结构无效：" + JSON.stringify(outputValidator.errors));
        if (
          receipt.exported &&
          Object.values(task.inputIds).every((id) => Object.hasOwn(inputs, id)) &&
          canonical(originalResultRow(task.stage, row)) !== canonical(comparisonRow(inputs, task, value, receipts, names, receipt.evaluatorVersion))
        )
          throw new Error("正式结果与已接受收据不一致");
        if (!expected.has(name)) expected.set(name, []);
        expected.get(name)!.push(canonical(row));
      } catch (error) {
        errors.push(`${task.id}: ${errorText(error)}`);
      }
    }
  const directory = locateRun(run).results;
  const actual = (await exists(directory)) ? await localFiles.list(directory) : [];
  for (const name of new Set([...actual.filter((v) => v.endsWith(".jsonl")), ...expected.keys()])) {
    try {
      const rows = (await localFiles.read(path.join(directory, name), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => canonical(JSON.parse(line)))
        .sort();
      if (canonical(rows) !== canonical((expected.get(name) || []).sort()) || !expected.has(name))
        throw new Error("Export differs from receipts");
    } catch (error) {
      errors.push(`${name}: ${errorText(error)}`);
    }
  }
  const behaviorFile = path.join(run, "model-behavior.jsonl");
  if (await exists(behaviorFile)) {
    try {
      const actual = (await localFiles.read(behaviorFile, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (canonical(actual) !== canonical(modelBehavior(manifest.tasks, state.receipts).rows))
        throw new Error("模型行为归因报告与已接受来源不一致");
    } catch (error) { errors.push(`model-behavior.jsonl: ${errorText(error)}`); }
  }
  const validation = {
    valid: errors.length === 0 && evidenceErrors.length === 0 && rewriteErrors.length === 0 && delivery.valid,
    delivery,
    rewrites: { valid: !rewriteErrors.length, errors: rewriteErrors, semantic_review: "required" },
    results: { valid: errors.length === 0, errors: [...errors] },
    evidence: { valid: evidenceErrors.length === 0, errors: evidenceErrors },
    artifacts: {
      status: !manifest.debug ? "not_retained" : artifactErrors.length ? "missing" : "available",
      errors: artifactErrors,
    },
    completed_comparisons: [...expected].reduce(
      (n, [name, rows]) => n + (name === "comparison.jsonl" ? rows.length : 0),
      0,
    ),
    errors: [...errors, ...evidenceErrors, ...rewriteErrors, ...delivery.errors,
      ...(requirements.rewriteScopes?.length ? delivery.missing_slots.map((row) => `${row.task_id}: missing rewrite slots: ${row.slot_ids.join(", ")}`) : [])],
    artifacts_checked: manifest.debug,
  };
  const file = locateRun(run).stats;
  const summary = (await exists(file)) ? await readJson(file) : undefined;
  const { errors: _errors, results, evidence, artifacts, rewrites, delivery: coverage, ...counts } = validation;
  await writeJson(file, {
    ...summary,
    validation: {
      ...counts,
      error_count: validation.errors.length,
      results: { valid: results.valid, error_count: results.errors.length },
      evidence: { valid: evidence.valid, error_count: evidence.errors.length },
      rewrites: { valid: rewrites.valid, error_count: rewrites.errors.length, semantic_review: rewrites.semantic_review },
      delivery: { valid: coverage.valid, by_batch: coverage.by_batch, required_slots: coverage.required_slots,
        filled_slots: coverage.filled_slots, missing_comparisons: coverage.missing_slots.length, error_count: coverage.errors.length },
      artifacts: {
        status: artifacts.status,
        error_count: artifacts.errors.length,
      },
    },
  });
  if (manifest.debug && errors.length)
    await writeJson(internalPath(run, "diagnostics", "validation.json"), validation);
  if (summary?.task_statuses) await writeOverview(run, summary, validation);
  return validation;
}
