#!/usr/bin/env node
/**
 * Trace-record slimmer for collected agent sessions.
 *
 * One `.jsonl` line is one session. Every `llm_turn` span in it stores the whole
 * prompt it was called with: the system prompt, the tool definitions and the
 * entire conversation so far. Consecutive turns therefore repeat the same
 * messages over and over, which is what makes single lines reach tens of MB.
 *
 * This module rewrites that repetition as references. Per trace it collects the
 * distinct messages once (`message_pool`) and the distinct tool definitions once
 * (`tool_sets`), then replaces each snapshot with indices into them. Message
 * order and key order survive, so any coordinate inside `input_messages`
 * (evidence offsets included) keeps its meaning. A record without `llm_turn`
 * spans is copied through untouched.
 *
 * The module is deliberately standalone: it imports nothing from this project,
 * knows no caller, and writes only inside the requested directory. `--source`
 * may be a single file or a directory tree; every `*.jsonl` below it is
 * collected and mirrored into `--target` under the same relative path.
 *
 * Speed comes from three things: a pool of worker threads parses files in
 * parallel, lines are split on raw bytes so a 20MB line is copied and decoded
 * once, and a message reused at the same position as the previous turn skips
 * serialization entirely. `--verify` runs the inverse transform per record.
 *
 * Usage:
 *   node scripts/aime-slim.mjs --source <path> --target <dir> [options]
 *
 *   --source <path>     `*.jsonl` file or a directory tree containing them
 *   --target <dir>      directory to mirror slimmed `*.jsonl` into (created)
 *   --file <path>       only process this relative path or file name (repeatable)
 *   --concurrency <n>   worker threads (default: available cores, at most 8)
 *   --split <bytes>     split files above this size into parallel ranges
 *                       (default: 256MB when compressing, off for plain output)
 *   --zstd              write `*.jsonl.zst` (the fast choice: ~11x smaller, ~300MB/s)
 *   --gzip              write `*.jsonl.gz` (portable, but ~10x slower than zstd)
 *   --level <n>         codec level for `--zstd` (default 3)
 *   --dry-run           list what would be processed without writing anything
 *   --force             rewrite targets even when they are newer than the source
 *   --verify            per record, require the inverse transform to round-trip
 *   --expand            inverse mode: rebuild full records from slimmed ones
 *   --quiet             only print the summary
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { constants, createGunzip, createGzip, createZstdCompress, createZstdDecompress } from "node:zlib";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

/** Spans that carry a prompt snapshot. */
const isTurn = (value) => !!value && typeof value === "object" && value.type === "llm_turn";

/** Traces hold their own `messages`; a flat record holds them itself. */
const holders = (record) =>
  Array.isArray(record.traces) ? record.traces : Array.isArray(record.messages) ? [record] : [];

const isObject = (value) => typeof value === "object" && value !== null;

/** Structural equality for parsed JSON; cheaper than serializing both sides. */
function same(left, right) {
  if (left === right) return true;
  if (!isObject(left) || !isObject(right)) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!same(left[index], right[index])) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) if (!Object.hasOwn(right, key) || !same(left[key], right[key])) return false;
  return true;
}

function snapshotOf(turn) {
  const input = turn.input_messages;
  if (Array.isArray(input)) return { bare: true, input, messages: input };
  if (!isObject(input) || !Array.isArray(input.messages)) return null;
  return { bare: false, input, messages: input.messages };
}

/**
 * Replace repeated prompt snapshots with indices into a per-trace pool.
 *
 * Returns whether anything was replaced. A trace whose snapshots share no
 * message is left byte-for-byte untouched, which lets the caller copy the
 * record through without serializing it again.
 *
 * Mutates `record`.
 */
