import { localFiles } from "@eval/data";
import path from "node:path";
import type { SubmissionReceipt, ValidationIssue } from "@eval/contracts";
import { canonical, errorText } from "@eval/contracts";
import { exists, internalPath, locateRun, readJson, writeJson } from "@eval/data";
import { bindTask } from "./workflow.js";
import type { AgentBinding, ToolAudit } from "@eval/contracts";
import { writeOverview } from "./report.js";
import { loadRunInputs, readRunState } from "./run-data.js";
import type { Candidate, EvalConfig, PairwiseResult, RawInput, TaskData } from "./types.js";
import { adapt, candidateKey } from "./input.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { outputSchema } from "./schema.js";
import { correctnessProfile } from "@eval/agents/critique";
import { comparisonRow, correctnessRow } from "./results.js";

export async function validateRun(
  run: string,
  validate: (binding: AgentBinding, result: unknown, audit: ToolAudit) => void,
) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const outputValidator = ajv.compile(outputSchema),
    correctnessValidator = ajv.compile(correctnessProfile.resolvedSchema!);
  const state = await readRunState(run),
    manifest = state.manifest;
  const errors: string[] = [],
    evidenceErrors: string[] = [],
    artifactErrors: string[] = [],
    receipts = new Map<string, SubmissionReceipt>();
  const inputIssues: ValidationIssue[] = [];
  const inputs = await loadRunInputs(manifest, inputIssues);
  evidenceErrors.push(...inputIssues.map((issue) => issue.message));
  const config = manifest.config as EvalConfig;
  const catalog =
    (manifest.inputCatalog as Candidate[]) ||
    manifest.tasks.flatMap((task) => Object.values((task.data as TaskData).candidates));
  for (const candidate of new Map(
    catalog.map((candidate) => [candidateKey(candidate), candidate]),
  ).values()) {
    if (!Object.hasOwn(inputs, candidate.input_id)) continue;
    try {
      const version = config.inputs.versions.find((version) => version.id === candidate.version);
      if (!version) throw new Error("Input version is not registered");
      const actual = adapt(
        inputs[candidate.input_id] as RawInput,
        version,
        candidate.source,
        candidate.line,
        config.inputs.default_batch_id,
      );
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
      receipts.set(task.id, receipt);
    } catch (error) {
      errors.push(`${task.id}: ${errorText(error)}`);
    }
  }
  for (const task of manifest.tasks) {
    const receipt = receipts.get(task.id);
    if (!receipt) continue;
    try {
      if (Object.values(task.inputIds).every((id) => Object.hasOwn(inputs, id)))
        validate(
          bindTask(
            task,
            inputs,
            Object.fromEntries(
              Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)]),
            ),
          ),
          receipt.evaluation,
          receipt.audit,
        );
    } catch (error) {
      evidenceErrors.push(`${task.id}: ${errorText(error)}`);
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
  for (const task of manifest.tasks)
    if (receipts.has(task.id)) {
      try {
        const receipt = receipts.get(task.id)!;
        if (task.stage === "correctness") {
          const row = receipt.exported?.row || correctnessRow(task, receipt);
          if (
            !correctnessValidator(row.evaluation) ||
            canonical(row) !== canonical(correctnessRow(task, receipt))
          )
            throw new Error("正确性结果结构或收据不一致");
          const name = "correctness.jsonl";
          if (!expected.has(name)) expected.set(name, []);
          expected.get(name)!.push(canonical(row));
          continue;
        }
        const value = receipt.evaluation as PairwiseResult;
        const row = receipt.exported?.row || comparisonRow(inputs, task, value, receipts, names),
          name = (task.data as TaskData).pair!.join("__vs__") + ".jsonl";
        if (!outputValidator(row))
          throw new Error("正式结果结构无效：" + JSON.stringify(outputValidator.errors));
        if (
          receipt.exported &&
          Object.values(task.inputIds).every((id) => Object.hasOwn(inputs, id)) &&
          canonical(row) !== canonical(comparisonRow(inputs, task, value, receipts, names))
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
  const validation = {
    valid: errors.length === 0 && evidenceErrors.length === 0,
    results: { valid: errors.length === 0, errors: [...errors] },
    evidence: { valid: evidenceErrors.length === 0, errors: evidenceErrors },
    artifacts: {
      status: !manifest.debug ? "not_retained" : artifactErrors.length ? "missing" : "available",
      errors: artifactErrors,
    },
    completed_comparisons: [...expected].reduce(
      (n, [name, rows]) => n + (name === "correctness.jsonl" ? 0 : rows.length),
      0,
    ),
    errors: [...errors, ...evidenceErrors],
    artifacts_checked: manifest.debug,
  };
  const file = locateRun(run).stats;
  const summary = (await exists(file)) ? await readJson(file) : undefined;
  const { errors: _errors, results, evidence, artifacts, ...counts } = validation;
  await writeJson(file, {
    ...summary,
    validation: {
      ...counts,
      error_count: validation.errors.length,
      results: { valid: results.valid, error_count: results.errors.length },
      evidence: { valid: evidence.valid, error_count: evidence.errors.length },
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
