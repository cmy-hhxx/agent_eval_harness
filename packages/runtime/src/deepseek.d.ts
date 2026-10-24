/** Typed application seam over the bundled upstream implementation. */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { JsonObject } from "@eval/contracts";
export class Context {
  effect(callback: () => (() => void), name?: string): () => void;
  fiber: { dispose(): Promise<void> };
}
export interface Peer { id: string; ctx: Context; dispose(): Promise<void> }
export class RemoteStreamMuxServer {
  constructor(open: (endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>, peer: Peer, control: AbortController) => Promise<AsyncIterable<unknown>>, failure: (error: unknown) => unknown, heartbeat: number, inboxBytes: number);
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, peer: Peer): void;
  close(): Promise<void>;
}
export class RemoteStreamMuxClient {
  constructor(endpointUrl?: string, socketFactory?: (url: string) => WebSocket);
  start(): void;
  close(): Promise<void>;
  open(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>;
}
export function rpcFetchHandler(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal, peer: Peer) => Promise<unknown>, peer: Peer): { fetch(request: Request): Promise<Response> };
export function bootThemeInjections(preference: "light", fontSize?: number): { kind: string; text: string; placement?: string }[];
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
