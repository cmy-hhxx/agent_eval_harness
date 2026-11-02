import path from "node:path";
import { open, readdir, stat } from "node:fs/promises";
import { canonical, safeId, type JsonObject, type ResultReference } from "@eval/contracts";
import { appendJsonl, atomicWrite, exists, readJson, readJsonl, readJsonlText, runLock } from "./files.js";
import { fileSourceReader, waitForRunLock } from "./sources.js";

/** Input coordinates and persistent answer identity; never a copy of the input body. */
export interface BusinessAnswer {
  id: string;
  batch: string;
  caseId: string;
  model: string;
  session: string | null;
  traces: (string | null)[];
  source: string;
  line: number;
  revision?: string;
}
export interface BusinessResult {
  id: string;
  date: string;
  file: string;
  line: number;
  stage: string;
  scope: unknown;
  answers: BusinessAnswer[];
  acceptedAt: number;
  evaluatorVersion: string;
  judge: string;
  submissionId: string;
  complete: boolean;
  published: boolean;
  origin: { run: string; taskId: string; reference: ResultReference & { line: number } };
}

/** A business batch is already a calendar date. No timestamp parsing or timezone conversion. */
export function businessDate(batch: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(batch);
  if (!match) throw new Error("业务批次缺少明确的 YYYY-MM-DD 日期：" + batch);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new Error("无效业务日期：" + batch);
  return batch;
}
function destination(root: string, value: Pick<BusinessResult, "date" | "file">) {
  businessDate(value.date);
  const parts = value.file.split("/");
  for (const part of parts) safeId(part);
  if (!value.file.endsWith(".jsonl")) throw new Error("正式交付必须是 JSONL");
  return path.join(root, ...parts);
}
function validate(value: BusinessResult) {
  destination(".", value);
  if (!value.id || !value.stage || !Number.isSafeInteger(value.line) || value.line < 1 ||
      !Number.isFinite(value.acceptedAt) || value.acceptedAt <= 0 || !value.evaluatorVersion || !value.judge || !value.submissionId ||
      typeof value.complete !== "boolean" || typeof value.published !== "boolean" || !Array.isArray(value.answers) || !value.origin?.run ||
      !value.origin.taskId || !Number.isSafeInteger(value.origin.reference?.line) || value.origin.reference.line < 1)
    throw new Error("正式结果溯源索引无效");
  safeId(value.origin.reference.file!);
  for (const answer of value.answers)
    if (!answer.id || answer.batch !== value.date || !answer.model || !answer.caseId || !answer.source ||
        !Number.isSafeInteger(answer.line) || answer.line < 1 || !Array.isArray(answer.traces))
      throw new Error("正式结果回答身份无效");
}
export async function readBusinessResults(root: string): Promise<BusinessResult[]> {
  const records: BusinessResult[] = [];
  const directory = path.join(root, ".delivery", "provenance");
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return [];
  })) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (!await exists(file)) continue;
    for await (const value of readJsonl(file)) {
      const record = value as BusinessResult;
      validate(record);
      if (record.date + ".jsonl" !== entry.name) throw new Error("结果索引业务日期与目录不一致");
      records.push(record);
    }
  }
  return records;
}
export async function formalResultLine(run: string, reference: ResultReference, row: JsonObject): Promise<number> {
  const file = path.join(run, "results", safeId(reference.file!));
  let line = 0, found: number | undefined;
  for await (const text of readJsonlText(file)) {
    line++;
    if (reference.line !== undefined && line !== reference.line) continue;
    if (canonical(JSON.parse(text)) !== canonical(row)) {
      if (reference.line === line) throw new Error("收据与正式结果行不一致");
      continue;
    }
    if (found !== undefined) throw new Error("无行号的正式结果存在多份相同正文，无法确认来源");
    found = line;
    if (reference.line !== undefined) break;
  }
  if (found === undefined) throw new Error("收据引用的正式结果缺失");
  return found;
}
export async function readBusinessResultRow(record: BusinessResult): Promise<JsonObject> {
  validate(record);
  const file = path.join(record.origin.run, "results", safeId(record.origin.reference.file!));
  let line = 0;
  for await (const text of readJsonlText(file)) if (++line === record.origin.reference.line) return JSON.parse(text);
  throw new Error("正式结果来源行缺失：" + file);
}
/** Existing run ledgers are read only, including explicitly chosen older run deliveries. */
export async function businessRunDirectories(root: string): Promise<string[]> {
  const runs: string[] = [];
  for (const directory of [root, path.join(root, ".runs")]) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return [];
    })) if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const run = path.join(directory, entry.name);
      if (await exists(path.join(run, "state.json"))) runs.push(run);
    }
  }
  return [...new Set(runs)].sort();
}
export async function sourcePredatesAcceptance(file: string, acceptedAt: number): Promise<boolean> {
  return (await stat(file)).mtimeMs <= acceptedAt;
}
export async function runCheckpointPrefix(run: string): Promise<string> {
  const handle = await open(path.join(run, "state.json"), "r");
  try { const bytes = Buffer.alloc(4096), result = await handle.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, result.bytesRead).toString("utf8"); }
  finally { await handle.close(); }
}
/** Existing organization manifests map source result lines, never evaluation times or input identities. */
export async function organizedResultLines(run: string) {
  const file = path.join(run, "organization.json"), result = new Map<string, Map<string, number>>();
  if (!await exists(file)) return result;
  const value = await readJson<{ files?: { artifact: string; relative: string; rows: number; source_lines: number[] }[] }>(file);
  if (!Array.isArray(value.files)) throw new Error("整理清单缺少 files");
  for (const entry of value.files) {
    safeId(entry.artifact);
    for (const part of entry.relative.split("/")) safeId(part);
    if (!Array.isArray(entry.source_lines) || entry.rows !== entry.source_lines.length ||
        entry.source_lines.some(line => !Number.isSafeInteger(line) || line < 1) || new Set(entry.source_lines).size !== entry.rows)
      throw new Error("整理清单来源行无效");
    entry.source_lines.forEach((line, index) => {
      const key = canonical([entry.artifact, line]), destinations = result.get(key) ?? new Map<string, number>();
      if (destinations.has(entry.relative)) throw new Error("整理清单重复来源行");
      destinations.set(entry.relative, index + 1); result.set(key, destinations);
    });
  }
  return result;
}
/** Enumerate only formal attribution files, excluding giant journals and private run material. */
export async function formalAttributionFiles(root: string, models: readonly string[]) {
  const files: string[] = [];
  for (const model of models) safeId(model);
  const visit = async (directory: string, depth: number) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return [];
    })) {
      if (entry.name.startsWith(".") || entry.name === "_internal") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) await visit(file, depth + 1);
      else if (entry.isFile() && (entry.name === "attribution.jsonl" && path.basename(directory) === "results" ||
        models.some(model => path.basename(directory) === model && entry.name.startsWith(model + "_attribution-") &&
          /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name.slice(model.length + "_attribution-".length))))) files.push(file);
    }
  };
  await visit(root, 0);
  return files.sort();
}
export async function claimBusinessPartitions(root: string, partitions: { date: string; model: string }[]) {
  const unlocks: (() => Promise<void>)[] = [], blocked = new Set<string>();
  try {
    const keys = [...new Set(partitions.map(value => canonical([businessDate(value.date), safeId(value.model)])))].sort();
    for (const key of keys) {
      const [date, model] = JSON.parse(key) as string[];
      try { unlocks.push(await runLock(path.join(root, ".delivery", "claims", date, model))); }
      catch (error) {
        if (!(error instanceof Error) || !/^(Run already owned|Run lock recovery|Could not acquire run lock)/.test(error.message)) throw error;
        blocked.add(key);
      }
    }
    return { blocked, close: async () => { for (const unlock of unlocks.reverse()) await unlock(); } };
  } catch (error) { for (const unlock of unlocks.reverse()) await unlock(); throw error; }
}

