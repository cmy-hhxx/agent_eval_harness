import { cp, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { publishTree, root, run } from "./lib.mjs";

await mkdir(path.join(root, ".runtime"), { recursive: true });
const staging = await mkdtemp(path.join(root, ".runtime", "build-app-"));
try {
  await run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", staging]);
  await cp(path.join(root, "apps/host/dashboard"), path.join(staging, "apps/host/dashboard"), {
    recursive: true,
  });
  await copyFile(path.join(root, "node_modules/@tabler/core/dist/css/tabler.min.css"),
    path.join(staging, "apps/host/dashboard/tabler.css"));

  await build({ entryPoints: [path.join(root, "apps/host/dashboard/workbench.js")],
    outfile: path.join(staging, "apps/host/dashboard/workbench.bundle.js"), bundle: true,
    format: "esm", platform: "browser", target: "es2022" });

  async function resources(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await resources(file);
      else if (/\.(md|json)$/.test(entry.name)) {
        await mkdir(path.dirname(path.join(staging, file)), { recursive: true });
        await copyFile(path.join(root, file), path.join(staging, file));
      }
    }
  }
  await resources("packages/agents/src");
  await resources("packages/prompts/resources");
  await resources("schemas");

  for (const name of ["apps", "packages", "tests", "schemas", "agent/src", "agent/tests"])
    await publishTree(path.join(staging, name), path.join(root, "dist", name));

  await run("node", ["scripts/build-agent.mjs"]);
} finally {
  await rm(staging, { recursive: true, force: true });
}
