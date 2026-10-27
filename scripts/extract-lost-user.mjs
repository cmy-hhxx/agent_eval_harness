#!/usr/bin/env node
/**
 * Extract lost-user upload packages into the evaluation input tree.
 *
 * A lost-user package is a `.7z` whose members are JSONL sessions. Packages arrive
 * in two shapes and both land under the same target root, one directory per input
 * version:
 *
 *   AIME    member `*.jsonl`, each record `{ meta, traces }` with a `fast` or
 *           `expert` mode. Channel is `aime_fast` / `aime_expert`. A record's
 *           identity is its trace id, because one session can repeat a round.
 *   Wencai  members named `*-A-fast*.jsonl`, `*-AA-expert*.jsonl`, ... Channel is
 *           `a_fast` / `b_fast` / `a_expert` / `b_expert` (`A` is a, `AA`/`B` is b).
 *           A single trace is flattened onto the record, as the data service does,
 *           so the row carries `messages` instead of `traces`.
 *
 * Every written row is the published input contract: `request_time`, `batch_id`,
 * `case_id`, `version`, `has_standard_answer`, `versions`, `meta`, `_source`, plus
 * the original messages. That is what `2_daily_eval_input` holds and what the
 * evaluator reads. The business date is the Asia/Shanghai date of `request_time`;
 * rows are grouped into `<target>/<channel>/<YYYY-MM-DD>.jsonl`.
 *
 * Speed comes from doing the expensive work in parallel: archives are split over
 * worker threads (one `7z` child each), every worker normalizes directly into
 * per-archive JSONL under a local temporary directory, and the main thread only
 * concatenates those chunks once into the target files. Decompression and JSON
 * parsing therefore overlap across cores instead of running one archive at a time.
 *
 * The first run (or `--refresh`) rebuilds every target file: rows are
 * deduplicated by `(channel, batch_id, case_id)`, each file is assembled under a
 * temporary name and renamed into place, and nothing is published unless every
 * package was read. A rerun reads `.extract-lost-user.json`, appends only the
 * packages that are new, skips already published case ids, and returns in
 * milliseconds when nothing changed. The manifest also records byte counts, so a
 * run interrupted mid-append is truncated back and retried instead of doubling
 * rows. A replaced, removed or longer-than-recorded input forces a rebuild.
 *
 * The module is standalone: it imports nothing from this project, and its only
 * external tool is the `7z` binary needed to read `.7z` archives. It never writes
 * inside the inbox and never deletes a package.
 *
 * Usage:
 *   node scripts/extract-lost-user.mjs [options]
 *
 *   --source <dir>      inbox with top-level `.7z` packages
 *                       (default /mnt/fin_bench/eval_data/1_aime/1_7z_data/lost_user)
 *   --target <dir>      evaluation input root (default /mnt/fin_bench/eval_data/1_aime/5_lost_user_eval_input)
 *   --seven-zip <path>  archive reader (default `7z`)
 *   --concurrency <n>   parallel archive workers (default: min(16, cores))
 *   --refresh           ignore the manifest and rebuild every target file
 *   --dry-run           list packages and members without reading or writing
 *   --quiet             print only the summary
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, truncateSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const DEFAULT_SOURCE = "/mnt/fin_bench/eval_data/1_aime/1_7z_data/lost_user";
const DEFAULT_TARGET = "/mnt/fin_bench/eval_data/1_aime/5_lost_user_eval_input";
const DEFAULT_CONCURRENCY = Math.min(16, availableParallelism());
/** Manifest that lets a rerun append only newly arrived packages. */
const STATE_NAME = ".extract-lost-user.json";

/** Wencai member naming; `A` is the a group, `AA`/`B` the b group. */
const WENCAI_MEMBER = /(?:^|[_-])(aa|a|b)-(fast|expert)(?:\.incr\d+)?\.jsonl$/i;
/** Version written into a Wencai row; matches the data service names. */
const WENCAI_VERSION = { a_fast: "A Fast", a_expert: "A Expert", b_fast: "B Fast", b_expert: "B Expert" };
/** Every channel this script may write. */
const CHANNELS = new Set(["aime_fast", "aime_expert", "a_fast", "b_fast", "a_expert", "b_expert"]);