export function slimInPlace(record) {
  let changed = false;
  for (const holder of holders(record)) {
    const turns = holder.messages.filter(isTurn);
    if (!turns.length) continue;
    const pool = [], poolIndex = new Map(), toolSets = [], toolIndex = new Map(), pending = [];
    let previousMessages = null, previousRefs = null, previousTools, previousToolRef, hadTools = false, saved = false;
    for (const turn of turns) {
      const snapshot = snapshotOf(turn);
      if (!snapshot) continue;
      const { bare, input, messages } = snapshot;
      const refs = new Array(messages.length);
      for (let index = 0; index < messages.length; index += 1) {
        // Consecutive snapshots repeat their prefix verbatim; reuse that pool
        // entry without serializing the message again.
        if (previousMessages && index < previousMessages.length && same(messages[index], previousMessages[index])) {
          refs[index] = previousRefs[index];
          saved = true;
          continue;
        }
        const key = JSON.stringify(messages[index]);
        let pooled = poolIndex.get(key);
        if (pooled === undefined) {
          pooled = pool.length;
          poolIndex.set(key, pooled);
          pool.push(messages[index]);
        } else saved = true;
        refs[index] = pooled;
      }
      previousMessages = messages;
      previousRefs = refs;
      if (bare) {
        pending.push({ turn, bare: true, refs });
        continue;
      }
      let tools;
      if (Object.hasOwn(input, "tools")) {
        const value = input.tools;
        if (hadTools && same(value, previousTools)) {
          tools = previousToolRef;
          saved = true;
        } else {
          const key = JSON.stringify(value);
          tools = toolIndex.get(key);
          if (tools === undefined) {
            tools = toolSets.length;
            toolIndex.set(key, tools);
            toolSets.push(value);
          } else saved = true;
        }
        previousTools = value;
        previousToolRef = tools;
        hadTools = true;
      }
      pending.push({ turn, bare: false, input, refs, tools });
    }
    if (!saved) continue;
    for (const item of pending) {
      if (item.bare) item.turn.input_messages = item.refs;
      else {
        item.input.messages = item.refs;
        if (item.tools !== undefined) item.input.tools = item.tools;
      }
    }
    holder.message_pool = pool;
    if (toolSets.length) holder.tool_sets = toolSets;
    changed = true;
  }
  return changed;
}

/** Replace repeated prompt snapshots with indices into a per-trace pool. */
export function slimRecord(record) {
  slimInPlace(record);
  return record;
}

/** Restore the snapshots written by {@link slimInPlace}. Returns whether anything was restored. */
export function expandInPlace(record) {
  let changed = false;
  for (const holder of holders(record)) {
    const pool = holder.message_pool, toolSets = holder.tool_sets;
    if (!Array.isArray(pool)) continue;
    delete holder.message_pool;
    delete holder.tool_sets;
    for (const turn of holder.messages) {
      if (!isTurn(turn)) continue;
      const input = turn.input_messages;
      if (Array.isArray(input)) {
        turn.input_messages = input.map((ref) => pool[ref]);
        continue;
      }
      if (!isObject(input)) continue;
      if (Array.isArray(input.messages)) input.messages = input.messages.map((ref) => pool[ref]);
      if (typeof input.tools === "number" && Array.isArray(toolSets)) input.tools = toolSets[input.tools];
    }
    changed = true;
  }
  return changed;
}

/** Restore the snapshots written by {@link slimRecord}. Mutates and returns `record`. */
export function expandRecord(record) {
  expandInPlace(record);
  return record;
}

/**
 * Yield the non-empty lines of a file, optionally restricted to the byte range
 * `[from, to)`. Splitting happens on the `\n` byte, so a line that spans chunks
 * is copied once and decoded once.
 */
