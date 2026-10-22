import { root, upstream, run } from "./lib.mjs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

await run("npm", ["ci", "--ignore-scripts"]);
for (const item of [upstream.pi, upstream.prime])
  await run("npm", ["ci", "--ignore-scripts"], path.join(root, item.directory));

await run("uv", ["venv", "--allow-existing", "--python", "3.12.12", path.join(root, ".venv")]);
const primeRuntime = path.join(root, "vendor/prime-agent/prime-agent-runtime");
const primePython = path.join(root, ".runtime/prime-python/bin/python");
await run("uv", ["venv", "--allow-existing", "--python", "3.12.12", path.join(root, ".runtime/prime-python")]);

// Export exact versions from the frozen Prime lock, then install those pins with the
// available pip index. This keeps server bootstrap independent of registry URL layout.
const exported = execFileSync("uv", ["export", "--frozen", "--directory", primeRuntime, "--format", "requirements-txt", "--no-hashes"], {
  cwd: root, encoding: "utf8", env: process.env,
});
const requirements = path.join(root, ".runtime/prime-requirements.txt");
await writeFile(requirements, exported.split(/\r?\n/).filter(line => !line.startsWith("-e ") && !line.startsWith("#")).join("\n") + "\n");
await run(primePython, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", requirements]);
await run(primePython, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-deps", primeRuntime]);
console.log("Dependencies installed from independent lockfiles and pinned Prime export. Run npm run build.");
