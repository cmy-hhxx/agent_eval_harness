// Application Remote descriptors consume the unmodified upstream Gateway.
// The server validates the business payload before dispatching any operation.
const codec = { mode: "strict", typeSymbol: "JsonValue", create: () => ({ parse: (value) => {
  if (value !== undefined) JSON.stringify(value);
  return value;
} }) };
const methods = {
  session: {
    list: ["request"], search: ["request"], create: ["request"], rename: ["request"],
    fork: ["request"], prompt: ["request"], cancel: ["request"], updateQueue: ["request"],
    page: ["request"], follow: ["request"], control: [], projections: ["request"],
    selectModel: ["request"], modelCatalog: [], skillList: ["request"], workspacePathApplications: ["request"],
  },
  assistant: { models: ["request"], favorites: ["request"], toolResult: ["request"] },
  workspace: {
    follow: [], initializeDefault: [], create: ["request"], rename: ["request"], delete: ["request"],
    insertBefore: ["request"], insertSessionBefore: ["request"], archiveSession: ["request"],
    unarchiveSession: ["request"], pinSession: ["request"], unpinSession: ["request"],
  },
  settings: { describe: [], mutate: ["ns", "ops", "expectedRevision"] },
  commands: { list: ["agentId"], execute: ["agentId", "line", "attachments"] },
  subagents: { prompt: ["request"], interruptByParent: ["childSessionId", "parentSessionId", "mode"] },
  directoryPicker: { capabilities: [], pick: [] },
};
const streams = new Set(["session/follow", "session/control", "workspace/follow"]);
export const contribution = {
  package: "@eval/assistant",
  descriptors: Object.entries(methods).flatMap(([namespace, entries]) => Object.entries(entries).map(([method, names]) => ({
    id: `${namespace}/${method}`, service: namespace, namespace, method,
    invocation: { kind: "direct" },
    parameters: names.map((name) => ({ name, wire: name, source: "json", codec, ...(name === "expectedRevision" ? { acceptsUndefined: true } : {}) })),
    result: codec, cancellation: { parameter: "signal" },
    ...(streams.has(`${namespace}/${method}`) ? { mode: "stream" } : {}),
  }))),
};
