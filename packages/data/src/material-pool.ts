import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { writeJson } from "./files.js";

interface Entry {
  directory: string;
  controller: AbortController;
  users: number;
  ready: Promise<{ value: unknown; file: string }>;
}

/** Share immutable input preparation only while a Worker pool has active users. */
export class MaterialPool {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly directory: string) {}

  async acquire(key: string, load: (signal: AbortSignal) => Promise<{ value: unknown; display: unknown }>, signal: AbortSignal) {
    signal.throwIfAborted();
    let entry = this.entries.get(key);
    if (!entry) {
      const directory = path.join(this.directory, randomUUID()), controller = new AbortController();
      const ready = (async () => {
        const { value, display } = await load(controller.signal);
        controller.signal.throwIfAborted();
        await mkdir(directory, { recursive: true });
        const file = path.join(directory, "input.json");
        await writeJson(file, display);
        return { value, file };
      })();
      entry = { directory, controller, users: 0, ready };
      this.entries.set(key, entry);
    }
    const selected = entry;
    selected.users++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (--selected.users) return;
      if (this.entries.get(key) === selected) this.entries.delete(key);
      selected.controller.abort();
      await selected.ready.catch(() => {});
      await rm(selected.directory, { recursive: true, force: true });
    };
    let aborted: () => void = () => {};
    try {
      const material = await Promise.race([selected.ready, new Promise<never>((_, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
      })]);
      signal.throwIfAborted();
      return { value: material.value, release,
        // Never hard-link or symlink a writable session file to the shared material.
        copyTo: (file: string) => copyFile(material.file, file, constants.COPYFILE_FICLONE) };
    } catch (error) { await release(); throw error; }
    finally { signal.removeEventListener("abort", aborted); }
  }
}
