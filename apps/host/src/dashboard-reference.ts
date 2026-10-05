import { attributionAgent } from "@eval/agents/attribution";
import { criteriaAgent } from "@eval/agents/criteria";
import { comparisonAgent } from "@eval/agents/comparison";
import { rewriteAgent } from "@eval/agents/rewrite";
import { clusteringAgent } from "@eval/agents/clustering";
import { evidenceSelectionSchema, type AgentProfile, type JsonSchema } from "@eval/contracts";
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
  const submissionSource = schemaSource(stage === "rewrite" ? "result" : profile.inspection ? "verification-submission" : "submission");
  const sources: Record<string, string[]> = {
    request: profile.inspection ? [schemaSource("request"), schemaSource("result"), agentSource] : [schemaSource("request")],
    result: [schemaSource("result")],
    system: ["packages/prompts/resources/" + stage + "/" + profile.id + "/system.md"],
    instructions: ["packages/prompts/resources/" + stage + "/" + profile.id + "/instructions.md"],
    submissionNudge: ["packages/prompts/resources/shared/nudge.md"],
  };
  const schemas: Record<string, JsonSchema> = { request: profile.requestSchema };
  if (stage !== "rewrite") { schemas.submission = profile.submissionSchema; sources.submission = [submissionSource]; }
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
    for (const [key, resource] of [["taskType", "task_type"], ["sourceRule", "source_rule"], ["referenceRule", "reference_rule"]] as const) {
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
    const schema = tool === "submit_evaluation" ? modelSubmission : tool === "inspect_material" ? schemas.modelInspection
      : builtinTools.find(definition => definition.name === tool)?.inputSchema;
    if (!schema) throw new Error("Missing reference tool schema: " + stage + "/" + profile.id + "/" + tool);
    return [tool, schema];
  }));
  sources.toolSchemas = [...new Set([
    ...Object.keys(profile.toolDescriptions).map(tool => "packages/prompts/resources/tools/" + tool + ".md"),
    "packages/tools/src/index.ts", "packages/host/src/agents.ts", submissionSource,
    ...(profile.evidenceSelections ? ["packages/contracts/src/evidence-selection.ts"] : []),
    ...(profile.modelSubmissionSchema ? [agentSource] : []),
    ...(profile.inspection ? [schemaSource("inspection"), "packages/agents/src/comparison/verification.ts"] : []),
  ])];
  return { id: profile.id, name, schemas, prompts, sources, toolDescriptions: profile.toolDescriptions, toolSchemas,
    fileSubmission: profile.fileSubmission, requestBoundSubmission: Boolean(profile.modelSubmissionSchema) };
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
      { id: "criteria", name: "共同标准", unit: "同问题与标准答案范围", input: "问题、标准答案与候选 USER 指令来源", output: "原文来源选择生成的要求、得分点、红线与固定验收规则", dependency: "输入预检通过", file: "criteria.jsonl", profiles: [referenceProfile("criteria", criteriaAgent.profiles.default, "共同标准")] },
      { id: "attribution", name: "归因", unit: "单条回答", input: "共同标准、本方完整规范、最终交付与原始调用链", output: "标准评估、核心可用性、标准答案核对、发现与证据", dependency: "共同标准已接受", file: "attribution.jsonl", profiles: [referenceProfile("attribution", attributionAgent.profiles.default, "单回答归因")] },
      { id: "comparison", name: "对比", unit: "同批次、同 case 的两条候选", input: "共同标准、双方归因、真实规范与原始材料", output: "比较草稿；独立核验接受的裁决或归因复核请求", dependency: "共同标准与双方归因已接受；核验还依赖不可变草稿", file: "comparison-draft.jsonl / comparison.jsonl / comparison-review.jsonl", profiles: [referenceProfile("comparison", comparisonAgent.profiles.default, "对比草稿"), referenceProfile("comparison", comparisonAgent.profiles.verification, "独立核验")] },
      { id: "rewrite", name: "改写", unit: "已接受结果的文本槽位", input: "槽位 ID、原文与已确定偏好；无原始证据", output: "同 ID 的润色文本", dependency: "源结果已接受；对比已裁决；对应开关开启", file: "源结果的 rewritten 字段", profiles: [referenceProfile("rewrite", rewriteAgent.profiles.default, "文本改写")] },
      { id: "clustering", name: "聚类", unit: "模型 × 批次分片", input: "归因的问题观察、组件与当前问题库", output: "归类、延期、新类、合并与目录维护决定", dependency: "该分片归因与涉及对局裁决完成；聚类开启", file: "clustering.jsonl", profiles: [referenceProfile("clustering", clusteringAgent.profiles.default, "问题聚类")] },
    ],
    flow: {
      steps: [
        { id: "preflight", name: "输入预检", input: "来源适配与登记", output: "有效样本及独立模型对" },
        { id: "criteria", name: "共同标准", stage: "criteria", profile: "default", input: "问题、标准答案与 USER 来源", output: "原文标准与适用范围" },
        { id: "attribution", name: "单回答归因", stage: "attribution", profile: "default", input: "本方完整规范与实际材料", output: "已接受归因" },
        { id: "draft", name: "对比草稿", stage: "comparison", profile: "default", input: "双方归因与真实材料", output: "不可变草稿" },
        { id: "inspection", name: "独立首查", stage: "comparison", profile: "verification", input: "真实材料；隐藏上游判词", output: "inspect_material 检查点" },
        { id: "verification", name: "揭示后核验", stage: "comparison", profile: "verification", input: "草稿、归因与未闭合问题", output: "decided / needs_review" },
      ],
      branches: [
        { name: "一次独立归因复核", condition: "首次核验 needs_review；只复核请求涉及的候选", steps: [
          { id: "attribution-review", name: "独立归因复核", stage: "attribution", profile: "default" },
          { id: "review-draft", name: "新对比草稿", stage: "comparison", profile: "default" },
          { id: "review-verification", name: "新首查与核验", stage: "comparison", profile: "verification" },
        ] },
        { name: "末轮待复核", condition: "一次复核后仍为 needs_review", steps: [
          { id: "blocked", name: "阻塞该对局的改写与聚类", output: "保留原收据、review_of 与 superseded_by；无正式判决或统计" },
        ] },
        { name: "归因改写", condition: "已接受归因", enabled: config.rewrite.attribution, steps: [{ id: "attribution-rewrite", name: "归因文本槽位", stage: "rewrite", profile: "default" }] },
        { name: "对比偏好改写", condition: "独立核验 decided", enabled: config.rewrite.comparison, steps: [{ id: "comparison-rewrite", name: "对战偏好理由", stage: "rewrite", profile: "default" }] },
        { name: "逐项点评改写", condition: "对比改写与 comparisonItems 开启", enabled: config.rewrite.comparison && config.rewrite.comparisonItems === true, steps: [{ id: "comparison-items-rewrite", name: "全部候选格 summary", stage: "rewrite", profile: "default" }] },
        { name: "问题库维护", condition: "该分片归因与涉及对局裁决完成", enabled: config.clustering.enabled, steps: [
          { id: "clustering", name: "聚类决定", stage: "clustering", profile: "default" },
          { id: "problem-library", name: "模型问题库", output: "归类、新类、合并、目录与样本事件" },
        ] },
        { name: "聚类改写", condition: "聚类已接受", enabled: config.clustering.enabled && config.rewrite.clustering, steps: [{ id: "clustering-rewrite", name: "类定义与决定理由", stage: "rewrite", profile: "default" }] },
      ],
      rules: [
        "共同标准只选择问题、有效标准答案与 USER 约束原文；SYS / DEV 完整规范由归因独立核查。",
        "归因与核验选择任务内正整数 evidence_index；程序解析并保留 evidence_id、message_index、quote 与真实来源。",
        "草稿不产生正式对局、统计、聚类或对局点评改写；只有独立核验接受的 decided 结果进入正式导出。",
        "首查隐藏归因、排名与上游评审；inspect_material 成功后揭示，再提交已有发现的匹配、反驳与来源复核选择。",
        "对比确认既有 finding；排名、核心状态与逐项关联由程序解析，两两判决由排名和核心可用性派生。",
        "better_candidates 为空表示未区分优劣；unknown 与 not_applicable 保留各自状态，不从摘要另判。",
        "改写只润色指定文本槽位；原判词、证据、排名与判决保留。",
        "聚类维护每模型跨 run 问题库；归因不建类，对比不改写归因。",
        "同 run ID 续跑保留已接受任务与收据，只补未完成和新增任务。",
      ],
      sources: ["packages/workflows/src/comparison/input.ts", "packages/workflows/src/comparison/binding.ts", "packages/workflows/src/comparison/review.ts", "packages/workflows/src/comparison/results.ts", "packages/workflows/src/comparison/rewrite-projection.ts"],
    } as ReferenceFlow,
    exports: { comparison: outputSchema, clustering: clusteringSchema },
    exportSources: {
      comparison: ["schemas/workflow/export.schema.json", "schemas/comparison/result.schema.json", "schemas/attribution/result.schema.json", "schemas/workflow/annotation.schema.json", "packages/workflows/src/comparison/schema.ts"],
      clustering: ["schemas/workflow/clustering.schema.json", "schemas/clustering/result.schema.json", "packages/workflows/src/comparison/schema.ts"],
    },
  };
}
