import { object, type AssistantScope, type AssistantTool } from "@eval/contracts";

/** Resolve a recorded source locator for both Pi replay and the tool inspector. */
export async function readAssistantSource(tools: AssistantTool[], scope: AssistantScope, callId: string, sourceRead: unknown, audience: "model" | "user" = "model") {
  const reference = object(sourceRead), tool = tools.find(item => item.name === reference.tool);
  if (!tool?.readOnly) throw new Error(`Source reader unavailable: ${String(reference.tool)}`);
  return tool.execute(reference.args, { scope, callId, signal: new AbortController().signal, audience, progress() {} });
}
