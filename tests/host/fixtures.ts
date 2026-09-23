import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EngineIdentity, ToolAudit } from "../../packages/contracts/src/index.js";
import { ROOT, writeJsonl } from "../../packages/contracts/src/io.js";
import { loadConfig } from "../../packages/pairwise-eval/src/input.js";
import type { PairwiseResult, RawInput } from "../../packages/pairwise-eval/src/types.js";

export const fakeIdentity: EngineIdentity = {
  engine: "pi",
  version: "fixture",
  commit: "fixture",
  sourceDigest: "fixture",
  buildDigest: "fixture",
};
export const emptyAudit = (): ToolAudit => ({ calls: 0, viewedImages: [], calculations: [], artifacts: [] });
export function raw(caseId = "q1", reference: unknown = "4", answer = "2+2=4"): RawInput {
  return {
    batch_id: "b1",
    case_id: caseId,
    messages: [
      { type: "message", role: "user", content: "计算2+2" },
      { type: "message", role: "assistant", content: answer },
    ],
    meta: { ok: true, ground_truth: reference, finish_answer_time_cost: 1200 },
  };
}
export function pairResult(answers: Record<string, string> = { A: "2+2=4", B: "2+2=4" }): PairwiseResult {
  return {
    verdict: { result: "both_good", reason: "两个都好。双方正确回答加法结果。" },
    task_analysis: {
      task_type: "整数加法",
      goal: "计算2+2",
      requirements: ["给出正确的加法结果"],
      scoring_points: ["使用指定操作数"],
      red_flags: ["擅自替换操作数"],
      timing_analysis: "",
    },
    decision_basis: {
      decisive_findings: [
        { candidate: "A", finding_index: 0 },
        { candidate: "B", finding_index: 0 },
      ],
      counterevidence: [],
      tradeoff: "双方均满足同一要求，没有结果差异。",
    },
    evaluations: Object.fromEntries(
      Object.entries(answers).map(([label, answer]) => [
        label,
        {
          summary: "正确给出了结果。",
          findings: [
            {
              type: "strength",
              dimension: "correctness",
              stage: "final_answer",
              importance: "high",
              text: "加法结果正确",
              reason: "与题目要求一致。",
              assessment: {
                requirement_index: 0,
                observation: answer,
                evidence_status: "established",
                impact: "完成加法要求。",
              },
              evidence: [{ message_index: 1, quote: answer }],
            },
          ],
        },
      ]),
    ),
  };
}
export async function fixtureConfig(rows: RawInput[][] = [[raw()], [raw()], [raw()], [raw()]]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dual-eval-test-"));
  const config = await loadConfig(path.join(ROOT, "configs/host.json"), {
    EVAL_BASE_URL: "http://127.0.0.1:1/v1",
  });
  config.outputDir = path.join(directory, "runs");
  config.cacheDir = path.join(directory, "cache");
  config.execution.retries = 0;
  config.execution.retryDelaySeconds = 0;
  config.execution.timeoutSeconds = 30;
  config.execution.idleTimeoutSeconds = 10;
  config.execution.concurrency = 2;
  for (const [i, version] of config.inputs.versions.entries()) {
    version.path = path.join(directory, version.id + ".jsonl");
    version.adapter = "a";
    await writeJsonl(version.path, rows[i] || []);
  }
  return { directory, config };
}
