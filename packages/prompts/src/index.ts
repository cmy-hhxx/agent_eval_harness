import { readFileSync } from "node:fs";
import { canonical, submissionToolNames, type FailureContext, type JsonObject, type Policy } from "@eval/contracts";

export type PromptStage = "criteria" | "attribution" | "comparison" | "rewrite" | "clustering";

const builtinToolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "calculate_pair", "execute_code",
  "read_artifact", "check_table", "inspect_material", ...submissionToolNames(false), ...submissionToolNames(true),
] as const;

function resource(path: string): string {
  const text = readFileSync(new URL(`../resources/${path}`, import.meta.url), "utf8").trim();
  if (!text) throw new Error(`Empty prompt resource: ${path}`);
  return text;
}

const material = resource("shared/material.md");
const commentary = resource("shared/commentary.md");
const evidence = resource("shared/evidence.md");
const taskFocus = resource("shared/task-focus.md");
const budget = resource("shared/budget.md");
const recovery = resource("shared/recovery.md");
const nudge = resource("shared/nudge.md");
export const standardConflictReviewInstructions = resource("attribution/standard-review.md");
export const attributionNotApplicableText = resource("attribution/default/not_applicable.md");
const descriptions = new Map<string, string>(
  builtinToolNames.map((name) => [name, resource(`tools/${name}.md`)]),
);

/** Read-only dashboard projection of the same shared text used by prompt assembly. */
export function sharedPromptResources() {
  return Object.entries({ material, commentary, evidence, taskFocus, budget, recovery, nudge }).map(([name, text]) => ({
    name,
    source: `packages/prompts/resources/shared/${name === "taskFocus" ? "task-focus" : name}.md`,
    text,
  }));
}

/** The only source of model-facing text for the built-in evaluation profiles. */
export function agentPrompt(stage: PromptStage, toolNames: string[], profile = "default") {
  if (!/^[a-z][a-z0-9_-]*$/.test(profile)) throw new Error(`Invalid prompt profile: ${profile}`);
  const instructions = resource(`${stage}/${profile}/instructions.md`);
  const evidenceGuide = toolNames.some(name => ["read_trace", "search_trace", "view_image", "check_table"].includes(name))
    ? `\n${evidence}\n` : "";
  const systemPrompt = resource(`${stage}/${profile}/system.md`) + "\n\n" + commentary + "\n\n" + instructions + evidenceGuide;
  const fileSubmission = stage === "comparison" && profile === "verification";
  const names = [...toolNames, ...submissionToolNames(fileSubmission)];
  if (new Set(names).size !== names.length) throw new Error(`Duplicate prompt tool in ${stage}`);
  const toolDescriptions = Object.fromEntries(names.map((name) => {
    const description = descriptions.get(name);
    if (!description) throw new Error(`Missing tool description: ${name}`);
    return [name, description];
  }));
  return {
    systemPrompt,
    instructions,
    submissionNudge: nudge,
    toolDescriptions,
    fileSubmission,
    renderPrompt(input: JsonObject, policy?: Policy, failure?: FailureContext): string {
      if (failure && !policy) throw new Error("Recovery requires an execution policy");
      const { task_focus, ...complete } = input;
      const focus = task_focus === undefined ? "" : `${taskFocus}\n${JSON.stringify(task_focus)}\n\n`;
      const limits = policy ? {
        content_call_limit: 1 + policy.repairAttempts,
        ...(toolNames.some(name => name !== "inspect_material") ? { exploration_call_limit: policy.maxToolCalls } : {}),
        ...(toolNames.includes("execute_code") ? { code_timeout_seconds: policy.codeTimeoutSeconds } : {}),
      } : undefined;
      return focus + `${material}\n` + canonical(task_focus === undefined ? input : complete) +
        (limits ? `\n\n${budget}${JSON.stringify(limits)}。` : "") +
        (failure ? `\n${recovery}\n${JSON.stringify({
          ...(!failure.stopped ? { draft: failure.draft } : {}), errors: failure.errors,
        })}` : "");
    },
  };
}

/** Fixed Criteria wording; models select original sources instead of authoring acceptance rules. */
export function criteriaText(name: "task_type" | "source_rule"): string {
  return resource(`criteria/default/${name}.md`);
}

/** Fixed wording for a review request; it never claims a comparison outcome. */
export function comparisonText(name: "review_pending" | "not_applicable"): string {
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
  return { systemPrompt: resource("eris/system.md"), recoveryMessage: resource("eris/recovery.md"), toolDescriptions };
}
