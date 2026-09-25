import { rm, cp, readdir } from "node:fs/promises";
import path from "node:path";
import { root, run } from "./lib.mjs";

await Promise.all(
  ["apps", "packages", "tests"].map((name) =>
    rm(path.join(root, "dist", name), { recursive: true, force: true }),
  ),
);
await run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);

async function resources(directory) {
  for (const entry of await readdir(path.join(root, directory), {
    withFileTypes: true,
  })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await resources(file);
    else if (/\.(md|json)$/.test(entry.name)) await cp(path.join(root, file), path.join(root, "dist", file));
  }
}
await resources("packages/agents/src");
