import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { publishTree, root, run } from "./lib.mjs";

const staging = await mkdtemp(path.join(root, ".runtime", "build-test-"));
try {
  await run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", staging]);
  async function resources(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await resources(file);
      else if (/\.(md|json)$/.test(entry.name)) {
        await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
        await cp(path.join(root, file), path.join(staging, file));
      }
    }
  }
  for (const directory of ["packages/agents/src", "packages/prompts/resources", "schemas"]) await resources(directory);
  for (const name of ["apps", "packages", "tests", "schemas"]) await publishTree(path.join(staging, name), path.join(root, "dist", name));
} finally {
  await rm(staging, { recursive: true, force: true });
}
