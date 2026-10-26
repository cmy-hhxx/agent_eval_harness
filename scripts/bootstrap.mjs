import { root, upstream, run } from "./lib.mjs";
import path from "node:path";
import { applyAgentDependencyPatches } from "./apply-agent-dependency-patches.mjs";

await run("npm", ["ci", "--ignore-scripts"]);
await applyAgentDependencyPatches();
await run("npm", ["ci", "--ignore-scripts"], path.join(root, upstream.pi.directory));

await run("uv", ["venv", "--allow-existing", "--python", "3.12.12", path.join(root, ".venv")]);
console.log("Dependencies installed. Run npm run build.");