const publicationQueues = new Map<string, Promise<void>>();

/** runLock only excludes other processes; same-process runs must queue fairly behind one publisher. */
async function queuePublication(root: string): Promise<() => void> {
  const previous = publicationQueues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  publicationQueues.set(root, tail);
  await previous;
  return () => {
    release();
    if (publicationQueues.get(root) === tail) publicationQueues.delete(root);
  };
}

export interface BusinessPublication {
  record: Omit<BusinessResult, "line" | "published">;
  row: JsonObject;
  refresh?: boolean;
  existingLine?: number;
}
type FileView = { revision: string; bytes: number; spans: Map<number, { offset: number; bytes: number }> };

/** The public view is recoverable from immutable formal rows and its provenance journal. */
export function createBusinessPublisher(root: string) {
  const cache = new Map<string, { revision: string; records: BusinessResult[] }>();
  const views = new Map<string, FileView>();
  const view = async (file: string) => {
    if (!await exists(file)) return undefined;
    const revision = await fileSourceReader.revision(file), previous = views.get(file);
    if (previous?.revision === revision) return previous;
    const spans = new Map<number, { offset: number; bytes: number }>();
    for await (const line of fileSourceReader.lines(file, revision)) spans.set(line.index, { offset: line.byteOffset, bytes: line.byteLength });
    const bytes = (await stat(file)).size;
    if (bytes && fileSourceReader.record(file, bytes - 1, 1, revision) !== "\n") throw new Error("交付文件存在未完成尾行");
    const current = { revision, bytes, spans }; views.set(file, current); return current;
  };
  /**
   * One delivery date is decided in memory and materialized with one journal append,
   * one append per delivery file, then one published-flag append. The delivery mount
   * charges a full fsync per append, so batching the accepted results of one write is
   * what keeps publication from serializing the whole host behind the lock.
   */
  async function publishDate(entries: readonly BusinessPublication[]) {
    const date = entries[0].record.date;
    const journal = path.join(root, ".delivery", "provenance", date + ".jsonl");
    const revision = async () => stat(journal).then(info => [info.ino, info.size, info.mtimeMs].join(":"), error => {
      if (error.code !== "ENOENT") throw error;
      return "missing";
    });
    let saved = cache.get(date);
    if (!saved || saved.revision !== await revision()) {
      const records: BusinessResult[] = [];
      if (await exists(journal)) for await (const value of readJsonl(journal)) { validate(value as BusinessResult); records.push(value as BusinessResult); }
      saved = { revision: await revision(), records };
      cache.set(date, saved);
    }
    const latest = new Map<string, BusinessResult>();
    for (const item of saved.records) {
      const previous = latest.get(item.id);
      if (!previous || item.complete && !previous.complete || item.complete === previous.complete && item.acceptedAt >= previous.acceptedAt)
        latest.set(item.id, item);
    }
    // Snapshot the indexed lines before this batch claims any new ones.
    const indexed = new Map<string, BusinessResult[]>();
    for (const item of latest.values()) {
      const list = indexed.get(item.file) ?? [];
      list.push(item); indexed.set(item.file, list);
    }
    interface FileState { relative: string; current: FileView | undefined; lines: number; fresh: number;
      rewrite?: Map<number, JsonObject>; appends: { line: number; row: JsonObject }[]; claimed: Set<number> }
    const files = new Map<string, FileState>(), pending: BusinessResult[] = [], released: BusinessResult[] = [];
    for (const entry of entries) {
      const { record, row } = entry;
      const previous = latest.get(record.id);
      if (previous?.complete && !record.complete) continue;
      if (previous && previous.complete === record.complete && previous.acceptedAt > record.acceptedAt) continue;
      const sameOrigin = previous && canonical(previous.origin) === canonical(record.origin);
      if (sameOrigin && previous.published && !entry.refresh && await exists(destination(root, previous))) continue;
      if (previous?.submissionId === record.submissionId && previous.published && !entry.refresh &&
        await exists(path.join(previous.origin.run, "results", previous.origin.reference.file!)) &&
        await exists(destination(root, previous))) continue;
      const relocated = previous && previous.file !== record.file;
      // An unresolved comparison can acquire its unified delivery after presentation
      // completes. Preserve its original file and accepted identity in the journal.
      if (relocated && !(entry.refresh && previous.stage === "comparison" && record.stage === "comparison" &&
        !previous.complete && !record.complete && previous.submissionId === record.submissionId &&
        previous.acceptedAt === record.acceptedAt && previous.evaluatorVersion === record.evaluatorVersion &&
        previous.origin.run === record.origin.run && previous.origin.taskId === record.origin.taskId &&
        canonical(previous.answers) === canonical(record.answers) && canonical(previous.scope) === canonical(record.scope)))
        throw new Error("同一结果身份对应不同交付文件");
      const file = destination(root, record), items = indexed.get(record.file) ?? [];
      let state = files.get(file);
      if (!state) {
        const current = await view(file);
        const lastLine = items.reduce((last, item) => Math.max(last, item.line), 0);
        state = { relative: record.file, current, lines: current?.spans.size ?? lastLine, fresh: 0, appends: [], claimed: new Set() };
        files.set(file, state);
      }
      const current = state.current;
      if (items.length && current && items.some(item => item.line > current.spans.size)) {
        // A crash between journaling a result and appending its row leaves a journaled
        // tail the file never received. Rebuild that tail from the immutable formal rows
        // before the next result claims the next line.
        const missing = items.filter(item => item.line > current.spans.size);
        const lines = new Set(items.map(item => item.line));
        if (missing.some(item => item.published) || lines.size !== items.length || lines.size !== Math.max(...lines))
          throw new Error("交付结果索引缺行，不能补造或删除未索引结果");
        state.lines = Math.max(state.lines, ...lines);
        state.rewrite ??= new Map();
      }
      if (!current) state.rewrite ??= new Map();
      let adopted = false;
      if (!previous && current && entry.existingLine !== undefined) {
        const span = current.spans.get(entry.existingLine);
        if (!span || canonical(JSON.parse(fileSourceReader.record(file, span.offset, span.bytes, current.revision))) !== canonical(row))
          throw new Error("整理清单目标行与原正式结果不一致");
        if (items.some(item => item.line === entry.existingLine && item.id !== record.id) || state.claimed.has(entry.existingLine))
          throw new Error("整理清单目标行已归属其他业务回答");
        adopted = true;
      }
      if ((!previous || relocated) && current && !adopted && items.length + state.fresh !== state.lines)
        throw new Error("已有交付文件缺少可核实的整理映射，暂不追加或覆盖");
      const line = previous && !relocated ? previous.line : adopted ? entry.existingLine! : 1 + state.lines;
      const next = { ...record, line, published: false };
      validate(next);
      if (previous && previous.acceptedAt === next.acceptedAt && !sameOrigin && previous.submissionId !== next.submissionId)
        throw new Error("同一回答的正式结果接受时间相同，无法选定最新判词");
      // Journal first: a crash before publishing is repaired from the original accepted row.
      if (!sameOrigin || canonical(previous) !== canonical(next)) pending.push(next);
      state.claimed.add(line);
      if (!adopted) {
        if (!previous || relocated) state.fresh++;
        if (!state.current || previous || state.rewrite) (state.rewrite ??= new Map()).set(line, row);
        else state.appends.push({ line, row });
        state.lines = Math.max(state.lines, line);
      }
      const published = { ...next, published: true };
      released.push(published);
      latest.set(record.id, published);
    }
    if (pending.length) { await appendJsonl(journal, pending); saved.records.push(...pending); }
    const marks: BusinessResult[] = [];
    for (const [file, state] of files) {
      if (state.rewrite) {
        // Rebuild the file from the immutable rows: replacements, a journaled tail the
        // file never received, and rows still carrying their unpublished index entry.
        const items = new Map([...latest.values()].filter(item => item.file === state.relative).map(item => [item.line, item]));
        const overrides = state.rewrite, spans = new Map<number, { offset: number; bytes: number }>();
        let bytes = 0;
        async function* chunks() {
          let index = 0;
          const chunk = (text: string) => {
            const buffer = Buffer.from(text + "\n");
            spans.set(index, { offset: bytes, bytes: buffer.length - 1 }); bytes += buffer.length; return buffer;
          };
          if (state.current) for await (const text of readJsonlText(file)) {
            index++;
            const override = overrides.get(index), item = items.get(index);
            yield chunk(override ? JSON.stringify(override) : item && !item.published
              ? JSON.stringify(await readBusinessResultRow(item)) : text);
          }
          const end = [...items.keys(), ...overrides.keys()].reduce((last, value) => Math.max(last, value), index);
          while (index < end) {
            const override = overrides.get(++index), item = items.get(index);
            if (!override && !item) throw new Error("交付结果索引缺行，不能补造或删除未索引结果");
            yield chunk(JSON.stringify(override ?? await readBusinessResultRow(item!)));
          }
        }
        await atomicWrite(file, chunks());
        views.set(file, { revision: await fileSourceReader.revision(file), bytes, spans });
        for (const item of latest.values())
          if (item.file === state.relative && !item.published) marks.push({ ...item, published: true });
      } else if (state.appends.length) {
        const count = state.current?.spans.size ?? 0;
        for (const [index, item] of state.appends.entries())
          if (item.line !== count + index + 1) throw new Error("交付结果追加行号不连续");
        await appendJsonl(file, state.appends.map(item => item.row));
        if (state.current) {
          for (const { line, row } of state.appends) {
            state.current.spans.set(line, { offset: state.current.bytes, bytes: Buffer.byteLength(JSON.stringify(row)) });
            state.current.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
          }
          state.current.revision = await fileSourceReader.revision(file);
        }
      }
    }
    if (released.length || marks.length) {
      await appendJsonl(journal, [...released, ...marks]);
      saved.records.push(...released, ...marks);
    }
    saved.revision = await revision();
  }
  const many = async (entries: readonly BusinessPublication[]) => {
    if (!entries.length) return;
    const release = await queuePublication(root);
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await waitForRunLock(path.join(root, ".delivery", "publication"), AbortSignal.timeout(10_000));
      const byDate = new Map<string, BusinessPublication[]>();
      for (const entry of entries) {
        const list = byDate.get(entry.record.date) ?? [];
        list.push(entry); byDate.set(entry.record.date, list);
      }
      for (const list of byDate.values()) await publishDate(list);
    } finally {
      try { await unlock?.(); } finally { release(); }
    }
  };
  const publish = (record: Omit<BusinessResult, "line" | "published">, row: JsonObject, refresh = false, existingLine?: number) =>
    many([{ record, row, refresh, existingLine }]);
  return Object.assign(publish, { many });
}