class RecordError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => (typeof value === "string" && value.trim()) || (typeof value === "number" && !Number.isNaN(value));

/** Channel for a Wencai member path, or null when the name is not a Wencai member. */
export function wencaiChannel(member) {
  const matched = WENCAI_MEMBER.exec(path.basename(member.replaceAll("\\", "/")));
  if (!matched) return null;
  const group = matched[1].toLowerCase() === "a" ? "a" : "b";
  return `${group}_${matched[2].toLowerCase()}`;
}

/**
 * AIME mode of a session. The published input puts the session-level mode first
 * (`agent_mode`, then `session_type`) and only falls back to the trace mode.
 */
export function aimeChannel(record) {
  const meta = record?.meta;
  if (!isObject(meta)) return null;
  const declared = typeof meta.agent_mode === "string" ? meta.agent_mode.split("-")[0] : meta.session_type;
  if (declared === "fast" || declared === "expert") return "aime_" + declared;
  const modes = new Set();
  if (Array.isArray(record.traces)) {
    for (const trace of record.traces) {
      const mode = trace?.meta?.mode;
      if (mode === "fast" || mode === "expert") modes.add(mode);
    }
  }
  return modes.size === 1 ? "aime_" + [...modes][0] : null;
}

/** Business date in Asia/Shanghai (UTC+8, no DST). Accepts ISO with zone or naive local time. */
export function shanghaiDay(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  let milliseconds;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    milliseconds = Date.parse(text);
  } else {
    const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text);
    if (!local) return null;
    milliseconds = Date.UTC(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], Math.floor(Number(local[6] ?? 0)))
      - 8 * 60 * 60 * 1000;
  }
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Text of a message content as the evaluator sees it. */
function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" || isObject(item)).map(contentText).join("\n");
  if (isObject(value)) return String(value.text ?? "");
  return "";
}

/** Question of the last user turn and the last non-empty answer after it. */
function lastExchange(messages) {
  let lastUser = -1;
  for (const [index, message] of messages.entries()) {
    if (isObject(message) && (message.role === "user" || (message.role === undefined && message.type === "user_question"))) lastUser = index;
  }
  if (lastUser < 0) return { question: "", answer: "" };
  const content = messages[lastUser].content;
  const question = contentText(Array.isArray(content) ? content.slice(0, 1) : content).trim();
  let answer = "";
  for (const message of messages.slice(lastUser + 1)) {
    if (!isObject(message) || !(message.role === "assistant" || (message.role === undefined && message.type === "final_answer"))) continue;
    const text = contentText(message.content).trim();
    if (text) answer = text;
  }
  return { question, answer };
}

/** `has_standard_answer` as the input contract defines it, or a RecordError. */
function standardAnswer(record, meta) {
  let flag = record.has_standard_answer;
  if (flag === undefined) flag = meta.has_standard_answer;
  if (flag === undefined) {
    flag = ["ground_truth", "std_answer"].some((key) => meta[key] !== null && meta[key] !== undefined && meta[key] !== "");
  }
  if (typeof flag !== "boolean") throw new RecordError("standard_answer_flag_invalid");
  return flag;
}

/** The legacy `versions` marker the data service writes beside `version`. */
function recordVersions(day, channel) {
  return channel === "b_fast" && day >= "2026-09-29" ? "0929-big-fast" : "default";
}

function requestTimeOf(record, meta, traces) {
  const direct = record.request_time ?? meta.request_time;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const stamp = meta.timestamp_time;
  if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) {
    return new Date(stamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 23) + "+08:00";
  }
  const traceStamp = traces?.map((trace) => trace?.meta?.timestamp).find((value) => typeof value === "string" && value.trim());
  return traceStamp ? traceStamp.trim() : null;
}

function businessIdentity(record, meta, requestTime) {
  if (!requestTime) throw new RecordError("request_time_missing");
  const day = shanghaiDay(requestTime);
  if (!day) throw new RecordError("request_time_invalid");
  const batch = record.batch_id ?? meta.batch_id ?? day;
  if (!isText(batch)) throw new RecordError("batch_id_invalid");
  return { day, batch: String(batch).trim() };
}

function originOf(origin) {
  return { original_file: origin.archive + "/" + origin.member, original_line: origin.line, original_item: origin.item };
}

