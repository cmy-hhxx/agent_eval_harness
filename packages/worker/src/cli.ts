import { parseArgs } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentBackend, Engine, EngineIdentity } from "../../contracts/src/index.js";
import { ROOT, errorText } from "../../contracts/src/io.js";
import { loadIdentity } from "./identity.js";
import { startWorker } from "./server.js";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    directory: { type: "string" },
    port: { type: "string", default: "0" },
  },
});
const engine = values.engine as Engine;
if (!["pi", "prime"].includes(engine)) throw new Error("--engine pi|prime required");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PRIME_AGENT_TELEMETRY = "0";
process.env.DO_NOT_TRACK = "1";
process.env.PRIME_AGENT_KERNEL_PYTHON = path.join(ROOT, ".runtime/prime-python/bin/python");
const identity = await loadIdentity(engine);
const adapter = (await import(
  pathToFileURL(path.join(ROOT, `dist/packages/agent-${engine}/src/index.js`)).href
)) as Record<string, (identity: EngineIdentity) => AgentBackend>;
const backend = adapter[`${engine}Backend`](identity);
const worker = await startWorker(
  backend,
  values.directory || path.join(ROOT, ".runtime", "workers", `${engine}-${process.pid}`),
  undefined,
  Number(values.port),
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
    console.error(errorText(error));
    process.exit(2);
  }
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
process.once("disconnect", () => void close());
