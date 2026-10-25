import { locateRun, readJson } from "@eval/data";
import { answerReviewRepository, validateAnswerReview } from "@eval/workflows/answer-review";
import { readRunTasks, type ClusteringRunReader } from "@eval/workflows/comparison";
import type { Candidate } from "@eval/workflows/inputs";

/** Read each workflow with its own codec; only the in-memory clustering owner view is shared. */
export const readClusteringSource: ClusteringRunReader = async (run, taskIds) => {
  const saved = await readJson<{ workflow?: string; format?: string }>(locateRun(run).stateFile);
  if (saved.format === "evaluation-run") return readRunTasks(run, taskIds);
  if (saved.workflow !== "answer-review") throw new Error("聚类来源必须是评测 run：" + run);
  const state = await answerReviewRepository.readTasks(run, taskIds);
  validateAnswerReview(state);
  for (const id of taskIds) {
    const task = state.manifest.tasks.find(task => task.id === id), receipt = state.receipts[id];
    if (!task) throw new Error("聚类来源任务不存在：" + id);
    if (!receipt) continue;
    const candidate = (task.data as { candidate: Candidate }).candidate, row = receipt.exported?.row, meta = row?.meta as Record<string,unknown>|undefined;
    if (task.stage !== "attribution" || !row || receipt.taskId !== id || receipt.exported?.file !== "attribution.jsonl" ||
        meta?.task_id !== id || meta?.submission_id !== receipt.submissionId || meta?.evaluator_version !== receipt.evaluatorVersion ||
        meta?.input_id !== candidate.input_id || meta?.version !== candidate.version || meta?.batch_id !== candidate.batch_id ||
        meta?.case_id !== candidate.case_id || meta?.trace_id !== candidate.trace_id ||
        meta?.input_file !== candidate.source || meta?.input_line !== candidate.line)
      throw new Error("AIME 正式归因与来源收据不一致：" + id);
  }
  return { ...state, manifest: { ...state.manifest, tasks: state.manifest.tasks.map(task => {
    const { candidate, ...data } = task.data as { candidate: Candidate; [key: string]: unknown };
    if (!candidate || !state.manifest.inputCatalog?.some(input => (input as Candidate).input_id === candidate.input_id))
      throw new Error("AIME 聚类来源缺少登记的回答：" + task.id);
    return { ...task, data: { ...data, candidates: { A: candidate } } };
  }) } };
};
