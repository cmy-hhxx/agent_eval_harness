import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
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
