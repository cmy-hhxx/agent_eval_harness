import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const upstream = JSON.parse(await readFile(path.join(root, "vendor/upstream.json"), "utf8"));
export function run(command, args, cwd = root, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        HUSKY: "0",
        npm_config_cache: path.join(root, ".cache/npm"),
        UV_CACHE_DIR: path.join(root, ".cache/uv"),
        ...extraEnv,
      },
    });
    proc.once("error", reject);
    proc.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}
const ignored = new Set([
  ".git",
  "node_modules",
  "dist",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".cache",
  ".artifacts",
  "build",
  ".DS_Store",
]);
export async function treeHash(directory) {
  const hash = createHash("sha256");
  async function walk(relative) {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      if (ignored.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile())
        hash.update(file.split(path.sep).join("/") + "\0").update(await readFile(path.join(directory, file)));
    }
  }
  await walk("");
  return hash.digest("hex");
}
export async function exists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}
export async function buildHash(directory) {
  const hash = createHash("sha256");
  for (const name of (await readdir(path.join(directory, "packages"))).sort()) {
    const built = path.join(directory, "packages", name, "dist");
    if (await exists(built)) hash.update(name + "\0" + (await treeHash(built)));
  }
  return hash.digest("hex");
}
