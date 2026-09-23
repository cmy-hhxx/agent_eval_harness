import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Engine, EngineIdentity } from "../../contracts/src/index.js";
import { ROOT, exists, readJson } from "../../contracts/src/io.js";

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
export async function treeHash(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(relative: string): Promise<void> {
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
export async function loadIdentity(engine: Engine): Promise<EngineIdentity> {
  const stamp = await readJson<EngineIdentity & { directory: string }>(
    path.join(ROOT, ".runtime", `${engine}.json`),
  );
  const directory = path.join(ROOT, stamp.directory);
  const hash = createHash("sha256");
  for (const name of (await readdir(path.join(directory, "packages"))).sort()) {
    const built = path.join(directory, "packages", name, "dist");
    if (await exists(built)) hash.update(name + "\0" + (await treeHash(built)));
  }
  if (stamp.sourceDigest !== (await treeHash(directory)) || stamp.buildDigest !== hash.digest("hex"))
    throw new Error(`${engine} source or build changed; run npm run build --workspace @eval/agent-${engine}`);
  const { version, commit, sourceDigest, buildDigest } = stamp;
  return { engine, version, commit, sourceDigest, buildDigest };
}
