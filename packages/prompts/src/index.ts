import { readFileSync } from "node:fs";
import { canonical, submissionToolNames, type FailureContext, type JsonObject, type Policy } from "@eval/contracts";

export type PromptStage = "criteria" | "attribution" | "comparison" | "rewrite" | "clustering";

const builtinToolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "calculate_pair", "execute_code",
  "read_artifact", "check_table", ...submissionToolNames(true),
] as const;

function resource(path: string): string {
  const text = readFileSync(new URL(`../resources/${path}`, import.meta.url), "utf8").trim();
  if (!text) throw new Error(`Empty prompt resource: ${path}`);
  return text;
}

const material = resource("shared/material.md");
const budget = resource("shared/budget.md");
const recovery = resource("shared/recovery.md");
const nudge = resource("shared/nudge.md");
const descriptions = new Map<string, string>(
  builtinToolNames.map((name) => [name, resource(`tools/${name}.md`)]),
);

/** The only source of model-facing text for the built-in evaluation profiles. */
export function agentPrompt(stage: PromptStage, toolNames: string[]) {
  const systemPrompt = resource(`${stage}/default/system.md`);
  const instructions = resource(`${stage}/default/instructions.md`);
  const fileSubmission = toolNames.includes("execute_code");
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
      return instructions + `\n${material}\n` + canonical(input) +
        (policy ? `\n\n${budget}${JSON.stringify(policy)}。` : "") +
        (failure ? `\n${recovery}\n${JSON.stringify({
          ...(!failure.stopped ? { draft: failure.draft } : {}), errors: failure.errors,
        })}` : "");
    },
  };
}

/** Fixed Criteria wording; models select original sources instead of authoring acceptance rules. */
export function criteriaText(name: "task_type" | "source_rule" | "reference_rule"): string {
  return resource(`criteria/default/${name}.md`);
}

/** Fixed wording for a review request; it never claims a comparison outcome. */
export function comparisonText(name: "review_pending"): string {
  return resource(`comparison/default/${name}.md`);
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
