import { rm } from "node:fs/promises";
import path from "node:path";
import { root, run } from "./lib.mjs";

await Promise.all(
  ["apps", "packages", "tests"].map((name) =>
    rm(path.join(root, "dist", name), { recursive: true, force: true }),
  ),
);
await run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
