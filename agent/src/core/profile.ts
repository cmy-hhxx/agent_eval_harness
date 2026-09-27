import { erisPrompt } from "@eval/prompts";
import { erisToolNames, erisTools, type ErisDependencies } from "./tools.js";

/** Host supplies capabilities; Eris owns its model-facing definition. */
export function createEris(dependencies: ErisDependencies) {
  const { toolDescriptions, ...prompt } = erisPrompt(erisToolNames);
  return { ...prompt, tools: erisTools(dependencies, toolDescriptions) };
}
