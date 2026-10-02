import path from "node:path";
import * as sdk from "#pi-sdk";
import { object, type AssistantEvent, type AssistantRecord, type AssistantModelOptions, type AssistantScope, type JsonObject } from "@eval/contracts";
import { providerConfig, sdkContent, transformPayload } from "./sdk-utils.js";
import { readAssistantSource } from "./assistant-source.js";

export interface ConversationDriver {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
export interface ConversationDriverOptions extends AssistantModelOptions {
  scope: AssistantScope;
  workdir: string;
  history: readonly AssistantEvent[];
  records: readonly AssistantRecord[];
  compact(summary: string, firstKeptEntryId: string, tokensBefore: number): Promise<void>;
  event(value: unknown): Promise<void>;
  checkpoint(): Promise<void>;
  progress(callId: string, value: unknown): void;
}
export type ConversationDriverFactory = (options: ConversationDriverOptions) => Promise<ConversationDriver>;

/** Rebuild the SDK's memory from the authoritative, provider-neutral messages. */
async function restore(options: ConversationDriverOptions): Promise<sdk.FileEntry[]> {
  const history = options.history;
  const entries: unknown[] = [];
  let parentId: string | null = null;
  for (const record of options.records) {
    if (record.kind === "compaction") {
      const id = crypto.randomUUID();
      entries.push({ ...record, type: "compaction", id, parentId, timestamp: new Date().toISOString() });
      parentId = id; continue;
    }
    if (record.kind !== "event") continue;
    const event = record.event, messages: unknown[] = [];
    const data = event.data;
    if (event.type === "user/message") messages.push({ role: "user", content: data.content, timestamp: event.time });
    if (event.type === "assistant/message") {
      const message = object(data.message), source = object(message.source);
      const replay = object(source.replayState ?? {});
      const content = (message.content as JsonObject[]).map((block, index) => {
        const metadata = (replay.blocks as JsonObject[] | undefined)?.[index] ?? {};
        if (block.type === "reasoning") return { ...metadata, type: "thinking", thinking: block.text };
        if (block.type === "tool-call") return { type: "toolCall", id: block.id, name: block.name, arguments: JSON.parse(String(block.arguments)) };
        return { ...metadata, type: "text", text: block.text };
      });
      messages.push({ ...replay, role: "assistant", content, provider: source.provider, model: source.model, timestamp: event.time });
    }
    if (event.type === "tool/result") {
      const message = structuredClone(object(data.message));
      const call = history.findLast((entry) => entry.type === "tool/call" && entry.data.callId === message.toolCallId);
      const requested = history.findLast((entry) => entry.type === "assistant/message" && (object(entry.data.message).content as JsonObject[]).some(block => block.type === "tool-call" && block.id === message.toolCallId));
      const block = (requested ? object(requested.data.message).content as JsonObject[] : []).find(block => block.type === "tool-call" && block.id === message.toolCallId);
      const sourceRead = object(data.meta ?? {}).sourceRead;
      if (sourceRead && !message.isError) {
        message.content = sdkContent((await readAssistantSource(options.tools, options.scope, String(message.toolCallId), sourceRead)).content);
      }
      messages.push({ role: "toolResult", toolCallId: message.toolCallId, toolName: call?.data.name ?? block?.name ?? "tool", content: message.content, isError: message.isError, timestamp: event.time });
    }
    for (const message of messages) {
      const id = String(data.entryId ?? (event.type === "user/message" ? data.id : object(data.message).id));
      entries.push({ type: "message", id, parentId, timestamp: new Date(event.time).toISOString(), message });
      parentId = id;
    }
  }
  return entries as sdk.FileEntry[];
}

export const createPiConversation: ConversationDriverFactory = async (options) => {
  const { model: config, workdir } = options, agentDir = path.join(workdir, ".agent");
  const secret = process.env[config.apiKeyEnv];
  if (!secret) throw new Error(`Missing ${config.apiKeyEnv}`);
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(config.provider, providerConfig(config));
  await runtime.setRuntimeApiKey(config.provider, secret);
  const model = runtime.getModel(config.provider, config.model);
  if (!model) throw new Error("Configured model unavailable");
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
  const loader = new sdk.DefaultResourceLoader({ cwd: workdir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: options.systemPrompt,
    extensionFactories: [(api) => { api.on("before_provider_request", (event) => transformPayload(event.payload, config)); }],
  });
  await loader.reload();
  const customTools: sdk.ToolDefinition[] = options.tools.map((tool) => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema as sdk.ToolDefinition["parameters"], executionMode: "sequential",
    async execute(callId, args, signal) {
      await options.checkpoint();
      const result = await tool.execute(args, { scope: options.scope, callId, signal: signal ?? new AbortController().signal, progress: (value) => options.progress(callId, value) });
      return { ...result, content: sdkContent(result.content), details: result.details ?? {} };
    },
  }));
  const { session } = await sdk.createAgentSession({ cwd: workdir, agentDir, modelRuntime: runtime, model, thinkingLevel: config.thinking, settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(workdir, { id: options.scope.sessionId }, [{ type: "session", id: options.scope.sessionId, cwd: workdir, timestamp: new Date().toISOString() }, ...await restore(options)]), resourceLoader: loader, noTools: "builtin", tools: customTools.map((tool) => tool.name), customTools });
  await session.bindExtensions({ mode: "rpc" });
  // Agent.subscribe is awaited by Pi. AgentSession.subscribe is not: it cannot
  // be used as a persistence barrier before the next model/tool request.
  const unsubscribe = session.agent.subscribe(async (event) => { await options.event({ ...event, ...(event.type === "message_end" ? { entryId: session.sessionManager.getLeafId() } : {}) }); });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (...args) => { await options.checkpoint(); return stream(...args); };
  return { prompt: async (text) => {
      const usage = session.getContextUsage();
      if (usage?.percent !== null && usage?.percent !== undefined && usage.percent > 75) {
        await options.checkpoint();
        const compacted = await session.compact();
        await options.compact(compacted.summary, compacted.firstKeptEntryId, compacted.tokensBefore);
      }
      await session.prompt(text);
    }, steer: async (text) => { await session.steer(text); }, abort: () => session.abort(),
    async dispose() { await session.abort(); unsubscribe(); session.dispose(); },
  };
};
