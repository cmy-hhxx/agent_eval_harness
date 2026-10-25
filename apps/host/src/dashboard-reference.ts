import { attributionAgent } from "@eval/agents/attribution";
import { criteriaAgent } from "@eval/agents/criteria";
import { comparisonAgent } from "@eval/agents/comparison";
import { rewriteAgent } from "@eval/agents/rewrite";
import { clusteringAgent } from "@eval/agents/clustering";
import { evidenceSelectionSchema, SUBMISSION_FILE_SCHEMA, SUBMISSION_JSON_SCHEMA, type AgentProfile, type JsonSchema } from "@eval/contracts";
import { criteriaText, comparisonText, sharedPromptResources } from "@eval/prompts";
import { builtinTools } from "@eval/tools";
import { outputSchema, clusteringSchema, type EvalConfig } from "@eval/workflows/comparison";

interface ReferenceFlowStep {
  id: string;
  name: string;
  stage?: string;
  profile?: string;
  input?: string;
  output?: string;
}
interface ReferenceFlow {
  steps: ReferenceFlowStep[];
  branches: { name: string; condition: string; enabled?: boolean; steps: ReferenceFlowStep[] }[];
  rules: string[];
  sources: string[];
}

function referenceProfile(stage: string, profile: AgentProfile, name: string) {
  const agentSource = "packages/agents/src/" + stage + "/index.ts";
  const schemaSource = (document: string) => "schemas/" + stage + "/" + document + ".schema.json";
  const submissionSource = schemaSource(profile.inspection ? "verification-submission" : "submission");
  const sources: Record<string, string[]> = {
    request: profile.inspection ? [schemaSource("request"), schemaSource("result"), agentSource] : [schemaSource("request")],
    result: [schemaSource("result")],
    system: ["packages/prompts/resources/" + stage + "/" + profile.id + "/system.md"],
    instructions: ["packages/prompts/resources/" + stage + "/" + profile.id + "/instructions.md"],
    submissionNudge: ["packages/prompts/resources/shared/nudge.md"],
  };
  const schemas: Record<string, JsonSchema> = { request: profile.requestSchema };
  schemas.submission = profile.submissionSchema; sources.submission = [submissionSource];
  const modelSubmission = profile.evidenceSelections ? evidenceSelectionSchema(profile.submissionSchema) : profile.submissionSchema;
  if (profile.evidenceSelections) {
    schemas.modelSubmission = modelSubmission;
    sources.modelSubmission = [submissionSource, "packages/contracts/src/evidence-selection.ts", ...(profile.modelSubmissionSchema ? [agentSource] : [])];
  }
  if (profile.inspection) {
    schemas.modelInspection = profile.inspection.modelSchema ?? profile.inspection.schema;
    schemas.inspection = profile.inspection.schema;
    sources.modelInspection = [schemaSource("inspection"), "packages/agents/src/comparison/verification.ts", "packages/contracts/src/evidence-selection.ts"];
    sources.inspection = [schemaSource("inspection")];
  }
  schemas.result = profile.resultSchema!;
  const prompts: Record<string, string> = { system: profile.systemPrompt, instructions: profile.instructions, submissionNudge: profile.submissionNudge };
  if (stage === "criteria") {
    for (const [key, resource] of [["taskType", "task_type"], ["sourceRule", "source_rule"]] as const) {
      prompts[key] = criteriaText(resource);
      sources[key] = ["packages/prompts/resources/criteria/default/" + resource + ".md"];
    }
  }
  if (stage === "comparison") {
    for (const [key, resource] of [["reviewPending", "review_pending"], ["notApplicable", "not_applicable"]] as const) {
      prompts[key] = comparisonText(resource);
      sources[key] = ["packages/prompts/resources/comparison/default/" + resource + ".md"];
    }
  }
  const toolSchemas = Object.fromEntries(Object.keys(profile.toolDescriptions).map(tool => {
    const schema = tool === "submit_evaluation_file" || tool === "inspect_material" && profile.fileSubmission ? SUBMISSION_FILE_SCHEMA
      : tool === "submit_evaluation" ? profile.jsonStringSubmission ? SUBMISSION_JSON_SCHEMA : modelSubmission : tool === "inspect_material" ? schemas.modelInspection
      : builtinTools.find(definition => definition.name === tool)?.inputSchema;
    if (!schema) throw new Error("Missing reference tool schema: " + stage + "/" + profile.id + "/" + tool);
    return [tool, schema];
  }));
  sources.toolSchemas = [...new Set([
    ...Object.keys(profile.toolDescriptions).map(tool => "packages/prompts/resources/tools/" + tool + ".md"),
    "packages/tools/src/index.ts", "packages/host/src/agents.ts", submissionSource,
    ...(profile.fileSubmission || profile.jsonStringSubmission ? ["packages/contracts/src/index.ts"] : []),
    ...(profile.evidenceSelections ? ["packages/contracts/src/evidence-selection.ts"] : []),
    ...(profile.modelSubmissionSchema ? [agentSource] : []),
    ...(profile.inspection ? [schemaSource("inspection"), "packages/agents/src/comparison/verification.ts"] : []),
  ])];
  return { id: profile.id, name, schemas, prompts, sources, toolDescriptions: profile.toolDescriptions, toolSchemas,
    fileSubmission: profile.fileSubmission, jsonStringSubmission:Boolean(profile.jsonStringSubmission),requestBoundSubmission: Boolean(profile.modelSubmissionSchema) };
}

