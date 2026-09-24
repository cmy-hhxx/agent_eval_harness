import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SubmissionReceipt } from "../../../packages/contracts/src/index.js";
import {
  canonical,
  digest,
  errorText,
  exists,
  internalPath,
  readJson,
  sha256,
  writeJson,
} from "../../../packages/contracts/src/io.js";
import { pairwisePack } from "../../../packages/pairwise-eval/src/index.js";
import { comparisonRow, writeOverview } from "../../../packages/pairwise-eval/src/report.js";
import { loadRunInputs, readRunState } from "../../../packages/pairwise-eval/src/run-data.js";
import type { EvalConfig, PairwiseResult, TaskData } from "../../../packages/pairwise-eval/src/types.js";

export async function validateRun(run: string) {
  const state = await readRunState(run), manifest = state.manifest;
  const errors: string[] = [],
    receipts = new Map<string, SubmissionReceipt>();
  const inputs = await loadRunInputs(run, manifest);
  for (const id of Object.keys(manifest.inputs))
    if (!Object.hasOwn(inputs, id)) errors.push(`${id}: missing input`);
  for (const task of manifest.tasks) {
    const receipt = state.receipts[task.id];
    if (!receipt) {
      if (manifest.states[task.id]?.status === "succeeded") errors.push(`${task.id}: missing receipt`);
      continue;
    }
    try {
      if (
        receipt.taskId !== task.id ||
        receipt.status !== "succeeded" ||
        (!receipt.exported && receipt.submissionId !== digest([receipt.attemptId, receipt.evaluation]))
      )
        throw new Error("Receipt identity mismatch");
      if (manifest.debug) for (const artifact of receipt.audit.artifacts)
        if (
          sha256(await readFile(internalPath(run, "tasks", task.id, "artifacts", artifact.id))) !==
          artifact.digest
        )
          throw new Error("Artifact hash mismatch");
      receipts.set(task.id, receipt);
    } catch (error) {
      errors.push(`${task.id}: ${errorText(error)}`);
    }
  }
  for (const task of manifest.tasks) {
    const receipt = receipts.get(task.id);
    if (!receipt) continue;
    try {
      pairwisePack.validate(task, inputs, receipt.evaluation, receipt.audit,
        Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)])),
      );
    } catch (error) {
      errors.push(`${task.id}: ${errorText(error)}`);
    }
  }
  const names = Object.fromEntries(
      (manifest.config as EvalConfig).inputs.versions.map((v) => [v.id, v.display_name || v.name]),
    ),
    expected = new Map<string, string[]>();
  for (const task of manifest.tasks)
    if (task.stage === "pairwise" && receipts.has(task.id)) {
      try {
        const receipt = receipts.get(task.id)!;
        const value = receipt.evaluation as PairwiseResult;
        const row = receipt.exported?.row || comparisonRow(inputs, task, value, receipts, names),
          name = value.verdict.result === "not_comparable" ? "not_comparable.jsonl" : (task.data as TaskData).pair!.join("__vs__") + ".jsonl";
        if (!expected.has(name)) expected.set(name, []);
        expected.get(name)!.push(canonical(row));
      } catch (error) {
        errors.push(`${task.id}: ${errorText(error)}`);
      }
    }
  const directory = path.join(run, "results");
  const actual = (await exists(directory)) ? await readdir(directory) : [];
  for (const name of new Set([...actual.filter((v) => v.endsWith(".jsonl")), ...expected.keys()])) {
    try {
      const rows = (await readFile(path.join(directory, name), "utf8"))
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
    valid: errors.length === 0,
    completed_comparisons: [...expected].reduce((n, [name, rows]) => n + (name === "not_comparable.jsonl" ? 0 : rows.length), 0),
    errors,
    artifacts_checked: manifest.debug,
  };
  const file = path.join(run, "stats.json");
  const summary = await exists(file) ? await readJson(file) : undefined;
  const { errors: _errors, ...counts } = validation;
  await writeJson(file, { ...summary, validation: { ...counts, error_count: errors.length } });
  if (manifest.debug && errors.length)
    await writeJson(internalPath(run, "diagnostics", "validation.json"), validation);
  if (summary?.task_statuses) await writeOverview(run, summary, validation);
  return validation;
}
