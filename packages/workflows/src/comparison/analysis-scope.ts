import { fileSourceReader, locateRun, readJson } from "@eval/data";
import type { Checkpoint } from "./checkpoint.js";
import type { ClusteringJobSource } from "./clustering-job-types.js";

/** Read accepted receipt identities and progress without copying answer/result bodies. */
export async function readAnalysisAnswers(run: string) {
  const file = locateRun(run).stateFile, revision = await fileSourceReader.revision(file);
  const saved = await readJson<Checkpoint>(file);
  if (saved.format !== "evaluation-run") throw new Error("分析来源必须是评测运行");
  const rows = Object.entries(saved.tasks).flatMap(([id, task]) => {
    if (task.stage !== "attribution") return [];
    const input_id = task.inputIds.answer, candidate = saved.inputs[input_id];
    if (!candidate) throw new Error("归因任务缺少输入引用：" + id);
    const receipt = task.status === "succeeded" ? task.receipt : undefined;
    const source: ClusteringJobSource | undefined = receipt ? {
      run, run_id: saved.runId, task_id: id, submission_id: receipt.submissionId,
      evaluator_version: receipt.evaluatorVersion, input_id, model: candidate.version,
      batch_id: candidate.batch_id, case_id: candidate.case_id, source: { file: candidate.source, line: candidate.line },
    } : undefined;
    return [{ task_id: id, input_id, model: candidate.version, batch_id: candidate.batch_id, case_id: candidate.case_id,
      file: candidate.source, line: candidate.line, status: task.status, accepted_at: receipt?.acceptedAt, source }];
  });
  if (await fileSourceReader.revision(file) !== revision) throw new Error("运行结果正在更新，请刷新范围");
  return rows;
}
