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
  const excerpt = (text: string, limit = 2400) => {
    const chars = [...text];
    if (chars.length <= limit) return { text, truncated: false };
    const gap = "\n[…]\n", head = Math.ceil((limit - gap.length) * 2 / 3), tail = limit - gap.length - head;
    return { text: chars.slice(0, head).join("") + gap + chars.slice(-tail).join(""), truncated: true };
  };
  const visual = (receipt: JsonObject) => {
    let truncated = false;
    const text = (value: unknown, limit: number) => {
      const part = excerpt(typeof value === "string" ? value : "", limit);
      truncated ||= part.truncated;
      return part.text;
    };
    if (receipt.kind === "comparison-diagram") {
      const diagram = object(receipt.diagram);
      return { text: JSON.stringify({ kind: receipt.kind, title: text(diagram.title, 120), verdict: text(diagram.verdict, 120),
        reason: text(diagram.reason, 240), caveat: text(diagram.caveat, 160),
        candidates: ((diagram.candidates ?? []) as JsonObject[]).map(candidate => ({ name: text(candidate.name, 80),
          outcome: candidate.outcome, summary: text(candidate.summary, 160),
          paths: ((candidate.paths ?? []) as JsonObject[]).map(path => ({ title: text(path.title, 48), assessment: path.assessment,
            evidence: text(path.evidence, 120), impact: text(path.impact, 80) })),
        })),
      }), truncated };
    }
    const chart = object(receipt.chart), categories = (chart.categories ?? []) as string[], series = (chart.series ?? []) as JsonObject[];
    const indices = categories.length <= 12 ? categories.map((_, index) => index)
      : [...Array.from({ length: 4 }, (_, index) => index), ...Array.from({ length: 8 }, (_, index) => categories.length - 8 + index)];
    truncated = categories.length > 12 || series.length > 6;
    return { text: JSON.stringify({ kind: receipt.kind, title: text(chart.title, 120), scope: text(chart.scope, 160),
      unit: text(chart.unit, 40), caveat: text(chart.caveat, 160), categoryCount: categories.length,
      categories: indices.map(index => text(categories[index], 80)),
      series: series.slice(0, 6).map(row => ({ name: text(row.name, 80), values: indices.map(index => (row.values as unknown[])[index]) })),
    }), truncated };
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
        messages.push({ role: "assistant", ...visual(receipt) });
        continue;
      } catch { continue; }
    }
    if (text) messages.push({ role: event.type === "user/message" ? "user" : "assistant", ...excerpt(text) });
  }
  return { initialRequest, currentRequest, dialogue: messages.reverse() };
}

export function predictionText(text: string, previous: readonly string[]): string | null {
  const value = text.trim();
  if (!value || [...value].length > 40 || /[\r\n`<>]|^[/#\[{"“]|^(?:[-*•]|\d+[.)])\s/u.test(value)) return null;
  if (/^(?:none|null|无建议|暂无建议|没有建议|保持沉默|空文本|空字符串)$/i.test(value)) return null;
  const identity = (input: string) => input.replace(/[\s\p{P}]/gu, "").toLocaleLowerCase();
  if (previous.some(item => identity(item) === identity(value))) return null;
  return value;
}

export async function createPiPrediction(options: PredictionOptions): Promise<string | null> {
  options.signal.throwIfAborted();
  const config = { ...options.model, thinking: options.model.thinking === "off" ? "off" as const : "low" as const, maxOutputTokens: 1024 };
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
  const response = await runtime.completeSimple(model, {
    systemPrompt: options.instructions,
    messages: [
      { role: "user", content: JSON.stringify({ ...context, recentSuggestions: options.recentSuggestions }), timestamp: Date.now() },
    ] }, {
    signal: options.signal, maxTokens: config.maxOutputTokens, reasoning: config.thinking === "off" ? undefined : config.thinking,
    onPayload: value => {
      const payload = object(transformPayload(value, config));
      if (config.api === "openai-responses") payload.reasoning = { effort: config.thinking === "off" ? "none" : config.thinking };
      return payload;
    },
  });
  options.signal.throwIfAborted();
  if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Prediction ended: ${response.stopReason}`);
  return predictionText(response.content.filter(block => block.type === "text").map(block => block.text).join(""),
    [...options.recentSuggestions, context.initialRequest.text, ...context.dialogue.filter(message => message.role === "user").map(message => message.text)]);
}