async function* readLines(file, from = 0, to = Infinity) {
  const pending = [];
  const ends = Number.isFinite(to);
  const source = file.endsWith(".gz")
    ? createReadStream(file).pipe(createGunzip())
    : file.endsWith(".zst")
      ? createReadStream(file).pipe(createZstdDecompress())
      : createReadStream(file, { start: from, ...(ends ? { end: to - 1 } : {}), highWaterMark: 1 << 20 });
  for await (const chunk of source) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0x0a, start);
      if (end < 0) break;
      let line;
      if (pending.length) {
        pending.push(chunk.subarray(start, end));
        line = Buffer.concat(pending).toString("utf8");
        pending.length = 0;
      } else line = chunk.toString("utf8", start, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) yield line;
      start = end + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
  if (pending.length) {
    const line = Buffer.concat(pending).toString("utf8");
    if (line.trim()) yield line;
  }
}

/** Buffered writer that keeps syscalls off the hot path. */
function createWriter(file, codec, level) {
  const sink = createWriteStream(file);
  const compressor = codec === "zstd"
    ? createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: level } })
    : codec === "gzip" ? createGzip({ level }) : null;
  const stream = compressor ?? sink;
  if (compressor) compressor.pipe(sink);
  // Keep an error listener attached for the whole life of the writer; without
  // one a late filesystem error would surface as an unhandled event.
  let failure = null;
  const fail = (error) => {
    failure ??= error;
  };
  sink.on("error", fail);
  compressor?.on("error", fail);
  let parts = [], size = 0;
  const flush = async () => {
    if (!parts.length) return;
    const chunk = parts.join("");
    parts = [];
    size = 0;
    if (!stream.write(chunk)) await once(stream, "drain");
    if (failure) throw failure;
  };
  return {
    async write(line) {
      parts.push(line, "\n");
      size += line.length + 1;
      if (size >= 4 << 20) await flush();
    },
    async writeChunk(chunk) {
      await flush();
      if (!stream.write(chunk)) await once(stream, "drain");
      if (failure) throw failure;
    },
    async end() {
      await flush();
      await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));
      if (compressor) await finished(sink);
      if (failure) throw failure;
    },
  };
}

/**
 * Slim or expand one byte range of a file into `target`.
 * Returns the record count.
 */
export async function transformRange(source, target, { expand = false, verify = false, codec = null, level = 3 } = {}, from = 0, to = Infinity) {
  await mkdir(path.dirname(target), { recursive: true });
  const writer = createWriter(target, codec, level);
  let records = 0;
  try {
    for await (const line of readLines(source, from, to)) {
      const record = JSON.parse(line);
      records += 1;
      const original = verify ? JSON.stringify(record) : null;
      // Nothing to dedupe: copy the source line through untouched, which keeps
      // pass-through records byte-identical without re-serializing them.
      const changed = expand ? expandInPlace(record) : slimInPlace(record);
      const written = changed ? JSON.stringify(record) : line;
      if (verify && changed) {
        // Check the inverse transform: expanding a slimmed record must return
        // the source, and re-slimming an expanded one must return the slim one.
        const copy = JSON.parse(written);
        if (expand) slimInPlace(copy);
        else expandInPlace(copy);
        if (JSON.stringify(copy) !== original) throw new Error(`${path.basename(source)} 第 ${records} 条记录往返不一致`);
      }
      await writer.write(written);
    }
    await writer.end();
    return records;
  } catch (error) {
    await writer.end().catch(() => {});
    await unlink(target).catch(() => {});
    throw error;
  }
}

/** Slim or expand one whole file. */
export function transformFile(source, target, options = {}) {
  return transformRange(source, target, options, 0, Infinity);
}

/** Every `*.jsonl` below `source`, as paths relative to it, plus whether it was a file. */
async function discover(source) {
  const info = await stat(source);
  if (info.isFile()) return { single: true, files: [path.basename(source)] };
  if (!info.isDirectory()) throw new Error(`无法读取源路径：${source}`);
  const files = [];
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.gz") || entry.name.endsWith(".jsonl.zst"))) files.push(relative);
    }
  };
  await walk(source, "");
  return { single: false, files: files.sort() };
}

