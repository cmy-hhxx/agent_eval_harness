import path from "node:path";
import { localFiles, exists } from "./files.js";

/** Public run artifacts only: no state, inputs, credentials, locks or debug materials. */
export async function listRunArtifacts(run: string) {
  const names: string[] = [];
  for (const name of ["report.md", "task_summaries.md", "stats.json"]) if (await exists(path.join(run,name))) names.push(name);
  const results = path.join(run,"results");
  if (await exists(results)) for (const entry of await localFiles.list(results,{withFileTypes:true})) {
    if (entry.isFile() && /^[\w.-]+\.jsonl(?:\.gz)?$/.test(entry.name)) names.push("results/"+entry.name);
  }
  return Promise.all(names.sort().map(async name => {
    const stat = await localFiles.stat(path.join(run,name));
    return {name,bytes:stat.size,modified_at:stat.mtimeMs};
  }));
}
