import path from "node:path";
import type { Engine, EngineIdentity } from "../../contracts/src/index.js";
import { ROOT, exists, readJson } from "../../contracts/src/io.js";

export async function loadIdentity(engine: Engine): Promise<EngineIdentity> {
  const stamp = await readJson<EngineIdentity & { directory: string }>(path.join(ROOT, ".runtime", engine + ".json"));
  const upstream = await readJson<Record<Engine, { version: string; commit: string }>>(path.join(ROOT, "vendor/upstream.json"));
  if (!stamp.buildId || stamp.version !== upstream[engine].version || stamp.commit !== upstream[engine].commit ||
      !await exists(path.join(ROOT, stamp.directory, "packages/coding-agent/dist/index.js")))
    throw new Error(engine + " build unavailable; rebuild this engine");
  const { version, commit, buildId } = stamp;
  return { engine, version, commit, buildId };
}
