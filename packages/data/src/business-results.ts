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

/** The public view is recoverable from immutable formal rows and its provenance journal. */
export function createBusinessPublisher(root: string) {
  const cache = new Map<string, { revision: string; records: BusinessResult[] }>();
  const views = new Map<string, { revision: string; bytes: number; spans: Map<number, { offset: number; bytes: number }> }>();
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
  return async (record: Omit<BusinessResult, "line" | "published">, row: JsonObject, refresh = false, existingLine?: number) => {
    const release = await queuePublication(root);
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await waitForRunLock(path.join(root, ".delivery", "publication"), AbortSignal.timeout(10_000));
      const journal = path.join(root, ".delivery", "provenance", record.date + ".jsonl");
      const revision = async () => stat(journal).then(info => [info.ino, info.size, info.mtimeMs].join(":"), error => {
        if (error.code !== "ENOENT") throw error;
        return "missing";
      });
      let saved = cache.get(record.date);
      if (!saved || saved.revision !== await revision()) {
        const records: BusinessResult[] = [];
        if (await exists(journal)) for await (const value of readJsonl(journal)) { validate(value as BusinessResult); records.push(value as BusinessResult); }
        saved = { revision: await revision(), records };
        cache.set(record.date, saved);
      }
      const latest = new Map<string, BusinessResult>();
      for (const item of saved.records) {
        const previous = latest.get(item.id);
        if (!previous || item.complete && !previous.complete || item.complete === previous.complete && item.acceptedAt >= previous.acceptedAt)
          latest.set(item.id, item);
      }
      const previous = latest.get(record.id);
      if (previous?.complete && !record.complete) return;
      if (previous && previous.complete === record.complete && previous.acceptedAt > record.acceptedAt) return;
      const sameOrigin = previous && canonical(previous.origin) === canonical(record.origin);
      if (sameOrigin && previous.published && !refresh && await exists(destination(root, previous))) return;
      if (previous?.submissionId === record.submissionId && previous.published && !refresh &&
        await exists(path.join(previous.origin.run, "results", previous.origin.reference.file!)) &&
        await exists(destination(root, previous))) return;
      const file = destination(root, record), current = await view(file);
      let adopted = false;
      if (!previous && current && existingLine !== undefined) {
        const span = current.spans.get(existingLine);
        if (!span || canonical(JSON.parse(fileSourceReader.record(file, span.offset, span.bytes, current.revision))) !== canonical(row))
          throw new Error("整理清单目标行与原正式结果不一致");
        if ([...latest.values()].some(item => item.file === record.file && item.line === existingLine && item.id !== record.id))
          throw new Error("整理清单目标行已归属其他业务回答");
        adopted = true;
      }
      if (!previous && current && !adopted && [...latest.values()].filter(item => item.file === record.file).length !== current.spans.size)
        throw new Error("已有交付文件缺少可核实的整理映射，暂不追加或覆盖");
      const lastLine = [...latest.values()].filter(item => item.file === record.file).reduce((last, item) => Math.max(last, item.line), 0);
      const line = previous?.line ?? (adopted ? existingLine! : 1 + (current?.spans.size ?? lastLine));
      const next = { ...record, line, published: false };
      validate(next);
      if (previous && previous.file !== next.file) throw new Error("同一结果身份对应不同交付文件");
      if (previous && previous.acceptedAt === next.acceptedAt && !sameOrigin && previous.submissionId !== next.submissionId)
        throw new Error("同一回答的正式结果接受时间相同，无法选定最新判词");
      // Read the immutable source on repair, never fabricate a successful empty result.
      const repair = async () => {
        const selected = new Map([...latest.values()].filter(item => item.file === next.file).map(item => [item.line, item]));
        selected.set(next.line, next);
        const spans = new Map<number, { offset: number; bytes: number }>();
        let bytes = 0;
        async function* chunks() {
          let index = 0;
          const chunk = (text: string) => {
            const buffer = Buffer.from(text + "\n");
            spans.set(index, { offset: bytes, bytes: buffer.length - 1 }); bytes += buffer.length; return buffer;
          };
          if (current) for await (const text of readJsonlText(file)) {
            index++;
            const item = selected.get(index);
            yield chunk(item === next ? JSON.stringify(row) : item && !item.published
              ? JSON.stringify(await readBusinessResultRow(item)) : text);
          }
          const end = [...selected.keys()].reduce((last, value) => Math.max(last, value), index);
          while (index < end) {
            const item = selected.get(++index);
            if (!item) throw new Error("交付结果索引缺行，不能补造或删除未索引结果");
            yield chunk(JSON.stringify(item === next ? row : await readBusinessResultRow(item)));
          }
        }
        await atomicWrite(file, chunks());
        views.set(file, { revision: await fileSourceReader.revision(file), bytes, spans });
      };
      // Journal first: a crash before publishing is repaired from the original accepted row.
      if (!sameOrigin || canonical(previous) !== canonical(next)) {
        await appendJsonl(journal, [next]);
        saved.records.push(next);
        saved.revision = await revision();
      }
      if (adopted) { /* The organized immutable row is already in place. */ }
      else if (!current || previous) await repair();
      else {
        const count = current.spans.size;
        if (line !== count + 1) throw new Error("交付结果追加行号不连续");
        await appendJsonl(file, [row]);
        current.spans.set(line, { offset: current.bytes, bytes: Buffer.byteLength(JSON.stringify(row)) });
        current.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        current.revision = await fileSourceReader.revision(file);
      }
      const published = { ...next, published: true };
      await appendJsonl(journal, [published]);
      saved.records.push(published);
      saved.revision = await revision();
    } finally {
      try { await unlock?.(); } finally { release(); }
    }
  };
}
