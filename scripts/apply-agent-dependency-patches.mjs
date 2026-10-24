import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { root } from "./lib.mjs";

const execute = promisify(execFile);

/** Apply the selected upstream dependency patches to their exact installed versions. */
export async function applyAgentDependencyPatches(directory = root) {
  const vendor = path.join(directory, "vendor/deepseek");
  const { dependencyPatches } = JSON.parse(await readFile(path.join(vendor, "sources.json"), "utf8"));
  if (!Array.isArray(dependencyPatches)) throw new Error("Missing DeepSeek dependencyPatches array");
  for (const { package: name, version, file } of dependencyPatches) {
    const installed = await realpath(path.join(directory, "node_modules", name));
    const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== version)
      throw new Error(`Dependency patch requires ${name}@${version}; installed ${manifest.name}@${manifest.version}`);
    const patch = path.join(vendor, file);
    // Without this ceiling, Git finds the checkout above node_modules and
    // silently skips package-relative paths while returning success.
    const options = { cwd: installed, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(installed) } };
    let forward;
    try { await execute("git", ["apply", "--check", patch], options); }
    catch (error) {
      if (typeof error.code !== "number") throw error;
      forward = error;
    }
    if (!forward) { await execute("git", ["apply", patch], options); continue; }
    try { await execute("git", ["apply", "--check", "--reverse", patch], options); }
    catch (error) {
      throw new Error(`Dependency patch does not match ${name}@${version}: ${forward.stderr || forward.message}`, { cause: error });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await applyAgentDependencyPatches();
