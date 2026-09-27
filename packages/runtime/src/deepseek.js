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
import { LocaleSettingsSchema } from "../../../vendor/deepseek/packages/client/locale/src/locale-settings.ts";
import { ThemeSettingsSchema } from "../../../vendor/deepseek/packages/client/ui-theme/src/theme-settings.ts";
import { ConversationSettingsSchema } from "../../../vendor/deepseek/packages/client/ui-conversation/src/submission-settings.ts";
import { ChatSettingsSchema, TRANSCRIPT_VIEW_MODES } from "../../../vendor/deepseek/packages/client/ui-chat/src/chat-settings.ts";
const settingsSections = [
  {ns: "ui-settings", schema: DeveloperToolsSettingsSchema, base: {enabled: true}, fields: []},
  {ns: "locale", schema: LocaleSettingsSchema, base: {}, fields: ["preference"]},
  {ns: "ui-theme", schema: ThemeSettingsSchema, base: {preference: "light", fontSize: 14}, fields: ["fontSize"]},
  {ns: "ui-conversation", schema: ConversationSettingsSchema, base: {busyEnter: "queue"}, fields: ["busyEnter"]},
  {ns: "ui-chat", schema: ChatSettingsSchema, base: {transcriptView: "standard", performanceUsage: "detailed", linkOpening: "new-tab"}, fields: ["transcriptView", "performanceUsage"]},
];
export function assistantSettingsDescribe(document) {
  return { writable: true, hasDocument: false, namespaces: settingsSections.map(({ns, schema, base}) => ({
    ns, autoGenerate: false, schema: schema.toJSON(), value: {...base,...document.values[ns]}, base,
    user: document.values[ns] ?? {}, applies: "live", secrets: [], revision: document.revisions[ns] ?? 0,
  })) };
}
export function assistantSettingsMutation(document, namespace, ops, expectedRevision) {
  const section = settingsSections.find(section => section.ns === namespace);
  if (!section?.fields.length || !Array.isArray(ops) || !ops.length) throw new Error("Invalid settings mutation");
  const revision = document.revisions[namespace] ?? 0;
  if (expectedRevision !== revision) throw new Error("设置已在另一窗口更新，请重试");
  const user = {...document.values[namespace]};
  for (const op of ops) {
    if (!op || !Array.isArray(op.path) || op.path.length !== 1 || !section.fields.includes(op.path[0])) throw new Error("Unsupported setting");
    const field = op.path[0];
    if (op.op === "unset") delete user[field];
    else if (op.op === "set") user[field] = op.value;
    else throw new Error("Unsupported settings operation");
  }
  section.schema({...section.base, ...user});
  if (namespace === "ui-chat" && user.transcriptView !== undefined && !TRANSCRIPT_VIEW_MODES.includes(user.transcriptView)) throw new Error("Unsupported work details mode");
  if (namespace === "locale" && user.preference !== undefined && !["zh", "en"].includes(user.preference)) throw new Error("Unsupported language");
  return {revision: document.revision + 1, revisions: {...document.revisions, [namespace]: revision + 1}, values: {...document.values, [namespace]: user}};
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