/** First line start at or after `offset`, so a byte range never splits a record. */
async function lineStartAfter(file, offset, size) {
  if (offset <= 0) return 0;
  if (offset >= size) return size;
  const handle = await open(file, "r");
  try {
    const probe = Buffer.allocUnsafe(1 << 20);
    let position = offset;
    for (;;) {
      const { bytesRead } = await handle.read(probe, 0, probe.length, position);
      if (!bytesRead) return size;
      const index = probe.subarray(0, bytesRead).indexOf(0x0a);
      if (index >= 0) return position + index + 1;
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/** Split a file into `parts` byte ranges aligned to record boundaries. */
async function planRanges(file, size, parts, minimum) {
  const count = Math.max(1, Math.min(parts, Math.floor(size / minimum)));
  if (count === 1) return [{ index: 0, start: 0, end: size }];
  const bounds = [0];
  for (let index = 1; index < count; index += 1) {
    const offset = Math.floor((size * index) / count);
    const start = await lineStartAfter(file, offset, size);
    if (start > bounds[bounds.length - 1] && start < size) bounds.push(start);
  }
  bounds.push(size);
  return bounds.slice(1).map((end, index) => ({ index, start: bounds[index], end })).filter((range) => range.end > range.start);
}

/** Skip a target that already reflects a source of the same age or older. */
async function isCurrent(source, target) {
  const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target).catch(() => null)]);
  return !!targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs;
}

/** Copy part files into one file, in order, with plain handle reads. */
async function joinParts(parts, target) {
  const output = await open(target, "w");
  try {
    const buffer = Buffer.allocUnsafe(8 << 20);
    for (const part of parts) {
      const input = await open(part, "r");
      try {
        let position = 0;
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead;
          let offset = 0;
          while (offset < bytesRead) {
            const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
            offset += bytesWritten;
          }
        }
      } finally {
        await input.close();
      }
    }
  } finally {
    await output.close();
  }
}

const OPTIONS = ["source", "target", "file", "concurrency", "split", "level"];
const FLAGS = ["force", "verify", "expand", "gzip", "zstd", "dry-run", "quiet"];

function parseArguments(argv) {
  const options = {
    source: null, target: null, file: [], concurrency: Math.min(availableParallelism(), 8),
    split: null, level: 3, force: false, verify: false, expand: false, gzip: false, zstd: false, dryRun: false, quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`无法识别的参数：${argument}`);
    const name = argument.slice(2);
    if (FLAGS.includes(name)) {
      options[name.replace("-run", "Run")] = true;
      continue;
    }
    if (!OPTIONS.includes(name)) throw new Error(`无法识别的参数：${argument}`);
    const value = argv[(index += 1)];
    if (value === undefined) throw new Error(`${argument} 缺少取值`);
    if (name === "file") options.file.push(value);
    else if (name === "concurrency" || name === "split" || name === "level") options[name] = Number.parseInt(value, 10);
    else options[name] = value;
  }
  if (!options.source || !options.target) throw new Error("必须指定 --source 与 --target");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency 必须是正整数");
  if (options.split !== null && (!Number.isFinite(options.split) || options.split < 0))
    throw new Error("--split 必须是非负整数（0 表示不拆分）");
  if (options.gzip && options.zstd) throw new Error("--gzip 与 --zstd 只能选一个");
  if (!Number.isInteger(options.level) || options.level < 1 || options.level > 19) throw new Error("--level 必须在 1 到 19 之间");
  options.codec = options.zstd ? "zstd" : options.gzip ? "gzip" : null;
  // Compressed output is CPU-bound, so ranges cost nothing and buy parallelism.
  // Plain output is write-bound, where ranges would double the writes.
  if (options.split === null) options.split = options.codec ? 256 << 20 : 0;
  return options;
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)}MB`;
const percent = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "-");
const seconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)}s`;

