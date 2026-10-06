import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
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
export async function exists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}
async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files;
}
async function pruneEmptyDirectories(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries)
    if (entry.isDirectory()) await pruneEmptyDirectories(path.join(directory, entry.name));
  if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
}
// Replace a managed tree in place. New files are moved over their previous
// versions one by one, so an entry file never disappears while a build runs;
// obsolete files are removed only after every replacement is in place.
export async function publishTree(source, destination) {
  let files;
  try {
    files = await listFiles(source);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await rm(destination, { recursive: true, force: true });
    return;
  }
  for (const file of files) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(path.join(source, file), target);
  }
  const published = new Set(files);
  const existing = await listFiles(destination).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of existing) {
    if (!published.has(file)) await rm(path.join(destination, file), { force: true });
  }
  await pruneEmptyDirectories(destination);
}
