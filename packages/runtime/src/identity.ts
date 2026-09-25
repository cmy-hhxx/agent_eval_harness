import path from "node:path";
import type { Engine, EngineIdentity } from "@eval/contracts";
import { exists, readJson } from "@eval/data";

export async function loadIdentity(engine: Engine, root: string): Promise<EngineIdentity> {
  const stamp = await readJson<EngineIdentity & { directory: string }>(
    path.join(root, ".runtime", engine + ".json"),
  );
  const upstream = await readJson<Record<Engine, { version: string; commit: string }>>(
    path.join(root, "vendor/upstream.json"),
  );
  if (
    !stamp.buildId ||
    stamp.version !== upstream[engine].version ||
    stamp.commit !== upstream[engine].commit ||
    !(await exists(path.join(root, stamp.directory, "packages/coding-agent/dist/index.js")))
  )
    throw new Error(engine + " build unavailable; rebuild this engine");
  const { version, commit, buildId } = stamp;
  return { engine, version, commit, buildId };
}