const omit = (record, keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

/**
 * Normalize one AIME session onto the published input contract.
 * Throws RecordError for records the evaluator could not load.
 *
 * `raw` is the source line. AIME rows only need fields added around the original
 * `meta`/`traces` body, so the body is reused verbatim instead of being parsed,
 * re-serialized and copied again; a record with colliding top-level keys falls
 * back to a full serialization.
 */
export function normalizeAime(record, origin, raw = null) {
  if (!isObject(record)) throw new RecordError("record_not_object");
  const meta = record.meta;
  if (!isObject(meta)) throw new RecordError("meta_invalid");
  const traces = record.traces;
  if (!Array.isArray(traces) || !traces.length) throw new RecordError("traces_invalid");
  for (const trace of traces) {
    if (!isObject(trace) || !Array.isArray(trace.messages) || !trace.messages.length) throw new RecordError("trace_invalid");
  }
  const channel = aimeChannel(record);
  if (!channel) throw new RecordError("aime_mode_unknown");
  const requestTime = requestTimeOf(record, meta, traces);
  const { day, batch } = businessIdentity(record, meta, requestTime);
  // A session may repeat a round, so the trace is the business identity when the
  // package holds one trace per row; multi-trace sessions keep the session identity.
  const traceId = traces.length === 1 ? traces[0].meta.trace_id : null;
  const identity = (isText(traceId) ? traceId : null) ?? meta.session_id ?? record.case_id ?? meta.case_id;
  if (!isText(identity)) throw new RecordError("case_id_missing");
  if (meta.ok === false) throw new RecordError("collection_failed");
  // The evaluator requires a question and a final answer in every trace.
  for (const trace of traces) {
    const exchange = lastExchange(trace.messages);
    if (!exchange.question) throw new RecordError("question_missing");
    if (!exchange.answer) throw new RecordError("answer_empty");
  }
  // Identity first: the merge pass can read `case_id` without parsing the record.
  const row = {
    request_time: requestTime,
    batch_id: batch,
    case_id: String(identity).trim(),
    version: channel,
    has_standard_answer: standardAnswer(record, meta),
    versions: "default",
    ...omit(record, ["request_time", "batch_id", "case_id", "version", "has_standard_answer", "versions"]),
    meta: { ...meta },
    trace_id: isText(traceId) ? String(traceId).trim() : (record.trace_id ?? meta.trace_id ?? null),
    _source: originOf(origin),
  };
  if (Array.isArray(meta.file_refs) && meta.file_refs.length) {
    row.files = meta.file_refs
      .filter(isObject)
      .map((ref) => ({ fileName: ref.fileName, filePath: ref.filePath, contentType: ref.contentType, dsw_file_name: ref.dsw_file_name }));
  }
  return { channel, day, row, line: spliceAimeLine(row, record, raw) };
}

const RESERVED_KEYS = ["request_time", "batch_id", "case_id", "version", "has_standard_answer", "versions", "trace_id", "_source", "files"];

/** Serialize an AIME row by wrapping the untouched source body, when that is lossless. */
function spliceAimeLine(row, record, raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text.startsWith("{") || !text.endsWith("}") || RESERVED_KEYS.some((key) => Object.hasOwn(record, key))) {
    return JSON.stringify(row);
  }
  const head = JSON.stringify({
    request_time: row.request_time,
    batch_id: row.batch_id,
    case_id: row.case_id,
    version: row.version,
    has_standard_answer: row.has_standard_answer,
    versions: row.versions,
  }).slice(0, -1);
  const tail = JSON.stringify({ trace_id: row.trace_id, _source: row._source, ...(row.files ? { files: row.files } : {}) }).slice(1, -1);
  return head + "," + text.slice(1, -1) + "," + tail + "}";
}

/**
 * Normalize one Wencai AB row. A package member is already bound to a channel, so
 * the member name, not the payload, decides the version.
 */
