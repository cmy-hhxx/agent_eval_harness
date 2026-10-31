import { readFileSync } from "node:fs";
import { canonical, submissionToolNames, type FailureContext, type JsonObject, type Policy } from "@eval/contracts";

export type PromptStage = "compact" | "criteria" | "attribution" | "comparison" | "rewrite" | "clustering" | "score" | "instruction-review";

const builtinToolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "calculate_pair", "execute_code",
  "read_artifact", "check_table", "inspect_material", "edit_json", "review_material", "review_calculate", "review_external", "score_material", "score_calculate", "score_external", ...submissionToolNames(false), ...submissionToolNames(true),
] as const;

const resources = new Map<string, string>();
function resource(path: string): string {
  const loaded = resources.get(path);
  if (loaded !== undefined) return loaded;
  const text = readFileSync(new URL(`../resources/${path}`, import.meta.url), "utf8").trim();
  if (!text) throw new Error(`Empty prompt resource: ${path}`);
  resources.set(path, text);
  return text;
}

const material = resource("shared/material.md");
const commentary = resource("shared/commentary.md");
const evidence = resource("shared/evidence.md");
const taskFocus = resource("shared/task-focus.md");
const budget = resource("shared/budget.md");
const recovery = resource("shared/recovery.md");
const nudge = resource("shared/nudge.md");
export function workflowText(name: "attribution-material" | "core-rewrite" | "criteria-review" | "prediction-evaluation" | "material-omitted"): string {
  return resource(`workflow/${name}.md`);
}
export const attributionNoStandardReason = resource("attribution/trace/no-standard-reason.md");
const attributionRules = Object.fromEntries(["standard-answer", "numeric", "table-doubts", "images", "capture-gaps"]
  .map(name => [name, resource(`attribution/conditional/${name}.md`)]));
/** Only applicable procedural rules accompany this request; fixed decisions remain in the system prompt. */
export function attributionConditionalRules(options: {
  standardAnswer: boolean; numeric: boolean; tableDoubts: boolean; images: boolean; captureGaps: boolean;
}): string {
  return [options.standardAnswer && attributionRules["standard-answer"],
    options.standardAnswer && options.numeric && attributionRules.numeric,
    options.tableDoubts && attributionRules["table-doubts"], options.images && attributionRules.images,
    options.captureGaps && attributionRules["capture-gaps"]].filter(Boolean).join("\n\n");
}
export const compactFields = JSON.parse(resource("compact/fields.json")) as Record<string, {
  scope: "session" | "turn"; instruction: string; submission_example?: JsonObject;
}>;
export const compactOutputGuidance = JSON.parse(resource("compact/output-guidance.json")) as {
  repair_instruction: string; field_task: string;
};
const descriptions = new Map<string, string>(
  builtinToolNames.map((name) => [name, resource(`tools/${name}.md`)]),
);

/** The only source of model-facing text for the built-in evaluation profiles. */
function scoreRules(profile:string):string {
  if(profile!=='default')throw Error('Unknown Score profile: '+profile);
  const rubric=resource('score/skill/rubric.md'),scoring=resource('score/skill/scoring.md');
  const start=rubric.indexOf('## 7.'),end=rubric.indexOf('## 9.');
  return [rubric.slice(start,end),scoring].join('\n\n');
}

export interface AgentPromptOptions {
  profile?: string;
  fileSubmission: boolean;
  draftWriteInCallLimit?: boolean;
}

