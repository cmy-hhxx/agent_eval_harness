import { attributionProfile } from "@eval/agents/attribution";
import { comparisonProfile } from "@eval/agents/comparison";
import { rewriteProfile } from "@eval/agents/rewrite";
import { clusteringProfile } from "@eval/agents/clustering";
import { outputSchema, commentarySchema, clusteringSchema, type EvalConfig } from "@eval/workflows/comparison";

/** Read-only reference assembled from the same public profiles used by the Host. */
export function dashboardReference(config: EvalConfig, evaluatorVersion: unknown) {
  return {
    evaluator_version: evaluatorVersion,
    inputs: config.inputs,
    comparisons: config.comparisons,
    storage: { runs: config.output.path, problems: config.problemLibrary.path },
    execution: config.execution,
    rewrite: config.rewrite,
    clustering: config.clustering,
    stages: [
      { id: "attribution", name: "归因", unit: "单条回答", input: "问题、最终回答与调用链", output: "任务分析、判定、发现与证据", dependency: "有效输入", file: "attribution.jsonl", profile: attributionProfile },
      { id: "comparison", name: "对比", unit: "同批次、同 case 的对比组", input: "各候选归因与原始材料", output: "排名、核心要求判定与决定性发现", dependency: "组内归因全部成功", file: "comparison.jsonl", profile: comparisonProfile },
      { id: "rewrite", name: "改写", unit: "一份归因或对比结果", input: "已接受结果的文本槽位", output: "槽位 ID 与润色文本", dependency: "源结果成功；对应开关开启", file: "commentary.jsonl", profile: rewriteProfile },
      { id: "clustering", name: "聚类", unit: "模型 × 批次分片", input: "问题观察与当前问题库", output: "归类、新类与合并决定", dependency: "该分片归因完成；聚类开启", file: "clustering.jsonl", profile: clusteringProfile },
    ].map(({ profile, ...stage }) => ({
      ...stage,
      tools: profile.toolNames,
      schemas: stage.id === "attribution"
        ? { request: profile.requestSchema, submission: profile.submissionSchema, result: profile.resultSchema }
        : { request: profile.requestSchema, result: profile.resultSchema },
      prompts: { system: profile.systemPrompt, instructions: profile.instructions },
    })),
    exports: { comparison: outputSchema, commentary: commentarySchema, clustering: clusteringSchema },
  };
}