export function normalizeWencai(record, origin, channel) {
  if (!CHANNELS.has(channel) || !WENCAI_VERSION[channel]) throw new RecordError("channel_unknown");
  if (!isObject(record)) throw new RecordError("record_not_object");
  if (record.meta !== undefined && !isObject(record.meta)) throw new RecordError("meta_invalid");
  let meta = { ...(record.meta ?? {}) };
  let flat = { ...record };
  if ("traces" in record) {
    const traces = record.traces;
    if (!Array.isArray(traces) || traces.length !== 1) throw new RecordError("single_trace_required");
    const trace = traces[0];
    if (!isObject(trace) || !isObject(trace.meta)) throw new RecordError("trace_meta_invalid");
    meta = { ...trace.meta, ...meta };
    if (record.request_time === undefined && meta.request_time === undefined && meta.timestamp_time === undefined) {
      meta.request_time = trace.meta.timestamp;
    }
    flat = omit(record, ["traces"]);
    flat.messages = trace.messages;
    flat.trace_id = trace.meta.trace_id ?? flat.trace_id ?? meta.trace_id;
  }
  flat.meta = meta;
  const messages = flat.messages;
  if (!Array.isArray(messages) || !messages.length) throw new RecordError("message_chain_invalid");
  if (meta.ok === false) throw new RecordError("collection_failed");
  const exchange = lastExchange(messages);
  if (!exchange.question) throw new RecordError("question_missing");
  if (!exchange.answer) throw new RecordError("answer_empty");
  const identity = flat.case_id ?? meta.case_id ?? meta.item_id;
  if (!isText(identity)) throw new RecordError("case_id_missing");
  const requestTime = requestTimeOf(flat, meta, null);
  const { day, batch } = businessIdentity(flat, meta, requestTime);
  const row = {
    request_time: requestTime,
    batch_id: batch,
    case_id: String(identity).trim(),
    version: WENCAI_VERSION[channel],
    has_standard_answer: standardAnswer(flat, meta),
    versions: recordVersions(day, channel),
    ...omit(flat, ["request_time", "batch_id", "case_id", "version", "has_standard_answer", "versions", "traces", "files"]),
    meta,
    trace_id: flat.trace_id ?? meta.trace_id ?? null,
    _source: originOf(origin),
  };
  return { channel, day, row, line: JSON.stringify(row) };
}

/** Run a command and collect stdout lines; rejects on a non-zero exit. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const lines = [];
    createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on("line", (line) => lines.push(line))
      .on("close", () => undefined);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(lines);
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Split a byte stream on `\n` without buffering more than one record.
 *
 * `readline` is not usable here: a lost-user record reaches ~10 MB and the
 * interface truncates very long lines, which would silently cut JSON in half.
 */
async function forEachRawLine(stream, visit) {
  let pending = [], pendingLength = 0;
  const flush = async (chunk) => {
    pending.push(chunk);
    pendingLength += chunk.length;
    const raw = (pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength)).toString("utf8").replace(/\r$/, "");
    pending = [];
    pendingLength = 0;
    await visit(raw);
  };
  for await (const chunk of stream) {
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index >= 0; index = chunk.indexOf(0x0a, start)) {
      await flush(chunk.subarray(start, index));
      start = index + 1;
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
      pendingLength += chunk.length - start;
    }
  }
  if (pendingLength) await flush(Buffer.alloc(0));
}

/** Same split as `forEachRawLine`, but hands whole lines over as Buffers. */
async function forEachBufferLine(stream, visit) {
  let pending = [], pendingLength = 0;
  const flush = async (chunk) => {
    pending.push(chunk);
    pendingLength += chunk.length;
    const raw = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);
    pending = [];
    pendingLength = 0;
    if (raw.length && raw[raw.length - 1] === 0x0d) await visit(raw.subarray(0, raw.length - 1));
    else if (raw.length) await visit(raw);
  };
  for await (const chunk of stream) {
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index >= 0; index = chunk.indexOf(0x0a, start)) {
      await flush(chunk.subarray(start, index));
      start = index + 1;
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
      pendingLength += chunk.length - start;
    }
  }
  if (pendingLength) await flush(Buffer.alloc(0));
}

