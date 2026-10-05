import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { safeId, type ProblemLibrary, type ProblemLibraryTarget } from "@eval/contracts";
import { exists, readJson, runLock, writeJson } from "./files.js";

/** One file per model; clustering rules own classification and explicit review events. */
export function problemLibraryFile(target: ProblemLibraryTarget, model: string): string {
  return path.join(target.path, `${safeId(model)}.json`);
}

export async function readProblemLibrary(file: string): Promise<ProblemLibrary | undefined> {
  return (await exists(file)) ? readJson<ProblemLibrary>(file) : undefined;
}

export async function writeProblemLibrary(file: string, library: ProblemLibrary): Promise<void> {
  await writeJson(file, library);
}

/** Serialize read/modify/write per model, including reports from different run directories. */
export async function withProblemLibraryLock<T>(
  target: ProblemLibraryTarget,
  model: string,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = path.join(target.path, ".locks", safeId(model));
  const deadline = Date.now() + 60_000;
  let release: () => Promise<void>;
  while (true) {
    try {
      release = await runLock(directory);
      break;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("Run already owned by host PID ")) || Date.now() >= deadline)
        throw error;
      await sleep(25);
    }
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}
