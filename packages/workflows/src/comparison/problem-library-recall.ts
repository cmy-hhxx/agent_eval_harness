import path from "node:path";
import type { ProblemLibrary } from "@eval/contracts";
import { projectLibrary } from "@eval/agents/clustering";
import { readRunTasks } from "./run-data.js";
import { sessionProblemEntries, type SessionAttributionResult } from "@eval/agents/attribution";
import type { TaskData } from "./types.js";
import type { ClusteringRunReader } from "./clustering-job-types.js";

/** Recall only the selected accepted findings, keeping result text out of the shared library. */
export async function recallProblemLibrary(library: ProblemLibrary, output: string, readSource: ClusteringRunReader = readRunTasks) {
  const projection = projectLibrary(library);
  const examples = projection.components.flatMap(component => component.classes.flatMap(problem => problem.examples));
  const groups = new Map<string, typeof examples>();
  for (const example of examples) {
    const run = example.attribution?.run ?? path.join(output, example.run_id);
    groups.set(run, [...(groups.get(run) ?? []), example]);
  }
  await Promise.all([...groups].map(async ([run, samples]) => {
    const ids = [...new Set(samples.map(sample => sample.attribution?.task_id ?? sample.task_id))];
    const state = await readSource(run, ids);
    const dependencies = samples.filter(sample => !sample.attribution).map(sample => {
      const cluster = state.manifest.tasks.find(task => task.id === sample.task_id);
      const receipt = state.receipts[sample.task_id];
      if (cluster?.stage !== "clustering" || receipt?.submissionId !== sample.submission_id)
        throw new Error("问题类代表样本的聚类来源不一致：" + sample.problem_path);
      const id = cluster.dependencies[sample.input_id];
      if (!id) throw new Error("问题类代表样本缺少原归因：" + sample.problem_path);
      return id;
    });
    const source = dependencies.length ? await readSource(run, [...new Set([...ids, ...dependencies])]) : state;
    for (const sample of samples) {
      const taskId = sample.attribution?.task_id ?? state.manifest.tasks.find(task => task.id === sample.task_id)!.dependencies[sample.input_id]!;
      const task = source.manifest.tasks.find(task => task.id === taskId), receipt = source.receipts[taskId];
      if (task?.stage !== "attribution-session" || (task.data as TaskData).candidate?.input_id !== sample.input_id || !receipt ||
        (sample.attribution && (source.manifest.runId !== sample.attribution.run_id || receipt.submissionId !== sample.attribution.submission_id ||
          receipt.evaluatorVersion !== sample.attribution.evaluator_version)))
        throw new Error("问题类代表样本的原归因身份不一致：" + sample.problem_path);
      const finding = sessionProblemEntries(receipt.evaluation as SessionAttributionResult).find(item => item.problem_path === sample.problem_path);
      if (!finding)
        throw new Error("问题类代表样本的原发现缺失或不一致：" + sample.problem_path);
      sample.evidence_status = "已确认";
      sample.finding = finding.problem_phenomena;
      sample.reason = finding.reason;
      const evidence = finding.evidence[0];
      if (!evidence) throw new Error("问题类代表样本缺少本方原文：" + sample.problem_path);
      sample.quote = evidence.quote.length > 600 ? `${evidence.quote.slice(0, 600)}…` : evidence.quote;
    }
  }));
  return projection;
}
