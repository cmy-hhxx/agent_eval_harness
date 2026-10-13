import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { exists, assistantUser } from "@eval/data";
import { AssistantSessions, serveAssistant } from "@eval/runtime/assistant";
import { assistantEndpoints } from "@eval/assistant/server";
import { createEris } from "@eval/assistant";
import { createSerperSearch, createWebReader } from "@eval/tools";
import { loadConfig, createModelResolver, readSettings, configurationSecrets } from "./config.js";
import { ROOT } from "./paths.js";
import { logger } from "./composition.js";
import { assistantModelConfiguration, GatewayAssistantModels } from "./assistant-models.js";
import { LocalAnalysisCode } from "./assistant-code.js";
import { LocalAnalysisData } from "./assistant-data.js";
import { LocalSpecialists } from "./assistant-specialists.js";
import { loadAutomationConfig } from "./automation-config.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "4180" }, user: { type: "string", default: "local" }, "no-open": { type: "boolean", default: false }, debug: { type: "boolean", default: false } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
const userId = assistantUser(values.user!);
const sources = [path.join(ROOT, "configs/host.json")];
if (await exists(path.join(ROOT, "configs/local/models.json"))) sources.push(path.join(ROOT, "configs/local/models.json"));
// Eris may read local search credentials without changing evaluation startup.
if (await exists(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
const configuration = await readSettings();
const config = await loadConfig(sources, configuration);
const automation = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
const data = new LocalAnalysisData(config.evaluation.output.path, {
  stateFile: path.join(automation.stateDirectory, "state.json"), logFile: automation.publication.logFile,
});
logger.addSecrets(...configurationSecrets());
const { model, gateways } = assistantModelConfiguration(createModelResolver(config.models)("attribution"), configuration);
const server = await serveAssistant({ port, userId, webDirectory: path.join(ROOT, "dist/agent/web"), endpoints: (url) => assistantEndpoints(new AssistantSessions({
  directory: path.join(ROOT, "data/assistant"), url, model, models: new GatewayAssistantModels(path.join(ROOT, "data/assistant"), model, gateways),
  ...createEris({ code: new LocalAnalysisCode(path.join(ROOT, "data/assistant"), path.join(ROOT, ".venv/bin/python")), data, specialists: new LocalSpecialists(path.join(ROOT, "data/assistant"), data, config, values.debug), search: createSerperSearch({ apiKey: process.env.SEARCH_API_KEY }), web: createWebReader() }),
  onError: (error) => { void logger.error(error, { component: "assistant", event: "error" }); },
})), onError: (error) => { void logger.error(error, { component: "assistant-http", event: "error" }); } });
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
