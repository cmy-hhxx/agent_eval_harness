import { setTimeout as delay } from "node:timers/promises";
import { object, type AssistantModelSelection, type AssistantPrompt, type AssistantSessionRuntime, type JsonObject } from "@eval/contracts";
import { assistantSettingsDescribe, sessionSummary, type AssistantEndpoints } from "@eval/runtime/assistant";

/** Product operations; transport framing belongs entirely to upstream Runtime. */
export function assistantEndpoints(sessions: AssistantSessionRuntime, artifact?: AssistantEndpoints["artifact"]): AssistantEndpoints {
  const workspace = async (userId: string) => {
    const rows = await sessions.list(userId);
    return { workspaceId: "analysis", title: "评测分析", path: sessions.options.directory,
      sessionIds: rows.filter((r) => !r.archived).map((r) => r.sessionId), createdAt: new Date(rows.at(-1)?.createdAt ?? 0).toISOString(), updatedAt: new Date(rows[0]?.updatedAt ?? 0).toISOString() };
  };
  const requestOf = (payload: unknown) => object(object(payload).args ?? {});
  return {
    artifact,
    async call(userId, endpoint, payload) {
      const args = requestOf(payload), request = object(args.request ?? {});
      const scope = { userId, sessionId: String(request.sessionId ?? object(request.address ?? {}).sessionId ?? "") };
      switch (endpoint) {
        case "session/list": return { items: (await sessions.list(userId)).map(sessionSummary) };
        case "session/search": return { items: (await sessions.list(userId)).filter((row) => row.title.includes(String(request.query ?? ""))).map(sessionSummary) };
        case "session/create": return { sessionId: (await sessions.create(userId, request.sessionId as string | undefined)).sessionId };
        case "session/prompt": {
          if (typeof request.requestId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(request.requestId) || !["queue", "steer"].includes(String(request.mode)) || !Array.isArray(request.content) || !request.content.length || request.content.some((part: JsonObject) => part.type !== "text" || typeof part.text !== "string")) throw new Error("Invalid prompt");
          await sessions.prompt(userId, request as unknown as AssistantPrompt); return { accepted: true };
        }
        case "session/cancel": await sessions.cancel(scope); return { accepted: true };
        case "session/rename": {
          if (typeof request.title !== "string" || !request.title.trim() || request.title.length > 200) throw new Error("Invalid title");
          return sessions.rename(scope, request.title.trim());
        }
        case "session/page": return sessions.page(scope, request.beforeSeq as number | undefined, request.maxMessages as number | undefined);
        case "session/projections": return sessions.projections(scope);
        case "session/updateQueue": return sessions.updateQueue(scope, String(request.itemId), object(request.action));
        case "session/selectModel":
          await sessions.selectModel(scope, {provider:String(request.provider),model:String(request.model),...(request.reasoningEffort===undefined?{}:{reasoningEffort:request.reasoningEffort as AssistantModelSelection["reasoningEffort"]})}); return null;
        case "assistant/models":
          if (!sessions.options.models) throw new Error("网关模型目录未配置");
          return sessions.options.models.list(userId, request.refresh === true);
        case "assistant/favorites":
          if (!sessions.options.models || !Array.isArray(request.ids) || request.ids.some(id=>typeof id!=="string")) throw new Error("Invalid model selection");
          await sessions.options.models.favorites(userId, request.ids as string[]); return {accepted:true};
        case "session/modelCatalog": {
          const directory = sessions.options.models ? await sessions.options.models.list(userId) : {models:[{id:sessions.options.model.model,name:sessions.options.model.model}],favorites:[sessions.options.model.model],default:{provider:sessions.options.model.provider,model:sessions.options.model.model}};
          return {groups:[{id:sessions.options.model.provider,name:"评测网关",models:directory.models.filter(model=>directory.favorites.includes(model.id))}],failures:[],routableProviders:[sessions.options.model.provider],default:directory.default};
        }
        case "session/skillList": return { items: [] };
        case "session/workspacePathApplications": return { applications: [] };
        case "workspace/initializeDefault": return { workspace: await workspace(userId), created: false };
        case "workspace/archiveSession": return sessions.mark(scope, "archived", true);
        case "workspace/unarchiveSession": return sessions.mark(scope, "archived", false);
        case "workspace/pinSession": return sessions.mark(scope, "pinned", true);
        case "workspace/unpinSession": return sessions.mark(scope, "pinned", false);
        case "settings/describe": return assistantSettingsDescribe();
        case "commands/list": return [];
        case "directoryPicker/capabilities": return { native: false, browse: false };
        default: throw new Error(`当前评测分析 Agent 不提供 ${endpoint}`);
      }
    },
    async stream(userId, endpoint, payload, signal) {
      const args = requestOf(payload), request = object(args.request ?? {});
      if (endpoint === "$events") return sessions.changes(userId, signal, "events");
      if (endpoint === "session/control") return sessions.changes(userId, signal, "control");
      if (endpoint === "session/follow") return sessions.events({ userId, sessionId: String(object(request.address).sessionId) }, signal);
      if (endpoint === "workspace/follow") return (async function* () {
        let previous = "";
        while (!signal.aborted) {
          const rows = await sessions.list(userId), item = await workspace(userId);
          const state = { items: [item], archivedSessionIds: rows.filter((r) => r.archived).map((r) => r.sessionId), pinnedSessionIds: rows.filter((r) => r.pinned).map((r) => r.sessionId) };
          const current = JSON.stringify(state);
          if (!previous) yield { type: "baseline", value: state };
          else if (previous !== current) {
            yield { type: "upsert", workspace: item };
            yield { type: "archived", archivedSessionIds: state.archivedSessionIds };
            yield { type: "pinned", pinnedSessionIds: state.pinnedSessionIds };
          }
          previous = current;
          await delay(150, undefined, { signal }).catch(() => {});
        }
      })();
      throw new Error(`Unknown stream ${endpoint}`);
    },
    dispose: () => sessions.dispose(),
  };
}
