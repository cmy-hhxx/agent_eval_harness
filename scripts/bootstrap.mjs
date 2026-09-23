import { root, upstream, run } from "./lib.mjs";
import path from "node:path";

await run("npm", ["ci", "--ignore-scripts"]);
for (const item of Object.values(upstream))
  await run("npm", ["ci", "--ignore-scripts"], path.join(root, item.directory));
await run("uv", ["sync", "--locked", "--python", "3.12.12"]);
process.env.UV_PROJECT_ENVIRONMENT = path.join(root, ".runtime/prime-python");
await run(
  "uv",
  ["sync", "--locked", "--python", "3.12.12"],
  path.join(root, "vendor/prime-agent/prime-agent-runtime"),
);
console.log("Dependencies installed from independent lockfiles. Run npm run build.");
