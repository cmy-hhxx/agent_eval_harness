import { attributionProfile } from "@eval/agents/attribution";
import { criteriaProfile } from "@eval/agents/criteria";
import { comparisonProfile } from "@eval/agents/comparison";
import { rewriteProfile } from "@eval/agents/rewrite";
import { clusteringProfile } from "@eval/agents/clustering";
import { outputSchema, clusteringSchema, type EvalConfig } from "@eval/workflows/comparison";

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
      { id: "criteria", name: "共同标准", unit: "同问题与标准答案范围", input: "问题、标准答案与候选指令", output: "共同要求、得分点、红线与验收规则", dependency: "有效输入", file: "criteria.jsonl", profile: criteriaProfile },
      { id: "attribution", name: "归因", unit: "单条回答", input: "共同标准、最终回答与调用链", output: "逐条标准评估、核心判定、发现与证据", dependency: "共同标准成功", file: "attribution.jsonl", profile: attributionProfile },
      { id: "comparison", name: "对比", unit: "同批次、同 case 的两条候选", input: "共同标准、各候选归因与原始材料", output: "草稿独立核验后的排名、核心要求判定或归因复核请求", dependency: "共同标准与双方归因成功", file: "comparison-draft.jsonl / comparison.jsonl / comparison-review.jsonl", profile: comparisonProfile },
      { id: "rewrite", name: "改写", unit: "一份归因、对比或聚类结果", input: "已接受结果的文本槽位", output: "槽位 ID 与润色文本", dependency: "源结果成功；对应开关开启", file: "源结果的 rewritten 字段", profile: rewriteProfile },
      { id: "clustering", name: "聚类", unit: "模型 × 批次分片", input: "问题观察与当前问题库", output: "归类、新类与合并决定", dependency: "该分片归因与涉及对局裁决完成；聚类开启", file: "clustering.jsonl", profile: clusteringProfile },
    ].map(({ profile, ...stage }) => ({
      ...stage,
      toolDescriptions: profile.toolDescriptions,
      schemas: stage.id === "rewrite"
        ? { request: profile.requestSchema, result: profile.resultSchema }
        : { request: profile.requestSchema, submission: profile.submissionSchema, result: profile.resultSchema },
      prompts: { system: profile.systemPrompt, instructions: profile.instructions, submissionNudge: profile.submissionNudge },
    })),
    exports: { comparison: outputSchema, clustering: clusteringSchema },
  };
}
