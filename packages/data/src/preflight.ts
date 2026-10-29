import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hasLiveRunOwner } from "./files.js";

/** Probe the actual filesystem and lock without claiming a run or retaining artifacts. */
export async function preflightPaths(directories: string[], run?: string) {
  const failures: { path: string; reason: string }[] = [];
  for (const directory of new Set(directories.map(value => path.resolve(value)))) {
    const probe = path.join(directory, ".preflight-" + randomUUID());
    try {
      await mkdir(directory, { recursive: true });
      const handle = await open(probe, "wx");
      try { await handle.writeFile("preflight\n"); await handle.sync(); } finally { await handle.close(); }
    } catch (error) { failures.push({ path: directory, reason: error instanceof Error ? error.message : String(error) }); }
    finally { await rm(probe, { force: true }).catch(() => {}); }
  }
  if (run) {
    try { if (await hasLiveRunOwner(run)) failures.push({ path: run, reason: "Run already has a live owner" }); }
    catch (error) { failures.push({ path: run, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return failures;
}
