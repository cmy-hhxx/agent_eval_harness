/** Typed application seam over the bundled upstream implementation. */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { JsonObject } from "@eval/contracts";
export class Context {
  effect(callback: () => (() => void), name?: string): () => void;
  fiber: { dispose(): Promise<void> };
}
export class Peer {
  constructor(owner: Context, options: { principal: { kind: "owner" }; interactions?: "answer" | "none" });
  readonly id: string;
  readonly ctx: Context;
  readonly principal: { kind: "owner" };
  readonly interactions: "answer" | "none";
  readonly signal: AbortSignal;
  dispose(): Promise<void>;
}
export interface ConnectionWebSocketEventMap {
  readonly open: object;
  readonly error: object;
  readonly close: object;
  readonly message: { readonly data: unknown };
}
export interface ConnectionWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<Event extends keyof ConnectionWebSocketEventMap>(event: Event, listener: (event: ConnectionWebSocketEventMap[Event]) => void, options?: { readonly once?: boolean }): void;
  removeEventListener<Event extends keyof ConnectionWebSocketEventMap>(event: Event, listener: (event: ConnectionWebSocketEventMap[Event]) => void): void;
}
export class RemoteStreamMuxServer {
  constructor(open: (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: Peer, control: AbortController, window: { maxBytes: number; frameOverheadBytes: number }) => Promise<AsyncIterable<unknown>>, failure: (error: unknown) => unknown, options: { heartbeatIntervalMs: number; streamInboxBytes: number; compression: boolean });
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: Peer): void;
  close(): Promise<void>;
}
export class RemoteStreamMuxClient {
  constructor(openSocket?: (path: string) => ConnectionWebSocket, waitForReconnect?: boolean);
  start(): void;
  reconnect(): void;
  close(): Promise<void>;
  open(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>;
}
export function rpcFetchHandler(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal, peer: Peer) => Promise<unknown>): { fetch(request: Request, peer: Peer): Promise<Response> };
export function bootThemeInjections(preference: "light", fontSizes?: { text: number; code: number; terminal: number }, fontFamilies?: { text: string; code: string; terminal: string }): { kind: string; text: string; placement?: string }[];
export const SESSION_FORMAT_VERSION: number;
export class ToolCallRecovery {
  observe(event: import("@eval/contracts").AssistantEvent): void;
  results(): (import("@eval/contracts").AssistantEvent & { sourceEventSeqs?: number[] })[];
}
export class AssistantStreamAccumulator {
  push(value: {time: number; chunk: JsonObject}): unknown;
  snapshot(): JsonObject[];
}
export class SessionAssistantStreamAccumulator {
  accept(frame: JsonObject, durableCursor: number): void;
  snapshot(): JsonObject;
}
export function createUserMessage(input: JsonObject): JsonObject;
export function createAssistantMessage(input: JsonObject): JsonObject;
export function createToolResultMessage(input: JsonObject): JsonObject;

export class RemoteStreamCarrierError extends Error {}
export function assistantSettingsDescribe(document: import("@eval/contracts").AssistantPreferences): JsonObject;
export function assistantSettingsMutation(document: import("@eval/contracts").AssistantPreferences, namespace: string, ops: unknown, expectedRevision: unknown): import("@eval/contracts").AssistantPreferences;

export function createAssistantMetrics(): {accept(event: import("@eval/contracts").AssistantEvent): void; view(): JsonObject};
