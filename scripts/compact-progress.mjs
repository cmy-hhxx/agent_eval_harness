import path from "node:path";
import { compactProgressJournal, localFiles, readJson, readProgressJournal, runLock, runProgressFile } from "@eval/data";

/** Offline maintenance uses the same exclusive run lock and checkpoint boundary as Host. */
export async function compactRunProgress(run) {
  const directory = path.resolve(run), release = await runLock(directory, { createDirectory: false });
  try {
    const saved = await readJson(path.join(directory, "state.json"));
    const checkpoint = saved.workflow === "attribution" ? saved.manifest : saved;
    if (checkpoint.format !== "evaluation-run") throw new Error("Unsupported run checkpoint");
    const sequence = checkpoint.journalSequence ?? 0;
    const size = () => localFiles.stat(runProgressFile(directory)).then(stat => stat.size,
      error => { if (error.code === "ENOENT") return 0; throw error; });
    const before = await size();
    await compactProgressJournal(directory, sequence);
    return { run: directory, checkpoint_sequence: sequence, before_bytes: before, after_bytes: await size(),
      remaining_events: sequence ? (await readProgressJournal(directory, sequence)).length : null };
  } finally { await release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  if (process.argv.length !== 3) throw new Error("node scripts/compact-progress.mjs RUN");
  console.log(JSON.stringify(await compactRunProgress(process.argv[2]), null, 2));
}
