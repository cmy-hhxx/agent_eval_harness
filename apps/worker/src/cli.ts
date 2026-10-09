import { readSettings, applySettings, configurationSecrets } from "@eval/host-app/settings";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLogger } from "@eval/data";
import type { AgentBackend, Engine, EngineIdentity } from "@eval/contracts";
import { errorText, redact } from "@eval/contracts";
import { loadIdentity } from "@eval/runtime/client";
import { startWorker } from "@eval/runtime/worker";

function logs(root: string) {
  return createFileLogger({
    directory: path.join(root, "log"),
    lockDirectory: path.join(root, ".runtime/log-writer"),
    secrets: configurationSecrets(),
  });
}
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
let logger = logs(defaultRoot);

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      engine: { type: "string" },
      directory: { type: "string" },
      port: { type: "string", default: "0" },
    },
  });
  const ROOT = path.resolve(values.root || defaultRoot);
  if (!process.send) applySettings(await readSettings(process.env.EVAL_CONFIG_FILE || path.join(ROOT, "config.ini")));
  logger = logs(ROOT);
  if (!process.send) await logger.initialize();
  const engine = values.engine as Engine;
  if (!["pi", "prime"].includes(engine)) throw new Error("--engine pi|prime required");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.PRIME_AGENT_TELEMETRY = "0";
  process.env.DO_NOT_TRACK = "1";
  process.env.PRIME_AGENT_KERNEL_PYTHON = path.join(ROOT, ".runtime/prime-python/bin/python");
  const identity = await loadIdentity(engine, ROOT);
  const adapters: Record<Engine, string> = {
    pi: "@eval/runtime/pi",
    prime: "@eval/runtime/prime",
  };
  const adapter = (await import(adapters[engine])) as Record<
    string,
    (identity: EngineIdentity) => AgentBackend
  >;
  const backend = adapter[`${engine}Backend`](identity);
  const worker = await startWorker(
    backend,
    values.directory || path.join(ROOT, ".runtime", "workers", `${engine}-${process.pid}`),
    undefined,
    Number(values.port),
    { python: process.env.EVAL_PYTHON || path.join(ROOT, ".venv/bin/python") },
  );
  const ready = { type: "ready", url: worker.url, engine };
  if (process.send) process.send(ready);
  else console.log(JSON.stringify(ready));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await worker.close();
      process.exit(0);
    } catch (error) {
      await logger.error(error, { component: "worker", event: "shutdown_failed" });
      console.error(redact(errorText(error), configurationSecrets()));
      process.exit(2);
    }
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  process.once("disconnect", () => void close());
}

main().catch(async (error) => {
  // Managed startup failures reach the Host through stderr and are logged there once.
  if (!process.send) await logger.error(error, { component: "worker", event: "startup_failed" });
  console.error(redact(errorText(error), configurationSecrets()));
  process.exitCode = 2;
});
