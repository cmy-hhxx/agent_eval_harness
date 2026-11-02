import { parseArgs } from "node:util";
import path from "node:path";
import { localFiles, runLock } from "@eval/data";
import { readConsoleConfig, serveConsole } from "./console-server.js";
import { ConsoleTasks } from "./console-tasks.js";
import { applySettings, readSettings } from "./settings.js";
import { initializeServices, logger } from "./composition.js";

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (!values.config) throw new Error("console requires --config FILE");
const config = await readConsoleConfig(path.resolve(values.config));
applySettings(await readSettings());
process.env.EVAL_LOG_DIR = config.logDirectory;
process.env.EVAL_LOG_LOCK_DIR = path.join(config.stateDirectory, "log-writer");
await initializeServices();
const unlock = await runLock(config.stateDirectory);
const tasks = new ConsoleTasks(config);
try {
  await tasks.initialize();
  const password = (await localFiles.read(config.passwordFile, "utf8")).trim();
  const http = await serveConsole(tasks, password);
  await logger.event("console_ready", { component: "console", port: config.port });
  console.log("Evaluation console ready on port " + http.url.split(":").at(-1));
  await new Promise<void>(resolve => {
    process.once("SIGTERM", resolve); process.once("SIGINT", resolve);
  });
  await tasks.close();
  await http.close();
} finally { await unlock(); }
