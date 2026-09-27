import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { object, errorText, type AssistantModelSelection, type AssistantModelDirectory, type AssistantScope, type AssistantPrompt, type AssistantSessionState, type AssistantEvent, type AssistantModelOptions, type AssistantOwnership, type AssistantSessionRuntime, type JsonObject } from "@eval/contracts";
import { AssistantJournal, assistantId, assistantOwner, assistantUser, ownAssistantSession, listAssistantSessions, type AssistantOwner } from "@eval/data";
import { createPiConversation, type ConversationDriver, type ConversationDriverFactory } from "./assistant-pi.js";
import { createAssistantMetrics, createAssistantMessage, createToolResultMessage, createUserMessage, AssistantStreamAccumulator, SessionAssistantStreamAccumulator, SESSION_FORMAT_VERSION, RemoteStreamMuxClient } from "./deepseek.js";

import { assistantContent, AssistantContentStream } from "./assistant-content.js";

class Feed {
  private listeners = new Set<(value: unknown) => void>();
  publish(value: unknown) { for (const listener of this.listeners) listener(value); }
  open(signal: AbortSignal): AsyncIterable<unknown> {
    const queue: unknown[] = [];
    let wake = () => {};
    const push = (value: unknown) => { queue.push(value); wake(); };
    this.listeners.add(push);
    const release = () => { this.listeners.delete(push); wake(); };
    signal.addEventListener("abort", release, { once: true });
    return { async *[Symbol.asyncIterator]() {
      try {
        while (!signal.aborted) {
          if (queue.length) yield queue.shift();
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally { release(); signal.removeEventListener("abort", release); }
    } };
  }
}

interface Owned {
  journal: AssistantJournal;
  metrics: ReturnType<typeof createAssistantMetrics>;
  release(): Promise<void>;
  feed: Feed;
  stream: SessionAssistantStreamAccumulator;
  driver?: ConversationDriver;
  driverSelection?: string;
  working?: Promise<void>;
  mutation: Promise<void>;
  writes: Promise<void>;
  revision: number;
  turn: number;
  step: number;
  attempt?: { id: string; index: number; content: AssistantContentStream; stream: AssistantStreamAccumulator };
  prompt?: AssistantPrompt;
  activeMessage?: JsonObject;
  lastFailure?: string;
  stopping: boolean;
  progress: Map<string, { id: string; text: string; pending: string; operationId: string; timer?: ReturnType<typeof setTimeout> }>;
}
export interface AssistantRuntimeOptions extends AssistantModelOptions {
  directory: string;
  models?: AssistantModelDirectory;
  url: string;
  driver?: ConversationDriverFactory;
  ownership?: AssistantOwnership;
  onError?(error: unknown): void;
}
export function sessionProjections(state: AssistantSessionState, journal?: AssistantJournal, metrics?: ReturnType<typeof createAssistantMetrics>) {
  const turn = journal?.events.findLast((event) => event.type === "turn/start");
  const boundary = journal?.events.findLast((event) => event.type === "step/start" || event.type === "step/end");
  const step = journal?.events.findLast((event) => event.type === "step/start");
  return { asOfSeq: state.lastSeq, values: {
    ...metrics?.view(),
    title: state.title,
    modelSelection: { lastUsed: state.modelUsed ?? null, next: state.modelSelection ?? state.modelUsed ?? null },
    ...(journal ? { inbox: structuredClone(journal.inbox), turnBoundary: { openTurnStartSeq: state.status === "running" ? turn?.seq ?? null : null, lastStepStartSeq: step?.seq ?? null, lastStepBoundary: boundary ? { kind: boundary.type === "step/start" ? "start" : "end", seq: boundary.seq } : null, lastTurn: turn?.data.turn ?? 0 } } : {}),
    sessionListMetadata: { blank: Object.keys(state.requests).length === 0, lastPromptAt: state.updatedAt },
  } };
}
export function sessionSummary(state: AssistantSessionState) {
  return { sessionId: state.sessionId, updatedAt: state.updatedAt, running: state.status === "running", blank: Object.keys(state.requests).length === 0, agentAvailable: true,
    projections: { kind: "sequenced", ...sessionProjections(state) } };
}

/** Process ownership is a replaceable seam; local files are the current coordinator. */
export class AssistantSessions implements AssistantSessionRuntime {
  private readonly owned = new Map<string, Promise<Owned>>();
  private readonly relays = new Map<string, RemoteStreamMuxClient>();
  private readonly owner: AssistantOwner;
  private readonly ownership: AssistantOwnership;
  private disposed = false;
  constructor(readonly options: AssistantRuntimeOptions) {
    this.owner = { pid: process.pid, instanceId: randomUUID(), url: options.url };
    this.ownership = options.ownership ?? { locate: (scope) => assistantOwner(options.directory, scope), claim: (scope, owner) => ownAssistantSession(options.directory, scope, owner) };
  }
  list(userId: string) { return listAssistantSessions(this.options.directory, userId); }
  async create(userId: string, sessionId?: string) {
    const journal = await AssistantJournal.create(this.options.directory, userId, sessionId);
    return journal.state;
  }
  private key(scope: AssistantScope) { return `${assistantUser(scope.userId)}/${assistantId(scope.sessionId)}`; }
  private async foreign(scope: AssistantScope) {
    const owner = await this.ownership.locate(scope);
    return owner?.instanceId !== this.owner.instanceId ? owner : undefined;
  }
  private async local(scope: AssistantScope): Promise<Owned> {
    if (this.disposed) throw new Error("Assistant shutting down");
    const key = this.key(scope);
    const previous = this.owned.get(key);
    if (previous) return previous;
    const promise = (async () => {
      const release = await this.ownership.claim(scope, this.owner);
      try {
        const journal = await AssistantJournal.load(this.options.directory, scope);
        const value: Owned = { journal, metrics: createAssistantMetrics(), release, feed: new Feed(), stream: new SessionAssistantStreamAccumulator(), mutation: Promise.resolve(), writes: Promise.resolve(), revision: 0,
          turn: Math.max(0, ...journal.events.filter((e) => e.type === "turn/start").map((e) => Number(e.data.turn))), step: 0, stopping: false, progress: new Map() };
        for (const event of journal.events) value.metrics.accept(event);
        if (journal.state.status === "running" || Object.values(journal.state.requests).includes("running")) {
          // Never replay a possibly completed external tool blindly. Accepted
          // specialist results are reconciled by the gateway on the next call.
          const answered = new Set(journal.events.filter((e) => e.type === "tool/result").map((e) => object(e.data.message).toolCallId));
          for (const call of journal.events.filter((e) => e.type === "tool/call" && !answered.has(e.data.callId)))
            await this.append(value, "tool/result", { turn: call.data.turn, step: call.data.step, message: createToolResultMessage({ callId: call.data.callId, content: [{ type: "text", text: this.options.recoveryMessage ?? "INTERRUPTED_PENDING_TOOL" }], isError: true }) }, true);
          if (journal.events.findLast((event) => ["turn/start", "turn/end"].includes(event.type))?.type === "turn/start")
            await this.append(value, "turn/end", { turn: value.turn, reason: { kind: "interrupted" } });
          for (const [requestId, status] of Object.entries(journal.state.requests))
            if (status === "running") await this.requestState(value, requestId, "interrupted");
          journal.state.status = "interrupted";
          await journal.save();
        }
        return value;
      } catch (error) { await release(); throw error; }
    })();
    this.owned.set(key, promise);
    try { const value = await promise; this.pump(value); return value; }
    catch (error) { this.owned.delete(key); throw error; }
  }
  private async target(scope: AssistantScope): Promise<Owned | AssistantOwner> {
    const owner = await this.foreign(scope);
    if (owner) return owner;
    try { return await this.local(scope); }
    catch (error) {
      for (let retry = 0; retry < 10; retry++) {
        const owner = await this.foreign(scope);
        if (owner) return owner;
        if (!/owned|lock/i.test(errorText(error))) throw error;
        await delay(20);
      }
      throw error;
    }
  }
  private append(value: Owned, type: string, data: JsonObject, surface = false): Promise<AssistantEvent> {
    const next = value.writes.then(async () => {
      const event: AssistantEvent = { type, seq: value.journal.events.length, time: Date.now(), data, ...(surface ? { surfaceOp: "append" as const } : {}), ...(type.startsWith("assistant/") && !["assistant/message", "assistant/attempt"].includes(type) ? { ignorable: true as const } : {}) };
      await value.journal.append({ kind: "event", event });
      value.metrics.accept(event);
      value.feed.publish({ type: "event", event: this.publicEvent(event) });
      return event;
    });
    value.writes = next.then(() => {});
    return next;
  }
  private publicEvent(event: AssistantEvent): AssistantEvent {
    if (!event.data.entryId && event.type !== "assistant/message") return event;
    const { entryId: _entryId, ...data } = event.data;
    if (event.type === "assistant/message") {
      const message = object(data.message), { replayState: _replay, ...source } = object(message.source);
      return { ...event, data: { ...data, message: { ...message, content: assistantContent(message.content as JsonObject[]), source } } };
    }
    return { ...event, data };
  }
  private splice(value: Owned, target: "next-turn" | "next-step", start: number, removedCount: number, inserted: JsonObject[], canceled = false) {
    return this.append(value, "agent/inbox/spliced", { target, start, removedCount, inserted, ...(canceled ? { outcome: "canceled" } : {}) });
  }
  private async requestState(value: Owned, requestId: string, status: AssistantSessionState["requests"][string]) {
    value.journal.state.requests[requestId] = status;
    await this.append(value, "assistant/request", { requestId, status });
  }
  private frame(value: Owned, frame: JsonObject) {
    const data = { ...frame, revision: ++value.revision };
    value.stream.accept(data, value.journal.state.lastSeq);
    value.feed.publish({ type: "assistant-stream", frame: data });
  }
  private progress(value: Owned, callId: string, raw: unknown) {
    const update = object(raw), event = object(update.event ?? {}), data = event.data && typeof event.data === "object" ? object(event.data) : {};
    let progress = value.progress.get(callId);
    if (!progress) {
      progress = { id: randomUUID(), text: "", pending: "", operationId: String(update.operationId ?? "") };
      value.progress.set(callId, progress);
      void this.append(value, "tool/ptc-dispatch-start", { rootCallId: callId, parentCallId: callId, subCallId: progress.id, name: "specialist_output", arguments: { operationId: progress.operationId } }).catch(this.options.onError);
    }
    if (update.message) progress.pending = String(update.message);
    if (event.type === "model" && data.type === "message_update") {
      const chunk = object(data.assistantMessageEvent ?? {});
      if (["text_delta", "thinking_delta"].includes(String(chunk.type))) {
        progress.text += String(chunk.delta ?? ""); progress.pending = progress.text.slice(-4096);
      }
    }
    if (event.type === "tool_start") progress.pending = `调用 ${String(data.name)}`;
    if (event.type === "finished") progress.pending = `专业任务：${String(data.state ?? data.status ?? "已结束")}`;
    // Projection of received output, not a professional verdict. The root call
    // remains running until its validated result arrives. Existing upstream
    // ToolCallTree replaces this one dispatch row in place.
    if (progress.pending && !progress.timer) progress.timer = setTimeout(() => {
      progress!.timer = undefined; void this.flushProgress(value, callId).catch(this.options.onError);
    }, 120);
  }
  private async flushProgress(value: Owned, callId: string, final = false) {
    const progress = value.progress.get(callId);
    if (!progress) return;
    if (progress.timer) clearTimeout(progress.timer);
    progress.timer = undefined;
    const text = final ? progress.text || progress.pending : progress.pending;
    if (text) await this.append(value, "tool/ptc-dispatch", { rootCallId: callId, parentCallId: callId, subCallId: progress.id, name: "specialist_output", arguments: { operationId: progress.operationId }, content: [{ type: "text", text }], isError: false });
    progress.pending = "";
    if (final) value.progress.delete(callId);
  }
  private async modelEvent(value: Owned, raw: unknown) {
    const event = object(raw), message = event.message ? object(event.message) : undefined;
    const turnStep = () => ({ turn: value.turn, step: value.step });
    switch (event.type) {
      case "agent_start":
        value.turn++; value.step = 0;
        await this.append(value, "turn/start", { turn: value.turn }); break;
      case "turn_start":
        value.step++;
        await this.append(value, "step/start", turnStep()); break;
      case "message_start":
        if (message?.role === "assistant") {
          value.attempt = { id: randomUUID(), index: 0, content: new AssistantContentStream(), stream: new AssistantStreamAccumulator() };
          this.frame(value, { type: "start", attemptId: value.attempt.id, ...turnStep() });
        }
        break;
      case "message_update": {
        if (!value.attempt) break;
        const update = object(event.assistantMessageEvent);
        for (const chunk of value.attempt.content.push(update)) {
          const time = Date.now(); value.attempt.stream.push({ time, chunk });
          this.frame(value, { type: "chunk", attemptId: value.attempt.id, index: value.attempt.index++, time, chunk });
        }
        break;
      }
      case "message_end": {
        if (message?.role === "user") {
          const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
          const pending = value.journal.inbox["next-step"][0];
          const current = value.activeMessage ?? pending;
          if (!value.activeMessage && pending) await this.splice(value, "next-step", 0, 1, []);
          const accepted = current ?? createUserMessage({ content, source: { kind: "user", rpcId: value.prompt?.requestId } });
          await this.append(value, "user/message", { ...accepted, content, ...(event.entryId ? { entryId: event.entryId } : {}) }, true);
          value.activeMessage = undefined;
          const rpcId = object(accepted.source).rpcId;
          if (typeof rpcId === "string" && rpcId !== value.prompt?.requestId) await this.requestState(value, rpcId, "completed");
        }
        if (message?.role === "assistant") {
          if (value.attempt) for (const chunk of value.attempt.content.finish()) {
            const time = Date.now(); value.attempt.stream.push({ time, chunk });
            this.frame(value, { type: "chunk", attemptId: value.attempt.id, index: value.attempt.index++, time, chunk });
          }
          const rawUsage = object(message.usage ?? {});
          const usage = typeof rawUsage.input === "number" && typeof rawUsage.output === "number" ? {
            inputTokens: rawUsage.input, outputTokens: rawUsage.output,
            ...(typeof rawUsage.cacheRead === "number" ? { cacheReadTokens: rawUsage.cacheRead } : {}),
            ...(typeof rawUsage.cacheWrite === "number" ? { cacheWriteTokens: rawUsage.cacheWrite } : {}),
            ...(typeof rawUsage.totalTokens === "number" ? { totalTokens: rawUsage.totalTokens } : {}),
          } : undefined;
          const blocks = (message.content as JsonObject[]).map((block) => {
            if (block.type === "thinking") return { type: "reasoning", text: block.thinking };
            if (block.type === "toolCall") return { type: "tool-call", id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) };
            return { type: "text", text: block.text ?? "" };
          });
          const { content: _content, ...replay } = message;
          const settled = await this.append(value, "assistant/message", { ...turnStep(), ...(event.entryId ? { entryId: event.entryId } : {}),
            message: createAssistantMessage({ content: blocks, source: { provider: message.provider, model: message.model, replayState: { ...replay, blocks: (message.content as JsonObject[]).map(({ text: _text, thinking: _thinking, arguments: _args, ...metadata }) => metadata) } } }),
            ...(usage ? { usage } : {}), stream: value.attempt?.stream.snapshot() ?? [], ...(message.stopReason === "aborted" ? { interrupted: true } : {}),
          }, true);
          if (message.stopReason === "error") value.lastFailure = String(message.errorMessage ?? "模型请求失败");
          if (value.attempt) this.frame(value, { type: "end", attemptId: value.attempt.id, index: value.attempt.index, outcome: { kind: "committed", eventType: "assistant/message", seq: settled.seq } });
          value.attempt = undefined;
        }
        if (message?.role === "toolResult") {
          await this.flushProgress(value, String(message.toolCallId), true);
          const sourceRead = object(message.details ?? {}).sourceRead;
          const content = sourceRead ? [{ type: "text", text: JSON.stringify({ sourceRead }) }] : (message.content as JsonObject[]).map((block) => block.type === "image" ? { type: "text", text: "[image reference]" } : block);
          await this.append(value, "tool/result", { ...turnStep(), ...(event.entryId ? { entryId: event.entryId } : {}), message: createToolResultMessage({ callId: message.toolCallId, content, isError: message.isError === true }), ...(message.details ? { meta: message.details } : {}) }, true);
        }
        break;
      }
      case "tool_execution_start":
        await this.append(value, "tool/call", { ...turnStep(), callId: event.toolCallId, name: event.toolName, arguments: JSON.stringify(event.args) }); break;
      case "turn_end": await this.append(value, "step/end", turnStep()); break;
      case "agent_end":
        await this.append(value, "turn/end", { turn: value.turn, reason: value.lastFailure ? { kind: "error", error: { code: "MODEL_ERROR", message: value.lastFailure } } : value.stopping ? { kind: "aborted", reason: { kind: "user" } } : { kind: "completed" } }); break;
    }
  }
  private pump(value: Owned) {
    if (value.working || this.disposed) return;
    value.working = (async () => {
      while (!this.disposed) {
        await value.mutation;
        const prompt = [...value.journal.commands.values()].find((entry) => value.journal.state.requests[entry.requestId] === "queued");
        if (!prompt) break;
        value.prompt = prompt; value.stopping = false; value.lastFailure = undefined;
        let index = value.journal.inbox["next-turn"].findIndex((message) => object(message.source).rpcId === prompt.requestId);
        if (index < 0) {
          await this.splice(value, "next-turn", value.journal.inbox["next-turn"].length, 0, [{ ...createUserMessage({ content: prompt.content, source: { kind: "user", rpcId: prompt.requestId } }), id: prompt.requestId }]);
          index = value.journal.inbox["next-turn"].length - 1;
        }
        value.activeMessage = value.journal.inbox["next-turn"][index];
        await this.splice(value, "next-turn", index, 1, []);
        value.journal.state.status = "running";
        await this.requestState(value, prompt.requestId, "running");
        try {
          const defaultSelection = this.options.models ? (await this.options.models.list(value.journal.state.userId)).default : {provider:this.options.model.provider,model:this.options.model.model,reasoningEffort:this.options.model.thinking};
          const selection = value.journal.state.modelSelection ?? value.journal.state.modelUsed ?? defaultSelection;
          const model = this.options.models ? await this.options.models.resolve(selection) : this.options.model;
          const key = JSON.stringify(selection);
          if (value.driver && value.driverSelection !== key) { await value.driver.dispose(); value.driver = undefined; }
          value.driverSelection = key;
          await this.append(value, "assistant/model-used", { selection });
          await this.append(value, "request/context", { contextWindow: model.contextWindow });
          value.driver ??= await (this.options.driver ?? createPiConversation)({ ...this.options, model, scope: value.journal.state, workdir: value.journal.directory, history: value.journal.events, records: value.journal.records,
            compact: (summary, firstKeptEntryId, tokensBefore) => value.journal.append({ kind: "compaction", summary, firstKeptEntryId, tokensBefore }),
            event: (event) => this.modelEvent(value, event), checkpoint: async () => { await value.writes; await value.journal.flush(); },
            progress: (callId, result) => this.progress(value, callId, result),
          });
          await value.driver.prompt((value.activeMessage!.content as { text: string }[]).map((part) => part.text).join("\n"));
          await this.requestState(value, prompt.requestId, value.stopping || value.lastFailure ? "interrupted" : "completed");
        } catch (error) {
          if (value.journal.events.findLast((event) => event.type === "turn/start" || event.type === "turn/end")?.type !== "turn/start") {
            value.turn++; await this.append(value, "turn/start", { turn: value.turn });
          }
          if (value.activeMessage) { await this.append(value, "user/message", value.activeMessage, true); value.activeMessage = undefined; }
          await this.append(value, "turn/end", { turn: value.turn, reason: { kind: "error", error: { code: "ASSISTANT_ERROR", message: errorText(error) } } });
          await this.requestState(value, prompt.requestId, "interrupted");
          this.options.onError?.(error);
        } finally {
          for (const callId of value.progress.keys()) await this.flushProgress(value, callId, true);
          for (const message of [...value.journal.inbox["next-step"]]) {
            await this.splice(value, "next-step", 0, 1, []);
            await this.splice(value, "next-turn", value.journal.inbox["next-turn"].length, 0, [message]);
            await this.requestState(value, String(object(message.source).rpcId), "queued");
          }
          value.journal.state.status = "idle";
          await value.journal.save();
        }
      }
    })().catch((error) => this.options.onError?.(error)).finally(() => { value.working = undefined; if (!this.disposed && Object.values(value.journal.state.requests).includes("queued")) this.pump(value); });
  }
  async prompt(userId: string, prompt: AssistantPrompt) {
    const scope = { userId, sessionId: prompt.sessionId };
    const value = await this.target(scope);
    if ("url" in value) { await this.forward(value, userId, "session/prompt", { request: prompt }); return; }
    const next = value.mutation.then(async () => {
      if (!(await value.journal.command(prompt))) return;
      if (Object.keys(value.journal.state.requests).length === 1) {
        value.journal.state.title = prompt.content.map((p) => p.text).join(" ").slice(0, 64);
        await this.append(value, "session/title", { title: value.journal.state.title, source: "user" });
      }
      const steering = prompt.mode === "steer" && !!value.working && !!value.driver;
      const target = steering ? "next-step" : "next-turn";
      await this.splice(value, target, value.journal.inbox[target].length, 0, [{ ...createUserMessage({ content: prompt.content, source: { kind: "user", rpcId: prompt.requestId } }), id: prompt.requestId }]);
      if (steering) {
        await this.requestState(value, prompt.requestId, "running");
        await value.driver!.steer(prompt.content.map((p) => p.text).join("\n"));
      } else this.pump(value);
    });
    value.mutation = next.catch(() => {});
    return next;
  }
  async projections(scope: AssistantScope) {
    const value = await this.target(scope);
    if ("url" in value) return this.forward(value, scope.userId, "session/projections", { request: { sessionId: scope.sessionId } });
    return sessionProjections(value.journal.state, value.journal, value.metrics);
  }
  async updateQueue(scope: AssistantScope, itemId: string, action: JsonObject) {
    const value = await this.target(scope);
    if ("url" in value) return this.forward(value, scope.userId, "session/updateQueue", { request: { sessionId: scope.sessionId, itemId, action } });
    const next = value.mutation.then(async () => {
      const target = value.journal.inbox["next-turn"].some((message) => message.id === itemId) ? "next-turn" : "next-step";
      const index = value.journal.inbox[target].findIndex((message) => message.id === itemId), message = value.journal.inbox[target][index];
      if (!message) throw new Error("Queued message is no longer pending");
      const requestId = String(object(message.source).rpcId);
      // Pi owns already submitted steering; editing it would mutate an in-flight request.
      if (target === "next-step") throw new Error("Steering has already been submitted");
      if (action.kind === "edit") {
        if (!Array.isArray(action.content) || !action.content.length || action.content.some((part: JsonObject) => part.type !== "text" || typeof part.text !== "string" || !part.text.trim())) throw new Error("Invalid queue content");
        await this.splice(value, target, index, 1, [{ ...message, content: action.content }], true);
      } else if (action.kind === "remove") {
        await this.splice(value, target, index, 1, [], true); await this.requestState(value, requestId, "interrupted");
      } else if (action.kind === "steer") {
        if (!value.working || !value.driver) throw new Error("No running turn");
        await this.splice(value, target, index, 1, []);
        await this.splice(value, "next-step", value.journal.inbox["next-step"].length, 0, [message]);
        await this.requestState(value, requestId, "running");
        await value.driver.steer((message.content as {text: string}[]).map((part) => part.text).join("\n"));
      } else throw new Error("Invalid queue action");
      return { accepted: true };
    });
    value.mutation = next.then(() => {}, () => {}); return next;
  }
  async selectModel(scope: AssistantScope, selection: AssistantModelSelection) {
    const value = await this.target(scope);
    if ("url" in value) { await this.forward(value, scope.userId, "session/selectModel", { request: {sessionId:scope.sessionId,...selection} }); return; }
    const next = value.mutation.then(async () => {
      if (!this.options.models) {
        if (selection.provider !== this.options.model.provider || selection.model !== this.options.model.model) throw new Error("Unknown model");
      } else await this.options.models.resolve(selection);
      await this.append(value, "assistant/model-selection", { selection });
    });
    value.mutation = next.then(() => {}, () => {}); await next;
  }
  async cancel(scope: AssistantScope) {
    const value = await this.target(scope);
    if ("url" in value) { await this.forward(value, scope.userId, "session/cancel", { request: { sessionId: scope.sessionId } }); return; }
    value.stopping = true; await value.driver?.abort();
  }
  async rename(scope: AssistantScope, title: string) {
    const value = await this.target(scope);
    if ("url" in value) return this.forward(value, scope.userId, "session/rename", { request: { sessionId: scope.sessionId, title } });
    value.journal.state.title = title;
    const event = await this.append(value, "session/title", { title, source: "user" }); return { title, seq: event.seq };
  }
  async mark(scope: AssistantScope, field: "archived" | "pinned", marked: boolean) {
    const value = await this.target(scope);
    if ("url" in value) return this.forward(value, scope.userId, `workspace/${field === "pinned" ? marked ? "pinSession" : "unpinSession" : marked ? "archiveSession" : "unarchiveSession"}`, { request: { sessionId: scope.sessionId } });
    if (field === "archived" && value.working) throw new Error("会话仍在执行");
    value.journal.state[field] = marked;
    await this.append(value, "assistant/metadata", { [field]: marked });
    return { sessionId: scope.sessionId };
  }
  private header(value: Owned) { return { version: SESSION_FORMAT_VERSION, id: value.journal.state.sessionId, createdAt: value.journal.state.createdAt, isSeeded: false }; }
  async page(scope: AssistantScope, beforeSeq = Infinity, maxMessages = 100) {
    const value = await this.target(scope);
    if ("url" in value) return this.forward(value, scope.userId, "session/page", { request: { address: { kind: "session", sessionId: scope.sessionId }, ...(Number.isFinite(beforeSeq) ? { beforeSeq } : {}), maxMessages } });
    const end = Math.min(beforeSeq, value.journal.events.length), start = Math.max(0, end - Math.min(1000, Math.max(1, maxMessages)));
    return { records: value.journal.events.slice(start, end).map((event) => ({ type: "event", event: this.publicEvent(event) })), hasMore: start > 0 };
  }
  async *events(scope: AssistantScope, signal: AbortSignal): AsyncIterable<unknown> {
    const value = await this.target(scope);
    if ("url" in value) {
      const base = `${value.url}/u/${scope.userId}/`;
      let relay = this.relays.get(base);
      if (!relay) { relay = new RemoteStreamMuxClient(new URL("api/remote.mux", base).href.replace(/^http/, "ws")); this.relays.set(base, relay); }
      relay.start();
      yield* relay.open("session/follow", { args: { request: { address: { kind: "session", sessionId: scope.sessionId }, assistantStream: true } } }, signal);
      return;
    }
    const following = value.feed.open(signal);
    const events = value.journal.events, start = Math.max(0, events.length - 100);
    yield { type: "snapshot", header: this.header(value), cursor: value.journal.state.lastSeq, records: events.slice(start).map((event) => ({ type: "event", event: this.publicEvent(event) })), hasMore: start > 0, projections: sessionProjections(value.journal.state, value.journal, value.metrics), assistantStream: value.stream.snapshot() };
    yield* following;
  }
  async *changes(userId: string, signal: AbortSignal, kind: "events" | "control") {
    const states = await this.list(userId);
    if (kind === "events") yield { type: "ready", clientId: randomUUID(), host: { home: this.options.directory } };
    else yield { type: "baseline", value: { projections: Object.fromEntries(await Promise.all(states.map(async (state) => [state.sessionId, await this.projections(state)]))) } };
    let favorites = JSON.stringify(await this.options.models?.readFavorites(userId));
    const seen = new Map(states.map((state) => [state.sessionId, JSON.stringify(state)]));
    while (!signal.aborted) {
      await delay(150, undefined, { signal }).catch(() => {});
      if (signal.aborted) break;
      if (kind === "events" && this.options.models) {
        const current = JSON.stringify(await this.options.models.readFavorites(userId));
        if (current !== favorites) { favorites = current; yield {type:"emit",event:"llm/adapters-updated",args:[]}; }
      }
      for (const state of await this.list(userId)) {
        const serialized = JSON.stringify(state);
        if (seen.get(state.sessionId) === serialized) continue;
        seen.set(state.sessionId, serialized);
        if (kind === "events") {
          yield { type: "emit", event: "api-session/added", args: [sessionSummary(state)] };
          yield { type: "emit", event: "api-session/status", args: [state.sessionId, state.status === "running"] };
        }
        else if (state.lastSeq >= 0) for (const [key, value] of Object.entries(object(object(await this.projections(state)).values))) yield { type: "projection", sessionId: state.sessionId, key, value, seq: state.lastSeq };
      }
    }
  }
  private async forward(owner: AssistantOwner, userId: string, method: string, args: unknown) {
    const response = await fetch(`${owner.url}/u/${userId}/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Session owner returned ${response.status}`);
    const envelope = await response.json() as { result: { ok: boolean; value?: JsonObject; error?: { message: string } } };
    if (!envelope.result.ok) throw new Error(envelope.result.error?.message ?? "Session owner failed");
    return envelope.result.value;
  }
  async dispose() {
    this.disposed = true;
    for (const relay of this.relays.values()) await relay.close();
    for (const promise of this.owned.values()) {
      const value = await promise.catch(() => undefined);
      if (!value) continue;
      value.stopping = true;
      try { await value.driver?.abort(); await value.working; await value.driver?.dispose(); await value.journal.flush(); }
      finally { await value.release(); }
    }
  }
}
