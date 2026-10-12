import path from "node:path";
import * as sdk from "#pi-sdk";
import { canonical, errorText, object, type AssistantEvent, type AssistantRecord, type AssistantModelOptions, type AssistantScope, type JsonObject } from "@eval/contracts";
import { providerConfig, sdkContent, transformPayload } from "./sdk-utils.js";
import { readAssistantSource } from "./assistant-source.js";

export interface ConversationDriver {
  prompt(text: string, messageId?: string): Promise<void>;
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
  const compaction = options.records.findLast(record => record.kind === "compaction");
  let retained = !compaction;
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
    const entryId = String(data.entryId ?? (event.type === "user/message" ? data.id : object(data.message ?? {}).id));
    if (compaction && entryId === compaction.firstKeptEntryId) retained = true;
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
      if (sourceRead && !message.isError && retained) {
        try {
          const result = await readAssistantSource(options.tools, options.scope, String(message.toolCallId), sourceRead);
          message.content = sdkContent(result.content);
          message.isError = result.isError === true;
        } catch (error) {
          // A removed/unreadable source is an evidence gap, not a broken session.
          message.content = [{ type: "text", text: `Source unavailable during replay: ${errorText(error)}` }];
          message.isError = true;
        }
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
  // Compaction must refer to the user ID already persisted by AssistantSessions.
  const userEntryIds = new Map<string, string>();
  let compactionFailure: Error | undefined;
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: Math.ceil(config.contextWindow * 0.2) }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
  const loader = new sdk.DefaultResourceLoader({ cwd: workdir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: options.systemPrompt,
    extensionFactories: [(api) => { api.on("before_provider_request", (event) => {
      const payload = object(transformPayload(event.payload, config));
      // Eris schedules read-only tools itself; evaluation workers retain their serial policy.
      payload.parallel_tool_calls = true;
      // Responses may promote omitted strict mode to all-required arguments. Keep the tool's optional fields intact.
      if (config.api === "openai-responses" && Array.isArray(payload.tools))
        for (const tool of payload.tools) if (tool.type === "function") tool.strict = false;
      // DeepSeek enables thinking when reasoning is omitted, including for a non-reasoning SDK model.
      if (config.provider === 'deepseek' && config.api === 'openai-responses' && config.thinking === 'off') payload.reasoning = {effort:'none'};
      return payload;
    });
      api.on("session_before_compact", async () => {
        if (compactionFailure) return { cancel: true };
        await options.checkpoint();
        return undefined;
      });
      // Pi awaits this hook before issuing the next request, including within a tool loop.
      api.on("session_compact", async ({ compactionEntry }) => {
        try {
          await options.compact(compactionEntry.summary, userEntryIds.get(compactionEntry.firstKeptEntryId) ?? compactionEntry.firstKeptEntryId, compactionEntry.tokensBefore);
        } catch (error) { compactionFailure = new Error(`上下文压缩记录保存失败：${errorText(error)}`); }
      });
      api.on("session_compact_failed", ({ aborted, errorMessage }) => {
        if (!aborted) compactionFailure = new Error(`上下文压缩失败：${errorMessage ?? "未生成摘要"}`);
      });
    }],
  });
  await loader.reload();
  // Pi batches independent reads; the application bounds their I/O. A batch
  // containing a writable tool remains sequential in Pi, preserving ordering.
  const activeReads = new Set<Promise<void>>();
  const customTools: sdk.ToolDefinition[] = options.tools.map((tool) => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema as sdk.ToolDefinition["parameters"], executionMode: tool.readOnly ? "parallel" : "sequential",
    prepareArguments(args) { tool.validate?.(args); return args as Record<string, unknown>; },
    async execute(callId, args, signal) {
      while (tool.readOnly && activeReads.size >= 4) {
        await Promise.race(activeReads);
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
      let release = () => {};
      const slot = new Promise<void>(resolve => { release = resolve; });
      if (tool.readOnly) activeReads.add(slot);
      try {
        await options.checkpoint();
        signal?.throwIfAborted();
        const result = await tool.execute(args, { scope: options.scope, callId, signal: signal ?? new AbortController().signal, progress: (value) => options.progress(callId, value),
          async complete(request) {
            await options.checkpoint();
            signal?.throwIfAborted();
            const started = Date.now();
            const messages = session.agent.state.messages;
            const sources = messages.slice(messages.findLastIndex(message => message.role === "user") + 1)
              .flatMap(message => message.role === "toolResult" && !message.isError && request.sourceTools?.includes(message.toolName)
                ? [{ tool: message.toolName, content: message.content }] : []);
            const response = await runtime.completeSimple(model, { systemPrompt: request.systemPrompt,
              messages: [{ role: "user", content: sources.length ? JSON.stringify({ draft: request.text, sources }) : request.text, timestamp: started }] }, {
              signal, reasoning: config.thinking === "off" ? undefined : config.thinking,
              onPayload: value => {
                const payload = object(transformPayload(value, config));
                const format = { name: "tool_check", strict: true, schema: request.outputSchema };
                if (config.api === "openai-responses") payload.text = { ...object(payload.text ?? {}), format: { type: "json_schema", ...format } };
                else payload.response_format = { type: "json_schema", json_schema: format };
                if (config.provider === "deepseek" && config.api === "openai-responses" && config.thinking === "off") payload.reasoning = { effort: "none" };
                return payload;
              },
            });
            signal?.throwIfAborted();
            if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Isolated model request ended: ${response.stopReason}`);
            return { text: response.content.filter(block => block.type === "text").map(block => block.text).join(""),
              elapsedMs: Date.now() - started, usage: { ...response.usage } };
          },
        });
        return { ...result, content: sdkContent(result.content), details: result.details ?? {} };
      } finally { activeReads.delete(slot); release(); }
    },
  }));
  const { session } = await sdk.createAgentSession({ cwd: workdir, agentDir, modelRuntime: runtime, model, thinkingLevel: config.thinking, settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(workdir, { id: options.scope.sessionId }, [{ type: "session", version: sdk.CURRENT_SESSION_VERSION, id: options.scope.sessionId, cwd: workdir, timestamp: new Date().toISOString() }, ...await restore(options)]), resourceLoader: loader, noTools: "builtin", tools: customTools.map((tool) => tool.name), customTools });
  await session.bindExtensions({ mode: "rpc" });
  // Agent.subscribe is awaited by Pi. AgentSession.subscribe is not: it cannot
  // be used as a persistence barrier before the next model/tool request.
  const pending = new Map<string, { name: string; key: string }>();
  const failures = new Map<string, { name: string; count: number }>();
  let openingMessageId: string | undefined;
  const unsubscribe = session.agent.subscribe(async (event) => {
    if (event.type === "message_end" && event.message.role === "user" && openingMessageId) {
      userEntryIds.set(session.sessionManager.getLeafId()!, openingMessageId);
      openingMessageId = undefined;
    }
    // Low-level agent_end can precede Pi's compact-and-retry. Close the user turn only after prompt settles.
    if (event.type !== "agent_end") await options.event({ ...event, ...(event.type === "message_end" ? { entryId: session.sessionManager.getLeafId() } : {}) });
    if (event.type !== "message_end") return;
    const message = event.message;
    if (message.role === "assistant") for (const block of message.content) {
      if (block.type === "toolCall") pending.set(block.id, { name: block.name, key: canonical([block.name, block.arguments]) });
    }
    if (message.role === "toolResult") {
      const call = pending.get(message.toolCallId);
      pending.delete(message.toolCallId);
      if (!call) return;
      if (!message.isError) failures.delete(call.key);
      else {
        const count = (failures.get(call.key)?.count ?? 0) + 1;
        failures.set(call.key, { name: call.name, count });
      }
    }
  });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (...args) => {
    await options.checkpoint();
    if (compactionFailure) throw compactionFailure;
    const repeatedFailure = [...failures.values()].find(failure => failure.count >= 3);
    if (repeatedFailure) throw new Error(`工具 ${repeatedFailure.name} 以相同参数失败3次，已停止重复调用；已保存结果，可更正请求后继续。`);
    return stream(...args);
  };
  return { prompt: async (text, messageId) => {
      openingMessageId = messageId;
      pending.clear(); failures.clear(); compactionFailure = undefined;
      await session.prompt(text);
      if (compactionFailure) throw compactionFailure;
      await options.event({ type: "agent_end" });
    }, steer: async (text) => { await session.steer(text); }, abort: () => session.abort(),
    async dispose() { await session.abort(); unsubscribe(); session.dispose(); },
  };
};
