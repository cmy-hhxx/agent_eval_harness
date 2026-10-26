import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { root, upstream, exists } from "./lib.mjs";

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
for (const [engine, item] of Object.entries(upstream).filter(([name]) => name === "pi")) {
  try {
    const stamp = JSON.parse(await readFile(path.join(root, ".runtime", `${engine}.json`), "utf8"));
    const directory = path.join(root, item.directory);
    if (!stamp.buildId || stamp.version !== item.version || stamp.commit !== item.commit)
      throw new Error("build version changed; rebuild this engine");
    const sdk = await import(pathToFileURL(path.join(directory, "packages/coding-agent/dist/index.js")).href);
    if (typeof sdk.createAgentSession !== "function") throw new Error("SDK entrypoint unavailable");
    console.log(`${engine}: ${item.version} ${item.commit} SDK ready`);
  } catch (error) {
    failures++;
    console.error(`${engine}: ${error.message}`);
  }
}
try {
  const { readSettings, applySettings } = await import("@eval/host-app/settings");
  applySettings(await readSettings());
} catch (error) { failures++; console.error(`Configuration: ${error.message}`); }
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
try {
  const { boundProfiles, loadConfig } = await import("@eval/host-app/config");
  const { createRegistry } = await import("@eval/tools");
  const paths = process.argv.slice(2);
  const host = await loadConfig(paths.length ? paths : [path.join(root, "configs/host.json")]);
  const models = Object.entries(host.models.models)
    .map(([name, profile]) => `${name}:${profile.model || "<unset>"}`)
    .join(", ");
  const bindings = Object.entries(host.models.bindings)
    .map(([stage, binding]) => `${stage}->${binding.profile}`)
    .join(", ");
  console.log(`Models: ${models}; bindings: ${bindings}; tools: ${createRegistry().names().join(", ")}`);
  for (const profile of boundProfiles(host.models))
    if (!process.env[profile.apiKeyEnv])
      console.log(`Model credential ${profile.apiKeyEnv} is not loaded (only required for run).`);
} catch (error) {
  failures++;
  console.error(`Configuration: ${error.message}`);
}
process.exitCode = failures ? 2 : 0;
