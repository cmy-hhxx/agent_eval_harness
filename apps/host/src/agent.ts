import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { exists, assistantUser, writeAssistantArtifact, readAssistantArtifact } from "@eval/data";
import { AssistantSessions, serveAssistant } from "@eval/runtime/assistant";
import { assistantEndpoints } from "@eval/assistant/server";
import { createEris } from "@eval/assistant";
import { createSerperSearch, createWebReader } from "@eval/tools";
import { loadConfig, createModelResolver, DEFAULT_THINKING } from "./config.js";
import { ROOT } from "./paths.js";
import { logger } from "./composition.js";
import { GatewayAssistantModels } from "./assistant-models.js";
import { LocalAnalysisData } from "./assistant-data.js";
import { LocalSpecialists } from "./assistant-specialists.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "4180" }, user: { type: "string", default: "local" }, "no-open": { type: "boolean", default: false }, debug: { type: "boolean", default: false } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
const userId = assistantUser(values.user!);
const sources = [path.join(ROOT, "configs/host.json")];
if (await exists(path.join(ROOT, "configs/local/models.json"))) sources.push(path.join(ROOT, "configs/local/models.json"));
const config = await loadConfig(sources);
const model = process.env.AGENT_MODEL ? {
  provider: "evaluation-gateway", baseUrl: process.env.EVAL_BASE_URL!, api: "openai-responses" as const, apiKeyEnv: "EVAL_API_KEY", model: process.env.AGENT_MODEL,
  thinking: DEFAULT_THINKING, contextWindow: Number(process.env.AGENT_CONTEXT_WINDOW ?? 131072), maxOutputTokens: Number(process.env.AGENT_MAX_TOKENS ?? 8192),
} : createModelResolver(config.models)("attribution");
if (!model.baseUrl || !process.env[model.apiKeyEnv]) throw new Error("请在根目录 .env 中配置 EVAL_BASE_URL、EVAL_API_KEY 和 AGENT_MODEL（或 configs/local/models.json）");
const server = await serveAssistant({ port, userId, webDirectory: path.join(ROOT, "dist/agent/web"), endpoints: (url) => assistantEndpoints(new AssistantSessions({
  directory: path.join(ROOT, "data/assistant"), url, model, models: new GatewayAssistantModels(path.join(ROOT, "data/assistant"), model),
  ...createEris({ data: new LocalAnalysisData(config.evaluation.output.path), specialists: new LocalSpecialists(path.join(ROOT, "data/assistant"), new LocalAnalysisData(config.evaluation.output.path), config, values.debug), search: createSerperSearch({ apiKey: process.env.SEARCH_API_KEY }), web: createWebReader(), save: async (scope, markdown) => { const artifact = await writeAssistantArtifact(path.join(ROOT, "data/assistant"), scope, markdown); return { ...artifact, url: `${url}/u/${scope.userId}/artifacts/${scope.sessionId}/${artifact.name}` }; } }),
  onError: (error) => { void logger.error(error, { component: "assistant", event: "error" }); },
}), (userId, sessionId, id) => readAssistantArtifact(path.join(ROOT, "data/assistant"), { userId, sessionId }, id)), onError: (error) => { void logger.error(error, { component: "assistant-http", event: "error" }); } });
const url = `${server.url}/u/${userId}/`;
console.log(`Eris: ${url}`);
if (!values["no-open"]) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const child = spawn(command, process.platform === "win32" ? ["/c", "start", "", url] : [url], { stdio: "ignore", detached: true });
  child.on("error", (error) => console.error(`浏览器未自动打开：${error.message}\n${url}`)); child.unref();
}
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await server.close(); };
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