/** Read-only reference assembled from the same public definitions used by the Host. */
export function dashboardReference(config: EvalConfig, evaluatorVersion: unknown) {
  return {
    evaluator_version: evaluatorVersion,
    inputs: config.inputs,
    comparisons: config.comparisons,
    storage: { runs: config.output.path, problems: config.problemLibrary.path },
    execution: config.execution,
    rewrite: config.rewrite,
    clustering: config.clustering,
    sharedPrompts: Object.fromEntries(sharedPromptResources().map(({ name, text, source }) => [name, { text, source }])),
    stages: [
      { id: "criteria", name: "共同标准", unit: "同问题与标准答案范围", input: "问题与候选 USER 指令来源", output: "原文来源选择生成的要求、得分点、红线与固定验收规则", dependency: "输入预检通过", file: "criteria.jsonl", profiles: [referenceProfile("criteria", criteriaAgent.profiles.default, "共同标准")] },
      { id: "attribution", name: "归因", unit: "单条回答", input: "公开任务、适用规则、最终交付与原始调用链", output: "评审总结、问题与责任证据、标准答案一致性", dependency: "共同标准已接受", file: "attribution.jsonl", profiles: [referenceProfile("attribution", attributionAgent.profiles.default, "单回答归因")] },
      { id: "comparison", name: "对比", unit: "同批次、同 case 的两条候选", input: "共同标准、双方归因、真实规范与原始材料", output: "正式裁决或证据不足结果；可选复核结果单独保存", dependency: "共同标准与双方归因已接受；可选复核依赖已接受的正式裁决", file: "comparison.jsonl / comparison-review.jsonl / comparison-verification.jsonl", profiles: [referenceProfile("comparison", comparisonAgent.profiles.default, "对比评测"), referenceProfile("comparison", comparisonAgent.profiles.verification, "可选复核")] },
      { id: "rewrite", name: "改写", unit: "已接受结果的文本槽位", input: "槽位 ID、原文与已确定偏好；无原始证据", output: "同 ID 的润色文本", dependency: "源结果已接受；对比已裁决；对应开关开启", file: "源结果的 rewritten 字段", profiles: [referenceProfile("rewrite", rewriteAgent.profiles.default, "文本改写")] },
      { id: "clustering", name: "聚类", unit: "模型 × 批次分片", input: "归因的问题观察、组件与当前问题库", output: "归类、延期、新类、合并与目录维护决定", dependency: "全部基础归因完成后显式准备聚类；只使用已接受的归因", file: "clustering.jsonl", profiles: [referenceProfile("clustering", clusteringAgent.profiles.default, "问题聚类")] },
    ],
    flow: {
      steps: [
        { id: "criteria", name: "共同标准", stage: "criteria", profile: "default", input: "问题与 USER 来源", output: "原文标准与适用范围" },
        { id: "attribution", name: "单回答归因", stage: "attribution", profile: "default", input: "本方完整规范与实际材料", output: "已接受归因" },
        { id: "comparison", name: "对比评测", stage: "comparison", profile: "default", input: "双方归因与真实材料", output: "正式裁决或证据不足结果" },
      ],
      branches: [
        { name: "可选独立复核", condition: "用户显式准备已完成对比的复核；失败或证据不足不影响原正式裁决", steps: [
          { id: "inspection", name: "独立首查", stage: "comparison", profile: "verification", input: "真实材料；隐藏上游判词", output: "inspect_material 检查点" },
          { id: "verification", name: "揭示后核验", stage: "comparison", profile: "verification", input: "原正式裁决与归因", output: "独立复核结果；不自动开启归因或对比重评" },
        ] },
        { name: "归因改写", condition: "已接受归因", enabled: config.rewrite.attribution, steps: [{ id: "attribution-rewrite", name: "归因文本槽位", stage: "rewrite", profile: "default" }] },
        { name: "对比偏好改写", condition: "对比已接受正式裁决", enabled: config.rewrite.comparison, steps: [{ id: "comparison-rewrite", name: "对战偏好理由", stage: "rewrite", profile: "default" }] },
        { name: "总评与取舍改写", condition: "对比改写与 comparisonItems 开启", enabled: config.rewrite.comparison && config.rewrite.comparisonItems === true, steps: [{ id: "comparison-items-rewrite", name: "双方整体总评与取舍", stage: "rewrite", profile: "default" }] },
        { name: "问题库维护", condition: "全部基础归因完成后单独准备；使用已接受归因，不依赖对比裁决", enabled: config.clustering.enabled, steps: [
          { id: "clustering", name: "聚类决定", stage: "clustering", profile: "default" },
          { id: "problem-library", name: "模型问题库", output: "归类、新类、合并、目录与样本事件" },
        ] },
        { name: "聚类改写", condition: "聚类已接受", enabled: config.clustering.enabled && config.rewrite.clustering, steps: [{ id: "clustering-rewrite", name: "类定义与决定理由", stage: "rewrite", profile: "default" }] },
      ],
      rules: [
        "共同标准只选择问题、有效标准答案与 USER 约束原文；SYS / DEV 完整规范由归因独立核查。",
        "归因与核验选择任务内正整数 evidence_index；程序解析并保留 evidence_id、message_index、quote 与真实来源。",
        "默认共同标准、归因、对比；首次对比前关键观察未对齐时最多补查一轮。decided 正式导出，needs_review 保留具体待核事项，已接受对比不重评。",
        "可选复核首查隐藏归因、排名与上游评审；inspect_material 成功后揭示，复核结果单独保存，不覆盖正式裁决。",
        "对比确认既有 finding；排名、核心状态与逐项关联由程序解析，两两判决由排名和核心可用性派生。",
        "better_candidates 为空表示未区分优劣；unknown 与 not_applicable 保留各自状态，不从摘要另判。",
        "改写只润色指定文本槽位；原判词、证据、排名与判决保留。",
        "聚类在全部基础归因完成后单独准备，维护每模型跨 run 问题库；归因不建类，对比不改写归因。",
        "同 run ID 续跑保留已接受任务与收据，只补未完成和新增任务。",
      ],
      sources: ["packages/workflows/src/comparison/input.ts", "packages/workflows/src/comparison/binding.ts", "packages/workflows/src/comparison/verification-preparation.ts", "packages/workflows/src/comparison/repair.ts", "packages/workflows/src/comparison/results.ts", "packages/workflows/src/comparison/rewrite-projection.ts"],
    } as ReferenceFlow,
    exports: { comparison: outputSchema, clustering: clusteringSchema },
    exportSources: {
      comparison: ["schemas/workflow/export.schema.json", "schemas/comparison/result.schema.json", "schemas/attribution/result.schema.json", "schemas/workflow/annotation.schema.json", "packages/workflows/src/comparison/schema.ts"],
      clustering: ["schemas/workflow/clustering.schema.json", "schemas/clustering/result.schema.json", "packages/workflows/src/comparison/schema.ts"],
    },
  };
}