/** JSONL members of an archive, in archive order. */
export async function membersOf(command, archive) {
  const lines = await run(command, ["l", "-slt", "-y", "--", archive]);
  const names = [];
  for (const line of lines) {
    const matched = /^Path = (.+)$/.exec(line);
    if (!matched) continue;
    const name = matched[1].trim();
    if (!/\.jsonl$/i.test(name)) continue;
    if (path.basename(name) === path.basename(archive)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Stream one member and await `visit` for every parsed JSONL value, one at a time. */
async function streamMember(command, archive, member, visit) {
  const child = spawn(command, ["x", "-so", "-y", "--", archive, member], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} x ${path.basename(archive)} ${member} exited ${code}: ${stderr.trim()}`));
    });
  });
  let line = 0;
  await forEachRawLine(child.stdout, async (raw) => {
    line += 1;
    if (!raw.trim()) return;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      await visit({ line, error: new RecordError("invalid_json") });
      return;
    }
    const items = Array.isArray(value) ? value : [value];
    if (!items.length) await visit({ line, item: 1, error: new RecordError("empty_session") });
    for (const [index, item] of items.entries()) await visit({ line, item: index + 1, value: item, raw });
  });
  await closed;
}

/** Read `case_id` from the first bytes of a serialized row without parsing it. */
function caseIdOf(prefix) {
  const matched = /^\{"request_time":(?:"(?:[^"\\]|\\.)*"|null),"batch_id":"(?:[^"\\]|\\.)*","case_id":"((?:[^"\\]|\\.)*)"/.exec(prefix);
  return matched ? matched[1] : null;
}

/**
 * Every package under the inbox, keyed by file name. Processed packages keep
 * their name when the watcher moves them under `3_processed_archives/`, so the
 * same package is still found after archiving and never re-published.
 */
async function scanPackages(source) {
  const packages = new Map();
  for (const entry of await readdir(source, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.7z$/i.test(entry.name)) continue;
    if (packages.has(entry.name)) throw new Error(`收包目录存在同名压缩包：${entry.name}`);
    packages.set(entry.name, path.join(entry.parentPath ?? entry.path ?? source, entry.name));
  }
  if (!packages.size) throw new Error(`收包目录没有 .7z：${source}`);
  return packages;
}

/** Signatures of the given packages, keyed by file name. */
async function archiveSignatures(packages, names) {
  const signatures = {};
  for (const name of names) {
    const info = await stat(packages.get(name));
    signatures[name] = { size: info.size, mtimeMs: info.mtimeMs };
  }
  return signatures;
}

export async function readState(target) {
  try {
    const value = JSON.parse(await readFile(path.join(target, STATE_NAME), "utf8"));
    if (!isObject(value) || value.version !== 2 || !isObject(value.archives) || !isObject(value.files)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Decide how much work a run needs.
 *
 * `current` means every package is already published; `incremental` means only
 * the listed packages are new; anything inconsistent (a package replaced or
 * removed, a published file shorter than recorded) falls back to a full rebuild.
 * A file longer than recorded is a partially appended run and is truncated first.
 */
async function planRun({ packages, target, archives, state }) {
  if (!state) return { mode: "full" };
  const signatures = await archiveSignatures(packages, archives);
  if (Object.keys(state.archives).some((name) => !signatures[name] ||
      signatures[name].size !== state.archives[name].size || signatures[name].mtimeMs !== state.archives[name].mtimeMs)) {
    return { mode: "full" };
  }
  for (const [key, entry] of Object.entries(state.files)) {
    const [channel, day] = key.split("/");
    if (!CHANNELS.has(channel) || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isInteger(entry.bytes) || entry.bytes < 0 || !Array.isArray(entry.cases)) return { mode: "full" };
    const file = path.join(target, channel, day + ".jsonl");
    const info = await stat(file).catch(() => null);
    if (!info) return { mode: "full" };
    if (info.size > entry.bytes) truncateSync(file, entry.bytes);
    else if (info.size < entry.bytes) return { mode: "full" };
  }
  const pending = archives.filter((name) => !Object.hasOwn(state.archives, name));
  if (!pending.length) return { mode: "current" };
  const known = {};
  for (const [key, entry] of Object.entries(state.files)) {
    const channel = key.split("/")[0];
    (known[channel] ??= []).push(...entry.cases);
  }
  return { mode: "incremental", pending, known };
}

/**
 * Extract and normalize the archives assigned to one worker.
 * Chunk files are written under `staging`; nothing in the target is touched.
 */
async function processArchives({ staging, sevenZip, rank, entries, known = {} }) {
  const summary = { rows: 0, accepted: 0, duplicates: 0, invalid: 0, skipped: new Map(), files: [] };
  const streams = new Map();
  const identities = new Set();
  const published = new Map(Object.entries(known).map(([channel, cases]) => [channel, new Set(cases)]));
  const directory = path.join(staging, String(rank));
  await mkdir(directory, { recursive: true });

  const skip = (reason, where) => {
    const entry = summary.skipped.get(reason) ?? { count: 0, sample: where };
    entry.count += 1;
    summary.skipped.set(reason, entry);
  };

  // Synchronous writes keep the workers off the shared libuv thread pool: with
  // the default pool of four, concurrent async writes would serialize the whole
  // parallel phase. Each worker owns its files, so append-order is private.
  const open = (channel, day) => {
    if (!CHANNELS.has(channel) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`非法输出通道或日期：${channel}/${day}`);
    const key = channel + "/" + day;
    const known = streams.get(key);
    if (known) return known;
    const folder = path.join(directory, channel);
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, day + ".jsonl");
    const entry = { channel, day, file, rows: 0, fd: openSync(file, "a") };
    streams.set(key, entry);
    summary.files.push(entry);
    return entry;
  };

  const accept = ({ channel, day, row, line }) => {
    if (published.get(channel)?.has(row.case_id)) {
      summary.duplicates += 1;
      return;
    }
    const identity = [channel, row.batch_id, row.case_id].join("\u0000");
    if (identities.has(identity)) {
      summary.duplicates += 1;
      return;
    }
    identities.add(identity);
    const entry = open(channel, day);
    const buffer = Buffer.from(line + "\n");
    for (let offset = 0; offset < buffer.length;) offset += writeSync(entry.fd, buffer, offset, buffer.length - offset);
    entry.rows += 1;
    summary.accepted += 1;
  };

  for (const { name, path: archive } of entries) {
    const members = await membersOf(sevenZip, archive);
    if (!members.length) throw new Error(`${name}: 压缩包没有 JSONL 成员`);
    for (const member of members) {
      const wencai = wencaiChannel(member);
      await streamMember(sevenZip, archive, member, async (event) => {
        summary.rows += 1;
        const where = `${name}/${member}:${event.line}${event.item ? "#" + event.item : ""}`;
        if (event.error) {
          summary.invalid += 1;
          skip(event.error.reason, where);
          return;
        }
        const origin = { archive: name, member, line: event.line, item: event.item ?? 1 };
        try {
          const normalized = wencai
            ? normalizeWencai(event.value, origin, wencai)
            : normalizeAime(event.value, origin, event.raw);
          await accept(normalized);
        } catch (error) {
          summary.invalid += 1;
          skip(error instanceof RecordError ? error.reason : error.message, where);
        }
      });
    }
  }

  for (const entry of summary.files) {
    closeSync(entry.fd);
    delete entry.fd;
  }
  return {
    rank,
    rows: summary.rows,
    accepted: summary.accepted,
    duplicates: summary.duplicates,
    invalid: summary.invalid,
    skipped: Object.fromEntries([...summary.skipped.entries()].map(([reason, entry]) => [reason, entry.count])),
    samples: Object.fromEntries([...summary.skipped.entries()].map(([reason, entry]) => [reason, entry.sample])),
    files: summary.files,
  };
}

/** Run one worker over its share of archives; resolves with its summary. */
function startWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { ...data, lostUserWorker: true } });
    worker.once("message", (message) => {
      worker.terminate().catch(() => undefined);
      if (message.error) reject(new Error(message.error));
      else resolve(message.summary);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

/**
 * One final output file under construction. Chunks are appended in worker order
 * while the remaining workers are still busy, so the Ceph write overlaps with
 * extraction instead of waiting for every archive.
 */
class GroupFile {
  constructor({ channel, day, target, append = false }) {
    this.channel = channel;
    this.day = day;
    this.final = path.join(target, channel, day + ".jsonl");
    this.temporary = path.join(target, channel, `.${day}.${process.pid}.tmp`);
    this.appendMode = append;
    this.stream = null;
    this.seen = new Set();
    this.rows = 0;
    this.duplicates = 0;
  }

  async open() {
    if (this.stream) return this;
    await mkdir(path.dirname(this.final), { recursive: true });
    this.stream = this.appendMode
      ? createWriteStream(this.final, { flags: "a", highWaterMark: 4 << 20 })
      : createWriteStream(this.temporary, { highWaterMark: 4 << 20 });
    return this;
  }

  async append(chunk) {
    await this.open();
    await forEachBufferLine(createReadStream(chunk.file, { highWaterMark: 4 << 20 }), async (raw) => {
      const identity = caseIdOf(raw.subarray(0, 512).toString("utf8"));
      if (identity === null) throw new Error(`规范化行缺少 case_id：${chunk.file}`);
      if (this.seen.has(identity)) {
        this.duplicates += 1;
        return;
      }
      this.seen.add(identity);
      if (!this.stream.write(raw)) await once(this.stream, "drain");
      if (!this.stream.write("\n")) await once(this.stream, "drain");
      this.rows += 1;
    });
  }

  async publish() {
    await this.open();
    await new Promise((resolve, reject) => {
      this.stream.on("error", reject);
      this.stream.end(resolve);
    });
    if (!this.appendMode) await rename(this.temporary, this.final);
    const info = await stat(this.final);
    return { rows: this.rows, duplicates: this.duplicates, cases: [...this.seen], bytes: info.size };
  }

  async abort() {
    if (this.stream) this.stream.destroy();
    if (!this.appendMode) await rm(this.temporary, { force: true });
  }
}

/**
 * Rebuild the target tree from every package in the inbox.
 * Returns the summary used by the CLI and the tests.
 */
export async function extract({
  source, target, sevenZip = "7z", dryRun = false, quiet = false, refresh = false,
  concurrency = DEFAULT_CONCURRENCY, log = console.log,
} = {}) {
  const started = Date.now();
  const packages = await scanPackages(source);
  const archives = [...packages.keys()].sort();

  if (dryRun) {
    for (const name of archives) {
      const file = packages.get(name);
      const size = (await stat(file)).size;
      const members = await membersOf(sevenZip, file);
      log(`${name} (${size} bytes)`);
      for (const member of members) log(`  ${member}  ->  ${wencaiChannel(member) ?? "AIME by record"}`);
    }
    return { archives: archives.length, members: 0, rows: 0, accepted: 0, duplicates: 0, invalid: 0, files: {} };
  }

  await mkdir(target, { recursive: true });
  const state = await readState(target);
  const plan = refresh ? { mode: "full" } : await planRun({ packages, target, archives, state });
  if (plan.mode === "current") {
    const files = Object.fromEntries(Object.entries(state.files).map(([key, entry]) => [key, entry.rows]));
    return {
      archives: archives.length, members: 0, rows: 0, accepted: 0, duplicates: 0, invalid: 0,
      files, skipped: {}, samples: {}, unchanged: true, elapsedMs: Date.now() - started,
    };
  }

  const pending = plan.mode === "incremental" ? plan.pending : archives;
  const known = plan.mode === "incremental" ? plan.known : {};
  const signatures = await archiveSignatures(packages, pending);
  const staging = await mkdtemp(path.join(tmpdir(), "lost-user-"));
  try {
    const workers = Math.max(1, Math.min(concurrency, pending.length));
    // Contiguous slices keep rank order equal to archive order.
    const buckets = Array.from({ length: workers }, () => []);
    pending.forEach((name, rank) => buckets[Math.floor(rank * workers / pending.length)].push({ rank, name, path: packages.get(name) }));
    const summaries = await Promise.all(buckets.map((bucket, index) => startWorker({
      staging, sevenZip, rank: index, entries: bucket, known,
    })));

    const groups = new Map();
    for (const summary of summaries) {
      for (const file of summary.files) {
        const key = file.channel + "/" + file.day;
        const group = groups.get(key) ?? {
          writer: new GroupFile({ channel: file.channel, day: file.day, target, append: plan.mode === "incremental" }),
          chunks: [],
        };
        group.chunks.push({ rank: summary.rank, file: file.file });
        groups.set(key, group);
      }
    }

    const files = {};
    const nextFiles = {};
    let duplicates = 0;
    let accepted = 0;
    try {
      await Promise.all([...groups.values()].map(async (group) => {
        for (const chunk of group.chunks.sort((left, right) => left.rank - right.rank)) await group.writer.append(chunk);
      }));
      await Promise.all([...groups.entries()].map(async ([key, group]) => {
        const merged = await group.writer.publish();
        const previous = plan.mode === "incremental" ? state.files[key] : undefined;
        const cases = previous ? [...previous.cases, ...merged.cases] : merged.cases;
        nextFiles[key] = { bytes: merged.bytes, rows: (previous?.rows ?? 0) + merged.rows, cases };
        files[key] = nextFiles[key].rows;
        accepted += merged.rows;
        duplicates += merged.duplicates;
        if (!quiet) log(`${key}: ${merged.rows} 条`);
      }));
    } catch (error) {
      await Promise.all([...groups.values()].map((group) => group.writer.abort()));
      throw error;
    }

    if (plan.mode === "full" && accepted === 0) throw new Error("没有可发布的记录（全部记录被排除）");
    // Files from an earlier full rebuild that no longer have a source are stale.
    if (plan.mode === "full") {
      for (const channel of CHANNELS) {
        const folder = path.join(target, channel);
        for (const name of await readdir(folder).catch(() => [])) {
          if (!/\.jsonl$/.test(name) || Object.hasOwn(nextFiles, channel + "/" + name.replace(/\.jsonl$/, ""))) continue;
          await rm(path.join(folder, name), { force: true });
        }
      }
    }
    if (plan.mode === "incremental") {
      for (const [key, entry] of Object.entries(state.files)) nextFiles[key] ??= entry;
    }
    await writeFile(path.join(target, STATE_NAME + "." + process.pid + ".tmp"), JSON.stringify({
      version: 2,
      archives: plan.mode === "incremental" ? { ...state.archives, ...signatures } : signatures,
      files: nextFiles,
    }));
    await rename(path.join(target, STATE_NAME + "." + process.pid + ".tmp"), path.join(target, STATE_NAME));

    const summary = {
      archives: archives.length,
      members: 0,
      rows: summaries.reduce((total, entry) => total + entry.rows, 0),
      accepted,
      duplicates: summaries.reduce((total, entry) => total + entry.duplicates, 0) + duplicates,
      invalid: summaries.reduce((total, entry) => total + entry.invalid, 0),
      files,
      skipped: {},
      samples: {},
      incremental: plan.mode === "incremental",
      elapsedMs: Date.now() - started,
    };
    for (const entry of summaries) {
      for (const [reason, count] of Object.entries(entry.skipped)) {
        summary.skipped[reason] = (summary.skipped[reason] ?? 0) + count;
        summary.samples[reason] ??= entry.samples[reason];
      }
    }
    return summary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string", default: DEFAULT_SOURCE },
    target: { type: "string", default: DEFAULT_TARGET },
    "seven-zip": { type: "string", default: "7z" },
    concurrency: { type: "string", default: String(DEFAULT_CONCURRENCY) },
    "dry-run": { type: "boolean", default: false },
    refresh: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  } });
  const summary = await extract({
    source: path.resolve(values.source),
    target: path.resolve(values.target),
    sevenZip: values["seven-zip"],
    concurrency: Number(values.concurrency),
    dryRun: values["dry-run"],
    refresh: values.refresh,
    quiet: values.quiet,
  });
  if (values["dry-run"]) return;
  if (summary.unchanged) {
    console.log(`已是最新：${summary.archives} 个包，${Object.values(summary.files).reduce((total, rows) => total + rows, 0)} 条记录，耗时 ${(summary.elapsedMs / 1000).toFixed(1)}s`);
    return;
  }
  for (const [file, rows] of Object.entries(summary.files)) console.log(`${file}: ${rows} 条`);
  console.log(`完成：${summary.archives} 个包，${summary.rows} 条记录，本次写入 ${summary.accepted} 条，重复 ${summary.duplicates} 条，排除 ${summary.invalid} 条，耗时 ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  for (const [reason, count] of Object.entries(summary.skipped)) {
    console.log(`  排除 ${reason}: ${count}（例：${summary.samples[reason]}）`);
  }
}

if (!isMainThread && workerData?.lostUserWorker) {
  processArchives(workerData)
    .then((summary) => parentPort.postMessage({ summary }))
    .catch((error) => parentPort.postMessage({ error: error?.stack || String(error) }));
} else if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
