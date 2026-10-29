import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep the real CLI and logger, but isolate test failures from operator logs.
const directory = process.argv[2];
process.env.EVAL_LOG_DIR = path.join(directory, "log");
process.env.EVAL_LOG_LOCK_DIR = path.join(directory, ".runtime/log-writer");
const entry = new URL("../../apps/host/src/cli.js", import.meta.url);
process.argv.splice(1, 2, fileURLToPath(entry));
await import(entry.href);