if (!isMainThread) {
  parentPort.on("message", async (message) => {
    if (message.type === "stop") {
      parentPort.close();
      return;
    }
    try {
      const records = await transformRange(message.from, message.part, { ...workerData, codec: message.codec }, message.start, message.end);
      parentPort.postMessage({ relative: message.relative, index: message.index, records });
    } catch (error) {
      parentPort.postMessage({ relative: message.relative, index: message.index, failed: error.message, part: message.part });
    }
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`${error.message}\n用法见 scripts/aime-slim.mjs 顶部注释。`);
    return 2;
  }
  const source = path.resolve(options.source), target = path.resolve(options.target);
  if (source === target) {
    console.error("源路径与目标路径不能相同。");
    return 2;
  }
  let discovered;
  try {
    discovered = await discover(source);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const available = discovered.files.filter((relative) =>
    options.expand ? true : !relative.endsWith(".gz"));
  const files = options.file.length
    ? available.filter((relative) => {
        const bare = relative.replace(/\.(gz|zst)$/, "");
        return options.file.some((name) => relative === name || bare === name || path.basename(bare) === name);
      })
    : available;
  if (!files.length) {
    console.error(`没有找到需要处理的 *.jsonl：${source}`);
    return 2;
  }
  if (options.dryRun) {
    let bytes = 0;
    for (const relative of files) {
      const from = discovered.single ? source : path.join(source, relative);
      const { size } = await stat(from);
      bytes += size;
      console.log(`${relative}  ${mb(size)}`);
    }
    console.log(`共 ${files.length} 个文件，${mb(bytes)}；目标目录 ${target}`);
    return 0;
  }
  await mkdir(target, { recursive: true });

  const totals = { records: 0, bytes: 0, written: 0, skipped: 0, failed: 0 };
  const started = performance.now();
  const workers = Math.min(options.concurrency, 32);

  // Byte ranges are the scheduling unit, so one huge file cannot pin the run to
  // a single core. Ranges never split a record: they start right after a newline.
  // Ranges of a compressed file are staged as plain text on the local disk and
  // merged afterwards through a single compressor, so parsing stays parallel
  // while the output stays one valid zstd/gzip stream.
  const scratch = options.codec && options.split ? await mkdtemp(path.join(tmpdir(), "aime-slim-")) : null;
  let scratchId = 0;
  const tasks = [];
  const jobs = new Map();
  for (const relative of files) {
    const from = discovered.single ? source : path.join(source, relative);
    const suffix = options.codec === "zstd" ? ".zst" : options.codec === "gzip" ? ".gz" : "";
    const name = options.expand ? relative.replace(/\.(gz|zst)$/, "") : `${relative}${suffix}`;
    const to = path.join(target, name);
    if (!options.force && await isCurrent(from, to)) {
      totals.skipped += 1;
      if (!options.quiet) console.log(`${relative}  已是当前版本，跳过`);
      continue;
    }
    const { size } = await stat(from);
    // A compressed file must stay one stream: concatenated zstd members do not
    // decode as one file, so ranges are only used for plain output.
    const ranges = options.split
      ? await planRanges(from, size, workers, options.split)
      : [{ index: 0, start: 0, end: size }];
    const temporary = path.join(path.dirname(to), `.${path.basename(to)}.${process.pid}.tmp`);
    const merge = ranges.length > 1 && !!options.codec;
    await mkdir(path.dirname(to), { recursive: true });
    const job = { relative, from, to, temporary, size, remaining: ranges.length, parts: [], merge };
    jobs.set(relative, job);
    for (const range of ranges) {
      const part = ranges.length === 1
        ? temporary
        : merge ? path.join(scratch, `${scratchId++}-${range.index}`) : `${temporary}.${range.index}`;
      job.parts[range.index] = part;
      tasks.push({
        relative, index: range.index, from, part,
        start: range.start, end: range.end,
        codec: merge ? null : options.codec,
      });
    }
  }
  if (!tasks.length) {
    console.log(`没有需要处理的文件，跳过 ${totals.skipped} 个`);
    return 0;
  }
  tasks.sort((left, right) => (right.end - right.start) - (left.end - left.start));

  const discard = async (job) => {
    await Promise.all(job.parts.map((part) => unlink(part).catch(() => {})));
    await unlink(job.temporary).catch(() => {});
  };
  const finish = async (job) => {
    try {
      if (job.merge) {
        const writer = createWriter(job.temporary, options.codec, options.level);
        try {
          for (const part of job.parts)
            for await (const chunk of createReadStream(part, { highWaterMark: 8 << 20 })) await writer.writeChunk(chunk);
          await writer.end();
        } catch (error) {
          await writer.end().catch(() => {});
          throw error;
        }
        await Promise.all(job.parts.map((part) => unlink(part).catch(() => {})));
      } else if (job.parts.length > 1) {
        await joinParts(job.parts, job.temporary);
        await Promise.all(job.parts.map((part) => unlink(part).catch(() => {})));
      }
      await rename(job.temporary, job.to);
      const { size: targetBytes } = await stat(job.to);
      totals.bytes += job.size;
      totals.written += targetBytes;
      if (!options.quiet)
        console.log(`${job.relative}  ${mb(job.size)} -> ${mb(targetBytes)}  (${percent(targetBytes, job.size)})  ${job.parts.length} 段`);
    } catch (error) {
      totals.failed += 1;
      console.error(`${job.relative}  失败：${error.message}`);
      await discard(job);
    }
  };
  const settle = async (result) => {
    const job = jobs.get(result.relative);
    if (!job) return;
    if (result.failed) {
      totals.failed += 1;
      console.error(`${result.relative}  失败：${result.failed}`);
      job.remaining = 0;
      await discard(job);
      return;
    }
    totals.records += result.records;
    job.remaining -= 1;
    if (job.remaining === 0) await finish(job);
  };

  if (workers === 1) {
    for (const task of tasks) {
      try {
        await settle({ relative: task.relative, records: await transformRange(task.from, task.part, { ...options, codec: task.codec }, task.start, task.end) });
      } catch (error) {
        await settle({ relative: task.relative, failed: error.message });
      }
    }
  } else {
    const queue = [...tasks];
    await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, () => new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { expand: options.expand, verify: options.verify, codec: options.codec, level: options.level } });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        resolve();
      };
      const next = async () => {
        const task = queue.shift();
        if (task === undefined) {
          worker.postMessage({ type: "stop" });
          return;
        }
        worker.postMessage({ type: "task", from: task.from, part: task.part, start: task.start, end: task.end, relative: task.relative, index: task.index, codec: task.codec });
      };
      worker.on("message", async (result) => {
        const job = jobs.get(result.relative);
        if (!job) {
          next();
          return;
        }
        if (result.failed) {
          totals.failed += 1;
          console.error(`${result.relative}  失败：${result.failed}`);
          job.remaining = 0;
          await discard(job);
          jobs.delete(result.relative);
        } else {
          totals.records += result.records;
          job.remaining -= 1;
          if (job.remaining === 0) await finish(job);
        }
        next();
      });
      worker.on("error", (error) => {
        totals.failed += 1;
        console.error(`工作线程失败：${error.message}`);
        close();
      });
      worker.on("exit", close);
      next();
    })));
  }
  if (scratch) await rm(scratch, { recursive: true, force: true });
  const elapsed = performance.now() - started;
  console.log(`合计 ${totals.records} 条，${mb(totals.bytes)} -> ${mb(totals.written)} (${percent(totals.written, totals.bytes)})，跳过 ${totals.skipped} 个，失败 ${totals.failed} 个，用时 ${seconds(elapsed)}，${mb(totals.bytes / (elapsed / 1000))}/s`);
  return totals.failed ? 1 : 0;
}
