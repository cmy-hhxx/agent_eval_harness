import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { root, upstream, run, treeHash, buildHash } from "./lib.mjs";

const selected = process.argv[2];
if (selected && !upstream[selected]) throw new Error("Expected pi or prime");
for (const [engine, item] of Object.entries(upstream)) {
  if (selected && selected !== engine) continue;
  const directory = path.join(root, item.directory);
  if (engine === "pi")
    await cp(
      path.join(root, "vendor/pi-model-data"),
      path.join(directory, "packages/ai/src/providers/data"),
      { recursive: true },
    );
  await run("npm", ["run", engine === "pi" ? "build:offline" : "build"], directory);
  const sourceDigest = await treeHash(directory);
  const buildDigest = await buildHash(directory);
  await mkdir(path.join(root, ".runtime"), { recursive: true });
  await writeFile(
    path.join(root, ".runtime", `${engine}.json`),
    JSON.stringify({ engine, ...item, sourceDigest, buildDigest }, null, 2) + "\n",
  );
}
if (selected) await run("node", ["node_modules/typescript/bin/tsc", "-p", `tsconfig.${selected}.json`]);
else await run("npm", ["run", "build:app"]);
