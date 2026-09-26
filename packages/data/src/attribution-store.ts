import path from "node:path";
import { safeId, type AttributionLibrary, type AttributionTarget } from "@eval/contracts";
import { exists, readJson, writeJson } from "./files.js";

/**
 * Versioned layout is reserved: `tree_version` > 1 writes `<path>/<model>/<tree_version>.json`,
 * keeping the per-version history alongside the v1 file.
 */
export function attributionLibraryFile(
  target: AttributionTarget,
  model: string,
  treeVersion = 1,
): string {
  return treeVersion <= 1
    ? path.join(target.path, `${safeId(model)}.json`)
    : path.join(target.path, safeId(model), `${treeVersion}.json`);
}

export async function readAttributionLibrary(file: string): Promise<AttributionLibrary | undefined> {
  return (await exists(file)) ? readJson<AttributionLibrary>(file) : undefined;
}

export async function writeAttributionLibrary(
  file: string,
  library: AttributionLibrary,
): Promise<void> {
  await writeJson(file, library);
}
