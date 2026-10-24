import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AutomationJob } from "@eval/automations";
import type { InputDownload, RemoteDay } from "@eval/contracts";
import { completeInputMetadata, readCaseMetadata, replaceInputSnapshot, waitForRunLock } from "@eval/data";
import type { RemoteInputs } from "@eval/runtime/client";

/** Transfer while the old snapshot is in use; promote only after its consumers finish. */
export async function syncRemoteInputs(
  remote: RemoteInputs, directory: string, output: string, job: AutomationJob, day: RemoteDay,
  signal: AbortSignal, beforeReplace: () => Promise<void>,
) {
  const locks: (() => Promise<void>)[] = [];
  const metadata = await readCaseMetadata(path.join(directory, "..", "case-meta.jsonl"));
  async function* files(): AsyncGenerator<() => Promise<InputDownload>> {
    for (const model of remote.models) yield () => remote.download(day, model, signal);
  }
  try {
    return await replaceInputSnapshot(directory, files(), signal, async () => {
      while (job.evaluation === "evaluating")
        await delay(100, undefined, { signal });
      signal.throwIfAborted();
      await beforeReplace();
      locks.push(await waitForRunLock(path.join(directory, ".snapshot"), signal));
      for (const runId of job.runIds) locks.push(await waitForRunLock(path.join(output, runId), signal));
    }, async file => {
      await completeInputMetadata(file, metadata, signal);
    });
  } finally { for (const unlock of locks.reverse()) await unlock(); }
}
