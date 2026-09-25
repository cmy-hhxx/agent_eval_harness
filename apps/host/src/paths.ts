import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const runtimePaths = {
  root: ROOT,
  workerEntry: path.join(ROOT, "dist/apps/worker/src/cli.js"),
};