export function agentPrompt(stage: PromptStage, toolNames: string[], options: AgentPromptOptions) {
  const { profile = "default", fileSubmission, draftWriteInCallLimit = false } = options;
  if (!/^[a-z][a-z0-9_-]*$/.test(profile)) throw new Error(`Invalid prompt profile: ${profile}`);
  const resourceProfile=profile;
  const instructions = resource(`${stage}/${resourceProfile}/instructions.md`) + (stage === "score" ? '\n\n'+scoreRules(profile) : "") +
    (stage === "attribution" && ["component", "session"].includes(profile)
      ? (profile === "component" ? "\n\n" + resource("attribution/component-choice.md") : "") + "\n\n" + resource("attribution/problem-output.md") : "");
  const evidenceGuide = !["attribution", "compact"].includes(stage) && toolNames.some(name => ["read_trace", "search_trace", "view_image", "check_table"].includes(name))
    ? `\n${evidence}\n` : "";
  const systemPrompt = resource(`${stage}/${resourceProfile}/system.md`) + "\n\n" + (["score", "attribution", "compact"].includes(stage) ? "" : commentary + "\n\n") + instructions + evidenceGuide;
  const names = [...toolNames, ...submissionToolNames(fileSubmission)];
  if (new Set(names).size !== names.length) throw new Error(`Duplicate prompt tool in ${stage}`);
  const toolDescriptions = Object.fromEntries(names.map((name) => {
    const description = stage === "compact" && name === "submit_evaluation"
      ? resource("compact/submit_evaluation.md") : stage === "attribution" && !fileSubmission && name === "execute_code"
      ? resource("attribution/trace/execute_code.md") : descriptions.get(name);
    if (!description) throw new Error(`Missing tool description: ${name}`);
    return [name, description];
  }));
  return {
    systemPrompt,
    instructions,
    submissionNudge: nudge,
    toolDescriptions,
    fileSubmission,
    ...(draftWriteInCallLimit ? { draftWriteInCallLimit: true } : {}),
    renderPrompt(input: JsonObject, policy?: Policy, failure?: FailureContext): string {
      if (failure && !policy) throw new Error("Recovery requires an execution policy");
      const { task_focus, ...complete } = input;
      const focus = task_focus === undefined ? "" : `${stage === "attribution" ? resource("attribution/trace/task-focus.md") : taskFocus}\n${JSON.stringify(task_focus)}\n\n`;
      const limits = policy ? {
        content_call_limit: 1 + policy.repairAttempts,
        ...(toolNames.some(name => name !== "inspect_material") ? {
          exploration_call_limit: Math.max(0, policy.maxToolCalls + (stage === 'attribution' ? 3 * policy.repairAttempts : 0) - Number(draftWriteInCallLimit)),
          ...(draftWriteInCallLimit ? { reserved_draft_calls: 1 } : {}),
        } : {}),
        ...(toolNames.includes("execute_code") ? { code_timeout_seconds: policy.codeTimeoutSeconds } : {}),
      } : undefined;
      return focus + `${material}\n` + canonical(task_focus === undefined ? input : complete) +
        (limits ? `\n\n${budget}${JSON.stringify(limits)}。` : "") +
        (failure ? `\n${["compact", "attribution"].includes(stage) ? resource("shared/attribution-recovery.md") : recovery}\n${JSON.stringify({
          ...(!failure.stopped ? { draft: failure.draft } : {}), errors: failure.errors,
        })}` : "");
    },
  };
}

/** Fixed Criteria wording; models select original sources instead of authoring acceptance rules. */
export function criteriaText(name: "task_type" | "source_rule" | "model_quality"): string {
  return resource(`criteria/default/${name}.md`);
}

/** Program-owned Comparison wording; review requests never claim an outcome. */
export function comparisonText(name: "review_pending" | "not_applicable" | "relative_preference" | "tradeoff_candidate"): string {
  return resource(`comparison/default/${name}.md`);
}

/** Recorded resource measurements are rendered verbatim, without model-authored arithmetic. */
export function comparisonResourceText(metrics: { finish_seconds: number | null; total_tokens: number | null }): string {
  const text = JSON.parse(resource("comparison/default/resource-summary.json")) as { summary: string; seconds: string; unrecorded: string };
  return text.summary.replace("{seconds}", metrics.finish_seconds === null ? text.unrecorded : text.seconds.replace("{value}", String(metrics.finish_seconds)))
    .replace("{tokens}", metrics.total_tokens === null ? text.unrecorded : String(metrics.total_tokens));
}

/** Eris owns its instructions and tool wording separately from evaluation profiles. */
export function erisPrompt(toolNames: string[]) {
  if (new Set(toolNames).size !== toolNames.length) throw new Error("Duplicate prompt tool in Eris");
  const toolDescriptions = Object.fromEntries(toolNames.map((name) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid Eris tool name: ${name}`);
    return [name, resource(`eris/tools/${name}.md`)];
  }));
  return { systemPrompt: resource("eris/system.md"), predictionPrompt: resource("eris/prediction.md"), recoveryMessage: resource("eris/recovery.md"),
    failureSummaryMessage: resource("eris/tool-failure.md"), toolDescriptions };
}
export { modelProbeText } from "./model-probe.js";

export const scoreDirectory=JSON.parse(resource('score/skill/directory.json')) as {units:Record<string,string>;diagnostics:Record<string,string>;parents:Record<string,string>;core_grades:Record<string,string>;final_grades:Record<string,string>;always_units:string[];always_diagnostics:string[]};
