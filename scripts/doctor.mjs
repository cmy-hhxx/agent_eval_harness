import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root, upstream, treeHash, buildHash, exists } from "./lib.mjs";

let failures = 0;
for (const [command, args, expected] of [
  ["node", ["--version"], "v24.14.1"],
  ["npm", ["--version"], "11.11.0"],
  ["uv", ["--version"], "uv 0.9.27"],
]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const actual = result.stdout?.trim();
  if (result.status !== 0 || !actual?.startsWith(expected)) {
    failures++;
    console.error(`${command}: expected ${expected}, got ${actual || result.error}`);
  } else console.log(`${command}: ${actual}`);
}
for (const [engine, item] of Object.entries(upstream)) {
  try {
    const stamp = JSON.parse(await readFile(path.join(root, ".runtime", `${engine}.json`), "utf8"));
    const directory = path.join(root, item.directory);
    if (stamp.sourceDigest !== (await treeHash(directory)))
      throw new Error("source changed; rebuild this engine");
    if (stamp.buildDigest !== (await buildHash(directory)))
      throw new Error("built SDK changed; rebuild this engine");
    const sdk = await import(pathToFileURL(path.join(directory, "packages/coding-agent/dist/index.js")).href);
    if (typeof sdk.createAgentSession !== "function") throw new Error("SDK entrypoint unavailable");
    console.log(`${engine}: ${item.version} ${item.commit} SDK ready`);
  } catch (error) {
    failures++;
    console.error(`${engine}: ${error.message}`);
  }
}
const python = process.env.EVAL_PYTHON || path.join(root, ".venv/bin/python");
const py = spawnSync(python, ["--version"], { encoding: "utf8" });
if (py.status !== 0 || !py.stdout.includes("3.12.12")) {
  failures++;
  console.error("Python 3.12.12 required; set EVAL_PYTHON or create .venv with uv.");
} else console.log(py.stdout.trim());
if (!(await exists(path.join(root, "dist/apps/host/src/cli.js")))) {
  failures++;
  console.error("Host not built; run npm run build:app");
}
const runtime = spawnSync(
  path.join(root, ".runtime/prime-python/bin/python"),
  ["-c", "import rlm; assert callable(rlm.create_session)"],
  { encoding: "utf8" },
);
if (runtime.status !== 0) {
  failures++;
  console.error("Prime Python runtime missing; run npm run bootstrap.");
} else console.log("Prime Python runtime: ready (independent .runtime/prime-python)");
try {
  const { loadConfig } = await import(
    pathToFileURL(path.join(root, "dist/packages/pairwise-eval/src/input.js")).href
  );
  const { createRegistry } = await import(
    pathToFileURL(path.join(root, "dist/packages/tools/src/index.js")).href
  );
  const config = await loadConfig(process.argv[2] || path.join(root, "configs/host.json"));
  console.log(
    `Model configuration: ${config.judge.provider}, ${config.judge.api}; tools: ${createRegistry().names().join(", ")}`,
  );
  if (!process.env[config.judge.apiKeyEnv])
    console.log(`Model credential ${config.judge.apiKeyEnv} is not loaded (only required for run).`);
} catch (error) {
  failures++;
  console.error(`Configuration: ${error.message}`);
}
process.exitCode = failures ? 2 : 0;
