import path from "node:path";
import * as sdk from "#pi-sdk";
import { object, type AssistantEvent, type JsonObject, type ModelConfig } from "@eval/contracts";
import { assistantContent } from "./assistant-content.js";
import { providerConfig, transformPayload } from "./sdk-utils.js";

export interface PredictionOptions {
  model: ModelConfig;
  workdir: string;
  instructions: string;
  history: readonly AssistantEvent[];
  recentSuggestions: readonly string[];
  signal: AbortSignal;
}

/** Only visible dialogue and accepted visual receipts; never replay tools or private reasoning. */
export function predictionContext(history: readonly AssistantEvent[]) {
  const textOf = (content: unknown) => assistantContent(content as JsonObject[]).filter(block => block.type === "text").map(block => String(block.text)).join("").trim();
  const excerpt = (text: string) => {
    const chars = [...text];
    return { text: chars.slice(0, 2400).join(""), truncated: chars.length > 2400 };
  };
  const requestText = (event: AssistantEvent | undefined) => excerpt(event ? textOf(event.data.content) : "");
  const initialRequest = requestText(history.find(event => event.type === "user/message"));
  const currentRequest = requestText(history.findLast(event => event.type === "user/message"));
  const messages: { role: string; text: string; truncated: boolean }[] = [];
  for (let index = history.length - 1; index >= 0 && messages.length < 10; index--) {
    const event = history[index];
    if (!["user/message", "assistant/message", "tool/result"].includes(event.type)) continue;
    const message = event.type === "user/message" ? event.data : object(event.data.message);
    if (message.isError) continue;
    let text = textOf(message.content);
    if (event.type === "tool/result") {
      try {
        const receipt = object(JSON.parse(text));
        if (!["chart", "comparison-diagram"].includes(String(receipt.kind))) continue;
        text = JSON.stringify(receipt);
      } catch { continue; }
    }
    if (text) messages.push({ role: event.type === "user/message" ? "user" : "assistant", ...excerpt(text) });
  }
  return { initialRequest, currentRequest, dialogue: messages.reverse() };
}

export function predictionText(text: string, previous: readonly string[]): string | null {
  const value = text.trim();
  if (!value || [...value].length > 40 || /[\r\n`<>]|^[/#\[{"“]|^(?:[-*•]|\d+[.)])\s/u.test(value)) return null;
  if (/^(?:none|null|无建议|暂无建议|没有建议|保持沉默)$/i.test(value)) return null;
  const identity = (input: string) => input.replace(/[\s\p{P}]/gu, "").toLocaleLowerCase();
  if (previous.some(item => identity(item) === identity(value))) return null;
  return value;
}

export async function createPiPrediction(options: PredictionOptions): Promise<string | null> {
  options.signal.throwIfAborted();
  const config = { ...options.model, thinking: "off" as const, maxOutputTokens: 256 };
  const secret = process.env[config.apiKeyEnv];
  if (!secret) throw new Error(`Missing ${config.apiKeyEnv}`);
  const agentDir = path.join(options.workdir, ".agent");
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(config.provider, providerConfig(config));
  await runtime.setRuntimeApiKey(config.provider, secret);
  const model = runtime.getModel(config.provider, config.model);
  if (!model) throw new Error("Configured prediction model unavailable");
  options.signal.throwIfAborted();
  const context = predictionContext(options.history);
  // End on the prediction task so completed dialogue is not mistaken for a live user request.
  const response = await runtime.completeSimple(model, {
    messages: [
      { role: "user", content: JSON.stringify({ ...context, recentSuggestions: options.recentSuggestions }), timestamp: Date.now() },
      { role: "user", content: options.instructions, timestamp: Date.now() },
    ] }, {
    signal: options.signal, maxTokens: config.maxOutputTokens,
    onPayload: value => {
      const payload = object(transformPayload(value, config));
      if (config.api === "openai-responses") payload.reasoning = { effort: "none" };
      return payload;
    },
  });
  options.signal.throwIfAborted();
  if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Prediction ended: ${response.stopReason}`);
  return predictionText(response.content.filter(block => block.type === "text").map(block => block.text).join(""),
    [...options.recentSuggestions, context.initialRequest.text, ...context.dialogue.filter(message => message.role === "user").map(message => message.text)]);
}
