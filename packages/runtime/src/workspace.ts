import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { internalPath } from "@eval/data";

export async function createRunWorkspace(run: string, debug: boolean) {
  const directory = debug ? internalPath(run) : await mkdtemp(path.join(tmpdir(), "eval-run-"));
  return {
    directory,
    async close() {
      if (!debug) await rm(directory, { recursive: true, force: true });
    },
  };
}
