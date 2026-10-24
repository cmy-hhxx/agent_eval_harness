import path from "node:path";
import { parseArgs } from "node:util";
import { AssistantAccounts, createFileLogger, runLock } from "@eval/data";
import { AssistantSessions, serveAssistant } from "@eval/runtime/assistant";
import { assistantEndpoints } from "@eval/assistant/server";
import { createEris } from "@eval/assistant";
import { createSerperSearch, createWebReader } from "@eval/tools";
import { readSettings, applySettings, configurationSecrets } from "./settings.js";
import { ROOT } from "./paths.js";
import { assistantModelConfiguration, GatewayAssistantModels } from "./assistant-models.js";
import { CatalogAnalysisData } from "./assistant-catalog.js";
import { readErisConfig } from "./eris-config.js";
import { erisAccess } from "./eris-auth.js";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("使用 --config 指定服务器 Eris 配置");
const config = await readErisConfig(path.resolve(values.config));
const settings = await readSettings(config.evalConfigFile);
const bypass = [settings.environment.NO_PROXY, settings.environment.no_proxy, process.env.NO_PROXY, process.env.no_proxy, "localhost", "127.0.0.1", "::1", ...Object.values(settings.channels).map(channel => new URL(channel.baseUrl).hostname)].filter(Boolean).join(",");
settings.environment.NO_PROXY = bypass; settings.environment.no_proxy = bypass;
applySettings(settings);
const release = await runLock(path.join(config.runtimeRoot, "state/eris"));
let sessions: AssistantSessions | undefined;
try {
  const logger = createFileLogger({ directory: path.join(config.runtimeRoot, "log"), lockDirectory: path.join(config.runtimeRoot, "state/log-writer"), secrets: configurationSecrets() });
  await logger.initialize();
  const accounts = new AssistantAccounts(path.join(config.runtimeRoot, "secrets/eris"));
  const initialPassword = process.env.ERIS_ADMIN_PASSWORD;
  delete process.env.ERIS_ADMIN_PASSWORD;
  await accounts.initialize("cmy", initialPassword);
  const directory = path.join(config.runtimeRoot, "data/assistant");
  const access = await erisAccess(accounts, config.publicOrigin, async userId => {
    for (const session of await sessions?.list(userId) ?? []) if (session.status === "running") await sessions?.cancel(session);
  });
  const { model, gateways } = assistantModelConfiguration(settings);
  const data = new CatalogAnalysisData(config.dataRoot, {
    stateFile: path.join(config.runtimeRoot, "state/automations/remote-evaluation/state.json"),
    logFile: path.join(config.runtimeRoot, "log/comparison-statistics-log.jsonl"),
    deliveryFile: path.join(config.runtimeRoot, "state/automations/statistics-delivery.json"),
  });
  const server = await serveAssistant({ ...config.listen, access, userId: "cmy", webDirectory: path.join(ROOT, "dist/agent/web"), endpoints(url) {
    sessions = new AssistantSessions({ directory, url, model, internalAuthorization: access.internalAuthorization,
      models: new GatewayAssistantModels(directory, model, gateways),
      ...createEris({ data, search: createSerperSearch({ apiKey: process.env.SEARCH_API_KEY }), web: createWebReader() }),
      onError: error => { void logger.error(error, { component: "assistant", event: "error" }); },
    });
    return assistantEndpoints(sessions);
  }, onError: error => { void logger.error(error, { component: "assistant-http", event: "error" }); } });
  console.log(`Eris: ${config.publicOrigin}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; try { await server.close(); } finally { await release(); } };
  process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
} catch (error) { await release(); throw error; }
