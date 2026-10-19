import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DEFAULT_POLICY, emptyUsage, errorText, object, redact, type AgentSession, type AttemptSpec, type Engine, type ModelConfig, type Usage } from "@eval/contracts";
import { localFiles } from "@eval/data";
import { loadIdentity } from "@eval/runtime/client";
import { modelProbeText } from "@eval/prompts";
import { createModelResolver, loadConfig } from "./config.js";
import { ROOT } from "./paths.js";

export interface ModelProbeOptions {
  configPaths: string[];
  engine: Engine;
  stage?: string;
  execute?: boolean;
  signal?: AbortSignal;
}
export interface ModelProbeResult {
  engine: Engine;
  stage: string;
  channel: string;
  model: string;
  api: ModelConfig["api"];
  status: "planned" | "passed" | "failed";
  attempts: number;
  modelRequests: number;
  toolCalls: number;
  usage: Usage;
  error?: string;
}

/** A dry run resolves configuration only. Execution is explicit and never retries. */
export async function runModelProbe(options: ModelProbeOptions): Promise<ModelProbeResult> {
  if (!["pi", "prime"].includes(options.engine)) throw new Error("--engine must be pi or prime");
  const host = await loadConfig(options.configPaths), stage = options.stage ?? "comparison";
  const model = createModelResolver(host.models)(stage);
  const result: ModelProbeResult = { engine: options.engine, stage, channel: model.provider, model: model.model,
    api: model.api, status: "planned", attempts: 0, modelRequests: 0, toolCalls: 0, usage: emptyUsage() };
  if (!options.execute) return result;
  options.signal?.throwIfAborted();
  const directory = path.join(tmpdir(), "eval-model-probe-" + randomUUID());
  const token = randomUUID(), controller = new AbortController();
  const relay = () => controller.abort(options.signal?.reason ?? new Error("Model probe cancelled"));
  options.signal?.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Model probe exceeded 60 seconds")), 60000);
  let session: AgentSession | undefined, failure: string | undefined, finalText = "", ended = 0, usageMessages = 0;
  const stop = () => { void session?.abort().catch(() => {}); };
  controller.signal.addEventListener("abort", stop, { once: true });
  try {
    if (!process.env[model.apiKeyEnv]) throw new Error(`Missing ${model.apiKeyEnv}`);
    const identity = await loadIdentity(options.engine, ROOT);
    const backend = options.engine === "pi" ? (await import("@eval/runtime/pi")).piBackend(identity)
      : (await import("@eval/runtime/prime")).primeBackend(identity);
    await localFiles.mkdir(directory, { recursive: true });
    const spec: AttemptSpec = {
      runId: "model-probe", taskId: randomUUID(), attemptId: randomUUID(), inputRevision: 1, engine: identity,
      evidenceBank: [], inputs: [], hostUrl: "http://127.0.0.1", deadline: Date.now() + 60000,
      model: { ...model, maxOutputTokens: Math.min(model.maxOutputTokens, 512) },
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 60, idleTimeoutSeconds: 60, maxToolCalls: 1, repairAttempts: 0 },
      evaluation: { id: "model-probe", profile: "default", systemPrompt: modelProbeText.system,
        outputSchema: { type: "object" }, toolNames: ["probe_echo"], fileSubmission: false,
        toolDescriptions: { probe_echo: modelProbeText.tool }, submissionNudge: modelProbeText.prompt },
      prompt: modelProbeText.prompt,
    };
    session = await backend.createSession({ spec, workdir: directory,
      tools: [{ name: "probe_echo", description: modelProbeText.tool,
        inputSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { const: "probe", type: "string" } } },
        async execute() { throw new Error("Probe tools use the adapter execution callback"); } }],
      async execute(name, args) {
        result.toolCalls++;
        if (name !== "probe_echo" || result.toolCalls !== 1 || object(args).value !== "probe") {
          failure = "Model probe requires exactly one valid probe_echo call";
          controller.abort(new Error(failure));
          throw new Error(failure);
        }
        return { content: [{ type: "text", text: JSON.stringify({ token }) }], details: {} };
      },
      onEvent(value) {
        const event = object(value), message = object(event.message ?? {});
        if (message.role !== "assistant") return;
        if (event.type === "message_start" && !controller.signal.aborted) result.modelRequests++;
        if (event.type !== "message_end") return;
        ended++;
        const usage = object(message.usage ?? {});
        if (Object.keys(result.usage).every(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) && Number(usage[key]) >= 0) &&
            Number(usage.totalTokens) > 0 && Number(usage.output) > 0 &&
            Number(usage.input) + Number(usage.cacheRead) + Number(usage.cacheWrite) > 0) usageMessages++;
        for (const key of Object.keys(result.usage) as (keyof Usage)[]) {
          const count = usage[key];
          if (typeof count === "number" && Number.isFinite(count) && count >= 0) result.usage[key] += count;
        }
        if (message.stopReason === "error" || message.stopReason === "length" || message.stopReason === "aborted")
          failure = typeof message.errorMessage === "string" ? message.errorMessage : `Model probe ended with ${message.stopReason}`;
        finalText = Array.isArray(message.content) ? message.content.map(object).filter(item => item.type === "text").map(item => String(item.text)).join("").trim() : "";
        if (ended >= 2 && (finalText !== token || message.stopReason !== "stop")) {
          failure ??= "Model probe did not finish after the tool result";
          controller.abort(new Error(failure));
        }
      },
    });
    controller.signal.throwIfAborted();
    result.attempts = 1;
    await session.run(spec.prompt);
    controller.signal.throwIfAborted();
    if (failure) throw new Error(failure);
    if (result.modelRequests !== 2 || ended !== 2 || result.toolCalls !== 1 || finalText !== token)
      throw new Error("Model probe did not complete tool call → tool result → final answer in two requests");
    if (usageMessages !== 2) throw new Error("Model probe is missing token usage for a response");
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = redact(errorText(error), [process.env[model.apiKeyEnv] ?? ""]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relay);
    controller.signal.removeEventListener("abort", stop);
    try {
      await session?.dispose();
    } catch (error) {
      result.status = "failed";
      result.error ??= redact(errorText(error), [process.env[model.apiKeyEnv] ?? ""]);
    }
    try {
      await localFiles.remove(directory, { recursive: true, force: true });
    } catch (error) {
      result.status = "failed";
      result.error ??= redact(errorText(error), [process.env[model.apiKeyEnv] ?? ""]);
    }
  }
  return result;
}
