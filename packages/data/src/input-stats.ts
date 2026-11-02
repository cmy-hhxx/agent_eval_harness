import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import { errorText, HttpError } from "@eval/contracts";
import { localFiles, readJson, writeJson } from "./files.js";

interface FileStats { bytes: number; mtimeMs: number; records: number; checkedAt: string; }
export interface DirectoryStats { files: number; records: number; bytes: number; pendingFiles: number; checkedAt: string; }
interface StatsIndex {
  updatedAt: string | null;
  files: Record<string, FileStats>;
  directories: Record<string, DirectoryStats>;
  errors: { path: string; reason: string }[];
}
const inside = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const visible = (name: string) => !name.startsWith(".") || name === ".archive";

/** Counts nonempty JSONL lines without parsing or retaining input bodies. */
async function countRecords(file: string, signal: AbortSignal) {
  const stream = localFiles.stream(file, { highWaterMark: 8 * 1024 * 1024, signal });
  let records = 0, content = false, first = true;
  try {
    for await (const value of stream) {
      signal.throwIfAborted();
      let chunk = value as Buffer;
      if (first && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) chunk = chunk.subarray(3);
      first = false;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
        if (!content) for (let i = offset; i < end; i++) if (![9, 13, 32].includes(chunk[i])) { content = true; break; }
        if (newline < 0) break;
        if (content) records++;
        content = false; offset = newline + 1;
      }
    }
    return records + Number(content);
  } finally { stream.destroy(); }
}

/** Thin input statistics only; never a cache of evaluation inputs or judgments. */
export class InputDirectoryStats {
  private data: StatsIndex = { updatedAt: null, files: {}, directories: {}, errors: [] };
  private pending?: Promise<void>;
  private readonly stop = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private failure?: string;
  constructor(private readonly file: string, private readonly roots: string[]) {}

  async initialize() {
    try {
      const data = await readJson<StatsIndex>(this.file);
      if (!data || !data.files || !data.directories || !Array.isArray(data.errors) ||
          data.updatedAt !== null && typeof data.updatedAt !== "string") throw new Error("Invalid eval_input statistics index");
      this.data = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  start(onError: (error: unknown) => unknown) {
    const update = () => { void this.refresh().catch(error => { if (!this.stop.signal.aborted) return onError(error); }); };
    update();
    this.timer = setInterval(update, 60 * 60 * 1000); this.timer.unref();
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.scan().catch(error => { this.failure = errorText(error); throw error; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async scan() {
    const seenFiles = new Set<string>(), seenDirectories = new Set<string>();
    const errors: StatsIndex["errors"] = [];
    const changed: { file: string; bytes: number; mtimeMs: number }[] = [];
    let lastSave = 0;
    const saveProgress = async () => {
      if (Date.now() - lastSave < 10_000) return;
      this.data.errors = errors; await writeJson(this.file, this.data); lastSave = Date.now();
    };
    const visit = async (directory: string): Promise<DirectoryStats> => {
      if (seenDirectories.has(directory)) return this.data.directories[directory];
      this.stop.signal.throwIfAborted(); seenDirectories.add(directory);
      const totals: DirectoryStats = { files: 0, records: 0, bytes: 0, pendingFiles: 0, checkedAt: new Date().toISOString() };
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          this.stop.signal.throwIfAborted();
          if (!visible(entry.name)) continue;
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            const child = await visit(file);
            for (const key of ["files", "records", "bytes", "pendingFiles"] as const) totals[key] += child[key];
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            totals.files++; seenFiles.add(file);
            try {
              const before = await stat(file); totals.bytes += before.size;
              const known = this.data.files[file];
              if (known && known.bytes === before.size && known.mtimeMs === before.mtimeMs) totals.records += known.records;
              else {
                delete this.data.files[file]; totals.pendingFiles++;
                changed.push({ file, bytes: before.size, mtimeMs: before.mtimeMs });
              }
            } catch (error) {
              this.stop.signal.throwIfAborted(); delete this.data.files[file]; totals.pendingFiles++;
              errors.push({ path: file, reason: errorText(error) });
            }
          }
        }
      } catch (error) {
        this.stop.signal.throwIfAborted(); totals.pendingFiles++;
        errors.push({ path: directory, reason: errorText(error) });
      }
      totals.checkedAt = new Date().toISOString(); this.data.directories[directory] = totals;
      return totals;
    };
    const roots: string[] = [];
    for (const source of this.roots) {
      try { roots.push(await realpath(source)); }
      catch (error) { errors.push({ path: source, reason: errorText(error) }); }
    }
    const unique = [...new Set(roots)];
    for (const root of unique) await visit(root);
    for (const file of Object.keys(this.data.files)) if (!seenFiles.has(file)) delete this.data.files[file];
    for (const directory of Object.keys(this.data.directories)) if (!seenDirectories.has(directory)) delete this.data.directories[directory];
    // Publish the cheap inventory first, so huge first-time scans never present unknown file counts.
    await saveProgress();
    for (const item of changed) {
      this.stop.signal.throwIfAborted();
      try {
        const records = await countRecords(item.file, this.stop.signal), after = await stat(item.file);
        if (after.size !== item.bytes || after.mtimeMs !== item.mtimeMs) throw new Error("统计时文件发生变化，将在下一轮重试");
        const checkedAt = new Date().toISOString();
        this.data.files[item.file] = { bytes: after.size, mtimeMs: after.mtimeMs, records, checkedAt };
        for (let directory = path.dirname(item.file); seenDirectories.has(directory); directory = path.dirname(directory)) {
          const totals = this.data.directories[directory];
          totals.records += records; totals.pendingFiles--; totals.checkedAt = checkedAt;
          if (path.dirname(directory) === directory) break;
        }
      } catch (error) {
        this.stop.signal.throwIfAborted(); errors.push({ path: item.file, reason: errorText(error) });
      }
      await saveProgress();
    }
    this.data.updatedAt = new Date().toISOString(); this.data.errors = errors; this.failure = undefined;
    await writeJson(this.file, this.data);
  }

  async browse(allowedRoots: string[], requested?: string, input = true) {
    const roots: string[] = [], unavailable: { path: string; reason: string }[] = [];
    for (const root of allowedRoots) {
      try { const actual = await realpath(root); if (!roots.includes(actual)) roots.push(actual); }
      catch (error) { unavailable.push({ path: root, reason: errorText(error) }); }
    }
    const item = (file: string) => ({ name: path.basename(file), path: file,
      ...(input ? { stats: this.data.directories[file] } : {}) });
    if (requested === undefined) return { path: null, parent: null, directories: roots.map(item),
      refreshing: !!this.pending, updatedAt: this.data.updatedAt, error: this.failure, unavailable };
    if (!path.isAbsolute(requested)) throw new HttpError(400, "目录须为绝对路径");
    const directory = await realpath(requested);
    if (!roots.some(root => inside(directory, root))) throw new HttpError(403, "目录不在预设允许的范围内");
    const directories = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && visible(entry.name)).map(entry => item(path.join(directory, entry.name)))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    const parent = path.dirname(directory);
    return { path: directory, parent: parent !== directory && roots.some(root => inside(parent, root)) ? parent : null,
      stats: input ? this.data.directories[directory] : undefined, directories,
      refreshing: !!this.pending, updatedAt: this.data.updatedAt, error: this.failure, unavailable };
  }
  async close() {
    clearInterval(this.timer); this.stop.abort(new Error("输入统计已停止"));
    await this.pending?.catch(() => {});
  }
}
