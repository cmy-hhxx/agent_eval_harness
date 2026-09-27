// Server-only bridge; no Pi or evaluation definitions enter the browser bundle.
export { RemoteStreamMuxServer } from "../../../vendor/deepseek/packages/api/gateway/src/stream-server.ts";
export { RemoteError, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
export { Context } from "@deepseek-ai/cordis";
export { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
export { createUserMessage, createAssistantMessage, createToolResultMessage, createSystemMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
export { AssistantStreamAccumulator } from "@deepseek-ai/dsh-llm/assistant-stream";
export { bootThemeInjections } from "../../../vendor/deepseek/packages/client/ui-theme/src/boot-theme.ts";

export { rpcFetchHandler } from "../../../vendor/deepseek/packages/client/connection/src/rpc-host.ts";
export { RemoteStreamMuxClient, RemoteStreamCarrierError } from "../../../vendor/deepseek/packages/api/gateway/src/client/stream-client.ts";
export { SessionAssistantStreamAccumulator } from "../../../vendor/deepseek/packages/api/session-controller/src/assistant-stream.ts";
import { DeveloperToolsSettingsSchema } from "../../../vendor/deepseek/packages/client/ui-settings/src/developer-tools-settings.ts";
export function assistantSettingsDescribe() {
  return { writable: false, hasDocument: false, namespaces: [{ ns: "ui-settings", autoGenerate: false, schema: DeveloperToolsSettingsSchema.toJSON(), value: { enabled: true }, base: { enabled: true }, user: {}, applies: "live", secrets: [], revision: 0 }] };
}

import { tokenUsageProjectionDefinition, contextPressureProjectionDefinition } from "../../../vendor/deepseek/packages/llm/token-meter/src/usage-projection.ts";
import { sessionStatsProjectionDefinition } from "../../../vendor/deepseek/packages/session/session-stats/src/projection.ts";
export function createAssistantMetrics() {
  const entries = [tokenUsageProjectionDefinition, contextPressureProjectionDefinition, sessionStatsProjectionDefinition].map(definition => ({definition,state:definition.init()}));
  return {
    accept(event) { for (const entry of entries) entry.state = entry.definition.apply(entry.state,event); },
    view() { return Object.fromEntries(entries.map(({definition,state})=>[definition.key,definition.wire.view(state)])); },
  };
}
