import path from "node:path";
import type { ProblemLibrary } from "@eval/contracts";
import { projectLibrary } from "@eval/agents/clustering";
import { readRunTasks } from "./run-data.js";
import type { AttributionResult } from "./types.js";

/** Recall only the selected accepted findings, keeping result text out of the shared library. */
export async function recallProblemLibrary(library: ProblemLibrary, output: string) {
  const projection = projectLibrary(library);
  const examples = projection.components.flatMap(component => component.classes.flatMap(problem => problem.examples));
  const groups = new Map<string, typeof examples>();
  for (const example of examples) {
    const run = example.attribution?.run ?? path.join(output, example.run_id);
    groups.set(run, [...(groups.get(run) ?? []), example]);
  }
  await Promise.all([...groups].map(async ([run, samples]) => {
    const ids = [...new Set(samples.map(sample => sample.attribution?.task_id ?? sample.task_id))];
    const state = await readRunTasks(run, ids);
    const dependencies = samples.filter(sample => !sample.attribution).map(sample => {
      const cluster = state.manifest.tasks.find(task => task.id === sample.task_id);
      const receipt = state.receipts[sample.task_id];
      if (cluster?.stage !== "clustering" || receipt?.submissionId !== sample.submission_id)
        throw new Error("问题类代表样本的聚类来源不一致：" + sample.finding_id);
      const id = cluster.dependencies[sample.input_id];
      if (!id) throw new Error("问题类代表样本缺少原归因：" + sample.finding_id);
      return id;
    });
    const source = dependencies.length ? await readRunTasks(run, [...new Set([...ids, ...dependencies])]) : state;
    for (const sample of samples) {
      const taskId = sample.attribution?.task_id ?? state.manifest.tasks.find(task => task.id === sample.task_id)!.dependencies[sample.input_id]!;
      const task = source.manifest.tasks.find(task => task.id === taskId), receipt = source.receipts[taskId];
      if (task?.stage !== "attribution" || task.inputIds.answer !== sample.input_id || !receipt ||
        (sample.attribution && (source.manifest.runId !== sample.attribution.run_id || receipt.submissionId !== sample.attribution.submission_id ||
          receipt.evaluatorVersion !== sample.attribution.evaluator_version)))
        throw new Error("问题类代表样本的原归因身份不一致：" + sample.finding_id);
      const finding = (receipt.evaluation as AttributionResult).findings.find(item => item.finding_id === sample.finding_id);
      if (!finding || finding.type !== "problem" || finding.assessment.evidence_status !== sample.evidence_status)
        throw new Error("问题类代表样本的原发现缺失或不一致：" + sample.finding_id);
      sample.finding = finding.text;
      sample.reason = finding.reason;
      const evidence = finding.evidence.find(item => item.source === undefined && item.source_input_id === undefined);
      if (!evidence) throw new Error("问题类代表样本缺少本方原文：" + sample.finding_id);
      sample.quote = evidence.quote.length > 600 ? `${evidence.quote.slice(0, 600)}…` : evidence.quote;
    }
  }));
  return projection;
}
