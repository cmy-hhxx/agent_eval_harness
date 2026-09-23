import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RunManifest, SubmissionReceipt } from "../../../packages/contracts/src/index.js";
import {
  canonical,
  digest,
  errorText,
  exists,
  readJson,
  readInputs,
  sha256,
  writeJson,
} from "../../../packages/contracts/src/io.js";
import { pairwisePack } from "../../../packages/pairwise-eval/src/index.js";
import { comparisonRow } from "../../../packages/pairwise-eval/src/report.js";
import type { EvalConfig, PairwiseResult, TaskData } from "../../../packages/pairwise-eval/src/types.js";

export async function validateRun(run: string) {
  const manifest = await readJson<RunManifest>(path.join(run, "manifest.json"));
  if (manifest.format !== "dual-agent-eval/1")
    throw new Error("不支持此运行格式；请使用当前版本新建 run。");
  const errors: string[] = [],
    receipts = new Map<string, SubmissionReceipt>();
  const inputs = await readInputs(run);
  for (const id of Object.keys(manifest.inputs))
    if (!Object.hasOwn(inputs, id)) errors.push(`${id}: missing input`);
  for (const task of manifest.tasks) {
    const file = path.join(run, "tasks", task.id, "result.json");
    if (!(await exists(file))) {
      if (manifest.states[task.id]?.status === "succeeded") errors.push(`${task.id}: missing receipt`);
      continue;
    }
    try {
      const receipt = await readJson<SubmissionReceipt>(file);
      if (
        receipt.taskId !== task.id ||
        receipt.status !== "succeeded" ||
        receipt.submissionId !== digest([receipt.attemptId, receipt.evaluation])
      )
        throw new Error("Receipt identity mismatch");
      for (const artifact of receipt.audit.artifacts)
        if (
          sha256(await readFile(path.join(run, "tasks", task.id, "artifacts", artifact.id))) !==
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
        const value = receipts.get(task.id)!.evaluation as PairwiseResult;
        if (value.verdict.result === "not_comparable") continue;
        const row = comparisonRow(inputs, task, value, receipts, names),
          name = (task.data as TaskData).pair!.join("__vs__") + ".jsonl";
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
    completed_comparisons: [...expected.values()].reduce((n, rows) => n + rows.length, 0),
    errors,
  };
  await writeJson(path.join(run, "validation.json"), validation);
  return validation;
}
