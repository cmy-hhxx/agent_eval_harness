import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLogger } from "@eval/data";
import { logger } from "@eval/host-app/composition";

// Keep the real CLI and logger, but isolate test failures from operator logs.
const directory = process.argv[2];
Object.assign(logger, createFileLogger({
  directory: path.join(directory, "log"),
  lockDirectory: path.join(directory, ".runtime/log-writer"),
}));
const entry = new URL("../../apps/host/src/cli.js", import.meta.url);
process.argv.splice(1, 2, fileURLToPath(entry));
await import(entry.href);
