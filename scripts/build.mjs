import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { root, upstream, run } from "./lib.mjs";

const selected = process.argv[2];
if (selected && !["pi", "prime"].includes(selected)) throw new Error("Expected pi or prime");
for (const [engine, item] of Object.entries(upstream).filter(([name]) => name === "pi" || name === "prime")) {
  if (selected && selected !== engine) continue;
  const directory = path.join(root, item.directory);
  await run("npm", ["run", engine === "pi" ? "build:offline" : "build"], directory);
  const buildId = randomUUID();
  await mkdir(path.join(root, ".runtime"), { recursive: true });
  await writeFile(
    path.join(root, ".runtime", `${engine}.json`),
    JSON.stringify({ engine, ...item, buildId }, null, 2) + "\n",
  );
}
if (selected) await run("node", ["node_modules/typescript/bin/tsc", "-p", `tsconfig.${selected}.json`]);
else await run("npm", ["run", "build:app"]);
